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
import { fidsAnswer, flightAnswer, MemoryKV } from "./fids.mjs";

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
  if (u.hostname.includes("aerodatabox")) return fidsAnswer(url) || flightAnswer(url) || new Response(null, { status: 204 });
  if (u.hostname === "sa.railyatri.in") return new Response(JSON.stringify(seatAnswer(u)), { headers: { "Content-Type": "application/json" } });
  // Recorded answers for 12786 from every source the coach guide reads
  if (u.hostname === "www.railyatri.in" && u.pathname.startsWith("/live-train-status/")) return new Response('<script id="__NEXT_DATA__">{"buildId":"TEST"}</script>');
  if (u.hostname === "www.railyatri.in" && u.pathname.startsWith("/_next/data/")) return new Response(rec("railyatri-tt-12786.json"));
  if (u.hostname === "www.railyatri.in") return pnrAnswer(u);
  if (u.hostname === "erail.in") return new Response(rec("erail-12786.txt"));
  if (u.hostname === "www.confirmtkt.com") return new Response(rec("confirmtkt-12786.html"));
  if (u.hostname === "etrain.info") return new Response(rec("etrain-12786.html"));
  const key = `${u.searchParams.get("from")}-${u.searchParams.get("to")}`;
  if (key.startsWith("PURI")) return new Response("down", { status: 503 });
  const body = FIXTURES[key] ? fixture(FIXTURES[key]) : { success: true, train_between_stations: [], alternate_trains: [] };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

// PNR 1234567890 is a recorded booking (12786 SBC → KCG, 3A, one passenger in B3/59), moved to
// 3 days from now; PNR 1234567891 is the same booking with two passengers, one still waitlisted.
const PNR_PAGE = readFileSync(new URL("./fixtures/pnr-sbc-kcg.html", import.meta.url), "utf8");
const rec = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const PNR_PENDING = readFileSync(new URL("./fixtures/pnr-pending.html", import.meta.url), "utf8");
function pnrAnswer(u) {
  const pnr = u.pathname.split("/").pop();
  const known = pnr.startsWith("123456789");
  if (u.pathname.startsWith("/get-status/")) return new Response(JSON.stringify({ status: known }), { headers: { "Content-Type": "application/json" } });
  if (!known) return new Response(PNR_PENDING, { headers: { "Content-Type": "text/html" } }); // RailYatri's "please wait" page
  const [y, m, d] = addDays(istToday(), 3).split("-");
  let html = PNR_PAGE.replace("14-11-2026", `${d}-${m}-${y}`).replaceAll("1234567890", pnr); // the page shows the PNR asked for
  if (pnr === "1234567891") {
    const li = (n, b, c, s) => `<li class="PNRPasList"><span class="paxListCount">${n}.</span><div><p class="statusType">${b}</p></div><div><p class="statusType">${c}</p></div><div><p class="statusType">${s}</p></div></li>`;
    html = html.replace(/<ul class="pasListUL">[\s\S]*?<\/ul>/, `<ul class="pasListUL">${li(1, "Confirmed", "Confirmed", "B3/59")}${li(2, "GNWL 12/WL 8", "WL 4", "")}</ul>`);
  }
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// Flight search is switched on (key + KV store) unless a test says otherwise.
const QUOTA = new MemoryKV();
async function callWorker(url, origin, env = {}, ip = "10.0.0.1") {
  const real = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    // each test page calls from its own address, so the Worker's rate limit never trips across tests
    return await worker.fetch(new Request(url, { headers: { Origin: origin, "CF-Connecting-IP": ip } }), { ALLOWED_ORIGINS: origin, ADB_KEY: "test", QUOTA, ...env }, { waitUntil() {} });
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
    console.log(`not ok - ${name}\n  ${String(err.stack || err).split("\n").slice(0, 9).join("\n  ")}`);
  }
}

const browser = await chromium.launch();
let pages = 0;
async function page({ width = 390, height = 844, dark = false, locale = "en-IN", env = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light", locale });
  const origin = new URL(SITE).origin;
  const ip = `10.1.${Math.floor(++pages / 250)}.${pages % 250}`;
  await ctx.route(`${API}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes("/api/train") || url.includes("/api/weather") || (url.includes("/api/flight?") && !env.flightStatus))
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found", message: "Not in this test." }) });
    const { flightStatus, ...workerEnv } = env;
    const res = await callWorker(url, origin, workerEnv, ip);
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
  await p.mouse.click(box.x + box.width - 40, box.y + box.height / 2); // anywhere on the card (but Save) opens it
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

await test("the live island appears once the status card scrolls away, and taps back to the top", async () => {
  const p = await page({ env: { flightStatus: true } });
  await p.goto(`${SITE}?m=flight&no=6E2131&d=${addDays(istToday(), 2)}`);
  await p.locator(".phase-banner").waitFor();
  await settle(p, 600);
  const island = p.locator(".island");
  assert.equal(await island.getAttribute("aria-hidden"), "true", "hidden while the status card is in view");
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle(p, 800);
  assert.equal(await island.getAttribute("aria-hidden"), "false");
  assert.match(await island.locator(".isl-top").textContent(), /6E 2131 · DEL → BLR/);
  assert.match(await island.locator(".isl-main").textContent(), /Departs in \d+d \d+h/);
  assert.match(await island.locator(".isl-detail").textContent(), /Gate 42B.*Terminal 1/);
  assert.equal(await island.locator(".isl-glyph svg").count(), 1, "plane icon");
  assert.match(await island.locator(".isl-open").getAttribute("aria-label"), /Flight 6E 2131 from Delhi to Bengaluru/);
  await island.locator(".isl-open").click();
  await p.waitForFunction(() => window.scrollY < 40);
  await settle(p, 500);
  assert.equal(await island.getAttribute("aria-hidden"), "true", "hides again at the top");
  await p.locator("#status-back").click();
  await settle(p, 500);
  assert.equal(await p.locator(".island.show").count(), 0, "gone when leaving the status screen");
  assert.deepEqual(p.errors, []);
});

await test("pinning keeps the island on every screen, after a reload, and it opens the journey", async () => {
  const p = await page({ env: { flightStatus: true } });
  const d = addDays(istToday(), 2);
  await p.goto(`${SITE}?m=flight&no=AI2803&d=${d}`);
  await p.locator(".phase-banner").waitFor();
  await settle(p, 500);
  await p.locator("#status-pin").click();
  assert.equal(await p.locator("#status-pin").getAttribute("aria-pressed"), "true");
  assert.match(await p.locator("#toast").textContent(), /Pinned/);
  // Elsewhere in the app, it stays on top and the page makes room for it
  await p.goto(`${SITE}?m=train`);
  await settle(p, 900);
  const island = p.locator(".island");
  assert.equal(await island.getAttribute("aria-hidden"), "false");
  assert.match(await island.locator(".isl-top").textContent(), /AI 2803/);
  assert.equal(await p.evaluate(() => document.body.classList.contains("island-pinned")), true);
  const gap = await p.evaluate(() => document.querySelector(".island").getBoundingClientRect().bottom <= document.querySelector("#view-search .topbar").getBoundingClientRect().top);
  assert.ok(gap, "the island doesn't cover the page");
  // Closing and reopening: still there, straight away
  await p.goto(`${SITE}`);
  await settle(p, 300);
  assert.equal(await island.getAttribute("aria-hidden"), "false", "shown from the saved copy on reopen");
  await island.locator(".isl-open").click();
  await settle(p, 900);
  assert.deepEqual([params(p).m, params(p).no, params(p).d], ["flight", "AI2803", d]);
  // Unpin from the island while elsewhere
  await p.goto(`${SITE}?m=train`);
  await settle(p, 600);
  await island.locator(".isl-pin").click();
  await settle(p, 400);
  assert.equal(await island.getAttribute("aria-hidden"), "true");
  assert.equal(await p.evaluate(() => localStorage.getItem("pinned")), null);
  assert.deepEqual(p.errors, []);
});

/* ---------- My journeys ---------- */

await test("journeys: save a train from route results with its seat and PNR", async () => {
  const p = await page();
  const d = addDays(istToday(), 5);
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${d}`);
  await settle(p, 900);
  await p.locator('li[data-no="12314"] .tc-save').click();
  const sheet = p.locator("#journey-add");
  await sheet.waitFor();
  assert.match(await sheet.locator(".jn-summary").textContent(), /12314/);
  await sheet.locator('.jn-classes button', { hasText: "3A" }).click();
  await sheet.locator("#jn-coach").fill("b2");
  await sheet.locator("#jn-seat").fill("34 lb");
  await sheet.locator("#jn-pnr").fill("123");
  await sheet.locator(".cta", { hasText: "Save journey" }).click();
  assert.match(await sheet.locator(".field-error").textContent(), /10 digits/, "a short PNR is caught");
  await sheet.locator("#jn-pnr").fill("4521879345");
  await sheet.locator("#jn-notes").fill("Mum picks up at Howrah");
  await sheet.locator(".cta", { hasText: "Save journey" }).click();
  await settle(p, 300);
  assert.match(await p.locator("#toast").textContent(), /Saved to My journeys/);
  assert.match(await p.locator('li[data-no="12314"] .tc-save').textContent(), /Saved/);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("journeys")));
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].no, saved[0].cls, saved[0].coach, saved[0].seat, saved[0].pnr, saved[0].from.code, saved[0].to.code], ["12314", "3A", "B2", "34 LB", "4521879345", "NDLS", "SDAH"]);
  // It's in the list, upcoming, and opens its details (live status isn't open yet that far ahead)
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 600);
  const card = p.locator(".jcard");
  assert.equal(await card.count(), 1);
  assert.match(await card.textContent(), /3A · B2 · 34 LB/);
  assert.match(await card.locator(".chip").textContent(), /In \d+ days/);
  await card.click();
  const det = p.locator("#journey-detail");
  await det.waitFor();
  assert.match(await det.locator(".jn-copy").textContent(), /452 187 9345/);
  assert.match(await det.textContent(), /Mum picks up at Howrah/);
  const [dl] = await Promise.all([p.waitForEvent("download"), det.locator(".cta", { hasText: "Add to calendar" }).click()]);
  assert.match(dl.suggestedFilename(), /^train-12314-\d{4}-\d{2}-\d{2}\.ics$/);
  assert.deepEqual(p.errors, []);
});

await test("journeys: swipe left to delete, with Undo", async () => {
  const p = await page();
  const d = addDays(istToday(), 4);
  await p.goto(`${SITE}?m=train&from=NDLS&to=HWH&d=${d}`);
  await settle(p, 900);
  await p.locator('li[data-no="12302"] .tc-save').click();
  await p.locator("#journey-add .cta", { hasText: "Save journey" }).click();
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 600);
  const card = p.locator(".jcard");
  const box = await card.boundingBox();
  await p.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(box.x + box.width - 30 - i * 30, box.y + box.height / 2 + 2);
  await p.mouse.up();
  await settle(p, 500);
  assert.equal(await p.locator(".jcard").count(), 0, "gone after a long swipe");
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem("journeys")).length), 0);
  assert.match(await p.locator("#toast").textContent(), /Deleted 12302/);
  await p.locator("#toast .toast-act").click();
  await settle(p, 400);
  assert.equal(await p.locator(".jcard").count(), 1, "Undo brings it back");
  // A short swipe opens the Delete button instead
  const b2 = await p.locator(".jcard").boundingBox();
  await p.mouse.move(b2.x + b2.width - 30, b2.y + b2.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 4; i++) await p.mouse.move(b2.x + b2.width - 30 - i * 22, b2.y + b2.height / 2);
  await p.mouse.up();
  await settle(p, 400);
  assert.equal(await p.locator(".jcard-wrap.open").count(), 1);
  await p.locator(".jcard-del").click();
  await settle(p, 500);
  assert.equal(await p.locator(".jcard").count(), 0);
  assert.deepEqual(p.errors, []);
});

await test("journeys: add one from scratch by stations and day", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 500);
  assert.match(await p.locator(".jn-empty h2").textContent(), /No upcoming journeys/);
  await p.locator("#journeys-add").click();
  const sheet = p.locator("#journey-add");
  await sheet.locator("#jn-from").focus();
  await sheet.locator("#jn-from-list .st-opt").first().waitFor();
  await sheet.locator("#jn-from").fill("mys");
  await settle(p);
  await p.keyboard.press("Enter");
  await sheet.locator("#jn-to").fill("kacheguda");
  await settle(p);
  await p.keyboard.press("Enter");
  await sheet.locator("#jn-date").fill(addDays(istToday(), 2));
  await sheet.locator(".cta", { hasText: "Find my train" }).click();
  await sheet.locator(".jn-pick button").first().waitFor();
  await sheet.locator(".jn-pick button").first().click();
  assert.match(await sheet.locator(".jn-summary").textContent(), /12786/);
  await sheet.locator(".cta", { hasText: "Save journey" }).click();
  await settle(p, 500);
  assert.equal(await p.locator(".jcard").count(), 1, "the list updates straight away");
  assert.deepEqual(p.errors, []);
});

await test("journeys: a past trip keeps how it actually ran; the home screen shows the next one", async () => {
  const p = await page();
  const start = addDays(istToday(), -2);
  const t = (h, m) => new Date(Date.parse(`${start}T00:00:00+05:30`) + (h * 60 + m) * 60000).toISOString();
  const past = { id: "jpast", no: "12627", name: "Karnataka SF Express", startDate: start, from: { code: "SBC", name: "KSR Bengaluru" }, to: { code: "BPL", name: "Bhopal Jn" }, dep: t(6, 0), arr: t(30, 0), schedMin: 1440, km: 1400, cls: "3A", coach: "B4", seat: "12 LB", pnr: "", notes: "" };
  const soonStart = addDays(istToday(), 2);
  const soon = { ...past, id: "jsoon", startDate: soonStart, dep: new Date(Date.parse(`${soonStart}T19:20:00+05:30`)).toISOString(), arr: new Date(Date.parse(`${soonStart}T19:20:00+05:30`) + 86400000).toISOString() };
  await p.addInitScript((list) => localStorage.setItem("journeys", JSON.stringify(list)), [past, soon]);
  // The tracker's answer for that run: left 6 minutes late, arrived 42 minutes late.
  await p.context().route(`${API}/api/train**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": new URL(SITE).origin },
      body: JSON.stringify({
        kind: "train", number: "12627", name: "Karnataka SF Express", date: start, status: { phase: "arrived" }, position: {},
        stops: [
          { code: "SBC", name: "KSR Bengaluru", km: 0, halts: true, platform: "2", sched: { arr: null, dep: t(6, 0) }, actual: { arr: null, dep: t(6, 6) }, expected: { arr: null, dep: null }, delay: { arr: null, dep: 6 }, passed: true },
          { code: "BPL", name: "Bhopal Jn", km: 1390, halts: true, platform: "4", sched: { arr: t(30, 0), dep: t(30, 10) }, actual: { arr: t(30, 42), dep: null }, expected: { arr: null, dep: null }, delay: { arr: 42, dep: null }, passed: true },
        ],
      }),
    })
  );
  await p.goto(`${SITE}`);
  await settle(p, 800);
  assert.match(await p.locator(".home-jn").textContent(), /Your next train/);
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 1500);
  await p.locator(".jn-tabs button", { hasText: "Past" }).click();
  await settle(p, 300);
  const card = p.locator(".jcard.past");
  assert.equal(await card.count(), 1);
  assert.match(await card.locator(".chip").textContent(), /42m late/);
  assert.match(await p.locator(".jn-stats").textContent(), /1 trip/);
  await card.click();
  const det = p.locator("#journey-detail");
  await det.waitFor();
  assert.match(await det.locator(".jn-tiles").textContent(), /Arrived42m late/);
  assert.match(await det.locator(".jn-tiles").textContent(), /36m longer than the timetable/);
  assert.match(await det.textContent(), /PF 2/);
  assert.deepEqual(p.errors, []);
});

await test("journeys: a PNR fills in the whole trip, and every passenger on it", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 500);
  await p.locator("#journeys-add").click();
  const sheet = p.locator("#journey-add");
  await sheet.locator("#jn-pnr-find").fill("12345");
  await sheet.locator(".cta", { hasText: "Fill in from PNR" }).click();
  assert.match(await sheet.locator(".field-error").first().textContent(), /10 digits/);
  await sheet.locator("#jn-pnr-find").fill("1234567891");
  await sheet.locator(".cta", { hasText: "Fill in from PNR" }).click();
  await sheet.locator(".jn-summary").waitFor();
  assert.match(await sheet.locator(".jn-summary").textContent(), /12786/);
  assert.match(await sheet.locator(".jn-summary").textContent(), /KSR Bengaluru to Kacheguda/);
  // Each end says its own date (you arrive the next morning), and the ticket's journey time shows
  const dayName = (iso) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
  const ends = await sheet.locator(".jn-summary .jn-end-day").allTextContents();
  assert.deepEqual(ends.map((t) => t.replace(",", "")), [dayName(addDays(istToday(), 3)), dayName(addDays(istToday(), 4))].map((t) => t.replace(",", "")));
  // It leaves SBC at 6:00 PM (both timetables); the ticket's 5:45 PM is when it gets there
  assert.equal(await sheet.locator(".jn-summary .jn-dur").textContent(), "11h 40m");
  assert.ok(!/\bnull\b/.test(await sheet.textContent()), "no empty slot printed as null");
  assert.equal(await sheet.locator('.jn-classes button[aria-pressed="true"]').textContent(), "3A");
  assert.equal(await sheet.locator("#jn-coach").inputValue(), "B3");
  assert.equal(await sheet.locator("#jn-seat").inputValue(), "59 UB", "the berth type comes with it");
  assert.equal(await sheet.locator("#jn-pnr").inputValue(), "1234567891");
  // One row per passenger
  assert.equal(await sheet.locator(".jn-pax-row").count(), 2);
  assert.match(await sheet.locator(".jn-pax-row").nth(1).textContent(), /Waitlist 4/);
  assert.match(await sheet.locator(".jn-bk-head").textContent(), /WL 4.*Chart not prepared yet/);
  await sheet.locator(".cta", { hasText: "Save journey" }).click();
  await settle(p, 500);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("journeys")));
  assert.deepEqual([saved[0].no, saved[0].from.code, saved[0].to.code, saved[0].pnrLinked, saved[0].booking.passengers.length], ["12786", "SBC", "KCG", true, 2]);
  assert.match(saved[0].dep, /T12:30:00\.000Z$/, "leaves at 6:00 PM in India");
  assert.match(saved[0].fromArr, /T12:15:00\.000Z$/, "gets in at 5:45 PM, as the ticket shows");
  assert.equal(saved[0].timeCheck.fromMatch, "arrival");
  // The card says it's still waitlisted, and how many are travelling
  const card = p.locator(".jcard");
  assert.match(await card.locator(".jc-meta").textContent(), /WL 4.*B3 · 59 UB · 2 travellers/);
  await card.click();
  const det = p.locator("#journey-detail");
  await det.waitFor();
  assert.equal(await det.locator(".jn-pax-row").count(), 2);
  assert.match(await det.textContent(), /PF 5 \(tentative\)/);
  assert.equal(await det.locator(".jn-leg-dur").textContent(), "11h 40m journey");
  await det.locator(".jn-coach").first().waitFor();
  assert.ok(!/\bnull\b/.test(await det.textContent()), "no empty slot printed as null");
  assert.match(await det.textContent(), /Arrives 5:45 PM, 15 min halt/);
  assert.match(await det.locator(".jn-times-note").textContent(), /Your ticket shows 5:45 PM, when the train gets to KSR Bengaluru\. It leaves at 6:00 PM, as both timetables say\./);
  assert.equal(await det.locator(".jn-leg-day").count(), 2, "a date by each station");
  assert.equal(await det.locator(".cta", { hasText: "Share trip" }).count(), 1);
  assert.deepEqual(p.errors, []);
});

await test("journeys: on the platform, find your coach and your berth, and name who's travelling", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 400);
  await p.locator("#journeys-add").click();
  const sheet = p.locator("#journey-add");
  await sheet.locator("#jn-pnr-find").fill("1234567890");
  await sheet.locator(".cta", { hasText: "Fill in from PNR" }).click();
  await sheet.locator(".jn-summary").waitFor();
  await sheet.locator(".cta", { hasText: "Save journey" }).click();
  await settle(p, 400);
  await p.locator(".jcard").click();
  const det = p.locator("#journey-detail");
  await det.locator(".jn-coach.mine").waitFor();
  // The coach order, with B3 marked; tap the coach you're standing at
  assert.equal(await det.locator(".jn-coach").count(), 22);
  assert.equal(await det.locator(".jn-coach.mine b").textContent(), "B3");
  assert.match(await det.locator(".jn-coach-say").textContent(), /B3 is coach 10 of 22 from the LPR end, and 13 from the SLRD end/);
  // Which end leads is only "probably", with its reasons
  assert.match(await det.locator(".jn-coach-front").textContent(), /Probably the LPR end comes in first, behind the engine\. The sources that show the engine put it at the LPR end, and RailYatri's timetable lists no reversal before KSR Bengaluru\./);
  assert.match(await det.locator(".jn-coachbox").textContent(), /erail\.in and ConfirmTkt list this order\. etrain\.info lists a different one\./);
  assert.equal(await det.locator(".jn-loco").count(), 1, "the engine is drawn at its end");
  await det.locator(".jn-coach b", { hasText: /^S4$/ }).click();
  assert.equal(await det.locator(".jn-coach-say").textContent(), "From S4, walk 6 coaches towards S5, about 140 m.");
  await det.locator(".jn-coach b", { hasText: /^B2$/ }).click();
  assert.equal(await det.locator(".jn-coach-say").textContent(), "From B2, walk 1 coach towards B3, about 20 m.");
  // The berth inside the coach: bay 8 of 9, upper, on the main side
  // Bay 8 is certain; how many bays the coach has isn't (the source that gives the build disagrees)
  assert.equal(await det.locator(".jn-berth-head").textContent(), "Berth 59 · UpperBay 8");
  assert.equal(await det.locator(".jn-bays").count(), 0);
  assert.equal(await det.locator(".jn-b.mine").textContent(), "59UB");
  assert.match(await det.locator(".jn-bay").getAttribute("aria-label"), /berths 57 to 64.*upper berth in the main bay/);
  // The platform: only the ticket's for now (no live data in this test)
  assert.equal(await det.locator(".jn-pf-line").textContent(), "Platform 5. Your ticket and both timetables (RailYatri, ConfirmTkt) all say so.");
  // Add who's travelling; it stays through a re-check
  await det.locator(".jn-pax-edit").click();
  await det.locator(".jn-pax-form input").first().fill("Asha Rao");
  await det.locator(".jn-pax-form input").nth(1).fill("31");
  await det.locator(".jn-pax-form select").selectOption("F");
  await det.locator(".pill-btn", { hasText: "Save" }).click();
  await settle(p, 300);
  assert.match(await det.locator(".jn-pax-who small").textContent(), /^Asha Rao · 31 · Female/);
  await det.locator(".jn-bk-refresh").click();
  await settle(p, 1500);
  assert.match(await det.locator(".jn-pax-who small").textContent(), /^Asha Rao · 31 · Female/, "kept after checking again");
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("journeys"))[0]);
  assert.deepEqual(saved.travellers, { 1: { name: "Asha Rao", age: 31, gender: "F" } });
  assert.deepEqual(p.errors, []);
});

await test("journeys: ticket times are matched to the timetable, never assumed to be departures", async () => {
  const p = await page();
  await p.goto(`${SITE}?m=train`);
  const r = await p.evaluate(async () => {
    const { timetableTimes } = await import("./js/journeys.js");
    const t = (stops, from, to, day, ticket) => {
      const x = timetableTimes(stops, from, to, day, ticket);
      return x && { ...x, check: { fromMatch: x.check.fromMatch, toMatch: x.check.toMatch } };
    };
    const sbc = { code: "SBC", arr: "17:45", dep: "18:00", day: 1 };
    const kcg = { code: "KCG", arr: "05:40", dep: null, day: 2 };
    return {
      arrival: t([sbc, kcg], "SBC", "KCG", "2026-11-14", { from: "17:45", to: "05:40" }),
      departure: t([sbc, kcg], "SBC", "KCG", "2026-11-14", { from: "18:00", to: "05:40" }),
      neither: t([sbc, kcg], "SBC", "KCG", "2026-11-14", { from: "17:30", to: "05:50" }),
      // gets in before midnight, leaves after it
      midnight: t([{ code: "A", arr: "23:50", dep: "00:05", day: 1 }, { code: "B", arr: "06:00", day: 2 }], "A", "B", "2026-11-14", { from: "23:50" }),
      missing: t([sbc], "SBC", "KCG", "2026-11-14", {}),
    };
  });
  assert.deepEqual([r.arrival.dep, r.arrival.fromArr, r.arrival.arr, r.arrival.schedMin, r.arrival.check.fromMatch, r.arrival.check.toMatch], ["2026-11-14T12:30:00.000Z", "2026-11-14T12:15:00.000Z", "2026-11-15T00:10:00.000Z", 700, "arrival", true]);
  assert.deepEqual([r.departure.dep, r.departure.check.fromMatch], ["2026-11-14T12:30:00.000Z", "departure"]);
  assert.deepEqual([r.neither.check.fromMatch, r.neither.check.toMatch], ["neither", false]);
  assert.deepEqual([r.midnight.fromArr, r.midnight.dep, r.midnight.arr], ["2026-11-14T18:20:00.000Z", "2026-11-14T18:35:00.000Z", "2026-11-15T00:30:00.000Z"]);
  assert.equal(r.missing, null, "no destination in the timetable: no guess");
  assert.deepEqual(p.errors, []);
});

await test("journeys: hours before boarding, today's run is checked, and every source is named", async () => {
  const at = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const j = {
    id: "jday", no: "12786", name: "Ashokapuram - Kacheguda SF Express", startDate: istToday(),
    from: { code: "SBC", name: "KSR Bengaluru" }, to: { code: "KCG", name: "Kacheguda" }, dep: at(120), arr: at(820), schedMin: 700, cls: "3A", coach: "B3", seat: "59 UB", pnr: "1234567890", notes: "",
    pnrLinked: true, booking: { overall: "confirmed", chart: "prepared", platform: "5", checkedAt: at(0), passengers: [{ n: 1, kind: "confirmed", booking: "CNF", current: "CNF", coach: "B3", berth: "59", berthType: "Upper", berthFrom: "railway", position: null }] },
  };
  const order = "LPR GN GN H1 A2 A1 B6 B5 B4 B3 B2 B1 S7 S6 S5 S4 S3 S2 S1 GN GN SLRD".split(" ");
  const dayof = (ntes) => ({
    kind: "dayof", no: "12786", date: istToday(), at: "SBC",
    coaches: ntes ? { list: order.map((id) => ({ id, cls: /^B/.test(id) ? "3A" : null })), source: "ntes" } : null,
    platform: { ntes: ntes ? { pf: "6", mark: "*" } : null, railyatri: "5", confirmtkt: "5" },
    delay: { ntes: ntes ? 13 : null, railyatri: 0, confirmtkt: 10 },
    sources: [{ name: "ntes", ok: ntes, why: ntes ? null : "timed out" }, { name: "railyatri", ok: true, why: null }, { name: "confirmtkt", ok: true, why: null }],
    status: { checkedAt: new Date().toISOString() },
  });
  for (const ntes of [true, false]) {
    const p = await page();
    await p.addInitScript((list) => localStorage.setItem("journeys", JSON.stringify(list)), [j]);
    await p.context().route(`${API}/api/dayof**`, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(SITE).origin }, body: JSON.stringify(dayof(ntes)) }));
    // Today's live run, for the tracker the trip opens into
    await p.context().route(`${API}/api/train**`, (route) =>
      route.fulfill({
        status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(SITE).origin },
        body: JSON.stringify({
          kind: "train", number: "12786", name: j.name, date: istToday(), status: { phase: "running" }, position: {},
          stops: [
            { code: "SBC", name: "KSR Bengaluru", km: 144, halts: true, platform: "5", sched: { arr: at(105), dep: at(120) }, actual: { arr: null, dep: null }, expected: { arr: at(118), dep: at(130) }, delay: { arr: 13, dep: 10 }, passed: false },
            { code: "KCG", name: "Kacheguda", km: 769, halts: true, platform: "4", sched: { arr: at(820), dep: null }, actual: { arr: null, dep: null }, expected: { arr: at(830), dep: null }, delay: { arr: 10, dep: null }, passed: false },
          ],
        }),
      })
    );
    await p.goto(`${SITE}?m=train&v=journeys`);
    await settle(p, 500);
    await p.locator(".jcard").click(); // on the day, a trip opens its live status…
    await p.locator(".trip-guide").waitFor();
    assert.match(await p.locator(".trip-guide").textContent(), /Your coach, berth and platform.*B3 · 59 UB · boarding at KSR Bengaluru/);
    await p.locator(".trip-guide").click(); // …and its guide is one tap from there
    const det = p.locator("#journey-detail");
    await det.locator(".jn-today-line").first().waitFor({ timeout: 15000 });
    const text = await det.locator(".jn-today").textContent();
    if (ntes) {
      assert.match(text, /Platform 6 today, from the railway's enquiry system \(marked provisional there\)\./);
      assert.match(text, /RailYatri's live status and ConfirmTkt list platform 5\./);
      assert.match(text, /At KSR Bengaluru: NTES says 13 min late, RailYatri says on time, ConfirmTkt says 10 min late\./);
      await det.locator(".jn-verified").waitFor();
      assert.match(await det.locator(".jn-coachbox").textContent(), /Today's order at KSR Bengaluru, from the railway's enquiry system \(NTES\), checked just now\. It matches the published order\./);
      assert.equal(await det.locator(".jn-loco").count(), 0, "no engine is drawn on today's order: NTES doesn't mark it");
    } else {
      assert.match(text, /RailYatri's live status and ConfirmTkt list platform 5\. The railway's own system hasn't confirmed it yet\./);
      assert.match(text, /NTES: timed out/);
      assert.match(text, /Not confirmed by the railway yet/);
      assert.equal(await det.locator(".jn-verified").count(), 0);
    }
    assert.match(await det.locator(".jn-pf-line").textContent(), /^Planned: platform 5\./);
    assert.ok(!/\bnull\b/.test(await det.textContent()));
    assert.deepEqual(p.errors, []);
  }
});

await test("journeys: a PNR with no booking says so kindly", async () => {
  const p = await page({ env: { PNR_WAIT_MS: "2500" } }); // the Worker waits ~24 s for real
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 500);
  await p.locator("#journeys-add").click();
  const sheet = p.locator("#journey-add");
  await sheet.locator("#jn-pnr-find").fill("9999999999");
  await sheet.locator(".cta", { hasText: "Fill in from PNR" }).click();
  await sheet.locator(".field-error:not([hidden])").first().waitFor({ timeout: 40000 });
  assert.match(await sheet.locator(".field-error:not([hidden])").first().textContent(), /couldn.t find this booking yet/);
  assert.equal(await sheet.locator(".cta", { hasText: "Fill in from PNR" }).isEnabled(), true, "ready to try again");
  assert.deepEqual(p.errors, []);
});

await test("journeys: share a trip as a link to live status at your stop", async () => {
  const p = await page();
  const start = addDays(istToday(), 2);
  const j = { id: "jshare", no: "12786", name: "Ashokapuram - Kacheguda SF Express", startDate: start, from: { code: "SBC", name: "KSR Bengaluru" }, to: { code: "KCG", name: "Kacheguda" }, dep: `${start}T12:15:00.000Z`, arr: `${addDays(start, 1)}T00:10:00.000Z`, schedMin: 715, cls: "3A", coach: "B3", seat: "59", pnr: "", notes: "" };
  await p.addInitScript((list) => {
    localStorage.setItem("journeys", JSON.stringify(list));
    // No share sheet in this browser: the link is copied instead.
    Object.defineProperty(navigator, "share", { value: undefined });
    window.__copied = null;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => (window.__copied = t) } });
  }, [j]);
  await p.goto(`${SITE}?m=train&v=journeys`);
  await settle(p, 500);
  await p.locator(".jcard").click();
  await p.locator("#journey-detail .cta", { hasText: "Share trip" }).click();
  await settle(p, 300);
  const text = await p.evaluate(() => window.__copied);
  assert.match(text, /train 12786 Ashokapuram - Kacheguda SF Express from KSR Bengaluru/);
  assert.match(text, /due at Kacheguda at 5:40 AM the next day/);
  const link = new URL(text.split(" ").pop());
  assert.deepEqual([link.searchParams.get("m"), link.searchParams.get("no"), link.searchParams.get("d"), link.searchParams.get("s")], ["train", "12786", start, "KCG"]);
  assert.match(await p.locator("#toast").textContent(), /Trip link copied/);
  assert.deepEqual(p.errors, []);
});

await test("journeys: on travel day the trip pins itself, and stays unpinned once you unpin it", async () => {
  const p = await page();
  const start = istToday();
  const at = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const j = { id: "jtoday", no: "12627", name: "Karnataka SF Express", startDate: start, from: { code: "SBC", name: "KSR Bengaluru" }, to: { code: "BPL", name: "Bhopal Jn" }, dep: at(120), arr: at(1500), schedMin: 1380, km: 1390, cls: "3A", coach: "B4", seat: "12", pnr: "", notes: "" };
  await p.addInitScript((list) => localStorage.getItem("journeys") || localStorage.setItem("journeys", JSON.stringify(list)), [j]);
  await p.context().route(`${API}/api/train**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": new URL(SITE).origin },
      body: JSON.stringify({
        kind: "train", number: "12627", name: "Karnataka SF Express", date: start, status: { phase: "upcoming" }, position: {},
        stops: [
          { code: "SBC", name: "KSR Bengaluru", km: 0, halts: true, platform: "2", sched: { arr: null, dep: at(120) }, actual: { arr: null, dep: null }, expected: { arr: null, dep: at(120) }, delay: { arr: null, dep: 0 }, passed: false },
          { code: "BPL", name: "Bhopal Jn", km: 1390, halts: true, platform: null, sched: { arr: at(1500), dep: at(1510) }, actual: { arr: null, dep: null }, expected: { arr: at(1500), dep: null }, delay: { arr: 0, dep: null }, passed: false },
        ],
      }),
    })
  );
  await p.goto(`${SITE}`);
  await settle(p, 2500);
  const pin = await p.evaluate(() => JSON.parse(localStorage.getItem("pinned")));
  assert.deepEqual([pin?.no, pin?.date, pin?.stop, pin?.auto], ["12627", start, "BPL", "jtoday"]);
  const island = p.locator(".island");
  assert.equal(await island.getAttribute("aria-hidden"), "false");
  assert.match(await p.locator("#toast").textContent(), /pinned to the top for today's trip/);
  await island.locator(".isl-pin").click();
  await settle(p, 300);
  await p.reload();
  await settle(p, 2500);
  assert.equal(await p.evaluate(() => localStorage.getItem("pinned")), null, "doesn't pin itself again");
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
