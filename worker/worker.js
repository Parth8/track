/**
 * Journey API: one Cloudflare Worker for the train and flight tracker.
 *
 * Routes (GET only):
 *   /api/health
 *   /api/train?no=12786&date=2026-09-29
 *   /api/flight?no=6E6252&date=2026-09-29
 *   /api/weather?lat=17.39&lon=78.50
 *   /api/between?from=MYS&to=KCG&date=2026-10-02
 *   /api/seats?no=12306&from=NDLS&to=HWH&date=2026-10-09&cls=3A&quota=GN
 *   /api/flights?from=DEL&to=BLR&date=2026-10-02&after=17:00
 *
 * Settings (Worker > Settings > Variables and Secrets):
 *   ALLOWED_ORIGINS   text    e.g. https://yourname.github.io   (comma separated)
 *   ADB_KEY           SECRET  AeroDataBox key (RapidAPI). Flights stay off without it.
 *                             Add it with the "Secret" type, never "Text". It is only ever
 *                             sent to the AeroDataBox host, and every response is checked
 *                             so that no secret value can leave this Worker.
 *   ADB_HOST          text    optional, default aerodatabox.p.rapidapi.com
 *   REQUIRE_ORIGIN    text    optional, "false" lets you test in a browser tab
 *   QUOTA             KV namespace binding. Flight search by route stays off without it.
 *                             It holds one number per month: how many paid airport lookups
 *                             flight search has used, so it can stop before tracking runs dry.
 *   FLIGHT_SEARCH_CAP text    optional, paid airport lookups flight search may use per month
 *                             (default 40). Each search uses at most 2, and every search from
 *                             the same airport and day shares them. "0" pauses flight search.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const TTL = { train: 15, flight: 90, weather: 900, timetable: 43200, between: 21600, seats: 600, stale: 21600 };
const TRAIN_FRESH_FLOOR_MS = 5000; // a manual refresh re-fetches unless the copy is under 5 s old
const ADB_HOSTS = new Set(["aerodatabox.p.rapidapi.com"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_MS = 5.5 * 3600 * 1000;
const RATE = { windowMs: 60_000, max: 40 };

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    logEnv = env;
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const cors = allowed.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" },
      });
    }

    try {
      if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET is supported.");
      if (url.pathname === "/api/health") return reply({ ok: true, time: new Date().toISOString() }, 200, cors, 0, env);

      // Only our own site may call the data routes from a browser.
      const originOk = allowed.includes(origin) || (!origin && env.REQUIRE_ORIGIN === "false");
      if (!originOk) throw new ApiError(403, "forbidden", "This API only serves its own website.");

      await rateLimit(request, env);

      switch (url.pathname) {
        case "/api/train":
          return reply(await trainRoute(url, ctx), 200, cors, TTL.train, env);
        case "/api/flight":
          return reply(await flightRoute(url, env, ctx), 200, cors, TTL.flight, env);
        case "/api/weather":
          return reply(await weatherRoute(url, ctx), 200, cors, TTL.weather, env);
        case "/api/between":
          return reply(await betweenRoute(url, ctx), 200, cors, TTL.between, env);
        case "/api/flights":
          return reply(await flightsBetweenRoute(url, env, ctx), 200, cors, 300, env);
        case "/api/seats":
          return reply(await seatsRoute(url, ctx), 200, cors, 300, env);
        default:
          throw new ApiError(404, "not_found", "Unknown route.");
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      const code = err instanceof ApiError ? err.code : "internal_error";
      const message = err instanceof ApiError ? err.message : "Something went wrong on our side.";
      if (!(err instanceof ApiError)) log("error", "unhandled", String(err && err.stack));
      return reply({ error: code, message }, status, cors, 0, env);
    }
  },
};

/** Names of settings whose values must never appear in a response or a log. */
const isSecretName = (name) => /KEY|TOKEN|SECRET|PASS/i.test(name);

function secretValues(env) {
  return Object.entries(env || {})
    .filter(([k, v]) => isSecretName(k) && typeof v === "string" && v.length >= 6)
    .map(([, v]) => v);
}

function redact(text, env) {
  let out = String(text);
  for (const v of secretValues(env)) out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  return out;
}

/** Every log line goes through here, so secrets never reach the logs either. */
let logEnv = {};
const log = (level, ...parts) =>
  console[level](...parts.map((p) => redact(typeof p === "string" ? p : JSON.stringify(p), logEnv)));

/**
 * The only way a response leaves this Worker. Last line of defence: if a secret
 * value ever ended up in the body by any route, the body is replaced with a
 * generic error. Nothing about the secret is revealed, not even its length.
 */
function reply(body, status, cors, maxAge, env) {
  let text = JSON.stringify(body);
  const lower = text.toLowerCase();
  if (secretValues(env).some((v) => lower.includes(v.toLowerCase()))) {
    log("error", "blocked a response that contained a secret value");
    text = JSON.stringify({ error: "internal_error", message: "Something went wrong on our side." });
    status = 500;
    maxAge = 0;
  }
  return new Response(text, {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? "private, max-age=15" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Rate limiting: platform binding if configured, else per-isolate     */
/* ------------------------------------------------------------------ */

const buckets = new Map();
async function rateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.LIMITER && typeof env.LIMITER.limit === "function") {
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) throw new ApiError(429, "rate_limited", "Too many requests. Try again in a minute.");
    return;
  }
  const now = Date.now();
  const b = buckets.get(ip) || { start: now, count: 0 };
  if (now - b.start > RATE.windowMs) {
    b.start = now;
    b.count = 0;
  }
  b.count += 1;
  buckets.set(ip, b);
  if (buckets.size > 5000) buckets.clear();
  if (b.count > RATE.max) throw new ApiError(429, "rate_limited", "Too many requests. Try again in a minute.");
}

/* ------------------------------------------------------------------ */
/* Cache helpers: fresh copy + longer-lived stale copy                 */
/* ------------------------------------------------------------------ */

const cacheKey = (name) => new Request(`https://journey-cache.internal/${name}`);

async function cached(ctx, name, ttl, producer, { fresh = false, floorMs = 0 } = {}) {
  const cache = caches.default;
  const hit = await cache.match(cacheKey(name));
  if (hit) {
    const age = Date.now() - Number(hit.headers.get("X-Fetched-At") || 0);
    if (!fresh || age < floorMs) return hit.json();
  }
  try {
    const data = await producer();
    const fetchedAt = Date.now();
    if (data && typeof data === "object" && data.status && typeof data.status === "object") {
      data.status.checkedAt = new Date(fetchedAt).toISOString();
    }
    const put = (key, seconds) =>
      cache.put(
        cacheKey(key),
        new Response(JSON.stringify(data), { headers: { "Cache-Control": `max-age=${seconds}`, "X-Fetched-At": String(fetchedAt) } })
      );
    const seconds = typeof ttl === "function" ? ttl(data) : ttl;
    ctx.waitUntil(Promise.all([put(name, seconds), put(`${name}/stale`, TTL.stale)]));
    return data;
  } catch (err) {
    const stale = await cache.match(cacheKey(`${name}/stale`));
    if (stale && !(err instanceof ApiError && err.status < 500)) {
      const data = await stale.json();
      data.status = { ...(data.status || {}), servedStale: true };
      return data;
    }
    throw err;
  }
}

async function getWithRetry(url, init = {}, { timeout = 8000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (res.status >= 500) throw new Error(`upstream ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

function istToday() {
  return new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}
function validDate(value, min, max) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new ApiError(400, "invalid_date", "Date must look like 2026-09-29.");
  if (value < min || value > max) throw new ApiError(400, "date_out_of_range", `Pick a date between ${min} and ${max}.`);
  return value;
}
/** Minutes after the start date's midnight (IST) to an ISO string. */
function istIso(startIso, minutes) {
  if (minutes == null || Number.isNaN(minutes)) return null;
  const ms = Date.parse(`${startIso}T00:00:00+05:30`) + minutes * 60000;
  const d = new Date(ms + IST_MS);
  return `${d.toISOString().slice(0, 16)}:00+05:30`;
}
function hhmmToMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  return m ? +m[1] * 60 + +m[2] : null;
}

/* ------------------------------------------------------------------ */
/* Trains                                                              */
/* ------------------------------------------------------------------ */

async function trainRoute(url, ctx) {
  const no = (url.searchParams.get("no") || "").trim();
  if (!/^\d{5}$/.test(no)) throw new ApiError(400, "invalid_train", "Train numbers have 5 digits.");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, addDays(today, -3), today);
  const offset = daysBetween(today, date);

  const fresh = url.searchParams.get("fresh") === "1";
  return cached(ctx, `train/${no}/${date}`, TTL.train, async () => {
    // Today: the crowd-sourced feed has predictions. Past runs: the official record is better.
    const order = offset === 0 ? [fromRailYatri, fromNtes] : [fromNtes, fromRailYatri];
    const failures = [];
    for (const source of order) {
      try {
        const journey = await source(no, date, offset, ctx);
        if (journey) return journey;
        failures.push(`${source.name}: no data`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) failures.push(`${source.name}: not found`);
        else failures.push(`${source.name}: ${err.message}`);
      }
    }
    log("warn", "train failed", no, date, failures);
    if (failures.every((f) => /not found|no data/.test(f)))
      throw new ApiError(404, "not_found", `No run found for train ${no} starting ${date}.`);
    throw new ApiError(502, "upstream_unavailable", "Live train data is slow right now. Try again shortly.");
  }, { fresh, floorMs: TRAIN_FRESH_FLOOR_MS });
}

/* ---------- Source A: crowd-sourced running data ---------- */

let buildIdMemo = null;
async function buildId(force = false) {
  if (buildIdMemo && !force) return buildIdMemo;
  const res = await getWithRetry("https://www.railyatri.in/live-train-status/12786", { headers: { "User-Agent": UA } });
  const html = await res.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error("build id missing");
  buildIdMemo = m[1];
  return buildIdMemo;
}

async function railYatriJson(no, offset) {
  const q = offset ? `?start_day=${offset}` : "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await buildId(attempt > 0);
    const res = await getWithRetry(`https://www.railyatri.in/_next/data/${id}/live-train-status/${no}.json${q}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.status === 404) continue; // build id rotated, refresh once
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  }
  throw new Error("json route unavailable");
}

async function fromRailYatri(no, date, offset) {
  const data = await railYatriJson(no, offset);
  const lts = data?.pageProps?.ltsData;
  const tt = data?.pageProps?.timeTableData?.[0];
  if (!tt?.route?.length) throw new ApiError(404, "not_found", "Unknown train.");
  if (lts?.train_start_date && lts.train_start_date !== date) return null; // asked for another run
  return normaliseRailYatri(no, date, lts || {}, tt);
}

const KEEP_UPPER = new Set(["SF", "AC", "KSR", "MEMU", "DEMU", "EMU", "LTT", "CSMT", "SMVT", "MGR", "NSC", "II", "III"]);
function titleCase(s) {
  return (s || "")
    .replace(/~/g, "")
    .trim()
    .split(/(\s+|[()\-/])/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

function timetableStops(date, route) {
  const last = route.length - 1;
  return route.map((r, i) => ({
    code: r.station_code,
    name: titleCase(r.station_name),
    km: Math.round(parseFloat(r.distance_from_source) || 0),
    lat: parseFloat(r.lat) || null,
    lon: parseFloat(r.lng) || null,
    halts: !!r.stop || i === 0 || i === last,
    platform: r.platform_number > 0 ? String(r.platform_number) : null,
    haltMin: r.halt || 0,
    day: r.day || 1,
    onTimeRating: r.on_time_rating >= 0 ? r.on_time_rating : null,
    sched: { arr: i === 0 ? null : istIso(date, r.sta), dep: i === last ? null : istIso(date, i === 0 ? r.sta : r.std_min) },
    actual: { arr: null, dep: null },
    expected: { arr: null, dep: null },
    delay: { arr: null, dep: null },
    passed: false,
  }));
}

function normaliseRailYatri(no, date, lts, tt) {
  const stops = timetableStops(date, tt.route);
  const byCode = new Map(stops.map((s) => [s.code, s]));
  const prev = (lts.previous_stations || []).filter((s) => s.station_code);
  const next = (lts.upcoming_stations || []).filter((s) => s.station_code);

  const toIso = (hhmm, aDay) => {
    const m = hhmmToMin(hhmm);
    return m == null ? null : istIso(date, (aDay || 0) * 1440 + m);
  };
  const apply = (live, passed) => {
    const s = byCode.get(live.station_code);
    if (!s) return;
    const arr = toIso(live.eta, live.a_day);
    let dep = toIso(live.etd, live.a_day);
    if (arr && dep && dep < arr) dep = toIso(live.etd, (live.a_day || 0) + 1);
    const target = passed ? s.actual : s.expected;
    if (s.sched.arr) target.arr = arr;
    if (s.sched.dep) target.dep = dep;
    s.delay.arr = Number.isFinite(live.arrival_delay) ? live.arrival_delay : null;
    s.delay.dep = Number.isFinite(live.departure_delay) ? live.departure_delay : s.delay.arr;
    if (live.platform_number > 0) s.platform = String(live.platform_number);
    s.passed = passed;
  };
  prev.forEach((s) => apply(s, true));
  next.forEach((s) => apply(s, false));

  const total = lts.total_distance || stops[stops.length - 1].km;
  let kmDone = Number.isFinite(lts.distance_from_source) ? lts.distance_from_source : 0;
  const started = prev.length > 0 || (lts.at_src === false && lts.at_src_dstn === false);
  const arrived = !!lts.at_dstn;
  if (arrived) kmDone = total;
  for (const s of stops) if (s.km <= kmDone && started) s.passed = s.passed || s.km < kmDone || arrived;

  const phase = arrived ? "arrived" : started ? "running" : "not_started";
  const cur = byCode.get(lts.current_station_code);
  const u = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(lts.update_time || "");
  const lastUpdated = u ? new Date(`${u[1]}T${u[2]}${u[3]}:${u[4]}`).toISOString() : null;

  return {
    kind: "train",
    number: no,
    name: titleCase(lts.train_name || tt.train_name),
    date,
    source: "crowd",
    origin: { code: stops[0].code, name: stops[0].name },
    destination: { code: stops.at(-1).code, name: stops.at(-1).name },
    status: {
      phase,
      delayMin: Number.isFinite(lts.delay) ? lts.delay : null,
      lastUpdated,
      message: phase === "not_started" ? lts.new_message || null : null,
    },
    position: {
      kmDone: Math.round(kmDone),
      kmTotal: Math.round(total),
      stationCode: cur ? cur.code : lts.current_station_code || null,
      stationName: cur ? cur.name : titleCase(lts.current_station_name),
      state: lts.status === "T" || lts.ahead_distance > 0 ? "passed" : "at",
      kmPast: lts.ahead_distance || 0,
    },
    stops,
    coaches: null,
    extras: { pantry: !!lts.pantry_available, fogRisk: lts.fog_incidence_probability || 0 },
  };
}

/* ---------- Source B: official enquiry system ---------- */

async function fromNtes(no, date, offset, ctx) {
  const base = "https://enquiry.indianrail.gov.in/mntes/";
  const jar = {};
  const save = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

  const r1 = await getWithRetry(base, { headers: { "User-Agent": UA } }, { timeout: 7000 });
  save(r1);
  await r1.text();

  const r2 = await getWithRetry(`${base}GetCSRFToken?t=${Date.now()}`, {
    headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", Referer: base, Cookie: cookie() },
  });
  save(r2);
  const token = (await r2.text()).match(/name='([^']+)'\s+value='([^']+)'/);
  if (!token) throw new Error("token missing");

  const d = new Date(Date.now() + IST_MS);
  const jDate = `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  const r3 = await getWithRetry(
    `${base}tr?opt=TrainRunning&subOpt=FindRunningInstance&refDate=${jDate}`,
    {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Referer: base,
        Origin: "https://enquiry.indianrail.gov.in",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie(),
      },
      body: new URLSearchParams({ lan: "en", jDate, trainNo: no, [token[1]]: token[2] }),
    },
    { timeout: 12000, retries: 0 }
  );
  const html = await r3.text();
  const journey = parseNtes(html, no, date);
  if (!journey) return null;

  // The official feed has no coordinates. Borrow them from the timetable when we can.
  try {
    const coords = await cached(ctx, `timetable/${no}`, TTL.timetable, async () => {
      const data = await railYatriJson(no, 0);
      const route = data?.pageProps?.timeTableData?.[0]?.route || [];
      return Object.fromEntries(route.map((r) => [r.station_code, [parseFloat(r.lat), parseFloat(r.lng)]]));
    });
    for (const s of journey.stops) if (coords[s.code]) [s.lat, s.lon] = coords[s.code];
  } catch {
    /* map simply hides without coordinates */
  }
  return journey;
}

function parseNtes(html, no, date) {
  const [y, m, dd] = date.split("-");
  const paneId = `train${dd}-${MONTHS[+m - 1].toLowerCase()}-${y}`;
  const start = html.indexOf(`id="${paneId}"`);
  if (start < 0) return null;
  const nextPane = html.indexOf('<div class="tab-pane', start + 10);
  const pane = html.slice(start, nextPane > 0 ? nextPane : undefined);

  const clean = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const title = clean((html.match(/<h3>\s*(\d{5}\s[^<]+)<\/h3>/) || [])[1]);
  const headline = clean((pane.match(/<h6 class ="text-(?:primary|success|danger)"><b>([\s\S]*?)<\/b>/) || [])[1]);
  const updated = clean((pane.match(/Last Updates On<\/h4><font size="2pt">([\s\S]*?)<\/font>/) || [])[1]);
  const arrived = /Reached Destination/.test(pane);

  // "07:04 29-Sep" (optionally with * for "expected") to ISO in IST
  const toIso = (txt) => {
    const t = /(\d{2}):(\d{2}) (\d{2})-([A-Z][a-z]{2})/.exec(txt || "");
    if (!t) return null;
    let year = +y;
    const mon = MONTHS.indexOf(t[4]);
    if (mon < +m - 6) year += 1;
    return `${year}-${String(mon + 1).padStart(2, "0")}-${t[3]}T${t[1]}:${t[2]}:00+05:30`;
  };
  const minsBetween = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : null);

  const stops = [];
  const coaches = [];
  const blocks = pane.split('<div class=" w3-card-2 stopRow"').slice(1);
  for (const raw of blocks) {
    const cut = raw.indexOf("nonStopRow");
    const block = cut > 0 ? raw.slice(0, cut) : raw;
    const track = block.indexOf("w3-bar-block");
    const rightAt = block.indexOf("float:right;text-align:right;width:100px");
    const left = block.slice(0, track);
    const middle = block.slice(track, rightAt);
    const right = block.slice(rightAt, block.indexOf("<!-- Modal -->") > 0 ? block.indexOf("<!-- Modal -->") : undefined);
    const times = (part) => [...part.matchAll(/(\d{2}:\d{2} \d{2}-[A-Z][a-z]{2})(\*?)/g)].map((x) => ({ iso: toIso(x[1]), guess: !!x[2] }));
    const lt = times(left);
    const rt = times(right);
    const name = clean((middle.match(/<font size="1"><b>([^<]+)<\/b>/) || [])[1]);
    const codePf = middle.match(/<b>([A-Z0-9]+)\s+<span class="w3-round w3-orange"[^>]*>PF ([^<]+)<\/span>/);
    const code = codePf ? codePf[1] : clean((middle.match(/<b>([A-Z0-9]+)\s*<\/b>/) || [])[1]);
    const km = +((middle.match(/<b>(\d+)<\/b> KMs/) || [])[1] || 0);
    const stop = {
      code,
      name: titleCase(name),
      km,
      lat: null,
      lon: null,
      halts: true,
      platform: codePf ? codePf[2].replace("*", "").trim() : null,
      haltMin: 0,
      day: null,
      onTimeRating: null,
      sched: { arr: lt[0]?.iso || null, dep: rt[0]?.iso || null },
      actual: { arr: lt[1] && !lt[1].guess ? lt[1].iso : null, dep: rt[1] && !rt[1].guess ? rt[1].iso : null },
      expected: { arr: lt[1]?.guess ? lt[1].iso : null, dep: rt[1]?.guess ? rt[1].iso : null },
      delay: { arr: null, dep: null },
      passed: false,
    };
    stop.delay.arr = minsBetween(stop.sched.arr, stop.actual.arr || stop.expected.arr);
    stop.delay.dep = minsBetween(stop.sched.dep, stop.actual.dep || stop.expected.dep);
    stop.haltMin = Math.max(0, minsBetween(stop.sched.arr, stop.sched.dep) || 0);
    stop.passed = !!(stop.actual.arr || stop.actual.dep);
    stops.push(stop);

    const coachList = [...raw.matchAll(/<div style="text-align: center;">([A-Z0-9]+)<\/div>\s*<div[^>]*><b>([A-Z0-9]+)<\/b><\/div>/g)].map((c) => ({ cls: c[1], id: c[2] }));
    if (coachList.length) coaches.push({ code, list: coachList });
  }
  if (!stops.length) return null;

  // Non-stopping stations carry km only, which is enough to place the train on the line.
  const nonStops = [...pane.matchAll(/<font style="font-size:10px;">\s*<b>\s*([\s\S]*?)\s*- ([A-Z0-9]+)\s*<\/b>\s*<br\/>\s*<b>(\d+)<\/b> KMs/g)].map((x) => ({
    code: x[2],
    name: titleCase(clean(x[1])),
    km: +x[3],
  }));

  const pos = headline.match(/(Departed from|Arrived at|Crossed|Reached)\s+(.+?)\s*\((\w+)\)\s+at\s+(\d{2}:\d{2})/i);
  const posCode = pos ? pos[3] : null;
  const at = stops.find((s) => s.code === posCode) || nonStops.find((s) => s.code === posCode);
  const last = stops[stops.length - 1];
  const started = stops[0].actual.dep != null || stops.some((s) => s.passed);
  const phase = arrived ? "arrived" : started ? "running" : "not_started";
  const kmDone = arrived ? last.km : at ? at.km : 0;
  if (started) for (const s of stops) if (s.km <= kmDone) s.passed = true;

  const lastDelay = [...stops].reverse().find((s) => s.passed);
  const upd = updated.match(/(\d{2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}:\d{2})/);

  return {
    kind: "train",
    number: no,
    name: titleCase(title.replace(/^\d{5}\s*/, "")),
    date,
    source: "official",
    origin: { code: stops[0].code, name: stops[0].name },
    destination: { code: last.code, name: last.name },
    status: {
      phase,
      delayMin: lastDelay ? lastDelay.delay.dep ?? lastDelay.delay.arr : null,
      lastUpdated: upd ? `${upd[3]}-${String(MONTHS.indexOf(upd[2]) + 1).padStart(2, "0")}-${upd[1]}T${upd[4]}:00+05:30` : null,
      message: phase === "not_started" ? headline || null : null,
    },
    position: {
      kmDone,
      kmTotal: last.km,
      stationCode: posCode,
      stationName: at ? at.name : pos ? titleCase(pos[2]) : null,
      state: pos && /arrived|reached/i.test(pos[1]) ? "at" : "passed",
      kmPast: 0,
    },
    stops,
    nonStops,
    coaches: coaches.length ? coaches : null,
    extras: {},
  };
}

/* ------------------------------------------------------------------ */
/* Flights                                                             */
/* ------------------------------------------------------------------ */

// Names travellers know, where the flight data has another (it calls Akasa Air "Starlight Airline").
const AIRLINE_NAME = {
  "6E": "IndiGo", AI: "Air India", IX: "Air India Express", QP: "Akasa Air", SG: "SpiceJet", "9I": "Alliance Air",
  S5: "Star Air", I7: "IndiaOne Air", "2T": "TruJet", G8: "Go First", UK: "Vistara",
};
const airlineName = (iata, given) => AIRLINE_NAME[iata] || given || iata;

const AIRLINE_ICAO = {
  "6E": "IGO", AI: "AIC", IX: "AXB", QP: "AKJ", SG: "SEJ", UK: "VTI", I5: "IAD", S5: "SNJ", "9I": "LLR",
  EK: "UAE", QR: "QTR", EY: "ETD", SQ: "SIA", BA: "BAW", LH: "DLH", AF: "AFR", KL: "KLM", TK: "THY",
  UL: "ALK", TG: "THA", MH: "MAS", CX: "CPA", G9: "ABY", FZ: "FDB", WY: "OMA", GF: "GFA", SV: "SVA",
  AA: "AAL", UA: "UAL", DL: "DAL", VS: "VIR", LX: "SWR", QF: "QFA", NH: "ANA", JL: "JAL",
};

async function flightRoute(url, env, ctx) {
  if (!env.ADB_KEY) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
  const raw = (url.searchParams.get("no") || "").toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(raw)) throw new ApiError(400, "invalid_flight", "Flight numbers look like 6E 6252 or AI 101.");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, addDays(today, -2), addDays(today, 7));

  // Paid lookups are cached for minutes, not seconds. See flightTtl.
  const flight = await cached(ctx, `flight/${raw}/${date}`, flightTtl, async () => {
    const host = env.ADB_HOST || "aerodatabox.p.rapidapi.com";
    if (!ADB_HOSTS.has(host)) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
    const res = await getWithRetry(
      `https://${host}/flights/number/${raw}/${date}?withAircraftImage=false&withLocation=true&dateLocalRole=Departure`,
      { headers: { "X-RapidAPI-Key": env.ADB_KEY, "X-RapidAPI-Host": host, Accept: "application/json" } }
    );
    if (res.status === 204 || res.status === 404) throw new ApiError(404, "not_found", `No flight ${raw} found on ${date}.`);
    if (res.status === 429 || res.status === 403)
      throw new ApiError(503, "quota_exhausted", "This month's free flight lookups are used up. Trains still work.");
    if (!res.ok) throw new Error(`flight status ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) throw new ApiError(404, "not_found", `No flight ${raw} found on ${date}.`);
    return normaliseFlight(raw, date, list);
  });

  // Live position is free and changes fast, so it is looked up on every request,
  // including shortly before departure in case the schedule feed lags behind reality.
  const depRef = Date.parse(flight.departure.revised || flight.departure.sched || 0);
  const wantLive = flight.status.phase === "air" || (flight.status.phase === "pre" && Date.now() > depRef - 20 * 60000);
  if (wantLive) {
    const live = await livePosition(ctx, flight).catch(() => null);
    if (live) {
      flight.position = live;
      if (flight.status.phase === "pre" && ((live.altFt ?? 0) > 1500 || (live.speedKmh ?? 0) > 220)) {
        flight.status.phase = "air";
        flight.status.inferred = true;
      }
    }
  }
  return flight;
}

/** How long a paid flight lookup stays fresh, by phase. Keeps a free plan alive. */
function flightTtl(f) {
  const now = Date.now();
  const dep = Date.parse(f.departure.revised || f.departure.sched || 0);
  const arr = Date.parse(f.arrival.revised || f.arrival.sched || 0);
  switch (f.status.phase) {
    case "landed":
      return f.arrival.belt ? 3600 : 900;
    case "cancelled":
    case "diverted":
      return 1800;
    case "air":
      return arr - now < 30 * 60000 ? 300 : 900;
    default:
      return dep - now > 3 * 3600000 ? 1800 : 600;
  }
}

function airportOf(m) {
  const a = m?.airport || {};
  const t = (x) => x?.utc ? new Date(x.utc.replace(" ", "T").replace("Z", "") + "Z").toISOString() : null;
  return {
    code: a.iata || a.icao || "",
    name: a.shortName || a.name || "",
    city: a.municipalityName || a.name || "",
    tz: a.timeZone || null,
    lat: a.location?.lat ?? null,
    lon: a.location?.lon ?? null,
    sched: t(m?.scheduledTime),
    revised: t(m?.revisedTime) || t(m?.predictedTime),
    runway: t(m?.runwayTime),
    terminal: m?.terminal || null,
    gate: m?.gate || null,
    checkIn: m?.checkInDesk || null,
    belt: m?.baggageBelt || null,
  };
}

function normaliseFlight(no, date, list) {
  const f = list[0];
  const dep = airportOf(f.departure);
  const arr = airportOf(f.arrival);
  const raw = f.status || "Unknown";
  const now = Date.now();
  const depActual = dep.runway || (/(Departed|EnRoute|Approaching|Arrived)/.test(raw) ? dep.revised : null);
  const arrActual = arr.runway || (raw === "Arrived" ? arr.revised : null);

  let phase = "pre";
  if (/Cancel/i.test(raw)) phase = "cancelled";
  else if (raw === "Diverted") phase = "diverted";
  else if (arrActual || raw === "Arrived") phase = "landed";
  else if (depActual || /Departed|EnRoute|Approaching/.test(raw)) phase = "air";

  const mins = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : null);
  const airline = f.airline || {};
  const iata = no.slice(0, 2);
  const icao = airline.icao || AIRLINE_ICAO[iata];
  const callsign = (f.callSign || (icao ? icao + no.slice(2) : no)).replace(/\s+/g, "");

  let position = null;
  if (f.location?.lat != null) {
    position = {
      lat: f.location.lat,
      lon: f.location.lon,
      altFt: f.location.pressureAltitude?.feet ?? null,
      speedKmh: f.location.groundSpeed?.kt != null ? Math.round(f.location.groundSpeed.kt * 1.852) : null,
      trackDeg: f.location.trueTrack?.deg ?? null,
      at: f.location.reportedAtUtc ? new Date(f.location.reportedAtUtc.replace(" ", "T").replace("Z", "") + "Z").toISOString() : null,
      source: "reported",
    };
  }

  return {
    kind: "flight",
    number: `${iata} ${no.slice(2)}`,
    date,
    airline: { name: airlineName(iata, airline.name), iata },
    callsign,
    status: {
      phase,
      raw,
      delayDep: mins(dep.sched, dep.revised || depActual),
      delayArr: mins(arr.sched, arr.revised || arrActual),
      lastUpdated: f.lastUpdatedUtc ? new Date(f.lastUpdatedUtc.replace(" ", "T").replace("Z", "") + "Z").toISOString() : new Date(now).toISOString(),
    },
    departure: { ...dep, actual: depActual },
    arrival: { ...arr, actual: arrActual },
    distanceKm: f.greatCircleDistance?.km ? Math.round(f.greatCircleDistance.km) : null,
    aircraft: f.aircraft ? { model: f.aircraft.model || null, reg: f.aircraft.reg || null, hex: (f.aircraft.modeS || "").toLowerCase() || null } : null,
    position,
    legs: list.length,
  };
}

/* ------------------------------------------------------------------ */
/* Flights between two airports                                        */
/* ------------------------------------------------------------------ */

// AeroDataBox's free plan is 400 units a month and a departure board costs 2, so 40 lookups
// (80 units) leaves most of the plan for tracking flights by number.
const SEARCH_CAP_DEFAULT = 40;
const SLOTS = { am: ["00:00", "11:59"], pm: ["12:00", "23:59"] };

/**
 * Every flight from one airport to another on a local date. Built from the origin's
 * departure board in two 12-hour slots, each cached and shared by every search from that
 * airport that day, whatever the destination. Codeshares are left out: one row per real flight.
 */
async function flightsBetweenRoute(url, env, ctx) {
  if (!env.ADB_KEY) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
  const code = (k) => (url.searchParams.get(k) || "").trim().toUpperCase();
  const from = code("from");
  const to = code("to");
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new ApiError(400, "invalid_airport", "Airport codes have 3 letters, like DEL or BLR.");
  if (from === to) throw new ApiError(400, "same_airport", "From and To are the same airport.");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, addDays(today, -1), addDays(today, 7));
  const afterRaw = url.searchParams.get("after") || "";
  const afterMin = /^\d{2}:\d{2}$/.test(afterRaw) ? hhmmToMin(afterRaw) : null;
  const after = afterMin != null && afterMin < 1440 ? afterRaw : null;
  // An afternoon or evening search only needs the second half of the day.
  const slots = after && afterMin >= 720 ? ["pm"] : ["am", "pm"];

  const got = await Promise.allSettled(slots.map((slot) => departureSlot(env, ctx, from, date, slot)));
  const ok = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
  if (!ok.length) throw got[0].reason;

  const flights = flightsTo(ok.flatMap((s) => s.departures), to);
  const checked = ok.map((s) => Date.parse(s.status?.checkedAt || "")).filter(Number.isFinite);
  return {
    kind: "flights",
    from: { code: from },
    to: flights[0]?.arr.code === to ? { code: to, name: flights[0].arr.name, tz: flights[0].arr.tz } : { code: to },
    date,
    after,
    flights,
    partial: ok.length < slots.length,
    // Why part of the day is missing, in words the page can show.
    partialNote: ok.length < slots.length ? partialNote(got.find((g) => g.status === "rejected").reason) : null,
    asOf: checked.length ? new Date(Math.min(...checked)).toISOString() : new Date().toISOString(),
    status: { servedStale: ok.some((s) => s.status?.servedStale) || undefined },
  };
}

function partialNote(err) {
  return err instanceof ApiError ? err.message : "Part of the day couldn't be loaded. Try again shortly.";
}

/** One half-day of an airport's departure board: a paid lookup, so cached and counted. */
function departureSlot(env, ctx, from, date, slot) {
  const today = istToday();
  const ttl = date === today ? 900 : date < today ? 3600 : 21600;
  return cached(ctx, `fids/${from}/${date}/${slot}`, ttl, async () => {
    const host = env.ADB_HOST || "aerodatabox.p.rapidapi.com";
    if (!ADB_HOSTS.has(host)) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
    await spendSearch(env);
    const [a, b] = SLOTS[slot];
    const q = "withLeg=true&direction=Departure&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false";
    let res;
    try {
      res = await getWithRetry(`https://${host}/flights/airports/iata/${from}/${date}T${a}/${date}T${b}?${q}`, {
        headers: { "X-RapidAPI-Key": env.ADB_KEY, "X-RapidAPI-Host": host, Accept: "application/json" },
      }, { timeout: 12000, retries: 1 });
    } catch (err) {
      log("warn", "departures failed", from, date, slot, String(err && err.message));
      throw new ApiError(502, "upstream_unavailable", "Flight schedules are slow right now. Try again shortly.");
    }
    if (res.status === 204) return { departures: [], status: {} };
    if (res.status === 400 || res.status === 404) throw new ApiError(404, "airport_not_found", `No departure board for ${from}.`);
    if (res.status === 429 || res.status === 403)
      throw new ApiError(503, "quota_exhausted", "This month's free flight lookups are used up. Trains still work.");
    if (!res.ok) throw new ApiError(502, "upstream_unavailable", "Flight schedules are slow right now. Try again shortly.");
    const body = await res.json().catch(() => null);
    return { departures: Array.isArray(body?.departures) ? body.departures : [], status: {} };
  });
}

/**
 * Count one paid lookup against this month's flight-search budget, or refuse.
 * Tracking a flight by number never goes through here, so it keeps working when search pauses.
 */
let spendQueue = Promise.resolve();
function spendSearch(env) {
  // One at a time within this Worker, so two slots looked up together both get counted.
  const turn = spendQueue.then(() => spendOne(env));
  spendQueue = turn.catch(() => {});
  return turn;
}

async function spendOne(env) {
  const kv = env.QUOTA;
  if (!kv || typeof kv.get !== "function") throw new ApiError(503, "search_not_configured", "Flight search isn't switched on yet. Track by flight number for now.");
  const cap = Number.parseInt(env.FLIGHT_SEARCH_CAP ?? "", 10);
  const limit = Number.isFinite(cap) && cap >= 0 ? cap : SEARCH_CAP_DEFAULT;
  const month = istToday().slice(0, 7);
  const key = `flight-search/${month}`;
  const used = Number(await kv.get(key)) || 0;
  if (used >= limit) {
    const m = Number(month.slice(5, 7));
    const next = `1 ${MONTHS[m % 12]}`;
    throw new ApiError(503, "search_paused", `Flight search is resting until ${next} to save lookups for live tracking. Tracking by flight number still works.`);
  }
  // KV isn't atomic across Workers, so a busy minute can overshoot by a lookup or two. Fine for a monthly budget.
  await kv.put(key, String(used + 1), { expirationTtl: 60 * 60 * 24 * 45 });
}

const hmOf = (x) => (/^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(x?.local || "") || [])[1] || null;
const dateOf = (x) => (/^(\d{4}-\d{2}-\d{2})/.exec(x?.local || "") || [])[1] || null;
const date0 = (iso) => (iso ? iso.slice(0, 10) : null);

/** Departures that land at `to`, one row per flight, earliest first. */
function flightsTo(departures, to) {
  const t = (x) => (x?.utc ? new Date(x.utc.replace(" ", "T").replace("Z", "") + "Z").toISOString() : null);
  const seen = new Set();
  const out = [];
  for (const f of departures) {
    // withLeg=true gives departure + arrival; without it, `movement` describes the other airport.
    const dep = f.departure || f.movement || {};
    const arr = f.arrival || (f.departure ? {} : f.movement) || {};
    const ap = (f.arrival && f.arrival.airport) || (f.movement && f.movement.airport) || {};
    if ((ap.iata || "").toUpperCase() !== to) continue;
    if (f.codeshareStatus === "IsCodeshared" || f.isCargo) continue;
    const number = String(f.number || "").replace(/\s+/g, " ").trim().toUpperCase();
    const no = number.replace(/\s+/g, "");
    if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(no) || seen.has(no)) continue;
    const depSched = t(dep.scheduledTime);
    if (!depSched) continue;
    seen.add(no);
    const raw = f.status || "Unknown";
    const depRev = t(dep.revisedTime) || t(dep.predictedTime);
    const depActual = t(dep.runwayTime);
    const arrSched = f.arrival ? t(arr.scheduledTime) : null;
    const arrRev = f.arrival ? t(arr.revisedTime) || t(arr.predictedTime) : null;
    let phase = "pre";
    if (/Cancel/i.test(raw)) phase = "cancelled";
    else if (raw === "Diverted") phase = "diverted";
    else if (raw === "Arrived") phase = "landed";
    else if (depActual || /Departed|EnRoute|Approaching/.test(raw)) phase = "air";
    const mins = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : null);
    const localDate = dateOf(dep.scheduledTime);
    out.push({
      number: /^[A-Z0-9]{2} /.test(number) ? number : `${no.slice(0, 2)} ${no.slice(2)}`,
      no,
      date: localDate,
      airline: { name: airlineName(no.slice(0, 2), f.airline?.name), iata: f.airline?.iata || no.slice(0, 2) },
      status: { raw, phase, delayMin: mins(depSched, depRev) },
      // Local clock times at each airport ("06:00") and local dates, so the page needs no time zones.
      dep: {
        sched: depSched,
        revised: depRev,
        actual: depActual,
        local: hmOf(dep.scheduledTime),
        revisedLocal: hmOf(dep.revisedTime || dep.predictedTime),
        localDate: localDate || date0(depSched),
        terminal: dep.terminal || null,
        gate: dep.gate || null,
      },
      arr: {
        code: to,
        name: ap.shortName || ap.name || to,
        tz: ap.timeZone || null,
        sched: arrSched,
        revised: arrRev,
        local: hmOf(arr.scheduledTime),
        revisedLocal: hmOf(arr.revisedTime || arr.predictedTime),
        localDate: f.arrival ? dateOf(arr.scheduledTime) : null,
        terminal: arr.terminal || null,
      },
      durationMin: mins(depSched, arrSched),
      aircraft: f.aircraft?.model || null,
    });
  }
  out.sort((a, b) => (a.dep.sched < b.dep.sched ? -1 : a.dep.sched > b.dep.sched ? 1 : 0));
  return out;
}

const ADSB = [
  { name: "adsb.lol", base: "https://api.adsb.lol/v2", hex: "hex", reg: "reg", cs: "callsign" },
  { name: "adsb.fi", base: "https://opendata.adsb.fi/api/v2", hex: "hex", reg: "registration", cs: "callsign" },
];

/**
 * Ask several community receiver networks at once, by transponder code first
 * (most reliable), then registration, then callsign. First good answer wins.
 */
async function livePosition(ctx, flight) {
  const hex = flight.aircraft?.hex;
  const reg = flight.aircraft?.reg?.replace(/[^A-Z0-9-]/gi, "");
  const cs = /^[A-Z0-9]{3,8}$/.test(flight.callsign || "") ? flight.callsign : null;
  const id = hex || reg || cs;
  if (!id) return null;

  const cache = caches.default;
  const key = cacheKey(`pos/${id}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()).pos;

  const attempts = [];
  for (const p of ADSB) {
    if (hex) attempts.push(lookup(p, p.hex, hex));
    else if (reg) attempts.push(lookup(p, p.reg, reg));
    if (cs) attempts.push(lookup(p, p.cs, cs));
  }
  const pos = await Promise.any(attempts).catch(() => null);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify({ pos }), { headers: { "Cache-Control": "max-age=20" } })));
  return pos;
}

async function lookup(provider, path, value) {
  const res = await fetch(`${provider.base}/${path}/${encodeURIComponent(value)}`, {
    headers: { "User-Agent": "journey-tracker/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(3500),
  });
  if (!res.ok) throw new Error(`${provider.name} ${res.status}`);
  const data = await res.json();
  const list = data.ac || data.aircraft || [];
  const ac = list
    .filter((a) => a.lat != null && a.lon != null && (a.seen_pos ?? a.seen ?? 0) <= 600)
    .sort((x, y) => (x.seen_pos ?? 0) - (y.seen_pos ?? 0))[0];
  if (!ac) throw new Error(`${provider.name} no fix`);
  const age = Math.round(ac.seen_pos ?? ac.seen ?? 0);
  return {
    lat: ac.lat,
    lon: ac.lon,
    altFt: typeof ac.alt_baro === "number" ? ac.alt_baro : typeof ac.alt_geom === "number" ? ac.alt_geom : null,
    speedKmh: ac.gs != null ? Math.round(ac.gs * 1.852) : null,
    trackDeg: ac.track ?? ac.true_heading ?? null,
    at: new Date(Date.now() - age * 1000).toISOString(),
    ageSec: age,
    source: "live",
    via: provider.name,
  };
}

/* ------------------------------------------------------------------ */
/* Trains between two stations                                         */
/* ------------------------------------------------------------------ */

const RUN_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

/**
 * Every train from one station to another on a date, for the route finder.
 * `date` is the day you board at `from`. Each train says which day its run started,
 * which is the date the live tracker needs.
 */
async function betweenRoute(url, ctx) {
  const code = (k) => (url.searchParams.get(k) || "").trim().toUpperCase();
  const from = code("from");
  const to = code("to");
  if (!/^[A-Z]{1,5}$/.test(from) || !/^[A-Z]{1,5}$/.test(to))
    throw new ApiError(400, "invalid_station", "Station codes are 1 to 5 letters, like MYS or KCG.");
  if (from === to) throw new ApiError(400, "same_station", "From and To are the same station.");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, addDays(today, -3), addDays(today, 120));

  // Timetables change rarely, so one lookup per route and date serves everyone for hours.
  return cached(ctx, `between/${from}/${to}/${date}`, TTL.between, async () => {
    const q = new URLSearchParams({ from, to, dateOfJourney: date });
    const slow = () => new ApiError(502, "upstream_unavailable", "Train timetables are slow right now. Try again shortly.");
    let res;
    try {
      res = await getWithRetry(`https://trainticketapi.railyatri.in/api/trains-between-station-with-sa.json?${q}`, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.railyatri.in/" },
      });
    } catch (err) {
      log("warn", "between failed", from, to, date, String(err && err.message));
      throw slow();
    }
    if (!res.ok) throw slow();
    const body = await res.json().catch(() => null);
    if (!body || body.success !== true) throw slow();
    return normaliseBetween(from, to, date, body);
  });
}

function normaliseBetween(from, to, date, body) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const rating = (v) => (num(v) != null && num(v) >= 0 ? num(v) : null);
  const days = (t) => (t.run_days || t.train_run_days || []).filter((d) => RUN_DAYS.has(d));
  const station = (c, n) => ({ code: String(c || "").toUpperCase(), name: titleCase(n || c || "") });
  // "5 Kms from SBC": how far a nearby station the timetable suggests is from the one asked for.
  const nearKm = (txt) => {
    const m = /([\d.]+)\s*km/i.exec(String(txt || ""));
    return m ? Math.round(Number(m[1])) : null;
  };
  const base = (t) => ({
    number: String(t.train_number || "").trim(),
    name: String(t.train_name || "").replace(/\s+/g, " ").trim(),
    from: station(t.from, t.from_station_name),
    to: station(t.to, t.to_station_name),
    runDays: days(t),
    distanceKm: num(t.distance) != null ? Math.round(num(t.distance)) : null,
  });

  const seen = new Set();
  const trains = [];
  for (const t of body.train_between_stations || []) {
    const depMin = hhmmToMin(t.from_std || t.from_sta);
    const arrMin = hhmmToMin(t.to_sta || t.to_std);
    const fromDay = num(t.from_day) || 0;
    const toDay = num(t.to_day) || 0;
    if (!/^\d{5}$/.test(String(t.train_number || "").trim()) || depMin == null || arrMin == null) continue;
    // The run started fromDay days before the day you board.
    const startDate = addDays(date, -fromDay);
    const dep = istIso(startDate, fromDay * 1440 + depMin);
    const arr = istIso(startDate, toDay * 1440 + arrMin);
    const b = base(t);
    if (b.from.code !== from) b.from.nearKm = nearKm(t.from_distance_text);
    if (b.to.code !== to) b.to.nearKm = nearKm(t.to_distance_text);
    const train = {
      ...b,
      startDate,
      dep,
      arr,
      durationMin: num(t.duration_min) || Math.round((Date.parse(arr) - Date.parse(dep)) / 60000),
      onTimeRating: rating(t.to_on_time_rating) ?? rating(t.on_time_rating),
      pantry: !!t.has_pantry,
      special: !!t.special_train,
      classes: classesOf(t),
    };
    if (seen.has(train.number)) continue;
    seen.add(train.number);
    trains.push(train);
  }
  trains.sort((a, b) => (a.dep < b.dep ? -1 : a.dep > b.dep ? 1 : 0));

  // Trains on this route that don't run that day, with the next day they do.
  const others = [];
  for (const t of body.alternate_trains || []) {
    const b = base(t);
    if (!/^\d{5}$/.test(b.number) || seen.has(b.number)) continue;
    seen.add(b.number);
    others.push({
      ...b,
      depTime: /^\d{1,2}:\d{2}/.test(t.from_std || "") ? t.from_std.slice(0, 5) : null,
      arrTime: /^\d{1,2}:\d{2}/.test(t.to_sta || "") ? t.to_sta.slice(0, 5) : null,
      nextDate: /^\d{4}-\d{2}-\d{2}$/.test(t.train_date || "") ? t.train_date : null,
      arrDay: Math.max(0, (num(t.to_day) || 0) - (num(t.from_day) || 0)),
      durationMin: num(t.duration_min),
    });
  }

  return {
    kind: "between",
    from: trains.find((t) => t.from.code === from)?.from || { code: from, name: null },
    to: trains.find((t) => t.to.code === to)?.to || { code: to, name: null },
    date,
    trains,
    others: others.slice(0, 8),
    status: {},
  };
}

/** Travel classes a train carries on this route, cheapest first, as the timetable lists them. */
function classesOf(t) {
  const seen = new Set();
  const out = [];
  let list = Array.isArray(t.class_type) && t.class_type.length ? t.class_type : (t.journey_class || []).map((c) => ({ coach_type: c }));
  // When coach counts are known, a class with no coaches isn't really on the train.
  if (list.some((c) => Number(c?.coach_count) > 0)) list = list.filter((c) => Number(c?.coach_count) > 0);
  for (const c of list) {
    const code = String(c?.coach_type || "").toUpperCase().trim();
    if (!SEAT_CLASSES[code] || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Seat availability                                                   */
/* ------------------------------------------------------------------ */

const SEAT_CLASSES = {
  "1A": "AC First Class",
  "2A": "AC 2 Tier",
  "3A": "AC 3 Tier",
  "3E": "AC 3 Economy",
  EA: "AC Executive Anubhuti",
  EC: "Executive Chair Car",
  EV: "Vistadome AC",
  CC: "AC Chair Car",
  FC: "First Class",
  SL: "Sleeper",
  "2S": "Second Sitting",
};
const SEAT_QUOTAS = { GN: "General", TQ: "Tatkal" };

/**
 * Live seat availability (IRCTC, via RailYatri) for one train, class and quota,
 * for the day you board and the next few runs. Cached for 10 minutes: it moves, but
 * not second by second, and one lookup can serve everyone checking the same train.
 */
async function seatsRoute(url, ctx) {
  const p = (k) => (url.searchParams.get(k) || "").trim().toUpperCase();
  const no = p("no");
  const from = p("from");
  const to = p("to");
  const cls = p("cls");
  const quota = p("quota") || "GN";
  if (!/^\d{5}$/.test(no)) throw new ApiError(400, "invalid_train", "Train numbers have 5 digits.");
  if (!/^[A-Z]{1,5}$/.test(from) || !/^[A-Z]{1,5}$/.test(to))
    throw new ApiError(400, "invalid_station", "Station codes are 1 to 5 letters, like MYS or KCG.");
  if (from === to) throw new ApiError(400, "same_station", "From and To are the same station.");
  if (!SEAT_CLASSES[cls]) throw new ApiError(400, "invalid_class", "Pick a class like SL, 3A or 2A.");
  if (!SEAT_QUOTAS[quota]) throw new ApiError(400, "invalid_quota", "Quota must be GN (General) or TQ (Tatkal).");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, today, addDays(today, 120));

  return cached(ctx, `seats/${no}/${from}/${to}/${date}/${cls}/${quota}`, TTL.seats, async () => {
    const q = new URLSearchParams({
      device_type_id: "6",
      src: "ttb_landing",
      utm_source: "",
      is_update: "true",
      update_duration: "0",
      d_day: "0",
      train_source: from,
      train_destination: to,
      v_code: "",
    });
    const slow = () => new ApiError(502, "upstream_unavailable", "Seat availability is slow right now. Try again shortly.");
    let res;
    try {
      res = await getWithRetry(`https://sa.railyatri.in/api/seat/enquiry/${no}/${date}/${from}/${to}/${cls}/${quota}.json?${q}`, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.railyatri.in/" },
      }, { timeout: 12000, retries: 1 });
    } catch (err) {
      log("warn", "seats failed", no, from, to, date, cls, quota, String(err && err.message));
      throw slow();
    }
    if (!res.ok) throw slow();
    const body = await res.json().catch(() => null);
    if (!body || body.success !== true) throw slow();
    return normaliseSeats({ no, from, to, date, cls, quota }, body);
  });
}

/** "AVAILABLE-0048", "RAC  87/RAC  78", "GNWL119/WL47", "REGRET" → what it means now. */
function seatState(row) {
  const raw = String(row.availablity_status || row.current_status || "").replace(/#/g, "").replace(/\s+/g, " ").trim();
  const text = String(row.seat_avl_text || "").toUpperCase();
  const lastNum = (s) => {
    const all = s.match(/\d+/g);
    return all ? Number(all[all.length - 1]) : null;
  };
  const up = raw.toUpperCase();
  if (/DEPARTED/.test(up)) return { kind: "closed", count: null, label: "Train departed", raw };
  if (/CHART|CLOSED|BOOKING NOT ALLOWED|SUSPENDED/.test(up)) return { kind: "closed", count: null, label: "Booking closed", raw };
  if (/NOT ?AVAILABLE/.test(up)) return { kind: "closed", count: null, label: "Not available", raw };
  if (text === "REGRET" || /REGRET/.test(up)) return { kind: "regret", count: null, label: "Regret", raw };
  if (text === "AVAILABLE" || /^(CURR_)?AVA?I?LA?BLE|^AVBL/.test(up)) {
    const n = lastNum(up);
    return { kind: "available", count: n, label: n ? `${n} available` : "Available", raw };
  }
  if (text === "RAC" || /^RAC/.test(up)) {
    const n = lastNum(up);
    return { kind: "rac", count: n, label: n ? `RAC ${n}` : "RAC", raw };
  }
  if (text === "WAITLIST" || /WL/.test(up)) {
    const n = Number.isFinite(Number(row.seat_avl)) && Number(row.seat_avl) > 0 ? Number(row.seat_avl) : lastNum(up);
    return { kind: "waitlist", count: n, label: n ? `Waitlist ${n}` : "Waitlist", raw };
  }
  return { kind: "unknown", count: null, label: raw ? titleCase(raw) : "Not known", raw };
}

/** "9-10-2026" → "2026-10-09" */
function dmyToIso(s) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

function normaliseSeats(q, body) {
  const rows = Array.isArray(body.seat_availibility) ? body.seat_availibility : [];
  const err = String(body.error || "").trim();
  if (!rows.length) {
    if (/class does not exist/i.test(err)) throw new ApiError(404, "class_not_found", `${SEAT_CLASSES[q.cls]} isn't on this train between these stations.`);
    if (/invalid journey|not run|does not run/i.test(err)) throw new ApiError(404, "not_running", "This train doesn't run between these stations on that day.");
    if (q.quota === "TQ") throw new ApiError(404, "tatkal_closed", "Tatkal for this day isn't open yet. It opens the day before the train leaves.");
    throw new ApiError(502, "upstream_unavailable", "Seat availability is slow right now. Try again shortly.");
  }
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
  const days = [];
  for (const r of rows) {
    const date = dmyToIso(r.availablity_date || r["Date (DD-MM-YYYY)"]);
    if (!date || days.some((d) => d.date === date)) continue;
    const state = seatState(r);
    const chance = Number(r.cp_percentage);
    days.push({
      date,
      ...state,
      fare: num(r.total_fare),
      baseFare: num(r.ticket_fare),
      catering: num(r.catering_charge),
      // A confirmation guess only means something for a waitlist or RAC.
      chance: (state.kind === "waitlist" || state.kind === "rac") && Number.isFinite(chance) && chance >= 0 && chance <= 100 ? Math.round(chance) : null,
    });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  const updated = rows.map((r) => Date.parse(r.last_updated_at || "")).filter(Number.isFinite);
  return {
    kind: "seats",
    number: q.no,
    from: q.from,
    to: q.to,
    date: q.date,
    cls: q.cls,
    className: SEAT_CLASSES[q.cls],
    quota: q.quota,
    quotaName: SEAT_QUOTAS[q.quota],
    days: days.slice(0, 6),
    updatedAt: updated.length ? new Date(Math.max(...updated)).toISOString() : new Date().toISOString(),
    source: body.data_from === "IRCTC" ? "IRCTC" : "Railway booking data",
    status: {},
  };
}

/* ------------------------------------------------------------------ */
/* Weather                                                             */
/* ------------------------------------------------------------------ */

async function weatherRoute(url, ctx) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new ApiError(400, "invalid_location", "Latitude or longitude is out of range.");
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  return cached(ctx, `weather/${la}/${lo}`, TTL.weather, async () => {
    const q = new URLSearchParams({
      latitude: la,
      longitude: lo,
      current: "temperature_2m,weather_code,is_day",
      hourly: "temperature_2m,weather_code",
      daily: "sunrise,sunset",
      timezone: "auto",
      past_days: "1",
      forecast_days: "3",
    });
    const res = await getWithRetry(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const w = await res.json();
    return {
      tz: w.timezone,
      offsetSec: w.utc_offset_seconds,
      current: { temp: w.current?.temperature_2m, code: w.current?.weather_code, isDay: !!w.current?.is_day },
      hourly: { time: w.hourly?.time || [], temp: w.hourly?.temperature_2m || [], code: w.hourly?.weather_code || [] },
      daily: { date: w.daily?.time || [], sunrise: w.daily?.sunrise || [], sunset: w.daily?.sunset || [] },
    };
  });
}
