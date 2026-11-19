// Time zones, done by the browser's own zone database (Intl), so daylight saving is right for
// the actual date of every time shown, every year, with nothing of ours to keep up to date.
//
//   zoneName(iso, tz)    "IST", "GST", "BST", or "GMT+5:30" when no short name is in use there
//   zoneChip(iso, tz, opts)   a small tappable label beside a time that opens the converter
//   openConverter({ iso, places })   the time in each place, your own, and any cities you add

import { h, svg, clock } from "./util.js";
import { icons } from "./icons.js";

/** The short name people use for a zone at that moment ("BST" in summer, "GMT" in winter). */
export function zoneName(iso, tz) {
  const at = new Date(iso || Date.now());
  for (const locale of ["en-IN", "en-US", "en-GB", "en-AU"]) {
    try {
      const n = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
      if (n && !/^(GMT|UTC)[+-]/.test(n)) return n;
    } catch {
      return "";
    }
  }
  return offsetName(iso, tz);
}

/** "GMT+5:30", for the moment given. */
export function offsetName(iso, tz) {
  const m = offsetMin(iso, tz);
  if (!m) return "GMT";
  const a = Math.abs(m);
  return `GMT${m > 0 ? "+" : "−"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

/** Minutes ahead of UTC in a zone at a moment. */
export function offsetMin(iso, tz) {
  const at = new Date(iso || Date.now());
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** The long name of a zone: "India Standard Time", "Gulf Standard Time". */
export function zoneLong(iso, tz) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date(iso || Date.now())).find((p) => p.type === "timeZoneName")?.value || tz;
  } catch {
    return tz;
  }
}

/** A city for a zone id: "Asia/Kolkata" → "Kolkata", "America/New_York" → "New York". */
export const zoneCity = (tz) => String(tz || "").split("/").pop().replace(/_/g, " ");

export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The small label beside a time. Tapping it shows that moment around the world. */
export function zoneChip(iso, tz, { places = [], label = null } = {}) {
  if (!iso || !tz) return null;
  const name = zoneName(iso, tz);
  return h(
    "button",
    {
      type: "button",
      class: "tz-chip",
      "aria-label": `${name}, ${zoneLong(iso, tz)}. See this time in other places`,
      title: zoneLong(iso, tz),
      on: { click: (e) => (e.stopPropagation(), openConverter({ iso, from: { tz, city: label || zoneCity(tz) }, places })) },
    },
    name
  );
}

/* ---------------- the converter ---------------- */

const SAVED = "tzCities";
const saved = () => {
  try {
    return (JSON.parse(localStorage.getItem(SAVED) || "[]") || []).filter((x) => x && x.tz).slice(0, 6);
  } catch {
    return [];
  }
};
const save = (list) => {
  try {
    localStorage.setItem(SAVED, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* not kept */
  }
};

/** Every zone the browser knows, with words to find it by. */
let zoneIndex = null;
function zones() {
  if (zoneIndex) return zoneIndex;
  const ids = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "Asia/Singapore", "Australia/Sydney"];
  // A few names people search by that aren't in the zone ids
  const extra = { "Asia/Kolkata": "India Delhi Mumbai Bengaluru Bangalore Hyderabad Chennai", "Asia/Dubai": "UAE Abu Dhabi", "Europe/London": "UK England", "America/New_York": "USA East", "America/Los_Angeles": "USA West California San Francisco", "Asia/Riyadh": "Saudi Jeddah", "Asia/Qatar": "Doha", "Australia/Sydney": "Australia", "Asia/Tokyo": "Japan", "Europe/Berlin": "Germany Frankfurt", "Europe/Paris": "France", "America/Toronto": "Canada", "Asia/Singapore": "Singapore" };
  zoneIndex = ids.map((tz) => ({ tz, city: zoneCity(tz), words: `${zoneCity(tz)} ${tz} ${zoneLong(null, tz)} ${extra[tz] || ""}`.toLowerCase() }));
  return zoneIndex;
}

/** A little clock face showing the hour, so far-apart times read at a glance. */
function face(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24;
  const mm = +p.minute;
  const night = hh < 6 || hh >= 19;
  const a = (deg) => ((deg - 90) * Math.PI) / 180;
  const hd = a(((hh % 12) + mm / 60) * 30);
  const md = a(mm * 6);
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, at) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(at)) n.setAttribute(k, v);
    return n;
  };
  const s = el("svg", { viewBox: "0 0 40 40", class: `tz-face${night ? " night" : ""}`, "aria-hidden": "true" });
  s.append(
    el("circle", { cx: 20, cy: 20, r: 18, class: "tz-face-bg" }),
    el("line", { x1: 20, y1: 20, x2: 20 + Math.cos(hd) * 9, y2: 20 + Math.sin(hd) * 9, class: "tz-hand h" }),
    el("line", { x1: 20, y1: 20, x2: 20 + Math.cos(md) * 13, y2: 20 + Math.sin(md) * 13, class: "tz-hand m" }),
    el("circle", { cx: 20, cy: 20, r: 1.8, class: "tz-pin" })
  );
  return s;
}

let dialog = null;
/**
 * The moment in each place: where it happens first, the other airport, you, and cities you add
 * (kept on this device). Every time is worked out for that exact date, daylight saving included.
 */
export function openConverter({ iso, from, places = [] }) {
  if (!dialog) {
    dialog = h("dialog", { class: "sheet tz-sheet", "aria-labelledby": "tz-title" });
    dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
    document.body.append(dialog);
  }
  const at = new Date(iso);
  const dayKey = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
  const baseDay = dayKey(from.tz);
  const rel = (tz) => {
    const d = Math.round((Date.parse(`${dayKey(tz)}T00:00:00Z`) - Date.parse(`${baseDay}T00:00:00Z`)) / 86400000);
    return d === 0 ? "Same day" : d === 1 ? "Next day" : d === -1 ? "Day before" : d > 0 ? `${d} days later` : `${-d} days before`;
  };
  const gap = (tz) => {
    const d = offsetMin(iso, tz) - offsetMin(iso, from.tz);
    if (!d) return "Same time";
    const a = Math.abs(d);
    return `${d > 0 ? "+" : "−"}${Math.floor(a / 60)}h${a % 60 ? ` ${a % 60}m` : ""}`;
  };
  const day = (tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);

  function paint() {
    const seen = new Set([from.tz]);
    const rows = [{ ...from, role: "Where it happens" }];
    for (const p of places) if (p?.tz && !seen.has(`${p.tz}|${p.city}`) && !(p.tz === from.tz && p.city === from.city)) (rows.push(p), seen.add(`${p.tz}|${p.city}`));
    const mine = deviceZone();
    if (!rows.some((r) => r.tz === mine)) rows.push({ tz: mine, city: zoneCity(mine), role: "You" });
    for (const c of saved()) if (!rows.some((r) => r.tz === c.tz && r.city === c.city)) rows.push({ ...c, saved: true });

    const card = (r) =>
      h(
        "li",
        { class: `tz-row${r === rows[0] ? " base" : ""}` },
        face(iso, r.tz),
        h(
          "div",
          { class: "tz-where" },
          h("strong", { text: r.city }),
          h("small", { text: [r.role, zoneName(iso, r.tz), r === rows[0] ? zoneLong(iso, r.tz) : gap(r.tz)].filter(Boolean).join(" · ") })
        ),
        h("div", { class: "tz-when" }, h("strong", { class: "tn", text: clock(iso, r.tz) }), h("small", { text: r === rows[0] ? day(r.tz) : `${day(r.tz)} · ${rel(r.tz)}` })),
        r.saved
          ? h("button", { type: "button", class: "tz-x", "aria-label": `Remove ${r.city}`, on: { click: () => (save(saved().filter((x) => !(x.tz === r.tz && x.city === r.city))), paint()) } }, svg(icons.close))
          : null
      );

    // Add a city: type to find it among the browser's zones
    const input = h("input", { class: "jn-input tz-add-in", type: "search", placeholder: "Add a city: London, Toronto, Sydney…", autocomplete: "off", "aria-label": "Add a city" });
    const list = h("ul", { class: "tz-pick", role: "listbox", hidden: true });
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) return void (list.hidden = true);
      const found = zones().filter((z) => z.words.includes(q)).slice(0, 6);
      list.replaceChildren(
        ...found.map((z) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                role: "option",
                on: {
                  click: () => {
                    save([...saved().filter((x) => x.tz !== z.tz), { tz: z.tz, city: z.city }]);
                    paint();
                  },
                },
              },
              h("strong", { text: z.city }),
              h("small", { text: `${zoneLong(iso, z.tz)} · ${clock(iso, z.tz)}` })
            )
          )
        )
      );
      list.hidden = !found.length;
    });

    const text = rows
      .slice(0, 4)
      .map((r, i) => (i === 0 ? `${clock(iso, r.tz)} ${zoneName(iso, r.tz)} on ${day(r.tz)} in ${r.city}` : `${clock(iso, r.tz)} ${day(r.tz)} in ${r.city}`))
      .join(" · that's ");
    const share = h(
      "button",
      {
        type: "button",
        class: "cta secondary",
        on: {
          click: async () => {
            try {
              if (navigator.share) return void (await navigator.share({ text }));
            } catch (e) {
              if (e.name === "AbortError") return;
            }
            try {
              await navigator.clipboard.writeText(text);
              share.lastChild.textContent = "Copied";
            } catch {
              /* nothing to do */
            }
          },
        },
      },
      svg(icons.share),
      h("span", { text: "Share these times" })
    );
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close", on: { click: () => dialog.close() } }, svg(icons.close));
    dialog.replaceChildren(
      h(
        "div",
        { class: "sheet-inner" },
        h("span", { class: "sheet-grab", "aria-hidden": "true" }),
        h("div", { class: "sheet-head" }, h("h2", { class: "display", id: "tz-title", text: "This time, around the world" }), close),
        h("ol", { class: "tz-rows" }, rows.map(card)),
        h("div", { class: "tz-add" }, input, list),
        share,
        h("p", { class: "jn-fine small", text: "Worked out for this exact date, daylight saving included. Cities you add stay on this device." })
      )
    );
  }
  paint();
  if (!dialog.open) dialog.showModal();
}
