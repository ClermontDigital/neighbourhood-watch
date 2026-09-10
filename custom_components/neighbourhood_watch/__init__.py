"""Neighbourhood Watch: link separate Home Assistant deployments for security only."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN, FRONTEND_SCRIPTS, FRONTEND_URL_BASE
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
    await _async_register_frontend(hass)

    coordinator = NeighbourhoodWatchCoordinator(hass, entry)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await coordinator.async_start()

    async_setup_services(hass)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down a hood connection."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if not unloaded:
        return False

    coordinator: NeighbourhoodWatchCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
    await coordinator.async_stop()

    if not hass.data[DOMAIN]:
        hass.data.pop(DOMAIN, None)
        async_unload_services(hass)
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    coordinator: NeighbourhoodWatchCoordinator | None = hass.data.get(DOMAIN, {}).get(
        entry.entry_id
    )
    if coordinator is not None:
        await coordinator.async_options_updated()


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

    version = _integration_version(hass)
    for script in FRONTEND_SCRIPTS:
        url = f"{FRONTEND_URL_BASE}/{script}?v={version}"
        await _async_add_module(hass, url)


def _integration_version(hass: HomeAssistant) -> str:
    try:
        import json

        manifest = Path(__file__).parent / "manifest.json"
        return json.loads(manifest.read_text(encoding="utf-8")).get("version", "0")
    except (OSError, ValueError):  # pragma: no cover - defensive
        return "0"


async def _async_add_module(hass: HomeAssistant, url: str) -> None:
    """Add a JS module to the Lovelace resources if it is not already there."""
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None:
        _LOGGER.debug("Lovelace resources unavailable, skipping %s", url)
        return

    if not resources.loaded:
        await resources.async_load()

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
