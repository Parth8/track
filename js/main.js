import { h, svg, $, todayIn, addDays, longDate, relativeDay, prefersReducedMotion, IST } from "./util.js";
import { icons, art } from "./icons.js";
import { api, weatherAt } from "./api.js";
import { createFlipDate } from "./flip.js";
import { renderTrain } from "./train.js";
import { renderFlight } from "./flight.js";

const today = () => todayIn(IST);

const MODES = {
  train: {
    title: "Which train?",
    label: "Train number",
    placeholder: "12786",
    hint: "5 digits, like 12786.",
    inputmode: "numeric",
    maxlength: 5,
    valid: (v) => /^\d{5}$/.test(v),
    clean: (v) => v.replace(/\D/g, "").slice(0, 5),
    error: "Train numbers have 5 digits.",
    dateQ: "When did it leave its first station?",
    dateHelp: "Pick the day it started its run, even if you board later. Live status covers the last 4 days.",
    cta: "Check live status",
    range: () => [addDays(today(), -3), today()],
    refreshMs: 60000,
  },
  flight: {
    title: "Which flight?",
    label: "Flight number",
    placeholder: "6E 6252",
    hint: "Airline code and number, like 6E 6252 or AI 101.",
    inputmode: "text",
    maxlength: 8,
    valid: (v) => /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(v.replace(/\s/g, "")),
    clean: (v) => v.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 8),
    error: "Flight numbers look like 6E 6252 or AI 101.",
    dateQ: "Departure date",
    dateHelp: "Local date at the departure airport.",
    cta: "Track flight",
    range: () => [addDays(today(), -2), addDays(today(), 7)],
    refreshMs: 90000,
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
  const cfg = MODES[mode];
  const value = qInput.value.trim();
  if (!cfg.valid(value)) {
    qInput.setAttribute("aria-invalid", "true");
    qError.textContent = cfg.error;
    qError.hidden = false;
    qInput.focus();
    return;
  }
  navigate({ m: mode, no: value.replace(/\s/g, ""), d: flip.value });
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
  if (document.visibilityState === "visible" && session?.data && Date.now() - session.loadedAt > MODES[session.mode].refreshMs) load({ silent: true });
});

route();

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
  const url = qs ? `?${qs}` : location.pathname;
  history[opts.replace ? "replaceState" : "pushState"](null, "", url);
  route(opts);
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
    const focusTarget = views[target].querySelector("[data-focus]");
    focusTarget?.focus({ preventScroll: true });
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
  const no = carry ? carry.no : "";
  qInput.value = no ? cfg.clean(r.mode === "flight" ? no.replace(/^([A-Z0-9]{2})(\d)/, "$1 $2") : no) : "";
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
  clearTimeout(session.slowTimer);
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
  session = { ...r, data: null, loadedAt: 0, foldOpen: false, mapCtl: null, mapEl: null };
  $("#status-title").textContent = r.mode === "train" ? `Train ${r.no}` : r.no.replace(/^([A-Z0-9]{2})(\d)/, "$1 $2");
  $("#status-sub").textContent = longDate(r.date || today());
  paintSkeleton();
  load();
}

$("#status-back").addEventListener("click", (e) => {
  e.preventDefault();
  const r = current();
  prefill = { mode: r.mode, no: r.no, date: r.date };
  navigate({ m: r.mode });
});
$("#status-refresh").addEventListener("click", () => load({ manual: true }));
$("#status-share").addEventListener("click", share);
jumpBtn.addEventListener("click", () => session?.currentRow?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" }));

async function load({ silent = false, manual = false } = {}) {
  const s = session;
  if (!s) return;
  clearTimeout(s.timer);
  const btn = $("#status-refresh");
  btn.classList.add("spinning");
  btn.setAttribute("aria-busy", "true");
  if (!s.data) s.slowTimer = setTimeout(() => session === s && paintSlowNote(), 6000);
  try {
    const data = await api(`/api/${s.mode}`, { no: s.no, date: s.date || today() });
    if (session !== s) return;
    s.data = data;
    s.loadedAt = Date.now();
    paint();
    if (manual) toast("Updated just now");
  } catch (err) {
    if (session !== s) return;
    if (s.data && (silent || manual)) toast("Could not refresh. Showing the last update.");
    else paintError(err);
  } finally {
    if (session === s) {
      clearTimeout(s.slowTimer);
      btn.classList.remove("spinning");
      btn.removeAttribute("aria-busy");
      const done = s.data && ((s.mode === "train" && s.data.status?.phase === "arrived") || (s.mode === "flight" && ["landed", "cancelled"].includes(s.data.status?.phase)));
      if (!done) s.timer = setTimeout(() => load({ silent: true }), MODES[s.mode].refreshMs);
    }
  }
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
            toast("Your stop is updated");
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
    h("button", { type: "button", class: "link-quiet", "data-open": "sources", text: "Sources and credits" })
  );
  statusRoot.replaceChildren(view.node, footer);
  statusRoot.setAttribute("aria-busy", "false");

  for (const el of statusRoot.querySelectorAll("[data-k]")) {
    const old = before.get(el.dataset.k);
    if (old != null && old !== el.textContent && !prefersReducedMotion()) el.classList.add("tick");
  }
  if (before.size) window.scrollTo({ top: scrollY, behavior: "instant" });

  const name = s.mode === "train" ? `${s.no} ${s.data.name || ""}` : `${s.data.number} ${s.data.departure?.code}-${s.data.arrival?.code}`;
  $("#status-sub").textContent = s.mode === "train" ? s.data.name : `${s.data.departure.code} to ${s.data.arrival.code}`;
  document.title = name.trim();

  if (view.weatherPlace) weatherAt(view.weatherPlace.lat, view.weatherPlace.lon).then(view.addWeather).catch(() => {});

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

function paintSkeleton() {
  const bar = (w, hgt) => {
    const el = h("span", { class: "skel" });
    el.style.width = w;
    el.style.height = hgt;
    return el;
  };
  statusRoot.setAttribute("aria-busy", "true");
  statusRoot.replaceChildren(
    h("div", { class: "card skel-card", "aria-hidden": "true" }, bar("40%", "12px"), bar("65%", "26px"), bar("45%", "54px"), bar("100%", "8px")),
    h("div", { class: "card skel-card", "aria-hidden": "true" }, [80, 60, 72, 55, 66].map((w) => bar(`${w}%`, "14px"))),
    h("p", { class: "sr-only", text: "Loading live status" })
  );
}

function paintSlowNote() {
  if (session?.data) return;
  statusRoot.append(
    h(
      "div",
      { class: "card slow-note", role: "status" },
      svg(art.slow),
      h("div", {}, h("strong", { text: "Live data is slow right now" }), h("p", { class: "field-hint", text: "Taking longer than usual. Still trying." }))
    )
  );
}

function paintError(err) {
  const s = session;
  const r = current();
  const cfg = MODES[s.mode];
  const [min] = cfg.range();
  const actions = [];
  let title = "Could not load live status";
  let body = err.message || "Something went wrong.";

  if (err.code === "not_found") {
    title = s.mode === "train" ? "No run found" : "Flight not found";
    const yesterday = addDays(r.date || today(), -1);
    if (s.mode === "train" && yesterday >= min)
      actions.push(h("button", { type: "button", class: "cta", text: "Try the run that started a day earlier", on: { click: () => navigate({ m: r.mode, no: r.no, d: yesterday }) } }));
  } else if (err.code === "flights_not_configured") {
    title = "Flight tracking is not switched on yet";
    body = "Add a flight data key to the Worker to turn it on. Train tracking works without it.";
  } else if (err.code === "forbidden") {
    title = "This site is not connected yet";
    body = "Add this site's address to ALLOWED_ORIGINS in the Worker settings.";
  } else if (err.code === "rate_limited") {
    title = "Too many checks";
    body = "Wait a minute, then try again.";
  } else if (["timeout", "network", "upstream_unavailable"].includes(err.code)) {
    title = "Live data is slow right now";
    body = "The live source did not answer in time. Trying again in a minute.";
    actions.push(h("button", { type: "button", class: "cta", text: "Try again now", on: { click: () => (paintSkeleton(), load()) } }));
  }
  actions.push(h("button", { type: "button", class: "cta secondary", text: "Change number or date", on: { click: () => navigate({ m: r.mode }) } }));

  statusRoot.setAttribute("aria-busy", "false");
  statusRoot.replaceChildren(h("div", { class: "empty", role: "alert" }, svg(art.empty), h("h2", { class: "display", text: title }), h("p", { text: body })), h("div", { class: "actions" }, actions));
}

/* ------------------------------------------------------------------ */
/* Small things                                                        */
/* ------------------------------------------------------------------ */

async function share() {
  const title = document.title;
  try {
    if (navigator.share) await navigator.share({ title, url: location.href });
    else {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied");
    }
  } catch {
    /* user closed the share sheet */
  }
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
}
