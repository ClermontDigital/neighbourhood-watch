/**
 * Neighbourhood Watch card pack.
 *
 * Seven cards, one visual language. Cards take entity references and layout
 * options only: there is deliberately no way to configure what a state looks
 * like, so no property's dashboard can drift from the others.
 */

import {
  NWBaseCard,
  NW_VERSION,
  collectProperties,
  collectSelf,
  define,
  escapeHtml,
  findCompanion,
  registerCard,
  relTime,
  sortProperties,
  stateColour,
  stateMeta,
} from "./nw-base.js";

const TILE_STYLES = `
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--nw-min, 120px), 1fr));
    gap: var(--nw-gap);
    padding: var(--nw-gap);
  }
  .tile {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 14px 8px; border-radius: var(--nw-radius);
    background: color-mix(in srgb, var(--tile-colour) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--tile-colour) 35%, transparent);
    cursor: pointer; text-align: center;
    /* Stops a press on a tile turning into a page scroll on a wall tablet. */
    touch-action: manipulation;
    transition: transform .12s ease;
  }
  .tile { position: relative; }
  .tile:hover { transform: translateY(-2px); }
  /* A chip rather than "(you)" appended to the name, which truncated on any
     tile narrower than the name. */
  .you {
    position: absolute; top: 7px; left: 7px;
    font-size: 9px; font-weight: 700; letter-spacing: .1em;
    padding: 2px 6px; border-radius: 999px;
    color: var(--tile-colour);
    background: color-mix(in srgb, var(--tile-colour) 16%, transparent);
  }
  .tile:focus-visible { outline: 2px solid var(--tile-colour); outline-offset: 2px; }
  .avatar {
    width: 56px; height: 56px; border-radius: 50%;
    display: grid; place-items: center;
    border: 3px solid var(--tile-colour);
    background: color-mix(in srgb, var(--tile-colour) 15%, var(--nw-surface));
    color: var(--tile-colour);
    background-size: cover; background-position: center;
    position: relative; flex: none;
  }
  .avatar ha-icon { --mdc-icon-size: 28px; }
  /* The hatch is an overlay rather than a background-image, so a property
     that supplies a picture does not lose its texture cue and end up
     distinguished by colour alone. */
  .offline .avatar::after {
    content: ""; position: absolute; inset: 0; border-radius: 50%;
    background-image: repeating-linear-gradient(
      45deg, transparent, transparent 4px,
      color-mix(in srgb, var(--tile-colour) 45%, transparent) 4px,
      color-mix(in srgb, var(--tile-colour) 45%, transparent) 8px);
  }
  .badge {
    position: absolute; bottom: -4px; right: -4px;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--tile-colour); color: #fff;
    display: grid; place-items: center;
    border: 2px solid var(--nw-surface);
  }
  .badge ha-icon { --mdc-icon-size: 13px; }
  .name {
    font-weight: 600; font-size: 13px; line-height: 1.2;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .status { font-size: 11px; letter-spacing: .06em; color: var(--tile-colour); font-weight: 700; }
  .meta { font-size: 11px; color: var(--nw-muted); }
  .empty { padding: 24px; text-align: center; color: var(--nw-muted); font-size: 13px; }
  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px var(--nw-gap) 0; font-weight: 600;
  }
  .head .count { font-weight: 400; font-size: 12px; color: var(--nw-muted); }
`;

function tileMarkup(prop) {
  const meta = stateMeta(prop.state);
  const colour = stateColour(prop.state);

  // The class comes from the vocabulary this module owns, never from the
  // payload. prop.state is another household's data, and interpolating it raw
  // let it close the attribute and add a real event handler.
  const token = meta.token;

  // The picture is never built into a CSS string here. It is applied to the
  // element afterwards, in wireTiles, because the HTML parser decodes entities
  // in an attribute before the CSS parser reads it, so escaping cannot keep a
  // quote out of a url().
  const avatar = prop.picture
    ? `<div class="avatar has-picture" data-picture="${escapeHtml(prop.picture)}"></div>`
    : `<div class="avatar"><ha-icon icon="${escapeHtml(prop.icon || "mdi:home")}"></ha-icon></div>`;

  // The badge repeats the state as an icon so the tile never relies on colour
  // alone to say what is wrong.
  const badge = `<span class="badge${meta.urgent ? " nw-pulse" : ""}"
      style="${meta.urgent ? "animation:nw-pulse 1.1s ease-in-out infinite;" : ""}">
      <ha-icon icon="${meta.icon}"></ha-icon></span>`;

  const detail = prop.detail ? ` &middot; ${escapeHtml(prop.detail)}` : "";
  return `
    <div class="tile ${token}${prop.is_self ? " self" : ""}" style="--tile-colour:${colour}"
         tabindex="0" role="button"
         aria-label="${escapeHtml(prop.name)}, ${meta.label}"
         data-entity="${escapeHtml(prop.entity_id)}">
      ${prop.is_self ? `<span class="you">YOU</span>` : ""}
      <div style="position:relative">${avatar}${badge}</div>
      <div class="name">${escapeHtml(prop.name)}</div>
      <div class="status">${meta.label}</div>
      <div class="meta">${relTime(prop.since)}${detail}</div>
    </div>`;
}

function wireTiles(root, card) {
  // Apply pictures through the CSSOM. safePicture has already restricted this
  // to plain https URLs, which is what makes embedding it here safe.
  root.querySelectorAll(".avatar.has-picture").forEach((el) => {
    const url = el.dataset.picture;
    if (!url) return;
    // safePicture has already rejected quotes, backslashes, parentheses,
    // angle brackets and whitespace, so this cannot escape the url() string.
    // CSS.escape would be wrong here: it escapes for identifiers and would
    // mangle the colons and slashes of a real URL.
    el.style.backgroundImage = `url("${url}")`;
    el.removeAttribute("data-picture");
  });

  root.querySelectorAll(".tile").forEach((el) => {
    const entity = el.dataset.entity;
    el.addEventListener("click", () => card.moreInfo(entity));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.moreInfo(entity);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* 1. The grid of every property                                       */
/* ------------------------------------------------------------------ */

class NWCard extends NWBaseCard {
  static getStubConfig() {
    return { title: "Neighbourhood" };
  }

  getGridOptions() {
    return { columns: "full", rows: "auto", min_columns: 6 };
  }

  render() {
    const collected = collectProperties(this.hass);
    const self = collectSelf(this.hass);
    if (this._config.include_self !== false && self) {
      // Included before sorting: pinning yourself to the front would push a
      // neighbour in PANIC to second place, which breaks the whole point.
      collected.push({
        ...self,
        is_self: true,
        icon: "mdi:home-heart",
        picture: null,
      });
    }
    const props = sortProperties(collected);

    const title = this._config.title === undefined ? "Neighbourhood" : this._config.title;
    const trouble = props.filter((p) => stateMeta(p.state).urgent).length;

    const body = props.length
      ? `<div class="grid">${props.map(tileMarkup).join("")}</div>`
      : `<div class="empty">No properties yet. Once a neighbour pastes their join code they appear here automatically.</div>`;

    this.shadowRoot.innerHTML = `
      ${this.styles(TILE_STYLES)}
      <div class="nw-card" style="--nw-min:${Number(this._config.min_tile) || 120}px">
        ${title ? `<div class="head"><span>${escapeHtml(title)}</span>
          <span class="count">${props.length} ${props.length === 1 ? "property" : "properties"}${
            trouble ? ` &middot; ${trouble} needing attention` : ""
          }</span></div>` : ""}
        ${body}
      </div>`;
    wireTiles(this.shadowRoot, this);
  }

  getCardSize() {
    return 3;
  }
}

/* ------------------------------------------------------------------ */
/* 2. A single property, to drop into an existing view                 */
/* ------------------------------------------------------------------ */

class NWTile extends NWBaseCard {
  getGridOptions() {
    return { columns: 3, rows: "auto", min_columns: 3 };
  }

  static getStubConfig(hass) {
    const first = collectProperties(hass)[0];
    return { property: first ? first.id : "" };
  }

  setConfig(config) {
    if (!config || typeof config.property !== "string") {
      throw new Error("neighbourhood-watch-tile needs a property id");
    }
    super.setConfig(config);
  }

  render() {
    const prop = collectProperties(this.hass).find(
      (p) => p.id === this._config.property || p.entity_id === this._config.property
    );
    this.shadowRoot.innerHTML = `
      ${this.styles(TILE_STYLES)}
      <div class="nw-card">
        ${prop
          ? `<div class="grid" style="--nw-min:100%">${tileMarkup(prop)}</div>`
          : `<div class="empty">${
              this._config.property
                ? `Property "${escapeHtml(this._config.property)}" is not in this neighbourhood.`
                : "Pick a property for this tile."
            }</div>`}
      </div>`;
    wireTiles(this.shadowRoot, this);
  }

  getCardSize() {
    return 2;
  }
}

/* ------------------------------------------------------------------ */
/* 3. Banner: invisible when all is well, unmissable when it is not    */
/* ------------------------------------------------------------------ */

const BANNER_STYLES = `
  .banner {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 18px; border-radius: var(--nw-radius);
    background: var(--tile-colour); color: #fff; font-weight: 600;
    touch-action: manipulation; cursor: pointer;
  }
  .banner ha-icon { --mdc-icon-size: 30px; flex: none; }
  .banner .who { font-size: 17px; line-height: 1.25; }
  .banner .what { font-size: 12px; opacity: .9; font-weight: 500; }
  .more { margin-left: auto; font-size: 12px; opacity: .85; text-align: right; }
`;

class NWBanner extends NWBaseCard {
  setConfig(config) {
    // Start hidden so a normal night never flashes an empty bar. This has to
    // happen here, not in the constructor: a custom element constructor must
    // not add attributes, and setting hidden there adds one, so
    // document.createElement throws and Home Assistant shows "Configuration
    // error" in place of the card.
    if (this._urgent === undefined) this.hidden = true;
    super.setConfig(config);
  }

  /**
   * Decide visibility here, not in render().
   *
   * When a card element is hidden, Home Assistant detaches it from the DOM.
   * render() only runs while connected, so a banner that hid itself from
   * render() could never run again to un-hide: it stayed gone even with a
   * neighbour in panic. The hass setter still runs on a detached element, so
   * this is where the decision has to live.
   */
  set hass(hass) {
    super.hass = hass;
    const urgent = collectProperties(hass).some((p) => stateMeta(p.state).urgent);
    this._urgent = urgent;
    this._setHidden(!urgent);
  }

  get hass() {
    return super.hass;
  }

  /**
   * Hide the card element itself, not just its contents.
   *
   * In a sections view Home Assistant only drops a card's grid slot when the
   * card element carries [hidden] and says so with card-visibility-changed.
   * Setting display:none from inside, as this used to, left an empty cell the
   * size of a card at the top of the page.
   */
  _setHidden(hidden) {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.dispatchEvent(
      new CustomEvent("card-visibility-changed", {
        detail: { value: !hidden },
        bubbles: true,
        composed: true,
      })
    );
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  render() {
    const urgent = sortProperties(
      collectProperties(this.hass).filter((p) => stateMeta(p.state).urgent)
    );

    // Rendering nothing at all lets this sit at the top of every view at every
    // property without cluttering anything on a normal night.
    if (!urgent.length) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    const top = urgent[0];
    const meta = stateMeta(top.state);
    const others = urgent.length - 1;

    this.shadowRoot.innerHTML = `
      ${this.styles(BANNER_STYLES)}
      <div class="banner nw-pulse" style="--tile-colour:${stateColour(top.state)};
           animation:nw-pulse 1.6s ease-in-out infinite"
           role="alert" tabindex="0" data-entity="${escapeHtml(top.entity_id)}">
        <ha-icon icon="${meta.icon}"></ha-icon>
        <div>
          <div class="who">${escapeHtml(top.name)} &middot; ${meta.label}</div>
          <div class="what">${top.detail ? escapeHtml(top.detail) + " &middot; " : ""}${relTime(top.since)} ago</div>
        </div>
        ${others ? `<div class="more">+${others} more</div>` : ""}
      </div>`;

    const el = this.shadowRoot.querySelector(".banner");
    if (el) el.addEventListener("click", () => this.moreInfo(top.entity_id));
  }

  getCardSize() {
    return 1;
  }
}

/* ------------------------------------------------------------------ */
/* 4. Panic: press and hold                                            */
/* ------------------------------------------------------------------ */

const PANIC_STYLES = `
  :host { height: 100%; }
  .nw-card { height: 100%; box-sizing: border-box; }
  .panic {
    position: relative; width: 100%; border: none; cursor: pointer;
    padding: 22px; border-radius: var(--nw-radius);
    background: color-mix(in srgb, var(--nw-panic) 12%, var(--nw-surface));
    border: 2px solid var(--nw-panic); color: var(--nw-panic);
    font: inherit; font-weight: 700; font-size: 16px; letter-spacing: .08em;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    overflow: hidden; touch-action: none; user-select: none;
    -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .panic ha-icon { --mdc-icon-size: 26px; }
  .fill {
    position: absolute; inset: 0 100% 0 0; background: var(--nw-panic);
    opacity: .3; transition: inset .05s linear;
  }
  .panic.armed-state { background: var(--nw-panic); color: #fff; }
  .hint { font-size: 11px; letter-spacing: .04em; font-weight: 500;
          color: var(--nw-muted); text-align: center; padding: 8px 0 0; }
  .row { display: flex; gap: var(--nw-gap); }
  .clear {
    flex: none; padding: 0 18px; border-radius: var(--nw-radius);
    border: 1px solid var(--divider-color, rgba(127,127,127,.3));
    background: transparent; color: var(--nw-text); cursor: pointer; font: inherit;
  }
`;

class NWPanic extends NWBaseCard {
  getGridOptions() {
    return { columns: 6, rows: "auto", min_columns: 4 };
  }

  constructor() {
    super();
    this._holdMs = 2000;
    this._timer = null;
    this._start = 0;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // The hold is a self-rescheduling rAF loop. Without this it survives the
    // card being removed and still fires: start a press, change your mind,
    // swipe to another view, and the whole neighbourhood gets a panic.
    this._abort();
  }

  render() {
    // Rebuild only once: re-rendering mid-hold would drop the press.
    if (this._built) {
      this._syncState();
      return;
    }
    this._built = true;

    const clearable = this._config.show_clear !== false;
    this.shadowRoot.innerHTML = `
      ${this.styles(PANIC_STYLES)}
      <div class="nw-card" style="padding:var(--nw-gap)">
        <div class="row">
          <button class="panic" type="button" aria-label="Hold to raise panic">
            <span class="fill"></span>
            <ha-icon icon="mdi:alarm-light"></ha-icon><span class="label">HOLD TO PANIC</span>
          </button>
          ${clearable ? `<button class="clear" type="button">Clear</button>` : ""}
        </div>
        <div class="hint">Hold for two seconds. Everyone in the neighbourhood is alerted.</div>
      </div>`;

    const button = this.shadowRoot.querySelector(".panic");
    button.addEventListener("pointerdown", (e) => this._begin(e));
    button.addEventListener("pointerup", () => this._abort());
    button.addEventListener("pointerleave", () => this._abort());
    button.addEventListener("pointercancel", () => this._abort());
    // A right click or long press must not open a context menu mid-hold.
    button.addEventListener("contextmenu", (e) => e.preventDefault());

    const clear = this.shadowRoot.querySelector(".clear");
    if (clear) clear.addEventListener("click", () => this._clear());

    this._syncState();
  }

  _syncState() {
    const self = collectSelf(this.hass);
    const button = this.shadowRoot.querySelector(".panic");
    if (!button || !self) return;
    const active = self.state === "panic";
    button.classList.toggle("armed-state", active);
    this.shadowRoot.querySelector(".label").textContent = active
      ? "PANIC RAISED"
      : "HOLD TO PANIC";
  }

  _begin(event) {
    if (this._timer) return;
    // currentTarget, not target: a press landing on the icon or the label
    // would otherwise capture the pointer on a child element.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    this._start = performance.now();
    const fill = this.shadowRoot.querySelector(".fill");

    const step = () => {
      const progress = Math.min(1, (performance.now() - this._start) / this._holdMs);
      fill.style.inset = `0 ${100 - progress * 100}% 0 0`;
      if (progress >= 1) {
        this._abort();
        this._fire();
        return;
      }
      this._timer = requestAnimationFrame(step);
    };
    this._timer = requestAnimationFrame(step);
  }

  _abort() {
    if (this._timer) {
      cancelAnimationFrame(this._timer);
      this._timer = null;
    }
    const fill = this.shadowRoot.querySelector(".fill");
    if (fill) fill.style.inset = "0 100% 0 0";
  }

  _fire() {
    const entity = this._config.entity || findCompanion(this.hass, "button", "_panic");
    if (!entity) return;
    navigator.vibrate?.([40, 60, 120]);
    this.callService("button", "press", { entity_id: entity });
  }

  _clear() {
    const entity = this._config.clear_entity || findCompanion(this.hass, "button", "_clear");
    if (!entity) return;
    this.callService("button", "press", { entity_id: entity });
  }

  getCardSize() {
    return 2;
  }
}

/* ------------------------------------------------------------------ */
/* 5. This property: own state, link health, publishing                */
/* ------------------------------------------------------------------ */

const SELF_STYLES = `
  :host { height: 100%; }
  .nw-card { height: 100%; box-sizing: border-box; display: flex; align-items: center; }
  .self { flex: 1; display: flex; align-items: center; gap: 14px; padding: 16px; }
  .dot { width: 42px; height: 42px; border-radius: 50%; flex: none;
         display: grid; place-items: center; color: #fff; background: var(--tile-colour); }
  .dot ha-icon { --mdc-icon-size: 22px; }
  .who { font-weight: 600; }
  .sub { font-size: 12px; color: var(--nw-muted); }
  .link { margin-left: auto; text-align: right; font-size: 12px; }
  .link .ok { color: var(--nw-armed); font-weight: 600; }
  .link .bad { color: var(--nw-alert); font-weight: 600; }
`;

class NWSelf extends NWBaseCard {
  getGridOptions() {
    return { columns: 6, rows: "auto", min_columns: 4 };
  }

  render() {
    const self = collectSelf(this.hass);
    if (!self) {
      this.shadowRoot.innerHTML = `${this.styles(SELF_STYLES)}
        <div class="nw-card"><div class="self"><div class="sub">Neighbourhood Watch is not set up on this instance.</div></div></div>`;
      return;
    }

    const meta = stateMeta(self.state);
    this.shadowRoot.innerHTML = `
      ${this.styles(SELF_STYLES)}
      <div class="nw-card">
        <div class="self" style="--tile-colour:${stateColour(self.state)}">
          <div class="dot"><ha-icon icon="${meta.icon}"></ha-icon></div>
          <div>
            <div class="who">${escapeHtml(self.name)}</div>
            <div class="sub">${meta.label}${self.detail ? " &middot; " + escapeHtml(self.detail) : ""} &middot; ${relTime(self.since)}</div>
          </div>
          <div class="link">
            <div class="${self.linked ? "ok" : "bad"}">${self.linked ? "LINKED" : "NO LINK"}</div>
            <div class="sub">${self.publishing ? "publishing" : "paused"}</div>
          </div>
        </div>
      </div>`;

    this.shadowRoot.querySelector(".self").addEventListener("click", () =>
      this.moreInfo(self.entity_id)
    );
  }

  getCardSize() {
    return 2;
  }
}

/* ------------------------------------------------------------------ */
/* 6. Live event log                                                   */
/* ------------------------------------------------------------------ */

const LOG_STYLES = `
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 10px; align-items: baseline;
       padding: 9px var(--nw-gap); border-top: 1px solid var(--divider-color, rgba(127,127,127,.15)); }
  li:first-child { border-top: none; }
  .pip { width: 8px; height: 8px; border-radius: 50%; background: var(--tile-colour); flex: none; }
  .txt { font-size: 13px; }
  .when { margin-left: auto; font-size: 11px; color: var(--nw-muted); white-space: nowrap; }
`;

class NWLog extends NWBaseCard {
  getGridOptions() {
    return { columns: "full", rows: "auto", min_columns: 6 };
  }

  constructor() {
    super();
    this._events = [];
    this._unsub = null;
  }

  /** Driven by its own event feed, not by entity state. */
  signature() {
    return null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsub) {
      this._unsub.then((fn) => fn && fn()).catch(() => {});
      this._unsub = null;
    }
  }

  // Both accessors are required. An accessor pair occupies one property slot,
  // so declaring only the setter would destroy the inherited getter and
  // this.hass would read undefined everywhere in render().
  set hass(hass) {
    super.hass = hass;
    this._subscribe();
  }

  get hass() {
    return super.hass;
  }

  _subscribe() {
    if (this._unsub || !this._hass || !this._hass.connection) return;
    const promise = this._hass.connection.subscribeEvents((event) => {
      const d = event.data || {};
      this._events.unshift({
        name: d.name || d.property_id,
        state: d.state,
        detail: d.detail,
        at: Math.floor(Date.now() / 1000),
      });
      this._events = this._events.slice(0, Number(this._config.max) || 12);
      this.requestRender();
    }, "neighbourhood_watch_status_changed");

    this._unsub = promise;
    // Without this a rejected subscribe leaves _unsub as a permanently
    // rejected promise, the guard above blocks every retry, and the log shows
    // "nothing since this page loaded" forever with an unhandled rejection in
    // the console.
    promise.catch(() => {
      if (this._unsub === promise) this._unsub = null;
    });
  }

  render() {
    const rows = this._events.length
      ? this._events
          .map((e) => {
            const meta = stateMeta(e.state);
            return `<li style="--tile-colour:${stateColour(e.state)}">
              <span class="pip"></span>
              <span class="txt"><strong>${escapeHtml(e.name)}</strong> ${meta.label.toLowerCase()}${
                e.detail ? " &middot; " + escapeHtml(e.detail) : ""
              }</span>
              <span class="when">${relTime(e.at)} ago</span></li>`;
          })
          .join("")
      : `<li><span class="txt" style="color:var(--nw-muted)">Nothing since this page loaded.</span></li>`;

    this.shadowRoot.innerHTML = `
      ${this.styles(LOG_STYLES)}
      <div class="nw-card">
        <div style="padding:14px var(--nw-gap) 6px;font-weight:600">${escapeHtml(
          this._config.title || "Recent activity"
        )}</div>
        <ul>${rows}</ul>
      </div>`;
  }

  getCardSize() {
    return 3;
  }
}

/* ------------------------------------------------------------------ */
/* 7. Badge for the sections view header                               */
/* ------------------------------------------------------------------ */

class NWBadge extends NWBaseCard {
  render() {
    const props = collectProperties(this.hass);
    const urgent = props.filter((p) => stateMeta(p.state).urgent);
    const offline = props.filter((p) => p.state === "offline");

    // No data must never render as "fine" on a security display.
    const worst = props.length ? sortProperties(props)[0].state : "unknown";
    const meta = stateMeta(worst);
    const text = !props.length
      ? "no data"
      : urgent.length
        ? `${urgent.length} alert${urgent.length > 1 ? "s" : ""}`
        : offline.length
          ? `${offline.length} offline`
          : `${props.length} ok`;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; }
        .b { display: inline-flex; align-items: center; gap: 6px;
             padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
             background: color-mix(in srgb, var(--c) 15%, transparent);
             border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
             color: var(--c); cursor: pointer; }
        .b ha-icon { --mdc-icon-size: 15px; }
        :host { --nw-panic:#d946ef; --nw-alert:#ef4444; --nw-armed:#3b82f6;
                --nw-disarmed:#64748b; --nw-offline:#475569; }
      </style>
      <span class="b" style="--c:${stateColour(worst)}" title="Neighbourhood Watch">
        <ha-icon icon="${meta.icon}"></ha-icon>${escapeHtml(text)}
      </span>`;
  }

  getCardSize() {
    return 1;
  }
}

/* ------------------------------------------------------------------ */

define("neighbourhood-watch-card", NWCard);
define("neighbourhood-watch-tile", NWTile);
define("neighbourhood-watch-banner", NWBanner);
define("neighbourhood-watch-panic", NWPanic);
define("neighbourhood-watch-self", NWSelf);
define("neighbourhood-watch-log", NWLog);
define("neighbourhood-watch-badge", NWBadge);

registerCard("neighbourhood-watch-card", "Neighbourhood Watch", "Every property in the neighbourhood as status tiles");
registerCard("neighbourhood-watch-tile", "Neighbourhood Watch tile", "A single property");
registerCard("neighbourhood-watch-banner", "Neighbourhood Watch banner", "Hidden until something needs attention");
registerCard("neighbourhood-watch-panic", "Neighbourhood Watch panic", "Press and hold to alert the neighbourhood");
registerCard("neighbourhood-watch-self", "Neighbourhood Watch this property", "What this property is publishing");
registerCard("neighbourhood-watch-log", "Neighbourhood Watch activity", "Live feed of neighbourhood events");
registerCard("neighbourhood-watch-badge", "Neighbourhood Watch badge", "Compact header badge");

console.info(
  `%c NEIGHBOURHOOD-WATCH %c ${NW_VERSION} `,
  "color:#fff;background:#d946ef;font-weight:700",
  "color:#d946ef;background:#222"
);
