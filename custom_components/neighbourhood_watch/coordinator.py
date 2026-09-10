"""Coordinator: local state machine, relay plumbing and event fan-out."""

from __future__ import annotations

import logging
import time
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import (
    CONF_ALERT_HOLD,
    CONF_ALERT_LINGER,
    CONF_ARMED_ENTITY,
    CONF_CLIENT_ID,
    CONF_ICON,
    CONF_PICTURE,
    CONF_PROPERTY_ID,
    CONF_PROPERTY_NAME,
    CONF_RELAY_URL,
    CONF_SHARE_DETAIL,
    CONF_TOKEN,
    CONF_TRIGGER_ENTITIES,
    DEFAULT_ALERT_HOLD,
    DEFAULT_ALERT_LINGER,
    DEFAULT_ICON,
    DEFAULT_SHARE_DETAIL,
    DOMAIN,
    EVENT_DEDUPE_SECONDS,
    EVENT_LINK_CHANGED,
    EVENT_STATUS_CHANGED,
    STATE_ALERT,
    STATE_ARMED,
    STATE_DISARMED,
    STATE_PANIC,
    signal_local_update,
    signal_property_added,
    signal_property_update,
)
from .models import PropertyStatus
from .transport import RelayClient

_LOGGER = logging.getLogger(__name__)

# States that mean a trigger entity has fired. Deliberately narrow: anything
# else, including unavailable and unknown, must not raise the neighbourhood.
TRIGGER_ON_STATES = ("on", "detected", "triggered")

# States of the nominated armed entity that mean this property is armed. A
# panel that is mid-alarm counts as armed, not as disarmed.
ARMED_STATES = (
    "on",
    "armed",
    "armed_away",
    "armed_home",
    "armed_night",
    "armed_vacation",
    "arming",
    "pending",
    "triggered",
)

# A property that never joins the hood should still not grow unbounded
# entities if the relay sends a huge roster.
MAX_PROPERTIES = 64

STORAGE_VERSION = 1


class NeighbourhoodWatchCoordinator:
    """Owns this property's published state and every remote property's state."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry

        self.property_id: str = entry.data[CONF_PROPERTY_ID]
        self.property_name: str = entry.data.get(CONF_PROPERTY_NAME) or self.property_id

        # Remote properties, keyed by id. Excludes this property.
        self.properties: dict[str, PropertyStatus] = {}

        self.local_state: str = STATE_DISARMED
        self.local_detail: str | None = None
        # Set on first recompute rather than here: on an off-grid box this can
        # run before NTP has corrected the clock, and this value is published.
        self.local_since: int | None = None
        self.publishing: bool = True

        self._panic_since: int | None = None
        self._alert_until: float = 0.0
        self._alert_detail: str | None = None
        self._pending_holds: dict[str, CALLBACK_TYPE] = {}
        self._unsubscribes: list[CALLBACK_TYPE] = []
        self._linger_timer: CALLBACK_TYPE | None = None
        self._last_events: dict[str, tuple[str, float]] = {}
        self._stopped = False

        # Kept so the update listener can tell a credential change, which needs
        # a reload, from an options change, which does not.
        self.token: str = entry.data[CONF_TOKEN]
        self.relay_url: str = entry.data[CONF_RELAY_URL]

        self._store: Store = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}"
        )

        self.client = RelayClient(
            async_get_clientsession(hass),
            entry.data[CONF_RELAY_URL],
            entry.data[CONF_TOKEN],
            entry.data.get(CONF_CLIENT_ID, entry.entry_id),
            on_snapshot=self._handle_snapshot,
            on_update=self._handle_update,
            on_link=self._handle_link,
            on_rejected=self._handle_rejected,
        )

    # ------------------------------------------------------------------
    # Signals scoped to this entry
    # ------------------------------------------------------------------

    @property
    def signal_update(self) -> str:
        return signal_property_update(self.entry.entry_id)

    @property
    def signal_added(self) -> str:
        return signal_property_added(self.entry.entry_id)

    @property
    def signal_local(self) -> str:
        return signal_local_update(self.entry.entry_id)

    # ------------------------------------------------------------------
    # Options
    # ------------------------------------------------------------------

    @property
    def _options(self) -> dict[str, Any]:
        return dict(self.entry.options)

    def _int_option(self, key: str, default: int) -> int:
        """Read a numeric option without treating a valid zero as unset."""
        value = self._options.get(key)
        if value is None:
            return default
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @property
    def armed_entity(self) -> str | None:
        return self._options.get(CONF_ARMED_ENTITY) or None

    @property
    def trigger_entities(self) -> list[str]:
        value = self._options.get(CONF_TRIGGER_ENTITIES) or []
        return list(value) if isinstance(value, list) else []

    @property
    def alert_hold(self) -> int:
        return self._int_option(CONF_ALERT_HOLD, DEFAULT_ALERT_HOLD)

    @property
    def alert_linger(self) -> int:
        return self._int_option(CONF_ALERT_LINGER, DEFAULT_ALERT_LINGER)

    @property
    def share_detail(self) -> bool:
        value = self._options.get(CONF_SHARE_DETAIL)
        return DEFAULT_SHARE_DETAIL if value is None else bool(value)

    @property
    def icon(self) -> str:
        return self._options.get(CONF_ICON) or DEFAULT_ICON

    @property
    def picture(self) -> str | None:
        return self._options.get(CONF_PICTURE) or None

    @property
    def link_connected(self) -> bool:
        return self.client.connected

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def async_start(self) -> None:
        await self._async_restore()
        self.client.set_profile(self.property_name, self.icon, self.picture)
        self._resubscribe()
        self._recompute()
        if self.publishing:
            await self.client.async_start()
            await self._publish()

    async def async_stop(self) -> None:
        self._stopped = True
        self._clear_subscriptions()
        await self.client.async_stop()

    async def _async_restore(self) -> None:
        """Bring back the panic latch and the privacy switch.

        Both were previously memory only. A restart silently cleared a latched
        panic, and worse, turned publishing back on for someone who had
        deliberately switched it off.
        """
        data = await self._store.async_load() or {}
        self.publishing = bool(data.get("publishing", True))
        panic = data.get("panic_since")
        self._panic_since = int(panic) if panic else None

    async def _async_persist(self) -> None:
        await self._store.async_save(
            {"publishing": self.publishing, "panic_since": self._panic_since}
        )

    def _clear_subscriptions(self) -> None:
        for unsub in self._unsubscribes:
            unsub()
        self._unsubscribes.clear()
        for cancel in self._pending_holds.values():
            cancel()
        self._pending_holds.clear()
        if self._linger_timer is not None:
            self._linger_timer()
            self._linger_timer = None

    def _resubscribe(self) -> None:
        """Watch the entities this property has nominated as its arm and triggers."""
        self._clear_subscriptions()
        watched = [e for e in ([self.armed_entity] + self.trigger_entities) if e]
        if not watched:
            _LOGGER.debug("No armed or trigger entities configured yet")
            return
        self._unsubscribes.append(
            async_track_state_change_event(self.hass, watched, self._handle_local_change)
        )

    async def async_options_updated(self) -> None:
        self.client.set_profile(self.property_name, self.icon, self.picture)
        self._resubscribe()
        await self._recompute_and_publish()

    @callback
    def _spawn(self, coro: Any, name: str) -> None:
        """Run a coroutine tied to this config entry, not to Home Assistant.

        hass.async_create_task registers against hass._tasks, which is only
        drained at shutdown, so recompute tasks queued during an unload keep
        running against a coordinator that has already been torn down.
        """
        if self._stopped:
            coro.close()
            return
        self.entry.async_create_background_task(self.hass, coro, name)

    # ------------------------------------------------------------------
    # Local state machine
    # ------------------------------------------------------------------

    @callback
    def _handle_local_change(self, event: Event) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")

        # State change events also fire for attribute-only updates. Without
        # this, a camera sensor that sits on with churning attributes restarts
        # the hold on every update, which re-extends the alert linger forever
        # and keeps the property showing alert indefinitely.
        if (
            old_state is not None
            and new_state is not None
            and old_state.state == new_state.state
        ):
            return

        if entity_id in self.trigger_entities:
            is_on = new_state is not None and new_state.state in TRIGGER_ON_STATES
            if is_on:
                self._start_hold(entity_id, new_state)
            else:
                self._cancel_hold(entity_id)

        self._spawn(self._recompute_and_publish(), "nw_recompute")

    @callback
    def _start_hold(self, entity_id: str, state: Any) -> None:
        """Wait out the debounce before treating a detection as real."""
        if entity_id in self._pending_holds:
            return

        friendly = None
        if state is not None:
            friendly = state.attributes.get("friendly_name")
        # Never fall back to the entity id. That publishes an internal entity
        # id to the whole neighbourhood and to the relay operator, which the
        # privacy promise says never leaves the property.
        label = self._clean_label(friendly) if friendly else "alert"

        @callback
        def _confirm(_now: Any) -> None:
            self._pending_holds.pop(entity_id, None)
            current = self.hass.states.get(entity_id)
            if current is None or current.state not in TRIGGER_ON_STATES:
                return
            self._alert_until = time.monotonic() + self.alert_linger
            self._alert_detail = label
            self._schedule_linger_expiry()
            self._spawn(self._recompute_and_publish(), "nw_alert")

        self._pending_holds[entity_id] = async_call_later(
            self.hass, self.alert_hold, _confirm
        )

    @callback
    def _cancel_hold(self, entity_id: str) -> None:
        cancel = self._pending_holds.pop(entity_id, None)
        if cancel is not None:
            cancel()

    @callback
    def _schedule_linger_expiry(self) -> None:
        """Re-evaluate exactly when the alert linger runs out.

        Without this the property would sit on alert until some unrelated state
        change happened to trigger a recompute, which on a quiet night could be
        hours.
        """
        if self._linger_timer is not None:
            self._linger_timer()
            self._linger_timer = None

        @callback
        def _expire(_now: Any) -> None:
            self._linger_timer = None
            self._spawn(self._recompute_and_publish(), "nw_linger")

        remaining = max(1, self._alert_until - time.monotonic())
        self._linger_timer = async_call_later(self.hass, remaining, _expire)

    @staticmethod
    def _clean_label(value: str) -> str:
        """Turn 'Creek Cam Person' into 'Creek Cam'."""
        for suffix in (" Person", " Motion", " Detected", " person", " motion"):
            if value.endswith(suffix):
                return value[: -len(suffix)]
        return value

    def _armed_state(self) -> bool | None:
        """True armed, False disarmed, None unknown.

        The distinction matters. Treating unknown as disarmed meant a momentary
        unavailable on the arm entity, which happens routinely during a
        restart or a radio blip, wiped a live alert and told the neighbourhood
        this property was disarmed. That is the worst direction to fail in.
        """
        entity_id = self.armed_entity
        if not entity_id:
            return False
        state = self.hass.states.get(entity_id)
        if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return None
        return state.state in ARMED_STATES

    @callback
    def _recompute(self) -> bool:
        """Work out this property's state. Returns True if it changed."""
        previous_state, previous_detail = self.local_state, self.local_detail
        armed = self._armed_state()

        if self._panic_since is not None:
            state, detail = STATE_PANIC, None
        elif armed is None:
            # Hold whatever we were last publishing until the arm entity is
            # readable again.
            state, detail = previous_state, previous_detail
        elif not armed:
            # Disarming clears a lingering alert: someone is home and has seen it.
            self._alert_until = 0.0
            self._alert_detail = None
            if self._linger_timer is not None:
                self._linger_timer()
                self._linger_timer = None
            state, detail = STATE_DISARMED, None
        elif time.monotonic() < self._alert_until:
            state = STATE_ALERT
            detail = self._alert_detail if self.share_detail else None
            # Re-arm the expiry if it has already fired. asyncio can run a
            # timer a hair early, which would otherwise leave the alert stuck
            # until some unrelated state change happened along.
            if self._linger_timer is None:
                self._schedule_linger_expiry()
        else:
            state, detail = STATE_ARMED, None

        changed = state != previous_state or detail != previous_detail
        if changed or self.local_since is None:
            self.local_state = state
            self.local_detail = detail
            if state != previous_state or self.local_since is None:
                self.local_since = int(time.time())
            async_dispatcher_send(self.hass, self.signal_local)
        return changed

    async def _recompute_and_publish(self) -> None:
        if self._recompute():
            await self._publish()

    async def _publish(self) -> None:
        if not self.publishing:
            return
        await self.client.async_send_status(
            self.local_state, self.local_detail, self.local_since
        )

    # ------------------------------------------------------------------
    # Panic
    # ------------------------------------------------------------------

    async def async_panic(self) -> None:
        """Raise panic. Fires regardless of armed state, day or night."""
        if self._panic_since is None:
            self._panic_since = int(time.time())
            await self._async_persist()
        await self._recompute_and_publish()

    async def async_clear(self) -> None:
        """Clear a latched panic and any lingering alert."""
        had_panic = self._panic_since is not None
        self._panic_since = None
        self._alert_until = 0.0
        self._alert_detail = None
        if self._linger_timer is not None:
            self._linger_timer()
            self._linger_timer = None
        if had_panic:
            await self._async_persist()
        await self._recompute_and_publish()

    @property
    def panic_active(self) -> bool:
        return self._panic_since is not None

    async def async_set_publishing(self, value: bool) -> None:
        """Privacy kill switch. Off drops the link entirely."""
        if value == self.publishing:
            return
        self.publishing = value
        await self._async_persist()
        if value:
            await self.client.async_start()
            await self._publish()
        else:
            await self.client.async_stop()
        async_dispatcher_send(self.hass, self.signal_local)

    # ------------------------------------------------------------------
    # Relay callbacks
    # ------------------------------------------------------------------

    async def _handle_snapshot(self, payloads: list[dict[str, Any]]) -> None:
        if len(payloads) > MAX_PROPERTIES:
            _LOGGER.warning(
                "Relay sent %s properties, only the first %s will be used",
                len(payloads),
                MAX_PROPERTIES,
            )
            payloads = payloads[:MAX_PROPERTIES]

        seen: set[str] = set()
        added: list[str] = []

        for payload in payloads:
            status = PropertyStatus.from_payload(payload)
            if not status.id or status.id == self.property_id:
                continue
            seen.add(status.id)
            if status.id not in self.properties:
                added.append(status.id)
            self._store_status(status, fire_event=False)

        # A property revoked while this instance was disconnected simply will
        # not be in the snapshot.
        for gone in set(self.properties) - seen:
            self.properties.pop(gone, None)

        if added:
            async_dispatcher_send(self.hass, self.signal_added, added)
        async_dispatcher_send(self.hass, self.signal_update)

    async def _handle_update(self, payload: dict[str, Any]) -> None:
        property_id = str(payload.get("id") or "")
        if not property_id or property_id == self.property_id:
            return

        if payload.get("removed"):
            self.properties.pop(property_id, None)
            async_dispatcher_send(self.hass, self.signal_update)
            return

        if property_id not in self.properties and len(self.properties) >= MAX_PROPERTIES:
            _LOGGER.warning("Ignoring property %s, hood is at its cap", property_id)
            return

        status = PropertyStatus.from_payload(payload)
        is_new = property_id not in self.properties
        self._store_status(status, fire_event=True)

        if is_new:
            async_dispatcher_send(self.hass, self.signal_added, [property_id])
        async_dispatcher_send(self.hass, self.signal_update)

    def _store_status(self, status: PropertyStatus, *, fire_event: bool) -> None:
        previous = self.properties.get(status.id)
        self.properties[status.id] = status

        if not fire_event:
            return
        if previous is not None and previous.state == status.state:
            return

        # Blunt an oscillating neighbour. The relay caps panic entries per
        # hour; this stops a rapid flap from firing the same event repeatedly
        # at every household's automations.
        last = self._last_events.get(status.id)
        now = time.monotonic()
        if last is not None and last[0] == status.state and now - last[1] < EVENT_DEDUPE_SECONDS:
            return
        self._last_events[status.id] = (status.state, now)

        # The integration raises the message and stops there. What happens next
        # is each instance's own business.
        self.hass.bus.async_fire(
            EVENT_STATUS_CHANGED,
            {
                "property_id": status.id,
                "name": status.name,
                "state": status.state,
                "previous_state": previous.state if previous else None,
                "detail": status.detail,
                "since": status.since,
                "online": status.online,
            },
        )

    async def _handle_link(self, connected: bool) -> None:
        async_dispatcher_send(self.hass, self.signal_local)
        self.hass.bus.async_fire(EVENT_LINK_CHANGED, {"connected": connected})
        if not connected:
            # Do not blank out remote properties. Their last known state is far
            # more useful than nothing, and the relay decides who is offline.
            _LOGGER.debug("Link to hood relay lost")

    async def _handle_rejected(self, reason: str) -> None:
        """The relay revoked this property. Surface it rather than retrying."""
        from homeassistant.helpers import issue_registry as ir

        ir.async_create_issue(
            self.hass,
            DOMAIN,
            f"rejected_{self.entry.entry_id}",
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key="rejected",
            translation_placeholders={"reason": reason},
        )
        # Actually start the reauth flow. Creating the issue alone left the
        # reauth steps unreachable, so the only recovery was deleting and
        # re-adding the entry, which orphans every entity and device.
        self.entry.async_start_reauth(self.hass)
