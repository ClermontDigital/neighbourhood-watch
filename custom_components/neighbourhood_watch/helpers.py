"""Helper for platforms that grow entities as properties join the hood."""

from __future__ import annotations

from collections.abc import Callable, Iterable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import NeighbourhoodWatchCoordinator


@callback
def async_add_dynamic_entities(
    hass: HomeAssistant,
    coordinator: NeighbourhoodWatchCoordinator,
    async_add_entities: AddEntitiesCallback,
    factory: Callable[[str], Iterable[Entity]],
    known: set[str],
) -> Callable[[], None]:
    """Create entities for properties already known, then for any that join.

    Properties are discovered from the relay rather than configured, so the
    platform cannot know its entity list at setup time.
    """

    def _build(property_ids: Iterable[str]) -> list[Entity]:
        entities: list[Entity] = []
        for property_id in property_ids:
            if property_id in known:
                continue
            known.add(property_id)
            entities.extend(factory(property_id))
        return entities

    # Empty at setup time by design: the coordinator starts after the
    # platforms are forwarded, precisely so the first snapshot is dispatched
    # into listeners that already exist. This ordering is load bearing.
    initial = _build(list(coordinator.properties))
    if initial:
        async_add_entities(initial)

    @callback
    def _handle_added(property_ids: list[str]) -> None:
        entities = _build(property_ids)
        if entities:
            async_add_entities(entities)

    return async_dispatcher_connect(hass, coordinator.signal_added, _handle_added)
