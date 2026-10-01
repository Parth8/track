/**
 * Journey API: one Cloudflare Worker for the train and flight tracker.
 *
 * Routes (GET only):
 *   /api/health
 *   /api/train?no=12786&date=2026-09-29
 *   /api/flight?no=6E6252&date=2026-09-29
 *   /api/weather?lat=17.39&lon=78.50
 *
 * Settings (Worker > Settings > Variables and Secrets):
 *   ALLOWED_ORIGINS   text    e.g. https://yourname.github.io   (comma separated)
 *   ADB_KEY           SECRET  AeroDataBox key (RapidAPI). Flights stay off without it.
 *                             Add it with the "Secret" type, never "Text". It is only ever
 *                             sent to the AeroDataBox host, and every response is checked
 *                             so that no secret value can leave this Worker.
 *   ADB_HOST          text    optional, default aerodatabox.p.rapidapi.com
 *   REQUIRE_ORIGIN    text    optional, "false" lets you test in a browser tab
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const TTL = { train: 15, flight: 90, weather: 900, timetable: 43200, stale: 21600 };
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
    airline: { name: airline.name || iata, iata },
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
