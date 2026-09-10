import { DurableObject } from "cloudflare:workers";
import {
  PROTOCOL_VERSION,
  PUBLISHABLE_STATES,
  DEFAULT_GRACE_SECONDS,
  PING_INTERVAL_SECONDS,
  STALE_PING_MULTIPLIER,
  MAX_PANIC_PER_HOUR,
  MAX_SOCKETS_PER_PROPERTY,
  MAX_FRAMES_PER_MINUTE,
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_DETAIL_LENGTH,
  WS_OPEN,
  PING_FRAME,
  PONG_FRAME,
} from "./protocol.js";
import {
  nowSeconds,
  sha256Hex,
  timingSafeEqual,
  randomToken,
  encodeJoinCode,
  isValidId,
  slugify,
  bearerToken,
  json,
  clampText,
  safePictureUrl,
  byteLength,
} from "./util.js";

const SWEEP_INTERVAL_SECONDS = 30;
const STALE_SOCKET_SECONDS = Math.ceil(PING_INTERVAL_SECONDS * STALE_PING_MULTIPLIER);

/**
 * One Durable Object instance per neighbourhood ("hood"). It is the single
 * source of truth for who belongs to the hood, who is connected right now, and
 * what state each property is in.
 *
 * Every property holds one outbound WebSocket to this object. Nothing ever
 * connects inbound to a property, which is what makes this work behind the
 * CGNAT that Starlink and 4G both impose.
 */
export class Hood extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.frameBudget = new Map();

    ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
      // Ping and pong are answered by the runtime without waking this object,
      // so an idle hood costs nothing while connections stay alive.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME)
      );
    });
  }

  #migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS properties (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        icon        TEXT,
        picture     TEXT,
        token_hash  TEXT NOT NULL,
        revoked     INTEGER NOT NULL DEFAULT 0,
        created     INTEGER NOT NULL,
        expires     INTEGER,
        bound_client TEXT
      );
      CREATE TABLE IF NOT EXISTS status (
        id              TEXT PRIMARY KEY,
        state           TEXT NOT NULL DEFAULT 'disarmed',
        detail          TEXT,
        since           INTEGER NOT NULL,
        last_seen       INTEGER NOT NULL,
        disconnected_at INTEGER,
        panic_window    INTEGER NOT NULL DEFAULT 0,
        panic_count     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  #grace() {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'grace'").toArray()[0];
    return row ? Number(row.value) : DEFAULT_GRACE_SECONDS;
  }

  /**
   * Sockets that are actually usable for a property.
   *
   * getWebSockets() also returns sockets in CLOSING, so presence in that array
   * is not liveness. Treating a draining socket as live is what previously let
   * a revoked property block its own grace clock forever.
   */
  #liveSockets(propertyId) {
    return this.ctx
      .getWebSockets(propertyId)
      .filter((ws) => ws.readyState === WS_OPEN);
  }

  // ------------------------------------------------------------------
  // Routing
  // ------------------------------------------------------------------

  async fetch(request) {
    const path = new URL(request.url).pathname;
    // Check admin before ws: an /admin/ path must never fall into the upgrade
    // handler just because it happens to end in the wrong characters.
    if (path.includes("/admin/")) return this.#handleAdmin(request, path);
    if (path.endsWith("/ws")) return this.#handleUpgrade(request);
    return new Response("not found", { status: 404 });
  }

  // ------------------------------------------------------------------
  // WebSocket lifecycle
  // ------------------------------------------------------------------

  async #handleUpgrade(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const token = bearerToken(request);
    if (!token) return new Response("missing bearer token", { status: 401 });

    const clientId = clampText(request.headers.get("X-NW-Client"), 64);
    const property = await this.#authenticate(token, clientId);
    if (!property) return new Response("invalid or revoked token", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag by property id so a revoke can find and close exactly its sockets.
    this.ctx.acceptWebSocket(server, [property.id]);
    server.serializeAttachment({ propertyId: property.id, connectedAt: nowSeconds() });

    // Cap concurrency. One extra socket is normal during a reconnect that
    // overlapped; a pile of them is a property flooding the relay, and each
    // one multiplies every broadcast.
    const live = this.#liveSockets(property.id);
    if (live.length > MAX_SOCKETS_PER_PROPERTY) {
      for (const old of live.slice(0, live.length - MAX_SOCKETS_PER_PROPERTY)) {
        if (old === server) continue;
        this.#closeSocket(old, "too_many_connections", 4008);
      }
    }

    const now = nowSeconds();
    this.sql.exec(
      `INSERT INTO status (id, state, detail, since, last_seen, disconnected_at)
       VALUES (?, 'disarmed', NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         last_seen = excluded.last_seen,
         disconnected_at = NULL,
         -- A property that reconnects is no longer offline. Without this it is
         -- broadcast as state "offline" with online true, and a neighbour's
         -- offline automation fires on it coming back.
         state = CASE WHEN status.state = 'offline' THEN 'disarmed' ELSE status.state END,
         since = CASE WHEN status.state = 'offline' THEN excluded.since ELSE status.since END`,
      property.id,
      now,
      now
    );

    server.send(
      JSON.stringify({
        t: "welcome",
        v: PROTOCOL_VERSION,
        property_id: property.id,
        name: property.name,
        grace: this.#grace(),
        ping_interval: PING_INTERVAL_SECONDS,
      })
    );
    server.send(JSON.stringify({ t: "snapshot", properties: this.#allProperties() }));

    // Everyone else learns this property came back.
    this.#broadcast(this.#propertyView(property.id), server);
    await this.#scheduleSweep();

    return new Response(null, { status: 101, webSocket: client });
  }

  async #authenticate(token, clientId) {
    const hash = await sha256Hex(token);
    const rows = this.sql
      .exec(
        "SELECT id, name, icon, picture, token_hash, revoked, expires, bound_client FROM properties"
      )
      .toArray();
    const now = nowSeconds();

    for (const row of rows) {
      if (!timingSafeEqual(row.token_hash, hash)) continue;
      if (row.revoked) return null;
      if (row.expires && row.expires < now) return null;

      // First-use binding. A join code that leaks after the property has
      // connected once is useless to anyone else, because their client id will
      // not match. Clients that send no id are not bound, which keeps
      // third-party implementations working.
      if (clientId) {
        if (row.bound_client && row.bound_client !== clientId) return null;
        if (!row.bound_client) {
          this.sql.exec("UPDATE properties SET bound_client = ? WHERE id = ?", clientId, row.id);
        }
      }
      return row;
    }
    return null;
  }

  async webSocketMessage(ws, raw) {
    const { propertyId } = ws.deserializeAttachment() || {};
    if (!propertyId) return ws.close(1011, "unidentified socket");

    // Meter every frame, not just status frames. hello, malformed frames and
    // unrecognised types all cost SQL writes or broadcasts, and previously
    // none of them were counted.
    if (!this.#withinBudget(propertyId)) {
      return this.#closeSocket(ws, "rate_limited", 4029);
    }

    if (typeof raw !== "string" || byteLength(raw) > MAX_MESSAGE_BYTES) {
      return this.#fail(ws, "too_large", "message rejected");
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.#fail(ws, "bad_json", "could not parse message");
    }
    if (!msg || typeof msg !== "object") {
      return this.#fail(ws, "bad_json", "could not parse message");
    }

    switch (msg.t) {
      case "ping":
        // Only reached when a client's ping is not byte-identical to
        // PING_FRAME, which means auto-response missed it and this object woke
        // up for nothing. Worth knowing about.
        console.warn(`[hood] ping from ${propertyId} missed auto-response`);
        return ws.send(PONG_FRAME);
      case "hello":
        return this.#handleHello(ws, propertyId, msg);
      case "status":
        return this.#handleStatus(ws, propertyId, msg);
      default:
        return this.#fail(ws, "unknown_type", `unknown message type ${msg.t}`);
    }
  }

  #handleHello(ws, propertyId, msg) {
    // A property may set its own display name, icon and picture, and nobody
    // else's. Identity itself comes from the authenticated token.
    const name = clampText(msg.name, MAX_NAME_LENGTH);
    const icon = clampText(msg.icon, MAX_NAME_LENGTH);
    // Rejected outright unless it is a plain https URL. This value ends up in
    // a CSS url() and an entity_picture on every neighbour's dashboard.
    const picture = safePictureUrl(msg.picture);

    const before = this.sql
      .exec("SELECT name, icon, picture FROM properties WHERE id = ?", propertyId)
      .toArray()[0];

    this.sql.exec(
      `UPDATE properties
       SET name = COALESCE(?, name), icon = COALESCE(?, icon), picture = COALESCE(?, picture)
       WHERE id = ?`,
      name,
      icon,
      picture,
      propertyId
    );
    this.#touch(propertyId);

    // Only broadcast when the profile actually changed. A property looping on
    // hello previously fanned out to every socket in the hood on every frame,
    // and each of those became a state write and a recorder row in every other
    // household's Home Assistant.
    const after = this.sql
      .exec("SELECT name, icon, picture FROM properties WHERE id = ?", propertyId)
      .toArray()[0];
    if (
      !before ||
      before.name !== after.name ||
      before.icon !== after.icon ||
      before.picture !== after.picture
    ) {
      this.#broadcast(this.#propertyView(propertyId));
    }
  }

  #handleStatus(ws, propertyId, msg) {
    if (!PUBLISHABLE_STATES.includes(msg.state)) {
      return this.#fail(ws, "bad_state", `state must be one of ${PUBLISHABLE_STATES.join(", ")}`);
    }

    const now = nowSeconds();
    const detail = clampText(msg.detail, MAX_DETAIL_LENGTH);
    const current = this.sql
      .exec("SELECT state, since, panic_window, panic_count FROM status WHERE id = ?", propertyId)
      .toArray()[0];

    const changed = !current || current.state !== msg.state;

    // Entering panic is capped per hour. A genuine panic always gets through;
    // a compromised or malfunctioning property cannot loop panic and disarmed
    // to wake every household in the valley all night. The only other remedy
    // is the hood owner being awake to revoke it.
    if (msg.state === "panic" && changed) {
      const hour = Math.floor(now / 3600);
      const window = current && current.panic_window === hour ? current.panic_count : 0;
      if (window >= MAX_PANIC_PER_HOUR) {
        return this.#fail(ws, "panic_rate_limited", "too many panics this hour");
      }
      this.sql.exec(
        "UPDATE status SET panic_window = ?, panic_count = ? WHERE id = ?",
        hour,
        window + 1,
        propertyId
      );
    }

    // Keep "since" anchored to when the state actually began, not to the last
    // heartbeat, so the dashboard can say ARMED 3h rather than ARMED 30s.
    const since = changed ? now : current.since;

    this.sql.exec(
      `INSERT INTO status (id, state, detail, since, last_seen, disconnected_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state, detail = excluded.detail,
         since = excluded.since, last_seen = excluded.last_seen, disconnected_at = NULL`,
      propertyId,
      msg.state,
      detail,
      since,
      now
    );

    // Nothing changed but the clock: no reason to wake every other household.
    if (!changed && current && (current.detail || null) === detail) return;
    this.#broadcast(this.#propertyView(propertyId));
  }

  async webSocketClose(ws) {
    await this.#onDisconnect(ws);
  }

  async webSocketError(ws) {
    await this.#onDisconnect(ws);
  }

  async #onDisconnect(ws) {
    const { propertyId } = ws.deserializeAttachment() || {};
    if (!propertyId) return;

    // Another socket may still be live for this property, for example during a
    // reconnect that overlapped. Only start the grace clock when the last one
    // goes, and count only genuinely open sockets.
    const live = this.#liveSockets(propertyId).filter((s) => s !== ws);
    if (live.length > 0) return;

    await this.#markGone(propertyId);
  }

  async #markGone(propertyId) {
    const now = nowSeconds();
    this.sql.exec(
      `UPDATE status SET disconnected_at = COALESCE(disconnected_at, ?), last_seen = ?
       WHERE id = ?`,
      now,
      now,
      propertyId
    );
    // Do not broadcast offline yet. That is what the grace window is for: a
    // fifteen second Starlink blip must not light up the whole street.
    await this.#scheduleSweep();
  }

  // ------------------------------------------------------------------
  // Grace window sweep
  // ------------------------------------------------------------------

  async #scheduleSweep(delaySeconds = SWEEP_INTERVAL_SECONDS) {
    const target = Date.now() + delaySeconds * 1000;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing <= target) return;
    await this.ctx.storage.setAlarm(target);
  }

  async alarm() {
    const grace = this.#grace();
    const now = nowSeconds();

    // 1. Reap sockets that have gone quiet. A satellite link can black-hole a
    //    connection without ever closing it, so a socket sitting in
    //    getWebSockets() proves nothing. Without this a house that has fallen
    //    off the internet reads as armed and fine forever, which is the worst
    //    possible direction for this to fail in.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      const stamp = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const lastHeard = stamp
        ? Math.floor(stamp.getTime() / 1000)
        : attachment.connectedAt || now;
      if (now - lastHeard > STALE_SOCKET_SECONDS) {
        this.#closeSocket(ws, "stale", 1001);
        if (attachment.propertyId) await this.#markGone(attachment.propertyId);
      }
    }

    // 2. Enforce revocation and expiry on established sessions, not just at
    //    connect. Hibernation means a socket can live indefinitely at no cost,
    //    so an expiring credential otherwise grants an unbounded session.
    for (const row of this.sql
      .exec("SELECT id FROM properties WHERE revoked = 1 OR (expires IS NOT NULL AND expires < ?)", now)
      .toArray()) {
      for (const ws of this.#liveSockets(row.id)) {
        this.#closeSocket(ws, "revoked", 4003);
      }
    }

    // 3. Expire grace windows.
    let nextDue = null;
    for (const row of this.sql.exec("SELECT id, state, disconnected_at FROM status").toArray()) {
      if (this.#liveSockets(row.id).length > 0) continue;
      if (row.state === "offline") continue;

      // A property with no socket and no disconnect timestamp was never given
      // one, for example because its socket was closed server side. Treat it
      // as gone now rather than leaving it showing armed forever.
      const goneAt = row.disconnected_at === null ? now : row.disconnected_at;
      if (row.disconnected_at === null) {
        this.sql.exec("UPDATE status SET disconnected_at = ? WHERE id = ?", now, row.id);
      }

      const due = goneAt + grace;
      if (now >= due) {
        this.sql.exec(
          "UPDATE status SET state = 'offline', detail = NULL, since = ? WHERE id = ?",
          goneAt,
          row.id
        );
        this.#broadcast(this.#propertyView(row.id));
      } else {
        nextDue = nextDue === null ? due : Math.min(nextDue, due);
      }
    }

    // Reschedule only while something is genuinely pending. An alarm prevents
    // hibernation, so polling every 30s whenever anyone is connected, as this
    // used to, meant the object never slept at all.
    const haveSockets = this.ctx.getWebSockets().length > 0;
    if (nextDue !== null) {
      await this.#scheduleSweep(Math.max(1, nextDue - now));
    } else if (haveSockets) {
      // Still need a slow heartbeat to catch black-holed sockets.
      await this.#scheduleSweep(STALE_SOCKET_SECONDS);
    }
  }

  // ------------------------------------------------------------------
  // Views and broadcast
  // ------------------------------------------------------------------

  #propertyView(propertyId) {
    const row = this.sql
      .exec(
        `SELECT p.id, p.name, p.icon, p.picture,
                s.state, s.detail, s.since, s.last_seen, s.disconnected_at
         FROM properties p LEFT JOIN status s ON s.id = p.id
         WHERE p.id = ? AND p.revoked = 0`,
        propertyId
      )
      .toArray()[0];
    if (!row) return null;
    return this.#shape(row, this.#grace(), nowSeconds());
  }

  #allProperties() {
    const grace = this.#grace();
    const now = nowSeconds();
    return this.sql
      .exec(
        `SELECT p.id, p.name, p.icon, p.picture,
                s.state, s.detail, s.since, s.last_seen, s.disconnected_at
         FROM properties p LEFT JOIN status s ON s.id = p.id
         WHERE p.revoked = 0`
      )
      .toArray()
      .map((row) => this.#shape(row, grace, now));
  }

  #shape(row, grace, now) {
    const live = this.#liveSockets(row.id).length > 0;
    // Inside the grace window a property still counts as online and keeps
    // showing its last known state.
    const withinGrace =
      row.disconnected_at !== null &&
      row.disconnected_at !== undefined &&
      now - row.disconnected_at < grace;
    const online = live || withinGrace;

    let state = row.state || "disarmed";
    if (!online) state = "offline";
    // Never report offline alongside online: the two disagreeing is what makes
    // a reconnecting property fire a neighbour's offline automation.
    else if (state === "offline") state = "disarmed";

    return {
      id: row.id,
      name: row.name,
      icon: row.icon || null,
      picture: row.picture || null,
      state,
      detail: online ? row.detail || null : null,
      since: row.since || now,
      last_seen: row.last_seen || now,
      online,
    };
  }

  #broadcast(property, except = null) {
    if (!property) return;
    const frame = JSON.stringify({ t: "update", property });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      if (socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(frame);
      } catch {
        // Socket is on its way out; the close handler will tidy up.
      }
    }
  }

  #closeSocket(ws, reason, code) {
    // send and close get their own try blocks. Sharing one means a throwing
    // send silently skips the close, and a revoked property keeps its socket.
    try {
      ws.send(JSON.stringify({ t: "bye", reason }));
    } catch {
      // ignore
    }
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  #touch(propertyId) {
    this.sql.exec(
      "UPDATE status SET last_seen = ?, disconnected_at = NULL WHERE id = ?",
      nowSeconds(),
      propertyId
    );
  }

  #withinBudget(propertyId) {
    const minute = Math.floor(Date.now() / 60000);
    const entry = this.frameBudget.get(propertyId);
    if (!entry || entry.minute !== minute) {
      this.frameBudget.set(propertyId, { minute, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_FRAMES_PER_MINUTE;
  }

  #fail(ws, code, message) {
    try {
      ws.send(JSON.stringify({ t: "error", code, message }));
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------
  // Admin API. Reached only after the Worker has checked the admin token.
  // ------------------------------------------------------------------

  async #handleAdmin(request, path) {
    const action = path.split("/admin/")[1];
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (action === "properties") return json({ properties: this.#adminList() });
    if (action === "invite") return this.#invite(body);
    if (action === "revoke") return this.#revoke(body);
    if (action === "grace") return this.#setGrace(body);
    return json({ error: "unknown admin action" }, 404);
  }

  #adminList() {
    const grace = this.#grace();
    const now = nowSeconds();
    return this.sql
      .exec(
        `SELECT p.id, p.name, p.icon, p.picture, p.revoked, p.created, p.expires, p.bound_client,
                s.state, s.detail, s.since, s.last_seen, s.disconnected_at
         FROM properties p LEFT JOIN status s ON s.id = p.id`
      )
      .toArray()
      .map((row) => ({
        ...this.#shape(row, grace, now),
        revoked: Boolean(row.revoked),
        bound: Boolean(row.bound_client),
        created: row.created,
        expires: row.expires,
      }));
  }

  async #invite(body) {
    const id = isValidId(body.id) ? body.id : slugify(body.name || body.id || "");
    if (!isValidId(id)) {
      return json({ error: "id must be lowercase alphanumeric with hyphens" }, 400);
    }

    const existing = this.sql.exec("SELECT id FROM properties WHERE id = ?", id).toArray()[0];
    if (existing && !body.rotate) {
      return json({ error: `property ${id} already exists, pass rotate to reissue` }, 409);
    }

    const name = clampText(body.name, MAX_NAME_LENGTH) || id;
    const icon = clampText(body.icon, MAX_NAME_LENGTH) || "mdi:home";
    const picture = safePictureUrl(body.picture);
    if (body.picture && !picture) {
      return json({ error: "picture must be an https:// URL" }, 400);
    }

    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const now = nowSeconds();

    let expires = null;
    if (body.expires_in !== undefined && body.expires_in !== null) {
      const seconds = Number(body.expires_in);
      // NaN would bind as NULL, silently turning "expires in a day" into
      // "never expires".
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return json({ error: "expires_in must be a positive number of seconds" }, 400);
      }
      expires = now + Math.floor(seconds);
    }

    this.sql.exec(
      `INSERT INTO properties (id, name, icon, picture, token_hash, revoked, created, expires, bound_client)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, icon = excluded.icon, picture = excluded.picture,
         token_hash = excluded.token_hash, revoked = 0, expires = excluded.expires,
         -- A rotated code is meant for a new install, so drop the old binding.
         bound_client = NULL`,
      id,
      name,
      icon,
      picture,
      tokenHash,
      now,
      expires
    );
    this.sql.exec(
      `INSERT INTO status (id, state, detail, since, last_seen, disconnected_at)
       VALUES (?, 'offline', NULL, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      id,
      now,
      now,
      now
    );

    // Rotating a token must kick the old socket, otherwise the previous
    // credential keeps working until it happens to disconnect.
    for (const socket of this.ctx.getWebSockets(id)) {
      this.#closeSocket(socket, "token_rotated", 4001);
    }
    // Closing a socket ourselves may not produce a webSocketClose, so start
    // the grace clock explicitly rather than relying on it.
    if (existing) await this.#markGone(id);

    // A rename or new picture is invisible to neighbours until the property
    // reconnects unless we say so now.
    this.#broadcast(this.#propertyView(id));

    const joinCode = encodeJoinCode({
      v: PROTOCOL_VERSION,
      u: `${body.relay_url}/hood/${body.hood}/ws`,
      h: body.hood,
      p: id,
      n: name,
      t: token,
      exp: expires,
    });

    return json({ property_id: id, name, join_code: joinCode, expires });
  }

  async #revoke(body) {
    const id = body.id;
    const row = this.sql.exec("SELECT id FROM properties WHERE id = ?", id).toArray()[0];
    if (!row) return json({ error: `no such property ${id}` }, 404);

    this.sql.exec("UPDATE properties SET revoked = 1 WHERE id = ?", id);
    this.sql.exec(
      "UPDATE status SET state = 'offline', disconnected_at = ? WHERE id = ?",
      nowSeconds(),
      id
    );

    for (const socket of this.ctx.getWebSockets(id)) {
      this.#closeSocket(socket, "revoked", 4003);
    }

    // Tell everyone else the property is gone rather than merely quiet.
    this.#broadcast({ id, removed: true });
    return json({ revoked: id });
  }

  #setGrace(body) {
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 15 || seconds > 900) {
      return json({ error: "seconds must be between 15 and 900" }, 400);
    }
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('grace', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(seconds)
    );
    return json({ grace: seconds });
  }
}
