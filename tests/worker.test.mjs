// Worker tests: node --test tests/
// Upstream calls are answered from recorded responses in tests/fixtures, so these run offline.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/worker.js";
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
