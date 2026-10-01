// Route finder: pick From and To stations, a day and a time, and see every train between them.
// Tapping a train opens its live status for the right run, with your stop already set.

import { h, svg, clock, dayLabel, duration, addDays, todayIn, IST, longDate } from "./util.js";
import { icons, art } from "./icons.js";
import { api, ApiError } from "./api.js";
import { loadStations, stationsReady, stationByCode, stationName, searchStations, resolveStation, POPULAR } from "./stations.js";

const today = () => todayIn(IST);
const noonOf = (d) => `${d}T12:00:00+05:30`;
const shortDay = (d) => dayLabel(noonOf(d)); // "Fri 2 Oct"
const weekday = (d) => new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const minutesOf = (hhmm) => (/^\d{2}:\d{2}$/.test(hhmm || "") ? +hhmm.slice(0, 2) * 60 + +hhmm.slice(3) : null);
const nowHHMM = () => clock(new Date().toISOString());
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Long names (or one long word) step both ends down a size together, so they wrap between
// words rather than inside one, and the two ends still match.
const nameSize = (...names) => {
  const longest = Math.max(...names.map((n) => n.length));
  const word = Math.max(...names.flatMap((n) => n.split(/\s+/).map((w) => w.length)));
  if (longest > 22 || word > 11) return " xlong";
  if (longest > 15 || word > 9) return " long";
  return "";
};

/** How far ahead (and back) a route search can go. */
export const routeRange = () => [addDays(today(), -3), addDays(today(), 30)];

/* ================================================================== */
/* Station field: an accessible combobox                               */
/* ================================================================== */

let uid = 0;

function stationField({ input, list, codeEl, status, onPick }) {
  const field = input.closest(".jf");
  let picked = null; // { code, name }
  let items = [];
  let active = -1;
  let query = "";

  const isOpen = () => !list.hidden;
  function open() {
    if (isOpen()) return;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    field.classList.add("open");
  }
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    field.classList.remove("open");
    active = -1;
  }

  function setActive(i) {
    const opts = [...list.querySelectorAll('[role="option"]')];
    opts.forEach((o) => o.setAttribute("aria-selected", "false"));
    active = opts.length ? (i + opts.length) % opts.length : -1;
    if (active < 0) return input.removeAttribute("aria-activedescendant");
    const el = opts[active];
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    el.scrollIntoView({ block: "nearest" });
  }

  function highlight(name, q) {
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const lower = name.toLowerCase();
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      const m = re.exec(lower);
      if (m) {
        const at = m.index + m[1].length;
        return [name.slice(0, at), h("mark", { text: name.slice(at, at + w.length) }), name.slice(at + w.length)];
      }
    }
    return [name];
  }

  function render(rows, { heading, empty } = {}) {
    items = rows;
    list.replaceChildren();
    if (heading) list.append(h("li", { class: "st-head", role: "presentation", text: heading }));
    rows.forEach(({ station, via }, i) => {
      const opt = h(
        "li",
        {
          class: "st-opt",
          role: "option",
          id: `${input.id}-opt-${++uid}`,
          "aria-selected": "false",
          vars: { "--i": String(i) },
          on: {
            // Keep focus in the field so the list stays open until the tap lands. mousedown (not
            // pointerdown) doesn't fire when a finger drags to scroll, so scrolling never picks.
            mousedown: (e) => e.preventDefault(),
            click: () => choose(station),
          },
        },
        h(
          "span",
          { class: "st-main" },
          h("span", { class: "st-name" }, via === "popular" ? station.name : highlight(station.name, query)),
          via === "alias" && station.alias ? h("span", { class: "st-sub", text: `Also known as ${station.alias}` }) : null
        ),
        h("span", { class: "st-code", text: station.code })
      );
      list.append(opt);
    });
    if (!rows.length && empty) list.append(h("li", { class: "st-empty", role: "presentation", text: empty }));
    open();
    if (rows.length && query) setActive(0);
    status.textContent = rows.length ? `${rows.length} station${rows.length > 1 ? "s" : ""} found. Use the arrow keys to choose.` : empty || "";
  }

  function refresh() {
    query = input.value.trim();
    if (!stationsReady()) {
      list.replaceChildren(h("li", { class: "st-empty", role: "presentation" }, h("span", { class: "st-spin", "aria-hidden": "true" }), "Loading stations"));
      open();
      loadStations()
        .then(() => document.activeElement === input && refresh())
        .catch(() => {
          list.replaceChildren(h("li", { class: "st-empty", role: "presentation", text: "Couldn't load the station list. Check your connection and try again." }));
        });
      return;
    }
    if (!query) {
      const popular = POPULAR.map((c) => stationByCode(c)).filter(Boolean);
      return render(
        popular.map((station) => ({ station, via: "popular" })),
        { heading: "Popular stations" }
      );
    }
    render(searchStations(query), { empty: `No station matches “${query}”. Try its code, like MYS.` });
  }

  function choose(station, { silent = false } = {}) {
    picked = { code: station.code, name: station.name };
    input.value = station.name;
    codeEl.textContent = station.code;
    codeEl.hidden = false;
    codeEl.classList.remove("pop");
    void codeEl.offsetWidth;
    codeEl.classList.add("pop");
    input.removeAttribute("aria-invalid");
    field.classList.add("picked");
    close();
    if (!silent) onPick?.(picked);
  }

  function unpick() {
    picked = null;
    codeEl.hidden = true;
    field.classList.remove("picked");
  }

  input.addEventListener("input", () => {
    unpick();
    input.removeAttribute("aria-invalid");
    onPick?.(null);
    refresh();
  });
  input.addEventListener("focus", () => {
    // Selecting the text makes retyping a picked station one gesture.
    if (picked) input.select();
    refresh();
    // On a phone the keyboard takes half the screen: lift the field so its suggestions stay in view.
    if (window.matchMedia("(pointer: coarse) and (max-height: 900px)").matches)
      setTimeout(() => field.scrollIntoView({ block: "start", behavior: "smooth" }), 250);
  });
  input.addEventListener("blur", () => {
    close();
    if (!picked && input.value.trim()) {
      const exact = resolveStation(input.value);
      if (exact) choose(exact, { silent: true });
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) refresh();
      setActive(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && isOpen() && active >= 0 && items[active]) {
      e.preventDefault();
      choose(items[active].station);
    } else if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close();
    } else if (e.key === "Tab" && isOpen() && active >= 0 && items[active] && query) {
      choose(items[active].station);
    }
  });

  return {
    get value() {
      return picked;
    },
    get text() {
      return input.value.trim();
    },
    input,
    /** Set from a code, e.g. from the address bar. Works before the list has loaded. */
    setCode(code) {
      if (!code) {
        input.value = "";
        return unpick();
      }
      const st = stationByCode(code);
      if (st) return choose(st, { silent: true });
      picked = { code, name: code };
      input.value = code;
      codeEl.textContent = code;
      codeEl.hidden = false;
      field.classList.add("picked");
      loadStations()
        .then(() => {
          const s = stationByCode(code);
          if (s && picked?.code === code) choose(s, { silent: true });
        })
        .catch(() => {});
    },
    set(p) {
      if (p) {
        picked = { ...p };
        input.value = p.name;
        codeEl.textContent = p.code;
        codeEl.hidden = false;
        field.classList.add("picked");
      } else {
        input.value = "";
        unpick();
      }
    },
    /** For the swap animation: what's shown, picked or not. */
    snapshot: () => ({ picked: picked && { ...picked }, text: input.value }),
    restore(snap) {
      if (snap.picked) this.set(snap.picked);
      else {
        unpick();
        input.value = snap.text;
      }
    },
    resolve() {
      if (picked) return picked;
      const exact = input.value.trim() && resolveStation(input.value);
      if (exact) choose(exact, { silent: true });
      return picked;
    },
    invalid(on) {
      if (on) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    },
    close,
  };
}

/* ================================================================== */
/* The route panel on the search screen                                */
/* ================================================================== */

const QUICK_TIMES = [
  { key: "", label: "Any time" },
  { key: "now", label: "Now" },
  { key: "05:00", label: "Morning" },
  { key: "12:00", label: "Afternoon" },
  { key: "17:00", label: "Evening" },
  { key: "21:00", label: "Night" },
];

export function createRoutePanel() {
  const $ = (id) => document.getElementById(id);
  const errorEl = $("route-error");
  const status = $("st-status");
  const timeInput = $("t-after");
  const chipsEl = $("time-chips");
  const swapBtn = $("jf-swap");
  let date = today();
  let chipKey = "";
  let spins = 0;

  const showError = (msg, field) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
    from.invalid(field === from);
    to.invalid(field === to);
    if (field) field.input.focus();
  };

  const from = stationField({
    input: $("st-from"),
    list: $("st-from-list"),
    codeEl: $("st-from-code"),
    status,
    onPick: (p) => {
      errorEl.hidden = true;
      // From picked: carry on to To, unless it's already filled in.
      if (p && !to.value) requestAnimationFrame(() => to.input.focus());
    },
  });
  const to = stationField({
    input: $("st-to"),
    list: $("st-to-list"),
    codeEl: $("st-to-code"),
    status,
    onPick: (p) => {
      errorEl.hidden = true;
      if (p) {
        // Both ends known: put the keyboard away so the date and button are in view.
        to.input.blur();
        requestAnimationFrame(() => $("search-form").querySelector(".cta")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      }
    },
  });

  swapBtn.addEventListener("click", () => {
    const a = from.snapshot();
    const b = to.snapshot();
    from.restore(b);
    to.restore(a);
    spins += 1;
    swapBtn.style.setProperty("--spin", `${spins * 180}deg`);
    const journey = swapBtn.closest(".journey");
    journey.classList.remove("swapping");
    void journey.offsetWidth;
    journey.classList.add("swapping");
    errorEl.hidden = true;
    status.textContent = `Swapped. From ${from.text || "empty"}, to ${to.text || "empty"}.`;
  });

  /* ---------- leaving after ---------- */
  function paintChips() {
    chipsEl.replaceChildren(
      ...QUICK_TIMES.filter((c) => c.key !== "now" || date === today()).map((c) =>
        h("button", {
          type: "button",
          class: "time-chip",
          "aria-pressed": String(chipKey === c.key),
          text: c.label,
          on: { click: () => setTime(c.key) },
        })
      )
    );
  }
  function setTime(key) {
    chipKey = key;
    timeInput.value = key === "now" ? nowHHMM() : key;
    paintChips();
  }
  timeInput.addEventListener("input", () => {
    const match = QUICK_TIMES.find((c) => c.key && c.key !== "now" && c.key === timeInput.value);
    chipKey = !timeInput.value ? "" : match ? match.key : "custom";
    paintChips();
  });

  return {
    /** Fill in from the address bar or a previous search. */
    reset({ from: f, to: t, time } = {}) {
      errorEl.hidden = true;
      from.setCode(f || null);
      to.setCode(t || null);
      const valid = /^\d{2}:\d{2}$/.test(time || "") ? time : "";
      timeInput.value = valid;
      chipKey = !valid ? "" : QUICK_TIMES.some((c) => c.key === valid) ? valid : "custom";
      paintChips();
      loadStations().catch(() => {});
    },
    onDate(d) {
      date = d;
      if (chipKey === "now" && d !== today()) chipKey = "custom";
      paintChips();
    },
    values: () => ({ from: from.value?.code || null, to: to.value?.code || null, time: timeInput.value || null }),
    focus() {
      (from.value ? (to.value ? null : to) : from)?.input.focus();
    },
    /** Checks the form; shows what's wrong and returns null, or returns the search. */
    validate() {
      const f = from.resolve();
      const t = to.resolve();
      if (!f) return showError(from.text ? `Pick “${from.text}” from the list, or type its code.` : "Choose the station you're leaving from.", from), null;
      if (!t) return showError(to.text ? `Pick “${to.text}” from the list, or type its code.` : "Choose where you're going.", to), null;
      if (f.code === t.code) return showError("From and To are the same station. Pick a different one.", to), null;
      showError("");
      return { from: f.code, to: t.code, time: timeInput.value || null };
    },
  };
}

/* ================================================================== */
/* Results                                                             */
/* ================================================================== */

const PREMIUM = /(Vande Bharat|Rajdhani|Shatabdi|Duronto|Tejas|Humsafar|Garib Rath|Amrit Bharat|Gatimaan|Antyodaya|Sampark Kranti|Double Decker|Uday)/i;

/** True when the live tracker can show this run (it covers runs from the last four days). */
const trackable = (startDate) => startDate >= addDays(today(), -3) && startDate <= today();

export function createResults({ root, title, sub, navigate, toast, footer }) {
  const memo = new Map(); // search key => data, for instant back navigation
  let current = null; // { key, r, data, expanded, scrollY }
  let token = 0;
  let focusStep = null; // keeps keyboard focus on the day arrow after the page redraws

  const keyOf = (r) => `${r.from}|${r.to}|${r.date}`;
  const nameOf = (code, data, side) => stationName(code, data?.[side]?.code === code ? data[side].name : null);

  function head(r, data) {
    const fromName = nameOf(r.from, data, "from");
    const toName = nameOf(r.to, data, "to");
    title.textContent = `${r.from} to ${r.to}`;
    sub.textContent = longDate(r.date);
    document.title = `Trains ${fromName} to ${toName}`;

    const [min, max] = routeRange();
    const step = (n) => {
      const d = addDays(r.date, n);
      return h(
        "button",
        {
          type: "button",
          class: `day-step ${n < 0 ? "prev" : "next"}`,
          disabled: d < min || d > max,
          "aria-label": `${n < 0 ? "Previous" : "Next"} day, ${longDate(d)}`,
          on: {
            click: () => {
              focusStep = n < 0 ? "prev" : "next";
              navigate({ m: "train", from: r.from, to: r.to, d, t: r.time }, { replace: true, instant: true, keepFocus: true });
            },
          },
        },
        n < 0 ? svg(icons.back) : null,
        h("span", { text: weekday(d) }),
        n > 0 ? svg(icons.next) : null
      );
    };

    return h(
      "section",
      { class: "card route-card", "aria-label": `${fromName} to ${toName}` },
      h(
        "div",
        { class: `rc-ends${nameSize(fromName, toName)}` },
        h("div", { class: "rc-end" }, h("span", { class: "rc-code", text: r.from }), h("strong", { class: "display", text: fromName })),
        h("div", { class: "rc-mid", "aria-hidden": "true" }, h("i"), h("b")),
        h("div", { class: "rc-end to" }, h("span", { class: "rc-code", text: r.to }), h("strong", { class: "display", text: toName }))
      ),
      h(
        "div",
        { class: "rc-meta" },
        step(-1),
        h(
          "div",
          { class: "rc-when" },
          h("strong", { text: r.date === today() ? `Today · ${shortDay(r.date)}` : shortDay(r.date) }),
          h("span", { text: r.time ? `Leaving after ${r.time}` : "Any time of day" })
        ),
        step(1)
      )
    );
  }

  function skeleton() {
    const bar = (w, ht) => h("span", { class: "skel", vars: { width: w, height: ht } });
    return h(
      "div",
      { class: "train-list", "aria-hidden": "true" },
      [0, 1, 2].map((i) =>
        h("div", { class: "tcard skel-card", vars: { "--i": String(i) } }, bar("70%", "28px"), bar("55%", "14px"), bar("40%", "14px"))
      )
    );
  }

  function dayDots(runDays) {
    if (runDays.length === 7) return h("span", { class: "chip ok", text: "Daily" });
    if (!runDays.length) return null;
    return h(
      "span",
      { class: "tc-days", role: "img", "aria-label": `Runs ${runDays.join(", ")}` },
      DAYS.map((d) => h("b", { class: runDays.includes(d) ? "on" : "", text: d[0] }))
    );
  }

  function trainCard(t, r, i, flags) {
    const nextDay = Math.round((Date.parse(`${t.arr.slice(0, 10)}T00:00:00Z`) - Date.parse(`${t.dep.slice(0, 10)}T00:00:00Z`)) / 86400000);
    const left = r.date === today() && Date.parse(t.dep) < Date.now();
    const canTrack = trackable(t.startDate);
    const fromName = stationName(t.from.code, t.from.name);
    const toName = stationName(t.to.code, t.to.name);
    const premium = (t.name.match(PREMIUM) || [])[1];

    const tags = [];
    if (premium) tags.push(h("span", { class: "chip accent", text: premium }));
    if (t.special) tags.push(h("span", { class: "chip info", text: "Special" }));
    tags.push(dayDots(t.runDays));
    if (t.onTimeRating != null && t.onTimeRating >= 8) tags.push(h("span", { class: "chip ok", text: "Usually on time" }));
    else if (t.onTimeRating != null && t.onTimeRating <= 3) tags.push(h("span", { class: "chip late", text: "Often late" }));
    if (t.from.code !== r.from) tags.push(h("span", { class: "chip info", text: `From ${fromName}` }));
    if (t.to.code !== r.to) tags.push(h("span", { class: "chip info", text: `To ${toName}` }));

    let foot;
    let spoken;
    if (canTrack) {
      spoken = left ? "On its way. Track live." : "Track live.";
      foot = h(
        "span",
        { class: "tc-go" },
        left ? h("i", { class: "live-dot", "aria-hidden": "true" }) : null,
        left ? `Left at ${clock(t.dep)} · Track live` : "Track live",
        svg(icons.next)
      );
    } else if (t.startDate > today()) {
      spoken = `Live tracking opens ${longDate(t.startDate)}, the day its run starts.`;
      foot = h("span", { class: "tc-later" }, svg(icons.clock), `Live from ${shortDay(t.startDate)}, when its run starts`);
    } else {
      spoken = "Too long ago to track live.";
      foot = h("span", { class: "tc-later" }, svg(icons.clock), "Too long ago to track live");
    }

    const body = [
      flags.length ? h("span", { class: "tc-flags" }, flags.map((f) => h("span", { class: `chip ${f.cls}`, text: f.text }))) : null,
      h(
        "span",
        { class: "tc-times" },
        h("span", { class: "tc-t" }, clock(t.dep)),
        h("span", { class: "tc-line" }, h("i"), h("b", { text: duration(t.durationMin * 60000) }), h("i")),
        h("span", { class: "tc-t" }, clock(t.arr), nextDay > 0 ? h("sup", { text: `+${nextDay}` }) : null)
      ),
      h("span", { class: "tc-codes" }, h("span", { text: t.from.code }), h("span", { text: t.to.code })),
      h("span", { class: "tc-name" }, h("span", { class: "tc-no tn", text: t.number }), h("span", { text: t.name })),
      h("span", { class: "tc-tags" }, tags),
      h("span", { class: "tc-foot" }, foot),
    ];
    const label =
      `${t.number} ${t.name}. Leaves ${fromName} at ${clock(t.dep)}, reaches ${toName} at ${clock(t.arr)}` +
      `${nextDay === 1 ? " the next day" : nextDay > 1 ? ` ${nextDay} days later` : ""}. ${duration(t.durationMin * 60000)}. ` +
      `${flags.map((f) => f.text).join(". ")}${flags.length ? ". " : ""}${spoken}`;

    if (!canTrack)
      return h("li", {}, h("div", { class: "tcard muted", vars: { "--i": String(i) }, role: "group", "aria-label": label }, body));
    const href = `?m=train&no=${t.number}&d=${t.startDate}&s=${t.to.code}`;
    return h(
      "li",
      {},
      h(
        "a",
        {
          class: "tcard",
          href,
          vars: { "--i": String(i) },
          "aria-label": label,
          on: {
            click: (e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              navigate({ m: "train", no: t.number, d: t.startDate, s: t.to.code }, { state: { from: "results" } });
            },
          },
        },
        body
      )
    );
  }

  function otherCard(o, r, i) {
    const [, max] = routeRange();
    const go = o.nextDate && o.nextDate <= max && o.nextDate !== r.date;
    return h(
      "li",
      { class: "ocard", vars: { "--i": String(i) } },
      h(
        "div",
        { class: "oc-main" },
        h("span", { class: "tc-name" }, h("span", { class: "tc-no tn", text: o.number }), h("span", { text: o.name })),
        h(
          "span",
          { class: "oc-meta" },
          o.depTime && o.arrTime ? h("span", { class: "tn" }, `${o.depTime} → ${o.arrTime}`, o.arrDay > 0 ? h("sup", { class: "plus", text: `+${o.arrDay}` }) : null) : null,
          dayDots(o.runDays)
        )
      ),
      go
        ? h(
            "button",
            {
              type: "button",
              class: "oc-next",
              "aria-label": `Show trains on ${longDate(o.nextDate)}, when ${o.number} next runs`,
              on: { click: () => navigate({ m: "train", from: r.from, to: r.to, d: o.nextDate, t: r.time }, { replace: true, instant: true }) },
            },
            h("span", { text: `Next ${weekday(o.nextDate)}` }),
            svg(icons.next)
          )
        : null
    );
  }

  function paint() {
    const { r, data } = current;
    const nodes = [head(r, data)];
    const trains = data.trains || [];
    const others = data.others || [];
    const tMin = minutesOf(r.time);
    const isToday = r.date === today();

    if (!trains.length) {
      nodes.push(
        h(
          "div",
          { class: "empty compact" },
          svg(art.empty),
          h("h2", { class: "display", text: others.length ? `No trains on ${shortDay(r.date)}` : "No direct trains here" }),
          h("p", {
            text: others.length
              ? "These trains run on this route on other days. Pick one to jump to its next run."
              : `We couldn't find a direct train from ${nameOf(r.from, data, "from")} to ${nameOf(r.to, data, "to")}. Try a bigger station nearby.`,
          }),
          others.length ? null : h("button", { type: "button", class: "cta secondary", text: "Change stations", on: { click: () => editSearch() } })
        )
      );
    } else {
      // Badges that help pick: the next one out, and the fastest.
      const flags = new Map();
      const add = (t, f) => t && flags.set(t.number, [...(flags.get(t.number) || []), f]);
      if (isToday) add(trains.find((t) => Date.parse(t.dep) > Date.now() && (tMin == null || minutesOf(clock(t.dep)) >= tMin)), { cls: "accent", text: "Next to leave" });
      if (trains.length >= 3) {
        const fastest = trains.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
        if (trains.filter((t) => t.durationMin === fastest.durationMin).length === 1) add(fastest, { cls: "info", text: "Fastest" });
      }

      const earlier = tMin == null ? [] : trains.filter((t) => minutesOf(clock(t.dep)) < tMin);
      const later = trains.filter((t) => !earlier.includes(t));
      const showEarlier = current.expanded || !later.length;
      const noneLater = !later.length && earlier.length;

      nodes.push(
        h(
          "p",
          { class: "rc-count" },
          h("strong", { text: `${trains.length} train${trains.length > 1 ? "s" : ""}` }),
          later.length && earlier.length ? ` · ${later.length} after ${r.time}` : "",
          h("span", { text: "Sorted by departure" })
        )
      );
      if (noneLater)
        nodes.push(
          h("div", { class: "banner info", role: "note" }, svg(icons.info), h("span", { text: `Nothing leaves after ${r.time} that day. Here's what leaves earlier.` }))
        );

      const list = h("ol", { class: "train-list", "aria-label": "Trains" });
      let i = 0;
      if (earlier.length && !showEarlier) {
        list.append(
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: "fold-btn",
                "aria-expanded": "false",
                on: {
                  click: () => {
                    current.expanded = true;
                    const y = window.scrollY;
                    paint();
                    window.scrollTo({ top: y, behavior: "instant" });
                    root.querySelector(".tcard")?.focus({ preventScroll: true });
                  },
                },
              },
              svg(icons.up),
              `${earlier.length} earlier train${earlier.length > 1 ? "s" : ""}, before ${r.time}`
            )
          )
        );
      }
      for (const t of showEarlier ? trains : later) list.append(trainCard(t, r, i++, flags.get(t.number) || []));
      nodes.push(list);
    }

    if (others.length) {
      // A short list is enough to show the route has other trains; the rest is a tap away.
      const showAll = current.othersOpen || others.length <= 4;
      const shown = showAll ? others : others.slice(0, 3);
      nodes.push(
        h("h2", { class: "section-title display", text: `Not running ${weekday(r.date)}` }),
        h("ol", { class: "other-list", "aria-label": `Trains on this route that don't run on ${longDate(r.date)}` }, shown.map((o, k) => otherCard(o, r, k)))
      );
      if (!showAll)
        nodes.push(
          h(
            "button",
            {
              type: "button",
              class: "fold-btn quiet",
              "aria-expanded": "false",
              on: {
                click: () => {
                  current.othersOpen = true;
                  const y = window.scrollY;
                  paint();
                  window.scrollTo({ top: y, behavior: "instant" });
                },
              },
            },
            svg(icons.down),
            `${others.length - 3} more not running ${weekday(r.date)}`
          )
        );
    }

    nodes.push(
      h(
        "footer",
        { class: "status-foot" },
        h("p", { class: "legend-note", text: "Scheduled times from the published timetable. Tap a train to see where it is right now." }),
        footer()
      )
    );
    root.replaceChildren(...nodes);
    root.setAttribute("aria-busy", "false");
    restoreStepFocus(true);
  }

  function restoreStepFocus(done) {
    if (!focusStep) return;
    const btn = root.querySelector(`.day-step.${focusStep}`);
    (btn && !btn.disabled ? btn : root.querySelector(".day-step:not(:disabled)"))?.focus({ preventScroll: true });
    if (done) focusStep = null;
  }

  function paintError(err) {
    const { r } = current;
    const tryAgain = { label: "Try again", run: () => load(true) };
    const edit = { label: "Change search", secondary: true, run: editSearch };
    const map = {
      offline: ["You're offline", "Check your connection. This page tries again by itself the moment you're back.", [tryAgain]],
      invalid_station: ["We couldn't use those stations", err.message, [edit]],
      same_station: ["From and To are the same", "Pick two different stations.", [edit]],
      invalid_date: ["That date doesn't look right", err.message, [edit]],
      date_out_of_range: ["That date is out of range", err.message, [edit]],
      rate_limited: ["That's a lot of searching", "Give it a minute, then try again.", [tryAgain, edit]],
      // The page is newer than its data service: route search goes live once the Worker is updated.
      not_found: ["Train search is almost ready", "Finding trains by station is still being switched on. Search by train number for now.", [
        { label: "Search by train number", run: () => navigate({ m: "train" }) },
      ]],
      forbidden: ["This page can't reach live data", "The site isn't connected to its data service yet.", []],
      not_configured: ["This page can't reach live data", "The site isn't connected to its data service yet.", []],
    };
    const [t, b, actions] = map[err.code] || [
      "Timetables are taking a moment",
      "The timetable service didn't answer in time. It usually clears within a minute.",
      [tryAgain, edit],
    ];
    root.replaceChildren(
      head(r, null),
      h("div", { class: "empty compact", role: "alert" }, h("span", { class: "err-icon" }, svg(err.code === "offline" ? icons.offline : icons.signal)), h("h2", { class: "display", text: t }), h("p", { text: b })),
      h(
        "div",
        { class: "actions" },
        actions.map((a) => h("button", { type: "button", class: `cta${a.secondary ? " secondary" : ""}`, text: a.label, on: { click: a.run } }))
      )
    );
    root.setAttribute("aria-busy", "false");
  }

  function editSearch() {
    const { r } = current;
    navigate({ m: "train", by: "route", from: r.from, to: r.to, d: r.date, t: r.time });
  }

  async function load(force = false) {
    const mine = ++token;
    const { r, key } = current;
    if (!force && memo.has(key)) {
      current.data = memo.get(key);
      return paint();
    }
    root.setAttribute("aria-busy", "true");
    root.replaceChildren(head(r, null), skeleton());
    restoreStepFocus(false);
    try {
      if (!navigator.onLine) throw new ApiError("offline", "You're offline.");
      const [data] = await Promise.all([
        api("/api/between", { from: r.from, to: r.to, date: r.date }, { timeout: 15000, retries: 1 }),
        loadStations().catch(() => null), // names read better than codes, if they're ready in time
      ]);
      if (mine !== token) return;
      memo.set(key, data);
      current.data = data;
      paint();
    } catch (err) {
      if (mine !== token) return;
      paintError(err instanceof ApiError ? err : new ApiError("network", "Could not reach live data."));
    }
  }

  window.addEventListener("online", () => {
    if (current && !current.data && !root.closest("[hidden]")) load(true);
  });

  return {
    /** Show a search. Returns the scroll position to restore, if coming back to it. */
    open(r, { pop = false } = {}) {
      const key = keyOf(r);
      const same = current && current.key === key;
      const keepScroll = pop && same ? current.scrollY : 0;
      current = { key, r, data: null, expanded: same ? current.expanded : false, othersOpen: same ? current.othersOpen : false, scrollY: 0 };
      load();
      return keepScroll;
    },
    leave(scrollY) {
      if (current) current.scrollY = scrollY;
    },
    swap() {
      if (!current) return;
      const { r } = current;
      navigate({ m: "train", from: r.to, to: r.from, d: r.date, t: r.time }, { instant: true });
      toast("Showing the return journey");
    },
  };
}
