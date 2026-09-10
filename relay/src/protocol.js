// Shared protocol constants. Kept in one file so the Worker, the self-hosted
// relay and the Home Assistant integration cannot drift apart.

export const PROTOCOL_VERSION = 1;

// Declared states a property can publish. "offline" is never published by a
// property: it is derived by the relay from connectivity.
export const PUBLISHABLE_STATES = ["disarmed", "armed", "alert", "panic"];

// Full set, highest priority first. Ordering is significant: the dashboard
// sorts by it so trouble floats to the top.
export const STATE_PRIORITY = ["panic", "alert", "offline", "armed", "disarmed"];

// Seconds a property may be disconnected before it is declared offline.
// Starlink drops for 5-15 seconds fairly often and a neighbourhood full of
// false offline alerts is a neighbourhood that stops looking at the dashboard.
export const DEFAULT_GRACE_SECONDS = 90;

// Client ping interval. The relay auto-responds without waking, so this is
// cheap; it exists to keep NAT and CGNAT mappings alive.
export const PING_INTERVAL_SECONDS = 30;

// Guard rails.
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_STATUS_PER_MINUTE = 60;
export const MAX_NAME_LENGTH = 64;
export const MAX_DETAIL_LENGTH = 96;

// Exact frames used for hibernation-safe ping/pong auto-response. These must
// match byte for byte on both ends or the Durable Object wakes for every ping.
// Written as literals rather than JSON.stringify output so the required bytes
// are visible: Python's json.dumps inserts a space after the colon by default,
// which silently defeats auto-response and wakes the object on every ping.
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';

// A socket that has not auto-responded within this many multiples of the ping
// interval is treated as dead. Satellite links black-hole connections without
// ever sending a FIN, so presence in getWebSockets() proves nothing.
export const STALE_PING_MULTIPLIER = 2.5;

// Cap on how often a property may enter panic. A genuine panic always gets
// through; a compromised or malfunctioning property cannot wake the whole
// valley on a loop.
export const MAX_PANIC_PER_HOUR = 6;

// Concurrent sockets per property. More than one is normal briefly during a
// reconnect; hundreds means something is wrong.
export const MAX_SOCKETS_PER_PROPERTY = 3;

// All inbound frames are metered, not just status frames.
export const MAX_FRAMES_PER_MINUTE = 120;

// WebSocket readyState for an open socket. getWebSockets() also returns
// sockets in CLOSING, so presence alone is not liveness.
export const WS_OPEN = 1;

export const JOIN_CODE_PREFIX = "NW1.";
