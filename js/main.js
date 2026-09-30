import { h, svg, $, todayIn, addDays, longDate, dayLabel, relativeDay, prefersReducedMotion, isDarkTheme, ago, IST } from "./util.js";
import { icons, art } from "./icons.js";
import { api, weatherAt, ApiError } from "./api.js";
import { createFlipDate } from "./flip.js";
import { createLoader } from "./loader.js";
import { renderShareImage } from "./share-card.js";
import { renderTrain } from "./train.js";
import { renderFlight } from "./flight.js";

const today = () => todayIn(IST);
const THEME_LABEL = { light: "Light", dark: "Dark", auto: "Match device" };
const THEME_ICON = { light: "themeLight", dark: "themeDark", auto: "themeAuto" };
const CHAI_URL = "https://buymeacoffee.com/parth8"; // swap for your UPI link later
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
    dateHelp: "Pick the day it started its run, even if you board later. Live status covers the last 4 days.",
    cta: "Check live status",
    range: () => [addDays(today(), -3), today()],
    refreshMs: () => 30000,
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
    dateHelp: "Local date at the airport the flight leaves from.",
    cta: "Track flight",
    range: () => [addDays(today(), -2), addDays(today(), 7)],
    // live position is free, so refresh often while airborne; schedules change slowly
    refreshMs: (data) => (data?.status?.phase === "air" ? 30000 : 90000),
  },
};

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

const views = { home: $("#view-home"), search: $("#view-search"), status: $("#view-status") };
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

qInput.addEventListener("input", () => {
  const mode = MODES[current().mode];
  const cleaned = mode.clean(qInput.value);
  if (cleaned !== qInput.value) qInput.value = cleaned;
  qInput.removeAttribute("aria-invalid");
  qError.hidden = true;
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const { mode } = current();
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

window.addEventListener("popstate", () => route());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session?.data && Date.now() - session.loadedAt > MODES[session.mode].refreshMs(session.data)) load({ silent: true });
});
window.addEventListener("online", () => {
  if (session?.error) retryNow();
});

$("#home-credit").append(credit());

// Floating chai button (desktop only; phones get the inline one above the signature)
const chaiFloat = chai("float");
document.body.append(chaiFloat);
document.addEventListener("click", (e) => {
  if (chaiFloat.classList.contains("open") && !chaiFloat.contains(e.target)) chaiFloat.set(false);
});
if (window.matchMedia("(min-width: 720px)").matches) {
  setTimeout(() => {
    if (document.hidden || chaiFloat.dataset.touched) return;
    chaiFloat.set(true);
    setTimeout(() => !chaiFloat.dataset.touched && chaiFloat.set(false, { slow: true }), 6000);
  }, 3500);
}
setupTheme();
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
  return {
    mode: m === "train" || m === "flight" ? m : null,
    no: (p.get("no") || "").toUpperCase(),
    date: p.get("d") || "",
    stop: (p.get("s") || "").toUpperCase(),
  };
}

function navigate(params, opts = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  history[opts.replace ? "replaceState" : "pushState"](null, "", qs ? `?${qs}` : location.pathname);
  route(opts);
}

function backToSearch() {
  const r = current();
  prefill = { mode: r.mode, no: r.no, date: r.date };
  navigate({ m: r.mode });
}

function route(opts = {}) {
  const r = current();
  const target = !r.mode ? "home" : r.no ? "status" : "search";
  const apply = () => {
    for (const [name, el] of Object.entries(views)) el.hidden = name !== target;
    document.body.dataset.mode = r.mode || "home";
    if (target !== "status") stopSession();
    if (target === "search") setupSearch(r);
    if (target === "status") openStatus(r);
    if (target === "home") document.title = "Track a train or flight";
    views[target].querySelector("[data-focus]")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  if (!document.startViewTransition || prefersReducedMotion()) return apply();

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

function setupSearch(r) {
  const cfg = MODES[r.mode];
  $("#search-title").textContent = cfg.title;
  $("#q-label").textContent = cfg.label;
  $("#q-hint").textContent = cfg.hint;
  $("#date-q").textContent = cfg.dateQ;
  $("#date-help").textContent = cfg.dateHelp;
  $("#cta-text").textContent = cfg.cta;
  qInput.placeholder = cfg.placeholder;
  qInput.inputMode = cfg.inputmode;
  qInput.maxLength = cfg.maxlength;
  qInput.autocapitalize = r.mode === "flight" ? "characters" : "off";
  const carry = prefill && prefill.mode === r.mode ? prefill : null;
  prefill = null;
  qInput.value = carry?.no ? cfg.clean(carry.no) : "";
  qInput.removeAttribute("aria-invalid");
  qError.hidden = true;

  const [min, max] = cfg.range();
  const wanted = carry?.date || r.date;
  const start = wanted && wanted >= min && wanted <= max ? wanted : today() > max ? max : today();
  const readout = (v) => {
    $("#date-long").textContent = longDate(v);
    $("#date-rel").textContent = relativeDay(v, today());
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
  backToSearch();
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

function chai(kind) {
  const btn = h("button", { type: "button", class: "chai-btn", "aria-expanded": "false", "aria-controls": `chai-${kind}`, "aria-label": "Support Track: chip in for a chai" }, svg(icons.cup));
  const close = h("button", { type: "button", class: "chai-close", "aria-label": "Close" }, svg(icons.close));
  const panel = h(
    "div",
    { class: "chai-panel", id: `chai-${kind}`, role: "region", "aria-label": "Support Track" },
    close,
    h("strong", { text: "Like it this way?" }),
    h(
      "p",
      {},
      "Track is free, has no ads, and stays that way. If it saved you a call to the enquiry counter, you can chip in for a chai.",
      h("br"),
      "(min $1 equivalent in your local supported currency)"
    ),
    h("a", { class: "support-btn", href: CHAI_URL, target: "_blank", rel: "noopener noreferrer" }, svg(icons.cup), "Chip in for a chai")
  );
  const root = h("div", { class: `chai chai-${kind}` }, panel, btn);
  root.set = (open, { slow = false } = {}) => {
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

function credit() {
  const a = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer", text });
  return h(
    "div",
    { class: "credit" },
    chai("inline"),
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
