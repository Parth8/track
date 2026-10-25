// My journeys: train trips you save (train, date, your stations, seat, PNR, notes), kept only on
// this device. Past ones keep a small record of how the run actually went, taken from the live
// tracker while it can still see that run (the tracker covers the last 4 days).

import { addDays, todayIn, IST } from "./util.js";

const KEY = "journeys";
const MAX = 300; // a few hundred trips is about 150 KB, far under what a browser allows a site

/**
 * A journey:
 * { id, no, name, startDate, from: { code, name }, to: { code, name }, dep, arr (scheduled ISO),
 *   schedMin, km, cls, coach, seat, pnr, notes, createdAt,
 *   pnrLinked?: true (you chose to have its status fetched),
 *   booking?: { overall, chart, platform, passengers: [{ n, kind, booking, current, coach, berth,
 *               berthType, position }], checkedAt },
 *   result?: { depSched, depActual, arrSched, arrActual, depDelay, arrDelay, travelMin, km,
 *              fromPf, toPf, complete, recordedAt } }
 */
export function loadJourneys() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((j) => j && j.id && j.no && j.dep) : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
    return true;
  } catch {
    return false; // storage full or blocked (private mode)
  }
}

const listeners = new Set();
export const onJourneysChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn());

export function addJourney(j) {
  const list = loadJourneys();
  // The same train, day and stations is the same trip: update it rather than keep two.
  const dupe = list.find((x) => x.no === j.no && x.startDate === j.startDate && x.from.code === j.from.code && x.to.code === j.to.code);
  const entry = { ...(dupe || {}), ...j, id: dupe?.id || `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: dupe?.createdAt || new Date().toISOString() };
  const next = dupe ? list.map((x) => (x.id === dupe.id ? entry : x)) : [...list, entry];
  const ok = saveAll(next);
  if (ok) changed();
  return ok ? entry : null;
}

export function updateJourney(id, patch) {
  const list = loadJourneys();
  const next = list.map((x) => (x.id === id ? { ...x, ...patch } : x));
  const ok = saveAll(next);
  if (ok) changed();
  return ok;
}

/** Remove one; returns a function that puts it back (for Undo). */
export function removeJourney(id) {
  const list = loadJourneys();
  const at = list.findIndex((x) => x.id === id);
  if (at < 0) return () => {};
  const [gone] = list.splice(at, 1);
  saveAll(list);
  changed();
  return () => {
    const now = loadJourneys();
    if (now.some((x) => x.id === gone.id)) return;
    now.splice(Math.min(at, now.length), 0, gone);
    saveAll(now);
    changed();
  };
}

export const journeyById = (id) => loadJourneys().find((x) => x.id === id) || null;

/** Bytes this list takes on the device, for an honest "stored on this device" line. */
export function journeysSize() {
  try {
    return (localStorage.getItem(KEY) || "").length * 2; // UTF-16
  } catch {
    return 0;
  }
}

/* ---------------- time ---------------- */

const endOf = (j) => Date.parse(j.result?.arrActual || j.arr);
/** "past" once you've arrived (an hour after, to be safe), otherwise "upcoming". */
export const isPast = (j, now = Date.now()) => endOf(j) + 60 * 60000 < now;
/** The live tracker can show runs that started in the last 4 days, up to today. */
export const isTrackable = (j) => j.startDate >= addDays(todayIn(IST), -3) && j.startDate <= todayIn(IST);
/** On its way right now: boarding was under 3 hours ago or soon, and it hasn't arrived. */
export const isLiveNow = (j, now = Date.now()) => isTrackable(j) && !isPast(j, now) && Date.parse(j.dep) - now < 3 * 3600000;

export function sortedJourneys(filter = "upcoming") {
  const now = Date.now();
  const list = loadJourneys();
  if (filter === "upcoming") return list.filter((j) => !isPast(j, now)).sort((a, b) => Date.parse(a.dep) - Date.parse(b.dep));
  if (filter === "past") return list.filter((j) => isPast(j, now)).sort((a, b) => Date.parse(b.dep) - Date.parse(a.dep));
  return list.sort((a, b) => Date.parse(b.dep) - Date.parse(a.dep));
}

/** The day you board, in India. */
export const boardDay = (j) => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date(j.dep));

/** Travel day: you board today, or within 6 hours (a trip just after midnight), or it's on its way. */
export const isTravelDay = (j, now = Date.now()) => isTrackable(j) && !isPast(j, now) && (boardDay(j) === todayIn(IST) || Date.parse(j.dep) - now < 6 * 3600000);

/** The next journey within a week, for the home screen. */
export function nextJourney(days = 7) {
  const now = Date.now();
  return sortedJourneys("upcoming").find((j) => Date.parse(j.dep) - now < days * 86400000) || null;
}

/* ---------------- how it actually ran ---------------- */

/**
 * Read your part of the run from the live tracker's answer: when it really left your station
 * and reached your stop, and how that compares with the timetable.
 */
export function resultFrom(j, data) {
  const stops = data?.stops || [];
  const a = stops.find((s) => s.code === j.from.code);
  const b = stops.find((s) => s.code === j.to.code);
  if (!a || !b) return null;
  const depSched = a.sched.dep || a.sched.arr;
  const arrSched = b.sched.arr || b.sched.dep;
  const depActual = a.actual.dep || null;
  const arrActual = b.actual.arr || null;
  const mins = (x, y) => (x && y ? Math.round((Date.parse(y) - Date.parse(x)) / 60000) : null);
  return {
    depSched,
    depActual,
    arrSched,
    arrActual,
    depDelay: a.delay.dep ?? mins(depSched, depActual),
    arrDelay: b.delay.arr ?? mins(arrSched, arrActual),
    travelMin: mins(depActual, arrActual),
    schedMin: mins(depSched, arrSched),
    km: b.km != null && a.km != null ? Math.round(b.km - a.km) : j.km ?? null,
    fromPf: a.platform || null,
    toPf: b.platform || null,
    complete: !!(depActual && arrActual),
    recordedAt: new Date().toISOString(),
  };
}

/** Saved journeys this answer from the tracker belongs to (same train and run). */
export const journeysForRun = (no, startDate) => loadJourneys().filter((j) => j.no === no && j.startDate === startDate);

/** Keep the record for any saved journey on this run, once there's something to keep. */
export function recordRun(no, startDate, data) {
  for (const j of journeysForRun(no, startDate)) {
    if (j.result?.complete) continue;
    const r = resultFrom(j, data);
    if (r && (r.depActual || r.arrActual)) updateJourney(j.id, { result: r });
  }
}

/** Journeys that have (or should have) finished and can still be read from the tracker. */
export const needsRecord = (now = Date.now()) =>
  loadJourneys().filter((j) => isTrackable(j) && !j.result?.complete && Date.parse(j.dep) < now);

/** A few totals for the Past tab. */
export function pastStats() {
  const past = sortedJourneys("past");
  const km = past.reduce((n, j) => n + (j.result?.km ?? j.km ?? 0), 0);
  const delays = past.map((j) => j.result?.arrDelay).filter((d) => Number.isFinite(d));
  const onTime = delays.filter((d) => d < 10).length;
  return {
    count: past.length,
    km: Math.round(km),
    recorded: delays.length,
    onTime,
    medianDelay: delays.length ? delays.sort((a, b) => a - b)[Math.floor(delays.length / 2)] : null,
  };
}

/* ---------------- booking status, from the PNR ---------------- */

/** What a PNR lookup adds to a journey. */
export function bookingFrom(data) {
  return {
    overall: data.overall,
    chart: data.chart,
    platform: data.platform || null,
    passengers: (data.passengers || []).map(({ n, kind, booking, current, coach, berth, berthType, position }) => ({ n, kind, booking, current, coach, berth, berthType, position })),
    checkedAt: data.status?.checkedAt || new Date().toISOString(),
  };
}

/**
 * When the ticket says you leave and arrive: the day you board and the boarding time, then the
 * journey time after that. Null unless the PNR gave all three.
 */
export function ticketTimes(data) {
  const day = data?.boardDate;
  const at = data?.from?.time;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || !/^\d{2}:\d{2}$/.test(at || "") || !(data.journeyMin > 0)) return null;
  const dep = Date.parse(`${day}T${at}:00+05:30`);
  return { dep: new Date(dep).toISOString(), arr: new Date(dep + data.journeyMin * 60000).toISOString(), schedMin: data.journeyMin };
}

/** The first passenger's coach and berth, once there is one, for the journey's own seat fields. */
export function seatFrom(booking) {
  const p = booking?.passengers?.find((x) => x.coach && x.berth);
  return p ? { coach: p.coach, seat: [p.berth, p.berthType ? BERTH_SHORT[p.berthType] : null].filter(Boolean).join(" ") } : null;
}
const BERTH_SHORT = { Lower: "LB", Middle: "MB", Upper: "UB", "Side lower": "SL", "Side upper": "SU", "Side middle": "SM", Window: "WS", Aisle: "AS" };

/**
 * How often a linked booking is worth checking again. Waitlists move most in the last day and
 * at the chart, so checks get closer as the trip nears; a prepared chart with every seat
 * confirmed won't change, so it stops.
 */
export function bookingDueMs(j, now = Date.now()) {
  if (!j.pnrLinked || !j.pnr || isPast(j, now)) return null;
  const b = j.booking;
  if (b?.chart === "prepared" && b.overall === "confirmed") return null;
  const until = Date.parse(j.dep) - now;
  if (until < -3600000) return null; // you're on board by now
  const every = until > 3 * 86400000 ? 12 * 3600000 : until > 86400000 ? 4 * 3600000 : until > 6 * 3600000 ? 3600000 : 15 * 60000;
  const age = b?.checkedAt ? now - Date.parse(b.checkedAt) : Infinity;
  return Math.max(0, every - age);
}
export const bookingDue = (j, now) => bookingDueMs(j, now) === 0;

/** A booking's state in a few words, for a chip: "Confirmed", "WL 12", "RAC 3", "2 of 3 confirmed". */
export function bookingChip(b) {
  if (!b?.passengers?.length) return null;
  const ps = b.passengers;
  const worst = ps.find((p) => p.kind === "waitlist") || ps.find((p) => p.kind === "rac");
  if (b.overall === "confirmed") return { cls: "ok", text: "Confirmed" };
  if (b.overall === "cancelled") return { cls: "bad", text: "Cancelled" };
  if (b.overall === "partly") return { cls: "warn", text: `${ps.filter((p) => p.kind === "confirmed").length} of ${ps.length} confirmed` };
  if (worst?.kind === "waitlist") return { cls: "warn", text: worst.position ? `WL ${worst.position}` : "Waitlisted" };
  if (worst?.kind === "rac") return { cls: "info", text: worst.position ? `RAC ${worst.position}` : "RAC" };
  return null;
}

/* ---------------- finding your coach, and your berth inside it ---------------- */

// Standard berth numbering, repeating every bay. In each bay of 3A and Sleeper, berths 1–6 face
// each other on the main side (lower, middle, upper twice) and 7–8 run along the side; 2A has
// no middle berths. Most coaches of a class have the same number of bays.
const LAYOUTS = {
  "3A": { per: ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"], bays: 9 },
  SL: { per: ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"], bays: 9 },
  "2A": { per: ["LB", "UB", "LB", "UB", "SL", "SU"], bays: 8 },
};
export const BERTH_NAMES = { LB: "Lower", MB: "Middle", UB: "Upper", SL: "Side lower", SU: "Side upper" };

/**
 * Where a berth is in its coach: its type, its bay (counting from berth 1's end), the berths in
 * that bay, and each berth's place, for a drawing. Null for classes without a standard layout.
 */
export function berthGuide(cls, berth) {
  const L = LAYOUTS[cls];
  const n = Number(berth);
  if (!L || !Number.isInteger(n) || n < 1 || n > 90) return null;
  const size = L.per.length;
  const bay = Math.ceil(n / size);
  const first = (bay - 1) * size + 1;
  return {
    cls,
    berth: n,
    type: L.per[(n - 1) % size],
    bay,
    bays: Math.max(L.bays, bay),
    first,
    last: first + size - 1,
    side: (n - 1) % size >= size - 2,
    places: L.per.map((type, i) => ({ type, n: first + i })),
  };
}

/** Seat "34 LB" or "59" → the berth number. */
export const berthNo = (seat) => Number((/(\d{1,3})/.exec(String(seat || "")) || [])[1]) || null;

const COACH_M = 24; // an LHB coach is about 24 m long

/**
 * From the coach you're standing at to yours, in coaches. Works whichever way the train faces,
 * because it only uses the order: "8 coaches, towards S3".
 */
export function coachWalk(order, fromIndex, coachId) {
  const to = order.findIndex((c) => c.id === coachId);
  if (to < 0 || fromIndex < 0 || fromIndex >= order.length) return null;
  const steps = to - fromIndex;
  if (steps === 0) return { steps: 0, toward: null, meters: 0 };
  return { steps: Math.abs(steps), toward: order[fromIndex + Math.sign(steps)].id, meters: Math.round((Math.abs(steps) * COACH_M) / 10) * 10 };
}

/* ---------------- calendar ---------------- */

const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/** A calendar event for the trip, with a reminder 3 hours before, to open in any calendar app. */
export function journeyIcs(j, link) {
  const seat = [j.cls, j.coach, j.seat].filter(Boolean).join(" · ");
  const lines = [
    `Train ${j.no} ${j.name || ""}`.trim(),
    `${j.from.name} (${j.from.code}) to ${j.to.name} (${j.to.code})`,
    seat ? `Seat: ${seat}` : null,
    j.pnr ? `PNR: ${j.pnr}` : null,
    j.notes ? `Notes: ${j.notes}` : null,
    link ? `Live status: ${link}` : null,
  ].filter(Boolean);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Track//My journeys//EN",
    "BEGIN:VEVENT",
    `UID:${j.id}@track`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(j.dep)}`,
    `DTEND:${icsTime(j.arr)}`,
    `SUMMARY:${icsText(`🚆 ${j.no} ${j.from.code} → ${j.to.code}`)}`,
    `LOCATION:${icsText(`${j.from.name} railway station`)}`,
    `DESCRIPTION:${icsText(lines.join("\n"))}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT3H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(`Train ${j.no} leaves ${j.from.name} in 3 hours`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
