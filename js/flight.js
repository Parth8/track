import { h, svg, clock, dayLabel, dateKey, duration, ago, delayChip, fmtMin, tzOffset, greatCircle, bearing, timeNode, dayShift } from "./util.js";
import { icons, weatherLook, bodyType } from "./icons.js";
import { endBadge, tripFacts, signal } from "./marks.js";
import { historySummary, turnaround, inboundAtGate, ON_TIME_MIN } from "./flight-insights.js";

/**
 * Flight status screen. The order changes with the phase:
 * before takeoff the departure leads, in the air the map leads, after landing the belt leads.
 */
/** "2h 05m" for today; "2d 13h" when departure is more than a day away. */
const countdown = (ms) => (ms >= 86400000 ? `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h` : duration(ms));

// Which sections someone opened or closed, kept across refreshes.
const openState = {};

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
  // In the air, the landing time comes from the plane's live speed and distance left (free and fresh).
  const arrTime = (phase === "landed" && (arr.actual || arr.revised)) || (phase === "air" && arr.liveEta) || arr.revised || arr.sched;
  const takeoff = dep.actual || depTime;
  const now = Date.now();
  const reported = !!(f.position && Number.isFinite(f.position.lat));
  const live = reported && f.position.source === "live";
  // Has anyone (airline, airport) said anything about this flight? Older data without the flag counts as yes.
  const reported0 = f.status.reported !== false;
  const turn = turnaround(f, now);
  const ib = f.inbound;
  const tight =
    turn?.verdict === "late"
      ? `Your plane is still on its way from ${ib.from.city || ib.from.code}, so expect ${t12(turn.earliest, depTz)} or later`
      : turn?.verdict === "tight"
        ? `Your plane reaches the gate ${t12(turn.gate.at, depTz)}, a tight turnaround`
        : null;

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
      // The plane flying in, live, with a faint line to your airport
      const ip = f.inbound?.position;
      if (ip && Number.isFinite(ip.lat) && f.inbound.phase === "air") {
        opts.inbound = { position: [ip.lon, ip.lat], trackDeg: ip.trackDeg, line: greatCircle([ip.lon, ip.lat], [dep.lon, dep.lat], 32) };
        badge = { text: "Your plane, flying in", cls: "" };
        note = `${f.inbound.number || "The inbound flight"} on its way to ${dep.code}. It flies your route once it has turned round.`;
      }
    } else if (phase === "air") {
      // The path it has really flown, then the great circle on from where it is
      const flown = (f.track || []).map((p) => [p[0], p[1]]);
      if (flown.length > 1) {
        const here = reported ? [f.position.lon, f.position.lat] : flown.at(-1);
        opts.done = [...flown, here];
        opts.ahead = greatCircle(here, [arr.lon, arr.lat], 48);
      }
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
      const flown = (f.track || []).map((p) => [p[0], p[1]]);
      if (flown.length > 1) {
        opts.done = flown;
        opts.ahead = [flown.at(-1), flown.at(-1)];
        note = "The path it really flew.";
      }
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

  /* ---------------- the flight board: status, both ends, the tiles ---------------- */
  // Live countdowns tick on their own between refreshes.
  const ticks = [];
  const tickText = (target, fmt) => {
    const el = h("span", { class: "tn" }, fmt(Date.parse(target) - Date.now()));
    ticks.push({ el, target, fmt });
    return el;
  };

  /* ---------------- phase banner ---------------- */
  const banner = h("section", { class: "phase-banner", "aria-live": "polite" });
  const tone = (d) => banner.classList.add(d == null ? "tone" : d >= 15 ? "warn" : d <= 5 ? "good" : "tone");
  const lead = (t) => h("p", { class: "lead", text: t });
  const big = (t) => h("p", { class: "big", "data-k": "banner" }, t);
  const sub = (t) => h("p", { class: "sub", text: t });
  let target = null; // a section the banner can open, when its last line is about it
  const ibFrom = ib ? ib.from.city || ib.from.code : "";
  const ibWhere = ib ? (ib.landed ? `has landed in ${dep.code}` : ib.phase === "air" ? `is in the air from ${ibFrom}` : `hasn't left ${ibFrom} yet`) : "";

  if (phase === "cancelled") {
    banner.classList.add("bad");
    banner.append(lead("Flight status"), big("Cancelled"), sub(`Check with ${f.airline.name} about rebooking or a refund.`));
  } else if (phase === "diverted") {
    banner.classList.add("warn");
    banner.append(lead("Flight status"), big("Diverted"), sub(`${f.airline.name} will share the new plan. We'll keep checking.`));
  } else if (phase === "pre") {
    const d = f.status.delayDep;
    tone(d);
    if (turn?.verdict === "late") banner.classList.replace("good", "warn") || banner.classList.replace("tone", "warn");
    const until = Date.parse(depTime) - now;
    const dc = delayChip(d);
    const statusWord = f.status.leftGate ? "Left the gate" : /Boarding/.test(f.status.raw) ? "Boarding now" : /GateClosed/.test(f.status.raw) ? "Gate closed" : null;
    // No report from anyone isn't "on time": say it's the schedule.
    const timing = !reported0
      ? `No live update yet. Scheduled ${t12(depTime, depTz)}`
      : dc && dc.cls === "late"
        ? `Delayed ${fmtMin(d)}, now ${t12(depTime, depTz)}`
        : d != null && d <= -5
          ? `Early, now ${t12(depTime, depTz)}`
          : `On time at ${t12(depTime, depTz)}`;
    banner.append(
      lead(until > 0 ? "Departs in" : "Departure"),
      big(until > 0 ? tickText(depTime, (ms) => countdown(Math.max(0, ms))) : timeNode(depTime, depTz, { shift: dayShift(depTime, baseDate, depTz) })),
      sub([statusWord, timing].filter(Boolean).join(". "))
    );
    // The one thing that most affects this departure, in a sentence
    const at = t12(depTime, depTz);
    let context = null;
    if (turn?.verdict === "late") context = `Your plane ${ibWhere}, so expect ${t12(turn.earliest, depTz)} or later.`;
    else if (turn?.verdict === "tight") context = `Your plane ${ibWhere} and reaches the gate ${t12(turn.gate.at, depTz)}, a tight turnaround.`;
    else if (turn?.verdict === "here") context = `Your plane is already here.`;
    else if (turn) context = `Your plane ${ibWhere}, with enough time for ${at}.`;
    if (context) {
      target = "inbound";
      banner.append(sub(context));
    }
    const ad = dep.delays;
    if (ad && ad.minutes >= 15) banner.append(sub(`Delays at ${dep.code}: about ${fmtMin(ad.minutes)}${ad.reasons[0] ? `, ${ad.reasons[0].toLowerCase()}` : ""}.`));
  } else if (phase === "air") {
    const d = f.status.delayArr;
    tone(d);
    const dc = delayChip(d);
    banner.append(
      lead("Lands in"),
      big(tickText(arrTime, (ms) => duration(Math.max(0, ms)))),
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
    if (arr.delays?.minutes >= 15) banner.append(sub(`Delays at ${arr.code}: about ${fmtMin(arr.delays.minutes)}, so it may wait for a gate.`));
  } else {
    const d = f.status.delayArr;
    tone(d);
    const dc = delayChip(d);
    banner.append(lead(`Landed in ${arrCity}`), big(timeNode(arrTime, arrTz, { shift: dayShift(arrTime, baseDate, arrTz) })), sub(`${dc ? dc.text : "On time"}, ${ago(arrTime)}.`));
  }
  if (target) {
    banner.classList.add("go");
    banner.setAttribute("role", "button");
    banner.setAttribute("aria-label", `${banner.textContent}. Opens where's your plane.`);
    banner.tabIndex = 0;
    banner.append(h("i", { class: "pb-go", "aria-hidden": "true" }));
    const open = () => {
      const sec = blocks[target];
      if (!sec) return;
      sec.open = true;
      sec.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    };
    banner.addEventListener("click", open);
    banner.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
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
  // A detail not announced yet can be tapped: it says when it usually appears.
  const tip = h("p", { class: "leg-tip", hidden: true, role: "status" });
  const later = (label, explain) =>
    h(
      "button",
      {
        type: "button",
        class: "signal dim leg-later",
        "aria-label": `${label}: not announced yet`,
        on: {
          click: () => {
            const same = !tip.hidden && tip.textContent === explain;
            tip.hidden = same;
            tip.textContent = explain;
          },
        },
      },
      h("strong", { text: "--" }),
      h("small", { text: label })
    );
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
    // A model's guess at the arrival, kept apart from anything the airline said
    if (!late && phase === "pre") neutral = true; // "Scheduled" isn't good news, just the plan
    if (!isDep && !late && m.predicted && phase === "pre") note = `Scheduled. A model estimates ${t12(m.predicted, tz)}`;
    if (isDep && !reported0 && phase === "pre") note = "Scheduled, no update yet";
    // How long until, ticking
    const inText =
      (isDep && phase === "pre") || (!isDep && (phase === "pre" || phase === "air"))
        ? Date.parse(time) > now
          ? h("span", { class: "leg-in" }, ` · ${isDep ? "Departs" : "Arrives"} in `, tickText(time, (ms) => duration(Math.max(0, ms))))
          : null
        : null;
    // The time itself in colour once someone has reported on it
    const known = reported0 && delay != null;
    const tcls = !known ? "" : late?.cls === "late" ? "t-late" : "t-early";
    const chips = [];
    if (m.gate) chips.push(h("span", { class: "gate-chip" }, svg(icons.gate), m.gate, h("small", { text: "Gate" })));
    else if (isDep && phase === "pre") chips.push(later("Gate", `The gate isn't announced yet. It shows here as soon as ${f.airline.name} posts it.`));
    if (m.terminal) chips.push(h("span", { class: "chip quiet", text: `Terminal ${m.terminal}` }));
    if (!isDep && m.belt && phase !== "landed") chips.push(h("span", { class: "gate-chip" }, svg(icons.belt), m.belt, h("small", { text: "Belt" })));
    else if (!isDep && !m.belt && phase !== "landed" && phase !== "cancelled") chips.push(later("Belt", "The baggage belt isn't announced yet. Airports post it around landing."));
    return h(
      "div",
      { class: "leg" },
      h(
        "div",
        {},
        h("p", { class: "leg-place" }, endBadge(isDep ? "leave" : "arrive"), `${m.code}, ${m.name}`),
        h(
          "p",
          { class: "leg-time" },
          h("span", { class: tcls, "data-k": `${side}-t` }, time ? timeNode(time, tz, { shift: dayShift(time, baseDate, tz) }) : "--:--"),
          changed ? h("s", { text: t12(m.sched, tz) }) : null
        ),
        h("p", { class: `leg-note ${neutral ? "neutral" : late && late.cls === "late" ? "t-late" : "t-early"}` }, note, inText)
      ),
      h("div", { class: "leg-chips" }, chips)
    );
  };
  const blockMins = depTime && arrTime ? Date.parse(arrTime) - Date.parse(depTime) : null;
  const overnight = arrTime && dateKey(arrTime, arrTz) !== baseDate;
  blocks.route = h(
    "section",
    { class: "card" },
    legBlock("dep", dep, depTz, depTime, f.status.delayDep, true),
    h(
      "div",
      { class: "leg-mid" },
      tripFacts({ ms: blockMins, km: f.distanceKm, overnight }),
      h("i")
    ),
    legBlock("arr", arr, arrTz, arrTime, f.status.delayArr, false),
    tip
  );

  /* ---------------- yours: booking code and seat, on this device only ---------------- */
  blocks.mine = mineCard(f);


  /** A section that folds, with what it would say shown on the closed line. */
  const fold = (key, title, preview, body, open = false) => {
    const d = h("details", { class: "card fsec", open: (openState[key] ?? open) || null, on: { toggle: () => (openState[key] = d.open) } }, h("summary", {}, h("span", { class: "fsec-title", text: title }), preview ? h("span", { class: "fsec-preview", text: preview }) : null, h("i", { class: "fsec-chev", "aria-hidden": "true" })), body);
    return d;
  };

  /* ---------------- height profile: climb, cruise, descent, from the flown path ---------------- */
  function profile() {
    const pts = (f.track || []).filter((p) => Number.isFinite(p[2]) && p[4]);
    if (pts.length < 5 || (phase !== "air" && phase !== "landed")) return null;
    const t0 = Date.parse(pts[0][4]);
    const t1 = phase === "air" ? Math.max(Date.parse(pts.at(-1)[4]), Date.parse(arrTime) || 0) : Date.parse(pts.at(-1)[4]);
    const top = Math.max(...pts.map((p) => p[2]), 10000);
    const W = 300;
    const H = 72;
    const x = (iso) => ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * W;
    const y = (ft) => H - 4 - (ft / top) * (H - 12);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[4]).toFixed(1)} ${y(p[2]).toFixed(1)}`).join(" ");
    const last = pts.at(-1);
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const chart = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "prof-svg", preserveAspectRatio: "none", "aria-hidden": "true" });
    chart.append(
      el("path", { d: `${line} L${x(last[4]).toFixed(1)} ${H} L0 ${H} Z`, class: "prof-area" }),
      el("path", { d: line, class: "prof-line" }),
      el("line", { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: "prof-base" })
    );
    const cursor = el("line", { x1: 0, x2: 0, y1: 0, y2: H, class: "prof-cursor" });
    chart.append(cursor);
    // An HTML dot, so it stays round however wide the chart is drawn
    const dot = h("i", { class: "prof-dot" });
    const place = (p) => {
      dot.style.left = `${(x(p[4]) / W) * 100}%`;
      dot.style.top = `${(y(p[2]) / H) * 100}%`;
    };
    place(last);
    const fmt = (p) => [t12(p[4], depTz), `${Math.round(p[2]).toLocaleString("en-IN")} ft`, p[3] ? `${p[3].toLocaleString("en-IN")} km/h` : null].filter(Boolean).join(" · ");
    const read = h("p", { class: "prof-read tn", text: phase === "air" ? `Now ${fmt(last)}` : `Cruised at ${Math.round(top).toLocaleString("en-IN")} ft` });
    const box = h("div", { class: "prof", role: "img", "aria-label": `Height through the flight, up to ${Math.round(top).toLocaleString("en-IN")} feet` }, h("div", { class: "prof-plot" }, chart, dot), read);
    const show = (clientX) => {
      const r = chart.getBoundingClientRect();
      const t = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(Date.parse(p[4]) - t) < Math.abs(Date.parse(best[4]) - t)) best = p;
      cursor.setAttribute("x1", x(best[4]));
      cursor.setAttribute("x2", x(best[4]));
      cursor.classList.add("on");
      place(best);
      read.textContent = fmt(best);
    };
    box.addEventListener("pointermove", (e) => show(e.clientX));
    box.addEventListener("pointerdown", (e) => show(e.clientX));
    box.addEventListener("pointerleave", () => {
      cursor.classList.remove("on");
      place(last);
      read.textContent = phase === "air" ? `Now ${fmt(last)}` : `Cruised at ${Math.round(top).toLocaleString("en-IN")} ft`;
    });
    return h("div", {}, h("p", { class: "fsec-sub", text: phase === "air" ? "Height so far" : "Climb, cruise and descent" }), box);
  }

  /* ---------------- gate to gate: the four times ---------------- */
  if (f.times) {
    const rows = [
      ["out", "Leaves the gate", dep, depTz],
      ["off", "Takes off", dep, depTz],
      ["on", "Lands", arr, arrTz],
      ["in", "At the gate", arr, arrTz],
    ];
    const list = h("ol", { class: "g2g" });
    for (const [k, label, , tz] of rows) {
      const t = f.times[k] || {};
      const shown = t.actual || t.est || t.sched;
      if (!shown) continue;
      const kind = t.actual ? "done" : t.est ? "est" : "sched";
      const moved = t.sched && Math.abs(Date.parse(shown) - Date.parse(t.sched)) >= 60000;
      const delta = t.sched ? Math.round((Date.parse(shown) - Date.parse(t.sched)) / 60000) : 0;
      list.append(
        h(
          "li",
          { class: `g2g-row ${kind}` },
          h("i", { "aria-hidden": "true" }),
          h("span", { class: "g2g-label", text: label }),
          h(
            "span",
            { class: "g2g-time tn" },
            timeNode(shown, tz, { shift: dayShift(shown, baseDate, tz) }),
            moved ? h("s", { text: t12(t.sched, tz) }) : null
          ),
          h("small", { class: `g2g-kind ${moved && delta > 0 ? "t-late" : moved ? "t-early" : ""}`, text: t.actual ? "Actual" : t.est ? (moved ? `${fmtMin(delta)} ${delta > 0 ? "late" : "early"}` : "Expected") : "Scheduled" })
        )
      );
    }
    const taxiOut = f.times.out?.actual && f.times.off?.actual ? Date.parse(f.times.off.actual) - Date.parse(f.times.out.actual) : null;
    const taxiIn = f.times.on?.actual && f.times.in?.actual ? Date.parse(f.times.in.actual) - Date.parse(f.times.on.actual) : null;
    const air = (f.times.off?.actual || f.times.off?.est) && (f.times.on?.actual || f.times.on?.est) ? Date.parse(f.times.on.actual || f.times.on.est) - Date.parse(f.times.off.actual || f.times.off.est) : null;
    const notes = [air ? `${duration(air)} in the air` : null, taxiOut ? `${duration(taxiOut)} taxiing out` : null, taxiIn ? `${duration(taxiIn)} taxiing in` : null].filter(Boolean);
    const offT = f.times.off?.actual || f.times.off?.est || f.times.off?.sched;
    const onT = f.times.on?.actual || f.times.on?.est || f.times.on?.sched;
    const preview = offT && onT ? `${f.times.off?.actual ? "Took off" : "Takes off"} ${t12(offT, depTz)} · ${f.times.on?.actual ? "landed" : "lands"} ${t12(onT, arrTz)}` : null;
    if (list.childElementCount) blocks.times = fold("times", "Gate to gate", preview, [list, notes.length ? h("p", { class: "g2g-note tn", text: notes.join(" · ") }) : null, phase === "landed" ? profile() : null]);
  }
  if (phase === "air") {
    const pf = profile();
    if (pf) blocks.profile = h("section", { class: "card prof-card" }, pf);
  }

  /* ---------------- where's your plane: the flight flying in ---------------- */
  if (ib && phase === "pre") {
    const from = ib.from.city || ib.from.code;
    const gate = inboundAtGate(ib);
    let now1 = "";
    if (ib.phase === "cancelled") now1 = "That flight is cancelled; the airline will bring another plane.";
    else if (ib.phase === "diverted") now1 = "That flight has diverted; the airline will bring another plane.";
    else if (ib.landed) now1 = gate?.how === "actual" ? `At the gate in ${dep.code} since ${t12(gate.at, depTz)}.` : `Landed in ${dep.code}, taxiing to the gate.`;
    else if (ib.phase === "air") {
      const lands = ib.liveEta || ib.times.on.est || ib.times.on.sched;
      now1 = `In the air from ${from}. Lands ${t12(lands, depTz)}${ib.liveEta ? " going by its live speed" : ""}.`;
    } else {
      const out = ib.times.out.est || ib.times.out.sched;
      now1 = `Still in ${from}. Due to leave ${t12(out, depTz)}${ib.delayDep >= 5 ? `, ${fmtMin(ib.delayDep)} late` : ""}.`;
    }
    const verdicts = {
      here: ["ok", "Your plane is here"],
      ok: ["ok", `Enough time to turn round: ${turn?.gapMin} min`],
      tight: ["warn", `Tight: ${turn?.gapMin} min to turn round, about ${turn?.minTurn} is the quickest`],
      late: ["late", turn?.earliest ? `Your departure can't be before about ${t12(turn.earliest, depTz)}` : ""],
    };
    const [cls, verdict] = turn ? verdicts[turn.verdict] : ["", ""];
    const pct = ib.landed ? 100 : Number.isFinite(ib.progress) ? ib.progress : ib.phase === "air" ? 50 : 0;
    const bar = h("div", { class: "ib-track", "aria-hidden": "true" }, h("span", { class: "ib-end", text: ib.from.code }), h("div", { class: "ib-line" }, h("i"), h("b", {}, svg(icons.plane))), h("span", { class: "ib-end", text: dep.code }));
    bar.querySelector(".ib-line i").style.width = `${pct}%`;
    bar.querySelector(".ib-line b").style.left = `${pct}%`;
    // Its own earlier leg, when the plane hasn't even left yet
    const pv = ib.prev;
    const prevLine =
      pv && pv.phase !== "landed"
        ? `Before that, it flies ${pv.number || "another flight"} from ${pv.from.city || pv.from.code}, ${pv.phase === "air" ? `landing ${t12(pv.times.in.est || pv.times.in.sched, depTz)}` : `due to leave ${t12(pv.times.out.est || pv.times.out.sched, depTz)}`}${pv.delayDep >= 5 ? `, ${fmtMin(pv.delayDep)} late` : ""}.`
        : null;
    const ibNo = (ib.number || "").replace(/\s+/g, "");
    const ibDate = ib.times.out.sched ? dateKey(ib.times.out.sched, depTz) : baseDate;
    const chain = h(
      "ol",
      { class: "ib-chain", "aria-label": "The plane's day" },
      pv ? h("li", { class: pv.phase }, h("b", { text: pv.from.code }), h("small", { text: pv.number || "" })) : null,
      h("li", { class: ib.phase }, h("b", { text: ib.from.code }), h("small", { text: ib.number || "" })),
      h("li", { class: "you" }, h("b", { text: dep.code }), h("small", { text: f.number })),
      h("li", { class: "you" }, h("b", { text: arr.code }), h("small", { text: "You land" }))
    );
    const body = [
      h("p", { class: "ib-lead" }, h("strong", { text: ib.number || "The inbound flight" }), ` from ${from} brings the plane for this flight.`),
      bar,
      h("p", { class: "ib-now", text: now1 }),
      gate && !ib.landed ? h("p", { class: "ib-gate tn", text: `At the gate about ${t12(gate.at, depTz)}${gate.how === "schedule" ? " (schedule)" : ""}` }) : null,
      verdict ? h("p", { class: `ib-verdict ${cls}`, text: verdict }) : null,
      prevLine ? h("p", { class: "ib-now ib-prev", text: prevLine }) : null,
      h("p", { class: "fsec-sub", text: "The plane's day" }),
      chain,
      /^[A-Z0-9]{2}\d+$/.test(ibNo) ? h("a", { class: "link-quiet ib-open", href: `?m=flight&no=${ibNo}&d=${ibDate}`, text: `Track ${ib.number} →` }) : null,
    ];
    blocks.inbound = fold("inbound", "Where's your plane", verdict || now1, body, true);
    blocks.inbound.classList.add("inbound-card");
  }

  /* ---------------- the last two weeks of this flight ---------------- */
  const hist = historySummary(f.history);
  if (hist && phase !== "air") {
    const max = Math.max(30, ...hist.bars.map((b) => Math.abs(b.delay ?? 0)));
    const strip = h("div", { class: "hist-strip", role: "img", "aria-label": `Departure delay over the last ${hist.days} days. ${hist.text.join(". ")}.` });
    const said = h("p", { class: "hist-said tn", role: "status", text: "Tap a day to see it." });
    for (const b of hist.bars) {
      const late = b.delay != null && b.delay > ON_TIME_MIN;
      const label = b.cancelled ? `${dayLabel(`${b.date}T12:00:00Z`, depTz)}: cancelled` : `${dayLabel(`${b.date}T12:00:00Z`, depTz)}: ${b.delay > 0 ? `${b.delay} min late` : b.delay < 0 ? `${-b.delay} min early` : "on time"}`;
      const col = h(
        "button",
        {
          type: "button",
          class: `hist-col${b.cancelled ? " x" : late ? " late" : b.delay > 0 ? " slow" : " early"}`,
          title: label,
          "aria-label": label,
          on: {
            click: (e) => {
              strip.querySelectorAll(".hist-col.on").forEach((x) => x.classList.remove("on"));
              e.currentTarget.classList.add("on");
              const row = f.history.find((r) => r.date === b.date);
              const left = row?.out ? `left ${t12(row.out.actual, depTz)}` : null;
              const got = row?.in ? `in ${t12(row.in.actual, arrTz)}` : null;
              said.textContent = [label, left, got].filter(Boolean).join(" · ");
            },
          },
        },
        h("i")
      );
      const hgt = b.cancelled ? 100 : Math.max(4, (Math.abs(b.delay) / max) * 100);
      col.querySelector("i").style.height = `${hgt / 2}%`;
      col.classList.add(b.delay > 0 || b.cancelled ? "up" : "down");
      strip.append(col);
    }
    blocks.history = fold("history", "Recent days", hist.text[0], [
      h("p", { class: "hist-lead", text: hist.text[0] }),
      h("p", { class: "hist-sub", text: hist.text.slice(1).join(" · ") }),
      strip,
      h("div", { class: "hist-axis" }, h("span", { text: hist.bars[0] ? dayLabel(`${hist.bars[0].date}T12:00:00Z`, depTz) : "Earlier" }), h("span", { text: "Up: late · down: early" }), h("span", { text: hist.bars.at(-1) ? dayLabel(`${hist.bars.at(-1).date}T12:00:00Z`, depTz) : "" })),
      said,
    ]);
    blocks.history.classList.add("hist-card");
  }

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
  if (body) fixed.push(tile(body.icon, "", body.label, f.aircraft.model, f.aircraft.reg ? `Registration ${f.aircraft.reg}` : f.aircraft.code ? `Type ${f.aircraft.code}` : null));
  if (f.plan?.eteMin && !(phase === "landed" && dep.actual && arr.actual))
    fixed.push(tile(icons.plane, "", "Planned air time", duration(f.plan.eteMin * 60000), [f.plan.speedKmh ? `Cruise ${f.plan.speedKmh.toLocaleString("en-IN")} km/h` : null, f.plan.altitudeFt ? `${f.plan.altitudeFt.toLocaleString("en-IN")} ft` : null].filter(Boolean).join(", ") || null));
  const seats = f.seats && [f.seats.first ? `${f.seats.first} first` : null, f.seats.business ? `${f.seats.business} business` : null, f.seats.economy ? `${f.seats.economy} economy` : null].filter(Boolean);
  if (seats?.length) fixed.push(tile(icons.seat || icons.desk, "lav", "Seats", seats.join(", "), null));
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
  for (const [m, when] of [[dep, "departures"], [arr, "arrivals"]]) {
    if (m.delays && (phase === "pre" || (phase === "air" && m === arr)))
      wide.unshift(tile(icons.clock, "warm", `Delays at ${m.code}`, m.delays.minutes ? `About ${fmtMin(m.delays.minutes)} on ${when}` : `Some ${when} delayed`, m.delays.reasons.join(". ") || null, true));
  }
  if (f.codeshares?.length) wide.push(tile(icons.route, "lav", "Also sold as", f.codeshares.join(", "), "The same plane under partner airlines' numbers", true));
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
    f.status.source === "flightaware" ? link("https://www.flightaware.com", "FlightAware") : link("https://aerodatabox.com", "AeroDataBox"),
    ". Live positions from ",
    link("https://adsb.lol", "adsb.lol"),
    " and ",
    link("https://adsb.fi", "adsb.fi"),
    "."
  );

  /* ---------------- order by phase ---------------- */
  const order =
    {
      pre: ["head", "banner", "inbound", "route", "mine", "times", "map", "history"],
      air: ["head", "map", "stats", "profile", "banner", "route", "mine", "times"],
      landed: ["head", "banner", "belt", "share", "route", "mine", "times", "map", "history"],
      cancelled: ["head", "banner", "route", "times", "map"],
      diverted: ["head", "banner", "map", "route", "times"],
    }[phase] || ["head", "banner", "route", "times", "map"];

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
      detail: [
        dep.gate ? `Gate ${dep.gate}` : null,
        dep.terminal ? `Terminal ${dep.terminal}` : null,
        dep.checkIn && !dep.gate ? `Check-in ${dep.checkIn}` : null,
        turn?.verdict === "late" ? `Plane still coming, ${clock(turn.earliest, depTz)} at the earliest` : turn?.verdict === "tight" ? "Tight turnaround" : null,
        !reported0 ? "No live update yet" : null,
      ].filter(Boolean),
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
  island.live = phase === "air";
  const mainText = island.main.map((x) => (x.time ? clock(x.time, x.tz) : x.text ?? x.strong ?? x.soft ?? "")).join("");
  island.spoken = `Flight ${f.number} from ${depCity} to ${arrCity}. ${mainText}.${island.chip ? ` ${island.chip.text}.` : ""} ${island.detail.join(". ")}`;
  if (island.chip && mainText === island.chip.text) island.chip = null;
  island.updatedAt = f.status.checkedAt || f.status.lastUpdated || new Date().toISOString();

  // Countdowns tick every 20 s until the next refresh replaces this screen.
  if (ticks.length) {
    let seen = false;
    const timer = setInterval(() => {
      if (!node.isConnected) {
        if (seen) clearInterval(timer);
        return;
      }
      seen = true;
      for (const t of ticks) t.el.textContent = t.fmt(Date.parse(t.target) - Date.now());
    }, 20000);
  }
  return { node, map, currentRow: null, weather, share, island, anchor: blocks.banner };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ---------- your booking code and seat for a flight, kept on this device only ---------- */
const MINE_KEY = "flightMine";
function mineAll() {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
export function flightMine(f) {
  return mineAll()[`${f.number.replace(/\s+/g, "")}/${f.date}`] || {};
}
function saveMine(f, patch) {
  const all = mineAll();
  const k = `${f.number.replace(/\s+/g, "")}/${f.date}`;
  all[k] = { ...(all[k] || {}), ...patch };
  if (!all[k].code && !all[k].seat) delete all[k];
  // Keep it small: drop entries for flights more than a month old
  const cutoff = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(all)) if (key.split("/")[1] < cutoff) delete all[key];
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: it just isn't kept */
  }
}

const CLEAN = { code: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8), seat: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) };
const VALID = { code: (v) => /^[A-Z0-9]{5,8}$/.test(v), seat: (v) => /^\d{1,2}[A-K]$/.test(v) };

/** Two light, icon-led actions: helpful, never in the way of the flight itself. */
function mineCard(f) {
  const mine = flightMine(f);
  const slot = (kind, icon, title, hint) => {
    const value = h("strong", { class: "fm-value", text: mine[kind] || "Add" });
    const input = h("input", {
      class: "fm-input",
      hidden: true,
      value: mine[kind] || "",
      maxLength: kind === "code" ? 8 : 4,
      autocapitalize: "characters",
      autocomplete: "off",
      spellcheck: false,
      "aria-label": title,
      placeholder: hint,
    });
    const note = h("small", { class: "fm-note", hidden: true, role: "status" });
    const btn = h("button", { type: "button", class: `card fact fm-slot${mine[kind] ? " set" : ""}`, "aria-label": `${title}: ${mine[kind] || "not added"}` }, h("span", { class: "fact-icon lav" }, svg(icon)), h("span", { text: title }), value);
    const box = h("div", { class: "fm-box" }, btn, input, note);
    const commit = () => {
      const v = CLEAN[kind](input.value);
      if (v && !VALID[kind](v)) {
        note.hidden = false;
        note.textContent = kind === "code" ? "Booking codes have 5 to 8 letters and numbers." : "Seats look like 14C.";
        input.focus();
        return;
      }
      saveMine(f, { [kind]: v || null });
      mine[kind] = v || null;
      value.textContent = v || "Add";
      btn.classList.toggle("set", !!v);
      btn.setAttribute("aria-label", `${title}: ${v || "not added"}`);
      note.hidden = true;
      input.hidden = true;
      btn.hidden = false;
    };
    btn.addEventListener("click", () => {
      btn.hidden = true;
      input.hidden = false;
      input.value = mine[kind] || "";
      input.focus();
    });
    input.addEventListener("input", () => (input.value = CLEAN[kind](input.value)));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") ((input.hidden = true), (btn.hidden = false), (note.hidden = true));
    });
    input.addEventListener("blur", commit);
    // Paste straight from the airline's email or app
    if (kind === "code" && navigator.clipboard?.readText) {
      const paste = h("button", { type: "button", class: "chip quiet fm-paste", text: "Paste" });
      paste.addEventListener("click", async (e) => {
        e.stopPropagation();
        const text = (await navigator.clipboard.readText().catch(() => "")) || "";
        const m = /\b[A-Z0-9]{6}\b/.exec(text.toUpperCase());
        if (m) {
          input.value = m[0];
          commit();
        } else {
          btn.click();
          note.hidden = false;
          note.textContent = "No booking code on the clipboard. Type it in.";
        }
      });
      box.append(paste);
    }
    return box;
  };
  return h(
    "section",
    { class: "fmine", "aria-label": "Your booking" },
    slot("code", icons.ticket, "Booking code", "e.g. X7KQ2P"),
    slot("seat", icons.seat, "Seat", "e.g. 14C"),
    h("p", { class: "fm-private", text: "Kept on this phone only." })
  );
}
