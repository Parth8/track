// A plane: what it is, at a glance and in plain words. Type facts are the published ones for
// each model (when it first flew, its engines, how many seats airlines usually fit); the plane
// itself (registration, owner, photo, its day) comes from /api/aircraft.

import { h, svg, clock, dayLabel } from "./util.js";
import { icons } from "./icons.js";
import { zoneName } from "./tz.js";

// ICAO type → maker, name, body, engines, typical seats, year the type first flew
const T = (maker, name, body, engines, seats, first) => ({ maker, name, body, engines, seats, first });
export const TYPES = {
  A19N: T("Airbus", "A319neo", "narrow", "2 jet", "120–160", 2017),
  A319: T("Airbus", "A319", "narrow", "2 jet", "120–156", 1995),
  A20N: T("Airbus", "A320neo", "narrow", "2 jet", "150–194", 2014),
  A320: T("Airbus", "A320", "narrow", "2 jet", "150–186", 1987),
  A21N: T("Airbus", "A321neo", "narrow", "2 jet", "180–244", 2016),
  A321: T("Airbus", "A321", "narrow", "2 jet", "180–236", 1993),
  A332: T("Airbus", "A330-200", "wide", "2 jet", "220–300", 1997),
  A333: T("Airbus", "A330-300", "wide", "2 jet", "250–330", 1992),
  A339: T("Airbus", "A330-900neo", "wide", "2 jet", "260–310", 2017),
  A359: T("Airbus", "A350-900", "wide", "2 jet", "300–350", 2013),
  A35K: T("Airbus", "A350-1000", "wide", "2 jet", "350–410", 2016),
  A388: T("Airbus", "A380", "wide", "4 jet", "480–615", 2005),
  BCS3: T("Airbus", "A220-300", "narrow", "2 jet", "120–150", 2015),
  B737: T("Boeing", "737-700", "narrow", "2 jet", "126–149", 1997),
  B738: T("Boeing", "737-800", "narrow", "2 jet", "162–189", 1997),
  B739: T("Boeing", "737-900", "narrow", "2 jet", "177–220", 2000),
  B38M: T("Boeing", "737 MAX 8", "narrow", "2 jet", "162–200", 2016),
  B39M: T("Boeing", "737 MAX 9", "narrow", "2 jet", "178–220", 2017),
  B763: T("Boeing", "767-300", "wide", "2 jet", "210–270", 1986),
  B772: T("Boeing", "777-200", "wide", "2 jet", "300–350", 1994),
  B77L: T("Boeing", "777-200LR", "wide", "2 jet", "300–320", 2005),
  B77W: T("Boeing", "777-300ER", "wide", "2 jet", "350–400", 2003),
  B788: T("Boeing", "787-8", "wide", "2 jet", "240–250", 2009),
  B789: T("Boeing", "787-9", "wide", "2 jet", "270–300", 2013),
  B78X: T("Boeing", "787-10", "wide", "2 jet", "300–340", 2017),
  B744: T("Boeing", "747-400", "wide", "4 jet", "400–420", 1988),
  B748: T("Boeing", "747-8", "wide", "4 jet", "410–470", 2010),
  AT72: T("ATR", "ATR 72", "turboprop", "2 propeller", "68–74", 1988),
  AT75: T("ATR", "ATR 72-500", "turboprop", "2 propeller", "68–74", 1996),
  AT76: T("ATR", "ATR 72-600", "turboprop", "2 propeller", "68–78", 2009),
  DH8D: T("De Havilland", "Dash 8-400", "turboprop", "2 propeller", "74–90", 1998),
  E190: T("Embraer", "E190", "regional", "2 jet", "96–114", 2004),
  E195: T("Embraer", "E195", "regional", "2 jet", "108–124", 2004),
  E290: T("Embraer", "E190-E2", "regional", "2 jet", "96–114", 2016),
  E295: T("Embraer", "E195-E2", "regional", "2 jet", "120–146", 2017),
  CRJ9: T("Bombardier", "CRJ900", "regional", "2 jet", "76–90", 2001),
};
const BODY = { narrow: "Narrow-body jet", wide: "Wide-body jet", turboprop: "Turboprop", regional: "Regional jet" };

/** The maker from a type code or a model name: "A20N" or "Airbus A320neo" → "Airbus". */
export function makerOf(codeOrName) {
  const s = String(codeOrName || "").toUpperCase();
  if (TYPES[s]) return TYPES[s].maker;
  if (/AIRBUS|^A3\d\d|^A2\d\d|A220/.test(s)) return "Airbus";
  if (/BOEING|^B7\d\d|737|747|757|767|777|787/.test(s)) return "Boeing";
  if (/ATR/.test(s)) return "ATR";
  if (/EMBRAER|^E1\d\d|^E2\d\d/.test(s)) return "Embraer";
  if (/DASH|Q400|DHC|DE HAVILLAND/.test(s)) return "De Havilland";
  if (/CRJ|BOMBARDIER/.test(s)) return "Bombardier";
  return null;
}

/** "Airbus" as a small badge, coloured by maker so a glance is enough. */
export function makerBadge(maker) {
  if (!maker) return null;
  const k = maker.toLowerCase().replace(/[^a-z]/g, "");
  return h("span", { class: `maker maker-${k}`, text: maker });
}

/** One line of facts about a type: "Narrow-body jet · 2 jet engines · 150–194 seats · first flew 2014". */
export function typeLine(code) {
  const t = TYPES[String(code || "").toUpperCase()];
  if (!t) return null;
  return [BODY[t.body], `${t.engines} engines`, `usually ${t.seats} seats`, `type first flew ${t.first}`].join(" · ");
}

/** "Airbus A320 on 13 of the last 13 days", "Boeing 737-800 on 9 of 13, Airbus A320 on 4". */
export function usualType(history, aircraftName) {
  const types = (history || []).map((r) => r.type).filter(Boolean);
  if (types.length < 3) return null;
  const count = new Map();
  for (const t of types) count.set(t, (count.get(t) || 0) + 1);
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const name = (c) => aircraftName(c) || c;
  const [top, n] = ranked[0];
  const head = `${name(top)} on ${n} of the last ${types.length} days`;
  const rest = ranked.slice(1, 3).map(([c, k]) => `${name(c)} on ${k}`);
  return { text: rest.length ? `${head}; ${rest.join(", ")}` : head, makers: [...new Set(ranked.map(([c]) => makerOf(c)).filter(Boolean))], same: ranked.length === 1 };
}

/** The photo of a plane, credited to its photographer as Planespotters asks, linking to it. */
export function planePhoto(photo, reg) {
  if (!photo?.src) return null;
  return h(
    "figure",
    { class: "plane-photo" },
    h("img", { src: photo.src, alt: `${reg}, photographed`, loading: "lazy", referrerPolicy: "no-referrer" }),
    h("figcaption", {}, "Photo: ", h("a", { href: photo.link, target: "_blank", rel: "noopener noreferrer", text: `${photo.by || "Planespotters"} / Planespotters.net` }))
  );
}

/** A plane's own page: what it is, a photo, where it is, and what it flies around today. */
export function renderPlanePage(a, { onOpenFlight } = {}) {
  const t = TYPES[String(a.icaoType || "").toUpperCase()];
  const now = Date.now();
  const node = h(
    "div",
    { class: "status-body plane-page" },
    h("header", { class: "flight-head" }, h("p", { class: "field-hint tn", text: [a.owner, a.variant].filter(Boolean).join(" · ") || "Aircraft" }), h("h2", { class: "display hero-place", text: a.reg })),
    planePhoto(a.photo, a.reg),
    h(
      "section",
      { class: "card plane-id" },
      h("p", { class: "plane-make" }, makerBadge(a.maker || makerOf(a.icaoType)), h("strong", { text: a.model || a.icaoType || "Unknown type" })),
      typeLine(a.icaoType) ? h("p", { class: "plane-facts", text: typeLine(a.icaoType) }) : null,
      h(
        "dl",
        { class: "plane-dl" },
        [
          ["Registration", a.reg],
          ["Exact model", a.variant],
          ["Owner", a.owner],
          ["Transponder", a.hex ? a.hex.toUpperCase() : null],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => [h("dt", { text: k }), h("dd", { class: "tn", text: v })])
      ),
      a.position
        ? h("p", { class: "plane-now" }, h("i", { class: "live-dot", "aria-hidden": "true" }), `In the air now: ${Math.round(a.position.altFt || 0).toLocaleString("en-IN")} ft, ${a.position.speedKmh || "--"} km/h`)
        : null
    ),
    a.flights?.length
      ? h(
          "section",
          { class: "card plane-day" },
          h("h3", { class: "card-title", text: "Its flights, yesterday to tomorrow" }),
          h(
            "ol",
            { class: "plane-flights" },
            a.flights.map((f) => {
              const out = f.times.out.actual || f.times.out.est || f.times.out.sched;
              const tz = f.from.tz || "UTC";
              const live = f.phase === "air";
              const done = f.phase === "landed";
              const no = f.number.replace(/\s+/g, "");
              return h(
                "li",
                { class: `pf-row ${f.phase}` },
                h(
                  "a",
                  {
                    href: `?m=flight&no=${no}&d=${f.date}`,
                    on: { click: (e) => onOpenFlight && (e.preventDefault(), onOpenFlight(no, f.date)) },
                  },
                  h("span", { class: "pf-when tn" }, h("b", { text: clock(out, tz) }), h("small", { text: `${dayLabel(out, tz)} · ${zoneName(out, tz)}` })),
                  h("span", { class: "pf-route" }, h("b", { text: `${f.from.code} → ${f.to.code}` }), h("small", { text: `${f.number} · ${f.from.city || ""} to ${f.to.city || ""}` })),
                  h("span", { class: `chip small ${live ? "accent live" : done ? "quiet" : "info"}`, text: live ? "In the air" : done ? "Landed" : f.phase === "cancelled" ? "Cancelled" : "Scheduled" })
                )
              );
            })
          )
        )
      : h("p", { class: "jn-fine", text: "No flights listed for this plane around today." }),
    h("p", { class: "data-credit", text: "Aircraft details from hexdb.io; its flights from FlightAware; photo from Planespotters.net. A plane's age isn't published freely, so it isn't shown." })
  );
  return node;
}
