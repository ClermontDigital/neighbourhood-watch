import { Hood } from "./hood.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { isValidId, bearerToken, timingSafeEqual, sha256Hex, json } from "./util.js";

export { Hood };

/**
 * Neighbourhood Watch relay.
 *
 * Properties dial out to wss://<host>/hood/<hood>/ws and hold the connection
 * open. Nothing connects inbound to a property, so this works behind the CGNAT
 * that Starlink and 4G impose.
 *
 * The Worker does routing and authentication gating only. All hood state lives
 * in the Hood Durable Object, one instance per neighbourhood.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "neighbourhood-watch-relay", v: PROTOCOL_VERSION });
    }

    const match = path.match(/^\/hood\/([^/]+)\/(ws|admin\/[a-z]+)$/);
    if (!match) return json({ error: "not found" }, 404);

    const [, hood, action] = match;
    if (!isValidId(hood)) return json({ error: "invalid hood id" }, 400);

    if (action === "ws") {
      // Gate before the stub is resolved. env.HOOD.idFromName() creates a new
      // Durable Object for any name, and its constructor provisions SQLite
      // tables, so forwarding unauthenticated requests lets anyone who knows
      // the hostname mint unbounded billed objects by guessing hood ids.
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      if (!bearerToken(request)) {
        return new Response("missing bearer token", { status: 401 });
      }
      if (!(await hoodExists(env, hood))) {
        return new Response("unknown hood", { status: 404 });
      }
      // The Durable Object still authenticates the token itself, since it owns
      // the credential table. This only stops object creation by strangers.
      return hoodStub(env, hood).fetch(request);
    }

    // Everything under /admin is gated here, before the object sees it.
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    if (!(await hoodExists(env, hood)) && !url.pathname.endsWith("/invite")) {
      return new Response("unknown hood", { status: 404 });
    }

    // Invite codes must carry the public relay URL, which only the Worker
    // knows. Fold it into the body rather than making the operator type it.
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const relayUrl = (env.NW_RELAY_URL || `wss://${url.host}`).replace(/\/+$/, "");
    const forwarded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, hood, relay_url: relayUrl }),
    });
    return hoodStub(env, hood).fetch(forwarded);
  },
};

/**
 * Hoods must be declared up front in NW_HOODS, a comma separated list.
 *
 * Without an allowlist any request path creates a Durable Object, which is
 * both a billing problem and an unauthenticated write to storage.
 */
async function hoodExists(env, hood) {
  const declared = String(env.NW_HOODS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  // An empty allowlist means the relay has not been configured yet. Fail
  // closed rather than accepting everything.
  return declared.includes(hood);
}

function hoodStub(env, hood) {
  const id = env.HOOD.idFromName(hood);
  // Pin the object to Oceania. Without a hint it lands wherever the first
  // connection happens to arrive from, which for an Australian neighbourhood
  // could easily be North America.
  return env.HOOD.get(id, { locationHint: env.NW_LOCATION_HINT || "oc" });
}

async function requireAdmin(request, env) {
  const expected = env.NW_ADMIN_TOKEN;
  if (!expected) {
    return json({ error: "relay has no admin token configured" }, 503);
  }
  const presented = bearerToken(request);
  if (!presented) return json({ error: "missing admin token" }, 401);

  // Hash both sides so the comparison is over equal-length hex, which keeps
  // timingSafeEqual meaningful.
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  if (!timingSafeEqual(a, b)) return json({ error: "bad admin token" }, 403);
  return null;
}
