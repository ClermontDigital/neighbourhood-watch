"""Neighbourhood Watch: link separate Home Assistant deployments for security only."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.loader import async_get_integration

from homeassistant.helpers.device_registry import DeviceEntry

from .const import (
    CONF_RELAY_URL,
    CONF_TOKEN,
    DOMAIN,
    FRONTEND_SCRIPTS,
    FRONTEND_URL_BASE,
)
from .coordinator import NeighbourhoodWatchCoordinator
from .services import async_setup_services, async_unload_services

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.SENSOR,
    Platform.SWITCH,
]

_FRONTEND_KEY = f"{DOMAIN}_frontend_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a hood connection from a config entry."""
    # A previous run may have raised a repair for a revoked credential. Getting
    # this far means the credential works now.
    ir.async_delete_issue(hass, DOMAIN, f"rejected_{entry.entry_id}")

    # Never let a frontend problem stop the integration loading. The entities
    # and the events are the useful part; the cards are a convenience.
    try:
        await _async_register_frontend(hass)
    except Exception:  # noqa: BLE001
        hass.data.pop(_FRONTEND_KEY, None)
        _LOGGER.exception("Could not register the Neighbourhood Watch cards")

    coordinator = NeighbourhoodWatchCoordinator(hass, entry)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await coordinator.async_start()

    async_setup_services(hass)
    entry.async_on_unload(entry.add_update_listener(_async_entry_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down a hood connection."""
    # Stop the relay first. Unloading the platforms first leaves the socket
    # live, so an incoming snapshot can call async_add_entities on a platform
    # that has already been reset, which registers orphaned entities that
    # survive the unload and collide on the next setup.
    coordinator: NeighbourhoodWatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    await coordinator.async_stop()

    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    hass.data[DOMAIN].pop(entry.entry_id, None)

    if not hass.data[DOMAIN]:
        hass.data.pop(DOMAIN, None)
        async_unload_services(hass)
    return True


async def _async_entry_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle any change to the entry.

    A credential change needs a full reload, since the transport holds the
    token. An options change only needs the coordinator to re-read them, which
    avoids tearing every entity down whenever someone adjusts a slider.
    """
    coordinator: NeighbourhoodWatchCoordinator | None = hass.data.get(DOMAIN, {}).get(
        entry.entry_id
    )
    if coordinator is None:
        return

    if entry.data.get(CONF_TOKEN) != coordinator.token or entry.data.get(
        CONF_RELAY_URL
    ) != coordinator.relay_url:
        hass.config_entries.async_schedule_reload(entry.entry_id)
        return

    await coordinator.async_options_updated()


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: ConfigEntry, device: DeviceEntry
) -> bool:
    """Let a user delete the device for a property that has left the hood.

    Without this a revoked neighbour's device sits in the registry forever with
    no way to remove it from the UI.
    """
    coordinator: NeighbourhoodWatchCoordinator | None = hass.data.get(DOMAIN, {}).get(
        entry.entry_id
    )
    if coordinator is None:
        return True

    live = {f"{entry.entry_id}:self"} | {
        f"{entry.entry_id}:{property_id}" for property_id in coordinator.properties
    }
    return not any(identifier[1] in live for identifier in device.identifiers)


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve and register the card bundle exactly once per Home Assistant run.

    The guard is claimed synchronously, before the first await. Claiming it
    afterwards lets two concurrent config entries both pass the check and
    register the resource twice, which loads the cards from two URLs and makes
    every custom element definition collide.
    """
    if hass.data.get(_FRONTEND_KEY):
        return
    hass.data[_FRONTEND_KEY] = True

    www = Path(__file__).parent / "www"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(FRONTEND_URL_BASE, str(www), cache_headers=False),
        ]
    )

    integration = await async_get_integration(hass, DOMAIN)
    version = integration.version or "0"
    for script in FRONTEND_SCRIPTS:
        url = f"{FRONTEND_URL_BASE}/{script}?v={version}"
        await _async_add_module(hass, url)


async def _async_add_module(hass: HomeAssistant, url: str) -> None:
    """Add a JS module to the Lovelace resources if it is not already there."""
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None:
        _LOGGER.warning(
            "Lovelace is not ready, so the Neighbourhood Watch cards were not "
            "registered. Add %s under Settings > Dashboards > Resources, or "
            "restart Home Assistant.",
            url,
        )
        return

    # In Lovelace YAML mode the resource collection is read only: it has
    # async_items but no async_create_item. Calling it raises AttributeError,
    # which previously propagated out of async_setup_entry and left the whole
    # integration in a permanent setup error.
    if not hasattr(resources, "async_create_item"):
        _LOGGER.warning(
            "Lovelace is in YAML mode, so resources cannot be registered "
            "automatically. Add this to your lovelace resources: %s",
            url,
        )
        return

    # async_get_info ensures the collection is loaded through the supported
    # path. Calling async_load directly does not set the loaded flag, so it
    # reloads on every call and rebroadcasts every resource to every open
    # browser each time.
    await resources.async_get_info()

    base = url.split("?", 1)[0]
    for item in resources.async_items():
        existing = str(item.get("url", ""))
        if existing.split("?", 1)[0] == base:
            if existing != url:
                # Version changed: update in place rather than adding a second
                # copy of the same file.
                await resources.async_update_item(item["id"], {"url": url})
            return

    await resources.async_create_item({"res_type": "module", "url": url})
