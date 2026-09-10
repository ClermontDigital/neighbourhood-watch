"""Services. Registered once, applied to every configured hood."""

from __future__ import annotations

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, SERVICE_CLEAR, SERVICE_PANIC

ATTR_ENTRY_ID = "entry_id"

# No schema defaults here. A default that the validator itself rejects makes
# the service refuse to register, with an error that points nowhere useful.
SERVICE_SCHEMA = vol.Schema({vol.Optional(ATTR_ENTRY_ID): cv.string})


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Register services if they are not already there."""
    if hass.services.has_service(DOMAIN, SERVICE_PANIC):
        return

    async def _handle_panic(call: ServiceCall) -> None:
        for coordinator in _targets(hass, call):
            await coordinator.async_panic()

    async def _handle_clear(call: ServiceCall) -> None:
        for coordinator in _targets(hass, call):
            await coordinator.async_clear()

    hass.services.async_register(DOMAIN, SERVICE_PANIC, _handle_panic, SERVICE_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_CLEAR, _handle_clear, SERVICE_SCHEMA)


@callback
def async_unload_services(hass: HomeAssistant) -> None:
    for service in (SERVICE_PANIC, SERVICE_CLEAR):
        hass.services.async_remove(DOMAIN, service)


def _targets(hass: HomeAssistant, call: ServiceCall) -> list:
    """Resolve which hoods a call applies to. Omitting entry_id means all."""
    entries = hass.data.get(DOMAIN, {})
    entry_id = call.data.get(ATTR_ENTRY_ID)
    if entry_id:
        coordinator = entries.get(entry_id)
        return [coordinator] if coordinator else []
    return list(entries.values())
