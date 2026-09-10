"""WebSocket transport to the Neighbourhood Watch relay.

The connection is always outbound. Nothing ever connects in to a property,
which is what makes this work behind the CGNAT that Starlink and 4G impose.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

from .const import (
    HEALTHY_CONNECTION_SECONDS,
    PING_FRAME,
    PING_INTERVAL,
    PROTOCOL_VERSION,
    RECEIVE_TIMEOUT,
    RECONNECT_MAX,
    RECONNECT_MIN,
)

_LOGGER = logging.getLogger(__name__)


class RelayRejected(Exception):
    """The relay refused this credential and retrying will not help."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class RelayClient:
    """Maintains one long-lived WebSocket to the hood relay."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        url: str,
        token: str,
        client_id: str,
        *,
        on_snapshot: Callable[[list[dict[str, Any]]], Awaitable[None]],
        on_update: Callable[[dict[str, Any]], Awaitable[None]],
        on_link: Callable[[bool], Awaitable[None]],
        on_rejected: Callable[[str], Awaitable[None]],
    ) -> None:
        self._session = session
        self._url = url
        self._token = token
        self._client_id = client_id
        self._on_snapshot = on_snapshot
        self._on_update = on_update
        self._on_link = on_link
        self._on_rejected = on_rejected

        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._runner: asyncio.Task[None] | None = None
        self._pinger: asyncio.Task[None] | None = None
        self._closing = False
        self._connected = False
        self._hello: dict[str, Any] = {}
        # Last status published, replayed after every reconnect so the relay
        # never holds a stale view of this property.
        self._last_status: dict[str, Any] | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    def set_profile(self, name: str, icon: str | None, picture: str | None) -> None:
        """Set the display identity sent on connect."""
        self._hello = {"t": "hello", "v": PROTOCOL_VERSION, "name": name}
        if icon:
            self._hello["icon"] = icon
        if picture:
            self._hello["picture"] = picture

    async def async_start(self) -> None:
        if self._runner is None or self._runner.done():
            self._closing = False
            self._runner = asyncio.create_task(self._run())
            self._runner.add_done_callback(self._runner_finished)

    def _runner_finished(self, task: asyncio.Task[None]) -> None:
        """Never let the connection loop die quietly.

        _run calls back into Home Assistant, and a listener that raises would
        otherwise kill this task with nothing but "Task exception was never
        retrieved" in the log, leaving the property permanently disconnected
        with no repair notice and no unavailable entity.
        """
        if task.cancelled() or self._closing:
            return
        err = task.exception()
        if err is None:
            return
        _LOGGER.error("Relay connection loop stopped unexpectedly: %s", err, exc_info=err)
        self._runner = None

    async def async_stop(self) -> None:
        self._closing = True
        await self._cancel(self._pinger)
        self._pinger = None
        # Cancel the reader before closing, and bound the close handshake. On a
        # black-holed satellite link the handshake otherwise waits its full
        # timeout inside async_unload_entry and stalls the reload.
        await self._cancel(self._runner)
        if self._ws is not None and not self._ws.closed:
            with contextlib.suppress(Exception, TimeoutError):
                async with asyncio.timeout(2):
                    await self._ws.close()
        self._runner = None
        await self._set_connected(False)

    @staticmethod
    async def _cancel(task: asyncio.Task[None] | None) -> None:
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def async_send_status(self, state: str, detail: str | None, since: int | None) -> None:
        """Publish this property's state. Cached and replayed on reconnect."""
        payload: dict[str, Any] = {"t": "status", "state": state, "detail": detail}
        if since is not None:
            payload["since"] = since
        self._last_status = payload
        await self._send(payload)

    async def _send(self, payload: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None or ws.closed:
            # Not an error: the run loop replays the cached status once the
            # socket comes back.
            return
        try:
            await ws.send_str(json.dumps(payload))
        except (aiohttp.ClientError, ConnectionError) as err:
            _LOGGER.debug("Send failed, connection will be retried: %s", err)

    async def _run(self) -> None:
        attempt = 0
        while not self._closing:
            started = time.monotonic()
            try:
                await self._connect_once()
            except asyncio.CancelledError:
                raise
            except RelayRejected as err:
                _LOGGER.error("Relay rejected this property: %s", err.reason)
                await self._safely_disconnect()
                await self._on_rejected(err.reason)
                return
            except Exception as err:  # noqa: BLE001 - transport must never die
                _LOGGER.debug("Relay connection failed: %s", err)

            # Reset the backoff on a connection that actually stayed up, not on
            # one that merely returned without raising. A relay that accepts
            # and immediately closes returns cleanly every time, which would
            # otherwise pin every property in the hood at the minimum delay and
            # produce exactly the synchronised hammering the jitter avoids.
            if time.monotonic() - started >= HEALTHY_CONNECTION_SECONDS:
                attempt = 0
            else:
                attempt += 1

            await self._safely_disconnect()
            if self._closing:
                return

            delay = min(RECONNECT_MAX, RECONNECT_MIN * (2 ** min(max(attempt - 1, 0), 8)))
            # Jitter matters here: every property in the hood reconnects at the
            # same moment after a relay restart, and a synchronised stampede
            # looks exactly like an attack.
            delay = delay * (0.5 + random.random() / 2)
            _LOGGER.debug("Reconnecting to relay in %.1fs", delay)
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                raise

    async def _safely_disconnect(self) -> None:
        """Report the link as down without letting a listener kill the loop.

        _set_connected fans out to dispatcher listeners that run inline, so one
        entity raising during a state write would otherwise propagate out of
        the reconnect loop and stop it for good.
        """
        try:
            await self._set_connected(False)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Listener raised while reporting the link as down")

    async def _connect_once(self) -> None:
        headers = {
            "Authorization": f"Bearer {self._token}",
            # Binds the join code to this install on first use, so a code that
            # leaks afterwards cannot be used by anyone else.
            "X-NW-Client": self._client_id,
        }
        async with self._session.ws_connect(
            self._url,
            headers=headers,
            heartbeat=None,  # we send our own application-level ping
            timeout=aiohttp.ClientWSTimeout(ws_close=10),
            max_msg_size=64 * 1024,
        ) as ws:
            self._ws = ws
            try:
                await self._set_connected(True)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Listener raised while reporting the link as up")

            if self._hello:
                await self._send(self._hello)
            if self._last_status is not None:
                await self._send(self._last_status)

            self._pinger = asyncio.create_task(self._ping_loop())
            try:
                await self._receive_loop(ws)
            finally:
                await self._cancel(self._pinger)
                self._pinger = None
                self._ws = None

    async def _receive_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        while not self._closing:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=RECEIVE_TIMEOUT)
            except TimeoutError:
                # Starlink can black-hole a connection without closing it, so
                # silence past the timeout means the socket is dead even though
                # TCP has not worked it out yet.
                _LOGGER.debug("No traffic from relay in %ss, reconnecting", RECEIVE_TIMEOUT)
                await ws.close()
                return

            if msg.type is aiohttp.WSMsgType.TEXT:
                await self._handle(msg.data)
            elif msg.type in (
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSING,
                aiohttp.WSMsgType.CLOSED,
                aiohttp.WSMsgType.ERROR,
            ):
                return

    async def _handle(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            _LOGGER.debug("Ignoring unparseable frame from relay")
            return
        if not isinstance(msg, dict):
            return

        kind = msg.get("t")
        if kind == "snapshot":
            properties = msg.get("properties")
            await self._on_snapshot(properties if isinstance(properties, list) else [])
        elif kind == "update":
            prop = msg.get("property")
            if isinstance(prop, dict):
                await self._on_update(prop)
        elif kind == "bye":
            reason = str(msg.get("reason") or "closed by relay")
            if reason in ("revoked", "token_rotated"):
                raise RelayRejected(reason)
            _LOGGER.info("Relay closed the connection: %s", reason)
        elif kind == "error":
            _LOGGER.warning(
                "Relay rejected a message: %s (%s)", msg.get("message"), msg.get("code")
            )
        elif kind in ("welcome", "pong"):
            _LOGGER.debug("Relay %s", kind)

    async def _ping_loop(self) -> None:
        # The relay auto-responds to this exact frame without waking its
        # Durable Object, so it must stay byte for byte identical. json.dumps
        # puts a space after the colon by default, which does not match.
        frame = PING_FRAME
        while True:
            await asyncio.sleep(PING_INTERVAL)
            ws = self._ws
            if ws is None or ws.closed:
                return
            try:
                await ws.send_str(frame)
            except (aiohttp.ClientError, ConnectionError):
                return

    async def _set_connected(self, value: bool) -> None:
        if value == self._connected:
            return
        self._connected = value
        await self._on_link(value)
