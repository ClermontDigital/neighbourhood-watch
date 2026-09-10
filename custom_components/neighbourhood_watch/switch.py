"""Publish switch: the privacy kill switch."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
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
    async_add_entities([NWPublishSwitch(coordinator)])


class NWPublishSwitch(NWLocalEntity, SwitchEntity):
    """Turn this property's participation on and off.

    Off disconnects from the relay entirely, so the neighbourhood sees this
    property go offline rather than seeing a frozen state.
    """

    _attr_translation_key = "publish"
    _attr_icon = "mdi:broadcast"

    def __init__(self, coordinator: NeighbourhoodWatchCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_publish"

    @property
    def is_on(self) -> bool:
        return self.coordinator.publishing

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_publishing(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_publishing(False)
