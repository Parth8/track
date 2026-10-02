// Browser tests for the route finder.
//
//   python3 -m http.server 8765        (from the repo root, in another terminal)
//   node tests/finder.e2e.mjs
//
// Needs Playwright (npm i -g playwright, or set NODE_PATH to where it's installed).
// API calls run through the real Worker code with recorded upstream answers, so results are stable.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import worker from "../worker/worker.js";
import { fidsAnswer, MemoryKV } from "./fids.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const SITE = process.env.SITE || "http://localhost:8765/";
const API = "https://journey-api.8parthaggarwal1999.workers.dev";
const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const FIXTURES = { "NDLS-HWH": "between-ndls-hwh.json", "KCG-AP": "between-kcg-ap.json", "MYS-KCG": "between-mys-kcg.json", "KCG-SBC": "between-kcg-sbc.json" };

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Workers runtime stand-ins
const store = new Map();
globalThis.caches = {
  default: {
    match: async (r) => (store.has(r.url) ? new Response(store.get(r.url).b, { headers: store.get(r.url).h }) : undefined),
    put: async (r, res) => store.set(r.url, { b: await res.text(), h: Object.fromEntries(res.headers) }),
  },
};
const SEAT_FIXTURES = { "2A": "seats-12306-2a.json", "3A": "seats-12306-3a.json", "1A": "seats-12627-3a.json" };
let seatCalls = 0;
// Seat answers are recorded ones, moved to the asked-for date (then weekly) so they always line up.
function seatAnswer(u) {
  seatCalls++;
  const [, , , , , date, , , cls] = u.pathname.split("/");
  if (!SEAT_FIXTURES[cls]) return { success: true, error: "Class does not exist in this train for this Train route", seat_availibility: [] };
  const body = fixture(SEAT_FIXTURES[cls]);
  body.seat_availibility.forEach((row, k) => {
    const [y, m, d] = addDays(date, k * 7).split("-");
    row.availablity_date = `${+d}-${+m}-${y}`;
  });
  return body;
}
const upstream = async (url) => {
  const u = new URL(url);
  if (u.hostname.includes("aerodatabox")) return fidsAnswer(url) || new Response(null, { status: 204 });
  if (u.hostname === "sa.railyatri.in") return new Response(JSON.stringify(seatAnswer(u)), { headers: { "Content-Type": "application/json" } });
  const key = `${u.searchParams.get("from")}-${u.searchParams.get("to")}`;
  if (key.startsWith("PURI")) return new Response("down", { status: 503 });
  const body = FIXTURES[key] ? fixture(FIXTURES[key]) : { success: true, train_between_stations: [], alternate_trains: [] };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

// Flight search is switched on (key + KV store) unless a test says otherwise.
const QUOTA = new MemoryKV();
async function callWorker(url, origin, env = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    return await worker.fetch(new Request(url, { headers: { Origin: origin } }), { ALLOWED_ORIGINS: origin, ADB_KEY: "test", QUOTA, ...env }, { waitUntil() {} });
  } finally {
    globalThis.fetch = real;
  }
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(["ok", name]);
    console.log(`ok - ${name}`);
  } catch (err) {
    results.push(["not ok", name]);
    console.log(`not ok - ${name}\n  ${String(err.stack || err).split("\n").slice(0, 4).join("\n  ")}`);
  }
}

const browser = await chromium.launch();
async function page({ width = 390, height = 844, dark = false, locale = "en-IN", env = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light", locale });
  const origin = new URL(SITE).origin;
  await ctx.route(`${API}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes("/api/train") || url.includes("/api/weather"))
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found", message: "Not in this test." }) });
    const res = await callWorker(url, origin, env);
    route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
  });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  return p;
}
const settle = (p, ms = 350) => p.waitForTimeout(ms);
// The station list loads the first time a station field is used.
async function focusStations(p, field = "#st-from") {
  await p.locator(field).waitFor({ state: "visible" });
  await p.locator(field).focus();
  await p.waitForSelector(`${field}-list .st-opt`);
}
const params = (p) => Object.fromEntries(new URL(p.url()).searchParams);
async function pick(p, field, text) {
  await p.locator(field).fill(text);
  await settle(p);
  await p.keyboard.press("Enter");
  await settle(p);
}

/* ------------------------------------------------------------------ */

await test("the toggle switches to From and to, and back, keeping the URL in step", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train`);
  await settle(p);
  assert.equal(await p.locator("#panel-route").isHidden(), true);
  await p.locator('#by-toggle [data-by="route"]').click();
  await settle(p, 500);
  assert.equal(params(p).by, "route");
  assert.equal(await p.locator("#panel-route").isVisible(), true);
  assert.equal(await p.locator("#panel-number").isHidden(), true);
  assert.equal(await p.locator("#cta-text").textContent(), "Find trains");
  // arrow keys move between the two options, like any radio group
  await p.locator('#by-toggle [data-by="route"]').focus();
  await p.keyboard.press("ArrowLeft");
  await settle(p, 500);
  assert.equal(params(p).by, undefined);
  assert.equal(await p.locator("#panel-number").isVisible(), true);
  // flights get the same choice, named for flights
  await p.goto(`${SITE}?m=flight`);
  await settle(p);
  assert.equal(await p.locator("#by-toggle").isVisible(), true);
  assert.equal(await p.locator("#by-toggle").getAttribute("aria-label"), "Find your flight by");
  await p.locator('#by-toggle [data-by="route"]').click();
  await settle(p, 500);
  assert.deepEqual([params(p).m, params(p).by], ["flight", "route"]);
  assert.equal(await p.locator("#cta-text").textContent(), "Find flights");
  assert.deepEqual(p.errors, []);
});

await test("an empty station field offers popular stations", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await focusStations(p);
  const names = await p.locator("#st-from-list .st-opt .st-code").allTextContents();
  assert.ok(names.includes("NDLS") && names.includes("HWH"), names.join(","));
  assert.equal(await p.locator("#st-from").getAttribute("aria-expanded"), "true");
});

await test("search finds stations by code, name, older name and nickname", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await focusStations(p);
  const top = async (q) => {
    await p.locator("#st-from").fill(q);
    await settle(p, 200);
    return p.locator("#st-from-list .st-opt .st-code").first().textContent();
  };
  assert.equal(await top("ndls"), "NDLS");
  assert.equal(await top("new del"), "NDLS");
  assert.equal(await top("mys"), "MYS");
  assert.equal(await top("mysore"), "MYS", "older name");
  assert.match(await p.locator("#st-from-list .st-sub").first().textContent(), /Also known as Mysore/);
  assert.equal(await top("allahabad"), "PRYJ", "older name");
  assert.ok(["CSMT", "MMCT"].includes(await top("bombay")), "nickname");
  assert.equal(await top("puri"), "PURI", "name equal to its code");
  await p.locator("#st-from").fill("zzzzq");
  await settle(p, 200);
  assert.match(await p.locator("#st-from-list .st-empty").textContent(), /No station matches/);
});

await test("keyboard: arrows and Enter pick a station, then focus moves to To", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await focusStations(p);
  await p.keyboard.type("kach");
  await settle(p, 200);
  await p.keyboard.press("ArrowDown"); // first is already active, so this moves to the second
  await p.keyboard.press("ArrowUp");
  const active = await p.locator("#st-from").getAttribute("aria-activedescendant");
  assert.ok(active, "an option is active");
  await p.keyboard.press("Enter");
  await settle(p);
  assert.equal(await p.locator("#st-from").inputValue(), "Kacheguda");
  assert.equal(await p.locator("#st-from-code").textContent(), "KCG");
  assert.equal(await p.evaluate(() => document.activeElement.id), "st-to");
  await p.keyboard.press("Escape");
  assert.equal(await p.locator("#st-to-list").isHidden(), true);
});

await test("tapping a suggestion picks it", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await focusStations(p);
  await p.locator("#st-from").fill("howrah");
  await settle(p, 200);
  await p.locator("#st-from-list .st-opt", { hasText: "Howrah Jn" }).tap();
  await settle(p);
  assert.equal(await p.locator("#st-from-code").textContent(), "HWH");
  assert.equal(await p.locator("#st-from-list").isHidden(), true);
});

await test("typing an exact code and leaving the field picks it", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await focusStations(p);
  await p.locator("#st-from").fill("sbc");
  await p.locator(".fieldset-legend").click(); // blur
  await settle(p);
  assert.equal(await p.locator("#st-from-code").textContent(), "SBC");
});

await test("swap trades From and To", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route&from=NDLS&to=HWH`);
  await settle(p, 700);
  await p.locator("#jf-swap").click();
  await settle(p);
  assert.equal(await p.locator("#st-from-code").textContent(), "HWH");
  assert.equal(await p.locator("#st-to-code").textContent(), "NDLS");
});

await test("the form explains what's missing", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await settle(p, 600);
  await p.locator("#search-form .cta").click();
  assert.match(await p.locator("#route-error").textContent(), /leaving from/);
  assert.equal(await p.locator("#st-from").getAttribute("aria-invalid"), "true");
  await p.locator("#st-from").fill("qqq");
  await p.locator("#search-form .cta").click();
  assert.match(await p.locator("#route-error").textContent(), /Pick “qqq” from the list/);
  await pick(p, "#st-from", "ndls");
  await p.locator("#st-to").fill("ndls");
  await p.locator("#search-form .cta").click();
  await settle(p);
  assert.match(await p.locator("#route-error").textContent(), /same station/);
  assert.equal(params(p).from, undefined, "didn't navigate");
});

await test("a search lists trains, notes nearby stations, and folds trains before the chosen time", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&by=route`);
  await focusStations(p);
  await pick(p, "#st-from", "ndls");
  await pick(p, "#st-to", "hwh");
  await p.locator("#t-after").fill("16:00");
  await p.locator("#search-form .cta").click();
  await settle(p, 900);
  const q = params(p);
  assert.deepEqual([q.m, q.from, q.to, q.t], ["train", "NDLS", "HWH", "16:00"]);
  assert.equal(q.d, istToday());
  assert.match(await p.locator("#results-title").textContent(), /NDLS to HWH/);
  const shown = await p.locator(".train-list .tcard").count();
  assert.equal(shown, 4, "4 leave at or after 16:00");
  assert.match(await p.locator(".train-list .fold-btn").textContent(), /3 earlier trains, before 4:00 PM/);
  await p.locator(".train-list .fold-btn").click();
  await settle(p);
  assert.equal(await p.locator(".train-list .tcard").count(), 7);
  assert.ok((await p.locator(".tc-near", { hasText: "Ends at" }).count()) > 0, "nearby destination noted");
  assert.ok((await p.locator(".tc-near", { hasText: "Leaves from Delhi Jn" }).count()) > 0, "nearby origin noted");
  assert.equal(await p.locator(".ocard").count(), 3, "trains not running that day: first 3");
  await p.locator(".fold-btn.quiet").click();
  await settle(p);
  assert.equal(await p.locator(".ocard").count(), 7, "then all of them");
  assert.deepEqual(p.errors, []);
});

await test("trains to a nearby station sit in their own section and say where they really end", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=KCG&to=SBC&d=${addDays(istToday(), 3)}`);
  await settle(p, 900);
  const lists = p.locator(".train-list");
  const exact = await lists.nth(0).locator("li[data-no]").evaluateAll((els) => els.map((e) => e.dataset.no));
  assert.deepEqual(exact.sort(), ["12785", "12976"], "only trains from KCG to SBC itself come first");
  assert.match(await p.locator(".section-title", { hasText: "nearby" }).textContent(), /Using nearby stations/);
  const vb = p.locator('li[data-no="20703"]');
  assert.equal(await vb.count(), 1);
  assert.match(await vb.locator(".tc-near").textContent(), /Ends at Yesvantpur Jn, 5 km from KSR Bengaluru/);
  assert.equal(await vb.locator(".tc-codes .near").textContent(), "YPR");
  assert.deepEqual(p.errors, []);
});

await test("tapping a train opens its live status for the right run, and Back returns to the list", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=KCG&to=AP&d=${istToday()}`);
  await settle(p, 900);
  await p.evaluate(() => window.scrollTo(0, 400));
  const card = p.locator(".tcard.linked", { hasText: "12976" });
  assert.match(await card.locator(".tc-link").getAttribute("href"), new RegExp(`no=12976&d=${addDays(istToday(), -2)}&s=MYS`));
  const box = await card.locator(".tc-foot").boundingBox();
  assert.ok(box.y > 0 && box.y < 800, "card's foot is on screen");
  await p.mouse.click(box.x + 20, box.y + box.height / 2); // anywhere on the card opens it
  await settle(p, 600);
  const q = params(p);
  assert.deepEqual([q.no, q.d, q.s], ["12976", addDays(istToday(), -2), "MYS"]);
  await p.locator("#status-back").click();
  await settle(p, 600);
  assert.equal(params(p).from, "KCG");
  assert.equal(await p.locator("#view-results").isVisible(), true);
  assert.ok((await p.evaluate(() => window.scrollY)) > 100, "scroll position kept");
});

await test("trains whose run hasn't started can't be tracked yet, and say when they can", async () => {
  const p = await page();
  const d = addDays(istToday(), 5);
  await p.goto(`${SITE}?m=train&from=MYS&to=KCG&d=${d}`);
  await settle(p, 900);
  assert.equal(await p.locator(".tcard.linked").count(), 0);
  assert.equal(await p.locator(".tcard.muted").count(), 0, "future runs aren't greyed out: their seats can be checked");
  assert.match(await p.locator(".tcard .tc-later").first().textContent(), /Live from/);
});

await test("day arrows step the date; the return button flips the journey", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=MYS&to=KCG&d=${istToday()}`);
  await settle(p, 900);
  await p.locator(".day-step.next").click();
  await settle(p, 700);
  assert.equal(params(p).d, addDays(istToday(), 1));
  await p.locator("#results-swap").click();
  await settle(p, 700);
  assert.deepEqual([params(p).from, params(p).to], ["KCG", "MYS"]);
});

await test("no direct trains and service problems both get a clear screen", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=MYS&to=GHY&d=${istToday()}`);
  await settle(p, 900);
  assert.match(await p.locator(".empty h2").textContent(), /No direct trains/);
  await p.locator(".empty .cta").click();
  await settle(p, 500);
  assert.equal(params(p).by, "route");
  assert.equal(await p.locator("#st-from-code").textContent(), "MYS");
  await p.goto(`${SITE}?m=train&from=PURI&to=HWH&d=${istToday()}`);
  await settle(p, 2500);
  assert.match(await p.locator(".empty h2").textContent(), /taking a moment/);
  assert.equal(await p.locator(".actions .cta").first().textContent(), "Try again");
});

await test("train number search still works as before", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train`);
  await settle(p);
  await p.locator("#q").fill("12786");
  await p.locator("#search-form .cta").click();
  await settle(p, 500);
  assert.equal(params(p).no, "12786");
});

await test("fits a 320px phone in dark mode without sideways scrolling", async () => {
  const p = await page({ width: 320, height: 640, dark: true });
  for (const url of [`${SITE}?m=train&by=route&from=NDLS&to=HWH`, `${SITE}?m=train&from=NDLS&to=HWH&d=${istToday()}`]) {
    await p.goto(url);
    await settle(p, 900);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${url} overflows by ${overflow}px`);
  }
  assert.deepEqual(p.errors, []);
});

await test("day arrows keep keyboard focus as the list redraws", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=MYS&to=KCG&d=${istToday()}`);
  await settle(p, 900);
  await p.locator(".day-step.next").focus();
  await p.keyboard.press("Enter");
  await settle(p, 800);
  assert.equal(params(p).d, addDays(istToday(), 1));
  assert.equal(await p.evaluate(() => document.activeElement.classList.contains("next")), true);
  await p.keyboard.press("Enter");
  await settle(p, 800);
  assert.equal(params(p).d, addDays(istToday(), 2));
});

await test("before the Worker is updated, the page says the feature is almost ready", async () => {
  const p = await page();
  await p.context().route(`${API}/api/between**`, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found", message: "Unknown route." }) })
  );
  await p.goto(`${SITE}?m=train&from=MYS&to=KCG&d=${istToday()}`);
  await settle(p, 900);
  assert.match(await p.locator(".empty h2").textContent(), /almost ready/);
  await p.locator(".actions .cta").click();
  await settle(p, 500);
  assert.deepEqual(params(p), { m: "train" });
});

await test("seat buttons show live availability, fare, confirmation chance and the next runs", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${addDays(istToday(), 5)}`);
  await settle(p, 900);
  const card = p.locator('.train-list li[data-no="12314"]');
  assert.deepEqual(await card.locator(".seat-cls").allTextContents(), ["3A", "2A", "1A"]);
  await card.locator('.seat-cls[data-cls="2A"]').click();
  await p.locator('li[data-no="12314"] .seat-now').waitFor();
  const c = p.locator('li[data-no="12314"]');
  assert.equal(await c.locator('.seat-cls[data-cls="2A"]').getAttribute("aria-expanded"), "true");
  assert.match(await c.locator(".seat-now strong").first().textContent(), /Waitlist 29/);
  assert.match(await c.locator(".seat-fare").textContent(), /₹4,390/);
  assert.match(await c.locator(".seat-chance").textContent(), /38% chance to confirm/);
  assert.equal(await c.locator(".seat-next li").count(), 3);
  assert.match(await c.locator(".seat-src").textContent(), /IRCTC, checked/);
  // Another class on the same train
  await c.locator('.seat-cls[data-cls="3A"]').click();
  await p.locator('li[data-no="12314"] .seat-now.rac').waitFor();
  assert.match(await p.locator('li[data-no="12314"] .seat-next li').first().textContent(), /Avl 48/);
  // Tapping the open class closes it
  await p.locator('li[data-no="12314"] .seat-cls[data-cls="3A"]').click();
  assert.equal(await p.locator('li[data-no="12314"] .seat-panel').isHidden(), true);
  assert.deepEqual(p.errors, []);
});

await test("seats: one train open at a time, clear messages, cached repeats, focus kept", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${addDays(istToday(), 4)}`);
  await settle(p, 900);
  const before = seatCalls;
  await p.locator('li[data-no="12314"] .seat-cls[data-cls="2A"]').click();
  await p.locator('li[data-no="12314"] .seat-now').waitFor();
  assert.equal(await p.evaluate(() => document.activeElement?.dataset.cls), "2A", "focus stays on the class button");
  // Opening a class on another train closes the first
  await p.locator('li[data-no="12324"] .seat-cls[data-cls="SL"]').click();
  await p.locator('li[data-no="12324"] .seat-error').waitFor();
  assert.match(await p.locator('li[data-no="12324"] .seat-error').textContent(), /Sleeper isn't on this train/);
  assert.equal(await p.locator('li[data-no="12314"] .seat-panel').isHidden(), true);
  // Back to the first: answered from memory, no new lookup
  await p.locator('li[data-no="12314"] .seat-cls[data-cls="2A"]').click();
  await p.locator('li[data-no="12314"] .seat-now').waitFor();
  assert.equal(seatCalls - before, 2);
  // Seats sit above the card's link: tapping them never opens live status
  const hit = await p.evaluate(() => {
    const b = document.querySelector('li[data-no="12314"] .seat-cls');
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
  });
  assert.ok(hit, "seat button is on top");
  assert.deepEqual(p.errors, []);
});

await test("Tatkal is offered for tomorrow only; past days have no seat buttons", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${addDays(istToday(), 1)}`);
  await settle(p, 900);
  await p.locator('li[data-no="12314"] .seat-cls[data-cls="3A"]').click();
  await p.locator('li[data-no="12314"] .seat-quota').waitFor();
  await p.locator('li[data-no="12314"] .seat-quota [data-q="TQ"]').click();
  await p.locator('li[data-no="12314"] .seat-now').waitFor();
  assert.equal(await p.locator('li[data-no="12314"] .seat-quota [data-q="TQ"]').getAttribute("aria-checked"), "true");
  assert.match(await p.locator('li[data-no="12314"] .seat-what span').textContent(), /Tatkal/);
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${addDays(istToday(), 6)}`);
  await settle(p, 900);
  await p.locator('li[data-no="12314"] .seat-cls[data-cls="3A"]').click();
  await p.locator('li[data-no="12314"] .seat-now').waitFor();
  assert.equal(await p.locator(".seat-quota").count(), 0);
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${addDays(istToday(), -1)}`);
  await settle(p, 900);
  assert.equal(await p.locator(".seat-cls").count(), 0);
  assert.deepEqual(p.errors, []);
});

await test("flights: From and to finds airports by city, code and older name", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=flight&by=route`);
  await p.locator("#panel-route").waitFor();
  assert.equal(await p.locator("#by-number-label").textContent(), "Flight number");
  assert.equal(await p.locator("#st-from").getAttribute("placeholder"), "City, airport or code");
  await p.locator("#st-from").focus();
  await p.locator("#st-from-list .st-opt").first().waitFor();
  assert.match(await p.locator("#st-from-list .st-head").textContent(), /Popular airports/);
  const first = async (q) => {
    await p.locator("#st-from").fill(q);
    await p.waitForTimeout(120);
    return p.locator("#st-from-list .st-opt .st-code").first().textContent();
  };
  assert.equal(await first("bombay"), "BOM");
  assert.equal(await first("hyd"), "HYD");
  assert.equal(await first("madras"), "MAA");
  assert.equal(await first("dubai"), "DXB");
  assert.equal(await first("london"), "LHR");
  await p.locator("#st-from").fill("goa");
  await p.waitForTimeout(120);
  const goa = await p.locator("#st-from-list .st-opt .st-code").allTextContents();
  assert.ok(goa.includes("GOI") && goa.includes("GOX"), "both Goa airports");
  assert.deepEqual(p.errors, []);
});

await test("flights: a search lists direct flights with local times, +1, delays and cancellations, and opens tracking", async () => {
  const p = await page();
  const d = addDays(istToday(), 2);
  await p.goto(`${SITE}?m=flight&by=route`);
  await p.locator("#panel-route").waitFor();
  await p.locator("#st-from").focus();
  await p.locator("#st-from-list .st-opt").first().waitFor();
  await pick(p, "#st-from", "delhi");
  await pick(p, "#st-to", "bangalore");
  await p.goto(`${SITE}?m=flight&from=DEL&to=BLR&d=${d}`);
  await settle(p, 900);
  assert.match(await p.locator("#results-title").textContent(), /DEL to BLR/);
  assert.equal(await p.locator(".train-list .fcard").count(), 11);
  const late = p.locator('li[data-no="QP1381"]');
  assert.match(await late.locator(".chip").first().textContent(), /Delayed 45m/);
  assert.match(await late.locator(".fc-now").textContent(), /Now leaves 9:05 AM/);
  assert.match(await p.locator('li[data-no="6E6352"] .chip').first().textContent(), /Cancelled/);
  const overnight = p.locator('li[data-no="6E6814"]');
  assert.equal(await overnight.locator(".tc-t .plus").textContent(), "+1");
  assert.match(await overnight.locator(".tc-link").getAttribute("aria-label"), /2:25 AM the next day/);
  assert.equal(await p.locator('li[data-no="VS8110"]').count(), 0, "no codeshare row");
  await overnight.locator(".tc-link").focus();
  await p.keyboard.press("Enter");
  await settle(p, 600);
  const q = params(p);
  assert.deepEqual([q.m, q.no, q.d], ["flight", "6E6814", d]);
  await p.locator("#status-back").click();
  await settle(p, 700);
  assert.equal(params(p).from, "DEL");
  assert.equal(await p.locator(".train-list .fcard").count(), 11);
  assert.deepEqual(p.errors, []);
});

await test("flights: leaving after 5 PM folds earlier flights; Dubai arrivals show Dubai time", async () => {
  const p = await page();
  const d = addDays(istToday(), 3);
  await p.goto(`${SITE}?m=flight&from=DEL&to=BLR&d=${d}&t=17:00`);
  await settle(p, 900);
  assert.equal(await p.locator(".train-list .fcard").count(), 4);
  assert.match(await p.locator(".train-list .fold-btn").textContent(), /2 earlier flights, before 5:00 PM/);
  await p.goto(`${SITE}?m=flight&from=DEL&to=DXB&d=${d}`);
  await settle(p, 900);
  const ek = p.locator('li[data-no="EK511"]');
  assert.deepEqual(await ek.locator(".tc-t").allTextContents(), ["4:25 AM", "6:35 AM"]);
  assert.match(await p.locator(".legend-note").textContent(), /Local times at each airport/);
  assert.deepEqual(p.errors, []);
});

await test("flights: before the KV store is set up, the page says search is almost ready", async () => {
  const p = await page({ env: { QUOTA: undefined } });
  await p.goto(`${SITE}?m=flight&from=DEL&to=BLR&d=${addDays(istToday(), 1)}`);
  await settle(p, 900);
  assert.match(await p.locator(".empty h2").textContent(), /almost ready/);
  await p.locator(".actions .cta").click();
  await settle(p, 500);
  assert.deepEqual(params(p), { m: "flight" });
});

await test("trains and flights share the results screen without mixing", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${istToday()}`);
  await settle(p, 900);
  await p.goto(`${SITE}?m=flight&from=DEL&to=BLR&d=${addDays(istToday(), 2)}`);
  await settle(p, 900);
  assert.equal(await p.locator(".tcard:not(.fcard)").count(), 0);
  await p.goBack();
  await settle(p, 900);
  assert.equal(await p.locator(".fcard").count(), 0);
  assert.ok((await p.locator(".tcard").count()) > 0);
  assert.deepEqual(p.errors, []);
});

await test("the clock setting switches every time between 12- and 24-hour, and is remembered", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${istToday()}&t=16:00`);
  await settle(p, 900);
  const first = p.locator(".train-list .tcard").first();
  assert.match(await first.locator(".tc-t").first().textContent(), /^\d{1,2}:\d{2} (AM|PM)$/);
  assert.ok((await first.locator(".tc-t .plus").count()) === 1, "overnight arrival shows +1");
  assert.match(await p.locator(".rc-when span").textContent(), /Leaving after 4:00 PM/);
  // Settings live in the menu at the top right of home and search
  await p.goto(`${SITE}?m=train`);
  await p.locator("#view-search .menu-btn").click();
  await settle(p, 400);
  assert.equal(await p.locator("#view-search .menu-btn").getAttribute("aria-expanded"), "true");
  assert.equal(await p.locator("#sources #clock-seg").count(), 0, "not in Sources and credits");
  await p.locator('#clock-seg [data-clock="24"]').click();
  await p.keyboard.press("Escape");
  await settle(p, 300);
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("menu-btn")), true, "focus returns to the menu button");
  await p.goBack();
  await settle(p, 900);
  assert.equal(await p.locator('#clock-seg [data-clock="24"]').getAttribute("aria-checked"), "true");
  assert.match(await first.locator(".tc-t").first().textContent(), /^\d{2}:\d{2}$/);
  assert.match(await p.locator(".rc-when span").textContent(), /Leaving after 16:00/);
  await p.reload();
  await settle(p, 900);
  assert.match(await p.locator(".train-list .tc-t").first().textContent(), /^\d{2}:\d{2}$/, "remembered after reload");
  assert.deepEqual(p.errors, []);
});

await test("with no choice yet, the clock follows the device", async () => {
  const p = await page({ locale: "en-GB" });
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${istToday()}`);
  await settle(p, 900);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.clock), "24");
  const q = await page({ locale: "en-US" });
  await q.goto(`${SITE}?m=train`);
  assert.equal(await q.evaluate(() => document.documentElement.dataset.clock), "12");
});

await browser.close();
const failed = results.filter(([s]) => s !== "ok").length;
console.log(`\n# pass ${results.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
