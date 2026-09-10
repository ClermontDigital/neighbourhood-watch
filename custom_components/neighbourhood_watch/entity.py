"""Shared entity plumbing."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .coordinator import NeighbourhoodWatchCoordinator
from .models import PropertyStatus


class NWBaseEntity(Entity):
    """Common behaviour: no polling, update on dispatcher signal."""

    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(self, coordinator: NeighbourhoodWatchCoordinator) -> None:
        super().__init__()
        self.coordinator = coordinator

    @property
    def _signal(self) -> str:
        """Scoped to this config entry, so two hoods never cross-fire."""
        return self.coordinator.signal_update

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, self._signal, self.async_write_ha_state)
        )


class NWRemoteEntity(NWBaseEntity):
    """An entity describing another property in the neighbourhood."""

    def __init__(
        self, coordinator: NeighbourhoodWatchCoordinator, property_id: str
    ) -> None:
        super().__init__(coordinator)
        self.property_id = property_id

    @property
    def status(self) -> PropertyStatus | None:
        return self.coordinator.properties.get(self.property_id)

    @property
    def available(self) -> bool:
        # The property staying in the roster is what matters. Whether it is
        # currently online is information the entities report, not a reason to
        # make them unavailable.
        return self.status is not None

    @property
    def device_info(self) -> DeviceInfo:
        status = self.status
        name = status.name if status else self.property_id
        return DeviceInfo(
            identifiers={(DOMAIN, f"{self.coordinator.entry.entry_id}:{self.property_id}")},
            name=name,
            manufacturer="Neighbourhood Watch",
            model="Neighbouring property",
        )


class NWLocalEntity(NWBaseEntity):
    """An entity describing this property."""

    @property
    def _signal(self) -> str:
        return self.coordinator.signal_local

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, f"{self.coordinator.entry.entry_id}:self")},
            name=f"{self.coordinator.property_name} (this property)",
            manufacturer="Neighbourhood Watch",
            model="This property",
        )
