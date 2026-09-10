"""Status sensors: one per property, plus this property's own."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import ALL_STATES, DOMAIN, STATE_OFFLINE
from .coordinator import NeighbourhoodWatchCoordinator
from .entity import NWLocalEntity, NWRemoteEntity
from .helpers import async_add_dynamic_entities

STATE_ICONS = {
    "panic": "mdi:alarm-light",
    "alert": "mdi:account-alert",
    "armed": "mdi:shield-check",
    "disarmed": "mdi:shield-off-outline",
    "offline": "mdi:lan-disconnect",
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: NeighbourhoodWatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([NWSelfStatusSensor(coordinator)])

    entry.async_on_unload(
        async_add_dynamic_entities(
            hass,
            coordinator,
            async_add_entities,
            lambda property_id: [NWPropertyStatusSensor(coordinator, property_id)],
            set(),
        )
    )


class NWPropertyStatusSensor(NWRemoteEntity, SensorEntity):
    """The five state roll-up for a neighbouring property."""

    _attr_translation_key = "property_status"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = list(ALL_STATES)

    def __init__(self, coordinator, property_id: str) -> None:
        super().__init__(coordinator, property_id)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{property_id}_status"

    @property
    def native_value(self) -> str:
        status = self.status
        return status.state if status else STATE_OFFLINE

    @property
    def icon(self) -> str:
        return STATE_ICONS.get(self.native_value, "mdi:home-alert")

    @property
    def entity_picture(self) -> str | None:
        status = self.status
        return status.picture if status else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        status = self.status
        return status.as_attributes() if status else {}


class NWSelfStatusSensor(NWLocalEntity, SensorEntity):
    """What this property is currently telling the neighbourhood."""

    _attr_translation_key = "self_status"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = list(ALL_STATES)

    def __init__(self, coordinator: NeighbourhoodWatchCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_self_status"

    @property
    def native_value(self) -> str:
        return self.coordinator.local_state

    @property
    def icon(self) -> str:
        return STATE_ICONS.get(self.native_value, "mdi:home-alert")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        coordinator = self.coordinator
        return {
            "nw": "self",
            "property_id": coordinator.property_id,
            "property_name": coordinator.property_name,
            "hood_size": len(coordinator.properties) + 1,
            "detail": coordinator.local_detail,
            "since": coordinator.local_since,
            "publishing": coordinator.publishing,
            "linked": coordinator.link_connected,
        }
