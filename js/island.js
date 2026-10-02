// The live island: a capsule at the top of the screen, like the Dynamic Island.
//
// Two ways it shows:
//  - "scroll": on a journey's own status screen, once the big status card scrolls away.
//  - "pinned": on every screen, for the journey you pinned, even after closing and reopening.
// It grows out of a small pill when it appears, resizes smoothly as its content changes, and
// updates its parts in place so changes crossfade instead of flickering.
//
// Content is plain data (so a pinned journey can be saved on the device):
//   { mode: "train" | "flight", top, main: [segment], chip: { cls, text }, detail: [text],
//     progress, live, spoken, updatedAt }
// where a segment is { text } | { strong } | { soft } | { time, tz, shift, soft }.

import { h, svg, ago, timeNode, prefersReducedMotion } from "./util.js";
import { icons } from "./icons.js";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)"; // the curve iOS uses for its own sheets and islands
const RING = 2 * Math.PI * 20; // circumference of the progress ring (r = 20)
const NS = "http://www.w3.org/2000/svg";

export function createIsland({ onOpen, onPin } = {}) {
  // Built once; later updates change these parts in place.
  const ringTrack = document.createElementNS(NS, "circle");
  const ringBar = document.createElementNS(NS, "circle");
  for (const c of [ringTrack, ringBar]) {
    c.setAttribute("cx", "22");
    c.setAttribute("cy", "22");
    c.setAttribute("r", "20");
  }
  ringTrack.setAttribute("class", "isl-ring-track");
  ringBar.setAttribute("class", "isl-ring-bar");
  ringBar.style.strokeDasharray = `${RING}`;
  ringBar.style.strokeDashoffset = `${RING}`;
  const ring = document.createElementNS(NS, "svg");
  ring.setAttribute("class", "isl-ring");
  ring.setAttribute("viewBox", "0 0 44 44");
  ring.setAttribute("aria-hidden", "true");
  ring.append(ringTrack, ringBar);

  const glyph = h("span", { class: "isl-glyph" });
  const icon = h("span", { class: "isl-icon" }, ring, glyph, h("i", { class: "isl-live", "aria-hidden": "true" }));
  const top = h("span", { class: "isl-top" });
  const mainLine = h("span", { class: "isl-main" });
  const chip = h("span", { class: "isl-chip" });
  const detail = h("span", { class: "isl-detail" });
  const main = h("button", { type: "button", class: "isl-open" }, h("span", { class: "isl-row" }, icon, h("span", { class: "isl-text" }, top, mainLine), chip), detail);
  const pin = h("button", { type: "button", class: "isl-pin", "aria-pressed": "false", "aria-label": "Pin to the top" }, svg(icons.pin));
  const el = h("div", { class: "island", "aria-hidden": "true" }, main, pin);
  let mode = "off"; // off | scroll | pinned
  main.addEventListener("click", () => onOpen?.(mode));
  pin.addEventListener("click", () => onPin?.(mode));
  document.body.append(el);

  let visible = false;
  let io = null;
  let last = "";
  let data = null;
  let glyphMode = "";

  const segment = (s) => {
    if (s.time) {
      const t = timeNode(s.time, s.tz, { shift: s.shift || 0 });
      return s.soft ? h("span", { class: "isl-when" }, t) : t;
    }
    if (s.strong != null) return h("b", { text: s.strong });
    if (s.soft != null) return h("span", { class: "isl-when", text: s.soft });
    return s.text ?? "";
  };

  /** Swap a part's content, fading the new content in when it actually changed. */
  function swap(part, nodes, animate) {
    const before = part.textContent;
    part.replaceChildren(...nodes);
    if (animate && part.textContent !== before && !prefersReducedMotion())
      part.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE });
  }

  function fill(d, animate) {
    // A saved copy says how old it is, so a reopened app never passes off old news as live.
    const old = d.updatedAt && Date.now() - Date.parse(d.updatedAt) > 3 * 60000;
    el.dataset.mode = d.mode;
    el.classList.toggle("live", !!d.live && !old);
    if (glyphMode !== d.mode) {
      glyph.replaceChildren(svg(d.mode === "flight" ? icons.plane : icons.trainFront));
      glyphMode = d.mode;
    }
    const p = d.progress == null ? null : Math.min(1, Math.max(0, d.progress));
    ring.classList.toggle("on", p != null);
    ringBar.style.strokeDashoffset = `${RING * (1 - (p ?? 0))}`;
    main.setAttribute("aria-label", `${d.spoken}${old ? ` Updated ${ago(d.updatedAt)}.` : ""} ${mode === "pinned" ? "Open this journey." : "Back to the top."}`);
    swap(top, [d.top, old ? h("span", { class: "isl-age", text: ` · ${ago(d.updatedAt)}` }) : null].filter(Boolean), animate);
    swap(mainLine, d.main.map(segment), animate);
    chip.hidden = !d.chip;
    chip.className = `isl-chip ${d.chip?.cls || ""}`;
    swap(chip, d.chip ? [h("i", { "aria-hidden": "true" }), d.chip.text] : [], animate);
    detail.hidden = !d.detail?.length;
    swap(detail, (d.detail || []).map((t) => h("span", { text: t })), animate);
  }

  /** New content: the capsule resizes smoothly from its old size to the new one. */
  function update(d) {
    if (!d) return;
    data = d;
    const key = JSON.stringify(d) + mode;
    if (key === last) return;
    last = key;
    if (!visible || prefersReducedMotion()) {
      fill(d, false);
      return measure();
    }
    const from = el.getBoundingClientRect();
    fill(d, true);
    const to = el.getBoundingClientRect();
    measure();
    if (Math.abs(from.width - to.width) < 1 && Math.abs(from.height - to.height) < 1) return;
    el.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], { duration: 480, easing: EASE });
  }

  function show(on) {
    if (on === visible) return measure();
    visible = on;
    el.classList.toggle("show", on);
    el.setAttribute("aria-hidden", String(!on));
    for (const b of [main, pin]) b.tabIndex = on ? 0 : -1;
    measure();
  }

  // While pinned, pages make room for the island instead of sliding under it.
  function measure() {
    const onTop = mode === "pinned" && visible;
    document.body.classList.toggle("island-pinned", onTop);
    if (onTop) document.body.style.setProperty("--island-space", `${Math.ceil(el.offsetHeight) + 14}px`);
  }

  return {
    update,
    setPinned(on) {
      pin.setAttribute("aria-pressed", String(on));
      pin.setAttribute("aria-label", on ? "Unpin from the top" : "Pin to the top, even after closing the app");
      el.classList.toggle("pinned", on);
    },
    /** On a journey's own screen: show once `anchor` (the big status card) has scrolled away. */
    watch(anchor) {
      io?.disconnect();
      mode = "scroll";
      last = "";
      if (data) fill(data, false);
      measure();
      if (!anchor || !("IntersectionObserver" in window)) return show(false);
      io = new IntersectionObserver(([e]) => show(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
      io.observe(anchor);
    },
    /** Anywhere else: the pinned journey stays on top. */
    pinOnTop(d) {
      io?.disconnect();
      io = null;
      mode = "pinned";
      last = "";
      if (d) update(d);
      show(true);
    },
    hide() {
      io?.disconnect();
      io = null;
      mode = "off";
      show(false);
    },
  };
}
