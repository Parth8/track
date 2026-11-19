// What the extra flight data means for the person waiting: plain rules, stated here, no model.
//
// History: a flight counts as on time when it left the gate within 15 minutes of schedule (the
// airline industry's own line). "Usually" is the middle day of the recent ones (the median), so
// one bad night doesn't set it.
//
// Turnaround: the plane flying in has to land, reach the gate, unload, be cleaned, fuelled and
// boarded. MIN_TURN is about the quickest that happens for a narrow-body plane (budget carriers in
// India plan 25 to 35 minutes); a wide-body needs longer. If the inbound plane reaches the gate
// later than (our departure − MIN_TURN), our departure can't be earlier than (its arrival + MIN_TURN).

export const ON_TIME_MIN = 15;
const MIN_TURN = { narrow: 25, wide: 50 };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** { days, onTime, cancelled, typical, text, bars } from the recent days of this flight, or null. */
export function historySummary(rows) {
  const days = (rows || []).filter((r) => r.cancelled || Number.isFinite(r.depDelay));
  if (days.length < 3) return null;
  const flown = days.filter((r) => !r.cancelled && Number.isFinite(r.depDelay));
  const onTime = flown.filter((r) => r.depDelay <= ON_TIME_MIN).length;
  const cancelled = days.filter((r) => r.cancelled).length;
  const typical = median(flown.map((r) => r.depDelay));
  let usually = null;
  if (typical != null) {
    if (typical <= -5) usually = `Usually leaves ${-typical} min early`;
    else if (typical < 5) usually = "Usually leaves on time";
    else usually = `Usually leaves ${typical} min late`;
  }
  const record = `On time ${onTime} of the last ${flown.length} days`;
  return {
    days: days.length,
    onTime,
    flown: flown.length,
    cancelled,
    typical,
    text: [usually, record, cancelled ? `${cancelled} cancelled` : null].filter(Boolean),
    // Oldest first, for a left-to-right strip
    bars: [...days].reverse().map((r) => ({ date: r.date, delay: r.cancelled ? null : r.depDelay, cancelled: r.cancelled })),
  };
}

/** When the plane flying in reaches our gate: actual, live estimate, airline estimate, schedule. */
export function inboundAtGate(ib) {
  if (!ib) return null;
  if (ib.times?.in?.actual) return { at: ib.times.in.actual, how: "actual" };
  // A live landing estimate plus a few minutes to taxi in
  if (ib.liveEta) return { at: new Date(Date.parse(ib.liveEta) + 5 * 60000).toISOString(), how: "live" };
  if (ib.times?.in?.est) return { at: ib.times.in.est, how: "estimate" };
  if (ib.times?.in?.sched) return { at: ib.times.in.sched, how: "schedule" };
  return null;
}

/**
 * Whether the inbound plane can make our departure.
 * { gapMin, minTurn, verdict: "here" | "ok" | "tight" | "late", earliest (ISO, when late) }
 */
export function turnaround(f, now = Date.now()) {
  const ib = f?.inbound;
  if (!ib || f.status?.phase !== "pre" || ib.phase === "cancelled" || ib.phase === "diverted") return null;
  const gate = inboundAtGate(ib);
  const out = f.departure?.revised || f.departure?.sched;
  if (!gate || !out) return null;
  const wide = /A3[3-8]\d|A350|A380|747|767|777|787/.test(f.aircraft?.model || "");
  const minTurn = wide ? MIN_TURN.wide : MIN_TURN.narrow;
  const gapMin = Math.round((Date.parse(out) - Date.parse(gate.at)) / 60000);
  let verdict = "ok";
  if (gate.how === "actual" || (ib.landed && Date.parse(gate.at) <= now)) verdict = "here";
  else if (gapMin < minTurn) verdict = "late";
  else if (gapMin < minTurn + 15) verdict = "tight";
  const earliest = verdict === "late" ? new Date(Date.parse(gate.at) + minTurn * 60000).toISOString() : null;
  return { gapMin, minTurn, verdict, earliest, gate };
}
