// The live island: a capsule at the top of the screen, like the Dynamic Island.
//
// Two ways it shows:
//  - "scroll": on a journey's own status screen, once the big status card scrolls away.
//  - "pinned": on every screen, for the journey you pinned, even after closing and reopening.
// It grows and shrinks to fit what it's saying, and morphs between sizes as details change.
//
// Content is plain data (so a pinned journey can be saved on the device):
//   { mode: "train" | "flight", top, main: [segment], chip: { cls, text }, detail: [text], progress, spoken, updatedAt }
// where a segment is { text } | { strong } | { soft } | { time, tz, shift, soft }.

import { h, svg, ago, timeNode, prefersReducedMotion } from "./util.js";
import { icons } from "./icons.js";

const SPRING = "cubic-bezier(0.2, 1.25, 0.35, 1)";

export function createIsland({ onOpen, onPin } = {}) {
  const main = h("button", { type: "button", class: "isl-open" });
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

  const segment = (s) => {
    if (s.time) {
      const t = timeNode(s.time, s.tz, { shift: s.shift || 0 });
      return s.soft ? h("span", { class: "isl-when" }, t) : t;
    }
    if (s.strong != null) return h("b", { text: s.strong });
    if (s.soft != null) return h("span", { class: "isl-when", text: s.soft });
    return s.text ?? "";
  };

  function fill(d) {
    const ring = d.progress != null ? `${Math.round(Math.min(1, Math.max(0, d.progress)) * 360)}deg` : null;
    // A saved copy says how old it is, so a reopened app never passes off old news as live.
    const old = d.updatedAt && Date.now() - Date.parse(d.updatedAt) > 3 * 60000;
    const age = old ? ` · ${ago(d.updatedAt)}` : "";
    el.dataset.mode = d.mode;
    main.setAttribute("aria-label", `${d.spoken}${old ? ` Updated ${ago(d.updatedAt)}.` : ""} ${mode === "pinned" ? "Open this journey." : "Back to the top."}`);
    main.replaceChildren(
      ...[
        h(
          "span",
          { class: `isl-icon${ring ? " ring" : ""}`, vars: ring ? { "--ring": ring } : {} },
          h("span", { class: "isl-glyph" }, svg(d.mode === "flight" ? icons.plane : icons.trainFront))
        ),
        h("span", { class: "isl-text" }, h("span", { class: "isl-top", text: `${d.top}${age}` }), h("span", { class: "isl-main" }, d.main.map(segment))),
        d.chip ? h("span", { class: `isl-chip ${d.chip.cls}`, text: d.chip.text }) : null,
        d.detail?.length ? h("span", { class: "isl-detail" }, d.detail.map((t) => h("span", { text: t }))) : null,
      ].filter(Boolean) // an empty slot would otherwise print "null"
    );
  }

  /** New content: the capsule morphs from its old size to the new one. */
  function update(d) {
    if (!d) return;
    data = d;
    const key = JSON.stringify(d) + mode;
    if (key === last) return;
    last = key;
    if (!visible || prefersReducedMotion()) {
      fill(d);
      return measure();
    }
    const from = el.getBoundingClientRect();
    fill(d);
    const to = el.getBoundingClientRect();
    measure();
    if (Math.abs(from.width - to.width) < 1 && Math.abs(from.height - to.height) < 1) return;
    el.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], { duration: 520, easing: SPRING });
    for (const c of main.children) c.animate([{ opacity: 0, filter: "blur(3px)" }, { opacity: 1, filter: "none" }], { duration: 320, delay: 90, fill: "backwards" });
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
      if (data) fill(data);
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
