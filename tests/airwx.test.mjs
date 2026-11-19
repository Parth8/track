import { test } from "node:test";
import assert from "node:assert/strict";
import { wxWords, skyWords, visWords, windWords, forecastAt, rough, conditions } from "../js/airwx.js";

test("airport weather codes read as plain words", () => {
  assert.equal(wxWords("BR HZ"), "mist and haze");
  assert.equal(wxWords("-TSRA"), "light thunderstorm with rain");
  assert.equal(wxWords("VCSH"), "showers nearby");
  assert.equal(wxWords("BCFG"), "patches of fog");
  assert.equal(wxWords("+RA"), "heavy rain");
  assert.equal(skyWords([], "CAVOK"), "clear");
  assert.equal(skyWords([{ cover: "FEW", baseFt: 2000 }, { cover: "BKN", baseFt: 8000, type: "CB" }]), "mostly cloudy, storm clouds");
  assert.equal(visWords(2.49 * 1.609), "4 km");
  assert.equal(visWords(0.8), "800 m");
  assert.equal(visWords(9.7, true), "10 km or more");
  assert.equal(windWords(330, 5), "9 km/h from the NW");
  assert.equal(windWords("VRB", 1), "calm");
  assert.equal(windWords(30, 10, 20), "19 km/h from the NE, gusting 37");
});

test("the forecast at a moment: the conditions then, and spells that may come and go", () => {
  // Hyderabad's TAF, 19 Nov 2026 17:00 UTC (as published)
  const fc = {
    periods: [
      { from: "2026-11-19T18:00:00.000Z", to: "2026-11-20T04:00:00.000Z", change: null, windDir: 40, windKt: 8, visKm: 4, wx: "HZ", clouds: [{ cover: "FEW", baseFt: 2000 }] },
      { from: "2026-11-19T22:00:00.000Z", to: "2026-11-20T03:00:00.000Z", change: "TEMPO", windDir: 10, windKt: 10, visKm: 2, wx: "BR HZ", clouds: [] },
    ],
  };
  const at = forecastAt(fc, "2026-11-20T01:00:00Z");
  assert.equal(at.main.wx, "HZ");
  assert.equal(at.spells.length, 1);
  assert.equal(conditions(at.main), "Haze, 4 km visibility, wind 15 km/h from the NE");
  assert.equal(rough({ visKm: 0.6, wx: "FG" }), "Fog or very low visibility");
  assert.equal(rough(at.main), null);
  assert.equal(forecastAt(fc, "2026-11-21T01:00:00Z"), null);
});
