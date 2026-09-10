"""Constants for the Neighbourhood Watch integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "neighbourhood_watch"

# Protocol version. Must match relay/src/protocol.js.
PROTOCOL_VERSION: Final = 1

JOIN_CODE_PREFIX: Final = "NW1."

# States a property can publish about itself.
STATE_DISARMED: Final = "disarmed"
STATE_ARMED: Final = "armed"
STATE_ALERT: Final = "alert"
STATE_PANIC: Final = "panic"
# Never published; derived by the relay from connectivity.
STATE_OFFLINE: Final = "offline"

PUBLISHABLE_STATES: Final = (STATE_DISARMED, STATE_ARMED, STATE_ALERT, STATE_PANIC)

# Highest priority first. The dashboard sorts by this so trouble floats up.
STATE_PRIORITY: Final = (STATE_PANIC, STATE_ALERT, STATE_OFFLINE, STATE_ARMED, STATE_DISARMED)

ALL_STATES: Final = (STATE_PANIC, STATE_ALERT, STATE_ARMED, STATE_DISARMED, STATE_OFFLINE)

# Config entry data, written once at pairing time from the join code.
CONF_RELAY_URL: Final = "relay_url"
CONF_HOOD: Final = "hood"
CONF_PROPERTY_ID: Final = "property_id"
CONF_PROPERTY_NAME: Final = "property_name"
CONF_TOKEN: Final = "token"
# Stable per-install id. The relay binds a join code to the first client that
# presents one, so a code that leaks after pairing is useless to anyone else.
CONF_CLIENT_ID: Final = "client_id"

# Options, editable afterwards.
CONF_ARMED_ENTITY: Final = "armed_entity"
CONF_TRIGGER_ENTITIES: Final = "trigger_entities"
CONF_ALERT_HOLD: Final = "alert_hold"
CONF_ALERT_LINGER: Final = "alert_linger"
CONF_SHARE_DETAIL: Final = "share_detail"
CONF_ICON: Final = "icon"
CONF_PICTURE: Final = "picture"

# Seconds a trigger entity must stay on before it counts as a real detection.
# Matches the 6 second hold already used by the local camera automations.
DEFAULT_ALERT_HOLD: Final = 6
# Seconds an alert keeps showing after the last detection clears. Long enough
# that someone waking up later still sees what happened.
DEFAULT_ALERT_LINGER: Final = 300
DEFAULT_SHARE_DETAIL: Final = True
DEFAULT_ICON: Final = "mdi:home"

# Reconnect backoff, seconds.
RECONNECT_MIN: Final = 2
RECONNECT_MAX: Final = 300
PING_INTERVAL: Final = 30
# Give up on a socket that has gone quiet for this long even if TCP has not
# noticed. Starlink can black-hole a connection without closing it.
RECEIVE_TIMEOUT: Final = 90
# A connection that stayed up at least this long counts as healthy, so the
# backoff resets. Judging by "did connect_once return cleanly" instead lets a
# relay that accepts then immediately closes pin the backoff at its minimum.
HEALTHY_CONNECTION_SECONDS: Final = 60

# Must be byte identical to PING_FRAME in relay/src/protocol.js. json.dumps
# inserts a space after the colon by default, which silently defeats the
# relay's ping auto-response and wakes its Durable Object on every ping.
PING_FRAME: Final = '{"t":"ping"}'

# Events fired on the local bus. Every instance decides for itself what these
# mean; the integration ships no opinion about notifications.
EVENT_STATUS_CHANGED: Final = f"{DOMAIN}_status_changed"
EVENT_LINK_CHANGED: Final = f"{DOMAIN}_link_changed"

# Dispatcher signals are per config entry. A bare domain-wide signal makes two
# configured neighbourhoods cross-contaminate: entry B builds entities for
# entry A's properties, which then sit permanently unavailable.
def signal_property_update(entry_id: str) -> str:
    return f"{DOMAIN}_property_update_{entry_id}"


def signal_property_added(entry_id: str) -> str:
    return f"{DOMAIN}_property_added_{entry_id}"


def signal_local_update(entry_id: str) -> str:
    return f"{DOMAIN}_local_update_{entry_id}"


# Suppress repeat events for the same property and state inside this window.
# Blunts a neighbour that oscillates, on top of the relay's own panic cap.
EVENT_DEDUPE_SECONDS: Final = 30

SERVICE_PANIC: Final = "panic"
SERVICE_CLEAR: Final = "clear"

# Frontend resources, registered once per Home Assistant run.
# nw-base.js is deliberately absent: the other two import it, and registering
# it separately would load the same module under a second URL.
FRONTEND_SCRIPTS: Final = ("nw-cards.js", "nw-strategy.js")
FRONTEND_URL_BASE: Final = f"/{DOMAIN}/frontend"
