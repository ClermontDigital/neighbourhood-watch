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
export const PING_FRAME = JSON.stringify({ t: "ping" });
export const PONG_FRAME = JSON.stringify({ t: "pong" });

export const JOIN_CODE_PREFIX = "NW1.";
