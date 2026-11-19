// Small marks every screen shares, so trains and flights read the same everywhere:
//   endBadge("leave" | "arrive")  ↗ / ↘ beside where you start and where you get off
//   tripFacts({ ms, km, overnight })  clock · duration · distance · moon Overnight
//   signal(label, value, icon)   the yellow tile for the one detail you hunt for on the day:
//                                gate, belt, platform, coach
import { h, svg, duration } from "./util.js";
import { icons } from "./icons.js";

const ARROW = {
  leave: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M8.5 15.5l7-7M10 8.5h5.5V14" fill="none" stroke="var(--card)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrive: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M8.5 8.5l7 7M15.5 10v5.5H10" fill="none" stroke="var(--card)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** ↗ where you leave from, ↘ where you arrive. Decorative: the words beside it say the same. */
export const endBadge = (dir) => h("span", { class: `end-badge ${dir}`, "aria-hidden": "true" }, svg(ARROW[dir]));

/** "🕒 13h 05m · 768 km · 🌙 Overnight", leaving out what isn't known. */
export function tripFacts({ ms = null, km = null, overnight = false, lead = null } = {}) {
  const parts = [];
  if (lead) parts.push(h("span", { text: lead }));
  if (ms > 0) parts.push(h("span", {}, svg(icons.clock), duration(ms)));
  if (km) parts.push(h("span", { text: `${Math.round(km).toLocaleString("en-IN")} km` }));
  if (overnight) parts.push(h("span", { class: "tf-night" }, svg(icons.moon), "Overnight"));
  if (!parts.length) return null;
  return h("span", { class: "trip-facts tn" }, parts.flatMap((p, i) => (i ? [h("i", { "aria-hidden": "true", text: "·" }), p] : [p])));
}

/** The yellow tile: "Gate 42B", "Belt 6", "PF 3", "Coach B1". Value "--" until it's known. */
export function signal(label, value, icon = null, { dim = false } = {}) {
  return h("span", { class: `signal${dim || !value ? " dim" : ""}` }, icon ? svg(icon) : null, h("strong", { class: "tn", text: value || "--" }), h("small", { text: label }));
}
