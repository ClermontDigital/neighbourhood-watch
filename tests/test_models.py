"""Tests for the pure-python parts: join codes and status payloads.

These deliberately need no Home Assistant install, so they run anywhere.
"""

import base64
import json

import pytest

from nw.const import (
    STATE_ALERT,
    STATE_ARMED,
    STATE_DISARMED,
    STATE_OFFLINE,
    STATE_PANIC,
)
from nw.models import (
    JoinCode,
    JoinCodeError,
    PropertyStatus,
)


def make_code(**overrides):
    payload = {
        "v": 1,
        "u": "wss://nw.example.com/hood/clermont/ws",
        "h": "clermont",
        "p": "coochinn",
        "n": "The Cooch Inn",
        "t": "sekrit-token",
        "exp": None,
    }
    payload.update(overrides)
    for key in [k for k, v in payload.items() if v is _OMIT]:
        del payload[key]
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "NW1." + raw


class _Omit:
    pass


_OMIT = _Omit()


# ---------------------------------------------------------------- join codes


def test_decodes_a_good_code():
    code = JoinCode.decode(make_code())
    assert code.hood == "clermont"
    assert code.property_id == "coochinn"
    assert code.name == "The Cooch Inn"
    assert code.token == "sekrit-token"
    assert code.relay_url.startswith("wss://")


def test_survives_copy_paste_whitespace():
    """A code pasted from a message often arrives wrapped across lines."""
    raw = make_code()
    mangled = f"  {raw[:20]}\n{raw[20:40]} \r\n {raw[40:]}  "
    assert JoinCode.decode(mangled).property_id == "coochinn"


def test_rejects_missing_prefix():
    with pytest.raises(JoinCodeError, match="NW1"):
        JoinCode.decode(make_code()[4:])


def test_rejects_plaintext_relay():
    """The token travels inside the code; it must never cross the wire in clear."""
    with pytest.raises(JoinCodeError, match="wss"):
        JoinCode.decode(make_code(u="ws://nw.example.com/hood/clermont/ws"))


def test_rejects_http_relay():
    with pytest.raises(JoinCodeError, match="wss"):
        JoinCode.decode(make_code(u="https://nw.example.com/hood/clermont/ws"))


def test_rejects_future_protocol():
    with pytest.raises(JoinCodeError, match="protocol"):
        JoinCode.decode(make_code(v=2))


def test_rejects_missing_token():
    with pytest.raises(JoinCodeError, match="token"):
        JoinCode.decode(make_code(t=""))


def test_rejects_garbage():
    with pytest.raises(JoinCodeError):
        JoinCode.decode("NW1.not-valid-base64!!!!")


def test_rejects_non_object_payload():
    raw = base64.urlsafe_b64encode(b'["nope"]').decode().rstrip("=")
    with pytest.raises(JoinCodeError):
        JoinCode.decode("NW1." + raw)


def test_name_falls_back_to_property_id():
    assert JoinCode.decode(make_code(n=_OMIT)).name == "coochinn"


def test_expiry_is_carried_through():
    assert JoinCode.decode(make_code(exp=1800000000)).expires == 1800000000


# ------------------------------------------------------------ status payloads


def test_status_from_relay_payload():
    status = PropertyStatus.from_payload(
        {
            "id": "mckays",
            "name": "McKays",
            "state": STATE_ALERT,
            "detail": "Front gate",
            "since": 1757500000,
            "online": True,
        }
    )
    assert status.id == "mckays"
    assert status.state == STATE_ALERT
    assert status.detail == "Front gate"
    assert status.online is True


def test_status_defaults_when_relay_sends_almost_nothing():
    status = PropertyStatus.from_payload({"id": "x"})
    assert status.name == "x"
    assert status.online is False
    # An absent state must not silently read as armed or disarmed.
    assert status.state == STATE_DISARMED


def test_unknown_state_does_not_crash_priority():
    """A newer relay could introduce a state this version has never seen."""
    status = PropertyStatus.from_payload({"id": "x", "state": "smouldering"})
    assert status.priority == 5  # sorts last rather than raising


def test_priority_orders_trouble_first():
    states = [STATE_DISARMED, STATE_ARMED, STATE_OFFLINE, STATE_ALERT, STATE_PANIC]
    statuses = [PropertyStatus.from_payload({"id": s, "state": s}) for s in states]
    ordered = [s.state for s in sorted(statuses, key=lambda s: s.priority)]
    assert ordered == [STATE_PANIC, STATE_ALERT, STATE_OFFLINE, STATE_ARMED, STATE_DISARMED]


def test_attributes_stay_small():
    """Every attribute of every entity is shipped to every browser on connect."""
    status = PropertyStatus.from_payload({"id": "mckays", "name": "McKays"})
    attributes = status.as_attributes()
    assert len(attributes) <= 10
    assert attributes["nw"] == "property"


def test_empty_detail_becomes_none():
    status = PropertyStatus.from_payload({"id": "x", "detail": ""})
    assert status.detail is None
