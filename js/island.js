// The live island: a capsule that settles at the top of the status screen once the big
// status card scrolls away, like the Dynamic Island. It grows and shrinks to fit what it
// is saying (a one-liner before a journey, more while it's moving) and tapping it goes back up.

import { h, svg, prefersReducedMotion } from "./util.js";
import { icons } from "./icons.js";

const SPRING = "cubic-bezier(0.2, 1.25, 0.35, 1)";

export function createIsland() {
  const el = h("button", { type: "button", class: "island", "aria-hidden": "true", tabindex: "-1" });
  el.addEventListener("click", () => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" }));
  document.body.append(el);
  let shown = false;
  let io = null;
  let last = "";

  function fill(d) {
    const ring = d.progress != null ? `${Math.round(Math.min(1, Math.max(0, d.progress)) * 360)}deg` : null;
    el.dataset.mode = d.mode;
    el.setAttribute("aria-label", `${d.spoken}. Back to the top.`);
    const parts = [
      h(
        "span",
        { class: `isl-icon${ring ? " ring" : ""}`, vars: ring ? { "--ring": ring } : {} },
        h("span", { class: "isl-glyph" }, svg(d.mode === "flight" ? icons.plane : icons.trainFront))
      ),
      h("span", { class: "isl-text" }, h("span", { class: "isl-top", text: d.top }), h("span", { class: "isl-main" }, d.main)),
      d.chip ? h("span", { class: `isl-chip ${d.chip.cls}`, text: d.chip.text }) : null,
      d.detail?.length ? h("span", { class: "isl-detail" }, d.detail.map((t) => h("span", { text: t }))) : null,
    ];
    el.replaceChildren(...parts.filter(Boolean)); // an empty slot would otherwise print "null"
  }

  /** New content: the capsule morphs from its old size to the new one. */
  function update(d) {
    if (!d) return;
    const key = JSON.stringify({ ...d, main: String(d.main?.textContent ?? d.main) });
    if (key === last) return;
    last = key;
    if (!shown || prefersReducedMotion()) return fill(d);
    const from = el.getBoundingClientRect();
    fill(d);
    const to = el.getBoundingClientRect();
    if (Math.abs(from.width - to.width) < 1 && Math.abs(from.height - to.height) < 1) return;
    el.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], { duration: 520, easing: SPRING });
    for (const c of el.children) c.animate([{ opacity: 0, filter: "blur(3px)" }, { opacity: 1, filter: "none" }], { duration: 320, delay: 90, fill: "backwards" });
  }

  function show(on) {
    if (on === shown) return;
    shown = on;
    el.classList.toggle("show", on);
    el.setAttribute("aria-hidden", String(!on));
    el.tabIndex = on ? 0 : -1;
  }

  /** Show the island whenever `anchor` (the big status card) has scrolled up out of view. */
  function watch(anchor) {
    io?.disconnect();
    if (!anchor || !("IntersectionObserver" in window)) return show(false);
    io = new IntersectionObserver(([e]) => show(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(anchor);
  }

  function stop() {
    io?.disconnect();
    io = null;
    last = "";
    show(false);
  }

  return { update, watch, stop };
}
