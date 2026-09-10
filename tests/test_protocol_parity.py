"""Guards against the relay and the integration drifting apart.

These are cheap file-level checks, but each one covers a bug that was silent in
practice and expensive to find.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELAY = (ROOT / "relay" / "src" / "protocol.js").read_text()
CONST = (ROOT / "custom_components" / "neighbourhood_watch" / "const.py").read_text()


def test_ping_frame_is_byte_identical():
    """The relay auto-responds to this exact frame without waking.

    A mismatch is invisible: the Durable Object falls back to handling the ping
    in code, so pings still work, hibernation is silently defeated, and every
    property wakes the object every thirty seconds forever. json.dumps puts a
    space after the colon by default, which is how this broke the first time.
    """
    relay = re.search(r"export const PING_FRAME = '(.*?)';", RELAY).group(1)
    integration = re.search(r"PING_FRAME: Final = '(.*?)'", CONST).group(1)
    assert relay == integration == '{"t":"ping"}'


def test_publishable_states_match():
    """offline must not be publishable: the relay derives it from connectivity."""
    relay = set(re.findall(r'"(\w+)"', re.search(
        r"PUBLISHABLE_STATES = \[(.*?)\]", RELAY, re.S).group(1)))
    integration = set(re.findall(r'"(\w+)"', re.search(
        r"PUBLISHABLE_STATES: Final = \((.*?)\)", CONST, re.S).group(1)))
    # The integration lists constants rather than literals, so compare the
    # values those constants hold.
    values = {
        name: re.search(rf'{name}: Final = "(\w+)"', CONST).group(1)
        for name in re.findall(r"(STATE_\w+)", re.search(
            r"PUBLISHABLE_STATES: Final = \((.*?)\)", CONST, re.S).group(1))
    }
    assert relay == set(values.values())
    assert "offline" not in relay


def test_protocol_versions_match():
    relay = int(re.search(r"PROTOCOL_VERSION = (\d+)", RELAY).group(1))
    integration = int(re.search(r"PROTOCOL_VERSION: Final = (\d+)", CONST).group(1))
    assert relay == integration


def test_state_priority_agrees():
    """Both ends sort trouble first, and must agree on what trouble is."""
    relay = re.findall(r'"(\w+)"', re.search(
        r"STATE_PRIORITY = \[(.*?)\]", RELAY, re.S).group(1))
    order = re.findall(r"(STATE_\w+)", re.search(
        r"STATE_PRIORITY: Final = \((.*?)\)", CONST, re.S).group(1))
    integration = [
        re.search(rf'{name}: Final = "(\w+)"', CONST).group(1) for name in order
    ]
    assert relay == integration
    assert integration[0] == "panic"
