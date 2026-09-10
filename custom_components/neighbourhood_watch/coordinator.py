"""Coordinator: local state machine, relay plumbing and event fan-out."""

from __future__ import annotations

import logging
import time
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .const import (
    CONF_ALERT_HOLD,
    CONF_ALERT_LINGER,
    CONF_ARMED_ENTITY,
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
    EVENT_LINK_CHANGED,
    EVENT_STATUS_CHANGED,
    SIGNAL_LOCAL_UPDATE,
    SIGNAL_PROPERTY_ADDED,
    SIGNAL_PROPERTY_UPDATE,
    STATE_ALERT,
    STATE_ARMED,
    STATE_DISARMED,
    STATE_PANIC,
)
from .models import PropertyStatus
from .transport import RelayClient

_LOGGER = logging.getLogger(__name__)

# States that mean a trigger entity has fired. Deliberately narrow: anything
# else, including unavailable and unknown, must not raise the neighbourhood.
TRIGGER_ON_STATES = ("on", "detected", "triggered")


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
        self.local_since: int = int(time.time())
        self.publishing: bool = True

        self._panic_since: int | None = None
        self._alert_until: float = 0.0
        self._alert_detail: str | None = None
        self._pending_holds: dict[str, CALLBACK_TYPE] = {}
        self._unsubscribes: list[CALLBACK_TYPE] = []
        self._linger_timer: CALLBACK_TYPE | None = None

        self.client = RelayClient(
            async_get_clientsession(hass),
            entry.data[CONF_RELAY_URL],
            entry.data[CONF_TOKEN],
            on_snapshot=self._handle_snapshot,
            on_update=self._handle_update,
            on_link=self._handle_link,
            on_rejected=self._handle_rejected,
        )

    # ------------------------------------------------------------------
    # Options
    # ------------------------------------------------------------------

    @property
    def _options(self) -> dict[str, Any]:
        return dict(self.entry.options)

    @property
    def armed_entity(self) -> str | None:
        return self._options.get(CONF_ARMED_ENTITY) or None

    @property
    def trigger_entities(self) -> list[str]:
        value = self._options.get(CONF_TRIGGER_ENTITIES) or []
        return list(value) if isinstance(value, list) else []

    @property
    def alert_hold(self) -> int:
        return int(self._options.get(CONF_ALERT_HOLD) or DEFAULT_ALERT_HOLD)

    @property
    def alert_linger(self) -> int:
        return int(self._options.get(CONF_ALERT_LINGER) or DEFAULT_ALERT_LINGER)

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
        self.client.set_profile(self.property_name, self.icon, self.picture)
        self._resubscribe()
        self._recompute(publish=False)
        await self.client.async_start()
        await self._publish()

    async def async_stop(self) -> None:
        self._clear_subscriptions()
        await self.client.async_stop()

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

    # ------------------------------------------------------------------
    # Local state machine
    # ------------------------------------------------------------------

    @callback
    def _handle_local_change(self, event: Event) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data.get("new_state")

        if entity_id in self.trigger_entities:
            is_on = new_state is not None and new_state.state in TRIGGER_ON_STATES
            if is_on:
                self._start_hold(entity_id, new_state)
            else:
                self._cancel_hold(entity_id)

        self.hass.async_create_task(self._recompute_and_publish())

    @callback
    def _start_hold(self, entity_id: str, state: Any) -> None:
        """Wait out the debounce before treating a detection as real."""
        if entity_id in self._pending_holds:
            return

        friendly = None
        if state is not None:
            friendly = state.attributes.get("friendly_name")
        label = self._clean_label(friendly or entity_id)

        @callback
        def _confirm(_now: Any) -> None:
            self._pending_holds.pop(entity_id, None)
            current = self.hass.states.get(entity_id)
            if current is None or current.state not in TRIGGER_ON_STATES:
                return
            self._alert_until = time.monotonic() + self.alert_linger
            self._alert_detail = label
            self._schedule_linger_expiry()
            self.hass.async_create_task(self._recompute_and_publish())

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

        @callback
        def _expire(_now: Any) -> None:
            self._linger_timer = None
            self.hass.async_create_task(self._recompute_and_publish())

        remaining = max(1, self._alert_until - time.monotonic())
        self._linger_timer = async_call_later(self.hass, remaining, _expire)

    @staticmethod
    def _clean_label(value: str) -> str:
        """Turn 'Creek Cam Person' into 'Creek Cam'."""
        for suffix in (" Person", " Motion", " Detected", " person", " motion"):
            if value.endswith(suffix):
                return value[: -len(suffix)]
        return value

    def _is_armed(self) -> bool:
        entity_id = self.armed_entity
        if not entity_id:
            return False
        state = self.hass.states.get(entity_id)
        if state is None:
            return False
        return state.state in ("on", "armed", "armed_away", "armed_home", "armed_night")

    @callback
    def _recompute(self, publish: bool = True) -> bool:
        """Work out this property's state. Returns True if it changed."""
        previous_state, previous_detail = self.local_state, self.local_detail

        if self._panic_since is not None:
            state, detail = STATE_PANIC, None
        elif not self._is_armed():
            # Disarming clears a lingering alert: someone is home and has seen it.
            self._alert_until = 0.0
            self._alert_detail = None
            state, detail = STATE_DISARMED, None
        elif time.monotonic() < self._alert_until:
            state = STATE_ALERT
            detail = self._alert_detail if self.share_detail else None
        else:
            state, detail = STATE_ARMED, None

        changed = state != previous_state or detail != previous_detail
        if changed:
            self.local_state = state
            self.local_detail = detail
            if state != previous_state:
                self.local_since = int(time.time())
            async_dispatcher_send(self.hass, SIGNAL_LOCAL_UPDATE)
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
        await self._recompute_and_publish()

    async def async_clear(self) -> None:
        """Clear a latched panic and any lingering alert."""
        self._panic_since = None
        self._alert_until = 0.0
        self._alert_detail = None
        if self._linger_timer is not None:
            self._linger_timer()
            self._linger_timer = None
        await self._recompute_and_publish()

    @property
    def panic_active(self) -> bool:
        return self._panic_since is not None

    async def async_set_publishing(self, value: bool) -> None:
        """Privacy kill switch. Off drops the link entirely."""
        if value == self.publishing:
            return
        self.publishing = value
        if value:
            await self.client.async_start()
            await self._publish()
        else:
            await self.client.async_stop()
        async_dispatcher_send(self.hass, SIGNAL_LOCAL_UPDATE)

    # ------------------------------------------------------------------
    # Relay callbacks
    # ------------------------------------------------------------------

    async def _handle_snapshot(self, payloads: list[dict[str, Any]]) -> None:
        seen: set[str] = set()
        added: list[str] = []

        for payload in payloads:
            status = PropertyStatus.from_payload(payload)
            if not status.id or status.id == self.property_id:
                continue
            seen.add(status.id)
            if status.id not in self.properties:
                added.append(status.id)
            self._store(status, fire_event=False)

        # A property revoked while this instance was disconnected simply will
        # not be in the snapshot.
        for gone in set(self.properties) - seen:
            self.properties.pop(gone, None)

        if added:
            async_dispatcher_send(self.hass, SIGNAL_PROPERTY_ADDED, added)
        async_dispatcher_send(self.hass, SIGNAL_PROPERTY_UPDATE)

    async def _handle_update(self, payload: dict[str, Any]) -> None:
        property_id = str(payload.get("id") or "")
        if not property_id or property_id == self.property_id:
            return

        if payload.get("removed"):
            self.properties.pop(property_id, None)
            async_dispatcher_send(self.hass, SIGNAL_PROPERTY_UPDATE)
            return

        status = PropertyStatus.from_payload(payload)
        is_new = property_id not in self.properties
        self._store(status, fire_event=True)

        if is_new:
            async_dispatcher_send(self.hass, SIGNAL_PROPERTY_ADDED, [property_id])
        async_dispatcher_send(self.hass, SIGNAL_PROPERTY_UPDATE)

    def _store(self, status: PropertyStatus, *, fire_event: bool) -> None:
        previous = self.properties.get(status.id)
        self.properties[status.id] = status

        if not fire_event:
            return
        if previous is not None and previous.state == status.state:
            return

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
        async_dispatcher_send(self.hass, SIGNAL_LOCAL_UPDATE)
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
            "neighbourhood_watch",
            f"rejected_{self.entry.entry_id}",
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key="rejected",
            translation_placeholders={"reason": reason},
        )
