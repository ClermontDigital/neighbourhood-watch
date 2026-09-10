"""Data models and join code handling for Neighbourhood Watch."""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from .const import (
    ALL_STATES,
    JOIN_CODE_PREFIX,
    PROTOCOL_VERSION,
    STATE_DISARMED,
    STATE_OFFLINE,
    STATE_PRIORITY,
)


class JoinCodeError(ValueError):
    """Raised when a join code cannot be used."""


def _b64_decode(payload: str) -> bytes:
    """Decode base64url that may have had its padding stripped.

    validate=True matters: without it base64 silently discards any character
    outside the alphabet, so obvious rubbish decodes to plausible-looking bytes
    and fails later with a far less helpful message.
    """
    padding = "=" * (-len(payload) % 4)
    try:
        # urlsafe_b64decode takes no validate flag, so go through b64decode
        # with the urlsafe alphabet supplied explicitly.
        return base64.b64decode(payload + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as err:
        raise JoinCodeError("join code is not valid base64") from err


@dataclass(frozen=True, slots=True)
class JoinCode:
    """A pairing credential, produced by the hood owner and pasted in once."""

    relay_url: str
    hood: str
    property_id: str
    name: str
    token: str
    expires: int | None

    @classmethod
    def decode(cls, raw: str) -> JoinCode:
        """Parse and validate a join code, raising JoinCodeError if unusable."""
        text = (raw or "").strip()
        # Tolerate whitespace and line breaks introduced by copy and paste.
        text = "".join(text.split())
        if not text.startswith(JOIN_CODE_PREFIX):
            raise JoinCodeError("join code must start with NW1.")

        try:
            data = json.loads(_b64_decode(text[len(JOIN_CODE_PREFIX) :]))
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            # UnicodeDecodeError is not a JSONDecodeError. Without it here, a
            # mistyped code escapes as an unhandled exception and the config
            # flow shows a traceback instead of "that code is not valid".
            raise JoinCodeError("join code does not contain valid data") from err

        if not isinstance(data, dict):
            raise JoinCodeError("join code does not contain valid data")

        version = data.get("v", PROTOCOL_VERSION)
        if version != PROTOCOL_VERSION:
            raise JoinCodeError(
                f"join code is for protocol v{version}, this version speaks v{PROTOCOL_VERSION}"
            )

        url = str(data.get("u") or "")
        parsed = urlparse(url)
        # Refuse plaintext. The token is in the code; it must not cross the
        # internet in the clear.
        if parsed.scheme != "wss" or not parsed.netloc:
            raise JoinCodeError("join code must point at a wss:// relay")

        for key, label in (("h", "hood"), ("p", "property id"), ("t", "token")):
            if not data.get(key):
                raise JoinCodeError(f"join code is missing its {label}")

        expires = data.get("exp")
        return cls(
            relay_url=url,
            hood=str(data["h"]),
            property_id=str(data["p"]),
            name=str(data.get("n") or data["p"]),
            token=str(data["t"]),
            expires=int(expires) if expires else None,
        )


@dataclass(slots=True)
class PropertyStatus:
    """The state of one property in the neighbourhood, local or remote."""

    id: str
    name: str
    state: str = STATE_OFFLINE
    detail: str | None = None
    icon: str | None = None
    picture: str | None = None
    since: int | None = None
    last_seen: int | None = None
    online: bool = False

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> PropertyStatus:
        """Build from a relay payload, defending against anything unexpected."""
        state = payload.get("state")
        if state not in ALL_STATES:
            # A newer relay could introduce a state this version has never
            # heard of. Showing offline is wrong; showing disarmed is a
            # dangerous lie. Fall back to the value only if it is a string we
            # can display, otherwise disarmed.
            state = state if isinstance(state, str) and state else STATE_DISARMED

        return cls(
            id=str(payload.get("id") or ""),
            name=str(payload.get("name") or payload.get("id") or "Unknown"),
            state=state,
            detail=payload.get("detail") or None,
            icon=payload.get("icon") or None,
            picture=payload.get("picture") or None,
            since=payload.get("since"),
            last_seen=payload.get("last_seen"),
            online=bool(payload.get("online")),
        )

    @property
    def priority(self) -> int:
        """Lower sorts first. Unknown states sort last rather than crashing."""
        try:
            return STATE_PRIORITY.index(self.state)
        except ValueError:
            return len(STATE_PRIORITY)

    def as_attributes(self) -> dict[str, Any]:
        """Attributes for the status sensor.

        Kept deliberately small: every attribute of every entity is sent to
        every connected browser on load.
        """
        return {
            # Lets the dashboard cards find these entities without
            # pattern matching on entity ids.
            "nw": "property",
            "property_id": self.id,
            "property_name": self.name,
            "detail": self.detail,
            "icon_hint": self.icon,
            "picture": self.picture,
            "since": self.since,
            "last_seen": self.last_seen,
            "online": self.online,
        }
