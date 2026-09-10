"""Config and options flow. Pairing is a single paste of a join code."""

from __future__ import annotations

import uuid
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_ALERT_HOLD,
    CONF_CLIENT_ID,
    CONF_ALERT_LINGER,
    CONF_ARMED_ENTITY,
    CONF_HOOD,
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
    DOMAIN,
)
from .models import JoinCode, JoinCodeError

CONF_JOIN_CODE = "join_code"

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_JOIN_CODE): selector.TextSelector(
            selector.TextSelectorConfig(multiline=True)
        )
    }
)


class NeighbourhoodWatchConfigFlow(ConfigFlow, domain=DOMAIN):
    """Pair this property with a neighbourhood."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                code = JoinCode.decode(user_input[CONF_JOIN_CODE])
            except JoinCodeError as err:
                errors["base"] = "invalid_join_code"
                return self.async_show_form(
                    step_id="user",
                    data_schema=STEP_USER_SCHEMA,
                    errors=errors,
                    description_placeholders={"reason": str(err)},
                )

            # One entry per property per hood. Re-pairing with a rotated token
            # updates the existing entry rather than creating a duplicate.
            await self.async_set_unique_id(f"{code.hood}:{code.property_id}")
            self._abort_if_unique_id_configured(
                updates={
                    CONF_RELAY_URL: code.relay_url,
                    CONF_TOKEN: code.token,
                    CONF_PROPERTY_NAME: code.name,
                }
            )

            return self.async_create_entry(
                title=f"{code.name} ({code.hood})",
                data={
                    CONF_RELAY_URL: code.relay_url,
                    CONF_HOOD: code.hood,
                    CONF_PROPERTY_ID: code.property_id,
                    CONF_PROPERTY_NAME: code.name,
                    CONF_TOKEN: code.token,
                    # Binds the join code to this install on first connect, so
                    # a code that leaks afterwards is useless to anyone else.
                    CONF_CLIENT_ID: uuid.uuid4().hex,
                },
                options={
                    CONF_ALERT_HOLD: DEFAULT_ALERT_HOLD,
                    CONF_ALERT_LINGER: DEFAULT_ALERT_LINGER,
                    CONF_SHARE_DETAIL: DEFAULT_SHARE_DETAIL,
                    CONF_ICON: DEFAULT_ICON,
                },
            )

        return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA)

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
        """A revoked or rotated token needs a fresh join code."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        if user_input is not None:
            try:
                code = JoinCode.decode(user_input[CONF_JOIN_CODE])
            except JoinCodeError as err:
                return self.async_show_form(
                    step_id="reauth_confirm",
                    data_schema=STEP_USER_SCHEMA,
                    errors={"base": "invalid_join_code"},
                    description_placeholders={"reason": str(err)},
                )

            if code.property_id != entry.data[CONF_PROPERTY_ID]:
                return self.async_show_form(
                    step_id="reauth_confirm",
                    data_schema=STEP_USER_SCHEMA,
                    errors={"base": "wrong_property"},
                )

            # Update, then abort, and let the entry's own update listener do
            # the reload. Reloading from here as well is what Home Assistant
            # warns about now and stops accepting in 2026.12.
            self.hass.config_entries.async_update_entry(
                entry,
                data={
                    **entry.data,
                    CONF_RELAY_URL: code.relay_url,
                    CONF_TOKEN: code.token,
                    CONF_PROPERTY_NAME: code.name,
                    # A rotated code clears the relay side binding, so mint a
                    # fresh client id to bind to.
                    CONF_CLIENT_ID: uuid.uuid4().hex,
                },
            )
            return self.async_abort(reason="reauth_successful")

        return self.async_show_form(
            step_id="reauth_confirm", data_schema=STEP_USER_SCHEMA
        )

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> NeighbourhoodWatchOptionsFlow:
        return NeighbourhoodWatchOptionsFlow()


class NeighbourhoodWatchOptionsFlow(OptionsFlow):
    """Choose which local entities drive this property's published state."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        current = dict(self.config_entry.options)

        # Suggested values rather than schema defaults. A default that the
        # validator later rejects makes the whole form fail to render with no
        # useful message, which is a miserable thing to debug.
        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_ARMED_ENTITY,
                    description={"suggested_value": current.get(CONF_ARMED_ENTITY)},
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=["input_boolean", "alarm_control_panel", "switch", "binary_sensor"]
                    )
                ),
                vol.Optional(
                    CONF_TRIGGER_ENTITIES,
                    description={"suggested_value": current.get(CONF_TRIGGER_ENTITIES, [])},
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain=["binary_sensor"], multiple=True)
                ),
                vol.Optional(
                    CONF_ALERT_HOLD,
                    description={
                        "suggested_value": current.get(CONF_ALERT_HOLD, DEFAULT_ALERT_HOLD)
                    },
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=0, max=120, step=1, unit_of_measurement="s",
                        mode=selector.NumberSelectorMode.BOX,
                    )
                ),
                vol.Optional(
                    CONF_ALERT_LINGER,
                    description={
                        "suggested_value": current.get(CONF_ALERT_LINGER, DEFAULT_ALERT_LINGER)
                    },
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=30, max=3600, step=30, unit_of_measurement="s",
                        mode=selector.NumberSelectorMode.BOX,
                    )
                ),
                vol.Optional(
                    CONF_SHARE_DETAIL,
                    description={
                        "suggested_value": current.get(CONF_SHARE_DETAIL, DEFAULT_SHARE_DETAIL)
                    },
                ): selector.BooleanSelector(),
                vol.Optional(
                    CONF_ICON,
                    description={"suggested_value": current.get(CONF_ICON, DEFAULT_ICON)},
                ): selector.IconSelector(),
                vol.Optional(
                    CONF_PICTURE,
                    description={"suggested_value": current.get(CONF_PICTURE)},
                ): selector.TextSelector(),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
