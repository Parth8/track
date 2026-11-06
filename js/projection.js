// Where a running train will probably be: times for the stops ahead, worked out again from the
// latest actual times on every refresh.
//
// The rule is plain and stated, not hidden in a model:
//  1. Start from the newest real delay: the last station the train actually reached or left, or
//     the live position's delay if that report is further along the line.
//  2. Carry it forward. At a long halt a late train can make up time, down to a short stop
//     (MIN_HALT); that's the only recovery assumed for the likely time.
//  3. Work out the most it could plausibly make up as well: those shortened halts plus up to
//     RECOVERY of the scheduled running time between stops (timetables pad their sections).
//     That's the floor: no projection, ours or the source's, goes below it.
//  4. If the source projects a stop, its figure is the likely value when it's above the floor;
//     below it, the floor stands instead. The range always reaches the carried delay, so a
//     hoped-for recovery is never shown as certain.
// Every stop ahead gets `est: { arr, dep }`, each { lo, hi, likely } in minutes late, and its
// expected times set from `likely`. Stops already passed keep their actual times, untouched.

const MIN_HALT = 2; // minutes: about the shortest stop a train makes at a scheduled halt
// The share of scheduled running time a late train can make up between stops. Set from a real
// run (12785, 6 Nov 2026): 27 min late at Yelahanka was projected 13 min late at KSR Bengaluru,
// about 19% of the running time between them.
const RECOVERY = 0.2;
const SLACK = 2; // minutes of rounding allowed before a source's projection counts as implausible
const MIN = 60000;

const plus = (iso, mins) => (iso ? new Date(Date.parse(iso) + mins * MIN).toISOString().replace(".000Z", "Z") : null);
const lateBy = (sched, actual) => (sched && actual ? Math.round((Date.parse(actual) - Date.parse(sched)) / MIN) : null);

/** The newest real delay on this run, and the halt it was measured at (index), or null. */
function anchorOf(j, halts) {
  let at = -1;
  let delay = null;
  halts.forEach((s, i) => {
    const d = s.actual?.dep ? (s.delay?.dep ?? lateBy(s.sched.dep, s.actual.dep)) : s.actual?.arr ? (s.delay?.arr ?? lateBy(s.sched.arr, s.actual.arr)) : null;
    if (d != null) {
      at = i;
      delay = d;
    }
  });
  // The live position is newer than the last station report once the train is past it.
  const live = j.status?.delayMin;
  const km = j.position?.kmDone;
  if (j.status?.phase === "running" && Number.isFinite(live) && Number.isFinite(km) && (at < 0 || km > (halts[at]?.km ?? 0))) {
    const ahead = halts.findIndex((s) => !s.passed && s.km >= km - 0.5);
    return { delay: live, from: ahead < 0 ? halts.length : ahead, at: at };
  }
  return at < 0 ? null : { delay, from: at + 1, at };
}

/** Leaves at its own estimate, but never sooner than a short stop after it gets in. */
function departs(s, arr, dep) {
  const leave = Date.parse(s.sched.dep) + dep.likely * MIN;
  const gotIn = arr ? Date.parse(s.sched.arr) + arr.likely * MIN + MIN_HALT * MIN : 0;
  return new Date(Math.max(leave, gotIn)).toISOString().replace(".000Z", "Z");
}

/**
 * The run with projected times for the stops ahead. Returns a new object; the input isn't
 * changed. Runs that haven't started, or have finished, come back as they are.
 */
export function projectRun(j) {
  if (!j?.stops?.length || j.status?.phase !== "running") return j;
  const halts = j.stops.filter((s) => s.halts);
  const anchor = anchorOf(j, halts);
  if (!anchor) return j;
  const ahead = new Set(halts.slice(anchor.from).filter((s) => !s.passed && !s.actual?.arr && !s.actual?.dep));
  let carry = Math.max(0, anchor.delay); // a late train doesn't leave a halt early
  let floor = carry; // the least late it could plausibly be
  let prev = halts[anchor.from - 1] || null; // the last halt behind the train
  let first = true;
  const stops = j.stops.map((s) => {
    if (!ahead.has(s)) return s;
    // Running time from the last halt to this one; if the train is already part-way, only what's left.
    let run = prev ? Math.max(0, lateBy(prev.sched.dep || prev.sched.arr, s.sched.arr || s.sched.dep) || 0) : 0;
    const km = j.position?.kmDone;
    if (first && prev && Number.isFinite(km) && s.km > prev.km) run *= Math.min(1, Math.max(0, (s.km - km) / (s.km - prev.km)));
    first = false;
    prev = s;
    floor = Math.max(0, floor - RECOVERY * run);
    const range = (carried, least, source) => {
      const src = Number.isFinite(source) ? Math.max(0, source) : null;
      const overruled = src != null && src < least - SLACK; // more recovery than is plausible
      const likely = src == null ? carried : overruled ? least : src;
      return { lo: Math.round(Math.min(least, likely)), hi: Math.round(Math.max(carried, likely)), likely: Math.round(likely), overruled };
    };
    const hasSrc = (which) => !!s.expected?.[which] && Number.isFinite(s.delay?.[which]);
    const arr = s.sched.arr ? range(carry, floor, hasSrc("arr") ? s.delay.arr : null) : null;
    // Time made up at the halt: anything beyond a short stop.
    const halt = s.sched.arr && s.sched.dep ? Math.max(0, lateBy(s.sched.arr, s.sched.dep)) : 0;
    carry = Math.max(0, carry - Math.max(0, halt - MIN_HALT));
    floor = Math.max(0, floor - Math.max(0, halt - MIN_HALT));
    const dep = s.sched.dep ? range(carry, floor, hasSrc("dep") ? s.delay.dep : null) : null;
    return {
      ...s,
      expected: { arr: arr ? plus(s.sched.arr, arr.likely) : null, dep: dep ? departs(s, arr, dep) : null },
      delay: { arr: arr?.likely ?? null, dep: dep?.likely ?? null },
      est: { arr, dep },
    };
  });
  return { ...j, stops, projection: { from: anchor.delay, at: anchor.at >= 0 ? halts[anchor.at].code : null } };
}

/** "20–25m late", "~27m late", "on time", from a stop's estimate. */
export function estText(e) {
  if (!e) return null;
  if (e.hi < 3) return "on time";
  if (e.hi - e.lo < 3) return `~${e.likely}m late`;
  return `${e.lo}–${e.hi}m late`;
}
