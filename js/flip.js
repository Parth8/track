import { h, addDays, prefersReducedMotion } from "./util.js";
import { icons } from "./icons.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const parts = (iso) => iso.split("-").map(Number);
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Split-flap date picker with Day, Month and Year cards.
 * Tap the arrows, swipe up or down on a card, scroll, or use arrow keys.
 */
export function createFlipDate(root, { value, min, max, onChange }) {
  let current = value;
  let lo = min;
  let hi = max;

  const step = {
    day: (v, n) => addDays(v, n),
    month: (v, n) => {
      const [y, m, d] = parts(v);
      const t = new Date(Date.UTC(y, m - 1 + n, 1));
      return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, daysIn(t.getUTCFullYear(), t.getUTCMonth())));
    },
    year: (v, n) => {
      const [y, m, d] = parts(v);
      return iso(y + n, m, Math.min(d, daysIn(y + n, m - 1)));
    },
  };
  const clamp = (v) => (v < lo ? lo : v > hi ? hi : v);
  const text = {
    day: (v) => String(parts(v)[2]).padStart(2, "0"),
    month: (v) => MONTHS[parts(v)[1] - 1],
    year: (v) => String(parts(v)[0]),
  };
  const label = { day: "Day", month: "Month", year: "Year" };
  const cols = {};

  root.replaceChildren();
  for (const unit of ["day", "month", "year"]) {
    const up = h("button", { type: "button", class: "nudge", "aria-label": `Next ${unit}`, svg: icons.up });
    const down = h("button", { type: "button", class: "nudge", "aria-label": `Previous ${unit}`, svg: icons.down });
    const face = (cls) => h("div", { class: cls }, h("span"));
    const card = h(
      "div",
      {
        class: "flip",
        tabindex: "0",
        role: "spinbutton",
        "aria-label": label[unit],
      },
      face("flip-half top"),
      face("flip-half bottom"),
      face("flip-flap top"),
      face("flip-flap bottom"),
      h("i", { class: "flip-pin l" }),
      h("i", { class: "flip-pin r" })
    );
    const col = h("div", { class: "flip-col" }, up, card, down, h("span", { class: "flip-label", text: label[unit] }));
    root.append(col);
    cols[unit] = { up, down, card, shown: null };

    up.addEventListener("click", () => move(unit, 1));
    down.addEventListener("click", () => move(unit, -1));
    card.addEventListener("keydown", (e) => {
      const map = { ArrowUp: 1, ArrowRight: 1, PageUp: 1, ArrowDown: -1, ArrowLeft: -1, PageDown: -1 };
      if (map[e.key]) {
        e.preventDefault();
        move(unit, map[e.key]);
      }
    });
    let wheelAt = 0;
    card.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (Date.now() - wheelAt < 180) return;
        wheelAt = Date.now();
        move(unit, e.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
    let startY = null;
    card.addEventListener("pointerdown", (e) => {
      startY = e.clientY;
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener("pointermove", (e) => {
      if (startY == null) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 26) {
        move(unit, dy < 0 ? 1 : -1);
        startY = e.clientY;
      }
    });
    const end = () => (startY = null);
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  function move(unit, n) {
    const next = clamp(step[unit](current, n));
    if (next === current) {
      const c = cols[unit].card;
      c.classList.remove("bump");
      void c.offsetWidth;
      c.classList.add("bump");
      return;
    }
    current = next;
    render(true);
    onChange?.(current);
  }

  function setFace(card, sel, value) {
    card.querySelector(`${sel} span`).textContent = value;
  }

  function render(animate) {
    for (const unit of Object.keys(cols)) {
      const col = cols[unit];
      const value = text[unit](current);
      const old = col.shown;
      col.card.setAttribute("aria-valuetext", `${label[unit]} ${value}`);
      col.up.disabled = clamp(step[unit](current, 1)) === current;
      col.down.disabled = clamp(step[unit](current, -1)) === current;
      if (old === value) continue;
      col.shown = value;
      if (!animate || old == null || prefersReducedMotion()) {
        for (const sel of [".flip-half.top", ".flip-half.bottom"]) setFace(col.card, sel, value);
        continue;
      }
      // Classic split-flap: new value behind the top, old value on the falling flap.
      setFace(col.card, ".flip-half.top", value);
      setFace(col.card, ".flip-half.bottom", old);
      setFace(col.card, ".flip-flap.top", old);
      setFace(col.card, ".flip-flap.bottom", value);
      col.card.classList.remove("flipping");
      void col.card.offsetWidth;
      col.card.classList.add("flipping");
      const done = () => {
        setFace(col.card, ".flip-half.bottom", value);
        col.card.classList.remove("flipping");
      };
      clearTimeout(col.timer);
      col.timer = setTimeout(done, 460);
    }
  }

  render(false);

  return {
    get value() {
      return current;
    },
    set(v) {
      current = clamp(v);
      render(true);
    },
    setRange(newMin, newMax) {
      lo = newMin;
      hi = newMax;
      current = clamp(current);
      render(false);
    },
  };
}
