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
//  5. Delays grow too, mostly near big junctions where trains queue for a platform. The top of the
//     range rises by GROWTH of the scheduled running time ahead, plus a little for every minute
//     the report is old beyond a few (a train nobody has reported for a while is often held).
//     From the real run: 23 min late at Channasandra became 39 at Baiyyappanahalli, 25 min later.
//  6. The clock. What's known for certain is that the train hadn't reached a stop ahead when the
//     last report came in, so its delay there is at least (report time − schedule), carried on to
//     every stop after it. Past that, "not reported" is weak evidence when reports are old (the
//     train often passes stops before anyone says so), so the clock only does two things: a
//     time already past is shown as "due now", never as an upcoming time, and the top of the
//     range reaches (now − schedule).
// Every stop ahead gets `est: { arr, dep }`, each { lo, hi, likely } in minutes late, and its
// expected times set from `likely`. Stops already passed keep their actual times, untouched.

const MIN_HALT = 2; // minutes: about the shortest stop a train makes at a scheduled halt
// The share of scheduled running time a late train can make up between stops. Set from a real
// run (12785, 6 Nov 2026): 27 min late at Yelahanka was projected 13 min late at KSR Bengaluru,
// about 19% of the running time between them.
const RECOVERY = 0.2;
const SLACK = 2; // minutes of rounding allowed before a source's projection counts as implausible
const GROWTH = 0.25; // share of running time ahead a delay can plausibly grow by
const AGE_FREE = 5; // minutes a report can be old before it widens the range
const AGE_GROWTH = 0.5; // minutes of possible extra delay per minute of report age beyond that
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

const notBefore = (iso, now) => (iso && Date.parse(iso) < now ? new Date(Math.floor(now / MIN) * MIN).toISOString().replace(".000Z", "Z") : iso);

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
export function projectRun(j, now = Date.now()) {
  if (!j?.stops?.length || j.status?.phase !== "running") return j;
  const halts = j.stops.filter((s) => s.halts);
  const anchor = anchorOf(j, halts);
  if (!anchor) return j;
  const ahead = new Set(halts.slice(anchor.from).filter((s) => !s.passed && !s.actual?.arr && !s.actual?.dep));
  let carry = Math.max(0, anchor.delay); // a late train doesn't leave a halt early
  let floor = carry; // the least late it could plausibly be
  let prev = halts[anchor.from - 1] || null; // the last halt behind the train
  let first = true;
  const ageMin = j.status?.lastUpdated ? Math.max(0, (now - Date.parse(j.status.lastUpdated)) / MIN) : 0;
  let grow = Math.max(0, ageMin - AGE_FREE) * AGE_GROWTH; // how much worse it could plausibly be
  const lateAt = (t, sched) => (sched && Number.isFinite(t) ? (t - Date.parse(sched)) / MIN : -Infinity);
  const reportAt = j.status?.lastUpdated ? Date.parse(j.status.lastUpdated) : NaN;
  const stops = j.stops.map((s) => {
    if (!ahead.has(s)) return s;
    // Running time from the last halt to this one; if the train is already part-way, only what's left.
    let run = prev ? Math.max(0, lateBy(prev.sched.dep || prev.sched.arr, s.sched.arr || s.sched.dep) || 0) : 0;
    const km = j.position?.kmDone;
    if (first && prev && Number.isFinite(km) && s.km > prev.km) run *= Math.min(1, Math.max(0, (s.km - km) / (s.km - prev.km)));
    first = false;
    prev = s;
    floor = Math.max(0, floor - RECOVERY * run);
    grow += GROWTH * run;
    const range = (carried, least, source, sched) => {
      const src = Number.isFinite(source) ? Math.max(0, source) : null;
      const overruled = src != null && src < least - SLACK; // more recovery than is plausible
      // Not there when the last report came in: at least that late, for certain.
      const known = lateAt(reportAt, sched);
      let likely = Math.max(src == null ? carried : overruled ? least : src, known);
      const lo = Math.max(Math.min(least, likely), known);
      const nowLate = lateAt(now, sched);
      const due = nowLate > likely; // its likely time has passed with no report
      const hi = Math.max(Math.max(carried, likely) + grow, due ? nowLate : -Infinity);
      return { lo: Math.round(lo), hi: Math.round(hi), likely: Math.round(likely), overruled, due, known: known > 0 ? Math.round(known) : null };
    };
    const hasSrc = (which) => !!s.expected?.[which] && Number.isFinite(s.delay?.[which]);
    const arr = s.sched.arr ? range(carry, floor, hasSrc("arr") ? s.delay.arr : null, s.sched.arr) : null;
    if (arr?.known != null) {
      // What the last report proves carries on to every stop after this one.
      carry = Math.max(carry, arr.known);
      floor = Math.max(floor, arr.known);
    }
    // Time made up at the halt: anything beyond a short stop.
    const halt = s.sched.arr && s.sched.dep ? Math.max(0, lateBy(s.sched.arr, s.sched.dep)) : 0;
    carry = Math.max(0, carry - Math.max(0, halt - MIN_HALT));
    floor = Math.max(0, floor - Math.max(0, halt - MIN_HALT));
    const dep = s.sched.dep ? range(carry, floor, hasSrc("dep") ? s.delay.dep : null, s.sched.dep) : null;
    if (dep?.known != null) {
      carry = Math.max(carry, dep.known);
      floor = Math.max(floor, dep.known);
    }
    return {
      ...s,
      // A time already gone by is shown as now: "due now", never as something still to come.
      expected: { arr: arr ? notBefore(plus(s.sched.arr, arr.likely), now) : null, dep: dep ? notBefore(departs(s, arr, dep), now) : null },
      delay: { arr: arr?.likely ?? null, dep: dep?.likely ?? null },
      est: { arr, dep },
    };
  });
  return { ...j, stops, projection: { from: anchor.delay, at: anchor.at >= 0 ? halts[anchor.at].code : null, ageMin: Math.round(ageMin) } };
}

/** "20–25m late", "~27m late", "on time", from a stop's estimate. */
export function estText(e) {
  if (!e) return null;
  if (e.due) return "due now, not reported yet";
  if (e.hi < 3) return "on time";
  if (e.hi - e.lo < 3) return `~${e.likely}m late`;
  return `${e.lo}–${e.hi}m late`;
}
