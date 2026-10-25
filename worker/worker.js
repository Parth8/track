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
 *   /api/coaches?no=12786     (the train's published coach order, kept a day)
 *   /api/dayof?no=12786&date=2026-11-14&at=SBC   (today's run at your station: coach order and
 *                              platform from the railway's enquiry system, delays from two more)
 *   /api/pnr?pnr=1234567890   (a booking's status; the PNR is never logged, and is cached
 *                              only under a hash of it, for 5 minutes)
 *
 * Settings (Worker > Settings > Variables and Secrets):
 *   ALLOWED_ORIGINS   text    e.g. https://yourname.github.io   (comma separated)
 *   ADB_KEY           SECRET  AeroDataBox key (RapidAPI). Flights stay off without it.
 *                             Add it with the "Secret" type, never "Text". It is only ever
 *                             sent to the AeroDataBox host, and every response is checked
 *                             so that no secret value can leave this Worker.
 *   ADB_HOST          text    optional, default aerodatabox.p.rapidapi.com
 *   REQUIRE_ORIGIN    text    optional, "false" lets you test in a browser tab
 *   QUOTA             KV namespace binding: the flight-data budget. Flight search stays off
 *                             without it. It holds this month's count of paid lookups, a tiny
 *                             per-visitor count for today (a hashed address, kept 2 days), and
 *                             airport details learned once and kept.
 *   FLIGHT_LOOKUP_CAP text    optional, paid AeroDataBox calls a month for tracking and search
 *                             together (default 180, which is 360 of the free plan's 400 units).
 *                             They're released day by day, and unused days roll over.
 *   FLIGHT_VISITOR_DAILY text optional, new flights (or searches) one visitor can bring in a day
 *                             (default 3). Refreshing ones they follow, or ones anyone already
 *                             looked up, doesn't count.
 *   FLIGHT_PER_FLIGHT_DAILY text optional, paid refreshes one flight can use a day (default 8).
 *   PNR_WAIT_MS       text    optional, how long to wait for a booking RailYatri hasn't fetched
 *                             before (default 24000).
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const TTL = { train: 15, flight: 90, weather: 900, timetable: 43200, between: 21600, seats: 600, pnr: 300, coaches: 86400, stale: 21600 };
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
          return reply(await flightRoute(url, env, ctx, request), 200, cors, TTL.flight, env);
        case "/api/weather":
          return reply(await weatherRoute(url, ctx), 200, cors, TTL.weather, env);
        case "/api/between":
          return reply(await betweenRoute(url, ctx), 200, cors, TTL.between, env);
        case "/api/flights":
          return reply(await flightsBetweenRoute(url, env, ctx, request), 200, cors, 300, env);
        case "/api/seats":
          return reply(await seatsRoute(url, ctx), 200, cors, 300, env);
        case "/api/dayof":
          return reply(await dayOfRoute(url, ctx, env), 200, cors, 60, env);
        case "/api/coaches":
          return reply(await coachesRoute(url, ctx), 200, cors, 3600, env);
        case "/api/pnr":
          return reply(await pnrRoute(url, ctx, env), 200, cors, 0, env); // personal: never kept by the browser or a proxy
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

async function fromNtes(no, date, offset, ctx, { coords = true } = {}) {
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
  if (coords) try {
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
      platformMark: codePf && codePf[2].includes("*") ? "*" : null, // NTES's own marker, passed on as is
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

/**
 * A flight's status. Paid lookups are the last resort, in this order:
 *   1. a fresh copy someone already paid for (cached by phase, see flightTtl)
 *   2. a flight we know is in the air, kept current on free live positions
 *   3. a departure board someone's search already paid for (hundreds of flights each)
 *   4. a paid lookup, if today's share of the month and this visitor's share allow it
 *   5. otherwise the last known copy, labelled, or a clear "resting" message
 */
async function flightRoute(url, env, ctx, request) {
  if (!env.ADB_KEY) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
  const raw = (url.searchParams.get("no") || "").toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(raw)) throw new ApiError(400, "invalid_flight", "Flight numbers look like 6E 6252 or AI 101.");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, addDays(today, -2), addDays(today, 7));
  const key = `flight/${raw}/${date}`;
  const item = `${raw}/${date}`;

  let flight = (await cacheGet(key))?.data || null;
  let liveDone = false;
  if (!flight) {
    const old = (await cacheGet(`${key}/stale`))?.data || null;
    const now = Date.now();

    // In the air, people want the position, and that's free. No paid calls until it has landed.
    if (old && mayBeFlying(old)) {
      const live = await livePosition(ctx, old).catch(() => null);
      const airborne = live && ((live.altFt ?? 0) > 1500 || (live.speedKmh ?? 0) > 220);
      const arrRef = Date.parse(old.arrival.revised || old.arrival.sched || 0);
      if (airborne) {
        flight = old;
        flight.position = live;
        if (flight.status.phase === "pre") flight.status.inferred = true;
        flight.status.phase = "air";
        liveDone = true;
      } else if (old.status.phase === "air" && (!arrRef || now < arrRef + 15 * 60000)) {
        // Out of receiver range, or just touching down: keep what we know until 15 minutes after
        // landing time, then make the one paid check that brings the landing time and belt.
        flight = old;
        if (live) flight.position = live;
        liveDone = true;
      }
    }
    // A departure board someone's search already paid for
    if (!flight) {
      flight = await fromBoards(env, ctx, raw, date).catch(() => null);
      if (flight) putFlight(ctx, key, flight);
    }
    // Before take-off: refresh the whole departure board, which updates every flight from that
    // airport for everyone, for the same cost as looking up this one flight.
    if (!flight && old && old.status.phase === "pre") {
      try {
        flight = await refreshFromBoard(env, ctx, request, raw, date, old);
        if (flight) putFlight(ctx, key, flight);
      } catch (err) {
        if (!(err instanceof ApiError) || ["flights_resting", "flight_rest", "visitor_limit", "quota_exhausted"].includes(err.code)) {
          flight = restingCopy(old, err);
        }
      }
    }
    if (!flight) {
      try {
        await spend(env, request, "track", item);
        flight = await fetchFlight(env, ctx, raw, date);
        putFlight(ctx, key, flight);
      } catch (err) {
        const saveable = err instanceof ApiError && ["flights_resting", "flight_rest", "visitor_limit", "quota_exhausted", "upstream_unavailable"].includes(err.code);
        if (!old || !(saveable || !(err instanceof ApiError))) throw err;
        flight = restingCopy(old, err);
      }
    }
  }

  // Live position is free and changes fast, so it is looked up on every request,
  // including shortly before departure in case the schedule feed lags behind reality.
  const depRef = Date.parse(flight.departure.revised || flight.departure.sched || 0);
  const wantLive = !liveDone && (flight.status.phase === "air" || (flight.status.phase === "pre" && Date.now() > depRef - 20 * 60000));
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
  // While it flies, a landing time worked out from its live speed and the distance left (free).
  flight.arrival.liveEta = flight.status.phase === "air" ? liveEta(flight) : null;
  // How often the details are checked at this stage, so the page can say so kindly.
  flight.status.windowMin = flight.status.phase === "air" ? null : Math.round(flightTtl(flight) / 60);
  return flight;
}

function restingCopy(old, err) {
  old.status.servedStale = true;
  old.status.note = err instanceof ApiError ? err.message : null;
  return old;
}

/** Minutes left at the current ground speed, plus a few for the approach. Null when we can't tell. */
function liveEta(f) {
  const p = f.position;
  const a = f.arrival;
  if (!p || !(p.speedKmh > 250) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || p.source !== "live") return null;
  const r = Math.PI / 180;
  const km = 6371 * 2 * Math.asin(Math.sqrt(Math.sin(((a.lat - p.lat) * r) / 2) ** 2 + Math.cos(p.lat * r) * Math.cos(a.lat * r) * Math.sin(((a.lon - p.lon) * r) / 2) ** 2));
  const mins = (km / p.speedKmh) * 60 + (km > 60 ? 8 : 4);
  return new Date(Date.now() + mins * 60000).toISOString();
}

/** Re-fetch the board half-day this flight leaves in, and read the flight from it. */
async function refreshFromBoard(env, ctx, request, no, date, old) {
  const dep = old.departure;
  if (!dep.code || !dep.tz || !dep.sched) return null;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: dep.tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(dep.sched)));
  const slot = hour < 12 ? "am" : "pm";
  const board = await departureSlot(env, ctx, request, dep.code, date, slot, { kind: "track", item: `${no}/${date}`, maxAgeMs: flightTtl(old) * 1000 });
  const it = board?.departures?.find((f) => boardNumber(f) === no);
  if (!it) return null;
  const origin = { iata: dep.code, name: dep.name, shortName: dep.name, municipalityName: dep.city, timeZone: dep.tz, location: { lat: dep.lat, lon: dep.lon } };
  const flight = normaliseFlight(no, date, [{ ...it, departure: { ...it.departure, airport: origin } }]);
  // The board doesn't carry the aircraft's transponder code; keep the one we already know for live positions.
  if (old.aircraft?.hex && !flight.aircraft?.hex) flight.aircraft = { ...(flight.aircraft || {}), ...old.aircraft, model: flight.aircraft?.model || old.aircraft.model };
  flight.status.via = "board";
  return flight;
}

/** Could this flight be in the air right now, going by what we last knew? */
function mayBeFlying(f) {
  const now = Date.now();
  const dep = Date.parse(f.departure.actual || f.departure.revised || f.departure.sched || 0);
  const arr = Date.parse(f.arrival.revised || f.arrival.sched || 0);
  return ["air", "pre"].includes(f.status.phase) && now > dep - 20 * 60000 && (!arr || now < arr + 30 * 60000);
}

/** The paid lookup itself. */
async function fetchFlight(env, ctx, raw, date) {
  const host = env.ADB_HOST || "aerodatabox.p.rapidapi.com";
  if (!ADB_HOSTS.has(host)) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
  let res;
  try {
    res = await getWithRetry(`https://${host}/flights/number/${raw}/${date}?withAircraftImage=false&withLocation=true&dateLocalRole=Departure`, {
      headers: { "X-RapidAPI-Key": env.ADB_KEY, "X-RapidAPI-Host": host, Accept: "application/json" },
    });
  } catch {
    throw new ApiError(502, "upstream_unavailable", "Flight data is slow right now. Try again shortly.");
  }
  if (res.status === 204 || res.status === 404) throw new ApiError(404, "not_found", `No flight ${raw} found on ${date}.`);
  if (res.status === 429 || res.status === 403) throw new ApiError(503, "quota_exhausted", "This month's free flight lookups are used up. Trains still work.");
  if (!res.ok) throw new ApiError(502, "upstream_unavailable", "Flight data is slow right now. Try again shortly.");
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new ApiError(404, "not_found", `No flight ${raw} found on ${date}.`);
  ctx.waitUntil(rememberAirports(env, [list[0].departure?.airport, list[0].arrival?.airport]).catch(() => {}));
  return normaliseFlight(raw, date, list);
}

/** Store a flight the way cached() does: a copy fresh for its phase, and a 36-hour fallback. */
function putFlight(ctx, key, data) {
  const fetchedAt = Date.parse(data.status?.checkedAt || "") || Date.now();
  data.status.checkedAt ||= new Date(fetchedAt).toISOString();
  const put = (k, seconds) =>
    caches.default.put(cacheKey(k), new Response(JSON.stringify(data), { headers: { "Cache-Control": `max-age=${seconds}`, "X-Fetched-At": String(fetchedAt) } }));
  const left = Math.max(60, flightTtl(data) - Math.round((Date.now() - fetchedAt) / 1000));
  ctx.waitUntil(Promise.all([put(key, left), put(`${key}/stale`, 36 * 3600)]).catch(() => {}));
}

/** A cache entry with its age, or null when there's none (or it has expired). */
async function cacheGet(name) {
  const hit = await caches.default.match(cacheKey(name));
  if (!hit) return null;
  return { data: await hit.json(), age: Date.now() - Number(hit.headers.get("X-Fetched-At") || Date.now()) };
}

/* ---------- departure boards double as a free source for every flight on them ---------- */

const boardNumber = (f) => String(f.number || "").replace(/\s+/g, "").toUpperCase();

let indexQueue = Promise.resolve();
/** Note which board holds each flight, so tracking any of them can use it. One update at a time. */
function indexBoard(from, date, slot, departures) {
  const turn = indexQueue.then(() => indexOne(from, date, slot, departures));
  indexQueue = turn.catch(() => {});
  return turn;
}

async function indexOne(from, date, slot, departures) {
  const key = `seeds/${date}`;
  const prev = (await cacheGet(key))?.data || {};
  for (const f of departures) if (f.codeshareStatus !== "IsCodeshared" && !f.isCargo) prev[boardNumber(f)] = `${from}/${slot}`;
  await caches.default.put(cacheKey(key), new Response(JSON.stringify(prev), { headers: { "Cache-Control": "max-age=172800", "X-Fetched-At": String(Date.now()) } }));
}

/** A flight built from a departure board someone's search already paid for, if it's fresh enough. */
async function fromBoards(env, ctx, no, date) {
  const where = (await cacheGet(`seeds/${date}`))?.data?.[no];
  if (!where) return null;
  const [from, slot] = where.split("/");
  const board = await cacheGet(`fids/${from}/${date}/${slot}`);
  const item = board?.data?.departures?.find((f) => boardNumber(f) === no);
  if (!item) return null;
  const origin = await airportInfo(env, from);
  if (!origin) return null;
  const flight = normaliseFlight(no, date, [{ ...item, departure: { ...item.departure, airport: origin } }]);
  if (board.age / 1000 > flightTtl(flight)) return null; // too old for this phase: look it up properly
  flight.status.checkedAt = new Date(Date.now() - board.age).toISOString();
  flight.status.via = "board";
  return flight;
}

/* ---------- airports: learned once, kept in KV ---------- */

const airportMemo = new Map();

/** Name, city, time zone and location for an airport code, from memory, KV, or one 1-unit lookup. */
async function airportInfo(env, code) {
  if (airportMemo.has(code)) return airportMemo.get(code);
  const kv = env.QUOTA;
  const saved = kv?.get ? await kv.get(`airport/${code}`) : null;
  if (saved) {
    const a = JSON.parse(saved);
    airportMemo.set(code, a);
    return a;
  }
  const host = env.ADB_HOST || "aerodatabox.p.rapidapi.com";
  if (!kv?.get || !ADB_HOSTS.has(host)) return null;
  await spend(env, null, "airport");
  const res = await getWithRetry(`https://${host}/airports/iata/${code}`, {
    headers: { "X-RapidAPI-Key": env.ADB_KEY, "X-RapidAPI-Host": host, Accept: "application/json" },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const a = await res.json().catch(() => null);
  if (!a?.timeZone) return null;
  const info = { iata: a.iata || code, icao: a.icao, name: a.fullName || a.shortName, shortName: a.shortName, municipalityName: a.municipalityName, timeZone: a.timeZone, location: a.location };
  airportMemo.set(code, info);
  await kv.put(`airport/${code}`, JSON.stringify(info));
  return info;
}

/** Keep airport details that a paid lookup brought anyway, so boards from there never need one. */
async function rememberAirports(env, list) {
  const kv = env.QUOTA;
  if (!kv?.get) return;
  for (const a of list) {
    if (!a?.iata || !a.timeZone || airportMemo.has(a.iata)) continue;
    const info = { iata: a.iata, icao: a.icao, name: a.name, shortName: a.shortName, municipalityName: a.municipalityName, timeZone: a.timeZone, location: a.location };
    airportMemo.set(a.iata, info);
    if (!(await kv.get(`airport/${a.iata}`))) await kv.put(`airport/${a.iata}`, JSON.stringify(info));
  }
}

/**
 * How long a flight's details stay fresh before a paid refresh, by what people care about then.
 * Before take-off: more often as it nears (gates, boarding, delays). In the air: free live
 * positions only. After landing: one check for the landing time and belt, then nothing more.
 */
function flightTtl(f) {
  const now = Date.now();
  const dep = Date.parse(f.departure.revised || f.departure.sched || 0);
  switch (f.status.phase) {
    case "landed":
      return 24 * 3600;
    case "cancelled":
    case "diverted":
      return 6 * 3600;
    case "air":
      return 15 * 60; // the schedule copy; positions keep it current for free (see flightRoute)
    default: {
      const until = dep - now;
      if (until > 24 * 3600000) return 12 * 3600;
      if (until > 6 * 3600000) return 3 * 3600;
      if (until > 2 * 3600000) return 3600;
      return 30 * 60;
    }
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

const SLOTS = { am: ["00:00", "11:59"], pm: ["12:00", "23:59"] };

/**
 * Every flight from one airport to another on a local date. Built from the origin's
 * departure board in two 12-hour slots, each cached and shared by every search from that
 * airport that day, whatever the destination. Codeshares are left out: one row per real flight.
 */
async function flightsBetweenRoute(url, env, ctx, request) {
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

  const got = await Promise.allSettled(slots.map((slot) => departureSlot(env, ctx, request, from, date, slot, { item: `search/${from}/${to}/${date}` })));
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
function departureSlot(env, ctx, request, from, date, slot, { kind = "search", item = null, maxAgeMs = null } = {}) {
  const today = istToday();
  const ttl = date === today ? 900 : date < today ? 3600 : 21600;
  return cached(ctx, `fids/${from}/${date}/${slot}`, ttl, async () => {
    const host = env.ADB_HOST || "aerodatabox.p.rapidapi.com";
    if (!ADB_HOSTS.has(host)) throw new ApiError(503, "flights_not_configured", "Flight tracking is not switched on yet.");
    await spend(env, request, kind, item);
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
    const departures = Array.isArray(body?.departures) ? body.departures : [];
    // Every flight on this board can now be tracked without another paid call.
    ctx.waitUntil(indexBoard(from, date, slot, departures).catch(() => {}));
    ctx.waitUntil(rememberAirports(env, departures.map((f) => f.arrival?.airport)).catch(() => {}));
    return { departures, status: {} };
  }, maxAgeMs != null ? { fresh: true, floorMs: maxAgeMs } : {});
}

/* ---------- the flight-data budget ---------- */

const LOOKUP_CAP_DEFAULT = 180; // paid calls a month: 360 of the free plan's 400 units, 40 kept spare
const VISITOR_DAILY_DEFAULT = 3;
const PER_FLIGHT_DAILY_DEFAULT = 8;
const SEARCH_KEEP = 2; // the last calls of each day's share are kept for tracking

const intEnv = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** How many paid calls this month may have used by now: the month's cap, released day by day. */
function allowanceToday(cap) {
  const [y, m, d] = istToday().split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(cap, Math.ceil((cap * d) / days));
}

async function visitorKey(request) {
  const ip = request?.headers?.get("CF-Connecting-IP");
  if (!ip) return null;
  // A one-way hash of the address and day: enough to count, useless for anything else.
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${istToday()}|journey`));
  return `visitor/${istToday()}/${[...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let spendQueue = Promise.resolve();
/**
 * Count one paid call, or refuse with a clear reason. kind: "track", "search" or "airport".
 * One at a time within this Worker, so two calls made together both get counted.
 */
function spend(env, request, kind, item = null) {
  const turn = spendQueue.then(() => spendOne(env, request, kind, item));
  spendQueue = turn.catch(() => {});
  return turn;
}

async function spendOne(env, request, kind, item) {
  const kv = env.QUOTA;
  if (!kv || typeof kv.get !== "function") {
    if (kind === "search") throw new ApiError(503, "search_not_configured", "Flight search isn't switched on yet. Track by flight number for now.");
    return; // tracking works without the budget store, just unguarded
  }
  const cap = intEnv(env.FLIGHT_LOOKUP_CAP, LOOKUP_CAP_DEFAULT);
  const key = `adb/${istToday().slice(0, 7)}`;
  const used = Number(await kv.get(key)) || 0;
  const left = allowanceToday(cap) - used;
  if (left <= 0)
    throw kind === "search"
      ? new ApiError(503, "search_paused", "Flight search is resting until tomorrow to save lookups for live tracking. Tracking by flight number still works.")
      : new ApiError(503, "flights_resting", "Today's new flight lookups are used up. Flights someone already checked still show, and new ones are back tomorrow. Trains work as usual.");
  if (kind === "search" && left <= SEARCH_KEEP)
    throw new ApiError(503, "search_paused", "Flight search is resting until tomorrow so live tracking keeps working. Tracking by flight number still works.");
  // One flight can't eat the day: at most a few paid refreshes each.
  if (kind === "track" && item) {
    const fk = `calls/${istToday()}/${item}`;
    const n = Number(await kv.get(fk)) || 0;
    if (n >= intEnv(env.FLIGHT_PER_FLIGHT_DAILY, PER_FLIGHT_DAILY_DEFAULT))
      throw new ApiError(503, "flight_rest", "This flight has had its updates for today, so we're showing the latest we have.");
    await kv.put(fk, String(n + 1), { expirationTtl: 2 * 86400 });
  }
  // Each visitor can bring in a few *new* flights or searches a day; refreshing ones they follow is free of that.
  if (kind !== "airport") {
    const vk = await visitorKey(request);
    if (vk) {
      let seen = [];
      try {
        seen = JSON.parse((await kv.get(vk)) || "[]");
      } catch {
        seen = [];
      }
      const id = item || `${kind}/${Date.now()}`;
      if (!seen.includes(id)) {
        if (seen.length >= intEnv(env.FLIGHT_VISITOR_DAILY, VISITOR_DAILY_DEFAULT))
          throw new ApiError(429, "visitor_limit", "You've looked up a few new flights today. Flights others have checked still work, and you can look up more tomorrow.");
        await kv.put(vk, JSON.stringify([...seen, id]), { expirationTtl: 2 * 86400 });
      }
    }
  }
  // KV isn't atomic across Workers, so a busy minute can overshoot by a call or two. Fine for a monthly budget.
  await kv.put(key, String(used + 1), { expirationTtl: 45 * 86400 });
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

/* ------------------------------------------------------------------ */
/* /api/coaches: a train's coach order and stops, from several sources */
/* ------------------------------------------------------------------ */

// Nothing here is assumed that a source doesn't say. Each source is read on its own, strictly:
//  - coach order: erail.in, ConfirmTkt and etrain.info each publish one. The order most of them
//    agree on is used; any that disagree are named, and coach details (like "LHB") are taken only
//    from sources that agree on the order.
//  - stops: RailYatri's and ConfirmTkt's timetables, station by station. A time or platform is
//    kept where they agree (or only one has it); where they differ, both are passed on, so the
//    app can show the difference instead of picking one.
//  - which end the engine is at: each source says whether its order starts at the engine (at the
//    train's start). Whether the train reverses on the way is only reported if a source flags it.

const COACH_ID = /^[A-Z]{1,5}\d{0,2}$/;
const NUMBERED = /^[A-Z]{1,2}\d{1,2}$/; // passenger coaches carry a number: H1, A2, B3, S7, M1, C2
const CLASS_CODE = /^(1A|2A|3A|3E|SL|CC|EC|EA|EV|2S|FC)$/;
const GENERAL = /^(GN|GS|GEN|UR|D)$/;
const coachKind = (id) => (/^[A-Z]+/.exec(id) || [id])[0];
const minsToHm = (m) => (Number.isFinite(m) && m > 0 ? `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` : null);
const hm = (t) => (/^\d{1,2}:\d{2}$/.test(String(t || "").trim()) ? String(t).trim().padStart(5, "0") : null);

async function coachesRoute(url, ctx) {
  const no = (url.searchParams.get("no") || "").trim();
  if (!/^\d{5}$/.test(no)) throw new ApiError(400, "invalid_train", "Train numbers have 5 digits.");
  return cached(ctx, `coaches/${no}`, TTL.coaches, async () => {
    const get = async (name, u, headers = {}) => {
      try {
        const res = await getWithRetry(u, { headers: { "User-Agent": UA, ...headers } }, { timeout: 10000, retries: 1 });
        if (!res.ok) throw new Error(`status ${res.status}`);
        return await res.text();
      } catch (err) {
        log("warn", "coaches source failed", name, no, String(err && err.message));
        return null;
      }
    };
    const timetable = async () => {
      try {
        return await railYatriTimetable(no);
      } catch (err) {
        log("warn", "coaches source failed", "railyatri", no, String(err && err.message));
        return null;
      }
    };
    const [erail, ctkt, etrain, ry] = await Promise.all([
      get("erail", `https://erail.in/rail/getTrains.aspx?TrainNo=${no}&DataSource=0&Language=0&Cache=true`, { Referer: "https://erail.in/" }),
      get("confirmtkt", `https://www.confirmtkt.com/train-schedule/${no}`),
      get("etrain", `https://etrain.info/train/${no}/schedule`),
      timetable(),
    ]);
    const ct = ctkt ? confirmTktData(ctkt, no) : null;
    const read = [
      erail && parseErailOrder(erail, no),
      ct && parseConfirmTktOrder(ct),
      etrain && parseEtrainOrder(etrain, no),
    ].filter(Boolean);
    const order = coachConsensus(read);
    const stops = mergeStops(ry ? railYatriStops(ry) : null, ct ? confirmTktStops(ct) : null);
    if (!order && !stops) throw new ApiError(404, "no_coach_order", "There's no published coach order for this train.");
    return { kind: "coaches", no, ...(order || { coaches: null, engineFirst: null, agreement: null, sources: [] }), stops, status: {} };
  });
}

/* ---------- coach order, one source at a time ---------- */

/** erail: ",,En:LPR,LPR,LPR:GN,GN,GN:H,H1,1A:…" in this train's own record. */
function parseErailOrder(text, no) {
  const record = String(text)
    .split("^")
    .slice(1)
    .map((r) => r.split("~"))
    .find((f) => f[0] === no); // this train's record, never another's
  const field = record?.find((f) => /(^|:)[A-Z]{1,5},[A-Z]{1,5}\d{0,2},[A-Z0-9]{1,5}:/.test(f));
  if (!field) return null;
  const coaches = [];
  let engineFirst = null;
  for (const group of field.split(":").filter(Boolean)) {
    const [kind, id, cls] = group.split(",").map((x) => (x || "").trim().toUpperCase());
    if (!kind && !id && /^EN/.test(cls)) {
      engineFirst = coaches.length === 0;
      continue;
    }
    if (!COACH_ID.test(id) || !COACH_ID.test(kind)) return null;
    coaches.push({ id: GENERAL.test(id) ? "GN" : id, kind: GENERAL.test(kind) ? "GN" : kind, cls: CLASS_CODE.test(cls) ? cls : null });
  }
  return orderOk(coaches) ? { source: "erail", coaches, engineFirst } : null;
}

/**
 * ConfirmTkt's pages carry their train data as JSON, either quoted (`var data = '{…}';`, the
 * schedule page) or as a plain object (`var data = {…};`, the running-status page). Read for
 * this train number only.
 */
function confirmTktData(html, no) {
  let raw = null;
  const quoted = /var\s+data\s*=\s*'([\s\S]*?)';\s*\n/.exec(html) || /var\s+data\s*=\s*'([\s\S]*?)';/.exec(html);
  if (quoted) raw = quoted[1].replace(/\\'/g, "'");
  else {
    const at = html.search(/var\s+data\s*=\s*\{/);
    if (at < 0) return null;
    const start = html.indexOf("{", at);
    let depth = 0;
    let inStr = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        raw = html.slice(start, i + 1);
        break;
      }
    }
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return String(d.TrainNumberString || d.TrainNo) === no ? d : null;
  } catch {
    return null;
  }
}

/** ConfirmTkt: ",En:,GS:,GS:H1,1A:A2,2A:…" as id,class pairs. */
function parseConfirmTktOrder(d) {
  const raw = String(d.CoachPosition || "");
  if (!raw.includes(":")) return null;
  const coaches = [];
  let engineFirst = null;
  for (const group of raw.split(":").filter(Boolean)) {
    const [id, cls] = group.split(",").map((x) => (x || "").trim().toUpperCase());
    if (!id && /^EN/.test(cls)) {
      engineFirst = coaches.length === 0;
      continue;
    }
    const cid = id || cls; // an unnumbered coach is named by its type, like GS
    if (!COACH_ID.test(cid)) return null;
    const gen = GENERAL.test(cid);
    coaches.push({ id: gen ? "GN" : cid, kind: gen ? "GN" : coachKind(cid), cls: CLASS_CODE.test(cls) ? cls : null });
  }
  return orderOk(coaches) ? { source: "confirmtkt", coaches, engineFirst } : null;
}

/** etrain.info: each coach a block with its position, a type ("3A_LHB") and its name. */
function parseEtrainOrder(html, no) {
  if (!new RegExp(`\\b${no}\\b`).test(html)) return null;
  const start = html.indexOf('class="inlineblock"');
  if (start < 0) return null;
  const row = html.slice(start, html.indexOf("</tr>", start) > 0 ? html.indexOf("</tr>", start) : undefined);
  const coaches = [];
  let engineFirst = null;
  for (const block of row.split('class="inlineblock"').slice(1)) {
    const spans = [...block.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => decodeHtml(m[1]).trim());
    const id = (spans.at(-1) || "").toUpperCase();
    const type = (/\brake="([A-Z0-9]+)_([A-Z]+)"/i.exec(block) || []).slice(1);
    if (/rake-eng/.test(block) || id === "ENG") {
      engineFirst = coaches.length === 0;
      continue;
    }
    if (!COACH_ID.test(id)) return null;
    const gen = GENERAL.test(id);
    coaches.push({ id: gen ? "GN" : id, kind: gen ? "GN" : coachKind(id), cls: CLASS_CODE.test((type[0] || "").toUpperCase()) ? type[0].toUpperCase() : null, build: type[1] ? type[1].toUpperCase() : null });
  }
  return orderOk(coaches) ? { source: "etrain", coaches, engineFirst } : null;
}

const orderOk = (coaches) => coaches.length >= 4 && coaches.length <= 30 && coaches.some((c) => NUMBERED.test(c.id));
const SOURCE_RANK = ["erail", "confirmtkt", "etrain"]; // only to break an exact tie, and the app says so

/**
 * The order most sources agree on, compared by their numbered coaches (sources differ on how they
 * name the unnumbered ones at the ends). A list that's another read from the other end is the same
 * rake. Returns the fullest agreeing list, what each source said, and details only agreeing
 * sources give. The engine's end is given only when every agreeing source that marks it puts it at
 * the same end of the returned list.
 */
function coachConsensus(read) {
  if (!read.length) return null;
  const seq = (r) => r.coaches.filter((c) => NUMBERED.test(c.id)).map((c) => c.id);
  const canon = (r) => {
    const f = seq(r).join(" ");
    const b = [...seq(r)].reverse().join(" ");
    return f < b ? f : b;
  };
  const groups = new Map();
  for (const r of read) groups.set(canon(r), [...(groups.get(canon(r)) || []), r]);
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length || SOURCE_RANK.indexOf(a[0].source) - SOURCE_RANK.indexOf(b[0].source));
  const win = ranked[0];
  const tie = ranked.length > 1 && ranked[1].length === win.length;
  const base = [...win].sort((a, b) => b.coaches.length - a.coaches.length || SOURCE_RANK.indexOf(a.source) - SOURCE_RANK.indexOf(b.source))[0];
  const forward = (r) => seq(r).join(" ") === seq(base).join(" ");
  const coaches = base.coaches.map((c) => {
    const more = win.map((r) => r.coaches.find((x) => x.id === c.id && NUMBERED.test(x.id))).filter(Boolean);
    const build = more.map((x) => x.build).find(Boolean) || null;
    return { id: c.id, kind: c.kind, cls: c.cls || more.map((x) => x.cls).find(Boolean) || null, ...(build ? { build } : {}) };
  });
  // Where each agreeing source puts the engine, turned to the returned list's direction.
  const ends = win.filter((r) => r.engineFirst != null).map((r) => (forward(r) ? r.engineFirst : !r.engineFirst));
  return {
    coaches,
    engineFirst: ends.length && ends.every(Boolean) ? true : ends.length && ends.every((x) => !x) ? false : null,
    engineSources: ends.length,
    directions: win.every(forward) ? "same" : "mixed", // "mixed": sources read the rake from different ends
    agreement: read.length === 1 ? "single" : win.length === read.length ? "all" : tie ? "tie" : "majority",
    sources: read.map((r) => ({ name: r.source, agrees: win.includes(r), reversed: win.includes(r) && !forward(r), order: seq(r).join(" ") })),
  };
}

/* ---------- stops, from two timetables ---------- */

async function railYatriTimetable(no) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await buildId(attempt > 0);
    const res = await getWithRetry(`https://www.railyatri.in/_next/data/${id}/time-table/${no}.json`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 404) continue; // build id rotated
    if (!res.ok) throw new Error(`status ${res.status}`);
    const d = (await res.json())?.pageProps?.trainTimeTable?.trainScheduleDetail?.[0];
    return d && String(d.train_number) === no ? d : null;
  }
  return null;
}

function railYatriStops(d) {
  const out = (d.route || [])
    .filter((x) => x.stop && /^[A-Z]{1,5}$/.test(x.station_code || ""))
    .map((x) => ({
      code: x.station_code,
      arr: minsToHm(Number(x.sta_min)),
      dep: minsToHm(Number(x.std_min)),
      day: Number(x.day) || null,
      pf: Number(x.platform_number) > 0 ? String(x.platform_number) : null,
      reversal: x.interchange_flag === true ? true : null, // only a "yes" means something
    }));
  // Some routes list a station more than once; keep the first.
  return out.filter((s, i) => out.findIndex((x) => x.code === s.code) === i);
}

function confirmTktStops(d) {
  const out = (d.Schedule || [])
    .filter((x) => /^[A-Z]{1,5}$/.test(x.StationCode || ""))
    .map((x) => ({ code: x.StationCode, arr: hm(x.ArrivalTime), dep: hm(x.DepartureTime), day: Number(x.Day) || null, pf: /^\d{1,2}[A-Z]?$/.test(String(x.ExpectedPlatformNo || "").trim()) ? String(x.ExpectedPlatformNo).trim() : null }));
  return out.filter((s, i) => out.findIndex((x) => x.code === s.code) === i);
}

/**
 * Two timetables, station by station: a value both give and agree on is kept; one only one gives
 * is kept and marked as single-sourced; one they differ on is dropped, with both versions passed on.
 */
function mergeStops(a, b) {
  if (!a?.length && !b?.length) return null;
  const codes = [...new Set([...(a || []).map((s) => s.code), ...(b || []).map((s) => s.code)])];
  return codes.map((code) => {
    const x = a?.find((s) => s.code === code);
    const y = b?.find((s) => s.code === code);
    const stop = { code };
    const seen = {};
    for (const f of ["arr", "dep", "pf"]) {
      const u = x?.[f] ?? null;
      const v = y?.[f] ?? null;
      if (u != null && v != null && u !== v) {
        stop[f] = null;
        seen[f] = { railyatri: u, confirmtkt: v };
      } else {
        stop[f] = u ?? v;
        if (stop[f] != null) seen[f] = u != null && v != null ? "both" : u != null ? "railyatri" : "confirmtkt";
      }
    }
    stop.day = x?.day ?? y?.day ?? null;
    stop.reversal = x?.reversal || null;
    stop.from = seen;
    return stop;
  });
}

/* ------------------------------------------------------------------ */
/* /api/dayof: what today's run says at your station                   */
/* ------------------------------------------------------------------ */

// For the hours before you board, when it matters most. Every source is asked at once and
// answers on its own:
//  - NTES, the railway's enquiry system: today's coach order at your station and its platform.
//    The only source here that publishes the actual run rather than the plan.
//  - RailYatri's live status and ConfirmTkt's running status: their platform and delay at your
//    station, to set beside it.
// Nothing is merged: each value comes back with its source, and every source says whether it
// answered and, if not, why, so a missing answer is never mistaken for a "no".

const DAYOF_TTL = 180;
/** A source gets this long, then counts as timed out, so the others aren't kept waiting. */
const within = (ms, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]); // three minutes: fresh enough on the platform, gentle on the sources

async function dayOfRoute(url, ctx, env = {}) {
  const no = (url.searchParams.get("no") || "").trim();
  const at = (url.searchParams.get("at") || "").trim().toUpperCase();
  if (!/^\d{5}$/.test(no)) throw new ApiError(400, "invalid_train", "Train numbers have 5 digits.");
  if (!/^[A-Z]{1,5}$/.test(at)) throw new ApiError(400, "invalid_station", "Station codes are 1 to 5 letters, like SBC.");
  const today = istToday();
  const date = validDate(url.searchParams.get("date") || today, addDays(today, -3), today);
  const offset = daysBetween(today, date);
  const fresh = url.searchParams.get("fresh") === "1";
  return cached(ctx, `dayof/${no}/${date}/${at}`, DAYOF_TTL, async () => {
    const sources = [];
    const ask = async (name, fn) => {
      const t0 = Date.now();
      try {
        const v = await fn();
        sources.push({ name, ok: !!v, why: v ? null : "no data for this run", ms: Date.now() - t0 });
        return v || null;
      } catch (err) {
        const why = err instanceof ApiError && err.status === 404 ? "no data for this run" : /timeout|aborted/i.test(String(err?.message)) ? "timed out" : "unreachable";
        log("warn", "dayof source failed", name, no, date, String(err && err.message));
        sources.push({ name, ok: false, why, ms: Date.now() - t0 });
        return null;
      }
    };
    const [ntes, crowd, ct] = await Promise.all([
      ask("ntes", () => within(Number(env.DAYOF_NTES_MS) || 9000, fromNtes(no, date, offset, ctx, { coords: false }))),
      ask("railyatri", () => fromRailYatri(no, date, offset)),
      ask("confirmtkt", () => confirmTktRun(no, date)),
    ]);
    const n = ntes?.stops?.find((x) => x.code === at) || null;
    const r = crowd?.stops?.find((x) => x.code === at) || null;
    const c = ct?.find((x) => x.code === at) || null;
    const order = ntes?.coaches?.find((x) => x.code === at) || null;
    return {
      kind: "dayof",
      no,
      date,
      at,
      // Today's order at this station, as the railway lists it; never borrowed from another station.
      coaches: order ? { list: order.list.map((x) => ({ id: x.id, cls: CLASS_CODE.test(x.cls) ? x.cls : null })), source: "ntes" } : null,
      platform: {
        ntes: n?.platform ? { pf: n.platform, mark: n.platformMark || null } : null,
        railyatri: r?.platform || null,
        confirmtkt: c?.pf || null,
      },
      delay: {
        ntes: n ? n.delay?.arr ?? n.delay?.dep ?? null : null,
        railyatri: r ? r.delay?.arr ?? r.delay?.dep ?? null : null,
        confirmtkt: c ? c.delay : null,
      },
      sources,
      status: {},
    };
  }, { fresh, floorMs: 60000 });
}

/** ConfirmTkt's running status for one run: each station's delay, and its listed platform. */
async function confirmTktRun(no, date) {
  const [y, m, d] = date.split("-");
  const res = await getWithRetry(`https://www.confirmtkt.com/train-running-status/${no}?Date=${d}-${MONTHS[+m - 1]}-${y}`, { headers: { "User-Agent": UA } }, { timeout: 10000, retries: 0 });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = confirmTktData(await res.text(), no);
  if (!data?.Schedule?.length) return null;
  const mins = (t) => {
    const m2 = /^(-)?\s*(\d+)\s*Min/i.exec(String(t || "").trim());
    return m2 ? (m2[1] ? -1 : 1) * Number(m2[2]) : /on\s*time/i.test(String(t || "")) ? 0 : null;
  };
  return data.Schedule.filter((x) => /^[A-Z]{1,5}$/.test(x.StationCode || "")).map((x) => ({
    code: x.StationCode,
    pf: /^\d{1,2}[A-Z]?$/.test(String(x.ExpectedPlatformNo || "").trim()) ? String(x.ExpectedPlatformNo).trim() : null,
    delay: mins(x.arrivalDelay) ?? mins(x.departureDelay),
  }));
}

/* ------------------------------------------------------------------ */
/* /api/pnr: a booking's status, read from RailYatri's PNR page        */
/* ------------------------------------------------------------------ */

// The page names the class in words; the app uses the short codes.
const CLASS_BY_NAME = {
  "AC FIRST CLASS": "1A",
  "FIRST AC": "1A",
  "AC 2 TIER": "2A",
  "AC 3 TIER": "3A",
  "AC 3 ECONOMY": "3E",
  "AC 3 TIER ECONOMY": "3E",
  "AC EXECUTIVE ANUBHUTI": "EA",
  "EXECUTIVE ANUBHUTI": "EA",
  "EXECUTIVE CHAIR CAR": "EC",
  "EXEC. CHAIR CAR": "EC",
  "VISTADOME AC": "EV",
  "AC CHAIR CAR": "CC",
  "CHAIR CAR": "CC",
  "FIRST CLASS": "FC",
  SLEEPER: "SL",
  "SLEEPER CLASS": "SL",
  "SECOND SITTING": "2S",
};
const BERTH_TYPES = { LB: "Lower", MB: "Middle", UB: "Upper", SL: "Side lower", SU: "Side upper", SM: "Side middle", WS: "Window", MS: "Middle", AS: "Aisle" };
const PNR_MISSING = "We couldn't find this booking yet. If it's a new booking or its first look-up, try again in a minute. Old PNRs are cleared after the trip.";
const PNR_WAIT_MS = 24000; // RailYatri's own page waits up to ~30 s for a booking it hasn't fetched before

async function pnrRoute(url, ctx, env = {}) {
  const pnr = (url.searchParams.get("pnr") || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(pnr)) throw new ApiError(400, "invalid_pnr", "A PNR has 10 digits.");
  // Keyed by a hash, so no PNR is stored in the clear, even for the 5 minutes a copy is kept.
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pnr|${pnr}`));
  const key = [...new Uint8Array(bytes)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  const fresh = url.searchParams.get("fresh") === "1";
  return cached(ctx, `pnr/${key}`, TTL.pnr, () => fetchPnr(pnr, Number(env.PNR_WAIT_MS) || PNR_WAIT_MS), { fresh, floorMs: 60000 });
}

async function fetchPnr(pnr, waitMs = PNR_WAIT_MS) {
  const headers = { "User-Agent": UA, Referer: "https://www.railyatri.in/pnr-status" };
  const slow = () => new ApiError(502, "upstream_unavailable", "PNR status is slow right now. Try again in a minute.");
  const deadline = Date.now() + waitMs;
  const left = () => deadline - Date.now();
  const page = async () => {
    const res = await getWithRetry(`https://www.railyatri.in/pnr-status/${pnr}`, { headers: { ...headers, Accept: "text/html" } }, { timeout: Math.max(3000, Math.min(12000, left())), retries: 0 });
    if (!res.ok) throw slow();
    return res.text();
  };
  // RailYatri only shows a booking it has already fetched from the railway. One it hasn't comes
  // back as a "please wait" page (which also carries their hidden "not found" text), and their
  // page then asks /get-status every few seconds until it's ready. So: read the page (instant
  // when it's ready), else ask the same way they do, with growing pauses, for up to ~24 s.
  let html = null;
  let read = null;
  let failed = 0;
  try {
    html = await page();
    read = extractPnr(html, pnr);
    if (read.data) return read.data;
  } catch (err) {
    failed++;
    log("warn", "pnr page failed", String(err && err.message)); // never the PNR itself
  }
  const pending = !read || read.reason === "no_booking"; // not fetched yet, as opposed to unreadable
  for (let wait = 1500; pending && left() > 2000; wait = Math.min(wait * 2, 6000)) {
    let ready = false;
    try {
      const res = await getWithRetry(
        `https://www.railyatri.in/get-status/${pnr}`,
        { headers: { ...headers, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } },
        { timeout: Math.max(2000, Math.min(10000, left())), retries: 0 }
      );
      ready = res.ok && (await res.json().catch(() => null))?.status === true;
    } catch {
      failed++;
    }
    if (ready) {
      try {
        html = await page();
        read = extractPnr(html, pnr);
        if (read.data) return read.data;
        if (read.reason !== "no_booking") break; // it's there but unreadable: say so below
      } catch (err) {
        failed++;
        log("warn", "pnr page failed", String(err && err.message));
      }
    }
    if (left() < wait + 1000) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!read && failed) throw slow(); // never reached RailYatri at all
  if (!read || read.reason === "no_booking" || /FLUSHED PNR|PNR NOT YET GENERATED/i.test(html || "")) throw new ApiError(404, "pnr_not_found", PNR_MISSING);
  // The page changed shape, or showed another booking. Log which fields broke (never the PNR), so
  // a change on their side shows up straight away, and show nothing rather than something wrong.
  log("warn", "pnr page unreadable", read.reason, `missing=${read.missing.join(",")}`, `conflicts=${read.conflicts.join(",")}`);
  throw new ApiError(502, "pnr_unreadable", "We couldn't read this booking just now. Your PNR is fine; try again later, or check it on IRCTC.");
}

/* ------------------------------------------------------------------ */
/* PNR extraction: deterministic, and independent of the page layout   */
/* ------------------------------------------------------------------ */
//
// RailYatri's PNR page is HTML made for people, and its markup can change any day. So nothing
// below depends on tags, classes or nesting:
//  1. The page becomes a flat list of its visible text, plus the links it carries.
//  2. Every field is found next to its label ("DAY OF BOARDING") and kept only if it passes a
//     strict check (a real calendar date, a 5-digit train number, a known class, a seat status).
//  3. Key fields also have a second, independent way in: a pattern near the booking, or the
//     page's own links. Where both find a value, they must agree.
//  4. A required field that's missing, or found two different ways, makes the page unreadable.
//     We'd rather say "couldn't read it" than show a wrong seat. Optional fields are dropped.
// The same page always reads the same way. tests/worker.test.mjs checks a real page plus
// reshaped copies of it (classes stripped, tags swapped, labels reworded, links gone).

const PNR_READER = 2; // bump when the rules change, so cached answers can be told apart

const decodeHtml = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The page as people see it: visible text in reading order, and the links. */
function pageText(html) {
  const code = String(html).replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const body = code.replace(/<!--[\s\S]*?-->/g, " ");
  const hrefs = (s) => [...s.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeHtml(m[1]));
  const links = hrefs(body);
  // Links in commented-out parts of the page: never shown to anyone, so never trusted on their
  // own. Only seat data is read from them, and only where the visible page agrees.
  const hidden = hrefs([...code.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).join(" "));
  const tokens = body
    .split(/<[^>]*>/)
    .map((t) => decodeHtml(t).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { tokens, links, hidden };
}

/** A label as written, reduced to its words: "PF# (TENTATIVE)" → "PF TENTATIVE", "Day of boarding:" → "DAY OF BOARDING". */
const labelOf = (t) =>
  t
    .toUpperCase()
    .replace(/[^A-Z0-9/ ]+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();

const PNR_LABELS = {
  pnr: ["PNR NUMBER", "PNR NO", "PNR"],
  train: ["TRAIN NAME", "TRAIN NUMBER", "TRAIN NO", "TRAIN", "TRAIN NAME/NUMBER", "TRAIN NO/NAME"],
  from: ["FROM", "BOARDING FROM", "BOARDING STATION", "BOARDING POINT", "SOURCE", "FROM STATION"],
  to: ["TO", "DESTINATION", "RESERVATION UPTO", "UPTO", "TO STATION"],
  date: ["DAY OF BOARDING", "DATE OF BOARDING", "BOARDING DATE", "DATE OF JOURNEY", "JOURNEY DATE", "DOJ"],
  cls: ["CLASS", "TRAVEL CLASS", "JOURNEY CLASS"],
  platform: ["PF TENTATIVE", "PF", "PLATFORM", "PLATFORM NO", "PLATFORM TENTATIVE", "EXPECTED PLATFORM"],
  chart: ["CHART STATUS", "CHART"],
  duration: ["JOURNEY TIME", "DURATION", "TRAVEL TIME"],
  booking: ["BOOKING STATUS"],
  current: ["CURRENT STATUS"],
  seat: ["COACH/BERTH", "COACH BERTH", "COACH/SEAT", "SEAT/BERTH", "BERTH"],
};
const ANY_LABEL = new Set(Object.values(PNR_LABELS).flat());
const isLabel = (t) => ANY_LABEL.has(labelOf(t));

/* ---------- strict checks: each returns the value, or null ---------- */

const check = {
  pnr: (t) => (/^\d{3}\s?-?\d{3}\s?-?\d{4}$/.test(t) ? t.replace(/\D/g, "") : null),
  trainNo: (t) => (/^(?:train\s*(?:no\.?)?\s*)?(\d{5})(?!\d)/i.exec(t) || [])[1] || null,
  /** "KSR BENGALURU | SBC", "KSR Bengaluru (SBC)" */
  station(t) {
    const m = /^([A-Za-z][A-Za-z0-9 .'&-]*?)\s*(?:\|\s*([A-Z]{1,5})|\(\s*([A-Z]{1,5})\s*\))$/.exec(t);
    return m ? { code: m[2] || m[3], name: m[1].trim() } : null;
  },
  /** "05:45 PM", "17:45" → "17:45" */
  time(t) {
    const m = /^(\d{1,2})[:.](\d{2})\s*([AP])?\.?\s*M?\.?$/i.exec(t);
    if (!m) return null;
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    if (m[3]) {
      if (hh < 1 || hh > 12) return null;
      hh = (hh % 12) + (/p/i.test(m[3]) ? 12 : 0);
    }
    return hh < 24 && mm < 60 ? `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` : null;
  },
  /** "14-11-2026", "14/11/2026", "14 Nov 2026", "2026-11-14" → "2026-11-14", only if that day exists */
  date(t) {
    const mon = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
    let y, m, d;
    let x;
    if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t))) [d, m, y] = [x[1], x[2], x[3]].map(Number);
    else if ((x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) [y, m, d] = [x[1], x[2], x[3]].map(Number);
    else if ((x = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/.exec(t))) [d, m, y] = [Number(x[1]), mon[x[2].toUpperCase()], Number(x[3])];
    else return null;
    if (!m || y < 2000 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // 31-11 isn't a day
    return dt.toISOString().slice(0, 10);
  },
  /** "AC 3 Tier", "3A", "AC 3 Tier (3A)", "Sleeper Class" → "3A" */
  cls(t) {
    const code = /^(?:.*\()?\s*(1A|2A|3A|3E|EA|EC|EV|CC|FC|SL|2S)\s*\)?$/.exec(t.toUpperCase());
    if (code) return code[1];
    return CLASS_BY_NAME[t.toUpperCase().replace(/\s+/g, " ").trim()] || null;
  },
  platform: (t) => (/^(?:PF\s*)?(\d{1,2}[A-Z]?)$/i.exec(t.trim()) || [])[1]?.toUpperCase() || null,
  chart(t) {
    const u = t.toUpperCase();
    if (/NOT\s*(YET\s*)?PREPARED/.test(u)) return "not_prepared";
    if (/^(CHART\s*)?PREPARED$/.test(u)) return "prepared";
    return null;
  },
  /** One of a passenger's statuses: "Confirmed", "CNF/B3/59/LB", "RAC 12", "GNWL 45/WL 12", "B3/59". */
  status: (t) =>
    /^(CNF|CONFIRMED|CONFIRM|RAC|RLWL|GNWL|PQWL|TQWL|RSWL|RQWL|CKWL|NOSB|WL|W\/L|WAIT ?LIST(ED)?|CAN|CANCELLED|CANCELED|REGRET|RELEASED)\b/i.test(t) ||
    /^[A-Z]{1,2}\d{1,2}\s*[/,\s]\s*\d{1,3}\b/i.test(t)
      ? t
      : null,
};

/** "11H 55M", or "11H" then "55M" as two pieces of text → 715 */
function durationAt(tokens, k) {
  const one = /^(\d{1,2})\s*H(?:RS?|OURS?)?\s*(?:(\d{1,2})\s*M(?:INS?)?)?$/i.exec(tokens[k]);
  if (!one) return null;
  const next = !one[2] && /^(\d{1,2})\s*M(?:INS?)?$/i.exec(tokens[k + 1] || "");
  return Number(one[1]) * 60 + Number(one[2] || (next && next[1]) || 0);
}

/**
 * The first value after a field's label that passes its check, looking a few pieces of text
 * ahead and stopping at the next label. Searches from `start` (where the booking begins).
 */
function byLabel(tokens, start, field, test, span = 4) {
  const names = PNR_LABELS[field];
  for (let i = start; i < tokens.length; i++) {
    if (!names.includes(labelOf(tokens[i]))) continue;
    for (let k = i + 1; k <= i + span && k < tokens.length; k++) {
      if (isLabel(tokens[k])) break;
      const v = test(tokens[k], k);
      if (v != null) return { v, at: k };
    }
  }
  return null;
}

/** The first piece of text in the booking's stretch of the page that passes a check. */
function byPattern(tokens, start, test, from = start, window = 160) {
  for (let k = from; k < Math.min(tokens.length, start + window); k++) {
    if (isLabel(tokens[k])) continue;
    const v = test(tokens[k], k);
    if (v != null) return { v, at: k };
  }
  return null;
}

/** Two ways to one value: keep it if they agree (or only one found it); flag it if they don't. */
function settle(name, a, b, same, out) {
  const x = a?.v ?? null;
  const y = b?.v ?? null;
  if (x != null && y != null && !same(x, y)) out.conflicts.push(name);
  else if (x == null && y == null) out.missing.push(name);
  return x ?? y;
}
const eq = (a, b) => a === b;

const rowNo = (t) => {
  const m = /^(?:passenger\s*)?(\d{1,2})\s*[.):]?$/i.exec(t);
  return m ? Number(m[1]) : null;
};
const ROW_NOISE = 2; // unrelated bits of text (an ad, a note) a row may hold between its statuses
const ROW_GAP = 8; // how far past one passenger the next may start before the table counts as over

/**
 * Passengers, without relying on any list markup: rows numbered 1, 2, 3… each followed by up to
 * three statuses (booking, current, coach/berth). Starts after the table's headings when the page
 * has them, else where the booking starts. The numbering must run 1, 2, 3 without gaps, so a stray
 * number elsewhere ("2 minutes late") can't pass for a passenger.
 */
function passengersFrom(tokens, start) {
  let i = start;
  for (let k = start; k < Math.min(tokens.length, start + 200); k++) {
    if (PNR_LABELS.booking.includes(labelOf(tokens[k]))) {
      i = k + 1;
      break;
    }
  }
  const rows = [];
  let lastAt = i;
  for (let k = i; k < Math.min(tokens.length, i + 300); k++) {
    if (rows.length && k - lastAt > ROW_GAP) break; // the table has ended
    if (rowNo(tokens[k]) !== rows.length + 1) continue;
    const statuses = [];
    let noise = 0;
    let j = k + 1;
    for (; j < tokens.length && statuses.length < 3; j++) {
      const t = tokens[j];
      if (rowNo(t) != null || isLabel(t)) break; // the next row, or the next section
      if (check.status(t)) {
        statuses.push(t);
        lastAt = j;
        noise = 0;
      } else if (++noise > ROW_NOISE) break;
    }
    if (!statuses.length) continue; // a number, but not a passenger row
    const [booking, current, seat] = statuses.length === 1 ? [null, statuses[0], null] : statuses;
    rows.push(pnrPassenger(rows.length + 1, booking, current, seat));
    k = lastAt;
  }
  return rows;
}

/**
 * Read a booking out of a PNR page, for the PNR that was asked for.
 * Returns { data } when every required field reads cleanly, else { reason, missing, conflicts }.
 */
function extractPnr(html, askedPnr) {
  const { tokens, links, hidden } = pageText(html);
  const out = { missing: [], conflicts: [] };

  // Where the booking starts: the PNR itself on the page. A different PNR there means a different
  // booking, and no PNR at all means this isn't a booking page.
  const shown = byLabel(tokens, 0, "pnr", check.pnr, 3);
  const at = tokens.findIndex((t) => check.pnr(t) === askedPnr);
  if (shown && shown.v !== askedPnr) return { reason: "other_pnr", missing: [], conflicts: ["pnr"] };
  if (at < 0) {
    const none = tokens.some((t) => /FLUSHED PNR|PNR NOT YET GENERATED|INVALID PNR|PNR NO\.? IS NOT VALID/i.test(t));
    return { reason: none ? "no_booking" : "unreadable", missing: ["pnr"], conflicts: [] };
  }
  const start = Math.max(0, (shown?.at ?? at) - 2);

  // Train: by its label, and from the page's own timetable or live-status link.
  const trainL = byLabel(tokens, start, "train", check.trainNo, 3);
  const slug = links.map((l) => /\/(?:time-table|live-train-status|train-schedule)\/(\d{5})-([a-z0-9-]+?)(?:--([a-z]{1,5})-to-([a-z]{1,5}))?(?:[?#/]|$)/i.exec(l)).find(Boolean);
  const no = settle("train", trainL, slug ? { v: slug[1] } : null, eq, out);
  let name = null;
  if (trainL) {
    const own = tokens[trainL.at].replace(/^\D*\d{5}/, "");
    const next = tokens[trainL.at + 1];
    const raw = own.replace(/[\s‐-―-]/g, "") ? own : next && !isLabel(next) && !check.station(next) && /[A-Za-z]{3}/.test(next) ? next : "";
    name = raw.replace(/^[\s‐-―:-]+/, "").replace(/\s+/g, " ").trim() || null;
  }

  // Stations: by label, and as the first two "NAME | CODE" pieces of the booking. Both must agree.
  const fromL = byLabel(tokens, start, "from", check.station, 3);
  const toL = byLabel(tokens, start, "to", check.station, 3);
  const first = byPattern(tokens, start, check.station);
  const second = first && byPattern(tokens, start, (t) => {
    const s = check.station(t);
    return s && s.code !== first.v.code ? s : null;
  }, first.at + 1);
  const sameCode = (a, b) => a.code === b.code;
  const from = settle("from", fromL, first, sameCode, out);
  const to = settle("to", toL, second, sameCode, out);
  if (from && to && from.code === to.code) out.conflicts.push("to");

  // Times sit just after each station.
  const timeAfter = (st) => st && byPattern(tokens, start, check.time, st.at + 1, st.at - start + 4)?.v;
  const depTime = timeAfter(fromL || first);
  const arrTime = timeAfter(toL || second);

  // Day you board: by label, and as the only date in the booking.
  const dateL = byLabel(tokens, start, "date", check.date, 3);
  const dates = [...new Set(tokens.slice(start, start + 160).map((t) => check.date(t)).filter(Boolean))];
  const boardDate = settle("date", dateL, dates.length === 1 ? { v: dates[0] } : null, eq, out);

  // Optional: kept only when they read cleanly; dropped (never guessed) when two ways disagree.
  const dropped = [];
  const absent = [];
  const opt = (field, a, b, same = eq) => {
    const x = a?.v ?? null;
    const y = b?.v ?? null;
    if (x != null && y != null && !same(x, y)) return void dropped.push(field), null;
    if (x == null && y == null) absent.push(field);
    return x ?? y;
  };
  const clsL = byLabel(tokens, start, "cls", check.cls, 2);
  const cls = opt("cls", clsL, byPattern(tokens, start, (t) => (CLASS_BY_NAME[t.toUpperCase().replace(/\s+/g, " ")] ? check.cls(t) : null)));
  const className = clsL ? tokens[clsL.at] : null;
  const chart = opt("chart", byLabel(tokens, start, "chart", check.chart, 2), byPattern(tokens, start, (t) => (/CHART/i.test(t) ? check.chart(t.replace(/CHART\s*/i, "")) : null)));
  const platform = opt("platform", byLabel(tokens, start, "platform", check.platform, 2), null);
  const journeyMin = opt("duration", byLabel(tokens, start, "duration", (_, k) => durationAt(tokens, k), 2), null);

  const passengers = passengersFrom(tokens, start);
  if (!passengers.length) out.missing.push("passengers");
  // Berth type (lower, upper…) two ways: the seat data some versions of the page carry in a link
  // (used only for a passenger whose coach and berth there match what the page shows), and the
  // standard berth numbering of the coach. Kept when they agree or only one knows; left out when
  // they disagree.
  const linked = linkedSeats([...links, ...hidden]);
  passengers.forEach((p, i) => {
    if (!p.coach || !p.berth) return;
    const l = linked.length === passengers.length ? linked[i] : null;
    const fromData = l && l.coach === p.coach && l.berth === p.berth && BERTH_TYPES[l.type] ? BERTH_TYPES[l.type] : null;
    const fromLayout = berthByLayout(cls, Number(p.berth));
    const shown = p.berthType; // written on the page itself, e.g. "CNF/B3/59/UB"
    const all = [shown, fromData, fromLayout].filter(Boolean);
    p.berthType = all.length && all.every((x) => x === all[0]) ? all[0] : null;
    p.berthFrom = p.berthType ? (shown || fromData ? "railway" : "layout") : null;
  });

  const required = ["train", "from", "to", "date", "passengers"];
  const bad = [...out.missing, ...out.conflicts].filter((f) => required.includes(f));
  if (bad.length) return { reason: "unreadable", missing: out.missing, conflicts: out.conflicts };

  const count = (k) => passengers.filter((p) => p.kind === k).length;
  const overall =
    count("confirmed") === passengers.length ? "confirmed"
    : count("cancelled") === passengers.length ? "cancelled"
    : count("waitlist") ? "waitlist"
    : count("rac") ? "rac"
    : count("confirmed") ? "partly"
    : "unknown";
  const tidy = (s) => ({ code: s.code, name: pnrStationName(s.name) });

  return {
    data: {
      kind: "pnr",
      pnr: askedPnr,
      no,
      name,
      boardDate,
      from: { ...tidy(from), time: depTime || null },
      to: { ...tidy(to), time: arrTime || null },
      journeyMin: journeyMin ?? null,
      cls: cls || null,
      className,
      platform: platform || null,
      chart: chart || null,
      overall,
      passengers,
      source: "RailYatri",
      read: { by: PNR_READER, dropped, missing: absent },
      status: {},
    },
  };
}

/** "KSR BENGALURU" → "KSR Bengaluru" */
function pnrStationName(name) {
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Ksr|Mgr|Csmt|Ltt|Hs|Ii|Iii)\b/g, (w) => w.toUpperCase());
}

/** One passenger, from how the page reads: "Confirmed" + "B3/59", "CNF/B3/59/LB", "RAC 12", "GNWL 45/WL 12". */
// Standard berth numbering, repeating every bay: 3A and Sleeper have 8 berths a bay (6 in the
// main bay, 2 on the side), 2A has 6 (4 + 2), First AC numbers lower then upper.
const BERTH_LAYOUTS = {
  "3A": ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"],
  SL: ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"],
  "2A": ["LB", "UB", "LB", "UB", "SL", "SU"],
  "1A": ["LB", "UB"],
};
const berthByLayout = (cls, n) => (BERTH_LAYOUTS[cls] && n > 0 && n <= 90 ? BERTH_TYPES[BERTH_LAYOUTS[cls][(n - 1) % BERTH_LAYOUTS[cls].length]] : null);

/**
 * Seats as data, from a link that carries passenger_details[][…] fields: one entry per passenger,
 * in order, each { coach, berth, type } read from current_status_details ("B3/59") and berth ("UB").
 */
function linkedSeats(links) {
  const link = links.find((l) => /passenger_details/.test(l) && l.includes("?"));
  if (!link) return [];
  let q;
  try {
    q = new URLSearchParams(link.slice(link.indexOf("?") + 1));
  } catch {
    return [];
  }
  const seats = q.getAll("passenger_details[][current_status_details]");
  const types = q.getAll("passenger_details[][berth]");
  return seats.map((s, i) => {
    const m = /^([A-Z]{1,2}\d{1,2})\s*\/\s*(\d{1,3})$/.exec(String(s).trim().toUpperCase());
    return { coach: m ? m[1] : null, berth: m ? m[2] : null, type: String(types[i] || "").trim().toUpperCase() };
  });
}

function pnrPassenger(n, booking, current, seatText) {
  const cur = String(current || "").toUpperCase();
  const seat = /\b([A-Z]{1,2}\d{1,2})\s*[/,\s]\s*(\d{1,3})(?:\s*[/,\s]\s*([A-Z]{2}))?\b/.exec(`${cur} ${String(seatText || "").toUpperCase()}`);
  let kind = "unknown";
  if (/CAN/.test(cur)) kind = "cancelled";
  else if (/RAC/.test(cur)) kind = "rac";
  else if (/WL|WAIT/.test(cur)) kind = "waitlist";
  else if (/CNF|CONFIRM/.test(cur) || seat) kind = "confirmed";
  const position = kind === "rac" || kind === "waitlist" ? Number((cur.match(/\d+/g) || []).pop()) || null : null;
  return {
    n,
    kind,
    booking: String(booking || "").trim() || null,
    current: String(current || "").trim() || null,
    coach: seat ? seat[1] : null,
    berth: seat ? seat[2] : null,
    berthType: (seat && BERTH_TYPES[seat[3]]) || null,
    berthFrom: null,
    position,
  };
}
export { extractPnr };
export { parseErailOrder, parseConfirmTktOrder, parseEtrainOrder, confirmTktData, coachConsensus, mergeStops };
