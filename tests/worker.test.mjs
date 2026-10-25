// Worker tests: node --test tests/
// Upstream calls are answered from recorded responses in tests/fixtures, so these run offline.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { extractPnr } from "../worker/worker.js";
import { fidsAnswer, flightAnswer, MemoryKV } from "./fids.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const ORIGIN = "https://parth8.github.io";
const env = { ALLOWED_ORIGINS: ORIGIN };

/* ---------- a tiny stand-in for the Workers runtime ---------- */

class MemoryCache {
  constructor() {
    this.store = new Map();
  }
  async match(req) {
    const hit = this.store.get(req.url);
    if (!hit || hit.expires < Date.now()) return undefined; // like the real cache, max-age is honoured
    return new Response(hit.body, { headers: hit.headers });
  }
  async put(req, res) {
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1] ?? 1e9);
    this.store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers), expires: Date.now() + maxAge * 1000 });
  }
  /** Test helper: make an entry look expired. */
  expire(name) {
    const hit = this.store.get(`https://journey-cache.internal/${name}`);
    if (hit) hit.expires = 0;
  }
}

let upstream; // url => Response factory
let calls;
let pending;
const ctx = { waitUntil: (p) => pending.push(p) };

let ip = 0; // each test calls from its own address, so the Worker's rate limit never trips across tests
beforeEach(() => {
  ip++;
  globalThis.caches = { default: new MemoryCache() };
  upstream = new Map();
  calls = [];
  pending = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    for (const [match, make] of upstream) if (String(url).includes(match)) return make();
    throw new Error(`unexpected fetch ${url}`);
  };
});

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function get(path, { origin = ORIGIN, with: extra = {} } = {}) {
  const res = await worker.fetch(new Request(`https://journey-api.example${path}`, { headers: { "CF-Connecting-IP": `10.0.0.${ip}`, ...(origin ? { Origin: origin } : {}) } }), { ...env, ...extra }, ctx);
  await Promise.all(pending.splice(0));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const serve = (match, body, status = 200) =>
  upstream.set(match, () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

/* ---------- /api/between ---------- */

test("lists trains in departure order with times in IST", async () => {
  serve("from=NDLS&to=HWH", fixture("between-ndls-hwh.json"));
  const date = istToday();
  const { status, body } = await get(`/api/between?from=ndls&to=HWH&date=${date}`);
  assert.equal(status, 200);
  assert.equal(body.kind, "between");
  assert.equal(body.date, date);
  assert.equal(body.trains.length, 7);
  const deps = body.trains.map((t) => t.dep);
  assert.deepEqual(deps, [...deps].sort(), "sorted by departure");
  for (const t of body.trains) {
    assert.match(t.number, /^\d{5}$/);
    assert.match(t.dep, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:30$/);
    assert.ok(Date.parse(t.arr) > Date.parse(t.dep), `${t.number} arrives after it leaves`);
    assert.ok(t.durationMin > 0);
    assert.ok(t.runDays.every((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(d)));
  }
  assert.equal(body.from.code, "NDLS");
  assert.equal(body.from.name, "New Delhi");
});

test("works out the date each run started, from the day you board", async () => {
  serve("from=KCG&to=AP", fixture("between-kcg-ap.json"));
  const date = istToday();
  const { body } = await get(`/api/between?from=KCG&to=AP&date=${date}`);
  const late = body.trains.find((t) => t.number === "12976"); // reaches Kacheguda on day 3 of its run
  assert.equal(late.startDate, addDays(date, -2));
  assert.equal(late.dep, `${date}T00:05:00+05:30`, "leaves on the day you board");
  const daily = body.trains.find((t) => t.number === "12785");
  assert.equal(daily.startDate, date);
  assert.equal(daily.dep, `${date}T19:05:00+05:30`);
  assert.equal(daily.arr, `${addDays(date, 1)}T09:55:00+05:30`);
});

test("keeps nearby stations the timetable suggests, so the page can say so", async () => {
  serve("from=KCG&to=AP", fixture("between-kcg-ap.json"));
  const { body } = await get(`/api/between?from=KCG&to=AP&date=${istToday()}`);
  const fromSC = body.trains.find((t) => t.number === "17289");
  assert.equal(fromSC.from.code, "SC");
  assert.equal(fromSC.to.code, "MYS");
  assert.equal(fromSC.onTimeRating, null, "unknown rating (-1) becomes null");
});

test("lists trains that don't run that day separately, without repeats", async () => {
  serve("from=NDLS&to=HWH", fixture("between-ndls-hwh.json"));
  const { body } = await get(`/api/between?from=NDLS&to=HWH&date=${istToday()}`);
  const running = new Set(body.trains.map((t) => t.number));
  assert.ok(body.others.length > 0);
  for (const o of body.others) {
    assert.ok(!running.has(o.number), `${o.number} is not also in the running list`);
    assert.match(o.depTime, /^\d{2}:\d{2}$/);
    assert.match(o.nextDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("answers repeat searches from the cache", async () => {
  serve("from=MYS&to=KCG", fixture("between-mys-kcg.json"));
  const date = istToday();
  await get(`/api/between?from=MYS&to=KCG&date=${date}`);
  await get(`/api/between?from=MYS&to=KCG&date=${date}`);
  assert.equal(calls.length, 1);
});

test("rejects bad input with a clear code", async () => {
  const today = istToday();
  const cases = [
    [`/api/between?from=MYS&to=MYS&date=${today}`, "same_station"],
    [`/api/between?from=MY5&to=KCG&date=${today}`, "invalid_station"],
    [`/api/between?from=&to=KCG&date=${today}`, "invalid_station"],
    [`/api/between?from=MYS&to=KCG&date=2026-13-45x`, "invalid_date"],
    [`/api/between?from=MYS&to=KCG&date=${addDays(today, -10)}`, "date_out_of_range"],
    [`/api/between?from=MYS&to=KCG&date=${addDays(today, 200)}`, "date_out_of_range"],
  ];
  for (const [path, code] of cases) {
    const { status, body } = await get(path);
    assert.equal(status, 400, path);
    assert.equal(body.error, code, path);
  }
  assert.equal(calls.length, 0, "nothing invalid reaches upstream");
});

test("only serves its own website", async () => {
  const { status, body } = await get(`/api/between?from=MYS&to=KCG&date=${istToday()}`, { origin: "https://evil.example" });
  assert.equal(status, 403);
  assert.equal(body.error, "forbidden");
});

test("says so plainly when the timetable source fails", async () => {
  serve("from=MYS&to=KCG", { success: false }, 200);
  const { status, body } = await get(`/api/between?from=MYS&to=KCG&date=${istToday()}`);
  assert.equal(status, 502);
  assert.equal(body.error, "upstream_unavailable");
});

test("falls back to the last good answer when the source is down", async () => {
  const date = istToday();
  serve("from=MYS&to=KCG", fixture("between-mys-kcg.json"));
  await get(`/api/between?from=MYS&to=KCG&date=${date}`);
  // The fresh copy expires; the source then fails.
  const cache = globalThis.caches.default;
  for (const key of [...cache.store.keys()]) if (!key.endsWith("/stale")) cache.store.delete(key);
  upstream.clear();
  upstream.set("from=MYS&to=KCG", () => new Response("oops", { status: 503 }));
  const { status, body } = await get(`/api/between?from=MYS&to=KCG&date=${date}`);
  assert.equal(status, 200);
  assert.equal(body.status.servedStale, true);
  assert.equal(body.trains[0].number, "12786");
});

/* ---------- seat availability ---------- */

const seatsPath = (q = {}) =>
  `/api/seats?${new URLSearchParams({ no: "12306", from: "NDLS", to: "HWH", date: addDays(istToday(), 7), cls: "2A", quota: "GN", ...q })}`;

test("between: each train lists the classes it carries, skipping ones with no coaches", async () => {
  serve("trains-between-station", fixture("between-ndls-hwh.json"));
  const { body } = await get(`/api/between?from=NDLS&to=HWH&date=${istToday()}`);
  const raj = body.trains.find((t) => t.number === "12314");
  assert.deepEqual(raj.classes, ["3A", "2A", "1A"]);
  for (const t of body.trains) assert.ok(Array.isArray(t.classes) && t.classes.length, `${t.number} has classes`);
});

test("seats: a waitlist reads as the current position, with fare and confirmation chance", async () => {
  serve("sa.railyatri.in", fixture("seats-12306-2a.json"));
  const { status, body } = await get(seatsPath());
  assert.equal(status, 200);
  assert.equal(body.className, "AC 2 Tier");
  assert.equal(body.quotaName, "General");
  assert.equal(body.days.length, 4);
  assert.deepEqual(
    { kind: body.days[0].kind, count: body.days[0].count, label: body.days[0].label, fare: body.days[0].fare, chance: body.days[0].chance },
    { kind: "waitlist", count: 29, label: "Waitlist 29", fare: 4390, chance: 38 }
  );
  assert.equal(body.days[0].date, "2026-10-09");
  assert.match(calls[0], /\/api\/seat\/enquiry\/12306\/\d{4}-\d{2}-\d{2}\/NDLS\/HWH\/2A\/GN\.json/);
});

test("seats: available, RAC and regret are told apart", async () => {
  serve("seat/enquiry/12306", fixture("seats-12306-3a.json"));
  const a = await get(seatsPath({ cls: "3A" }));
  assert.deepEqual(a.body.days.map((d) => [d.kind, d.label, d.chance]), [["rac", "RAC 78", null], ["available", "48 available", null]]);
  serve("seat/enquiry/12627", fixture("seats-12627-3a.json"));
  const b = await get(seatsPath({ no: "12627", from: "SBC", to: "NDLS", cls: "3A" }));
  assert.deepEqual(b.body.days.map((d) => d.kind), ["regret", "regret", "waitlist", "waitlist"]);
  assert.equal(b.body.days[0].fare, null, "no fare for a regret");
});

test("seats: a class the train doesn't carry, or a day it doesn't run, gets a clear 404", async () => {
  serve("sa.railyatri.in", { success: true, error: "Class does not exist in this train for this Train route", seat_availibility: [] });
  const a = await get(seatsPath({ cls: "SL" }));
  assert.deepEqual([a.status, a.body.error], [404, "class_not_found"]);
  assert.match(a.body.message, /Sleeper isn't on this train/);
  serve("sa.railyatri.in", { success: true, error: "Invalid Journey Details\n", seat_availibility: [] });
  const b = await get(seatsPath({ cls: "1A" }));
  assert.deepEqual([b.status, b.body.error], [404, "not_running"]);
});

test("seats: bad input is refused before any lookup", async () => {
  for (const [q, code] of [
    [{ no: "123" }, "invalid_train"],
    [{ cls: "XX" }, "invalid_class"],
    [{ quota: "LD" }, "invalid_quota"],
    [{ to: "NDLS" }, "same_station"],
    [{ date: addDays(istToday(), -1) }, "date_out_of_range"],
  ]) {
    const { status, body } = await get(seatsPath(q));
    assert.deepEqual([status, body.error], [400, code], JSON.stringify(q));
  }
  assert.equal(calls.length, 0);
});

test("seats: one lookup serves repeat checks for 10 minutes", async () => {
  serve("sa.railyatri.in", fixture("seats-12306-2a.json"));
  await get(seatsPath());
  await get(seatsPath());
  assert.equal(calls.length, 1);
});

/* ---------- flights between two airports ---------- */

const flightEnv = (over = {}) => ({ ADB_KEY: "test-key", QUOTA: new MemoryKV(), ...over });
const serveFids = () => upstream.set("/flights/airports/iata/", () => null) && (globalThis.fetch = async (url) => {
  calls.push(String(url));
  const r = fidsAnswer(url);
  if (r) return r;
  throw new Error(`unexpected fetch ${url}`);
});

test("flights: only flights that land at To, one row per real flight, earliest first", async () => {
  serveFids();
  const e = flightEnv();
  const d = addDays(istToday(), 2);
  const { status, body } = await get(`/api/flights?from=DEL&to=BLR&date=${d}`, { with: e });
  assert.equal(status, 200);
  const nos = body.flights.map((f) => f.no);
  assert.deepEqual(nos, ["6E2131", "AI2803", "QP1381", "6E6352", "IX1124", "6E5338", "AI2807", "6E2516", "QP1356", "AI2820", "6E6814"]);
  assert.ok(!nos.includes("VS8110"), "codeshare left out");
  assert.ok(!nos.includes("6E9001"), "cargo left out");
  const late = body.flights.find((f) => f.no === "QP1381");
  assert.equal(late.status.delayMin, 45);
  assert.equal(body.flights.find((f) => f.no === "6E6352").status.phase, "cancelled");
  const overnight = body.flights.at(-1);
  assert.equal(overnight.date, d, "tracking date is the local departure date");
  assert.equal(overnight.arr.sched.slice(0, 10), addDays(d, 1) === overnight.arr.sched.slice(0, 10) ? addDays(d, 1) : overnight.arr.sched.slice(0, 10));
  assert.equal(overnight.durationMin, 165);
  assert.equal(body.to.tz, "Asia/Kolkata");
  assert.equal(calls.length, 2, "two half-day slots");
  assert.match(calls[0], /withCodeshared=false/);
  assert.equal(await e.QUOTA.get(`adb/${istToday().slice(0, 7)}`), "2");
});

test("flights: an evening search needs one slot; every search from the airport that day shares it", async () => {
  serveFids();
  const e = flightEnv();
  const d = addDays(istToday(), 3);
  const a = await get(`/api/flights?from=DEL&to=BLR&date=${d}&after=17:00`, { with: e });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /T12:00\/.*T23:59/);
  assert.equal(a.body.after, "17:00");
  const b = await get(`/api/flights?from=DEL&to=DXB&date=${d}&after=18:00`, { with: e });
  assert.equal(calls.length, 1, "Dubai search reused Delhi's afternoon board");
  assert.deepEqual(b.body.flights.map((f) => f.no), [], "EK 511 leaves in the morning");
  const c = await get(`/api/flights?from=DEL&to=DXB&date=${d}`, { with: e });
  assert.equal(calls.length, 2, "only the missing morning slot was looked up");
  assert.equal(c.body.flights[0].arr.tz, "Asia/Dubai");
});

/* ---------- the flight-data budget ---------- */

const DEL_AIRPORT = { iata: "DEL", icao: "VIDP", shortName: "Delhi", fullName: "Indira Gandhi", municipalityName: "Delhi", timeZone: "Asia/Kolkata", location: { lat: 28.56, lon: 77.1 } };
// AeroDataBox stand-in: departure boards, flights by number, airports, and (free) live positions.
function serveAll({ live = null } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("adsb")) return new Response(JSON.stringify({ ac: live ? [live] : [] }), { headers: { "Content-Type": "application/json" } });
    if (/\/airports\/iata\/[A-Z]{3}$/.test(u)) return new Response(JSON.stringify(DEL_AIRPORT), { headers: { "Content-Type": "application/json" } });
    return fidsAnswer(u) || flightAnswer(u) || new Response(null, { status: 204 });
  };
}
const paid = () => calls.filter((u) => u.includes("aerodatabox"));
const month = () => `adb/${istToday().slice(0, 7)}`;

test("budget: search stops first, keeping the last of today's share for tracking", async () => {
  serveAll();
  const e = flightEnv({ FLIGHT_LOOKUP_CAP: "1" }); // today's share rounds up to 1 call
  const a = await get(`/api/flights?from=DEL&to=BLR&date=${addDays(istToday(), 4)}`, { with: e });
  assert.deepEqual([a.status, a.body.error], [503, "search_paused"]);
  assert.match(a.body.message, /resting until tomorrow/);
  const t = await get(`/api/flight?no=6E2131&date=${addDays(istToday(), 4)}`, { with: e });
  assert.equal(t.status, 200, "tracking still gets the last call");
  const u = await get(`/api/flight?no=AI2803&date=${addDays(istToday(), 4)}`, { with: e });
  assert.deepEqual([u.status, u.body.error], [503, "flights_resting"]);
  assert.match(u.body.message, /back tomorrow/);
  const again = await get(`/api/flight?no=6E2131&date=${addDays(istToday(), 4)}`, { with: e });
  assert.equal(again.status, 200, "a flight someone already checked stays free");
  assert.equal(paid().length, 1);
});

test("budget: one visitor can cause only a few paid lookups a day", async () => {
  serveAll();
  const e = flightEnv({ FLIGHT_LOOKUP_CAP: "5000", FLIGHT_VISITOR_DAILY: "2" });
  const d = addDays(istToday(), 3);
  assert.equal((await get(`/api/flight?no=6E2131&date=${d}`, { with: e })).status, 200);
  assert.equal((await get(`/api/flight?no=AI2803&date=${d}`, { with: e })).status, 200);
  const third = await get(`/api/flight?no=QP1381&date=${d}`, { with: e });
  assert.deepEqual([third.status, third.body.error], [429, "visitor_limit"]);
  assert.equal((await get(`/api/flight?no=6E2131&date=${d}`, { with: e })).status, 200, "cached ones stay free");
  ip++; // someone else
  assert.equal((await get(`/api/flight?no=QP1381&date=${d}`, { with: e })).status, 200);
  const keys = [...e.QUOTA.map.keys()].filter((k) => k.startsWith("visitor/"));
  assert.ok(keys.every((k) => /^visitor\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}$/.test(k)), "addresses are stored only as a short hash");
});

test("boards: tracking any flight on a board someone's search fetched costs nothing", async () => {
  serveAll();
  const e = flightEnv();
  const d = addDays(istToday(), 2);
  await get(`/api/flights?from=DEL&to=BOM&date=${d}`, { with: e }); // a search for Mumbai, 2 calls
  calls.length = 0;
  const a = await get(`/api/flight?no=6E5338&date=${d}`, { with: e }); // a Bengaluru flight on the same board
  assert.equal(a.status, 200);
  assert.equal(a.body.status.via, "board");
  assert.equal(a.body.departure.code, "DEL");
  assert.equal(a.body.departure.tz, "Asia/Kolkata");
  assert.equal(a.body.arrival.code, "BLR");
  // At most one call: Delhi's own details, the first time the Worker ever needs them.
  const firstPaid = paid().map((u) => u.replace(/.*rapidapi.com/, ""));
  assert.ok(firstPaid.length <= 1 && firstPaid.every((u) => u === "/airports/iata/DEL"), firstPaid.join());
  calls.length = 0;
  const b = await get(`/api/flight?no=IX1124&date=${d}`, { with: e });
  assert.equal(b.body.status.via, "board");
  assert.equal(paid().length, 0, "nothing paid at all now");
  if (firstPaid.length) assert.ok(await e.QUOTA.get("airport/DEL"), "airport kept for good");
});

test("free positions keep a flight in the air current without paying", async () => {
  // A flight that took off an hour ago
  const now = Date.now();
  const at = (ms) => ({ utc: new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z", local: new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace("T", " ") + "+05:30" });
  const d = new Date(now - 60 * 60000 + 330 * 60000).toISOString().slice(0, 10);
  const body = [{ number: "6E 777", status: "EnRoute", callSign: "IGO777", airline: { name: "IndiGo", iata: "6E" },
    departure: { airport: DEL_AIRPORT, scheduledTime: at(now - 60 * 60000), runwayTime: at(now - 55 * 60000) },
    arrival: { airport: { ...DEL_AIRPORT, iata: "BLR", icao: "VOBL", shortName: "Bengaluru", location: { lat: 13.2, lon: 77.7 } }, scheduledTime: at(now + 100 * 60000) } }];
  serveAll({ live: { lat: 20, lon: 77, alt_baro: 36000, gs: 450, track: 180, seen_pos: 2 } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("/flights/number/") ? (calls.push(String(url)), new Response(JSON.stringify(body))) : real(url));
  const e = flightEnv();
  const a = await get(`/api/flight?no=6E777&date=${d}`, { with: e });
  assert.equal(a.body.status.phase, "air");
  assert.equal(paid().length, 1);
  caches.default.expire(`flight/6E777/${d}`); // its schedule copy has gone stale
  const b = await get(`/api/flight?no=6E777&date=${d}`, { with: e });
  assert.equal(b.body.status.phase, "air");
  assert.equal(b.body.position.altFt, 36000);
  assert.equal(paid().length, 1, "no new paid call while it's flying");
});

test("far-off flights are kept for 12 hours; near departure only 10 minutes", async () => {
  serveAll();
  const e = flightEnv();
  await get(`/api/flight?no=6E2131&date=${addDays(istToday(), 5)}`, { with: e });
  const far = caches.default.store.get(`https://journey-cache.internal/flight/6E2131/${addDays(istToday(), 5)}`);
  assert.match(far.headers["cache-control"], /max-age=(4[0-3]\d{3})/);
});

test("when today's share is spent, the last known copy is shown and labelled", async () => {
  serveAll();
  const e = flightEnv({ FLIGHT_LOOKUP_CAP: "1" });
  const d = addDays(istToday(), 1);
  await get(`/api/flight?no=AI2807&date=${d}`, { with: e });
  caches.default.expire(`flight/AI2807/${d}`);
  const b = await get(`/api/flight?no=AI2807&date=${d}`, { with: e });
  assert.equal(b.status, 200);
  assert.equal(b.body.status.servedStale, true);
  assert.match(b.body.status.note, /used up/);
});

test("flight search without the KV store, and flights without a key, say so", async () => {
  serveAll();
  const c = await get(`/api/flights?from=DEL&to=BLR&date=${addDays(istToday(), 5)}`, { with: { ADB_KEY: "k" } });
  assert.deepEqual([c.status, c.body.error], [503, "search_not_configured"]);
  const n = await get(`/api/flights?from=DEL&to=BLR&date=${addDays(istToday(), 5)}`);
  assert.deepEqual([n.status, n.body.error], [503, "flights_not_configured"]);
});

test("flights: bad input is refused before any lookup", async () => {
  serveFids();
  for (const [q, code] of [
    ["from=DELHI&to=BLR", "invalid_airport"],
    ["from=DEL&to=DEL", "same_airport"],
    [`from=DEL&to=BLR&date=${addDays(istToday(), 9)}`, "date_out_of_range"],
  ]) {
    const { status, body } = await get(`/api/flights?${q}`, { with: flightEnv() });
    assert.deepEqual([status, body.error], [400, code], q);
  }
  assert.equal(calls.length, 0);
});

test("flights: an airport with no departures that day gives an empty list, not an error", async () => {
  serveFids();
  const { status, body } = await get(`/api/flights?from=IXZ&to=BLR&date=${addDays(istToday(), 1)}`, { with: flightEnv() });
  assert.equal(status, 200);
  assert.deepEqual(body.flights, []);
});

test("flights: a real AeroDataBox departure board (Delhi, recorded) reads correctly", async () => {
  const real = fixture("fids-del-real.json");
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).includes("T00:00") ? real.am : real.pm), { headers: { "Content-Type": "application/json" } });
  };
  const { status, body } = await get(`/api/flights?from=DEL&to=BLR&date=${istToday()}`, { with: flightEnv() });
  assert.equal(status, 200);
  assert.equal(body.flights.length, 38);
  assert.ok(body.flights.every((f) => f.arr.code === "BLR" && /^\d{2}:\d{2}$/.test(f.dep.local) && f.durationMin > 100));
  const akasa = body.flights.find((f) => f.no.startsWith("QP"));
  assert.equal(akasa.airline.name, "Akasa Air", "not the data's 'Starlight Airline'");
  const overnight = body.flights.filter((f) => f.arr.localDate > f.dep.localDate);
  assert.ok(overnight.length >= 4, "late flights land the next day");
});

test("between: a nearby station says how far it is from the one asked for", async () => {
  serve("trains-between-station", fixture("between-kcg-sbc.json"));
  const { body } = await get(`/api/between?from=KCG&to=SBC&date=${addDays(istToday(), 2)}`);
  const vb = body.trains.find((t) => t.number === "20703");
  assert.deepEqual([vb.to.code, vb.to.nearKm], ["YPR", 5]);
  assert.equal(body.trains.find((t) => t.number === "12785").to.nearKm, undefined, "exact stations have no distance");
});

/* ---------- refresh design: free in the air, one check after landing, shared boards ---------- */

const at = (ms) => ({ utc: new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z", local: new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace("T", " ") + "+05:30" });
const BLR = { iata: "BLR", icao: "VOBL", shortName: "Bengaluru", municipalityName: "Bengaluru", timeZone: "Asia/Kolkata", location: { lat: 13.2, lon: 77.7 } };
function flightBody(no, dep, arr, status, extra = {}) {
  return [{ number: no, status, callSign: `IGO${no.slice(3)}`, airline: { name: "IndiGo", iata: "6E" }, aircraft: { model: "A320", modeS: "800abc" },
    departure: { airport: DEL_AIRPORT, scheduledTime: at(dep), ...(status !== "Expected" ? { runwayTime: at(dep) } : {}) },
    arrival: { airport: BLR, scheduledTime: at(arr), ...(status === "Arrived" ? { runwayTime: at(arr), baggageBelt: "7" } : {}) }, ...extra }];
}

test("in the air: no paid calls at all, and a landing time from live speed; then one check after landing", async () => {
  const now = Date.now();
  const d = new Date(now - 90 * 60000 + 330 * 60000).toISOString().slice(0, 10);
  let answer = flightBody("6E 901", now - 90 * 60000, now + 60 * 60000, "EnRoute");
  let live = { lat: 20, lon: 77.5, alt_baro: 36000, gs: 440, track: 180, seen_pos: 1 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("adsb")) return new Response(JSON.stringify({ ac: live ? [live] : [] }));
    return new Response(JSON.stringify(answer));
  };
  const e = flightEnv();
  const a = await get(`/api/flight?no=6E901&date=${d}`, { with: e });
  assert.equal(a.body.status.phase, "air");
  assert.ok(a.body.arrival.liveEta, "landing time worked out from live speed");
  for (let i = 0; i < 3; i++) {
    caches.default.expire(`flight/6E901/${d}`);
    caches.default.expire(`pos/800abc`);
    await get(`/api/flight?no=6E901&date=${d}`, { with: e });
  }
  assert.equal(paid().length, 1, "only the first lookup was paid");
  // Out of receiver range mid-flight: still free
  live = null;
  caches.default.expire(`flight/6E901/${d}`);
  caches.default.expire(`pos/800abc`);
  const quiet = await get(`/api/flight?no=6E901&date=${d}`, { with: e });
  assert.equal(quiet.body.status.phase, "air");
  assert.equal(paid().length, 1);
  // Well after its landing time: exactly one paid check, then the landed copy is kept for the day
  const stale = caches.default.store.get(`https://journey-cache.internal/flight/6E901/${d}/stale`);
  const old = JSON.parse(stale.body);
  old.arrival.sched = new Date(now - 20 * 60000).toISOString();
  stale.body = JSON.stringify(old);
  caches.default.expire(`flight/6E901/${d}`);
  answer = flightBody("6E 901", now - 150 * 60000, now - 20 * 60000, "Arrived");
  const landed = await get(`/api/flight?no=6E901&date=${d}`, { with: e });
  assert.equal(landed.body.status.phase, "landed");
  assert.equal(landed.body.arrival.belt, "7");
  assert.equal(paid().length, 2);
  await get(`/api/flight?no=6E901&date=${d}`, { with: e });
  assert.equal(paid().length, 2, "no more paid calls after landing");
  const cc = caches.default.store.get(`https://journey-cache.internal/flight/6E901/${d}`).headers["cache-control"];
  assert.match(cc, /max-age=8\d{4}/, "kept for a day");
});

test("before take-off, one board refresh brings everyone's flights from that airport up to date", async () => {
  serveAll();
  const e = flightEnv();
  const d = addDays(istToday(), 1);
  await get(`/api/flight?no=6E2516&date=${d}`, { with: e }); // a paid lookup to start
  await get(`/api/flight?no=QP1356&date=${d}`, { with: e });
  calls.length = 0;
  caches.default.expire(`flight/6E2516/${d}`);
  caches.default.expire(`flight/QP1356/${d}`);
  const a = await get(`/api/flight?no=6E2516&date=${d}`, { with: e });
  assert.equal(a.body.status.via, "board");
  assert.deepEqual(paid().map((u) => u.replace(/.*iata\/|\?.*/g, "")), [`DEL/${d}T12:00/${d}T23:59`], "refreshed the evening board");
  const b = await get(`/api/flight?no=QP1356&date=${d}`, { with: e });
  assert.equal(b.body.status.via, "board");
  assert.equal(paid().length, 1, "the second flight came free from the same board");
  const hoursAway = (Date.parse(a.body.departure.sched) - Date.now()) / 3600000;
  assert.equal(a.body.status.windowMin, hoursAway > 24 ? 720 : hoursAway > 6 ? 180 : hoursAway > 2 ? 60 : 30, "checked less often the further away it is");
});

test("one flight gets at most a few paid refreshes a day; refreshing doesn't count against the visitor", async () => {
  serveAll();
  const e = flightEnv({ FLIGHT_PER_FLIGHT_DAILY: "2", FLIGHT_VISITOR_DAILY: "1" });
  const d = addDays(istToday(), 1);
  for (let i = 0; i < 4; i++) {
    caches.default.expire(`flight/AI2820/${d}`);
    caches.default.expire(`fids/DEL/${d}/pm`);
    const r = await get(`/api/flight?no=AI2820&date=${d}`, { with: e });
    assert.equal(r.status, 200, `refresh ${i + 1} still answers (visitor limit is 1, but it's the same flight)`);
  }
  assert.equal(paid().length, 2, "capped at 2 paid calls for this flight today");
  const last = await get(`/api/flight?no=AI2820&date=${d}`, { with: e });
  assert.equal(last.status, 200);
  const other = await get(`/api/flight?no=6E2131&date=${d}`, { with: e });
  assert.deepEqual([other.status, other.body.error], [429, "visitor_limit"], "a second new flight is over this visitor's limit");
});

/* ---------- /api/pnr ---------- */

const pnrPage = readFileSync(new URL("./fixtures/pnr-sbc-kcg.html", import.meta.url), "utf8"); // a real page, PNR replaced
const servePnr = (html = pnrPage, known = true) => {
  serve("/get-status/", { status: known });
  upstream.set("/pnr-status/", () => new Response(html, { headers: { "Content-Type": "text/html" } }));
};

test("pnr: a booking reads as train, stations, day, class, chart and each passenger", async () => {
  servePnr();
  const { status, body, headers } = await get("/api/pnr?pnr=1234567890");
  assert.equal(status, 200);
  assert.equal(headers.get("Cache-Control"), "no-store", "a booking is never kept by the browser");
  assert.equal(body.no, "12786");
  assert.equal(body.name, "Ashokapuram - Kacheguda SF Express");
  assert.deepEqual(body.from, { code: "SBC", name: "KSR Bengaluru", time: "17:45" });
  assert.deepEqual(body.to, { code: "KCG", name: "Kacheguda", time: "05:40" });
  assert.equal(body.boardDate, "2026-11-14");
  assert.equal(body.journeyMin, 11 * 60 + 55);
  assert.deepEqual([body.cls, body.className, body.platform, body.chart, body.overall], ["3A", "AC 3 Tier", "5", "not_prepared", "confirmed"]);
  assert.equal(body.passengers.length, 1);
  assert.deepEqual(body.passengers[0], { n: 1, kind: "confirmed", booking: "Confirmed", current: "Confirmed", coach: "B3", berth: "59", berthType: "Upper", berthFrom: "layout", position: null });
});

test("pnr: several passengers, waitlisted and RAC, each read on its own", async () => {
  const li = (n, b, c, s) => `<li class="PNRPasList"><span class="paxListCount">${n}.</span><div><p class="statusType">${b}</p></div><div><p class="statusType">${c}</p></div><div><p class="statusType">${s}</p></div></li>`;
  const html = pnrPage.replace(/<ul class="pasListUL">[\s\S]*?<\/ul>/, `<ul class="pasListUL">${li(1, "GNWL 45/WL 40", "CNF/B2/33/LB", "")}${li(2, "GNWL 46/WL 41", "RAC 7", "")}${li(3, "GNWL 47/WL 42", "WL 12", "")}</ul>`);
  servePnr(html);
  const { body } = await get("/api/pnr?pnr=1234567890");
  assert.deepEqual(
    body.passengers.map((p) => [p.n, p.kind, p.coach, p.berth, p.berthType, p.position]),
    [
      [1, "confirmed", "B2", "33", "Lower", null],
      [2, "rac", null, null, null, 7],
      [3, "waitlist", null, null, null, 12],
    ]
  );
  assert.equal(body.overall, "waitlist");
});

// RailYatri's real "please wait while we fetch it" page, for a booking it hasn't fetched yet. It
// also carries their hidden "FLUSHED PNR" message, so the page alone can't tell "not yet" from "never".
const pendingPage = readFileSync(new URL("./fixtures/pnr-pending.html", import.meta.url), "utf8");

test("pnr: a first look-up waits while RailYatri fetches the booking, like their own page does", async () => {
  let asks = 0;
  upstream.set("/get-status/", () => new Response(JSON.stringify({ status: ++asks >= 3 }), { headers: { "Content-Type": "application/json" } }));
  upstream.set("/pnr-status/", () => new Response(asks >= 3 ? pnrPage : pendingPage, { headers: { "Content-Type": "text/html" } }));
  const r = await get("/api/pnr?pnr=1234567890", { with: { PNR_WAIT_MS: "12000" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.passengers[0].coach, "B3");
  assert.equal(asks, 3, "asked until it was ready");
});

test("pnr: a booking that's already fetched comes straight from the page, with no waiting", async () => {
  servePnr();
  const t = Date.now();
  const r = await get("/api/pnr?pnr=1234567890");
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t < 1000);
  assert.equal(calls.filter((u) => u.includes("/get-status/")).length, 0);
});

test("pnr: an unknown PNR is a clear 404, and bad input never leaves the Worker", async () => {
  servePnr(pendingPage, false);
  const missing = await get("/api/pnr?pnr=9876543210", { with: { PNR_WAIT_MS: "4000" } });
  assert.deepEqual([missing.status, missing.body.error], [404, "pnr_not_found"]);
  calls = [];
  for (const bad of ["12345", "abcdefghij", "12345678901"]) {
    const r = await get(`/api/pnr?pnr=${bad}`);
    assert.deepEqual([r.status, r.body.error], [400, "invalid_pnr"], bad);
  }
  assert.equal(calls.length, 0);
});

test("pnr: kept 5 minutes under a hash, never the PNR itself", async () => {
  servePnr();
  await get("/api/pnr?pnr=1234567890");
  const n = calls.length;
  await get("/api/pnr?pnr=1234567890");
  assert.equal(calls.length, n, "the repeat came from the cache");
  const keys = [...caches.default.store.keys()];
  assert.ok(keys.some((k) => k.includes("/pnr/")));
  assert.ok(!keys.some((k) => k.includes("1234567890")), "no cache key holds the PNR");
});

/* ---------- PNR extraction: the same booking, however the page is shaped ---------- */

// What the real page says. Every reshaped copy below must read exactly the same.
const GOLDEN = {
  no: "12786",
  name: "Ashokapuram - Kacheguda SF Express",
  boardDate: "2026-11-14",
  from: { code: "SBC", name: "KSR Bengaluru", time: "17:45" },
  to: { code: "KCG", name: "Kacheguda", time: "05:40" },
  journeyMin: 715,
  cls: "3A",
  platform: "5",
  chart: "not_prepared",
  overall: "confirmed",
  passengers: [{ n: 1, kind: "confirmed", booking: "Confirmed", current: "Confirmed", coach: "B3", berth: "59", berthType: "Upper", berthFrom: "layout", position: null }],
};
const core = (d) => d && Object.fromEntries(Object.keys(GOLDEN).map((k) => [k, d[k]]));
const readPnr = (html, pnr = "1234567890") => extractPnr(html, pnr);

// A different site design altogether: a table of label/value cells, other wording, other formats.
const REDESIGN = `<html><body><main><h1>Your booking</h1>
<table><tr><th>PNR No.</th><td>123-456-7890</td></tr>
<tr><th>Train No/Name</th><td>12786 - Ashokapuram - Kacheguda SF Express</td></tr>
<tr><th>Boarding Station</th><td>KSR Bengaluru (SBC)</td><td>5:45 pm</td></tr>
<tr><th>Destination</th><td>Kacheguda (KCG)</td><td>5:40 am</td></tr>
<tr><th>Duration</th><td>11h 55m</td></tr>
<tr><th>Date of Journey</th><td>Sat, 14 Nov 2026</td></tr>
<tr><th>Class</th><td>AC 3 Tier (3A)</td></tr><tr><th>Platform</th><td>PF 5</td></tr>
<tr><th>Chart</th><td>Chart not yet prepared</td></tr></table>
<section><h2>Booking status</h2><div>Current status</div><div>Coach / Berth</div>
<div>Passenger 1</div><div>Confirmed</div><div>Confirmed</div><div>B3/59</div></section>
<footer>Book food on train · Hotels · 50% off</footer></main></body></html>`;

test("pnr extraction: reshaped pages read exactly like the real one", () => {
  assert.deepEqual(core(readPnr(pnrPage).data), GOLDEN, "the real page");
  const variants = {
    "every class, id and style removed": pnrPage.replace(/\s(class|id|style)\s*=\s*("[^"]*"|'[^']*')/gi, ""),
    "tags swapped (p→div, span→em, div→section)": pnrPage.replace(/<(\/?)p\b/gi, "<$1div").replace(/<(\/?)span\b/gi, "<$1em").replace(/<(\/?)div\b/gi, "<$1section"),
    "no list markup for passengers": pnrPage.replace(/<\/?(ul|li)\b[^>]*>/gi, ""),
    "labels reworded and lower-cased": pnrPage.replace(">PNR NUMBER<", ">Pnr number:<").replace(">DAY OF BOARDING<", ">Date of Boarding<").replace("PF# (TENTATIVE)", "Platform (tentative)").replace(">JOURNEY TIME<", ">Duration<"),
    "all links gone": pnrPage.replace(/<a\b[^>]*>/gi, "<span>").replace(/<\/a>/gi, "</span>"),
    "ads and banners between every field": pnrPage.replace(/<\/p>/gi, "</p><ins>Sponsored · Order food now</ins>"),
    "a whole new design": REDESIGN,
  };
  for (const [name, html] of Object.entries(variants)) {
    const r = readPnr(html);
    assert.ok(r.data, `${name}: ${r.reason} missing=${r.missing} conflicts=${r.conflicts}`);
    assert.deepEqual(core(r.data), GOLDEN, name);
  }
});

test("pnr extraction: the same page always reads the same way", () => {
  const a = JSON.stringify(readPnr(pnrPage));
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(readPnr(pnrPage)), a);
});

test("pnr extraction: refuses rather than guesses", () => {
  // Someone else's booking on the page
  assert.equal(readPnr(pnrPage, "9876543210").reason, "other_pnr");
  // The passenger table is gone
  const noTable = readPnr(pnrPage.replace(/<ul class="pasListUL">[\s\S]*?<\/ul>/, ""));
  assert.deepEqual([noTable.data, noTable.reason, noTable.missing], [undefined, "unreadable", ["passengers"]]);
  // Two ways to the boarding station disagree (a stray station before the labelled one)
  const twoFroms = readPnr(pnrPage.replace('<p class="pnr-normal-font">FROM</p>', '<p>MYSURU JN | MYS</p><p class="pnr-normal-font">FROM</p>'));
  assert.equal(twoFroms.reason, "unreadable");
  assert.ok(twoFroms.conflicts.includes("from"));
  // A day that doesn't exist is no date at all
  const badDay = readPnr(pnrPage.replace("14-11-2026", "31-11-2026"));
  assert.deepEqual([badDay.reason, badDay.missing], ["unreadable", ["date"]]);
  // The page's link names a different train
  const otherTrain = readPnr(pnrPage.replace("/time-table/12786-", "/time-table/12785-").replace("/live-train-status/12786-", "/live-train-status/12785-"));
  assert.ok(otherTrain.conflicts.includes("train"));
  // A cleared booking
  assert.equal(readPnr("<p>FLUSHED PNR / PNR NOT YET GENERATED</p>").reason, "no_booking");
});

test("pnr extraction: an optional field that reads two ways is left out, never guessed", () => {
  const html = pnrPage.replace('<P class="pnr-bold-txt">CNF</P>', '<P class="pnr-bold-txt">CNF</P><p>Sleeper</p>');
  const r = readPnr(html);
  assert.ok(r.data);
  assert.equal(r.data.cls, null);
  assert.deepEqual(r.data.read.dropped, ["cls"]);
  assert.equal(r.data.no, "12786", "the rest still reads");
});

test("pnr: a page that can't be read says so, and the logs name the field, never the PNR", async () => {
  servePnr(pnrPage.replace(/<ul class="pasListUL">[\s\S]*?<\/ul>/, ""));
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    const r = await get("/api/pnr?pnr=1234567890");
    assert.deepEqual([r.status, r.body.error], [502, "pnr_unreadable"]);
  } finally {
    console.warn = warn;
  }
  assert.match(lines.join("\n"), /missing=passengers/);
  assert.ok(!lines.join("\n").includes("1234567890"));
});

test("pnr extraction: every passenger is kept, even with ads between the rows", () => {
  const row = (n, b, c, s) => `<li><span>${n}.</span><p>${b}</p><p>${c}</p><p>${s}</p></li><li class="ad">Order food at the next station</li>`;
  const html = pnrPage.replace(/<ul class="pasListUL">[\s\S]*?<\/ul>/, `<ul>${row(1, "GNWL 45/WL 40", "CNF", "B2/33/LB")}${row(2, "GNWL 46/WL 41", "RAC 7", "")}${row(3, "GNWL 47/WL 42", "WL 12", "")}</ul>`);
  const r = readPnr(html);
  assert.deepEqual(
    r.data.passengers.map((p) => [p.n, p.kind, p.coach, p.berth, p.position]),
    [
      [1, "confirmed", "B2", "33", null],
      [2, "rac", null, null, 7],
      [3, "waitlist", null, null, 12],
    ]
  );
  // "2 minutes late" further down the page is not a second passenger on a solo booking
  assert.equal(readPnr(pnrPage).data.passengers.length, 1);
});

/* ---------- berth type: the page, its seat data, and the coach's standard numbering ---------- */

test("pnr: the berth type comes from the railway's seat data and the standard layout, when they agree", () => {
  // The real page carries seat data in a commented-out link (berth=UB for B3/59)
  const data = (berth, seat = "B3%2F59") => `<!-- <a href="/astros/get-passenger-details?passenger_details%5B%5D%5Bberth%5D=${berth}&amp;passenger_details%5B%5D%5Bcurrent_status_details%5D=${seat}">x</a> -->`;
  const withData = (b, s) => pnrPage.replace("</body>", `${data(b, s)}</body>`);
  const p = (html) => readPnr(html).data.passengers[0];
  assert.deepEqual([p(withData("UB")).berthType, p(withData("UB")).berthFrom], ["Upper", "railway"], "data and layout agree");
  assert.deepEqual([p(pnrPage).berthType, p(pnrPage).berthFrom], ["Upper", "layout"], "59 in a 3A coach is an upper berth");
  assert.equal(p(withData("LB")).berthType, null, "they disagree: shown as neither");
  assert.equal(p(withData("LB", "B4%2F12")).berthType, "Upper", "seat data for another seat is ignored");
  // A class whose numbering isn't standard gives no type from the layout
  assert.equal(p(pnrPage.replace(">AC 3 Tier<", ">AC Chair Car<")).berthType, null);
});

/* ---------- /api/coaches: several sources, cross-checked ---------- */

// Recorded, public answers for 12786 from each source.
const rec = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const SRC = { erail: rec("erail-12786.txt"), confirmtkt: rec("confirmtkt-12786.html"), etrain: rec("etrain-12786.html"), tt: rec("railyatri-tt-12786.json") };
function serveCoaches(over = {}) {
  const body = { ...SRC, ...over };
  const text = (k) => () => (body[k] == null ? new Response("down", { status: 503 }) : new Response(body[k]));
  upstream.set("erail.in/rail/getTrains", text("erail"));
  upstream.set("confirmtkt.com/train-schedule/", text("confirmtkt"));
  upstream.set("etrain.info/train/", text("etrain"));
  upstream.set("railyatri.in/live-train-status/", () => new Response('<script id="__NEXT_DATA__">{"buildId":"TEST"}</script>'));
  upstream.set("/_next/data/", text("tt"));
}

test("coaches: the order two of three sources agree on, naming the one that doesn't", async () => {
  serveCoaches();
  const { status, body } = await get("/api/coaches?no=12786");
  assert.equal(status, 200);
  assert.equal(body.coaches.map((c) => c.id).join(" "), "LPR GN GN H1 A2 A1 B6 B5 B4 B3 B2 B1 S7 S6 S5 S4 S3 S2 S1 GN GN SLRD");
  assert.equal(body.agreement, "majority");
  assert.deepEqual(body.sources.map((s) => [s.name, s.agrees]), [["erail", true], ["confirmtkt", true], ["etrain", false]]);
  assert.equal(body.engineFirst, true, "every source that marks the engine puts it first");
  // etrain's rake is a different one (B5, S8), so its coach details aren't borrowed
  assert.equal(body.coaches.find((c) => c.id === "B3").build, undefined);
  await get("/api/coaches?no=12786");
  assert.equal(calls.filter((u) => u.includes("erail")).length, 1, "kept for a day");
});

test("coaches: both timetables agree at SBC; where platforms differ, both are passed on, not picked", async () => {
  serveCoaches();
  const { body } = await get("/api/coaches?no=12786");
  const sbc = body.stops.find((s) => s.code === "SBC");
  assert.deepEqual([sbc.arr, sbc.dep, sbc.pf], ["17:45", "18:00", "5"]);
  assert.deepEqual(sbc.from, { arr: "both", dep: "both", pf: "both" });
  const kcg = body.stops.find((s) => s.code === "KCG");
  assert.equal(kcg.pf, null);
  assert.deepEqual(kcg.from.pf, { railyatri: "4", confirmtkt: "3" });
  assert.equal(body.stops.some((s) => s.reversal), false, "no reversal is claimed when no source flags one");
});

test("coaches: a list read from the other end is the same rake, and then the engine's end is unknown", async () => {
  // ConfirmTkt's list turned around, and its engine still listed first: the sources now put the
  // engine at opposite ends of the same rake, so no end is claimed.
  const ct = SRC.confirmtkt.replace(/"CoachPosition":"([^"]*)"/, (_, list) => {
    const groups = list.split(":").filter(Boolean);
    const [engine, ...rest] = groups;
    return `"CoachPosition":"${[engine, ...rest.reverse()].join(":")}:"`;
  });
  serveCoaches({ confirmtkt: ct });
  const { body } = await get("/api/coaches?no=12786");
  const c = body.sources.find((s) => s.name === "confirmtkt");
  assert.deepEqual([c.agrees, c.reversed], [true, true]);
  assert.equal(body.directions, "mixed");
  assert.equal(body.engineFirst, null);
});

test("coaches: any one source down, the others still answer; all down, a clear 404", async () => {
  serveCoaches({ erail: null, etrain: null });
  const one = await get("/api/coaches?no=12786");
  assert.equal(one.body.agreement, "single");
  assert.equal(one.body.coaches.find((c) => c.id === "B3").cls, "3A");
  caches.default.store.clear();
  serveCoaches({ erail: null, etrain: null, confirmtkt: null, tt: null });
  assert.deepEqual([(await get("/api/coaches?no=12786")).body.error], ["no_coach_order"]);
});

test("coaches: another train's record, or a coach that doesn't read cleanly, is never used", async () => {
  serveCoaches({ erail: SRC.erail.replace("^12786~", "^12785~"), confirmtkt: null, etrain: null });
  const r = await get("/api/coaches?no=12786");
  assert.equal(r.body.coaches, null, "no order from someone else's record");
  assert.ok(r.body.stops.length > 10, "the timetable still answers");
  caches.default.store.clear();
  serveCoaches({ erail: SRC.erail.replace("B,B3,3A", "B,B3 ;drop,3A"), confirmtkt: null, etrain: null });
  assert.equal((await get("/api/coaches?no=12786")).body.coaches, null);
  assert.deepEqual([(await get("/api/coaches?no=abc")).status], [400]);
});

/* ---------- /api/dayof: today's run at your station ---------- */

// NTES isn't reachable from where these tests were written, so its page here is hand-built in the
// shape the Worker reads, not a recording. ConfirmTkt's running status is a real, public answer.
const NTES_SAMPLE = rec("ntes-sample-12786.html");
const CT_RUN = rec("confirmtkt-run-12786.html");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function serveDayOf({ ntes = "ok", order = null } = {}) {
  const d = istToday();
  const [y, m, dd] = d.split("-");
  let page = NTES_SAMPLE.replaceAll("{DD}", dd).replaceAll("{mon}", MON[+m - 1].toLowerCase()).replaceAll("{Mon}", MON[+m - 1]).replaceAll("{YYYY}", y);
  if (order) page = order(page);
  upstream.set("mntes/GetCSRFToken", () => new Response("<input type='hidden' name='csrfX' value='t0k3n'>"));
  upstream.set("mntes/tr?opt=TrainRunning", () => (ntes === "hang" ? new Promise(() => {}) : ntes === "down" ? Promise.reject(new Error("reset")) : new Response(page)));
  upstream.set("mntes/", () => new Response("<html></html>"));
  upstream.set("confirmtkt.com/train-running-status/", () => new Response(CT_RUN));
  upstream.set("railyatri.in", () => new Response("down", { status: 503 }));
  return d;
}

test("dayof: today's coach order and platform at your station come from the railway's system, each source named", async () => {
  const d = serveDayOf();
  const { status, body } = await get(`/api/dayof?no=12786&date=${d}&at=SBC`);
  assert.equal(status, 200);
  assert.equal(body.coaches.source, "ntes");
  assert.equal(body.coaches.list.map((c) => c.id).join(" "), "LPR GN GN H1 A2 A1 B6 B5 B4 B3 B2 B1 S7 S6 S5 S4 S3 S2 S1 GN GN SLRD");
  assert.deepEqual(body.platform, { ntes: { pf: "6", mark: "*" }, railyatri: null, confirmtkt: "5" }, "each platform with its source, none merged");
  assert.equal(body.delay.confirmtkt, 10);
  assert.deepEqual(body.sources.map((s) => [s.name, s.ok, s.why]).sort(), [["confirmtkt", true, null], ["ntes", true, null], ["railyatri", false, "unreachable"]]);
});

test("dayof: a station NTES has no coach order for gets none, never another station's", async () => {
  const d = serveDayOf();
  const { body } = await get(`/api/dayof?no=12786&date=${d}&at=KGI`);
  assert.equal(body.coaches, null);
  assert.deepEqual(body.platform.ntes, { pf: "2", mark: null });
});

test("dayof: when NTES doesn't answer in time, the rest still do, and it says why", async () => {
  const d = serveDayOf({ ntes: "hang" });
  const t = Date.now();
  const { body } = await get(`/api/dayof?no=12786&date=${d}&at=SBC`, { with: { DAYOF_NTES_MS: "300" } });
  assert.ok(Date.now() - t < 3000, "not held up by the slow source");
  assert.equal(body.coaches, null);
  assert.equal(body.platform.ntes, null);
  assert.equal(body.platform.confirmtkt, "5");
  assert.deepEqual(body.sources.find((s) => s.name === "ntes"), { ...body.sources.find((s) => s.name === "ntes"), ok: false, why: "timed out" });
});

test("dayof: bad input is refused, and runs outside the tracker's window aren't looked up", async () => {
  serveDayOf();
  assert.equal((await get("/api/dayof?no=1278&at=SBC")).status, 400);
  assert.equal((await get("/api/dayof?no=12786&at=S B")).status, 400);
  assert.equal((await get(`/api/dayof?no=12786&at=SBC&date=${addDays(istToday(), 5)}`)).status, 400);
});
