import { DurableObject } from "cloudflare:workers";
import {
  PROTOCOL_VERSION,
  PUBLISHABLE_STATES,
  DEFAULT_GRACE_SECONDS,
  PING_INTERVAL_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_STATUS_PER_MINUTE,
  MAX_NAME_LENGTH,
  MAX_DETAIL_LENGTH,
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
} from "./util.js";

const SWEEP_INTERVAL_SECONDS = 30;

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
    this.statusBudget = new Map();

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
        disconnected_at INTEGER
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

  // ------------------------------------------------------------------
  // Routing
  // ------------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.pathname ? request.url : request.url);
    const path = url.pathname;

    if (path.endsWith("/ws")) return this.#handleUpgrade(request);
    if (path.includes("/admin/")) return this.#handleAdmin(request, path);
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

    const property = await this.#authenticate(token);
    if (!property) return new Response("invalid or revoked token", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag by property id so a revoke can find and close exactly its sockets.
    this.ctx.acceptWebSocket(server, [property.id]);
    server.serializeAttachment({ propertyId: property.id });

    const now = nowSeconds();
    this.sql.exec(
      `INSERT INTO status (id, state, detail, since, last_seen, disconnected_at)
       VALUES (?, 'disarmed', NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, disconnected_at = NULL`,
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

  async #authenticate(token) {
    const hash = await sha256Hex(token);
    const rows = this.sql
      .exec("SELECT id, name, icon, picture, token_hash, revoked, expires FROM properties")
      .toArray();
    const now = nowSeconds();
    for (const row of rows) {
      if (!timingSafeEqual(row.token_hash, hash)) continue;
      if (row.revoked) return null;
      if (row.expires && row.expires < now) return null;
      return row;
    }
    return null;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      return this.#fail(ws, "too_large", "message rejected");
    }

    const { propertyId } = ws.deserializeAttachment() || {};
    if (!propertyId) return ws.close(1011, "unidentified socket");

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.#fail(ws, "bad_json", "could not parse message");
    }

    switch (msg.t) {
      case "ping":
        // Only reached if auto-response missed, for example a client that
        // formats its ping differently. Answer anyway.
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
    const picture = clampText(msg.picture, 256);

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
    this.#broadcast(this.#propertyView(propertyId));
  }

  #handleStatus(ws, propertyId, msg) {
    if (!PUBLISHABLE_STATES.includes(msg.state)) {
      return this.#fail(ws, "bad_state", `state must be one of ${PUBLISHABLE_STATES.join(", ")}`);
    }
    if (!this.#withinBudget(propertyId)) {
      return this.#fail(ws, "rate_limited", "too many status updates");
    }

    const now = nowSeconds();
    const detail = clampText(msg.detail, MAX_DETAIL_LENGTH);
    const current = this.sql
      .exec("SELECT state, since FROM status WHERE id = ?", propertyId)
      .toArray()[0];

    // Keep "since" anchored to when the state actually began, not to the last
    // heartbeat, so the dashboard can say ARMED 3h rather than ARMED 30s.
    const changed = !current || current.state !== msg.state;
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
    // goes.
    const live = this.ctx.getWebSockets(propertyId).filter((s) => s !== ws);
    if (live.length > 0) return;

    const now = nowSeconds();
    this.sql.exec(
      "UPDATE status SET disconnected_at = ?, last_seen = ? WHERE id = ?",
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

  async #scheduleSweep() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_SECONDS * 1000);
  }

  async alarm() {
    const grace = this.#grace();
    const now = nowSeconds();
    const rows = this.sql.exec("SELECT id, state, disconnected_at FROM status").toArray();

    let pending = false;
    for (const row of rows) {
      const live = this.ctx.getWebSockets(row.id).length > 0;
      if (live) {
        pending = true;
        continue;
      }
      if (row.disconnected_at === null) continue;
      if (now - row.disconnected_at < grace) {
        pending = true;
        continue;
      }
      // Grace expired. The property is genuinely gone.
      if (row.state !== "offline") {
        this.sql.exec(
          "UPDATE status SET state = 'offline', detail = NULL, since = ? WHERE id = ?",
          row.disconnected_at,
          row.id
        );
        this.#broadcast(this.#propertyView(row.id));
      }
    }

    // Keep sweeping only while something could still change. A hood with every
    // property already offline schedules nothing and costs nothing.
    if (pending) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_SECONDS * 1000);
    }
  }

  // ------------------------------------------------------------------
  // Views and broadcast
  // ------------------------------------------------------------------

  #propertyView(propertyId) {
    const row = this.sql
      .exec(
        `SELECT p.id, p.name, p.icon, p.picture, p.revoked,
                s.state, s.detail, s.since, s.last_seen, s.disconnected_at
         FROM properties p LEFT JOIN status s ON s.id = p.id
         WHERE p.id = ?`,
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
        `SELECT p.id, p.name, p.icon, p.picture, p.revoked,
                s.state, s.detail, s.since, s.last_seen, s.disconnected_at
         FROM properties p LEFT JOIN status s ON s.id = p.id
         WHERE p.revoked = 0`
      )
      .toArray()
      .map((row) => this.#shape(row, grace, now));
  }

  #shape(row, grace, now) {
    const live = this.ctx.getWebSockets(row.id).length > 0;
    // Inside the grace window a property still counts as online and keeps
    // showing its last known state.
    const withinGrace =
      row.disconnected_at !== null &&
      row.disconnected_at !== undefined &&
      now - row.disconnected_at < grace;
    const online = live || withinGrace;

    return {
      id: row.id,
      name: row.name,
      icon: row.icon || null,
      picture: row.picture || null,
      state: online ? row.state || "disarmed" : "offline",
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
      try {
        socket.send(frame);
      } catch {
        // Socket is on its way out; the close handler will tidy up.
      }
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
    const entry = this.statusBudget.get(propertyId);
    if (!entry || entry.minute !== minute) {
      this.statusBudget.set(propertyId, { minute, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_STATUS_PER_MINUTE;
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
        `SELECT p.id, p.name, p.icon, p.picture, p.revoked, p.created, p.expires,
                s.state, s.detail, s.since, s.last_seen, s.disconnected_at
         FROM properties p LEFT JOIN status s ON s.id = p.id`
      )
      .toArray()
      .map((row) => ({
        ...this.#shape(row, grace, now),
        revoked: Boolean(row.revoked),
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
    const picture = clampText(body.picture, 256);
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const now = nowSeconds();
    const expires = body.expires_in ? now + Number(body.expires_in) : null;

    this.sql.exec(
      `INSERT INTO properties (id, name, icon, picture, token_hash, revoked, created, expires, bound_client)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, icon = excluded.icon, picture = excluded.picture,
         token_hash = excluded.token_hash, revoked = 0, expires = excluded.expires`,
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
      try {
        socket.send(JSON.stringify({ t: "bye", reason: "token_rotated" }));
        socket.close(4001, "token rotated");
      } catch {
        // ignore
      }
    }

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

  #revoke(body) {
    const id = body.id;
    const row = this.sql.exec("SELECT id FROM properties WHERE id = ?", id).toArray()[0];
    if (!row) return json({ error: `no such property ${id}` }, 404);

    this.sql.exec("UPDATE properties SET revoked = 1 WHERE id = ?", id);
    this.sql.exec("UPDATE status SET state = 'offline', disconnected_at = ? WHERE id = ?", nowSeconds(), id);

    for (const socket of this.ctx.getWebSockets(id)) {
      try {
        socket.send(JSON.stringify({ t: "bye", reason: "revoked" }));
        socket.close(4003, "revoked");
      } catch {
        // ignore
      }
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
