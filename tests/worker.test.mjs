// Worker tests: node --test tests/
// Upstream calls are answered from recorded responses in tests/fixtures, so these run offline.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/worker.js";

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
    return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
  }
  async put(req, res) {
    this.store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers) });
  }
}

let upstream; // url => Response factory
let calls;
let pending;
const ctx = { waitUntil: (p) => pending.push(p) };

beforeEach(() => {
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

async function get(path, { origin = ORIGIN } = {}) {
  const res = await worker.fetch(new Request(`https://journey-api.example${path}`, { headers: origin ? { Origin: origin } : {} }), env, ctx);
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
