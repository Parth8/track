// Airport search: what people type should find the airport they mean.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let A;
before(async () => {
  globalThis.fetch = async () => new Response(readFileSync(new URL("../data/airports.json", import.meta.url)));
  A = await import("../js/airports.js");
  await A.loadAirports();
});
const top = (q, n = 1) => A.searchAirports(q, n).map((r) => r.station.code);

test("cities find their main airport first", () => {
  for (const [q, code] of [["delhi", "DEL"], ["mumbai", "BOM"], ["hyd", "HYD"], ["chennai", "MAA"], ["kolkata", "CCU"], ["london", "LHR"], ["dubai", "DXB"]])
    assert.equal(top(q)[0], code, q);
});

test("codes, older names and nicknames work", () => {
  for (const [q, code] of [["BLR", "BLR"], ["bombay", "BOM"], ["madras", "MAA"], ["calcutta", "CCU"], ["bangalore", "BLR"], ["trivandrum", "TRV"], ["vizag", "VTZ"], ["aurangabad", "IXU"]])
    assert.equal(top(q)[0], code, q);
  assert.equal(A.searchAirports("bombay")[0].via, "alias");
});

test("an Indian city beats a foreign airport whose code matches", () => {
  assert.deepEqual(top("goa", 2).sort(), ["GOI", "GOX"]);
});

test("cities with several airports name each one", () => {
  assert.equal(A.airportByCode("LHR").name, "London Heathrow");
  assert.equal(A.airportByCode("HYD").name, "Hyderabad", "Pakistan's Hyderabad doesn't make India's ambiguous");
  assert.equal(A.airportByCode("GOX").name, "Goa (Mopa)");
});

test("typed text resolves only when it's unambiguous", () => {
  assert.equal(A.resolveAirport("blr")?.code, "BLR");
  assert.equal(A.resolveAirport("Delhi")?.code, "DEL");
  assert.equal(A.resolveAirport("goa"), null, "two airports: pick from the list");
});
