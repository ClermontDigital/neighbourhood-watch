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
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

from .const import (
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
        *,
        on_snapshot: Callable[[list[dict[str, Any]]], Awaitable[None]],
        on_update: Callable[[dict[str, Any]], Awaitable[None]],
        on_link: Callable[[bool], Awaitable[None]],
        on_rejected: Callable[[str], Awaitable[None]],
    ) -> None:
        self._session = session
        self._url = url
        self._token = token
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

    async def async_stop(self) -> None:
        self._closing = True
        await self._cancel(self._pinger)
        self._pinger = None
        if self._ws is not None and not self._ws.closed:
            with contextlib.suppress(Exception):
                await self._ws.close()
        await self._cancel(self._runner)
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
            try:
                await self._connect_once()
                # A clean return means the relay closed on us. Reset the
                # backoff so a routine restart reconnects promptly.
                attempt = 0
            except asyncio.CancelledError:
                raise
            except RelayRejected as err:
                _LOGGER.error("Relay rejected this property: %s", err.reason)
                await self._set_connected(False)
                await self._on_rejected(err.reason)
                return
            except Exception as err:  # noqa: BLE001 - transport must never die
                attempt += 1
                _LOGGER.debug("Relay connection failed (attempt %s): %s", attempt, err)
            else:
                attempt += 1

            await self._set_connected(False)
            if self._closing:
                return

            delay = min(RECONNECT_MAX, RECONNECT_MIN * (2 ** min(attempt, 8)))
            # Jitter matters here: every property in the hood reconnects at the
            # same moment after a relay restart, and a synchronised stampede
            # looks exactly like an attack.
            delay = delay * (0.5 + random.random() / 2)
            _LOGGER.debug("Reconnecting to relay in %.1fs", delay)
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                raise

    async def _connect_once(self) -> None:
        headers = {"Authorization": f"Bearer {self._token}"}
        async with self._session.ws_connect(
            self._url,
            headers=headers,
            heartbeat=None,  # we send our own application-level ping
            timeout=aiohttp.ClientWSTimeout(ws_close=10),
            max_msg_size=64 * 1024,
        ) as ws:
            self._ws = ws
            await self._set_connected(True)

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
        # Durable Object, so it must stay byte for byte identical.
        frame = json.dumps({"t": "ping"})
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
