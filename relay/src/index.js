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
 * The Worker does routing and admin authentication only. All hood state lives
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

    const stub = hoodStub(env, hood);

    if (action === "ws") {
      // The Durable Object authenticates the property token itself, since it
      // owns the credential table.
      return stub.fetch(request);
    }

    // Everything under /admin is gated here, before the object sees it.
    const denied = await requireAdmin(request, env);
    if (denied) return denied;

    // Invite codes must carry the public relay URL, which only the Worker
    // knows. Fold it into the body rather than making the operator type it.
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const relayUrl = (env.NW_RELAY_URL || `wss://${url.host}`).replace(/\/+$/, "");
    const forwarded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, hood, relay_url: relayUrl }),
    });
    return stub.fetch(forwarded);
  },
};

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
