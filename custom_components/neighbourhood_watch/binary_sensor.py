"""Alarm, panic, online and link binary sensors."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, STATE_ALERT, STATE_PANIC
from .coordinator import NeighbourhoodWatchCoordinator
from .entity import NWLocalEntity, NWRemoteEntity
from .helpers import async_add_dynamic_entities


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: NeighbourhoodWatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([NWLinkSensor(coordinator)])

    entry.async_on_unload(
        async_add_dynamic_entities(
            hass,
            coordinator,
            async_add_entities,
            lambda property_id: [
                NWPropertyAlarmSensor(coordinator, property_id),
                NWPropertyPanicSensor(coordinator, property_id),
                NWPropertyOnlineSensor(coordinator, property_id),
            ],
            set(),
        )
    )


class NWPropertyAlarmSensor(NWRemoteEntity, BinarySensorEntity):
    """On when a neighbouring property has a person detection or a panic."""

    _attr_translation_key = "property_alarm"
    _attr_device_class = BinarySensorDeviceClass.SAFETY

    def __init__(self, coordinator, property_id: str) -> None:
        super().__init__(coordinator, property_id)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{property_id}_alarm"

    @property
    def is_on(self) -> bool:
        status = self.status
        return bool(status and status.state in (STATE_ALERT, STATE_PANIC))


class NWPropertyPanicSensor(NWRemoteEntity, BinarySensorEntity):
    """On only for a panic, which is a person asking for help."""

    _attr_translation_key = "property_panic"
    _attr_device_class = BinarySensorDeviceClass.SAFETY

    def __init__(self, coordinator, property_id: str) -> None:
        super().__init__(coordinator, property_id)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{property_id}_panic"

    @property
    def is_on(self) -> bool:
        status = self.status
        return bool(status and status.state == STATE_PANIC)


class NWPropertyOnlineSensor(NWRemoteEntity, BinarySensorEntity):
    """On while a property is reachable.

    Off for more than a few minutes while that property was armed is worth
    paying attention to: power or internet cut at an armed house is a signal in
    its own right.
    """

    _attr_translation_key = "property_online"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(self, coordinator, property_id: str) -> None:
        super().__init__(coordinator, property_id)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{property_id}_online"

    @property
    def is_on(self) -> bool:
        status = self.status
        return bool(status and status.online)


class NWLinkSensor(NWLocalEntity, BinarySensorEntity):
    """On while this property is connected to the hood relay."""

    _attr_translation_key = "link"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = None

    def __init__(self, coordinator: NeighbourhoodWatchCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_link"

    @property
    def is_on(self) -> bool:
        return self.coordinator.link_connected
