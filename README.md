# Neighbourhood Watch - Shared Security Status for Home Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![HACS Badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/custom-components/hacs)
[![Version](https://img.shields.io/badge/version-0.1.3-green.svg)](https://github.com/ClermontDigital/neighbourhood-watch)

Link separate Home Assistant deployments into a neighbourhood watch. Each property runs its own
instance and sees all the others: armed, disarmed, person detected, panic, or offline. It shares
a status and nothing more. No cameras, no entities, no presence, no idea who is home.

## Features

- 🏠 **A tile per property** - family photo or icon, colour coded ring, name, state and relative time. Trouble floats to the top.
- 🚨 **Panic button** - press and hold for two seconds. Fires at any hour, armed or not, and shows as its own state rather than a flavour of alert.
- 👤 **Person detection while armed** - reads the camera sensors you already have, with a debounce so split second false positives never reach the street.
- 📡 **Offline detection** - a property that drops off is shown as offline, after a grace window so a satellite blip does not light up the neighbourhood.
- 🔌 **Works behind CGNAT** - every link is outbound only, so Starlink and 4G properties need no port forward, no static IP and no VPN.
- 🔑 **One paste to join** - a join code carries everything. No broker settings, no certificates, and nobody ever hands out a Home Assistant token.
- 📇 **Generated dashboard** - a registered strategy builds the same view at every property, so a house that joins appears on everyone's dashboard with nothing edited anywhere.
- 🔔 **Events, not opinions** - the integration raises the message and stops. Every household writes its own routine.
- 🔒 **Revocable per property** - cutting one off is instant and touches nobody else.
- 🚀 **HACS ready**

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

Each property publishes one of four states. The relay derives a fifth.

| State | Meaning | Tile |
|---|---|---|
| `panic` | Someone pressed the panic button. Any hour, armed or not. | Magenta, pulsing |
| `alert` | Person detection while armed, held past the debounce | Red |
| `armed` | Armed, nothing wrong | Blue |
| `disarmed` | Not armed | Slate, dimmed |
| `offline` | Connection gone past the grace window. Derived, never published. | Grey, hatched |

### Why not just link the instances

The obvious approaches do not survive contact with a real neighbourhood:

- **Sharing Home Assistant tokens**, which generic instance-linking integrations need, hands your neighbour full administrative access to your house so they can see one status light.
- **Peer to peer** needs inbound connectivity. Rural properties are on Starlink or 4G, both CGNAT, so there is no inbound anything.
- **A shared MQTT broker** collides with the one broker Home Assistant lets you configure. If you already run Zigbee2MQTT, or ever want to, you are stuck.

## Quick Setup

There are two roles: whoever runs the relay for the neighbourhood, and each property.

### Requirements

- Home Assistant 2026.5.0 or newer, on every property
- A Cloudflare account with a domain on it, for the relay. The free plan is enough.
- Node and `npx`, on the machine that deploys the relay only

### Installation

**HACS** > three dots > Custom repositories > add
`https://github.com/ClermontDigital/neighbourhood-watch`, category **Integration**. Install,
then restart Home Assistant.

The cards and the dashboard strategy are registered automatically on first setup. There is no
resource to add by hand.

### Deploy the relay (once, by one person)

```bash
git clone https://github.com/ClermontDigital/neighbourhood-watch.git
cd neighbourhood-watch/relay
npm install
```

`wrangler.toml` is already set up for `nw.clermont.digital`. Change `NW_RELAY_URL`, the route
and `NW_HOODS` together if you deploy elsewhere: join codes are built from `NW_RELAY_URL`, so if
it disagrees with the route every code points at nothing.

```bash
wrangler login                        # as the account holding the zone
export CLOUDFLARE_ACCOUNT_ID=...      # only if that login sees several accounts
npx wrangler deploy

# an admin token, known only to you, that gates invites and revocations
openssl rand -base64 32 | npx wrangler secret put NW_ADMIN_TOKEN
```

Deploying registers `nw.clermont.digital` as a **custom domain**, which provisions the DNS
record and the certificate as well, so there is nothing to add by hand in the dashboard. A
plain Workers route would not have been enough: a route only matches traffic for a hostname
that already resolves, so on a brand new subdomain it attaches to nothing.

Then set the offline grace window. Ninety seconds is sensible: Starlink drops for five to
fifteen seconds regularly, and a neighbourhood full of false offline alerts is a neighbourhood
that stops looking at the dashboard.

```bash
export NW_RELAY=https://nw.clermont.digital
export NW_ADMIN_TOKEN=...
export NW_HOOD=clermont

./tools/nw-hood grace 90
```

### Invite each property

```bash
./tools/nw-hood invite mckays --name "McKays" --icon mdi:home-group
```

That prints a join code, and a QR if `qrencode` is installed:

```
  Property : mckays  (McKays)

  Join code, paste this into their Home Assistant:

  NW1.eyJ2IjoxLCJ1Ijoid3NzOi8vbncuY2xlcm1vbnQuZGlnaXRhbC9ob29kL2Ns...
```

**Treat a join code like a password until it has been used.** It is a live credential: anyone
holding an unused one can connect as that property, see the whole neighbourhood, and publish
false states including panic. Once the property connects for the first time the relay binds the
code to that install and it is useless to anyone else. If a code sits unused for a week, reissue
it with `--rotate` rather than assuming nobody saw it.

Other commands:

```bash
./tools/nw-hood list                        # every property and its current state
./tools/nw-hood revoke mckays               # cut a property off right now
./tools/nw-hood invite mckays --rotate      # new token, old one dies immediately
./tools/nw-hood invite dawsons --expires-in 86400   # code stops working in a day
```

### Configuration

**Pair.** Settings > Devices & services > Add integration > Neighbourhood Watch. One field.
Paste the join code.

**Point it at your existing security.** Open the integration's **Configure**:

| Option | What to pick |
|---|---|
| Armed entity | Whatever already says this property is armed. An `input_boolean`, an alarm panel, a schedule helper. |
| Alert triggers | Your person detection sensors, for example `binary_sensor.creek_cam_person`. |
| Alert hold | How long a trigger must stay on to count. Six seconds filters out the split second false positives cameras produce. |
| Alert linger | How long an alert keeps showing after the last detection. Five minutes means someone waking later still sees it. |
| Share which sensor fired | Whether neighbours see "Front gate" or just "alert". |
| Tile icon and picture | How this property appears on everyone's dashboard. |

Neighbourhood Watch **does not arm anything itself**. It reads what you already have and
publishes the roll-up, so your existing automations keep working untouched.

**Add the dashboard.** Settings > Dashboards > Add dashboard > **Community dashboards** >
Neighbourhood Watch.

That view is generated, not copied. The cards discover properties as they render, so a new
property appears everywhere with nothing edited.

## Usage

### Entities Created

For this property:

| Entity | Purpose |
|---|---|
| `sensor.*_status` | What this property is publishing right now |
| `binary_sensor.*_hood_link` | Whether the relay connection is up |
| `button.*_panic` | Raise a panic |
| `button.*_clear` | Clear a latched panic or lingering alert |
| `switch.*_publish_status` | Privacy kill switch. Off disconnects entirely. |

For each neighbouring property, grouped as its own device:

| Entity | Purpose |
|---|---|
| `sensor.*_status` | The five state roll-up. Drives the tile. |
| `binary_sensor.*_alarm` | On for alert or panic |
| `binary_sensor.*_panic` | On for panic only |
| `binary_sensor.*_online` | On while reachable |

### The card pack

Seven cards, one visual language, so a red tile means the same thing at every property.

| Card | What it is for |
|---|---|
| `custom:neighbourhood-watch-card` | The grid of property tiles. The main one. |
| `custom:neighbourhood-watch-banner` | Full width alert bar. Renders nothing when all is well. Put it at the top of every view. |
| `custom:neighbourhood-watch-panic` | Press and hold for two seconds. |
| `custom:neighbourhood-watch-self` | What this property is publishing, and whether the link is up. |
| `custom:neighbourhood-watch-tile` | A single property, for a dashboard you already have. |
| `custom:neighbourhood-watch-log` | Live feed of neighbourhood events. |
| `custom:neighbourhood-watch-badge` | Compact badge for a sections view header. |

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
a word. Panic is magenta rather than a deeper red on purpose: red against red is exactly the
comparison a red-green deficient viewer cannot make, and panic against person detection is the
one distinction that has to survive.

### Automations

The integration raises the message and stops there, because a house with a baby asleep and a
house with a shift worker want different things.

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

Three worked examples live in [`blueprints/`](blueprints/automation/neighbourhood_watch): a
plain push, an overnight critical wake-up, and one for a property that goes offline while it was
armed. They are examples to copy, not defaults that get installed.

That last one is worth setting up. Power or internet cut at an armed house is a signal in its
own right, and it is the one thing a camera cannot tell you.

There are also two services, `neighbourhood_watch.panic` and `neighbourhood_watch.clear`, for
triggering a panic from a physical button or a voice assistant.

## Privacy and security

**What leaves your property:** a display name, an icon, an optional picture URL, one of four
state words, an optional short label saying which sensor fired, and a timestamp.

**What never leaves:** camera images and streams, entity ids, individual entity states,
`person` and `device_tracker` entities, GPS, occupancy, or anything about who is home. If a
trigger sensor has no friendly name, the label published is the generic word "alert" rather than
its entity id.

Do not put an internal Home Assistant URL in the tile picture field. Only `https://` URLs are
accepted, on both ends, which rules out a `/api/camera_proxy/...` link, but it is worth
understanding why that restriction is there.

**On the security side:**

- Nobody ever hands out a Home Assistant token. A property's credential works only against the relay and only as that property.
- The relay stamps identity from the authenticated token and ignores whatever a client claims, so no property can publish as another.
- Join codes bind to the first install that uses them, carry an optional expiry, and `--rotate` kills the previous token on the spot.
- Tokens are stored only as hashes. A relay operator reading the database still cannot connect as a property.
- Everything is TLS, and the integration refuses a join code pointing at a plaintext `ws://` relay.
- **The relay cannot call services or read your entities.** Nothing it sends can operate a device at your property by itself.

Two things to understand before deploying:

- **The relay operator is fully trusted.** Whoever holds the admin token can add or remove properties, fabricate any property's state including panic, and watch the neighbourhood's armed and disarmed rhythm over time. The protocol cannot prevent this. Pick the operator accordingly.
- **A hostile or malfunctioning property is only partly contained.** The relay caps panic entries at six an hour, meters every frame and limits concurrent connections, so one property cannot flood the others. But there is **no per-property mute** yet: if a neighbour becomes a nuisance, the only remedy is the hood owner revoking them.

## Troubleshooting

**Tiles are empty.** Check `binary_sensor.*_hood_link`. Off means the relay is unreachable or
the token was revoked. `./tools/nw-hood list` shows what the relay thinks.

**A property shows offline but is clearly fine.** The grace window may be too short for a flaky
link. Try `./tools/nw-hood grace 120`.

**Alerts fire for nothing.** Raise the alert hold. Cameras produce split second false positives
constantly, and six seconds is a floor, not a ceiling.

**"Credential rejected" repair notice.** The owner revoked or rotated this property. Ask for a
new join code; Home Assistant will prompt you to re-enter it.

**"Invalid or revoked token" but the code is new.** A join code binds to the first install that
uses it. If it has already been used elsewhere it is refused. Ask for a fresh code with
`--rotate`.

**Cards do not render after an update.** Hard refresh the browser. The resource URL carries the
version, but a service worker can hold the old copy.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest tests/ -q

cd relay && npm install && npx wrangler dev
```

The wire protocol is documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md), so the relay can be
reimplemented on your own server if you would rather not depend on Cloudflare.

## Contributing

Issues and pull requests welcome at
[ClermontDigital/neighbourhood-watch](https://github.com/ClermontDigital/neighbourhood-watch).

## License

MIT. See [LICENSE](LICENSE).
