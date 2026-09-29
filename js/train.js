import { h, svg, clock, dayLabel, dateKey, duration, ago, delayChip, fmtMin, pointAtKm } from "./util.js";
import { icons, weatherLook } from "./icons.js";

const bestArr = (s) => s.actual.arr || s.expected.arr || s.sched.arr;
const bestDep = (s) => s.actual.dep || s.expected.dep || s.sched.dep;

/**
 * Build the train status screen.
 * ctx: { stop, foldOpen, onPickStop(code), onToggleFold() }
 * Returns { node, map: { el, opts } | null, currentRow, addWeather(w) }
 */
export function renderTrain(j, ctx) {
  const halts = j.stops.filter((s) => s.halts);
  const origin = halts[0];
  const dest = halts.at(-1);
  const mine = halts.find((s) => s.code === ctx.stop) || dest;
  const phase = j.status.phase;
  const pos = j.position || {};
  const atStop = phase === "running" ? halts.find((s) => s.code === pos.stationCode && pos.state === "at") : null;
  const nextStop = halts.find((s) => !s.passed && s.km > pos.kmDone - 0.5);

  const node = h("div", { class: "status-body" });

  /* ---------------- hero: your stop ---------------- */
  const mineIsOrigin = mine === origin;
  const mineTime = mineIsOrigin ? bestDep(mine) : bestArr(mine);
  const mineDelay = (mineIsOrigin ? mine.delay.dep : mine.delay.arr) ?? (mine.passed ? null : j.status.delayMin);
  const until = mineTime ? Date.parse(mineTime) - Date.now() : null;

  let whenText;
  if (mine.passed) whenText = mineIsOrigin ? "Departed" : "Arrived";
  else if (until != null && until > 0) whenText = `in ${duration(until)}`;
  else whenText = "Due now";

  const chips = [];
  if (phase === "not_started" && !mine.passed) chips.push({ cls: "info", text: "Not started yet" });
  const dc = delayChip(mineDelay);
  if (dc) {
    const how = dc.cls === "ok" ? "on time" : dc.cls === "late" ? `${fmtMin(mineDelay)} late` : `${fmtMin(mineDelay)} early`;
    chips.push({ cls: dc.cls, text: mine.passed ? `${mineIsOrigin ? "Left" : "Arrived"} ${how}` : `Expected ${how}` });
  }

  const kmDone = Math.max(0, Math.min(pos.kmDone || 0, pos.kmTotal || dest.km));
  const kmTotal = pos.kmTotal || dest.km || 1;
  const lastPassedIdx = halts.reduce((acc, s, i) => (s.passed ? i : acc), -1);

  const hero = h(
    "section",
    { class: "card hero-card", "aria-labelledby": "hero-place" },
    h(
      "div",
      { class: "hero-row" },
      h("span", { class: "eyebrow-pin" }, svg(icons.pin), mineIsOrigin ? "Your start" : "Your stop"),
      h("button", { class: "pill-btn", type: "button", text: "Change", on: { click: () => document.getElementById("timeline")?.scrollIntoView({ behavior: "smooth" }) } })
    ),
    h("h2", { class: "hero-place display", id: "hero-place", text: mine.name }),
    h(
      "div",
      { class: "hero-time-row" },
      h("p", { class: "hero-time", "data-k": "hero-time", text: clock(mineTime) || "--:--" }),
      h("div", { class: "hero-when" }, h("span", { text: dayLabel(mineTime) }), h("strong", { class: "tn", "data-k": "hero-when", text: whenText }))
    ),
    h("div", { class: "hero-chips" }, chips.map((c) => h("span", { class: `chip ${c.cls}`, text: c.text }))),
    h(
      "div",
      { class: "ribbon", role: "img", "aria-label": `${kmDone} of ${kmTotal} km covered` },
      h("div", { class: "ribbon-track" }),
      h("div", { class: "ribbon-fill" }),
      h(
        "div",
        { class: "ribbon-dots" },
        halts.map((s, i) => h("i", { class: s === mine ? "m" : i === lastPassedIdx && phase === "running" ? "c" : s.passed ? "p" : "" }))
      )
    ),
    h(
      "div",
      { class: "ribbon-legend tn" },
      h("span", { text: origin.code }),
      h("strong", { "data-k": "km", text: `${kmDone} of ${kmTotal} km` }),
      h("span", { text: dest.code })
    )
  );
  hero.querySelector(".ribbon-fill").style.width = `${(kmDone / kmTotal) * 100}%`;
  node.append(hero);

  /* ---------------- now ---------------- */
  const now = h("section", { class: "now-card", "aria-live": "polite" });
  const lead = (t) => h("p", { class: "now-lead", text: t });
  const text = (...parts) => h("p", { class: "now-text" }, parts);
  const b = (t) => h("b", { class: "tn", text: t });

  if (phase === "not_started") {
    now.append(lead("Not started yet"), text("Leaves ", b(origin.name), " at ", b(clock(bestDep(origin))), "."));
  } else if (phase === "arrived") {
    now.append(lead("Journey complete"), text("Reached ", b(dest.name), " at ", b(clock(bestArr(dest))), "."));
  } else if (atStop && !atStop.actual.dep) {
    now.append(
      lead("Now"),
      text("Halting at ", b(atStop.name), atStop.platform ? `, platform ${atStop.platform}` : "", ". Leaves around ", b(clock(bestDep(atStop))), ".")
    );
  } else {
    const where = pos.stationName ? ["Passed ", b(pos.stationName), pos.kmPast ? `, ${pos.kmPast} km beyond` : "", ". "] : ["On the move. "];
    const next = nextStop ? ["Next stop ", b(nextStop.name), " at ", b(clock(bestArr(nextStop))), "."] : [];
    now.append(lead("Now"), text(...where, ...next));
  }
  const staleMin = j.status.lastUpdated ? (Date.now() - Date.parse(j.status.lastUpdated)) / 60000 : 0;
  const stale = phase === "running" && staleMin > 20;
  if (j.status.lastUpdated && phase !== "not_started") {
    now.append(
      h("p", { class: `now-fresh${stale ? " stale" : ""}` }, h("i"), `Location reported ${ago(j.status.lastUpdated)}`)
    );
  }
  node.append(now);
  if (stale || j.status.servedStale) {
    node.append(
      h(
        "div",
        { class: "banner info", role: "note" },
        svg(icons.info),
        h("span", { text: j.status.servedStale ? "Showing the last saved update while live data catches up." : `Last report is ${fmtMin(staleMin)} old, so times ahead may shift.` })
      )
    );
  }

  /* ---------------- map ---------------- */
  let map = null;
  const geo = j.stops.filter((s) => s.lat != null && s.lon != null).sort((a, c) => a.km - c.km);
  if (geo.length >= 2) {
    const point = pointAtKm(geo, kmDone);
    const line = geo.map((s) => [s.lon, s.lat]);
    const done = [...geo.filter((s) => s.km <= kmDone).map((s) => [s.lon, s.lat]), point];
    const ahead = [point, ...geo.filter((s) => s.km > kmDone).map((s) => [s.lon, s.lat])];
    const el = h("div", { class: "map-box", role: "img", "aria-label": `Map of the route with the train near ${pos.stationName || origin.name}` });
    node.append(
      h(
        "section",
        { class: "card map-card" },
        h("span", { class: "map-badge estimated" }, h("i"), "From last report"),
        el,
        h("p", { class: "map-note", text: "Position is placed on the line from the last reported station." })
      )
    );
    map = { el, opts: { mode: "train", line, done: done.length > 1 ? done : [line[0], line[0]], ahead, position: point } };
  }

  /* ---------------- timeline ---------------- */
  node.append(h("h2", { class: "section-title display", id: "timeline", text: "Stops" }));
  const tl = h("section", { class: "card timeline", "aria-label": "Stops on this journey" });
  tl.append(h("div", { class: "tl-head", "aria-hidden": "true" }, h("span", { text: "Station" }), h("span", { text: "Arr" }), h("span", { text: "Dep" })));

  const hiddenIdx = new Set();
  if (!ctx.foldOpen && phase !== "not_started") {
    for (let i = 1; i < lastPassedIdx; i++) hiddenIdx.add(i);
    if (hiddenIdx.size < 2) hiddenIdx.clear();
  }

  let rowI = 0;
  let prevDay = j.date;
  let currentRow = null;
  const between = phase === "running" && !atStop;

  halts.forEach((s, i) => {
    const next = halts[i + 1];
    if (hiddenIdx.has(i)) {
      if (i === 1) {
        const worst = [...hiddenIdx].map((k) => halts[k]).reduce((acc, x) => ((x.delay.arr ?? -99) > (acc?.delay.arr ?? -99) ? x : acc), null);
        tl.append(
          h(
            "div",
            { class: "tl-fold" },
            rail("done", "done"),
            h(
              "button",
              { type: "button", "aria-expanded": "false", on: { click: ctx.onToggleFold } },
              h("strong", { text: `${hiddenIdx.size} earlier stops` }),
              worst && worst.delay.arr >= 10 ? h("span", { text: `Peak delay ${fmtMin(worst.delay.arr)} at ${worst.name}` }) : null
            )
          )
        );
      }
      return;
    }

    const dayOf = dateKey(s.sched.arr || s.sched.dep);
    if (dayOf && dayOf !== prevDay) {
      tl.append(h("div", { class: "tl-day" }, rail(s.passed ? "done" : "ahead", s.passed ? "done" : "ahead"), h("span", { class: "chip info", text: dayLabel(s.sched.arr || s.sched.dep) })));
      prevDay = dayOf;
    }

    const isCurrent = phase === "running" && atStop === s;
    const isMine = s === mine;
    const up = i === 0 ? "none" : s.passed ? "done" : "ahead";
    const down = !next ? "none" : s.passed && (next.passed || (phase === "running" && !isCurrent)) ? "done" : "ahead";

    let chip = null;
    if (isMine) chip = { cls: "accent", text: "Your stop" };
    else if (isCurrent) chip = { cls: "ok", text: "Halting now" };
    else if (s === nextStop && phase === "running") chip = { cls: "info", text: "Next stop" };
    else if (s.passed) {
      const d = delayChip(i === 0 ? s.delay.dep : s.delay.arr);
      if (d && d.cls !== "ok") chip = d;
    }

    const meta = [`${s.km} km`];
    if (s.platform) meta.push(`PF ${s.platform}`);
    if (s.haltMin >= 2 && i > 0 && next) meta.push(`${s.haltMin} min halt`);
    if (i === 0) meta.push("Start");
    if (!next) meta.push("End");

    const row = h(
      "button",
      {
        type: "button",
        class: ["tl-row", s.passed ? "passed" : "", isCurrent ? "current" : "", isMine ? "mine" : ""].join(" "),
        vars: { "--i": String(rowI++) },
        "aria-pressed": isMine ? "true" : "false",
        "aria-label": `${s.name}. ${isMine ? "Your stop." : "Set as your stop."}`,
        on: { click: () => ctx.onPickStop(s.code) },
      },
      rail(up, down),
      h(
        "div",
        { class: "tl-info" },
        h("p", { class: "tl-name" }, s.name, h("span", { class: "tl-code", text: s.code })),
        h("p", { class: "tl-meta tn", text: meta.join(", ") }),
        chip ? h("span", { class: `chip ${chip.cls}`, text: chip.text }) : null
      ),
      timeCell(s, "arr", i === 0),
      timeCell(s, "dep", !next)
    );
    tl.append(row);
    if (isCurrent) currentRow = row;

    if (between && i === lastPassedIdx && next) {
      const here = h(
        "div",
        { class: "tl-here", "data-k": "here" },
        rail("done", "ahead", true),
        h("span", { text: pos.stationName ? `Passed ${pos.stationName}${pos.kmPast ? `, ${pos.kmPast} km on` : ""}` : "On the move" })
      );
      tl.append(here);
      currentRow = here;
    }
  });
  node.append(tl);

  /* ---------------- good to know ---------------- */
  const gtk = h("section", { class: "gtk", "aria-labelledby": "gtk-title" });
  const gtkTitle = h("h2", { class: "section-title display", id: "gtk-title", text: "Good to know" });
  const items = [];

  const mineArr = bestArr(mine);
  const upcoming = halts.filter((s) => !s.passed && s !== dest && s !== origin && s.haltMin >= 10);
  if (upcoming.length) {
    const s = upcoming[0];
    items.push(gtkItem(icons.cup, "warm", `${s.haltMin} min halt at ${s.name}`, `Around ${clock(bestArr(s))}. Enough time to step out for food or water.`));
  }
  if (!mine.passed && mineArr && dateKey(mineArr) !== j.date) {
    items.push(gtkItem(icons.moonTrain, "", "Overnight journey", `${mine.name} is on ${dayLabel(mineArr)}.`));
  }
  if (mine.onTimeRating != null && mine.onTimeRating >= 8) items.push(gtkItem(icons.clock, "cool", `Usually on time at ${mine.name}`, "Based on this train's recent runs."));
  if (mine.onTimeRating != null && mine.onTimeRating <= 3) items.push(gtkItem(icons.clock, "warm", `Often late at ${mine.name}`, "Recent runs have usually reached here behind schedule."));
  if ((j.extras?.fogRisk || 0) > 0.3) items.push(gtkItem(icons.fog, "", "Fog season on this route", "Winter fog often slows trains here, so delays can grow."));
  if (j.coaches?.length) {
    const entry = j.coaches.find((c) => c.code === mine.code) || j.coaches[0];
    const stationName = halts.find((s) => s.code === entry.code)?.name || entry.code;
    const card = gtkItem(icons.coach, "cool", `Coach order at ${stationName}`, "As published by Indian Railways. Can change on the day.");
    card.append(h("div", { class: "coach-strip", role: "list" }, entry.list.map((c) => h("i", { role: "listitem", text: c.id }))));
    card.classList.add("coach-card");
    items.push(card);
  }

  function paintGtk(extra = []) {
    const all = [...extra, ...items];
    gtk.replaceChildren(...all);
    gtkTitle.hidden = all.length === 0;
  }
  paintGtk();
  node.append(gtkTitle, gtk);

  function addWeather(w) {
    if (!w || !w.hourly) return;
    const extra = [];
    const target = mine.passed ? null : mineArr;
    const atLocal = (localStr) => Date.parse(`${localStr}:00Z`) - (w.offsetSec || 0) * 1000;
    let temp = w.current.temp;
    let code = w.current.code;
    let isDay = w.current.isDay;
    let when = "right now";
    if (target) {
      const t = Date.parse(target);
      let best = -1;
      let bestGap = Infinity;
      w.hourly.time.forEach((ts, k) => {
        const gap = Math.abs(atLocal(ts) - t);
        if (gap < bestGap) {
          bestGap = gap;
          best = k;
        }
      });
      if (best >= 0 && bestGap < 90 * 60000) {
        temp = w.hourly.temp[best];
        code = w.hourly.code[best];
        when = `around ${clock(target)}`;
        const d = w.daily.date.indexOf(dateKey(target));
        if (d >= 0) {
          const rise = atLocal(w.daily.sunrise[d]);
          const set = atLocal(w.daily.sunset[d]);
          isDay = t > rise && t < set;
          if (t < rise) extra.push(gtkItem(icons.sunset, "warm", "Reaching before sunrise", `Sunrise in ${mine.name} is at ${clock(new Date(rise).toISOString())}. Plan your pickup.`));
          else if (t > set) extra.push(gtkItem(icons.sunset, "warm", "Reaching after dark", `Sunset in ${mine.name} is at ${clock(new Date(set).toISOString())}.`));
        }
      }
    }
    if (temp != null) {
      const look = weatherLook(code, isDay);
      extra.unshift(gtkItem(look.icon, "", `Weather at ${mine.name}`, `${Math.round(temp)}°C and ${look.label} ${when}`));
    }
    paintGtk(extra);
  }

  return { node, map, currentRow, weatherPlace: mine.lat != null ? { lat: mine.lat, lon: mine.lon } : null, addWeather };
}

function rail(up, down, isHere = false) {
  return h(
    "span",
    { class: "tl-rail", "aria-hidden": "true" },
    h("i", { class: `seg up ${up}` }),
    h("i", { class: `seg down ${down}` }),
    h("i", { class: "tl-dot" })
  );
}

function timeCell(s, which, blank) {
  if (blank) return h("span", { class: "tl-time" }, h("small", { text: " " }), h("b", { class: "t-none", text: "-" }));
  const sched = s.sched[which];
  const actual = s.actual[which];
  const expected = s.expected[which];
  const shown = actual || expected || sched;
  const delay = s.delay[which];
  let cls = "";
  if (actual && delay != null) cls = delay >= 5 ? "t-late" : "t-early";
  return h(
    "span",
    { class: "tl-time" },
    h("small", { text: actual || expected ? clock(sched) : " " }),
    h("b", { class: cls, "data-k": `${s.code}-${which}`, text: clock(shown) })
  );
}

function gtkItem(icon, tone, title, sub) {
  return h(
    "div",
    { class: "card gtk-item" },
    h("span", { class: `gtk-icon ${tone}` }, svg(icon)),
    h("div", {}, h("strong", { text: title }), h("span", { text: sub }))
  );
}
