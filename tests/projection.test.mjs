// Projected times for the stops ahead: node --test tests/
// The run is real: 12785 on 6 Nov 2026, 27 min late out of Yelahanka (recorded from the Worker).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectRun, estText } from "../js/projection.js";

const run = JSON.parse(readFileSync(new URL("./fixtures/run-12785-running.json", import.meta.url), "utf8"));
const ist = (iso) => new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(11, 16);
const at = (j, code) => j.stops.find((s) => s.code === code);
/** The same run as the source sends it before it has projected anything. */
const bare = () => {
  const j = structuredClone(run);
  for (const s of j.stops) if (!s.passed) Object.assign(s, { expected: { arr: null, dep: null }, delay: { arr: null, dep: null } });
  return j;
};

test("without the source's projections, the latest delay carries forward: never 'on time'", () => {
  const p = projectRun(bare());
  const bnc = at(p, "BNC");
  assert.equal(ist(bnc.expected.arr), "05:54", "5:31 scheduled, 23 min late as the train last reported");
  assert.equal(estText(bnc.est.arr), "~23m late");
});

test("a long halt is where a late train can make up time, down to a short stop", () => {
  const p = projectRun(bare());
  const sbc = at(p, "SBC"); // 10 min halt: 8 of them can be made up
  assert.equal(sbc.est.arr.likely, 23);
  assert.equal(sbc.est.dep.likely, 15);
  assert.equal(at(p, "KGI").est.arr.likely, 15, "and it carries on from there");
});

test("the source's projection is the likely value, but the range always reaches the carried delay", () => {
  const p = projectRun(run);
  const bnc = at(p, "BNC");
  assert.equal(ist(bnc.expected.arr), "05:51", "RailYatri's projection");
  assert.deepEqual([bnc.est.arr.lo, bnc.est.arr.hi], [20, 23]);
  assert.equal(estText(bnc.est.arr), "20–23m late");
});

test("stops already passed keep their actual times", () => {
  const p = projectRun(run);
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
  assert.equal(at(projectRun(j), "BNC").est.arr.likely, 8);
});

test("a run that hasn't started, or has finished, is left as it is", () => {
  for (const phase of ["not_started", "arrived"]) {
    const j = { ...run, status: { ...run.status, phase } };
    assert.equal(projectRun(j), j);
  }
});
