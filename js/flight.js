import { h, svg, clock, dayLabel, dateKey, duration, ago, delayChip, fmtMin, tzOffset, greatCircle, bearing, timeNode, dayShift } from "./util.js";
import { icons, weatherLook, bodyType } from "./icons.js";

/**
 * Flight status screen. The order changes with the phase:
 * before takeoff the departure leads, in the air the map leads, after landing the belt leads.
 */
/** "2h 05m" for today; "2d 13h" when departure is more than a day away. */
const countdown = (ms) => (ms >= 86400000 ? `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h` : duration(ms));

export function renderFlight(f) {
  const dep = f.departure;
  const arr = f.arrival;
  const depTz = dep.tz || "UTC";
  const arrTz = arr.tz || "UTC";
  const phase = f.status.phase;
  const t12 = (iso, tz) => clock(iso, tz); // follows the person's 12/24-hour choice
  // "+1" is counted from the local date the flight was scheduled to leave.
  const baseDate = dateKey(dep.sched, depTz);
  const depCity = dep.city || dep.code;
  const arrCity = arr.city || arr.code;

  const depTime = dep.revised || dep.sched;
  const arrTime = (phase === "landed" && (arr.actual || arr.revised)) || arr.revised || arr.sched;
  const takeoff = dep.actual || depTime;
  const now = Date.now();
  const reported = !!(f.position && Number.isFinite(f.position.lat));
  const live = reported && f.position.source === "live";

  let fraction = phase === "landed" ? 1 : 0;
  if (phase === "air" && takeoff && arrTime) {
    fraction = Math.min(0.99, Math.max(0.01, (now - Date.parse(takeoff)) / (Date.parse(arrTime) - Date.parse(takeoff))));
  }

  const blocks = {};

  /* ---------------- header ---------------- */
  blocks.head = h(
    "header",
    { class: "flight-head" },
    h("p", { class: "field-hint tn", text: `${f.airline.name}, ${dayLabel(dep.sched, depTz)}` }),
    h("h2", { class: "display hero-place", text: `${depCity} to ${arrCity}` })
  );

  /* ---------------- map (every phase) ---------------- */
  let map = null;
  const haveGeo = [dep.lat, dep.lon, arr.lat, arr.lon].every(Number.isFinite);
  if (haveGeo) {
    const line = greatCircle([dep.lon, dep.lat], [arr.lon, arr.lat], 96);
    const startBearing = bearing(line[0], line[1]);
    const endBearing = bearing(line.at(-2), line.at(-1));
    let badge = { text: "Route", cls: "estimated" };
    let note = null;
    const opts = { mode: "flight", line, fraction, position: null, trackDeg: startBearing };

    if (phase === "pre") {
      badge = { text: `Waiting at ${dep.code}`, cls: "estimated" };
      note = "Your route. The plane moves along it once it takes off.";
      opts.position = line[0];
    } else if (phase === "air") {
      if (reported) {
        badge = live ? { text: "Live position", cls: "" } : { text: "Reported position", cls: "" };
        opts.position = [f.position.lon, f.position.lat];
        opts.trackDeg = Number.isFinite(f.position.trackDeg) ? f.position.trackDeg : startBearing;
      } else {
        badge = { text: "Estimated position", cls: "estimated" };
        note = "No receiver has picked up this plane in the last 10 minutes, so its position is estimated from the schedule.";
      }
    } else if (phase === "landed") {
      badge = { text: `Landed at ${arr.code}`, cls: "" };
      opts.position = line.at(-1);
      opts.trackDeg = endBearing;
    } else {
      badge = { text: phase === "cancelled" ? "Cancelled" : "Diverted", cls: "estimated" };
      opts.hideMarker = !reported;
      if (reported) opts.position = [f.position.lon, f.position.lat];
    }

    const el = h("div", { class: `map-box${phase === "air" ? " tall" : ""}`, role: "img", "aria-label": `Map of the route from ${depCity} to ${arrCity}` });
    blocks.map = h(
      "section",
      { class: "card map-card" },
      h("span", { class: `map-badge ${badge.cls}` }, h("i"), badge.text),
      el,
      note ? h("p", { class: "map-note", text: note }) : null
    );
    map = { el, opts };
  }

  /* ---------------- in-air numbers ---------------- */
  if (phase === "air") {
    const stat = (label, value) => h("div", { class: "card stat" }, h("span", { text: label }), h("strong", { class: "tn", text: value }));
    const left = f.distanceKm ? `${Math.round(f.distanceKm * (1 - fraction)).toLocaleString("en-IN")} km` : "--";
    blocks.stats = reported
      ? h(
          "div",
          { class: "stat-grid" },
          stat("Altitude", f.position.altFt ? `${Math.round(f.position.altFt).toLocaleString("en-IN")} ft` : "Climbing"),
          stat("Speed", f.position.speedKmh ? `${f.position.speedKmh} km/h` : "--"),
          stat("Signal", f.position.ageSec != null && f.position.ageSec < 60 ? "Live now" : ago(f.position.at))
        )
      : h(
          "div",
          { class: "stat-grid" },
          stat("In the air", duration(now - Date.parse(takeoff))),
          stat("Distance left", left),
          stat("Live signal", "Out of range")
        );
  }

  /* ---------------- phase banner ---------------- */
  const banner = h("section", { class: "phase-banner", "aria-live": "polite" });
  const tone = (d) => banner.classList.add(d == null ? "tone" : d >= 15 ? "warn" : d <= 5 ? "good" : "tone");
  const lead = (t) => h("p", { class: "lead", text: t });
  const big = (t) => h("p", { class: "big", "data-k": "banner" }, t);
  const sub = (t) => h("p", { class: "sub", text: t });

  if (phase === "cancelled") {
    banner.classList.add("bad");
    banner.append(lead("Flight status"), big("Cancelled"), sub(`Check with ${f.airline.name} about rebooking or a refund.`));
  } else if (phase === "diverted") {
    banner.classList.add("warn");
    banner.append(lead("Flight status"), big("Diverted"), sub(`${f.airline.name} will share the new plan. We'll keep checking.`));
  } else if (phase === "pre") {
    const d = f.status.delayDep;
    tone(d);
    const until = Date.parse(depTime) - now;
    const dc = delayChip(d);
    const statusWord = /Boarding/.test(f.status.raw) ? "Boarding now" : /GateClosed/.test(f.status.raw) ? "Gate closed" : null;
    banner.append(
      lead(until > 0 ? "Departs in" : "Departure"),
      big(until > 0 ? countdown(until) : timeNode(depTime, depTz, { shift: dayShift(depTime, baseDate, depTz) })),
      sub([statusWord, dc && dc.cls === "late" ? `Delayed ${fmtMin(d)}, now ${t12(depTime, depTz)}` : `On time at ${t12(depTime, depTz)}`].filter(Boolean).join(". "))
    );
  } else if (phase === "air") {
    const d = f.status.delayArr;
    tone(d);
    const dc = delayChip(d);
    const left = Math.max(0, Date.parse(arrTime) - now);
    banner.append(
      lead("Lands in"),
      big(duration(left)),
      sub(`${t12(arrTime, arrTz)} in ${arrCity}, ${dc ? dc.text.toLowerCase() : "on schedule"}`),
      h("div", { class: "progress", "aria-hidden": "true" }, h("i")),
      h(
        "div",
        { class: "progress-legend tn" },
        h("span", { text: `${duration(now - Date.parse(takeoff))} flown` }),
        h("span", { text: `${Math.round(fraction * 100)}% of the way` })
      )
    );
    banner.querySelector(".progress i").style.width = `${fraction * 100}%`;
    if (f.status.inferred) banner.append(sub("Spotted in the air before the airline updated its status."));
  } else {
    const d = f.status.delayArr;
    tone(d);
    const dc = delayChip(d);
    banner.append(lead(`Landed in ${arrCity}`), big(timeNode(arrTime, arrTz, { shift: dayShift(arrTime, baseDate, arrTz) })), sub(`${dc ? dc.text : "On time"}, ${ago(arrTime)}.`));
  }
  blocks.banner = banner;

  /* ---------------- after landing ---------------- */
  if (phase === "landed" && arr.belt) {
    blocks.belt = h(
      "section",
      { class: "belt-hero" },
      h("span", { class: "belt-num tn", text: arr.belt }),
      h("div", {}, h("span", {}, "Baggage belt"), h("strong", { text: `Your bags arrive on belt ${arr.belt}` }))
    );
  }
  if (phase === "landed" && navigator.share) {
    blocks.share = h(
      "button",
      {
        type: "button",
        class: "cta secondary",
        on: { click: () => navigator.share({ text: `Landed in ${arrCity} at ${t12(arrTime, arrTz)}. ${f.number}` }).catch(() => {}) },
      },
      svg(icons.message),
      "Tell someone you've landed"
    );
  }

  /* ---------------- route card ---------------- */
  const legBlock = (side, m, tz, time, delay, isDep) => {
    const late = delayChip(delay);
    const changed = m.sched && time && Math.abs(Date.parse(time) - Date.parse(m.sched)) >= 60000;
    let note = late ? late.text : "Scheduled";
    let neutral = false;
    if (isDep && phase !== "pre") {
      note = dep.runway ? `Took off ${t12(dep.runway, tz)}` : "Departed";
      neutral = true;
    }
    if (!isDep && phase === "landed") note = late ? `Landed ${late.text.toLowerCase()}` : "Landed";
    const chips = [];
    if (m.gate) chips.push(h("span", { class: "gate-chip" }, svg(icons.gate), m.gate, h("small", { text: "Gate" })));
    if (m.terminal) chips.push(h("span", { class: "chip quiet", text: `Terminal ${m.terminal}` }));
    if (!isDep && m.belt && phase !== "landed") chips.push(h("span", { class: "gate-chip" }, svg(icons.belt), m.belt, h("small", { text: "Belt" })));
    return h(
      "div",
      { class: "leg" },
      h(
        "div",
        {},
        h("p", { class: "leg-place", text: `${m.code}, ${m.name}` }),
        h(
          "p",
          { class: "leg-time" },
          h("span", { "data-k": `${side}-t` }, time ? timeNode(time, tz, { shift: dayShift(time, baseDate, tz) }) : "--:--"),
          changed ? h("s", { text: t12(m.sched, tz) }) : null
        ),
        h("p", { class: `leg-note ${neutral ? "neutral" : late && late.cls === "late" ? "t-late" : "t-early"}`, text: note })
      ),
      h("div", { class: "leg-chips" }, chips)
    );
  };
  const blockMins = depTime && arrTime ? Date.parse(arrTime) - Date.parse(depTime) : null;
  blocks.route = h(
    "section",
    { class: "card" },
    legBlock("dep", dep, depTz, depTime, f.status.delayDep, true),
    h(
      "div",
      { class: "leg-mid" },
      h("span", { class: "tn", text: [blockMins ? duration(blockMins) : null, f.distanceKm ? `${f.distanceKm.toLocaleString("en-IN")} km` : null].filter(Boolean).join(", ") }),
      h("i")
    ),
    legBlock("arr", arr, arrTz, arrTime, f.status.delayArr, false)
  );

  /* ---------------- good to know: icon tiles ---------------- */
  const gtkTitle = h("h2", { class: "section-title display", text: "Good to know" });
  const facts = h("section", { class: "facts", "aria-label": "Good to know" });
  const tile = (icon, tint, label, value, small, wide = false) =>
    wide
      ? h(
          "div",
          { class: "card fact wide" },
          h("span", { class: `fact-icon ${tint}` }, svg(icon)),
          h("div", {}, h("span", { text: label }), h("strong", { text: value }), small ? h("small", { text: small }) : null)
        )
      : h(
          "div",
          { class: "card fact" },
          h("span", { class: `fact-icon ${tint}` }, svg(icon)),
          h("span", { text: label }),
          h("strong", { text: value }),
          small ? h("small", { text: small }) : null
        );

  const fixed = [];
  const body = bodyType(f.aircraft?.model);
  if (body) fixed.push(tile(body.icon, "", body.label, f.aircraft.model, f.aircraft.reg ? `Registration ${f.aircraft.reg}` : null));
  if (phase === "landed" && dep.actual && arr.actual) {
    fixed.push(tile(icons.timer, "", "Time in the air", duration(Date.parse(arr.actual) - Date.parse(dep.actual)), "Runway to runway"));
  } else if (blockMins) {
    fixed.push(tile(icons.timer, "", "Flight time", duration(blockMins), "Gate to gate"));
  }
  if (f.distanceKm) fixed.push(tile(icons.route, "", "Distance", `${f.distanceKm.toLocaleString("en-IN")} km`, "As the crow flies"));
  if (phase === "pre" && dep.checkIn) fixed.push(tile(icons.desk, "lav", "Check-in", `Desks ${dep.checkIn}`, `At ${dep.code}`));
  if (dep.terminal || arr.terminal)
    fixed.push(tile(icons.terminal, "lav", "Terminals", `${dep.terminal ? `T${dep.terminal}` : dep.code} to ${arr.terminal ? `T${arr.terminal}` : arr.code}`, null));

  const wide = [];
  const refTime = new Date(arrTime || now);
  const diff = tzOffset(arrTz, refTime) - tzOffset(depTz, refTime);
  if (diff && arrTime) {
    const hh = Math.floor(Math.abs(diff) / 60);
    const mm = Math.abs(diff) % 60;
    const label = `${diff > 0 ? "+" : "-"}${hh ? `${hh} h` : ""}${hh && mm ? " " : ""}${mm ? `${mm} min` : ""}`;
    wide.push(tile(icons.globe, "lav", "Time change", `${label} in ${arrCity}`, `${t12(arrTime, arrTz)} arrival is ${t12(arrTime, depTz)} ${depCity} time.`, true));
    if (phase === "landed") wide.push(tile(icons.clock, "", "Local time now", `${t12(new Date().toISOString(), arrTz)} in ${arrCity}`, null, true));
  }

  const slots = { arr: null, dep: null, sun: null };
  function paint() {
    const all = [slots.arr, slots.dep, ...fixed].filter(Boolean);
    // an odd tile out stretches across instead of leaving a hole
    all.forEach((el, i) => el.classList.toggle("stretch", all.length % 2 === 1 && i === all.length - 1));
    facts.replaceChildren(...all, ...wide, ...(slots.sun ? [slots.sun] : []));
    gtkTitle.hidden = !facts.childElementCount;
  }
  paint();

  const atLocal = (w, s) => Date.parse(`${s}:00Z`) - (w.offsetSec || 0) * 1000;
  function nearest(w, t) {
    let best = -1;
    let gap = Infinity;
    w.hourly.time.forEach((ts, k) => {
      const g = Math.abs(atLocal(w, ts) - t);
      if (g < gap) {
        gap = g;
        best = k;
      }
    });
    return gap < 90 * 60000 ? best : -1;
  }
  function sunAt(w, t, tz) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t));
    const d = w.daily.date.indexOf(day);
    if (d < 0) return { isDay: true, rise: null, set: null };
    const rise = atLocal(w, w.daily.sunrise[d]);
    const set = atLocal(w, w.daily.sunset[d]);
    return { isDay: t > rise && t < set, rise, set };
  }

  const weather = [];
  if (Number.isFinite(arr.lat)) {
    weather.push({
      lat: arr.lat,
      lon: arr.lon,
      apply: (w) => {
        if (!w?.hourly) return;
        const t = Date.parse(arrTime || new Date().toISOString());
        const sun = sunAt(w, t, arrTz);
        let temp = w.current.temp;
        let code = w.current.code;
        let isDay = w.current.isDay;
        let when = "Right now";
        if (phase !== "landed") {
          const k = nearest(w, t);
          if (k >= 0) {
            temp = w.hourly.temp[k];
            code = w.hourly.code[k];
            isDay = sun.isDay;
            when = "At landing";
          }
          if (sun.set && t > sun.set)
            slots.sun = tile(icons.sunset, "warm", "Landing after dark", `Sunset in ${arrCity} is ${t12(new Date(sun.set).toISOString(), arrTz)}`, null, true);
          else if (sun.rise && t < sun.rise)
            slots.sun = tile(icons.sunset, "warm", "Landing before sunrise", `Sunrise in ${arrCity} is ${t12(new Date(sun.rise).toISOString(), arrTz)}`, null, true);
        }
        if (temp == null) return;
        const look = weatherLook(code, isDay);
        slots.arr = tile(look.icon, "", `Weather in ${arrCity}`, `${Math.round(temp)}°C`, `${cap(look.label)}. ${when}`);
        paint();
      },
    });
  }
  if (phase === "pre" && Number.isFinite(dep.lat)) {
    weather.push({
      lat: dep.lat,
      lon: dep.lon,
      apply: (w) => {
        if (!w?.hourly) return;
        const t = Date.parse(depTime);
        const k = nearest(w, t);
        const temp = k >= 0 ? w.hourly.temp[k] : w.current.temp;
        const code = k >= 0 ? w.hourly.code[k] : w.current.code;
        if (temp == null) return;
        const look = weatherLook(code, sunAt(w, t, depTz).isDay);
        slots.dep = tile(look.icon, "", `Weather in ${depCity}`, `${Math.round(temp)}°C`, `${cap(look.label)}. At take-off`);
        paint();
      },
    });
  }

  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer", text });
  const credit = h(
    "p",
    { class: "data-credit" },
    "Flight data by ",
    link("https://aerodatabox.com", "AeroDataBox"),
    ". Live positions from ",
    link("https://adsb.lol", "adsb.lol"),
    " and ",
    link("https://adsb.fi", "adsb.fi"),
    "."
  );

  /* ---------------- order by phase ---------------- */
  const order =
    {
      pre: ["head", "banner", "route", "map"],
      air: ["head", "map", "stats", "banner", "route"],
      landed: ["head", "banner", "belt", "share", "route", "map"],
      cancelled: ["head", "banner", "route", "map"],
      diverted: ["head", "banner", "map", "route"],
    }[phase] || ["head", "banner", "route", "map"];

  // Shown when the budget kept us from a fresh lookup: honest about how old this is.
  if (f.status.servedStale) {
    const when = f.status.checkedAt ? ago(f.status.checkedAt) : "a while ago";
    blocks.head = [
      blocks.head,
      h("div", { class: "banner info", role: "note" }, svg(icons.info), h("span", { text: `Showing the update from ${when}. ${f.status.note || "Live data is catching up."}` })),
    ];
  }
  const node = h("div", { class: "status-body" }, order.map((k) => blocks[k]).filter(Boolean), gtkTitle, facts, credit);

  const shareTone = ["bad", "warn", "good"].find((c) => banner.classList.contains(c)) || "tone";
  const shareTiles = [];
  // tiles add something the big number above them doesn't already say
  if (phase === "pre") {
    if (dep.gate) shareTiles.push({ label: "Gate", value: dep.gate });
    if (dep.terminal) shareTiles.push({ label: "Terminal", value: dep.terminal });
    if (dep.checkIn) shareTiles.push({ label: "Check-in", value: dep.checkIn });
    if (!shareTiles.length && blockMins) shareTiles.push({ label: "Flight time", value: duration(blockMins) });
  } else if (phase === "air") {
    if (reported && f.position.altFt) shareTiles.push({ label: "Altitude", value: `${Math.round(f.position.altFt / 1000)}k ft` });
    if (reported && f.position.speedKmh) shareTiles.push({ label: "Speed", value: `${f.position.speedKmh} km/h` });
    if (f.distanceKm) shareTiles.push({ label: "To go", value: `${Math.round(f.distanceKm * (1 - fraction)).toLocaleString("en-IN")} km` });
  } else if (phase === "landed") {
    if (arr.belt) shareTiles.push({ label: "Belt", value: arr.belt });
    if (arr.terminal) shareTiles.push({ label: "Terminal", value: arr.terminal });
    if (dep.actual && arr.actual) shareTiles.push({ label: "In the air", value: duration(Date.parse(arr.actual) - Date.parse(dep.actual)) });
  }
  const share = {
    mode: "flight",
    kicker: f.number,
    subtitle: `${f.airline.name}, ${dayLabel(dep.sched, depTz)}`,
    from: dep.code,
    to: arr.code,
    fromCity: depCity,
    toCity: arrCity,
    fraction,
    tone: shareTone,
    lead: banner.querySelector(".lead")?.textContent,
    big: banner.querySelector(".big")?.textContent,
    sub: banner.querySelector(".sub")?.textContent,
    tiles: shareTiles,
    updated: `Updated ${t12(new Date().toISOString(), depTz)}`,
    text:
      phase === "landed"
        ? `${f.number} landed in ${arrCity} at ${t12(arrTime, arrTz)}. Live:`
        : phase === "air"
          ? `${f.number} lands in ${arrCity} at ${t12(arrTime, arrTz)}. Live:`
          : `${f.number} from ${depCity} to ${arrCity}. Live:`,
  };
  // The island: what matters for this phase in one or two lines, growing only when there's more to say.
  const now2 = Date.now();
  const timeAt = (iso, tz, soft = false) => ({ time: iso, tz, shift: dayShift(iso, baseDate, tz), soft });
  let island;
  const route = `${f.number} · ${dep.code} → ${arr.code}`;
  if (phase === "pre") {
    const until = Date.parse(depTime) - now2;
    const d = f.status.delayDep;
    const boarding = /Boarding/.test(f.status.raw);
    const chip = boarding ? { cls: "accent", text: "Boarding" } : /GateClosed/.test(f.status.raw) ? { cls: "late", text: "Gate closed" } : d != null && d >= 5 ? { cls: "late", text: `Late ${fmtMin(d)}` } : d != null ? { cls: "ok", text: "On time" } : null;
    island = {
      top: route,
      main: until > 0 ? [{ text: "Departs in " }, { strong: countdown(until) }] : [{ text: "Departs " }, timeAt(depTime, depTz)],
      chip,
      detail: [dep.gate ? `Gate ${dep.gate}` : null, dep.terminal ? `Terminal ${dep.terminal}` : null, dep.checkIn && !dep.gate ? `Check-in ${dep.checkIn}` : null].filter(Boolean),
      progress: null,
    };
  } else if (phase === "air") {
    const left = Math.max(0, Date.parse(arrTime) - now2);
    const d = f.status.delayArr;
    island = {
      top: route,
      main: [{ text: "Lands in " }, { strong: duration(left) }, { soft: " · " }, timeAt(arrTime, arrTz, true)],
      chip: d != null && d >= 5 ? { cls: "late", text: `Late ${fmtMin(d)}` } : d != null ? { cls: "ok", text: "On time" } : null,
      detail: [
        reported && f.position.altFt ? `${Math.round(f.position.altFt).toLocaleString("en-IN")} ft` : null,
        reported && f.position.speedKmh ? `${f.position.speedKmh} km/h` : null,
        f.distanceKm ? `${Math.round(f.distanceKm * (1 - fraction)).toLocaleString("en-IN")} km to go` : null,
      ].filter(Boolean),
      progress: fraction,
    };
  } else if (phase === "landed") {
    island = {
      top: route,
      main: [{ text: "Landed " }, timeAt(arrTime, arrTz)],
      chip: { cls: "ok", text: "Landed" },
      detail: [arr.belt ? `Belt ${arr.belt}` : null, arr.terminal ? `Terminal ${arr.terminal}` : null].filter(Boolean),
      progress: 1,
    };
  } else {
    island = { top: route, main: [{ text: phase === "cancelled" ? "Cancelled" : "Diverted" }], chip: { cls: "bad", text: phase === "cancelled" ? "Cancelled" : "Diverted" }, detail: [], progress: null };
  }
  island.mode = "flight";
  const mainText = island.main.map((x) => (x.time ? clock(x.time, x.tz) : x.text ?? x.strong ?? x.soft ?? "")).join("");
  island.spoken = `Flight ${f.number} from ${depCity} to ${arrCity}. ${mainText}.${island.chip ? ` ${island.chip.text}.` : ""} ${island.detail.join(". ")}`;
  if (island.chip && mainText === island.chip.text) island.chip = null;
  island.updatedAt = f.status.checkedAt || f.status.lastUpdated || new Date().toISOString();

  return { node, map, currentRow: null, weather, share, island, anchor: blocks.banner };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
