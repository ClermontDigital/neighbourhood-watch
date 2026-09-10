/**
 * Dashboard and view strategies.
 *
 * This is what keeps every property's dashboard identical. Rather than asking
 * each household to paste the same YAML and hoping it stays in step, the view
 * is generated at runtime. The cards discover properties from the entity
 * registry as they render, so a property that joins the neighbourhood appears
 * on everyone's dashboard with nothing edited anywhere.
 */

import { NW_VERSION } from "./nw-base.js";

function buildView(config = {}) {
  const cards = [];

  // Always first, and invisible unless something is wrong.
  cards.push({ type: "custom:neighbourhood-watch-banner" });

  cards.push({
    type: "custom:neighbourhood-watch-card",
    title: config.title === undefined ? "Neighbourhood" : config.title,
    min_tile: config.min_tile || 120,
    include_self: config.include_self !== false,
  });

  if (config.show_self !== false) {
    cards.push({ type: "custom:neighbourhood-watch-self" });
  }
  if (config.show_panic !== false) {
    cards.push({ type: "custom:neighbourhood-watch-panic" });
  }
  if (config.show_log !== false) {
    cards.push({ type: "custom:neighbourhood-watch-log", max: config.log_max || 12 });
  }

  return {
    title: config.view_title || "Neighbourhood",
    path: config.path || "neighbourhood",
    icon: config.icon || "mdi:shield-home",
    // Masonry rather than sections on purpose: it behaves predictably at every
    // width without any per property tuning, which is the whole point here.
    // Stated explicitly rather than inferred from the presence of "cards",
    // because the frontend's final fallback for an untyped view is now
    // sections, not masonry.
    type: "masonry",
    cards,
  };
}

// HTMLElement, not HTMLTemplateElement. Home Assistant only ever reads the
// static generate() off the registered constructor, so extending the template
// element happened to work, but such an element can never be constructed:
// customElements.define accepts it, then `new` throws "Illegal constructor"
// and createElement silently yields HTMLUnknownElement.
class NWDashboardStrategy extends HTMLElement {
  // No configuration UI, so tell the dashboard dialog not to offer one.
  static noEditor = true;

  static async generate(config, _hass) {
    return {
      title: config.dashboard_title || "Neighbourhood Watch",
      views: [buildView(config)],
    };
  }
}

class NWViewStrategy extends HTMLElement {
  static noEditor = true;

  static async generate(config, _hass) {
    // A view strategy returns the view body only; the surrounding dashboard
    // supplies the title and icon.
    // The dashboard supplies title, path and icon: the frontend spreads the
    // generated view over the user's own config, so returning them here would
    // override whatever they set in YAML.
    const view = buildView(config);
    delete view.title;
    delete view.path;
    delete view.icon;
    return view;
  }
}

if (!customElements.get("ll-strategy-dashboard-neighbourhood-watch")) {
  customElements.define("ll-strategy-dashboard-neighbourhood-watch", NWDashboardStrategy);
}
if (!customElements.get("ll-strategy-view-neighbourhood-watch")) {
  customElements.define("ll-strategy-view-neighbourhood-watch", NWViewStrategy);
}

// Makes the strategy appear under Community dashboards in the new dashboard
// dialog, so setting a property up never involves editing YAML.
window.customStrategies = window.customStrategies || [];
for (const entry of [
  {
    type: "neighbourhood-watch",
    strategyType: "dashboard",
    name: "Neighbourhood Watch",
    description: "Every property in the neighbourhood, with panic and activity.",
    documentationURL: "https://github.com/ClermontDigital/neighbourhood-watch",
  },
  {
    type: "neighbourhood-watch",
    strategyType: "view",
    name: "Neighbourhood Watch view",
    description: "The neighbourhood as one view inside an existing dashboard.",
    documentationURL: "https://github.com/ClermontDigital/neighbourhood-watch",
  },
]) {
  const exists = window.customStrategies.some(
    (s) => s.type === entry.type && s.strategyType === entry.strategyType
  );
  if (!exists) window.customStrategies.push(entry);
}

console.debug(`[neighbourhood-watch] strategies registered (${NW_VERSION})`);
