// Station search tests: node --test tests/
// What people type should find the station they mean, first.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let s;
before(async () => {
  globalThis.fetch = async () => new Response(readFileSync(new URL("../data/stations.json", import.meta.url), "utf8"));
  s = await import("../js/stations.js");
  await s.loadStations();
});

const top = (q) => s.searchStations(q, 3)[0]?.station.code;

test("a city's name finds its main station first", () => {
  const cases = { del: "NDLS", delhi: "NDLS", chen: "MAS", chennai: "MAS", mumbai: "CSMT", hyd: "HYB", bang: "SBC", jai: "JP", pune: "PUNE", luck: "LKO", pat: "PNBE", kol: "HWH", goa: "MAO" };
  for (const [q, code] of Object.entries(cases)) assert.equal(top(q), code, q);
});

test("codes work, typed in any case", () => {
  for (const code of ["NDLS", "KCG", "MYS", "SBC", "PURI", "NZM"]) {
    assert.equal(top(code), code);
    assert.equal(top(code.toLowerCase()), code);
  }
});

test("older names and nicknames still find renamed stations", () => {
  const cases = { mysore: "MYS", allahabad: "PRYJ", madras: "MAS", bombay: "CSMT", calcutta: "HWH", trichy: "TPJ", vizag: "VSKP", cochin: "ERS", mughalsarai: "DDU", jhansi: "VGLJ", bct: "MMCT" };
  for (const [q, code] of Object.entries(cases)) assert.equal(top(q), code, q);
});

test("several words narrow it down", () => {
  assert.equal(top("new del"), "NDLS");
  assert.equal(top("delhi cantt"), "DEC");
  assert.equal(top("hazrat niz"), "NZM");
});

test("matches stay within words", () => {
  // "mys" must not match "Academy Shivarampalli" across the space
  assert.ok(!s.searchStations("mys", 8).some((r) => r.station.code === "NSVP"));
});

test("only passenger stations are listed", () => {
  for (const q of ["cabin", "goods shed", "siding", "marshalling"]) {
    for (const r of s.searchStations(q, 8)) assert.doesNotMatch(r.station.name, /cabin|goods|siding|marshalling/i, q);
  }
  assert.equal(s.stationByCode("BBTY"), null, "a signal cabin");
});

test("exact text resolves to one station; vague text doesn't", () => {
  assert.equal(s.resolveStation("kcg")?.code, "KCG");
  assert.equal(s.resolveStation("Kacheguda")?.code, "KCG");
  assert.equal(s.resolveStation("kach"), null);
  assert.equal(s.resolveStation(""), null);
});
