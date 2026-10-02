import { h, svg, $, todayIn, addDays, longDate, dayLabel, relativeDay, prefersReducedMotion, isDarkTheme, ago, IST } from "./util.js";
import { icons, art } from "./icons.js";
import { api, weatherAt, ApiError } from "./api.js";
import { createFlipDate } from "./flip.js";
import { createLoader } from "./loader.js";
import { renderShareImage } from "./share-card.js";
import { renderTrain } from "./train.js";
import { renderFlight } from "./flight.js";
import { installWay, installPlace, appleGuide, onInstallChange, promptInstall } from "./install.js";
import { guideArt } from "./guide.js";
import { createRoutePanel, createResults, routeRange } from "./finder.js";
import { createFlightResults, flightRouteRange } from "./flight-finder.js";

const today = () => todayIn(IST);
const THEME_LABEL = { light: "Light", dark: "Dark", auto: "Match device" };
const THEME_ICON = { light: "themeLight", dark: "themeDark", auto: "themeAuto" };
const CHAI_URL = "https://buymeacoffee.com/parth8"; // swap for your UPI link later
const INSTALL_NOTE = { home: "add the app to your home screen", dock: "add the app to your Dock", desktop: "install the app" };
const fmtFlight = (no) => no.replace(/^([A-Z0-9]{2})(\d)/, "$1 $2");

const MODES = {
  train: {
    title: "Which train?",
    label: "Train number",
    placeholder: "12786",
    hint: "5 digits, like 12786.",
    inputmode: "numeric",
    maxlength: 5,
    clean: (v) => v.replace(/\D/g, "").slice(0, 5),
    check: (v) => {
      const d = v.replace(/\D/g, "");
      if (!d) return "Enter your train's 5-digit number, like 12786.";
      if (d.length !== 5) return `Train numbers have exactly 5 digits. That one has ${d.length}.`;
      return null;
    },
    dateQ: "When did it leave its first station?",
    dateHelp: "Pick the day it started its run, even if you board later. Not sure? Use From and to above, and we'll work it out.",
    cta: "Check live status",
    range: () => [addDays(today(), -3), today()],
    refreshMs: () => 30000,
    // Finding a train by its stations instead of its number
    route: {
      dateQ: "When do you board?",
      dateHelp: "The day you get on at your From station.",
      cta: "Find trains",
      range: routeRange,
    },
  },
  flight: {
    title: "Which flight?",
    label: "Flight number",
    placeholder: "6E 6252",
    hint: "Airline code and number, like 6E 6252. The space is optional.",
    inputmode: "text",
    maxlength: 8,
    // "6e6252" becomes "6E 6252" as you type
    clean: (v) => {
      const x = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
      return x.length > 2 ? `${x.slice(0, 2)} ${x.slice(2)}` : x;
    },
    check: (v) => {
      const x = v.replace(/\s/g, "");
      if (!x) return "Enter a flight number, like 6E 6252.";
      if (/^\d+$/.test(x)) return "Add the airline's 2-character code first. For example 6E 6252 or AI 101.";
      if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(x)) return "That doesn't look like a flight number. Try something like 6E 6252 or AI 101.";
      return null;
    },
    dateQ: "Departure date",
    dateHelp: "Local date at the airport the flight leaves from. Don't know the number? Use From and to above.",
    cta: "Track flight",
    range: () => [addDays(today(), -2), addDays(today(), 7)],
    // live position is free, so refresh often while airborne; schedules change slowly
    refreshMs: (data) => (data?.status?.phase === "air" ? 30000 : 90000),
    route: {
      dateQ: "When do you fly?",
      dateHelp: "Local date at the airport you leave from.",
      cta: "Find flights",
      range: flightRouteRange,
    },
  },
};
const BY_LABEL = { train: ["Train number", "Find your train by"], flight: ["Flight number", "Find your flight by"] };

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

const views = { home: $("#view-home"), search: $("#view-search"), status: $("#view-status"), results: $("#view-results") };
const form = $("#search-form");
const qInput = $("#q");
const qError = $("#q-error");
const statusRoot = $("#status-root");
const toastEl = $("#toast");
const jumpBtn = $("#jump");
const sources = $("#sources");
let flip = null;
let session = null;
let prefill = null; // number and date carried back from the status screen
let routePanel = null; // created the first time the route finder opens
const byToggle = $("#by-toggle");

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

$("#art-train").append(svg(art.train));
$("#art-flight").append(svg(art.plane));
for (const el of document.querySelectorAll("[data-icon]")) el.prepend(svg(icons[el.dataset.icon]));

const hour = new Date().getHours();
$("#greet").textContent = hour < 5 ? "Hello, night owl" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

for (const card of document.querySelectorAll(".mode-card")) {
  card.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate({ m: card.dataset.mode }, { from: card });
  });
}

$("#search-back").addEventListener("click", (e) => {
  e.preventDefault();
  navigate({}, { back: true });
});

// Train number, or From and To. Switching keeps whatever was already filled in.
for (const btn of byToggle.querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    const r = current();
    const by = btn.dataset.by;
    if (by === r.by) return;
    prefill = { mode: r.mode, no: qInput.value.replace(/\s/g, ""), date: flip?.value, ...(routePanel ? routePanel.values() : {}) };
    navigate({ m: r.mode, by: by === "route" ? "route" : null }, { replace: true, instant: true, keepFocus: true });
  });
}
byToggle.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const other = byToggle.querySelector('[aria-checked="false"]');
  other.click();
  other.focus();
});

const resultsOpts = {
  root: $("#results-root"),
  title: $("#results-title"),
  sub: $("#results-sub"),
  navigate,
  toast: (m) => toast(m),
  footer: () => h("div", { class: "foot-stack" }, h("button", { type: "button", class: "link-quiet", "data-open": "sources", text: "Sources and credits" }), credit()),
};
// Trains and flights share the results screen; each mode has its own list behind it.
const resultsBy = { train: createResults(resultsOpts), flight: createFlightResults(resultsOpts) };
const results = { redraw: () => Object.values(resultsBy).forEach((x) => x.redraw()) };
$("#results-back").addEventListener("click", (e) => {
  e.preventDefault();
  const r = current();
  navigate({ m: r.mode, by: "route", from: r.from, to: r.to, d: r.date, t: r.time });
});
$("#results-swap").addEventListener("click", () => resultsBy[current().mode]?.swap());

qInput.addEventListener("input", () => {
  const mode = MODES[current().mode];
  const cleaned = mode.clean(qInput.value);
  if (cleaned !== qInput.value) qInput.value = cleaned;
  qInput.removeAttribute("aria-invalid");
  qError.hidden = true;
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const { mode, by } = current();
  if (by === "route") {
    const v = routePanel.validate();
    if (v) navigate({ m: mode, from: v.from, to: v.to, d: flip.value, t: v.time });
    return;
  }
  const problem = MODES[mode].check(qInput.value.trim());
  if (problem) {
    qInput.setAttribute("aria-invalid", "true");
    qError.textContent = problem;
    qError.hidden = false;
    qInput.focus();
    return;
  }
  navigate({ m: mode, no: qInput.value.replace(/\s/g, ""), d: flip.value });
});

document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-open='sources']");
  if (opener) {
    e.preventDefault();
    sources.showModal();
  }
});
$("#sources-close").addEventListener("click", () => sources.close());
sources.addEventListener("click", (e) => {
  if (e.target === sources) sources.close();
});

window.addEventListener("popstate", () => route({ pop: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session?.data && Date.now() - session.loadedAt > MODES[session.mode].refreshMs(session.data)) load({ silent: true });
});
window.addEventListener("online", () => {
  if (session?.error) retryNow();
});

$("#home-credit").append(credit());

// The add-to-home-screen button shows only where this browser can actually add it.
const syncInstall = (way) => {
  const was = document.documentElement.dataset.install;
  if (way) document.documentElement.dataset.install = way;
  else delete document.documentElement.dataset.install;
  if (way === was) return;
  // An open panel keeps up: written steps become the one-tap button the moment the browser allows it.
  const open = [...document.querySelectorAll(".install.open")];
  if (!open.length) return;
  if (!way) {
    open.forEach((b) => b.set(false));
    toast(installPlace === "home" ? "Track is on your home screen" : "Track is installed");
    return;
  }
  for (const b of open) {
    const hadFocus = b.contains(document.activeElement);
    b.refill();
    if (way === "prompt" && hadFocus) b.querySelector(".support-btn")?.focus();
  }
  if (way === "prompt") toast("One-tap install is ready");
};
syncInstall(installWay());
onInstallChange(syncInstall);

// Floating chai and install buttons (desktop only; phones get inline ones above the signature)
const chaiFloat = chai("float");
const installFloat = install("float");
const floats = [chaiFloat, installFloat];
document.body.append(chaiFloat, installFloat);
document.addEventListener("click", (e) => {
  for (const f of floats) if (f.classList.contains("open") && !f.contains(e.target)) f.set(false);
});
if (window.matchMedia("(min-width: 720px)").matches) {
  // Each one says hello once, chai first, and only if nobody has touched either yet.
  const peek = (f, delay) =>
    setTimeout(() => {
      if (document.hidden || getComputedStyle(f).display === "none" || floats.some((o) => o.dataset.touched || o.classList.contains("open"))) return;
      f.set(true);
      setTimeout(() => !f.dataset.touched && f.set(false, { slow: true }), 6000);
    }, delay);
  peek(chaiFloat, 3500);
  peek(installFloat, 12000);
}
setupTheme();
setupClock();
route();

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

function setupTheme() {
  $("#theme-btn").addEventListener("click", () => {
    const order = ["light", "dark", "auto"];
    const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length];
    setTheme(next);
    toast(`Appearance: ${THEME_LABEL[next]}`);
  });
  for (const b of document.querySelectorAll("#theme-seg button")) {
    b.prepend(svg(icons[THEME_ICON[b.dataset.theme]]));
    b.addEventListener("click", () => setTheme(b.dataset.theme));
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.theme === "auto") themeChanged();
  });
  syncThemeUI();
}

/** 12- or 24-hour times. Stored like the theme; theme.js applies it before first paint. */
function setupClock() {
  const sync = () => {
    for (const b of document.querySelectorAll("#clock-seg button")) b.setAttribute("aria-checked", String(b.dataset.clock === document.documentElement.dataset.clock));
  };
  for (const b of document.querySelectorAll("#clock-seg button")) {
    b.addEventListener("click", () => {
      if (document.documentElement.dataset.clock === b.dataset.clock) return;
      document.documentElement.dataset.clock = b.dataset.clock;
      try {
        localStorage.setItem("clock", b.dataset.clock);
      } catch {
        /* private mode: the choice lasts for this visit */
      }
      sync();
      // Redraw whatever is showing times right now.
      if (session?.data && !statusRoot.closest("[hidden]")) paint();
      results?.redraw();
    });
  }
  sync();
}

function setTheme(choice) {
  document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem("theme", choice);
  } catch {
    /* private mode: the choice lasts for this visit */
  }
  themeChanged();
}

function themeChanged() {
  syncThemeUI();
  // Map colours are baked in when it loads, so redraw an open map.
  if (session?.data && session.mapCtl) {
    session.mapCtl.destroy();
    session.mapCtl = null;
    session.mapEl = null;
    paint();
  }
}

function syncThemeUI() {
  const c = document.documentElement.dataset.theme || "light";
  const btn = $("#theme-btn");
  btn.replaceChildren(svg(icons[THEME_ICON[c]]));
  btn.setAttribute("aria-label", `Appearance: ${THEME_LABEL[c]}. Tap to change.`);
  for (const b of document.querySelectorAll("#theme-seg button")) b.setAttribute("aria-checked", String(b.dataset.theme === c));
  $('meta[name="theme-color"]').setAttribute("content", isDarkTheme() ? "#16181d" : "#faf7f2");
}

/* ------------------------------------------------------------------ */
/* Routing: the URL is the only state                                  */
/* ------------------------------------------------------------------ */

function current() {
  const p = new URLSearchParams(location.search);
  const m = p.get("m");
  const code = (k) => ((p.get(k) || "").toUpperCase().match(/^[A-Z]{1,5}$/) || [""])[0];
  return {
    mode: m === "train" || m === "flight" ? m : null,
    no: (p.get("no") || "").toUpperCase(),
    date: p.get("d") || "",
    stop: (p.get("s") || "").toUpperCase(),
    by: p.get("by") === "route" ? "route" : "number",
    from: code("from"),
    to: code("to"),
    time: /^\d{2}:\d{2}$/.test(p.get("t") || "") ? p.get("t") : "",
  };
}

function navigate(params, opts = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  if (!views.results.hidden) resultsBy[document.body.dataset.mode]?.leave(window.scrollY); // so Back lands where you were
  history[opts.replace ? "replaceState" : "pushState"](opts.state || null, "", qs ? `?${qs}` : location.pathname);
  route(opts);
}

function backToSearch() {
  const r = current();
  prefill = { mode: r.mode, no: r.no, date: r.date };
  navigate({ m: r.mode });
}

function route(opts = {}) {
  const r = current();
  const isResults = !!(r.mode && r.from && r.to && r.by !== "route");
  const target = !r.mode ? "home" : r.no ? "status" : isResults ? "results" : "search";
  const apply = () => {
    for (const [name, el] of Object.entries(views)) el.hidden = name !== target;
    document.body.dataset.mode = r.mode || "home";
    if (target !== "status") stopSession();
    let scrollTo = 0;
    if (target === "search") setupSearch(r);
    if (target === "status") openStatus(r);
    if (target === "results") {
      const other = r.mode === "train" ? "flight" : "train";
      resultsBy[other].pause();
      scrollTo = resultsBy[r.mode].open({ ...r, date: validRouteDate(r.date, r.mode) }, { pop: opts.pop });
    }
    if (target === "home") document.title = "Track a train or flight";
    if (!opts.keepFocus) views[target].querySelector("[data-focus]")?.focus({ preventScroll: true });
    window.scrollTo({ top: scrollTo, behavior: "instant" });
  };

  if (!document.startViewTransition || prefersReducedMotion() || opts.instant) return apply();

  // The tapped card grows into the search screen, and shrinks back on the way home.
  const card = opts.from || (opts.back ? document.querySelector(`.mode-card[data-mode="${document.body.dataset.mode}"]`) : null);
  const surface = views.search;
  if (card && !opts.back) card.style.viewTransitionName = "mode-surface";
  if (opts.back) surface.style.viewTransitionName = "mode-surface";
  const t = document.startViewTransition(() => {
    apply();
    if (card && !opts.back) {
      card.style.viewTransitionName = "";
      surface.style.viewTransitionName = "mode-surface";
    }
    if (opts.back && card) {
      surface.style.viewTransitionName = "";
      card.style.viewTransitionName = "mode-surface";
    }
  });
  t.finished.finally(() => {
    surface.style.viewTransitionName = "";
    if (card) card.style.viewTransitionName = "";
  });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/** A route search date inside the allowed window, or today. */
function validRouteDate(d, mode = "train") {
  const [min, max] = mode === "flight" ? flightRouteRange() : routeRange();
  return /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d >= min && d <= max ? d : today();
}

function setupSearch(r) {
  const byRoute = r.by === "route" && !!MODES[r.mode]?.route;
  const cfg = byRoute ? { ...MODES[r.mode], ...MODES[r.mode].route } : MODES[r.mode];
  $("#search-title").textContent = cfg.title;
  $("#q-label").textContent = cfg.label;
  $("#q-hint").textContent = cfg.hint;
  $("#date-q").textContent = cfg.dateQ;
  $("#date-help").textContent = cfg.dateHelp;
  $("#cta-text").textContent = cfg.cta;

  document.title = byRoute ? (r.mode === "flight" ? "Find flights between airports" : "Find trains between stations") : r.mode === "flight" ? "Track a flight" : "Track a train";
  byToggle.hidden = !MODES[r.mode]?.route;
  const [numberLabel, groupLabel] = BY_LABEL[r.mode] || BY_LABEL.train;
  $("#by-number-label").textContent = numberLabel;
  byToggle.setAttribute("aria-label", groupLabel);
  byToggle.dataset.by = byRoute ? "route" : "number";
  for (const b of byToggle.querySelectorAll("button")) {
    const on = b.dataset.by === byToggle.dataset.by;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const show = (el, on) => {
    if (on && el.hidden) {
      el.classList.remove("panel-in");
      void el.offsetWidth;
      el.classList.add("panel-in");
    }
    el.hidden = !on;
  };
  show($("#panel-number"), !byRoute);
  show($("#panel-route"), byRoute);
  show($("#time-set"), byRoute);
  qInput.placeholder = cfg.placeholder;
  qInput.inputMode = cfg.inputmode;
  qInput.maxLength = cfg.maxlength;
  qInput.autocapitalize = r.mode === "flight" ? "characters" : "off";
  const carry = prefill && prefill.mode === r.mode ? prefill : null;
  prefill = null;
  qInput.value = carry?.no ? cfg.clean(carry.no) : "";
  qInput.removeAttribute("aria-invalid");
  qError.hidden = true;

  if (byRoute) {
    routePanel ||= createRoutePanel();
    routePanel.reset({ from: carry?.from || r.from, to: carry?.to || r.to, time: carry?.time || r.time, kind: r.mode });
  }

  const [min, max] = cfg.range();
  const wanted = carry?.date || r.date;
  const start = wanted && wanted >= min && wanted <= max ? wanted : today() > max ? max : today();
  const readout = (v) => {
    $("#date-long").textContent = longDate(v);
    $("#date-rel").textContent = relativeDay(v, today());
    if (byRoute) routePanel.onDate(v);
  };
  flip = createFlipDate($("#flip"), { value: start, min, max, onChange: readout });
  readout(start);
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function stopSession() {
  if (!session) return;
  clearTimeout(session.timer);
  clearInterval(session.retryTick);
  session.loader?.destroy();
  session.io?.disconnect();
  session.mapCtl?.destroy();
  jumpBtn.classList.remove("show");
  session = null;
}

function openStatus(r) {
  const same = session && session.mode === r.mode && session.no === r.no && session.date === r.date;
  if (same) {
    session.stop = r.stop;
    if (session.data) paint();
    return;
  }
  stopSession();
  session = { ...r, data: null, error: null, loadedAt: 0, foldOpen: false, mapCtl: null, mapEl: null, loader: null };
  $("#status-title").textContent = r.mode === "train" ? `Train ${r.no}` : fmtFlight(r.no);
  $("#status-sub").textContent = longDate(r.date || today());
  load();
}

$("#status-back").addEventListener("click", (e) => {
  e.preventDefault();
  // Opened from a route search: go back to that list, where you were.
  if (history.state?.from === "results") history.back();
  else backToSearch();
});
$("#status-refresh").addEventListener("click", () => (session?.data ? load({ manual: true }) : retryNow()));
$("#status-share").addEventListener("click", share);
jumpBtn.addEventListener("click", () => session?.currentRow?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" }));

function showLoader(s) {
  s.loader?.destroy();
  s.loader = createLoader(s.mode, s.mode === "train" ? s.no : fmtFlight(s.no));
  const bar = (w, hgt) => {
    const el = h("span", { class: "skel" });
    el.style.width = w;
    el.style.height = hgt;
    return el;
  };
  statusRoot.setAttribute("aria-busy", "true");
  statusRoot.replaceChildren(
    s.loader.el,
    h("div", { class: "card skel-card", "aria-hidden": "true" }, bar("40%", "12px"), bar("65%", "26px"), bar("45%", "54px")),
    h("div", { class: "card skel-card", "aria-hidden": "true" }, [80, 60, 72].map((w) => bar(`${w}%`, "14px")))
  );
}

async function load({ silent = false, manual = false } = {}) {
  const s = session;
  if (!s) return;
  clearTimeout(s.timer);
  clearInterval(s.retryTick);
  const btn = $("#status-refresh");
  btn.classList.add("spinning");
  btn.setAttribute("aria-busy", "true");
  if (!s.data) showLoader(s);

  try {
    if (!navigator.onLine) throw new ApiError("offline", "You're offline.");
    const params = { no: s.no, date: s.date || today(), fresh: manual && s.mode === "train" ? "1" : null };
    const data = await api(`/api/${s.mode}`, params, { timeout: s.mode === "train" ? 25000 : 20000, retries: 1 });
    if (session !== s) return;
    if (s.loader) {
      await s.loader.finish();
      if (session !== s) return;
      s.loader.destroy();
      s.loader = null;
    }
    s.data = data;
    s.loadedAt = Date.now();
    s.error = null;
    paint();
    if (manual) toast("Updated just now");
  } catch (err) {
    if (session !== s) return;
    s.loader?.destroy();
    s.loader = null;
    s.error = err;
    if (s.data) showRefreshProblem(err, manual || !silent);
    else paintError(err);
  } finally {
    if (session === s) {
      btn.classList.remove("spinning");
      btn.removeAttribute("aria-busy");
      const phase = s.data?.status?.phase;
      const finished = (s.mode === "train" && phase === "arrived") || (s.mode === "flight" && ["landed", "cancelled"].includes(phase));
      if (s.data && !finished) s.timer = setTimeout(() => load({ silent: true }), MODES[s.mode].refreshMs(s.data));
    }
  }
}

function retryNow() {
  const s = session;
  if (!s) return;
  clearInterval(s.retryTick);
  load();
}

function paint() {
  const s = session;
  const before = new Map([...statusRoot.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.textContent]));
  const scrollY = window.scrollY;

  const view =
    s.mode === "train"
      ? renderTrain(s.data, {
          stop: s.stop,
          foldOpen: s.foldOpen,
          onPickStop: (code) => {
            const r = current();
            navigate({ m: r.mode, no: r.no, d: r.date, s: code }, { replace: true });
            const name = s.data.stops.find((x) => x.code === code)?.name;
            toast(name ? `${name} is now your stop` : "Your stop is updated");
            window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
          },
          onChangeStop: () => {
            const card = $("#timeline-card");
            if (!card) return;
            card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
            card.classList.add("picking");
            setTimeout(() => card.classList.remove("picking"), 2600);
          },
          onToggleFold: () => {
            s.foldOpen = true;
            paint();
          },
        })
      : renderFlight(s.data);

  // Keep one live map across refreshes so it never flickers.
  if (view.map) {
    if (s.mapEl) {
      view.map.el.replaceWith(s.mapEl);
      s.mapCtl?.update(view.map.opts);
    } else {
      s.mapEl = view.map.el;
      mountWhenVisible(s, view.map);
    }
  }

  const footer = h(
    "footer",
    { class: "status-foot" },
    s.mode === "train"
      ? h("p", { class: "legend-note", text: "Small grey times are scheduled. Bold times are actual, or expected for stops ahead. Running data is crowd-sourced and can shift." })
      : null,
    h("button", { type: "button", class: "link-quiet", "data-open": "sources", text: "Sources and credits" }),
    credit()
  );
  statusRoot.replaceChildren(view.node, footer);
  statusRoot.setAttribute("aria-busy", "false");

  for (const el of statusRoot.querySelectorAll("[data-k]")) {
    const old = before.get(el.dataset.k);
    if (old != null && old !== el.textContent && !prefersReducedMotion()) el.classList.add("tick");
  }
  if (before.size) window.scrollTo({ top: scrollY, behavior: "instant" });

  $("#status-sub").textContent = s.mode === "train" ? s.data.name : `${s.data.departure.code} to ${s.data.arrival.code}`;
  document.title = (s.mode === "train" ? `${s.no} ${s.data.name || ""}` : `${s.data.number} ${s.data.departure?.code}-${s.data.arrival?.code}`).trim();

  for (const w of view.weather || []) weatherAt(w.lat, w.lon).then(w.apply).catch(() => {});

  // Draw the share card in the background so tapping Share is instant.
  s.share = view.share;
  s.shareImage = null;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  idle(() => {
    if (session !== s || s.share !== view.share) return;
    s.shareImage = renderShareImage(view.share).catch(() => null);
  });

  s.currentRow = view.currentRow;
  s.io?.disconnect();
  if (view.currentRow && "IntersectionObserver" in window) {
    s.io = new IntersectionObserver(([entry]) => jumpBtn.classList.toggle("show", !entry.isIntersecting && window.scrollY > 300), { threshold: 0 });
    s.io.observe(view.currentRow);
  } else jumpBtn.classList.remove("show");
}

function mountWhenVisible(s, spec) {
  const start = async () => {
    try {
      const { mountMap } = await import("./map.js");
      if (session !== s) return;
      s.mapCtl = await mountMap(s.mapEl, spec.opts);
    } catch (e) {
      console.warn("map failed", e);
      s.mapEl.replaceChildren(h("p", { class: "map-note", text: "The map could not load. Everything else is up to date." }));
    }
  };
  if (!("IntersectionObserver" in window)) return start();
  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        io.disconnect();
        start();
      }
    },
    { rootMargin: "200px" }
  );
  io.observe(s.mapEl);
}

/* ------------------------------------------------------------------ */
/* Errors people can act on                                            */
/* ------------------------------------------------------------------ */

function describe(err, s) {
  const r = current();
  const [min, max] = MODES[s.mode].range();
  const date = r.date || today();
  const when = longDate(date);
  const short = (d) => dayLabel(`${d}T12:00:00+05:30`);
  const edit = { label: "Edit number or date", secondary: true, run: backToSearch };
  const tryNow = { label: "Try again now", run: retryNow };
  const goDate = (d) => ({ label: s.mode === "train" ? `Try the run that started ${short(d)}` : `Try ${short(d)}`, run: () => navigate({ m: r.mode, no: r.no, d }) });
  const isTrain = s.mode === "train";

  switch (err.code) {
    case "offline":
      return {
        icon: icons.offline,
        title: "You're offline",
        body: "Check your internet connection. This page will load by itself the moment you're back.",
        actions: [tryNow],
      };
    case "not_found": {
      if (isTrain) {
        const prev = addDays(date, -1);
        return {
          art: art.empty,
          title: `No run of train ${s.no} on ${when}`,
          body: "It may not run that day, or the number has a typo. Long-distance trains often start the day before you board.",
          actions: [prev >= min ? goDate(prev) : null, edit],
        };
      }
      const prev = addDays(date, -1);
      const next = addDays(date, 1);
      return {
        icon: icons.plane2,
        title: `No ${fmtFlight(s.no)} on ${when}`,
        body: "Check the date. It's the departure date, in local time at the airport the flight leaves from.",
        actions: [prev >= min ? goDate(prev) : null, next <= max ? { ...goDate(next), secondary: true } : null, edit],
      };
    }
    case "invalid_train":
    case "invalid_flight":
    case "invalid_date":
    case "date_out_of_range":
      return { icon: icons.info, title: "That doesn't look quite right", body: err.message, actions: [edit] };
    case "rate_limited":
      return {
        icon: icons.timer,
        title: "That's a lot of checking",
        body: "You've refreshed quite a bit in the last minute. Take a breath, we'll try again by ourselves.",
        retryIn: 60,
        actions: [edit],
      };
    case "quota_exhausted":
      return {
        icon: icons.plane2,
        title: "Flight lookups are out for this month",
        body: "Flights run on a free data plan with a monthly limit, and it's used up. It resets at the start of next month. Trains aren't affected.",
        actions: [{ label: "Track a train instead", run: () => navigate({ m: "train" }) }],
      };
    case "flights_not_configured":
      return {
        icon: icons.plane2,
        title: "Flights are almost ready",
        body: "Flight tracking isn't switched on for this site yet. Train tracking works right now.",
        actions: [{ label: "Track a train instead", run: () => navigate({ m: "train" }) }],
      };
    case "forbidden":
    case "not_configured":
      return {
        icon: icons.info,
        title: "This page can't reach live data",
        body: "The site isn't connected to its data service yet. If this is your site, check ALLOWED_ORIGINS in the Worker settings.",
        actions: [],
      };
    case "timeout":
    case "network":
    case "upstream_unavailable":
      return {
        icon: icons.signal,
        title: "Live data is taking a moment",
        body: isTrain
          ? "The railway feeds didn't answer in time. It happens at busy hours and usually clears within a minute."
          : "The flight data service didn't answer in time. It usually clears within a minute.",
        retryIn: 30,
        actions: [tryNow, edit],
      };
    default:
      return {
        icon: icons.info,
        title: "Something went sideways",
        body: "We hit an unexpected snag on our side. Trying again usually fixes it.",
        retryIn: 30,
        actions: [tryNow, edit],
      };
  }
}

function paintError(err) {
  const s = session;
  const d = describe(err, s);
  const visual = d.art ? svg(d.art) : h("span", { class: "err-icon" }, svg(d.icon));
  const empty = h("div", { class: "empty", role: "alert" }, visual, h("h2", { class: "display", text: d.title }), h("p", { text: d.body }));

  if (d.retryIn) {
    const ring = h("span", { class: "retry-ring", "aria-hidden": "true" });
    const label = h("span", { text: `Trying again in ${d.retryIn}s` });
    empty.append(h("p", { class: "retry-note" }, ring, label));
    let left = d.retryIn;
    s.retryTick = setInterval(() => {
      left -= 1;
      ring.style.setProperty("--k", String(left / d.retryIn));
      label.textContent = left > 0 ? `Trying again in ${left}s` : "Trying again now";
      if (left <= 0) retryNow();
    }, 1000);
  }

  const actions = d.actions
    .filter(Boolean)
    .map((a) => h("button", { type: "button", class: `cta${a.secondary ? " secondary" : ""}`, text: a.label, on: { click: a.run } }));
  statusRoot.setAttribute("aria-busy", "false");
  statusRoot.replaceChildren(empty, h("div", { class: "actions" }, actions));
}

function showRefreshProblem(err, loud) {
  statusRoot.querySelector(".refresh-banner")?.remove();
  const when = ago(new Date(session.loadedAt).toISOString());
  const text =
    err.code === "offline"
      ? `You're offline. Showing the update from ${when}. It refreshes when you're back online.`
      : `Couldn't refresh just now. Showing the update from ${when}. Trying again shortly.`;
  statusRoot.prepend(h("div", { class: "banner refresh-banner", role: "status" }, svg(icons.info), h("span", { text })));
  if (loud) toast("Couldn't refresh. Showing the last update.");
  session.timer = setTimeout(() => load({ silent: true }), err.code === "rate_limited" ? 60000 : 30000);
}

/* ------------------------------------------------------------------ */
/* Small things                                                        */
/* ------------------------------------------------------------------ */

/**
 * A round button that opens a small panel (chai, add to home screen).
 * kind: "float" (desktop corner) or "inline" (above the signature on phones).
 * fill() builds the panel's content each time it opens.
 */
function bubble(name, kind, { label, region, icon, fill, note }) {
  const btn = h("button", { type: "button", class: "bubble-btn", "aria-expanded": "false", "aria-controls": `${name}-${kind}`, "aria-label": label }, svg(icon));
  const close = h("button", { type: "button", class: "bubble-close", "aria-label": "Close" }, svg(icons.close));
  const panel = h("div", { class: "bubble-panel", id: `${name}-${kind}`, role: "region", "aria-label": region }, close);
  // A pencil note pointing at the button. Decorative: the button has its own label.
  const scribble = h("span", { class: "bubble-note", "aria-hidden": "true" }, svg(icons.scribbleArrow), svg(icons.scribbleDown), h("span", { text: note }));
  const root = h("div", { class: `bubble bubble-${kind} ${name}` }, panel, btn, scribble);
  root.refill = () => panel.replaceChildren(close, ...fill(root));
  root.set = (open, { slow = false } = {}) => {
    if (open) {
      root.refill();
      // inline bubbles share one row, so only one panel is open at a time
      for (const other of root.parentElement?.querySelectorAll(":scope > .bubble.open") || []) if (other !== root) other.set(false);
    }
    root.classList.toggle("fading", slow && !open);
    root.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
  };
  const touch = () => (root.dataset.touched = "1");
  btn.addEventListener("click", () => (touch(), root.set(!root.classList.contains("open"))));
  close.addEventListener("click", () => (touch(), root.set(false), btn.focus()));
  root.addEventListener("pointerenter", touch);
  root.addEventListener("keydown", (e) => e.key === "Escape" && root.set(false));
  return root;
}

function chai(kind) {
  return bubble("chai", kind, {
    label: "Support Track: chip in for a chai",
    region: "Support Track",
    icon: icons.cup,
    note: "chip in?",
    fill: () => [
      h("strong", { text: "Like it this way?" }),
      h(
        "p",
        {},
        "Track is free, has no ads, and stays that way. If it saved you a call to the enquiry counter, you can chip in for a chai.",
        h("br"),
        h("em", { text: "(min $1 equivalent in your local supported currency)" })
      ),
      h("a", { class: "support-btn", href: CHAI_URL, target: "_blank", rel: "noopener noreferrer" }, svg(icons.cup), "Chip in for a chai"),
    ],
  });
}

function install(kind) {
  const onHome = installPlace === "home";
  return bubble("install", kind, {
    label: onHome ? "Add Track to your home screen" : "Install Track as an app",
    region: onHome ? "Add Track to your home screen" : "Install Track",
    icon: icons.addHome,
    note: INSTALL_NOTE[installPlace],
    fill: installSteps,
  });
}

function installSteps(root) {
  const way = installWay();
  const onHome = installPlace === "home";
  const b = (text) => h("b", { text });
  const steps = (...items) => h("ol", { class: "install-steps" }, items.map((parts) => h("li", {}, h("span", {}, parts))));
  let how = null;
  if (way === "prompt")
    how = h(
      "button",
      {
        type: "button",
        class: "support-btn",
        on: {
          click: async () => {
            root.set(false);
            if (await promptInstall()) toast(onHome ? "Track is on your home screen" : "Track is installed");
          },
        },
      },
      svg(icons.addHome),
      onHome ? "Add to home screen" : "Install Track"
    );
  else if ((way === "ios" || way === "mac") && appleGuide) how = appleSteps(appleGuide);
  else if (way === "ios") how = steps(["Open your browser's ", b("Share"), " menu ", svg(icons.share), "."], ["Choose ", b("Add to Home Screen"), "."]);
  else if (way === "android") how = steps(["Open your browser's menu ", b("⋮"), "."], ["Choose ", b("Add to Home screen"), " or ", b("Install app"), "."]);
  else if (way === "chrome") how = steps(["Open Chrome's menu ", b("⋮"), " and choose ", b("Cast, save, and share"), "."], ["Choose ", b("Install page as app"), "."]);
  else if (way === "edge") how = steps(["Open Edge's menu ", b("…"), " and choose ", b("Apps"), "."], ["Choose ", b("Install this site as an app"), "."]);
  return [
    h("strong", { text: onHome ? "Keep Track one tap away" : "Keep Track one click away" }),
    h("p", {
      text: onHome
        ? "It opens full-screen from your home screen, just like an app. No app store, nothing to update, and still no ads."
        : "It opens in its own window, just like an app. No app store, nothing to update, and still no ads.",
    }),
    how,
  ].filter(Boolean);
}

/** Two pictures with numbered captions for Apple devices; the captions carry the meaning. */
function appleSteps(kind) {
  const b = (text) => h("b", { text });
  const addHome = ["Scroll down and choose ", b("Add to Home Screen"), "."];
  if (kind === "open-safari") {
    return h(
      "div",
      { class: "install-safari" },
      h("p", { text: "Only Safari can add Track to your home screen from here. Copy the link, open Safari, and paste it in." }),
      h(
        "button",
        {
          type: "button",
          class: "support-btn",
          on: {
            click: async () => {
              try {
                await navigator.clipboard.writeText(location.origin + location.pathname);
                toast("Link copied. Now open Safari.");
              } catch {
                toast("Couldn't copy. Long-press the address bar instead.");
              }
            },
          },
        },
        svg(icons.share),
        "Copy link"
      )
    );
  }
  const captions = {
    safari: [["Tap ", b("Share"), " in the toolbar."], addHome],
    safari26: [["Tap ", b("•••"), ", then ", b("Share"), "."], addHome],
    ipad: [["Tap ", b("Share"), " at the top right."], addHome],
    chrome: [["Tap ", b("Share"), " in the address bar."], addHome],
    mac: [["In the menu bar, open ", b("File"), "."], ["Choose ", b("Add to Dock"), "."]],
  }[kind];
  return h(
    "ol",
    { class: "guide" },
    guideArt[kind].map((art, i) => h("li", {}, h("span", { class: "guide-art" }, svg(art)), h("span", { class: "guide-cap" }, captions[i])))
  );
}

function credit() {
  const a = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer", text });
  return h(
    "div",
    { class: "credit" },
    h("div", { class: "bubbles" }, chai("inline"), install("inline")),
    h("p", { class: "credit-meta", text: "No ads · No tracking · No sign-ups" }),
    h(
      "p",
      { class: "credit-by" },
      "Built with ",
      svg(icons.heart),
      " (and coffee and Claude) by ",
      a("https://parth8.github.io/portfolio/", "Parth"),
      ", because life's too short for websites that fire 269 requests to show you one output."
    ),
    h("p", { class: "credit-links" }, a("https://linkedin.com/in/aggarwalparth", "LinkedIn ↗"), a("https://parth8.github.io/portfolio/", "Portfolio ↗"))
  );
}

async function share() {
  const s = session;
  const url = location.href;
  const title = document.title;
  const text = s?.share?.text ? `${s.share.text} ${url}` : url;
  const blob = s?.share ? await (s.shareImage || (s.shareImage = renderShareImage(s.share).catch(() => null))) : null;
  const file = blob ? new File([blob], `${s.mode}-${s.no}.png`, { type: "image/png" }) : null;

  // Phones: native share sheet with the picture and the link together.
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  // Desktop and older phones: preview the picture with copy and save buttons.
  if (blob) return openSharePreview(blob, file.name, url, text);
  try {
    if (navigator.share) await navigator.share({ title, text: s?.share?.text || title, url });
    else {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    }
  } catch {
    /* share sheet closed */
  }
}

const shareSheet = $("#share-sheet");
let previewUrl = null;
function openSharePreview(blob, name, url, text) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  $("#share-img").src = previewUrl;
  $("#share-img").alt = s_alt(text);
  const copyImg = $("#share-copy-img");
  copyImg.hidden = !(window.ClipboardItem && navigator.clipboard?.write);
  copyImg.onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Picture copied");
    } catch {
      toast("Couldn't copy the picture here. Try Save instead.");
    }
  };
  $("#share-download").onclick = () => {
    const a = h("a", { href: previewUrl, download: name });
    document.body.append(a);
    a.click();
    a.remove();
  };
  $("#share-copy-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast("Couldn't copy. Long-press the address bar instead.");
    }
  };
  shareSheet.showModal();
}
const s_alt = (text) => `Share card: ${text.replace(/ Live:.*$/, "")}`;
$("#share-close").addEventListener("click", () => shareSheet.close());
shareSheet.addEventListener("click", (e) => {
  if (e.target === shareSheet) shareSheet.close();
});

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
}
