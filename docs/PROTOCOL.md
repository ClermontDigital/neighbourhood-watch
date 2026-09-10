# Neighbourhood Watch wire protocol, v1

One WebSocket per property, always outbound, always TLS. JSON text frames only.

The protocol is small on purpose. A neighbourhood security link should be auditable in one
sitting, and anything the relay does not need is something it cannot leak.

## Connecting

```
GET wss://<relay>/hood/<hood_id>/ws
Authorization: Bearer <property_token>
```

`hood_id` and property ids match `^[a-z0-9][a-z0-9_-]{0,47}$`.

The relay authenticates the token, resolves it to exactly one property, and from that point
**ignores any identity a client claims**. A property can only ever speak as itself.

Rejections: `401` no token, `403` unknown, revoked or expired token, `426` not an upgrade
request.

## Property to relay

| Frame | Meaning |
|---|---|
| `{"t":"hello","v":1,"name":"McKays","icon":"mdi:home","picture":"https://..."}` | Set this property's own display identity. Optional, sent on connect. |
| `{"t":"status","state":"armed","detail":"Front gate","since":1757500443}` | Publish state. `state` is one of `disarmed`, `armed`, `alert`, `panic`. |
| `{"t":"ping"}` | Keepalive. |

`offline` is **not** publishable. It is derived by the relay from connectivity, so a property
cannot claim to be offline while connected or hide behind a stale state.

Limits: 4096 bytes per frame, 60 status frames per minute, name 64 characters, detail 96.

## Relay to property

| Frame | Meaning |
|---|---|
| `{"t":"welcome","v":1,"property_id":"mckays","name":"McKays","grace":90,"ping_interval":30}` | Sent first. |
| `{"t":"snapshot","properties":[<property>, ...]}` | Every non-revoked property, sent immediately after welcome. |
| `{"t":"update","property":<property>}` | One property changed. |
| `{"t":"update","property":{"id":"x","removed":true}}` | A property was revoked. |
| `{"t":"pong"}` | Answer to ping. |
| `{"t":"error","code":"bad_state","message":"..."}` | One frame was rejected. The connection stays up. |
| `{"t":"bye","reason":"revoked"}` | Followed by a close. `revoked` and `token_rotated` mean stop retrying. |

A property object:

```json
{
  "id": "mckays",
  "name": "McKays",
  "icon": "mdi:home-group",
  "picture": null,
  "state": "armed",
  "detail": null,
  "since": 1757500443,
  "last_seen": 1757503001,
  "online": true
}
```

`since` is when the current state began, not when it was last refreshed, so a client can render
"ARMED 3h" without keeping its own history.

## Keepalive and the grace window

The client pings every 30 seconds. On Cloudflare the relay answers via WebSocket auto-response,
which does not wake the Durable Object, so an idle neighbourhood costs nothing. The ping frame
must therefore be **byte for byte** `{"t":"ping"}`, since auto-response matches exactly.

When a property's last socket closes, the relay does not announce it immediately. It starts a
grace window, default 90 seconds, configurable from 15 to 900. Only if the property is still
absent when the window expires does its state become `offline` and get broadcast.

This is the main behavioural advantage over MQTT's Last Will, which fires the instant a socket
drops. Rural links drop for five to fifteen seconds regularly, and a neighbourhood full of
false offline alerts is a neighbourhood that stops looking at the dashboard.

Clients should also treat 90 seconds of total silence as a dead socket and reconnect. A
satellite link can black-hole a connection without ever closing it.

## Reconnecting

Exponential backoff from 2 seconds to 5 minutes, **with jitter**. Every property in the
neighbourhood reconnects the moment a relay restarts, and a synchronised stampede looks exactly
like an attack.

On reconnect the client resends `hello` and its last published status, so the relay never holds
a stale view.

## Admin API

Separate from the socket, gated by the neighbourhood's admin token, used only by `nw-hood`.

```
POST /hood/<hood>/admin/invite      {id, name, icon, picture, expires_in, rotate}
POST /hood/<hood>/admin/revoke      {id}
POST /hood/<hood>/admin/grace       {seconds}
POST /hood/<hood>/admin/properties  {}
```

`invite` returns a join code: `NW1.` followed by base64url JSON.

```json
{
  "v": 1,
  "u": "wss://nw.example.com/hood/clermont/ws",
  "h": "clermont",
  "p": "mckays",
  "n": "McKays",
  "t": "<property token>",
  "exp": null
}
```

Tokens are stored only as SHA-256 hashes. A relay operator who reads the database still cannot
connect as a property.

Clients must refuse a join code whose `u` is not `wss://`. The token is inside the code, so a
plaintext relay would put it on the wire in the clear.

## Reimplementing the relay

Everything above is the contract. A conforming relay needs to:

1. authenticate a bearer token to exactly one property, and reject revoked and expired ones
2. overwrite `id` and `name` on broadcast from its own records, never from the client
3. send `welcome` then `snapshot` on connect
4. broadcast `update` on any change
5. hold the grace window before declaring `offline`
6. answer `{"t":"ping"}` with `{"t":"pong"}`
7. close revoked sockets immediately with a `bye`

Nothing else is required. There is no persistence obligation beyond the roster and last known
status.
