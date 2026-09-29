/**
 * DOM builder. All text goes through textContent, so data from the API
 * can never become HTML. Static, trusted SVG comes only from icons.js.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "vars") for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
    else if (key === "on") for (const [evt, fn] of Object.entries(value)) el.addEventListener(evt, fn);
    else if (key === "svg") el.append(svg(value));
    else if (key in el && !key.startsWith("aria") && !key.startsWith("data")) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const tpl = document.createElement("template");
/** Parse a trusted, static SVG string from icons.js. */
export function svg(markup) {
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild.cloneNode(true);
}

export const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- time ---------------- */

export const IST = "Asia/Kolkata";

export function todayIn(tz = IST) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function clock(iso, tz = IST, twelve = false) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: twelve ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: twelve,
  })
    .format(new Date(iso))
    .replace(" am", " AM")
    .replace(" pm", " PM");
}

export function dayLabel(iso, tz = IST) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}

export function longDate(isoDate) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${isoDate}T00:00:00Z`)
  );
}

export function dateKey(iso, tz = IST) {
  return iso ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso)) : "";
}

export function duration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hrs === 0) return `${rest} min`;
  return `${hrs}h ${String(rest).padStart(2, "0")}m`;
}

export function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ${mins % 60}m ago` : `${Math.floor(hrs / 24)} days ago`;
}

export function relativeDay(isoDate, today) {
  const diff = Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return diff > 0 ? `In ${diff} days` : `${-diff} days ago`;
}

export function delayChip(min) {
  if (min == null) return null;
  if (min >= 5) return { cls: "late", text: `Late ${fmtMin(min)}` };
  if (min <= -2) return { cls: "early", text: `${fmtMin(-min)} early` };
  return { cls: "ok", text: "On time" };
}

export function fmtMin(m) {
  m = Math.abs(Math.round(m));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** Offset in minutes of a time zone at a given instant. */
export function tzOffset(tz, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (t) => +parts.find((p) => p.type === t).value;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - (at.getTime() - at.getSeconds() * 1000 - at.getMilliseconds())) / 60000);
}

/* ---------------- geometry ---------------- */

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Points along the great circle from a to b, as [lon, lat]. */
export function greatCircle(a, b, n = 64) {
  const [lon1, lat1, lon2, lat2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (d === 0) return [a, b];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return pts;
}

/** Split a polyline at fraction f (0..1) of its length. Returns [done, ahead, point]. */
export function splitLine(points, f) {
  if (points.length < 2) return [points, points, points[0]];
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segs.push(len);
    total += len;
  }
  let target = Math.min(Math.max(f, 0), 1) * total;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(target / segs[i], 1) : 0;
      const p = [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
      return [[...points.slice(0, i + 1), p], [p, ...points.slice(i + 1)], p];
    }
    target -= segs[i];
  }
  return [points, [points.at(-1)], points.at(-1)];
}

/** Interpolate a train's position by km along stations that have coordinates. */
export function pointAtKm(stations, km) {
  const pts = stations.filter((s) => s.lat != null && s.lon != null).sort((a, b) => a.km - b.km);
  if (!pts.length) return null;
  if (km <= pts[0].km) return [pts[0].lon, pts[0].lat];
  for (let i = 1; i < pts.length; i++) {
    if (km <= pts[i].km) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = b.km === a.km ? 0 : (km - a.km) / (b.km - a.km);
      return [a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t];
    }
  }
  const last = pts.at(-1);
  return [last.lon, last.lat];
}

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
