import { h, svg, clock, dayLabel, duration, ago, delayChip, fmtMin, tzOffset, greatCircle } from "./util.js";
import { icons, weatherLook } from "./icons.js";

/**
 * Build the flight status screen. The layout changes with the phase:
 * before takeoff the gate leads, in the air the map leads, after landing the belt leads.
 */
export function renderFlight(f, ctx = {}) {
  const dep = f.departure;
  const arr = f.arrival;
  const depTz = dep.tz || "UTC";
  const arrTz = arr.tz || "UTC";
  const phase = f.status.phase;
  const t12 = (iso, tz) => clock(iso, tz, true);

  const depTime = dep.revised || dep.sched;
  const arrTime = (phase === "landed" && (arr.actual || arr.revised)) || arr.revised || arr.sched;
  const now = Date.now();
  const node = h("div", { class: "status-body" });

  node.append(
    h(
      "header",
      { class: "flight-head" },
      h("p", { class: "field-hint tn", text: `${f.airline.name}, ${dayLabel(dep.sched, depTz)}` }),
      h("h2", { class: "display hero-place", text: `${dep.city || dep.code} to ${arr.city || arr.code}` })
    )
  );

  /* ---------------- live position (air) ---------------- */
  let map = null;
  let fraction = 0;
  const haveGeo = [dep.lat, dep.lon, arr.lat, arr.lon].every(Number.isFinite);
  const takeoff = dep.actual || depTime;
  if (phase === "air" && takeoff && arrTime) {
    fraction = Math.min(0.99, Math.max(0.01, (now - Date.parse(takeoff)) / (Date.parse(arrTime) - Date.parse(takeoff))));
  }
  if (phase === "air" && haveGeo) {
    const line = greatCircle([dep.lon, dep.lat], [arr.lon, arr.lat], 96);
    const live = f.position && Number.isFinite(f.position.lat);
    const el = h("div", { class: "map-box tall", role: "img", "aria-label": `Map of the flight from ${dep.code} to ${arr.code}` });
    node.append(
      h(
        "section",
        { class: "card map-card" },
        h("span", { class: `map-badge${live ? "" : " estimated"}` }, h("i"), live ? "Live position" : "Estimated position"),
        el,
        live ? null : h("p", { class: "map-note", text: "No live signal right now. Position is estimated from the schedule." })
      )
    );
    map = {
      el,
      opts: {
        mode: "flight",
        line,
        fraction,
        position: live ? [f.position.lon, f.position.lat] : null,
        trackDeg: live ? f.position.trackDeg : null,
      },
    };
    const stat = (label, value) => h("div", { class: "card stat" }, h("span", { text: label }), h("strong", { text: value }));
    node.append(
      h(
        "div",
        { class: "stat-grid" },
        stat("Altitude", live && f.position.altFt ? `${Math.round(f.position.altFt).toLocaleString("en-IN")} ft` : "--"),
        stat("Speed", live && f.position.speedKmh ? `${f.position.speedKmh} km/h` : "--"),
        stat("Signal", live ? ago(f.position.at) : "Estimated")
      )
    );
  }

  /* ---------------- phase banner ---------------- */
  const banner = h("section", { class: "phase-banner", "aria-live": "polite" });
  const setTone = (d) => banner.classList.add(d == null ? "tone" : d >= 15 ? "warn" : d <= 5 ? "good" : "tone");
  const lead = (t) => h("p", { class: "lead", text: t });
  const big = (t, k) => h("p", { class: "big", "data-k": k, text: t });
  const sub = (t) => h("p", { class: "sub", text: t });

  if (phase === "cancelled") {
    banner.classList.add("bad");
    banner.append(lead("Flight status"), big("Cancelled", "b"), sub(`Check with ${f.airline.name} about rebooking.`));
  } else if (phase === "diverted") {
    banner.classList.add("warn");
    banner.append(lead("Flight status"), big("Diverted", "b"), sub(`${f.airline.name} will share the new plan.`));
  } else if (phase === "pre") {
    const d = f.status.delayDep;
    setTone(d);
    const until = Date.parse(depTime) - now;
    const dc = delayChip(d);
    const statusWord = /Boarding/.test(f.status.raw) ? "Boarding now" : /GateClosed/.test(f.status.raw) ? "Gate closed" : null;
    banner.append(
      lead(until > 0 ? "Departs in" : "Departure"),
      big(until > 0 ? duration(until) : t12(depTime, depTz), "b"),
      sub([statusWord, dc && dc.cls === "late" ? `Delayed ${fmtMin(d)}, now ${t12(depTime, depTz)}` : `On time at ${t12(depTime, depTz)}`].filter(Boolean).join(". "))
    );
  } else if (phase === "air") {
    const d = f.status.delayArr;
    setTone(d);
    const dc = delayChip(d);
    const left = Math.max(0, Date.parse(arrTime) - now);
    const total = f.distanceKm;
    banner.append(
      lead("Lands in"),
      big(duration(left), "b"),
      sub(`${t12(arrTime, arrTz)}, ${dc ? dc.text.toLowerCase() : "on schedule"}`),
      h("div", { class: "progress", "aria-hidden": "true" }, h("i")),
      h(
        "div",
        { class: "progress-legend tn" },
        h("span", { text: `${duration(now - Date.parse(takeoff))} flown` }),
        h("span", { text: total ? `${Math.round(total * (1 - fraction)).toLocaleString("en-IN")} km to go` : `${duration(left)} left` })
      )
    );
    banner.querySelector(".progress i").style.width = `${fraction * 100}%`;
  } else {
    const d = f.status.delayArr;
    setTone(d);
    const dc = delayChip(d);
    banner.append(
      lead("Landed"),
      big(t12(arrTime, arrTz), "b"),
      sub(`${dc ? dc.text : "On time"}, ${ago(arrTime)}. ${arr.actual && dep.actual ? `${duration(Date.parse(arr.actual) - Date.parse(dep.actual))} in the air.` : ""}`.trim())
    );
  }
  node.append(banner);

  /* ---------------- belt hero after landing ---------------- */
  if (phase === "landed" && arr.belt) {
    node.append(
      h(
        "section",
        { class: "belt-hero" },
        h("span", { class: "belt-num tn", text: arr.belt }),
        h("div", {}, h("span", {}, "Baggage belt"), h("strong", { text: `Your bags arrive on belt ${arr.belt}` }))
      )
    );
  }
  if (phase === "landed" && navigator.share) {
    node.append(
      h(
        "button",
        {
          type: "button",
          class: "cta secondary",
          on: {
            click: () =>
              navigator.share({ text: `Landed in ${arr.city || arr.code} at ${t12(arrTime, arrTz)}. ${f.number}` }).catch(() => {}),
          },
        },
        svg(icons.message),
        "Tell someone you've landed"
      )
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
    const gateChips = [];
    if (m.gate) gateChips.push(h("span", { class: "gate-chip" }, svg(icons.gate), m.gate, h("small", { text: "Gate" })));
    if (m.terminal) gateChips.push(h("span", { class: "chip quiet", text: `Terminal ${m.terminal}` }));
    if (!isDep && m.belt && phase !== "landed") gateChips.push(h("span", { class: "gate-chip" }, svg(icons.belt), m.belt, h("small", { text: "Belt" })));
    if (isDep && m.checkIn && phase === "pre") gateChips.push(h("span", { class: "chip quiet", text: `Check-in ${m.checkIn}` }));
    return h(
      "div",
      { class: "leg" },
      h(
        "div",
        {},
        h("p", { class: "leg-place", text: `${m.code}, ${m.name}` }),
        h("p", { class: "leg-time" }, h("span", { "data-k": `${side}-t`, text: t12(time, tz) }), changed ? h("s", { text: t12(m.sched, tz) }) : null),
        h("p", { class: `leg-note ${neutral ? "neutral" : late && late.cls === "late" ? "t-late" : "t-early"}`, text: note })
      ),
      h("div", { class: "leg-chips" }, gateChips)
    );
  };
  const flightMins = depTime && arrTime ? Date.parse(arrTime) - Date.parse(depTime) : null;
  node.append(
    h(
      "section",
      { class: "card" },
      legBlock("dep", dep, depTz, depTime, f.status.delayDep, true),
      h(
        "div",
        { class: "leg-mid" },
        h("span", { class: "tn", text: [flightMins ? duration(flightMins) : null, f.distanceKm ? `${f.distanceKm.toLocaleString("en-IN")} km` : null].filter(Boolean).join(", ") }),
        h("i")
      ),
      legBlock("arr", arr, arrTz, arrTime, f.status.delayArr, false)
    )
  );

  /* ---------------- good to know ---------------- */
  const gtkTitle = h("h2", { class: "section-title display", text: "Good to know" });
  const gtk = h("section", { class: "gtk" });
  const items = [];
  const depOff = tzOffset(depTz, new Date(arrTime || now));
  const arrOff = tzOffset(arrTz, new Date(arrTime || now));
  if (depOff !== arrOff && arrTime) {
    const diff = arrOff - depOff;
    const sign = diff > 0 ? "+" : "-";
    const hh = Math.floor(Math.abs(diff) / 60);
    const mm = Math.abs(diff) % 60;
    const label = `${sign}${hh ? `${hh} h` : ""}${hh && mm ? " " : ""}${mm ? `${mm} min` : ""}`;
    items.push(
      gtkItem(icons.clock, "cool", `${label} time change`, `${t12(arrTime, arrTz)} arrival is ${t12(arrTime, depTz)} ${dep.city || dep.code} time.`)
    );
    if (phase === "landed") items.push(gtkItem(icons.clock, "", "Local time now", `${t12(new Date().toISOString(), arrTz)} in ${arr.city || arr.code}.`));
  }
  if (f.aircraft && (f.aircraft.model || f.aircraft.reg)) {
    items.push(gtkItem(icons.plane2, "", "Your aircraft", [f.aircraft.model, f.aircraft.reg].filter(Boolean).join(", ")));
  }

  function paint(extra = []) {
    const all = [...extra, ...items];
    gtk.replaceChildren(...all);
    gtkTitle.hidden = all.length === 0;
  }
  paint();
  node.append(gtkTitle, gtk);

  function addWeather(w) {
    if (!w || !w.hourly || !arrTime) return;
    const extra = [];
    const atLocal = (s) => Date.parse(`${s}:00Z`) - (w.offsetSec || 0) * 1000;
    const t = Date.parse(arrTime);
    let temp = w.current.temp;
    let code = w.current.code;
    let isDay = w.current.isDay;
    if (phase !== "landed") {
      let best = -1;
      let gap = Infinity;
      w.hourly.time.forEach((ts, k) => {
        const g = Math.abs(atLocal(ts) - t);
        if (g < gap) {
          gap = g;
          best = k;
        }
      });
      if (best >= 0 && gap < 90 * 60000) {
        temp = w.hourly.temp[best];
        code = w.hourly.code[best];
      }
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: arrTz }).format(new Date(t));
      const d = w.daily.date.indexOf(day);
      if (d >= 0) {
        const rise = atLocal(w.daily.sunrise[d]);
        const set = atLocal(w.daily.sunset[d]);
        isDay = t > rise && t < set;
        if (t > set) extra.push(gtkItem(icons.sunset, "warm", "Landing after dark", `Sunset in ${arr.city || arr.code} is at ${t12(new Date(set).toISOString(), arrTz)}.`));
        else if (t < rise) extra.push(gtkItem(icons.sunset, "warm", "Landing before sunrise", `Sunrise in ${arr.city || arr.code} is at ${t12(new Date(rise).toISOString(), arrTz)}.`));
      }
    }
    if (temp != null) {
      const look = weatherLook(code, isDay);
      extra.unshift(gtkItem(look.icon, "", phase === "landed" ? `Weather in ${arr.city || arr.code}` : "Arrival weather", `${Math.round(temp)}°C and ${look.label}${phase === "landed" ? " right now" : ""}`));
    }
    paint(extra);
  }

  return { node, map, currentRow: null, weatherPlace: Number.isFinite(arr.lat) ? { lat: arr.lat, lon: arr.lon } : null, addWeather };
}

function gtkItem(icon, tone, title, subText) {
  return h(
    "div",
    { class: "card gtk-item" },
    h("span", { class: `gtk-icon ${tone}` }, svg(icon)),
    h("div", {}, h("strong", { text: title }), h("span", { text: subText }))
  );
}
