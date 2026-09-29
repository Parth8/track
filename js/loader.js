import { h, svg, prefersReducedMotion } from "./util.js";
import { icons } from "./icons.js";

const TRAIN = `<svg viewBox="0 0 48 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
  <path d="M4 17V8a4 4 0 0 1 4-4h26c5 0 9 4.5 10 9.5l.5 3.5H4z" fill="var(--card)"/>
  <path d="M9 8h6v5H9zM19 8h6v5h-6z" fill="var(--tint)"/><path d="M30 8h3.5c2.5 0 4.5 2 5.2 5H30z" fill="var(--tint)"/>
  <circle cx="12" cy="19.5" r="2" fill="var(--card)"/><circle cx="34" cy="19.5" r="2" fill="var(--card)"/></g>
  <circle class="lamp" cx="42.5" cy="15" r="1.3" fill="#FFD98A"/></svg>`;

const LINES = {
  train: [
    [0, "Asking the railway feeds"],
    [2600, "Checking the latest station report"],
    [6500, "Lining up the stops"],
    [12500, "Nearly there, gathering the last details"],
  ],
  flight: [
    [0, "Asking the flight data service"],
    [2600, "Checking the departure board"],
    [6500, "Looking for the aircraft"],
    [12500, "Nearly there, gathering the last details"],
  ],
};
const SLOW_AT = 20000;
const MIN_SHOW = 1100;

/**
 * A small journey that fills while live data loads.
 * finish() completes the trip smoothly before the real screen appears.
 */
export function createLoader(mode, label) {
  const reduce = prefersReducedMotion();
  const vehicle = h("span", { class: `loader-vehicle ${mode}` }, svg(mode === "flight" ? icons.plane : TRAIN));
  const fill = h("span", { class: "loader-fill" });
  const title = h("h2", { class: "display loader-title", text: mode === "flight" ? `Finding ${label}` : `Finding train ${label}` });
  const line = h("p", { class: "loader-line", text: "" });
  const foot = h("p", { class: "loader-foot", text: "Live data usually arrives in a few seconds." });
  const el = h(
    "section",
    { class: `card loader ${mode}`, role: "status", "aria-live": "polite" },
    title,
    line,
    h("div", { class: `loader-track ${mode}`, "aria-hidden": "true" }, h("span", { class: "loader-rail" }), fill, vehicle),
    foot
  );

  const started = performance.now();
  let raf = 0;
  let lineIdx = -1;
  let slow = false;
  let progress = 0;

  const set = (p) => {
    progress = p;
    el.style.setProperty("--p", p.toFixed(4));
  };

  function frame(now) {
    const t = now - started;
    // quick at first, then easing towards the end, never quite arriving on its own
    set(t < SLOW_AT ? 0.9 * (1 - Math.exp(-t / 6500)) : 0.85 + 0.12 * (1 - Math.exp(-(t - SLOW_AT) / 30000)));
    const lines = LINES[mode];
    let idx = 0;
    for (let i = 0; i < lines.length; i++) if (t >= lines[i][0]) idx = i;
    if (idx !== lineIdx && !slow) {
      lineIdx = idx;
      line.textContent = lines[idx][1].replace("{no}", label);
    }
    if (!slow && t >= SLOW_AT) {
      slow = true;
      el.classList.add("slow");
      title.textContent = "Live data is slow right now";
      line.textContent = "Still trying. Hang tight, busy hours can take up to a minute.";
      foot.textContent = "You can leave this open. It will fill in on its own.";
    }
    raf = requestAnimationFrame(frame);
  }

  if (reduce) {
    set(0.5);
    line.textContent = LINES[mode][0][1].replace("{no}", label);
    setTimeout(() => {
      if (!slow && raf !== -1) {
        slow = true;
        title.textContent = "Live data is slow right now";
        line.textContent = "Still trying. Hang tight.";
      }
    }, SLOW_AT);
  } else raf = requestAnimationFrame(frame);

  return {
    el,
    async finish() {
      const wait = MIN_SHOW - (performance.now() - started);
      if (wait > 0 && !reduce) await new Promise((r) => setTimeout(r, wait));
      cancelAnimationFrame(raf);
      if (reduce) return;
      el.classList.add("arriving");
      const from = progress;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          const k = Math.min(1, (now - t0) / 380);
          set(from + (1 - from) * (1 - Math.pow(1 - k, 3)));
          if (k < 1) requestAnimationFrame(step);
          else setTimeout(resolve, 140);
        };
        requestAnimationFrame(step);
      });
    },
    destroy() {
      cancelAnimationFrame(raf);
      raf = -1;
    },
  };
}
