// Where a running train will probably be: times for the stops ahead, worked out again from the
// latest actual times on every refresh.
//
// The rule is plain and stated, not hidden in a model:
//  1. Start from the newest real delay: the last station the train actually reached or left, or
//     the live position's delay if that report is further along the line.
//  2. Carry it forward. At a long halt a late train can make up time, down to a short stop
//     (MIN_HALT); that's the only recovery assumed here.
//  3. If the source projects a stop too, its figure is used as the likely value, but the range
//     always reaches the carried delay, so a hoped-for recovery is never shown as certain.
// Every stop ahead gets `est: { arr, dep }`, each { lo, hi, likely } in minutes late, and its
// expected times set from `likely`. Stops already passed keep their actual times, untouched.

const MIN_HALT = 2; // minutes: about the shortest stop a train makes at a scheduled halt
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
  const stops = j.stops.map((s) => {
    if (!ahead.has(s)) return s;
    const range = (carried, source) => {
      const src = Number.isFinite(source) ? Math.max(0, source) : null;
      return { lo: src == null ? carried : Math.min(src, carried), hi: src == null ? carried : Math.max(src, carried), likely: src ?? carried };
    };
    const hasSrc = (which) => !!s.expected?.[which] && Number.isFinite(s.delay?.[which]);
    const arr = s.sched.arr ? range(carry, hasSrc("arr") ? s.delay.arr : null) : null;
    // Time made up at the halt: anything beyond a short stop.
    const halt = s.sched.arr && s.sched.dep ? Math.max(0, lateBy(s.sched.arr, s.sched.dep)) : 0;
    carry = Math.max(0, carry - Math.max(0, halt - MIN_HALT));
    const dep = s.sched.dep ? range(carry, hasSrc("dep") ? s.delay.dep : null) : null;
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
