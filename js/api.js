const BASE = (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * GET a Worker route with a hard timeout and one retry on network or 5xx errors.
 * The Worker already retries upstream, so one extra attempt here is enough.
 */
export async function api(path, params = {}, { timeout = 20000, retries = 1 } = {}) {
  if (!BASE || BASE.includes("YOUR-")) throw new ApiError("not_configured", "The API address is not set in index.html yet.");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);

  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return path === "/api/flight" || path === "/api/aircraft" ? withCities(body) : body;
      last = new ApiError(body.error || "http_error", body.message || "Something went wrong.", res.status);
      if (res.status < 500) throw last;
    } catch (err) {
      if (err instanceof ApiError && err.status && err.status < 500) throw err;
      last =
        err instanceof ApiError
          ? err
          : new ApiError(err.name === "AbortError" ? "timeout" : "network", "Could not reach live data. Check your connection.");
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 700));
  }
  throw last;
}

/**
 * Airports by the city people know them by: "Hyderabad", not the airport's suburb (Shamshabad).
 * The airport list is ours (OurAirports); if it isn't ready within a second, the flight's own
 * names stay, and the next refresh has them.
 */
async function withCities(f) {
  try {
    const { loadAirports, airportByCode } = await import("./airports.js");
    await Promise.race([loadAirports(), new Promise((r) => setTimeout(r, 1000))]);
    const fix = (m) => {
      const a = m?.code && airportByCode(m.code);
      if (a) ((m.city = a.city), (m.airportName = a.airport || m.name));
    };
    fix(f?.departure);
    fix(f?.arrival);
    fix(f?.inbound?.from);
    fix(f?.inbound?.prev?.from);
    for (const x of f?.flights || []) (fix(x.from), fix(x.to)); // a plane's day
  } catch {
    /* the flight's own names stand */
  }
  return f;
}

/** Weather is fetched once per place per 15 minutes per session. */
const weatherMemo = new Map();
export function weatherAt(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = weatherMemo.get(key);
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.promise;
  const promise = api("/api/weather", { lat: lat.toFixed(2), lon: lon.toFixed(2) }, { timeout: 12000, retries: 0 }).catch((e) => {
    weatherMemo.delete(key);
    throw e;
  });
  weatherMemo.set(key, { at: Date.now(), promise });
  return promise;
}

/** An airport's own weather (METAR now, TAF ahead), once per airport per 10 minutes per session. */
const airMemo = new Map();
export function airportWeather(icao) {
  const hit = airMemo.get(icao);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.promise;
  const promise = api("/api/airwx", { icao }, { timeout: 12000, retries: 0 }).catch((e) => {
    airMemo.delete(icao);
    throw e;
  });
  airMemo.set(icao, { at: Date.now(), promise });
  return promise;
}

/** A plane's details and photo, once per registration per 30 minutes per session. */
const planeMemo = new Map();
export function planeInfo(reg) {
  const hit = planeMemo.get(reg);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.promise;
  const promise = api("/api/aircraft", { reg }, { timeout: 15000, retries: 0 }).catch((e) => {
    planeMemo.delete(reg);
    throw e;
  });
  planeMemo.set(reg, { at: Date.now(), promise });
  return promise;
}
