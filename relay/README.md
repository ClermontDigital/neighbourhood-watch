# Neighbourhood Watch relay

A Cloudflare Worker plus one Durable Object per neighbourhood.

```bash
npm install
npx wrangler dev                                   # local
npx wrangler deploy                                # live
openssl rand -base64 32 | npx wrangler secret put NW_ADMIN_TOKEN
```

To exercise it end to end, put `NW_ADMIN_TOKEN = "test-admin-token"` in `.dev.vars`, run
`npx wrangler dev --port 8799 --local`, then in another shell:

```bash
npm run smoke
```

That covers the parts that are hard to reason about by reading: the grace window before a
property reads as offline, identity stamping, join code binding, the panic cap and revocation.
It takes about 40 seconds, most of it waiting out a deliberately shortened grace window.

Set `NW_RELAY_URL` in `wrangler.toml` to the public `wss://` hostname before issuing any join
codes: the codes are built from it, and a code pointing at the wrong host is useless.

## Why a Durable Object

- One object per neighbourhood gives a single, strongly consistent place to hold the roster and
  who is connected, with no database to run.
- WebSocket hibernation means idle connections accrue no billable duration, so a quiet
  neighbourhood costs nothing.
- SQLite-backed Durable Objects are available on the Workers free plan.
- `locationHint: "oc"` pins the object to Oceania. Without it the object lands wherever the
  first connection happens to arrive from.

## Why not MQTT

Cloudflare's managed MQTT product, Pub/Sub, was retired in August 2025, and Spectrum's arbitrary
TCP ports are an Enterprise add-on. More importantly Home Assistant allows exactly one MQTT
broker per instance, so a neighbourhood broker would collide with any local one, including
Zigbee2MQTT.

## Self hosting

Not built yet. The wire protocol in [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) is the complete
contract, and a conforming relay is a few hundred lines: authenticate a token to one property,
broadcast updates, hold the grace window, answer pings. The integration needs no change to talk
to it, only a join code pointing at the different host.
