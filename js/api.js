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
      if (res.ok) return body;
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
