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

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const SITE = process.env.SITE || "http://localhost:8765/";
const API = "https://journey-api.8parthaggarwal1999.workers.dev";
const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const FIXTURES = { "NDLS-HWH": "between-ndls-hwh.json", "KCG-AP": "between-kcg-ap.json", "MYS-KCG": "between-mys-kcg.json" };

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
const upstream = async (url) => {
  const u = new URL(url);
  const key = `${u.searchParams.get("from")}-${u.searchParams.get("to")}`;
  if (key.startsWith("PURI")) return new Response("down", { status: 503 });
  const body = FIXTURES[key] ? fixture(FIXTURES[key]) : { success: true, train_between_stations: [], alternate_trains: [] };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

async function callWorker(url, origin) {
  const real = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    return await worker.fetch(new Request(url, { headers: { Origin: origin } }), { ALLOWED_ORIGINS: origin }, { waitUntil() {} });
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
async function page({ width = 390, height = 844, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light" });
  const origin = new URL(SITE).origin;
  await ctx.route(`${API}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes("/api/train") || url.includes("/api/weather"))
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found", message: "Not in this test." }) });
    const res = await callWorker(url, origin);
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
  // flights have no route finder
  await p.goto(`${SITE}?m=flight`);
  await settle(p);
  assert.equal(await p.locator("#by-toggle").isHidden(), true);
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
  assert.match(await p.locator(".train-list .fold-btn").textContent(), /3 earlier trains, before 16:00/);
  await p.locator(".train-list .fold-btn").click();
  await settle(p);
  assert.equal(await p.locator(".train-list .tcard").count(), 7);
  assert.ok((await p.locator(".chip", { hasText: "To Sealdah" }).count()) > 0, "nearby destination noted");
  assert.ok((await p.locator(".chip", { hasText: "From Delhi Jn" }).count()) > 0, "nearby origin noted");
  assert.equal(await p.locator(".ocard").count(), 3, "trains not running that day: first 3");
  await p.locator(".fold-btn.quiet").click();
  await settle(p);
  assert.equal(await p.locator(".ocard").count(), 7, "then all of them");
  assert.deepEqual(p.errors, []);
});

await test("tapping a train opens its live status for the right run, and Back returns to the list", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&from=KCG&to=AP&d=${istToday()}`);
  await settle(p, 900);
  await p.evaluate(() => window.scrollTo(0, 400));
  const card = p.locator("a.tcard", { hasText: "12976" });
  assert.match(await card.getAttribute("href"), new RegExp(`no=12976&d=${addDays(istToday(), -2)}&s=MYS`));
  await card.click();
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
  assert.equal(await p.locator("a.tcard").count(), 0);
  assert.match(await p.locator(".tcard.muted .tc-later").first().textContent(), /Live from/);
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

await browser.close();
const failed = results.filter(([s]) => s !== "ok").length;
console.log(`\n# pass ${results.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
