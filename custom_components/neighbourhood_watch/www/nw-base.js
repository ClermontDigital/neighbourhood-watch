/**
 * Neighbourhood Watch shared card foundation.
 *
 * Everything visual lives here: the state language, the design tokens and the
 * base element. Individual cards never define their own colours or labels, so
 * a red tile means the same thing on every property's dashboard. That is a
 * safety property, not a cosmetic one.
 */

export const NW_VERSION = "0.1.4";

/**
 * The state language. Colour is never the only signal: roughly eight percent
 * of men have some colour vision deficiency, and this is a security display
 * people will read half asleep. Every state carries a distinct colour, icon
 * and word.
 *
 * Panic is magenta rather than a deeper red on purpose. Red against red is
 * exactly the comparison a red-green deficient viewer cannot make, and panic
 * against person detection is the one distinction that has to survive.
 */
const STATES = {
  panic: { label: "PANIC", icon: "mdi:alarm-light", token: "panic", rank: 0, urgent: true },
  alert: { label: "PERSON", icon: "mdi:account-alert", token: "alert", rank: 1, urgent: true },
  offline: { label: "OFFLINE", icon: "mdi:lan-disconnect", token: "offline", rank: 2, urgent: false },
  armed: { label: "ARMED", icon: "mdi:shield-check", token: "armed", rank: 3, urgent: false },
  disarmed: { label: "DISARMED", icon: "mdi:shield-off-outline", token: "disarmed", rank: 4, urgent: false },
};

const UNKNOWN = { label: "UNKNOWN", icon: "mdi:help-circle-outline", token: "offline", rank: 5, urgent: false };

export function stateMeta(state) {
  return STATES[state] || UNKNOWN;
}

/** Shared tokens. Cards are self contained, so no theme or card-mod is needed. */
export const NW_TOKENS = `
  :host {
    --nw-panic: #d946ef;
    --nw-alert: #ef4444;
    --nw-armed: #3b82f6;
    --nw-disarmed: #64748b;
    --nw-offline: #475569;

    --nw-surface: var(--ha-card-background, var(--card-background-color, #fff));
    --nw-text: var(--primary-text-color, #111);
    --nw-muted: var(--secondary-text-color, #666);
    --nw-radius: var(--ha-card-border-radius, 12px);
    --nw-gap: 12px;

    display: block;
  }
  /* Home Assistant's dark mode is a per-user theme setting, not an OS media
     query, so a wall tablet on OS light with the HA dark theme would otherwise
     get light state colours on a dark card. The attribute is set from
     hass.themes.darkMode; the media query stays as a fallback. */
  @media (prefers-color-scheme: dark) {
    :host(:not([nw-light])) {
      /* Slightly lifted so the states stay legible on a dark ground. */
      --nw-armed: #60a5fa;
      --nw-disarmed: #94a3b8;
      --nw-offline: #64748b;
    }
  }
  :host([nw-dark]) {
    --nw-armed: #60a5fa;
    --nw-disarmed: #94a3b8;
    --nw-offline: #64748b;
  }
  .nw-card {
    background: var(--nw-surface);
    border-radius: var(--nw-radius);
    box-shadow: var(--ha-card-box-shadow, none);
    border: var(--ha-card-border-width, 1px) solid
      var(--ha-card-border-color, var(--divider-color, rgba(127,127,127,.2)));
    color: var(--nw-text);
    overflow: hidden;
  }
  @keyframes nw-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: .45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .nw-pulse { animation: none !important; }
  }
`;

export function stateColour(state) {
  return `var(--nw-${stateMeta(state).token})`;
}

/** Trouble floats: panic, alert, offline, armed, disarmed, then by name. */
export function sortProperties(list) {
  return [...list].sort((a, b) => {
    const rank = stateMeta(a.state).rank - stateMeta(b.state).rank;
    if (rank !== 0) return rank;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

/** Compact relative time: 45s, 22m, 3h, 5d. */
export function relTime(epochSeconds) {
  if (!epochSeconds) return "";
  const value = Number(epochSeconds);
  // A remote property could send anything here. NaN silently rendered "NaNd".
  if (!Number.isFinite(value)) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - value));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Only https URLs are ever used as a picture.
 *
 * This value comes from another household's Home Assistant and is headed for a
 * CSS url() in this browser. escapeHtml is not enough on its own: the HTML
 * parser decodes entities in an attribute before the CSS parser sees the
 * string, so a &#39; becomes a real quote and closes the url().
 */
export function safePicture(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.length > 256 || /["'()\\<>\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function fromEntity(entityId, state) {
  const a = state.attributes || {};
  return {
    entity_id: entityId,
    id: a.property_id || entityId,
    name: a.property_name || a.friendly_name || entityId,
    state: state.state,
    detail: a.detail || null,
    icon: a.icon_hint || null,
    picture: safePicture(a.picture),
    since: a.since || null,
    last_seen: a.last_seen || null,
    online: a.online !== false,
  };
}

/** Every neighbouring property Home Assistant currently knows about. */
export function collectProperties(hass) {
  if (!hass) return [];
  const out = [];
  for (const [entityId, state] of Object.entries(hass.states)) {
    if (!entityId.startsWith("sensor.")) continue;
    if (!state.attributes || state.attributes.nw !== "property") continue;
    out.push(fromEntity(entityId, state));
  }
  return out;
}

/** This property's own status entity, if the integration is set up. */
export function collectSelf(hass) {
  if (!hass) return null;
  for (const [entityId, state] of Object.entries(hass.states)) {
    if (!entityId.startsWith("sensor.")) continue;
    if (!state.attributes || state.attributes.nw !== "self") continue;
    const a = state.attributes;
    return {
      entity_id: entityId,
      id: a.property_id,
      name: a.property_name,
      state: state.state,
      detail: a.detail || null,
      since: a.since || null,
      publishing: a.publishing !== false,
      linked: Boolean(a.linked),
    };
  }
  return null;
}

/**
 * Find a companion entity that belongs to the same device as this property's
 * own status sensor, for example the panic button.
 *
 * Matching on a substring of the entity id picked up anything that merely
 * contained "_panic", so a user with button.kitchen_panic_light could have
 * their panic press silently routed to a light.
 */
export function findCompanion(hass, domain, suffix) {
  if (!hass) return null;
  const self = collectSelf(hass);
  if (!self) return null;

  const registry = hass.entities || {};
  const deviceId = registry[self.entity_id] && registry[self.entity_id].device_id;

  if (deviceId) {
    for (const [entityId, entry] of Object.entries(registry)) {
      if (!entityId.startsWith(`${domain}.`)) continue;
      if (entry.device_id !== deviceId) continue;
      if (entityId.endsWith(suffix)) return entityId;
    }
  }

  // Registry not available to this user (a non-admin has a reduced hass
  // object). Fall back to a suffix match, which is still tighter than a
  // substring one.
  for (const entityId of Object.keys(hass.states)) {
    if (entityId.startsWith(`${domain}.`) && entityId.endsWith(suffix)) return entityId;
  }
  return null;
}

export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/**
 * Base card. Handles the hass setter, throttled re-render and the shared
 * stylesheet so no card has to get any of it right on its own.
 */
export class NWBaseCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._frame = null;
    this._built = false;
    this._signature = undefined;
    // Relative times go stale on a dashboard nobody touches, so tick them.
    this._ticker = null;
  }

  setConfig(config) {
    this._config = config || {};
    this._built = false;
    this._signature = undefined;
    this.requestRender();
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;

    if (hass && hass.themes && previous !== hass) {
      // Reflect the Home Assistant theme rather than the OS setting.
      const dark = Boolean(hass.themes.darkMode);
      this.toggleAttribute("nw-dark", dark);
      this.toggleAttribute("nw-light", !dark);
    }

    // Home Assistant hands over a new hass object on every state change of
    // every entity in the instance. Rebuilding the shadow DOM each time
    // destroyed keyboard focus on the tiles, restarted the banner's pulse
    // animation, and made text unselectable. Only render when something this
    // card actually shows has changed.
    const signature = this.signature();
    if (signature !== null && signature === this._signature) return;
    this._signature = signature;
    this.requestRender();
  }

  /**
   * A cheap string describing everything this card displays. Return null to
   * opt out and render on every update.
   */
  signature() {
    if (!this._hass) return null;
    const parts = [];
    for (const p of collectProperties(this._hass)) {
      parts.push(`${p.id}|${p.state}|${p.since}|${p.detail}|${p.picture}|${p.name}|${p.online}`);
    }
    const self = collectSelf(this._hass);
    if (self) parts.push(`self|${self.state}|${self.since}|${self.detail}|${self.linked}|${self.publishing}`);
    parts.sort();
    return parts.join("~");
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (!this._ticker) {
      // Relative times ("ARMED 3h") move even when no state changes, so this
      // tick deliberately bypasses the signature guard.
      this._ticker = setInterval(() => this.requestRender(), 30000);
    }
    this.requestRender();
  }

  disconnectedCallback() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
    if (this._frame) {
      cancelAnimationFrame(this._frame);
      this._frame = null;
    }
  }

  requestRender() {
    if (this._frame || !this.isConnected) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      if (!this._hass) return;
      try {
        this.render();
      } catch (err) {
        // A card that throws in render takes the whole dashboard view with it.
        console.error("[neighbourhood-watch] render failed", err);
      }
    });
  }

  /** Subclasses override. */
  render() {}

  styles(extra = "") {
    return `<style>${NW_TOKENS}${extra}</style>`;
  }

  /** Open the more-info dialog for an entity. */
  moreInfo(entityId) {
    const event = new CustomEvent("hass-more-info", {
      detail: { entityId },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  callService(domain, service, data) {
    if (!this._hass) return Promise.resolve();
    return this._hass.callService(domain, service, data);
  }
}

/** Define once. A second definition throws and kills every later card. */
export function define(tag, cls) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

/** Register in the card picker so people can find these without docs. */
export function registerCard(type, name, description) {
  window.customCards = window.customCards || [];
  if (window.customCards.some((c) => c.type === type)) return;
  window.customCards.push({
    type,
    name,
    description,
    preview: false,
    documentationURL: "https://github.com/ClermontDigital/neighbourhood-watch",
  });
}
