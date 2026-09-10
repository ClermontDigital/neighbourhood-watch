# Neighbourhood Watch

Link separate Home Assistant deployments together for security, and nothing else.

Each property runs its own Home Assistant. Neighbourhood Watch gives every one of them a
dashboard showing all the others: armed, disarmed, person detected, panic, or offline. When
something happens at one property, every property knows.

It shares a status and nothing more. No cameras, no entities, no presence, no idea who is home.

---

## Why not just link the instances

The obvious approaches do not survive contact with a real neighbourhood:

- **Sharing Home Assistant tokens** (which is what generic instance-linking integrations need)
  hands your neighbour full administrative access to your house so they can see one status
  light.
- **Peer to peer** needs inbound connectivity. Rural properties are on Starlink or 4G, both
  CGNAT, so there is no inbound anything.
- **A shared MQTT broker** collides with the one MQTT broker Home Assistant allows you to
  configure. If you already run Zigbee2MQTT, or ever want to, you are stuck.

So every property holds one **outbound** WebSocket to a small relay. Nobody hands out a token,
nothing needs a port forward, and the relay can only ever see the statuses it is sent.

---

## How it works

```
  The Cooch Inn            McKays               Devines
  Home Assistant       Home Assistant       Home Assistant
        |                    |                    |
        |  outbound wss      |                    |
        +--------------+     +     +--------------+
                       |     |     |
                    +--v-----v-----v--+
                    |   hood relay    |   Cloudflare Worker
                    |  Durable Object |   (or your own server)
                    +-----------------+
```

The relay holds the roster and, for each property, its display name, icon, optional picture,
current state, the optional short label saying which sensor fired, and connection timestamps.
It never initiates anything and it cannot reach into any property.

Each property publishes one of four states. The relay derives a fifth.

| State | Meaning |
|---|---|
| `panic` | Someone pressed the panic button. Any hour, armed or not. |
| `alert` | Person detection while armed, held past the debounce |
| `armed` | Armed, nothing wrong |
| `disarmed` | Not armed |
| `offline` | Connection gone past the grace window. Derived, never published. |

---

## Setup

There are two roles: whoever runs the relay for the neighbourhood, and each property.

### Part 1: the neighbourhood relay (once, by one person)

The relay runs on Cloudflare Workers. SQLite-backed Durable Objects run on the free plan, and
WebSocket hibernation means idle connections cost nothing, so a neighbourhood of a dozen
properties sits comfortably inside the free tier.

```bash
git clone https://github.com/ClermontDigital/neighbourhood-watch.git
cd neighbourhood-watch/relay
npm install
```

Point it at your own hostname and deploy:

```bash
# edit wrangler.toml: set NW_RELAY_URL to your wss:// hostname, and put your
# neighbourhood's id in NW_HOODS. Anything not in that allowlist is refused
# before a Durable Object is created, so nobody can run up your bill by
# guessing paths.
npx wrangler deploy

# an admin token, known only to you, that gates invites and revocations
openssl rand -base64 32 | npx wrangler secret put NW_ADMIN_TOKEN
```

Add the route in the Cloudflare dashboard so `nw.yourdomain.com` reaches the Worker. TLS is
Cloudflare's, so there are no certificates to generate, distribute or renew.

Then set the offline grace window. Ninety seconds is a sensible default: Starlink drops for
five to fifteen seconds regularly, and a neighbourhood full of false offline alerts is a
neighbourhood that stops looking at the dashboard.

```bash
export NW_RELAY=https://nw.yourdomain.com
export NW_ADMIN_TOKEN=...          # the one you just generated
export NW_HOOD=clermont-north      # any short name for this neighbourhood

./tools/nw-hood grace 90
```

### Part 2: invite each property

```bash
./tools/nw-hood invite mckays --name "McKays" --icon mdi:home-group
```

That prints a join code, and a QR if `qrencode` is installed:

```
  Property : mckays  (McKays)

  Join code, paste this into their Home Assistant:

  NW1.eyJ2IjoxLCJ1Ijoid3NzOi8vbncueW91cmRvbWFpbi5jb20vaG9vZC9jbGVy...
```

The code carries the relay URL, the property id, and a token that belongs to that property
alone.

**Treat a join code like a password until it has been used.** It is a live credential, and
anyone holding an unused one can connect as that property: they would see the whole
neighbourhood's roster and states, and could publish false states including panic. Once the
property connects for the first time, the relay binds the code to that install, and the code is
useless to anyone else. So send it over whatever channel you like, but if it sits unused for a
week, reissue it with `--rotate` rather than assuming nobody else saw it. Codes for someone who
will not set up straight away are worth an `--expires-in`.

Other commands:

```bash
./tools/nw-hood list                        # every property and its current state
./tools/nw-hood revoke mckays               # cut a property off right now
./tools/nw-hood invite mckays --rotate      # new token, old one dies immediately
./tools/nw-hood invite dawsons --expires-in 86400   # code stops working in a day
```

### Part 3: each property

**Install.** HACS > three dots > Custom repositories > add
`https://github.com/ClermontDigital/neighbourhood-watch`, category Integration. Install, then
restart Home Assistant.

**Pair.** Settings > Devices & services > Add integration > Neighbourhood Watch. There is one
field. Paste the join code. That is the entire pairing process: no broker, no host, no port, no
certificate.

**Point it at your existing security.** Open the integration's Configure and choose:

| Option | What to pick |
|---|---|
| Armed entity | Whatever already says this property is armed. An `input_boolean`, an alarm panel, a schedule helper. |
| Alert triggers | Your person detection sensors, for example `binary_sensor.creek_cam_person`. |
| Alert hold | How long a trigger must stay on to count. Six seconds filters out the split second false positives cameras produce. |
| Alert linger | How long an alert keeps showing after the last detection. Five minutes means someone waking later still sees it. |
| Share which sensor fired | Whether neighbours see "Front gate" or just "alert". |
| Tile icon and picture | How this property appears on everyone's dashboard. |

Neighbourhood Watch **does not arm anything itself**. It reads what you already have and
publishes the roll-up. Your existing automations keep working untouched.

**Add the dashboard.** Settings > Dashboards > Add dashboard > **Community dashboards** >
Neighbourhood Watch.

That is a generated dashboard, not a copied one. The cards discover properties as they render,
so when a new property joins the neighbourhood it appears on everyone's dashboard with nothing
edited anywhere.

---

## The widgets

Seven cards, all in one resource, all sharing one visual language so a red tile means the same
thing at every property. That is a safety property, not a cosmetic one.

| Card | What it is for |
|---|---|
| `custom:neighbourhood-watch-card` | The grid of property tiles. The main one. |
| `custom:neighbourhood-watch-banner` | Full width alert bar. Renders nothing at all when everything is fine, takes over when it is not. Put it at the top of every view. |
| `custom:neighbourhood-watch-panic` | Press and hold for two seconds to raise a panic. |
| `custom:neighbourhood-watch-self` | What this property is publishing, and whether the link is up. |
| `custom:neighbourhood-watch-tile` | A single property, to drop into a dashboard you already have. |
| `custom:neighbourhood-watch-log` | Live feed of neighbourhood events. |
| `custom:neighbourhood-watch-badge` | Compact badge for a sections view header. |

Hand-built example:

```yaml
type: custom:neighbourhood-watch-card
title: Neighbourhood
min_tile: 130        # px, tiles reflow to fit
include_self: true
```

Or the whole view inside a dashboard you already have:

```yaml
strategy:
  type: custom:neighbourhood-watch
```

### The state language

Colour is never the only signal. This is a display people read half asleep, and roughly eight
percent of men have some colour vision deficiency, so every state carries a colour, an icon and
a word.

| State | Colour | Icon | Label |
|---|---|---|---|
| Panic | Magenta, pulsing | `mdi:alarm-light` | PANIC |
| Alert | Red | `mdi:account-alert` | PERSON |
| Armed | Blue | `mdi:shield-check` | ARMED |
| Disarmed | Slate, dimmed | `mdi:shield-off-outline` | DISARMED |
| Offline | Grey, hatched | `mdi:lan-disconnect` | OFFLINE |

Panic is magenta rather than a deeper red deliberately. Red against red is exactly the
comparison a red-green deficient viewer cannot make, and panic against person detection is the
one distinction that has to survive.

The panic card needs a two second press and hold. A panic button a stray thumb can fire
destroys trust in the whole network.

---

## Entities

**For this property**

| Entity | Purpose |
|---|---|
| `sensor.*_status` | What this property is publishing right now |
| `binary_sensor.*_hood_link` | Whether the relay connection is up |
| `button.*_panic` | Raise a panic |
| `button.*_clear` | Clear a latched panic or lingering alert |
| `switch.*_publish_status` | Privacy kill switch. Off disconnects entirely. |

**For each neighbouring property**, grouped as its own device:

| Entity | Purpose |
|---|---|
| `sensor.*_status` | The five state roll-up. Drives the tile. |
| `binary_sensor.*_alarm` | On for alert or panic |
| `binary_sensor.*_panic` | On for panic only |
| `binary_sensor.*_online` | On while reachable |

---

## Automations

Neighbourhood Watch raises the message and stops there. It ships no opinion about what should
happen next, because a property with a baby asleep and a property with a shift worker want
different things.

Every remote state change fires an event:

```yaml
event_type: neighbourhood_watch_status_changed
data:
  property_id: mckays
  name: McKays
  state: alert            # panic | alert | armed | disarmed | offline
  previous_state: armed
  detail: "Front gate"
  since: 1757500443
  online: true
```

So a wake-up routine is your own automation:

```yaml
triggers:
  - trigger: event
    event_type: neighbourhood_watch_status_changed
conditions:
  - condition: template
    value_template: "{{ trigger.event.data.state in ['alert', 'panic'] }}"
actions:
  - action: notify.mobile_app_yourphone
    data:
      title: "{{ trigger.event.data.name }}"
      message: "{{ trigger.event.data.state }}"
      data:
        push:
          sound: {name: default, critical: 1, volume: 1.0}
```

There are three worked examples in [`blueprints/`](blueprints/automation/neighbourhood_watch):
a plain push, an overnight critical wake-up, and one for a property that goes offline while it
was armed. They are examples to copy, not defaults that get installed.

That last one is worth setting up. Power or internet cut at an armed house is a signal in its
own right, and it is the one thing a camera cannot tell you.

There are also two services, `neighbourhood_watch.panic` and `neighbourhood_watch.clear`, if you
would rather trigger a panic from a physical button or a voice assistant than from the card.

---

## Privacy and security

**What leaves your property:** a display name, an icon, an optional picture URL, one of four
state words, an optional short label saying which sensor fired, and a timestamp. That is all.

**What never leaves:** camera images and streams, entity ids, individual entity states,
`person` and `device_tracker` entities, GPS, occupancy, or anything about who is home. If a
trigger sensor has no friendly name, the label published is the generic word "alert" rather
than its entity id.

One thing to avoid: do not put an internal Home Assistant URL in the tile picture field. It is
published to the neighbourhood and fetched by every neighbour's browser. Only `https://` URLs
are accepted, on both the publishing and the receiving side, which rules out a
`/api/camera_proxy/...` link, but it is worth understanding why that restriction is there.

If you would rather neighbours not know which camera fired, turn off "share which sensor fired"
and they see only that an alert happened. If you want out entirely for a while, turn off the
publish switch and the neighbourhood sees you go offline.

**On the security side:**

- Nobody ever hands out a Home Assistant token. A property's credential works only against the
  relay and only as that property.
- The relay stamps identity from the authenticated token and ignores whatever a client claims,
  so no property can publish as another.
- Tokens are per property and revocable in isolation. Revoking one closes its connection
  immediately and touches nobody else.
- Join codes can carry an expiry, and `--rotate` kills the previous token on the spot.
- Everything is TLS, and the integration refuses a join code that points at a plaintext
  `ws://` relay.
- **The relay cannot call services or read your entities.** Nothing it sends can operate a
  device at your property by itself.

Be clear about what that last point does not say. The neighbourhood does reach your Home
Assistant as *data*: it creates a device and entities for each property, its status fires events
on your bus, and a picture URL is fetched by your browser when you open the dashboard. If you
write an automation that acts on those events, which is the entire point, then a neighbour's
state does change things at your place. That is intended. It just is not the same as "no path
in".

**Two things worth knowing before you deploy:**

- **The relay operator is fully trusted.** Whoever holds the admin token can add or remove
  properties, fabricate any property's state including panic, rename anyone, and watch the whole
  neighbourhood's armed and disarmed rhythm over time. The protocol cannot prevent this. Pick
  the operator accordingly.
- **A hostile or malfunctioning property is only partly contained.** The relay caps how often a
  property may enter panic (six times an hour), meters every frame, and limits concurrent
  connections, so one property cannot flood the others or wake the valley on a loop. But there
  is currently **no per-property mute**: if a neighbour becomes a nuisance, the only remedy is
  the hood owner revoking them. That is a known gap.

---

## Troubleshooting

**Tiles are empty.** Check `binary_sensor.*_hood_link`. If it is off, the relay is unreachable
or the token was revoked. `./tools/nw-hood list` from the owner's machine shows what the relay
thinks.

**A property shows offline but is clearly fine.** The grace window may be too short for a flaky
link. Try `./tools/nw-hood grace 120`.

**Alerts fire for nothing.** Raise the alert hold. Cameras produce split second false positives
constantly and six seconds is a floor, not a ceiling.

**"Credential rejected" repair notice.** The owner revoked or rotated this property. Ask for a
new join code; Home Assistant will prompt you to re-enter it.

**"Invalid or revoked token" but the code is new.** A join code binds to the first install that
uses it. If you paste one that has already been used on another machine, it is refused. Ask for
a fresh code with `--rotate`.

**Cards do not render after an update.** Hard refresh the browser. The resource URL carries the
version, so a normal reload usually picks it up, but a service worker can hold the old copy.

---

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest tests/ -q

cd relay && npm install && npx wrangler dev
```

The wire protocol is documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md), so the relay can be
reimplemented on your own server if you would rather not depend on Cloudflare.

## Licence

MIT.
