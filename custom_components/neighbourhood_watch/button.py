"""Panic and clear buttons."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import NeighbourhoodWatchCoordinator
from .entity import NWLocalEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: NeighbourhoodWatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([NWPanicButton(coordinator), NWClearButton(coordinator)])


class NWPanicButton(NWLocalEntity, ButtonEntity):
    """Raise panic across the neighbourhood.

    The dashboard card requires a two second press and hold. A panic button a
    stray thumb can fire destroys trust in the whole network.
    """

    _attr_translation_key = "panic"
    _attr_icon = "mdi:alarm-light"

    def __init__(self, coordinator: NeighbourhoodWatchCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_panic"

    async def async_press(self) -> None:
        await self.coordinator.async_panic()


class NWClearButton(NWLocalEntity, ButtonEntity):
    """Clear a latched panic and any lingering alert."""

    _attr_translation_key = "clear"
    _attr_icon = "mdi:check-circle-outline"

    def __init__(self, coordinator: NeighbourhoodWatchCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_clear"

    async def async_press(self) -> None:
        await self.coordinator.async_clear()
