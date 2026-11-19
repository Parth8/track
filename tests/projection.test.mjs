// Projected times for the stops ahead: node --test tests/
// The run is real: 12785 on 6 Nov 2026, 27 min late out of Yelahanka (recorded from the Worker).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectRun, estText } from "../js/projection.js";

const run = JSON.parse(readFileSync(new URL("./fixtures/run-12785-running.json", import.meta.url), "utf8"));
// The moment the run was recorded: projections are worked out as of then.
const AT = Date.parse(run.status.checkedAt);
const ist = (iso) => new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(11, 16);
const at = (j, code) => j.stops.find((s) => s.code === code);
/** The same run as the source sends it before it has projected anything. */
const bare = () => {
  const j = structuredClone(run);
  for (const s of j.stops) if (!s.passed) Object.assign(s, { expected: { arr: null, dep: null }, delay: { arr: null, dep: null } });
  return j;
};

test("without the source's projections, the latest delay carries forward: never 'on time'", () => {
  const p = projectRun(bare(), AT);
  const bnc = at(p, "BNC");
  assert.equal(ist(bnc.expected.arr), "05:54", "5:31 scheduled, 23 min late as the train last reported");
  assert.equal(estText(bnc.est.arr), "20–27m late", "likely 23: it could make up 3 on the way, or lose 4 more");
});

test("a long halt is where a late train can make up time, down to a short stop", () => {
  const p = projectRun(bare(), AT);
  const sbc = at(p, "SBC"); // 10 min halt: 8 of them can be made up
  assert.equal(sbc.est.arr.likely, 23);
  assert.equal(sbc.est.dep.likely, 15);
  assert.equal(at(p, "KGI").est.arr.likely, 15, "and it carries on from there");
});

test("the source's projection is the likely value, but the range always reaches the carried delay", () => {
  const p = projectRun(run, AT);
  const bnc = at(p, "BNC");
  assert.equal(ist(bnc.expected.arr), "05:51", "RailYatri's projection");
  assert.deepEqual([bnc.est.arr.lo, bnc.est.arr.hi], [20, 27]);
  assert.equal(estText(bnc.est.arr), "20–27m late");
});

test("stops already passed keep their actual times", () => {
  const p = projectRun(run, AT);
  const ynk = at(p, "YNK");
  assert.equal(ynk.est, undefined);
  assert.equal(ist(ynk.actual.arr), "05:20");
});

test("every refresh starts again from the newest actual: recovered time shows straight away", () => {
  // The train makes up time and reaches Bangalore East only 8 min late
  const j = bare();
  const bnce = at(j, "BNCE");
  bnce.passed = true;
  bnce.actual = { arr: new Date(Date.parse(bnce.sched.arr) + 8 * 60000).toISOString(), dep: new Date(Date.parse(bnce.sched.dep) + 8 * 60000).toISOString() };
  bnce.delay = { arr: 8, dep: 8 };
  j.position = { ...j.position, kmDone: bnce.km };
  j.status = { ...j.status, delayMin: 8 };
  assert.equal(at(projectRun(j, Date.parse(bnce.actual.dep)), "BNC").est.arr.likely, 8);
});

test("a run that hasn't started, or has finished, is left as it is", () => {
  for (const phase of ["not_started", "arrived"]) {
    const j = { ...run, status: { ...run.status, phase } };
    assert.equal(projectRun(j, AT), j);
  }
});

test("a source projecting more recovery than is plausible is overruled by the floor", () => {
  // As the source sent it at 5:49: 27 min late at the train, but 0 at KSR Bengaluru, 37 min of
  // running later. That would mean making up 27 min in 37: not possible.
  const j = structuredClone(run);
  j.status.delayMin = 27;
  for (const s of j.stops) if (!s.passed) {
    const d = ["BNCE", "BNC"].includes(s.code) ? 27 : 0;
    s.delay = { arr: d, dep: d };
    s.expected = { arr: s.sched.arr && new Date(Date.parse(s.sched.arr) + d * 60000).toISOString(), dep: s.sched.dep && new Date(Date.parse(s.sched.dep) + d * 60000).toISOString() };
  }
  const sbc = at(projectRun(j, AT), "SBC");
  assert.equal(sbc.est.arr.overruled, true);
  assert.equal(ist(sbc.expected.arr), "06:27", "not 6:10");
  assert.equal(estText(sbc.est.arr), "17–40m late", "it really came in 39 min late: the top of the range has to reach that");
});

test("a plausible source projection stands, within a couple of minutes of rounding", () => {
  const p = projectRun(run, AT);
  assert.equal(at(p, "BNC").est.arr.overruled, false);
  assert.equal(ist(at(p, "SBC").expected.arr), "06:23", "RailYatri's 13 min late at KSR Bengaluru is plausible");
});

test("the clock wins: at 6:13 with a 5:39 report, nothing ahead is shown in the past", () => {
  // What the Worker served at 6:13 AM: its copy of the 5:39 report, 23 min late near Channasandra.
  const now = Date.parse("2026-11-06T00:43:00Z"); // 6:13 AM in India
  const p = projectRun(bare(), now);
  const ahead = p.stops.filter((s) => s.est);
  assert.ok(ahead.length);
  for (const s of ahead) {
    const t = Date.parse(s.expected.arr || s.expected.dep);
    assert.ok(t >= now - 60000, `${s.code} shown at ${ist(s.expected.arr || s.expected.dep)}, before 6:13`);
  }
  const bnc = at(p, "BNC");
  assert.equal(bnc.est.arr.due, true);
  assert.equal(estText(bnc.est.arr), "due now, not reported yet");
  const sbc = at(p, "SBC");
  // It really reached KSR Bengaluru at 6:49, 39 min late.
  assert.ok(sbc.est.arr.lo <= 39 && sbc.est.arr.hi >= 39, `range ${sbc.est.arr.lo}–${sbc.est.arr.hi} misses the real 39`);
  assert.equal(p.projection.ageMin, 34);
});
