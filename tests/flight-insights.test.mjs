import { test } from "node:test";
import assert from "node:assert/strict";
import { historySummary, turnaround } from "../js/flight-insights.js";

test("history: the middle day sets 'usually', 15 minutes is the on-time line", () => {
  const rows = [-20, -11, 6, 19, -14, -25, -11, -2, -2, -14, -16].map((d, i) => ({ date: `2026-11-${String(18 - i).padStart(2, "0")}`, depDelay: d }));
  const s = historySummary(rows);
  assert.equal(s.flown, 11);
  assert.equal(s.onTime, 10, "the 19-minute day is the only late one");
  assert.equal(s.typical, -11);
  assert.deepEqual(s.text, ["Usually leaves 11 min early", "On time 10 of the last 11 days"]);
  assert.equal(s.bars[0].date, "2026-11-08", "oldest first");
  assert.equal(historySummary(rows.slice(0, 2)), null, "too few days to say anything");
});

test("turnaround: 6E 724 reaches the gate 10:17 for a 10:45 departure, which is tight", () => {
  const f = {
    status: { phase: "pre" },
    departure: { sched: "2026-11-19T17:00:00Z", revised: "2026-11-19T17:15:00Z" },
    aircraft: { model: "Airbus A320neo" },
    inbound: { phase: "air", times: { in: { sched: "2026-11-19T16:00:00Z", est: "2026-11-19T16:47:00Z", actual: null } } },
  };
  const t = turnaround(f, Date.parse("2026-11-19T16:21:00Z"));
  assert.equal(t.gapMin, 28);
  assert.equal(t.verdict, "tight");
  f.inbound.liveEta = "2026-11-19T16:55:00Z"; // the live position says it lands later than the airline thinks
  const late = turnaround(f, Date.parse("2026-11-19T16:21:00Z"));
  assert.equal(late.verdict, "late");
  assert.equal(late.earliest, "2026-11-19T17:25:00.000Z", "lands 10:25, at the gate 10:30, ready 10:55");
  f.inbound = { ...f.inbound, landed: true, times: { in: { actual: "2026-11-19T16:40:00Z" } } };
  assert.equal(turnaround(f).verdict, "here");
});
