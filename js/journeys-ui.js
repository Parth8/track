// My journeys: the list (Upcoming, Past, All), swipe left to delete with Undo, a journey's
// details, and the sheet for adding or editing one. Everything stays on this device.

import { h, svg, clock, timeNode, dayShift, duration, fmtMin, longDate, addDays, todayIn, IST, ago, prefersReducedMotion } from "./util.js";
import { icons } from "./icons.js";
import { api, ApiError } from "./api.js";
import { stationField, shortDay } from "./finder.js";
import { stationSource } from "./stations.js";
import {
  loadJourneys,
  addJourney,
  updateJourney,
  removeJourney,
  journeyById,
  journeysSize,
  sortedJourneys,
  isPast,
  isTrackable,
  isLiveNow,
  pastStats,
  journeyIcs,
  boardDay,
  ticketTimes,
  bookingFrom,
  seatFrom,
  bookingDue,
  bookingChip,
} from "./journeys.js";

const today = () => todayIn(IST);
const CLASS_NAMES = { "1A": "AC First Class", "2A": "AC 2 Tier", "3A": "AC 3 Tier", "3E": "AC 3 Economy", EA: "Anubhuti", EC: "Executive Chair", EV: "Vistadome", CC: "AC Chair Car", FC: "First Class", SL: "Sleeper", "2S": "Second Sitting" };
const daysUntil = (iso) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000);
const boardDate = boardDay;
const trackLink = (j) => ({ m: "train", no: j.no, d: j.startDate, s: j.to.code });
const PNR_PRIVACY = "Your PNR goes through Track's server to RailYatri's public PNR status, only to read your booking. It isn't logged or stored there, and the booking is kept on this device.";

/**
 * Check a saved journey's booking against its PNR and keep what changed. Returns a line worth
 * telling you ("now confirmed: B3 59"), or null when nothing that matters moved.
 */
export async function checkBooking(j, { fresh = false } = {}) {
  const data = await api("/api/pnr", { pnr: j.pnr, fresh: fresh ? 1 : null }, { timeout: 45000, retries: 0 });
  if (data.no !== j.no) throw new ApiError("pnr_other_train", `This PNR is for train ${data.no}, not ${j.no}.`, 409);
  const before = j.booking;
  const booking = bookingFrom(data);
  updateJourney(j.id, { booking, pnrLinked: true, cls: j.cls || data.cls || null, ...(seatFrom(booking) || {}), ...(ticketTimes(data) || {}) });
  return bookingNews(j, before, booking);
}

function bookingNews(j, before, after) {
  if (!before) return null;
  const seat = seatFrom(after);
  const where = seat ? `: ${seat.coach} ${seat.seat}` : "";
  if (before.overall !== "confirmed" && after.overall === "confirmed") return `${j.no} on ${shortDay(boardDate(j))} is confirmed${where}`;
  if (before.chart !== "prepared" && after.chart === "prepared") return `Chart prepared for ${j.no}${where}`;
  const a = bookingChip(before)?.text;
  const b = bookingChip(after)?.text;
  return a && b && a !== b ? `${j.no} on ${shortDay(boardDate(j))} moved from ${a} to ${b}` : null;
}

/** "B3 · 59 Lower", "RAC 7", "Waitlist 12", from one passenger. */
function passengerLine(p) {
  if (p.coach && p.berth) return [p.coach, [p.berth, p.berthType].filter(Boolean).join(" ")].join(" · ");
  if (p.kind === "waitlist") return p.position ? `Waitlist ${p.position}` : "Waitlisted";
  if (p.kind === "rac") return p.position ? `RAC ${p.position}` : "RAC";
  if (p.kind === "cancelled") return "Cancelled";
  return p.current || "Status not shown";
}
const KIND_WORD = { confirmed: "Confirmed", rac: "RAC", waitlist: "Waitlist", cancelled: "Cancelled", unknown: "" };

/**
 * Who's travelling on the booking: one row each, so a solo trip is one line and a family of six
 * is six. Public PNR status shows seats, not names, so they're Passenger 1, 2 and so on.
 */
function passengersBlock(b) {
  const ps = b.passengers || [];
  return h(
    "ol",
    { class: `jn-pax${ps.length === 1 ? " solo" : ""}`, "aria-label": `${ps.length} passenger${ps.length > 1 ? "s" : ""}` },
    ps.map((p) =>
      h(
        "li",
        { class: `jn-pax-row ${p.kind}` },
        h("span", { class: "jn-pax-n", "aria-hidden": "true", text: String(p.n) }),
        h("span", { class: "jn-pax-who" }, h("b", { text: passengerLine(p) }), h("small", { text: `Passenger ${p.n}${p.booking ? ` · booked ${p.booking}` : ""}` })),
        KIND_WORD[p.kind] ? h("span", { class: `jn-pax-kind ${p.kind}`, text: KIND_WORD[p.kind] }) : null
      )
    )
  );
}

function pnrError(e) {
  if (!(e instanceof ApiError)) return "Couldn't check the booking just now.";
  if (e.code === "pnr_not_found" || e.code === "invalid_pnr" || e.code === "pnr_other_train") return e.message;
  if (e.code === "network" || e.code === "timeout") return "Couldn't reach the booking status. Check your connection and try again.";
  return "PNR status is slow right now. Try again in a minute.";
}

/**
 * Upcoming journeys whose booking is due a look, checked one at a time (a few at most) when the
 * app opens or you open My journeys. Tells you only when something changed.
 */
let sweeping = false;
export async function checkDueBookings(toast, { max = 3 } = {}) {
  if (sweeping || !navigator.onLine) return 0;
  sweeping = true;
  let n = 0;
  try {
    const due = sortedJourneys("upcoming").filter((j) => bookingDue(j) && Date.parse(j.dep) - Date.now() < 30 * 86400000);
    for (const j of due.slice(0, max)) {
      try {
        const news = await checkBooking(j);
        n++;
        if (news) toast(news);
      } catch {
        /* try again next time */
      }
    }
  } finally {
    sweeping = false;
  }
  return n;
}

/**
 * Share a trip: a message with a link that opens this train's live status at your stop, so
 * whoever's picking you up sees when you'll actually arrive.
 */
export async function shareTrip(j, toast) {
  const url = new URL(`?m=train&no=${j.no}&d=${j.startDate}&s=${j.to.code}`, location.href.split("?")[0]).href;
  const bd = boardDate(j);
  const text = `I'm taking train ${j.no} ${j.name || ""} from ${j.from.name} on ${longDate(bd)}, due at ${j.to.name} at ${clock(j.arr)}${dayShift(j.arr, bd) > 0 ? " the next day" : ""}. Follow it live:`.replace(/\s+/g, " ");
  try {
    if (navigator.share) return void (await navigator.share({ title: `Train ${j.no} to ${j.to.name}`, text, url }));
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast("Trip link copied. It opens live status at your stop.");
  } catch {
    toast("Couldn't share the trip");
  }
}

/** Chart and overall state, with when it was checked. */
function bookingHead(b) {
  const chip = bookingChip(b);
  const chart = b.chart === "prepared" ? "Chart prepared" : b.chart === "not_prepared" ? "Chart not prepared yet" : null;
  return h(
    "p",
    { class: "jn-bk-head" },
    ...[chip ? h("span", { class: `chip ${chip.cls}`, text: chip.text }) : null, chart ? h("span", { class: "jn-bk-chart", text: chart }) : null, b.checkedAt ? h("small", { text: `Checked ${ago(b.checkedAt)}` }) : null].filter(Boolean)
  );
}

/** How it went, as a chip: "42 min late", "On time", "5 min early". */
function resultChip(r) {
  if (!r || !Number.isFinite(r.arrDelay)) return null;
  if (r.arrDelay >= 10) return { cls: "late", text: `${fmtMin(r.arrDelay)} late` };
  if (r.arrDelay <= -3) return { cls: "early", text: `${fmtMin(-r.arrDelay)} early` };
  return { cls: "ok", text: "On time" };
}

/** When it is, in words: "Live now", "Today", "Tomorrow", "In 5 days". */
function whenChip(j) {
  if (isLiveNow(j)) return { cls: "accent live", text: "On its way" };
  const d = daysUntil(boardDate(j));
  if (d <= 0) return { cls: "accent", text: "Today" };
  if (d === 1) return { cls: "info", text: "Tomorrow" };
  return { cls: "quiet", text: d < 30 ? `In ${d} days` : shortDay(boardDate(j)) };
}

/** The day a moment falls on in India, "Sat 14 Nov", so each end of a trip says its own date. */
const dayOf = (iso) => shortDay(boardDay({ dep: iso }));
/** The timetable's journey time, in minutes. */
const tripMin = (j) => j.schedMin ?? Math.round((Date.parse(j.arr) - Date.parse(j.dep)) / 60000);

const seatText = (j) => [j.cls, j.coach, j.seat].filter(Boolean).join(" · ");

/* ================================================================== */
/* The list                                                            */
/* ================================================================== */

export function createJourneysView({ root, navigate, toast, sheets }) {
  let filter = "upcoming";

  function card(j, i) {
    const past = isPast(j);
    const r = j.result;
    const chip = past ? resultChip(r) : whenChip(j);
    const dep = (past && r?.depActual) || j.dep;
    const arr = (past && r?.arrActual) || j.arr;
    const bd = boardDate(j);
    const [wd, dd, mm] = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: IST })
      .formatToParts(new Date(j.dep))
      .filter((p) => p.type !== "literal")
      .map((p) => p.value);
    // A booking still on the waitlist or RAC says so on the card; a confirmed one just shows its seat.
    const bk = !past ? bookingChip(j.booking) : null;
    const bkChip = bk && bk.cls !== "ok" ? bk : null;
    const pax = j.booking?.passengers?.length || 0;
    const seatLine = [seatText(j), pax > 1 ? `${pax} travellers` : null].filter(Boolean).join(" · ");
    const spoken = `${j.no} ${j.name}, ${longDate(bd)}. ${j.from.name} at ${clock(dep)} to ${j.to.name} at ${clock(arr)}.${chip ? ` ${chip.text}.` : ""}${bkChip ? ` Booking ${bkChip.text}.` : ""}${seatLine ? ` ${seatLine}.` : ""} ${isTrackable(j) && !past ? "Opens live status." : "Opens details."}`;

    const face = h(
      "button",
      { type: "button", class: `jcard${past ? " past" : ""}`, "aria-label": spoken, "data-id": j.id },
      h("span", { class: "jc-date", "aria-hidden": "true" }, h("small", { text: wd }), h("b", { text: dd }), h("small", { text: mm })),
      h(
        "span",
        { class: "jc-body", "aria-hidden": "true" },
        h(
          "span",
          { class: "jc-top" },
          h("span", { class: "jc-times" }, timeNode(dep), h("i", { text: "→" }), timeNode(arr, IST, { shift: Math.max(0, dayShift(arr, bd)) })),
          chip ? h("span", { class: `chip ${chip.cls}`, text: chip.text }) : null
        ),
        h("span", { class: "jc-route" }, h("b", { text: j.from.name }), h("span", { class: "jc-arrow", text: " to " }), h("b", { text: j.to.name })),
        h("span", { class: "jc-train" }, h("span", { class: "tn", text: j.no }), ` ${j.name}`),
        seatLine || bkChip || j.notes
          ? h(
              "span",
              { class: "jc-meta" },
              bkChip ? h("span", { class: `chip small ${bkChip.cls}`, text: bkChip.text }) : null,
              seatLine ? h("span", {}, svg(icons.seat), seatLine) : null,
              j.notes ? h("span", { class: "jc-note" }, svg(icons.note), j.notes) : null
            )
          : null
      )
    );
    const del = h("button", { type: "button", class: "jcard-del", tabindex: "-1", "aria-label": `Delete ${j.no} on ${longDate(bd)}` }, svg(icons.trash), h("span", { text: "Delete" }));
    const li = h("li", { class: "jcard-wrap", vars: { "--i": String(i) } }, del, face);
    del.addEventListener("click", () => remove(j, li));
    face.addEventListener("click", (e) => {
      if (li.dataset.swiped) return void (delete li.dataset.swiped, e.preventDefault());
      if (li.classList.contains("open")) return close(li);
      if (!past && isTrackable(j)) navigate(trackLink(j), { state: { from: "journeys" } });
      else sheets.openDetail(j.id);
    });
    swipeToDelete(li, face, () => remove(j, li));
    return li;
  }

  function close(li) {
    li.classList.remove("open");
    li.querySelector(".jcard").style.transform = "";
    li.querySelector(".jcard-del").tabIndex = -1;
  }

  /** Delete, folding the row away, with Undo in the toast. */
  function remove(j, li) {
    const undo = removeJourney(j.id);
    const done = () => paint();
    if (prefersReducedMotion() || !li) done();
    else {
      li.style.height = `${li.offsetHeight}px`;
      li.classList.add("going");
      requestAnimationFrame(() => (li.style.height = "0px"));
      setTimeout(done, 320);
    }
    toast(`Deleted ${j.no} on ${shortDay(boardDate(j))}`, { label: "Undo", run: () => (undo(), paint()) });
  }

  function paint() {
    const all = loadJourneys();
    const counts = { upcoming: sortedJourneys("upcoming").length, past: sortedJourneys("past").length, all: all.length };
    const list = sortedJourneys(filter);
    const tabs = h(
      "div",
      { class: "segmented three jn-tabs", role: "radiogroup", "aria-label": "Show journeys" },
      [
        ["upcoming", "Upcoming"],
        ["past", "Past"],
        ["all", "All"],
      ].map(([k, label]) =>
        h(
          "button",
          { type: "button", role: "radio", "aria-checked": String(filter === k), on: { click: () => ((filter = k), paint()) } },
          label,
          counts[k] ? h("small", { class: "jn-count", text: String(counts[k]) }) : null
        )
      )
    );

    const nodes = [tabs];
    if (filter === "past" && counts.past) {
      const st = pastStats();
      const bits = [
        `${st.count} trip${st.count > 1 ? "s" : ""}`,
        st.km ? `${st.km.toLocaleString("en-IN")} km on rails` : null,
        st.recorded ? `${st.onTime} of ${st.recorded} on time` : null,
        st.medianDelay != null && st.recorded >= 3 ? (st.medianDelay >= 10 ? `usually ${fmtMin(st.medianDelay)} late` : "usually on time") : null,
      ].filter(Boolean);
      nodes.push(h("p", { class: "jn-stats" }, bits.map((b) => h("span", { text: b }))));
    }

    if (!list.length) {
      const msg = {
        upcoming: ["No upcoming journeys", "Add your next train to keep its date, seat and PNR in one place, a tap away from live status."],
        past: ["No past journeys yet", "Once a trip is over it moves here, with how it actually ran: when you left, when you arrived, and the delay."],
        all: ["No journeys yet", "Add a train trip to keep its date, seat and PNR in one place."],
      }[filter];
      nodes.push(
        h(
          "div",
          { class: "empty compact jn-empty" },
          h("span", { class: "err-icon" }, svg(icons.calendar)),
          h("h2", { class: "display", text: msg[0] }),
          h("p", { text: msg[1] }),
          filter !== "past" ? h("button", { type: "button", class: "cta", on: { click: () => sheets.openAdd() } }, svg(icons.plus), "Add a journey") : null
        )
      );
    } else {
      // Grouped by month, the way a diary reads.
      const groups = new Map();
      for (const j of list) {
        const k = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: IST }).format(new Date(j.dep));
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(j);
      }
      let i = 0;
      for (const [month, items] of groups) {
        nodes.push(h("h2", { class: "jn-month", text: month }), h("ol", { class: "jn-list", "aria-label": month }, items.map((j) => card(j, i++))));
      }
      nodes.push(h("p", { class: "jn-hint", text: "Swipe a journey left to delete it, or open it for more." }));
    }
    const kb = Math.max(1, Math.round(journeysSize() / 1024));
    nodes.push(
      h(
        "p",
        { class: "jn-device" },
        svg(icons.info),
        `Kept only on this device (${all.length ? `${kb} KB` : "nothing yet"}). A PNR leaves it only when you ask for its status, to look up the booking.`
      )
    );
    root.replaceChildren(...nodes);
  }

  // Tapping anywhere else closes a row left half-swiped open.
  document.addEventListener("pointerdown", (e) => {
    for (const li of root.querySelectorAll(".jcard-wrap.open")) if (!li.contains(e.target)) close(li);
  });

  return {
    open(f) {
      if (f) filter = f;
      paint();
      checkDueBookings(toast).then((n) => n && !root.closest("[hidden]") && paint());
    },
    paint,
  };
}

/**
 * Swipe left on a row: it follows your finger; let go past halfway and it's deleted, or past
 * a short distance and it stays open on its Delete button. Vertical scrolling is untouched.
 */
function swipeToDelete(li, face, onDelete) {
  let x0 = 0;
  let y0 = 0;
  let dx = 0;
  let dragging = false;
  let decided = false;
  let id = null;
  const OPEN = 96;

  face.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    x0 = e.clientX;
    y0 = e.clientY;
    dx = 0;
    dragging = true;
    decided = false;
    id = e.pointerId;
  });
  face.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== id) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx)) return void (dragging = false); // a scroll, not a swipe
      face.setPointerCapture(id);
      li.classList.add("dragging");
    }
    const base = li.classList.contains("open") ? -OPEN : 0;
    dx = Math.min(0, base + mx);
    // a little resistance past the button, like a native list
    const shown = dx < -OPEN ? -OPEN + (dx + OPEN) * 0.6 : dx;
    face.style.transform = `translateX(${shown}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    li.classList.remove("dragging");
    if (!decided) return;
    li.dataset.swiped = "1";
    const w = face.offsetWidth;
    if (dx < -w * 0.5) {
      face.style.transform = `translateX(${-w}px)`;
      onDelete();
    } else if (dx < -OPEN * 0.55) {
      li.classList.add("open");
      face.style.transform = `translateX(${-OPEN}px)`;
      li.querySelector(".jcard-del").tabIndex = 0;
    } else {
      li.classList.remove("open");
      face.style.transform = "";
    }
    setTimeout(() => delete li.dataset.swiped, 50);
  };
  face.addEventListener("pointerup", end);
  face.addEventListener("pointercancel", end);
  // Keyboard: Delete or Backspace on a focused journey.
  face.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onDelete();
    }
  });
}

/* ================================================================== */
/* Sheets: details, and add or edit                                    */
/* ================================================================== */

export function createJourneySheets({ navigate, toast, onSaved }) {
  const detail = sheet("journey-detail");
  const add = sheet("journey-add");

  function sheet(id) {
    const titleId = `${id}-title`;
    const body = h("div", { class: "jn-sheet-body" });
    const title = h("h2", { class: "display", id: titleId });
    const closeBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Close" }, svg(icons.close));
    const d = h(
      "dialog",
      { class: "sheet jn-sheet", id, "aria-labelledby": titleId },
      h("div", { class: "sheet-inner" }, h("span", { class: "sheet-grab", "aria-hidden": "true" }), h("div", { class: "sheet-head" }, title, closeBtn), body)
    );
    closeBtn.addEventListener("click", () => d.close());
    d.addEventListener("click", (e) => e.target === d && d.close());
    document.body.append(d);
    return { d, title, body };
  }

  /* ---------------- details ---------------- */

  function openDetail(jid) {
    const j = journeyById(jid);
    if (!j) return;
    const past = isPast(j);
    const r = j.result;
    const bd = boardDate(j);
    detail.title.textContent = `${j.from.code} to ${j.to.code}`;
    const row = (label, value, sub) => h("div", { class: "jn-row" }, h("span", { text: label }), h("span", {}, value, sub ? h("small", { text: sub }) : null));
    const leg = (side) => {
      const s = side === "from" ? j.from : j.to;
      const sched = side === "from" ? j.dep : j.arr;
      const actual = past && r ? (side === "from" ? r.depActual : r.arrActual) : null;
      const delay = r ? (side === "from" ? r.depDelay : r.arrDelay) : null;
      const pf = r ? (side === "from" ? r.fromPf : r.toPf) : side === "from" && j.booking?.platform ? `${j.booking.platform} (tentative)` : null;
      const shift = Math.max(0, dayShift(actual || sched, bd));
      return h(
        "div",
        { class: "jn-leg" },
        h("span", { class: "jn-leg-dot", "aria-hidden": "true" }),
        h("div", {}, h("p", { class: "jn-leg-place" }, h("b", { text: s.name }), h("span", { class: "tc-code", text: s.code })), h("p", { class: "jn-leg-sub", text: [side === "from" ? "Board" : "Get off", pf ? `PF ${pf}` : null].filter(Boolean).join(" · ") })),
        h(
          "div",
          { class: "jn-leg-time" },
          timeNode(actual || sched, IST, { shift }),
          h("small", { class: "jn-leg-day", text: dayOf(actual || sched) }),
          actual && Number.isFinite(delay) && Math.abs(delay) >= 3 ? h("small", { text: `planned ${clock(sched)}` }) : null
        )
      );
    };

    const nodes = [
      h("p", { class: "jn-sub" }, h("b", { text: `${j.no} ${j.name}` }), h("span", { text: longDate(bd) })),
      h(
        "div",
        { class: "jn-legs" },
        leg("from"),
        tripMin(j) > 0 ? h("p", { class: "jn-leg-dur" }, svg(icons.clock), `${duration(tripMin(j) * 60000)} journey`) : null,
        leg("to")
      ),
    ];

    if (past) {
      if (r && (r.depActual || r.arrActual)) {
        const chip = resultChip(r);
        const diff = r.travelMin != null && r.schedMin != null ? r.travelMin - r.schedMin : null;
        const tiles = [
          chip ? ["Arrived", chip.text, r.arrActual ? `at ${clock(r.arrActual)}` : null, chip.cls] : null,
          r.travelMin != null ? ["On board", duration(r.travelMin * 60000), diff == null ? null : Math.abs(diff) < 5 ? "as the timetable says" : `${fmtMin(Math.abs(diff))} ${diff > 0 ? "longer" : "shorter"} than the timetable's ${duration(r.schedMin * 60000)}`] : null,
          Number.isFinite(r.depDelay) ? ["Left", Math.abs(r.depDelay) < 3 ? "On time" : `${fmtMin(Math.abs(r.depDelay))} ${r.depDelay > 0 ? "late" : "early"}`, r.depActual ? `at ${clock(r.depActual)}` : null] : null,
          r.km ? ["Distance", `${r.km.toLocaleString("en-IN")} km`, r.travelMin ? `${Math.round((r.km / r.travelMin) * 60)} km/h on average` : null] : null,
        ].filter(Boolean);
        nodes.push(
          h("p", { class: "sheet-label", text: "How it ran" }),
          h("div", { class: "jn-tiles" }, tiles.map(([l, v, s, cls]) => h("div", { class: `jn-tile${cls ? ` ${cls}` : ""}` }, h("span", { text: l }), h("strong", { text: v }), s ? h("small", { text: s }) : null))),
          !r.complete ? h("p", { class: "jn-fine", text: "Recorded while the trip was on. The final arrival wasn't reported in time." }) : null
        );
      } else {
        nodes.push(h("p", { class: "jn-fine", text: "We couldn't record how this trip ran. Track keeps a record when it can still see the run, up to 3 days after it starts. Open it in the app during or soon after your trip next time." }));
      }
    } else {
      const d = daysUntil(bd);
      nodes.push(
        h(
          "p",
          { class: "jn-when" },
          svg(icons.clock),
          isLiveNow(j) ? "On its way now." : isTrackable(j) ? "Live status is ready." : `Live status opens ${j.startDate === bd ? "on the day" : `on ${shortDay(j.startDate)}, when its run starts`}.`,
          d > 0 ? ` That's ${d === 1 ? "tomorrow" : `in ${d} days`}.` : ""
        )
      );
    }

    nodes.push(h("p", { class: "sheet-label", text: "Your booking" }));
    const checkNow = async (btn) => {
      btn.disabled = true;
      btn.classList.add("spinning");
      try {
        const news = await checkBooking(journeyById(j.id) || j, { fresh: true });
        toast(news || "Booking status is up to date");
      } catch (e) {
        toast(pnrError(e));
      }
      if (detail.d.open && detail.d.dataset.id === j.id) openDetail(j.id);
      onSaved?.();
    };
    if (j.booking) {
      nodes.push(
        h(
          "div",
          { class: "jn-bk" },
          bookingHead(j.booking),
          passengersBlock(j.booking),
          !past && j.pnr
            ? h("button", { type: "button", class: "pill-btn jn-bk-refresh", on: { click: (e) => checkNow(e.currentTarget) } }, svg(icons.refresh), "Check again")
            : null
        )
      );
    } else if (j.pnr && !past) {
      nodes.push(
        h(
          "div",
          { class: "jn-bk empty" },
          h("p", { class: "jn-fine", text: "See whether it's confirmed, your coach and berth, and the chart, from your PNR." }),
          h("button", { type: "button", class: "pill-btn jn-bk-refresh", on: { click: (e) => checkNow(e.currentTarget) } }, svg(icons.ticket), "Get booking status"),
          h("p", { class: "jn-fine small", text: PNR_PRIVACY })
        )
      );
    }
    const pnr = j.pnr
      ? h(
          "button",
          {
            type: "button",
            class: "jn-copy",
            "aria-label": `Copy PNR ${j.pnr.split("").join(" ")}`,
            on: {
              click: async () => {
                try {
                  await navigator.clipboard.writeText(j.pnr);
                  toast("PNR copied");
                } catch {
                  toast("Couldn't copy the PNR");
                }
              },
            },
          },
          h("span", { class: "tn", text: j.pnr.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3") }),
          svg(icons.copy)
        )
      : h("span", { class: "jn-none", text: "Not added" });
    nodes.push(
      h(
        "div",
        { class: "jn-rows" },
        row("Class", j.cls ? `${j.cls}` : h("span", { class: "jn-none", text: "Not added" }), j.cls ? CLASS_NAMES[j.cls] : null),
        row("Coach and seat", j.coach || j.seat ? [j.coach, j.seat].filter(Boolean).join(" · ") : h("span", { class: "jn-none", text: "Not added" })),
        row("PNR", pnr),
        j.notes ? row("Notes", j.notes) : null
      )
    );

    const actions = [];
    if (!past && isTrackable(j))
      actions.push(h("button", { type: "button", class: "cta", on: { click: () => (detail.d.close(), navigate(trackLink(j), { state: { from: "journeys" } })) } }, "Track live", svg(icons.next)));
    if (!past) actions.push(h("button", { type: "button", class: "cta secondary", on: { click: () => shareTrip(j, toast) } }, svg(icons.share), "Share trip"));
    if (!past) actions.push(h("button", { type: "button", class: "cta secondary", on: { click: () => downloadIcs(j) } }, svg(icons.calendar), "Add to calendar"));
    actions.push(h("button", { type: "button", class: "cta secondary", on: { click: () => (detail.d.close(), openEdit(j.id)) } }, "Edit details"));
    actions.push(
      h(
        "button",
        {
          type: "button",
          class: "jn-delete",
          on: {
            click: () => {
              const undo = removeJourney(j.id);
              detail.d.close();
              toast(`Deleted ${j.no} on ${shortDay(bd)}`, { label: "Undo", run: () => (undo(), onSaved?.()) });
              onSaved?.();
            },
          },
        },
        svg(icons.trash),
        "Delete journey"
      )
    );
    nodes.push(h("div", { class: "jn-actions" }, actions));
    detail.body.replaceChildren(...nodes.filter(Boolean)); // an empty slot would print "null"
    detail.d.dataset.id = j.id;
    if (!detail.d.open) detail.d.showModal();

    // A linked booking that's due a look is checked quietly while you read.
    if (bookingDue(j) && !checking.has(j.id)) {
      checking.add(j.id);
      checkBooking(j)
        .then((news) => {
          if (news) toast(news);
          if (detail.d.open && detail.d.dataset.id === j.id) openDetail(j.id);
          onSaved?.();
        })
        .catch(() => {})
        .finally(() => checking.delete(j.id));
    }
  }
  const checking = new Set();

  function downloadIcs(j) {
    const link = new URL(`?m=train&no=${j.no}&d=${j.startDate}&s=${j.to.code}`, location.href).href;
    const blob = new Blob([journeyIcs(j, link)], { type: "text/calendar" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `train-${j.no}-${boardDate(j)}.ics` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Calendar event ready, with a reminder 3 hours before");
  }

  /* ---------------- add and edit ---------------- */

  let fieldsMade = null;
  let editing = null; // journey id while editing
  let chosen = null; // the train picked in step 1

  function stepFind(pre = {}) {
    add.title.textContent = "Add a journey";
    const status = h("span", { class: "sr-only", role: "status", "aria-live": "polite" });
    const field = (end, label) => {
      const input = h("input", { class: "jf-input", id: `jn-${end}`, type: "text", placeholder: "Station name or code", autocomplete: "off", spellcheck: "false", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": `jn-${end}-list` });
      const codeEl = h("span", { class: "jf-code", hidden: true });
      const list = h("ul", { class: "st-list", id: `jn-${end}-list`, role: "listbox", "aria-label": `Stations to ${end === "from" ? "board at" : "get off at"}`, hidden: true });
      const wrap = h("div", { class: "jf", "data-end": end }, h("label", { class: "jf-label", for: `jn-${end}`, text: label }), h("div", { class: "jf-box" }, input, codeEl), list);
      return { wrap, input, list, codeEl };
    };
    const f = field("from", "Board at");
    const t = field("to", "Get off at");
    const fromF = stationField({ ...f, status, source: () => stationSource, onPick: (p) => p && !toF.value && requestAnimationFrame(() => toF.input.focus()) });
    const toF = stationField({ ...t, status, source: () => stationSource, onPick: (p) => p && toF.input.blur() });
    if (pre.from) fromF.setCode(pre.from);
    if (pre.to) toF.setCode(pre.to);
    const date = h("input", { type: "date", class: "jn-input", id: "jn-date", value: pre.date || today(), min: addDays(today(), -3), max: addDays(today(), 120) });
    const err = h("p", { class: "field-error", role: "alert", hidden: true });
    const results = h("div", { class: "jn-trains", "aria-live": "polite" });
    const find = h("button", { type: "button", class: "cta", on: { click: () => search() } }, "Find my train", svg(icons.next));

    async function search() {
      const a = fromF.resolve();
      const b = toF.resolve();
      err.hidden = true;
      if (!a || !b) return void ((err.textContent = !a ? "Choose the station you board at." : "Choose where you get off."), (err.hidden = false));
      if (a.code === b.code) return void ((err.textContent = "Pick two different stations."), (err.hidden = false));
      if (!date.value) return void ((err.textContent = "Pick the day you board."), (err.hidden = false));
      results.replaceChildren(h("div", { class: "seat-loading" }, h("span", { class: "skel", vars: { width: "80%", height: "18px" } }), h("span", { class: "skel", vars: { width: "60%", height: "18px" } })));
      try {
        const data = await api("/api/between", { from: a.code, to: b.code, date: date.value }, { timeout: 15000, retries: 1 });
        const trains = data.trains || [];
        if (!trains.length) return void results.replaceChildren(h("p", { class: "jn-fine", text: "No direct train between these stations that day. Check the date, or try a nearby station." }));
        results.replaceChildren(
          h("p", { class: "sheet-label", text: "Which one is yours?" }),
          h(
            "ol",
            { class: "jn-pick" },
            trains.map((tr) => {
              const shift = Math.max(0, dayShift(tr.arr, date.value));
              const near = tr.from.code !== a.code || tr.to.code !== b.code;
              return h(
                "li",
                {},
                h(
                  "button",
                  {
                    type: "button",
                    on: {
                      click: () => {
                        chosen = { no: tr.number, name: tr.name, startDate: tr.startDate, from: tr.from, to: tr.to, dep: tr.dep, arr: tr.arr, schedMin: tr.durationMin, km: tr.distanceKm ?? null, classes: tr.classes || [] };
                        stepDetails();
                      },
                    },
                  },
                  h("span", { class: "jn-pick-t" }, timeNode(tr.dep), h("i", { text: "→" }), timeNode(tr.arr, IST, { shift })),
                  h("span", { class: "jn-pick-n" }, h("b", { class: "tn", text: tr.number }), ` ${tr.name}`),
                  near ? h("span", { class: "jn-pick-near", text: `${tr.from.code} → ${tr.to.code}, a nearby station` }) : null
                )
              );
            })
          )
        );
      } catch (e) {
        results.replaceChildren(h("p", { class: "jn-fine", text: e instanceof ApiError && e.code === "offline" ? "You're offline. Try again when you're connected." : "Couldn't load trains just now. Try again in a moment." }));
      }
    }

    // The quickest way in: a PNR fills in the train, the day, your stations, class, seats and
    // everyone on the booking. Looking it up is your choice, made by tapping the button.
    const pnrIn = h("input", { class: "jn-input jn-pnr-in", id: "jn-pnr-find", inputMode: "numeric", autocomplete: "off", maxLength: 12, placeholder: "10-digit PNR", "aria-describedby": "jn-pnr-why" });
    const pnrErr = h("p", { class: "field-error", role: "alert", hidden: true });
    const pnrBtn = h("button", { type: "button", class: "cta", on: { click: () => byPnr() } }, svg(icons.ticket), "Fill in from PNR");
    pnrIn.addEventListener("input", () => (pnrIn.value = pnrIn.value.replace(/\D/g, "").slice(0, 10)));
    pnrIn.addEventListener("keydown", (e) => e.key === "Enter" && byPnr());

    async function byPnr() {
      const p = pnrIn.value.replace(/\D/g, "");
      pnrErr.hidden = true;
      if (p.length !== 10) return void ((pnrErr.textContent = "A PNR has 10 digits. You'll find it at the top of your ticket or booking SMS."), (pnrErr.hidden = false), pnrIn.focus());
      pnrBtn.disabled = true;
      // The first look-up of a booking can take a while: RailYatri fetches it from the railway
      // then. Say what's happening as it goes, rather than leave a spinner to guess at.
      const say = (text) => pnrBtn.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), text);
      say("Reading your booking…");
      status.textContent = "Reading your booking";
      const steps = [
        setTimeout(() => say("Fetching it from the railway…"), 4000),
        setTimeout(() => say("Still fetching, nearly there…"), 14000),
      ];
      try {
        const t0 = Date.now();
        let data;
        try {
          data = await api("/api/pnr", { pnr: p }, { timeout: 45000, retries: 0 });
        } catch (e) {
          // A quick "not found" means the booking wasn't ready the moment we asked: ask once more.
          if (!(e instanceof ApiError && e.code === "pnr_not_found" && Date.now() - t0 < 10000)) throw e;
          say("Fetching it from the railway…");
          await new Promise((r) => setTimeout(r, 6000));
          data = await api("/api/pnr", { pnr: p, fresh: 1 }, { timeout: 45000, retries: 0 });
        }
        chosen = await journeyFromPnr(data, p);
        stepDetails();
      } catch (e) {
        pnrErr.textContent = pnrError(e);
        pnrErr.hidden = false;
        pnrBtn.disabled = false;
        pnrBtn.replaceChildren(svg(icons.ticket), "Fill in from PNR");
      } finally {
        steps.forEach(clearTimeout);
      }
    }

    add.body.replaceChildren(
      h("label", { class: "field-label", for: "jn-pnr-find", text: "Your PNR" }),
      h("div", { class: "jn-pnr-row" }, pnrIn),
      pnrErr,
      pnrBtn,
      h("p", { class: "jn-fine small", id: "jn-pnr-why", text: PNR_PRIVACY }),
      h("p", { class: "jn-or", "aria-hidden": "true" }, h("span", { text: "or find your train" })),
      h("p", { class: "jn-fine", text: "No PNR yet? Find your train by where you board, where you get off and the day." }),
      h("div", { class: "journey jn-journey" }, f.wrap, t.wrap),
      h("label", { class: "field-label", for: "jn-date", text: "Day you board" }),
      date,
      err,
      find,
      status,
      results
    );
  }

  /**
   * Turn a PNR answer into a journey. The timetable search gives the exact times and the day the
   * run starts (which the live tracker needs, and which can be the day before you board); if it
   * can't be reached, the PNR's own times stand in.
   */
  async function journeyFromPnr(d, pnr) {
    const booking = bookingFrom(d);
    // The ticket's own times win over the timetable's: they're what was booked (the two can differ
    // by a few minutes when a timetable changes).
    const base = { cls: d.cls || null, pnr, pnrLinked: true, booking, ...(seatFrom(booking) || {}), ...(ticketTimes(d) || {}) };
    if (d.boardDate) {
      try {
        const between = await api("/api/between", { from: d.from.code, to: d.to.code, date: d.boardDate }, { timeout: 15000, retries: 1 });
        const tr = (between.trains || []).find((x) => x.number === d.no);
        if (tr) return { no: tr.number, name: d.name || tr.name, startDate: tr.startDate, from: tr.from, to: tr.to, dep: tr.dep, arr: tr.arr, schedMin: tr.durationMin, km: tr.distanceKm ?? null, classes: tr.classes || [], ...base };
      } catch {
        /* the ticket's own details are enough */
      }
    }
    const day = d.boardDate || today();
    const dep = new Date(`${day}T${d.from.time || "00:00"}:00+05:30`).toISOString();
    const arr = new Date(Date.parse(dep) + (d.journeyMin || 0) * 60000).toISOString();
    return { no: d.no, name: d.name || "", startDate: day, from: { code: d.from.code, name: d.from.name }, to: { code: d.to.code, name: d.to.name }, dep, arr, schedMin: d.journeyMin, km: null, classes: d.cls ? [d.cls] : [], ...base };
  }

  function stepDetails() {
    const j = editing ? journeyById(editing) : chosen;
    if (!j) return;
    add.title.textContent = editing ? "Edit journey" : "Your booking";
    const bd = boardDate(j);
    const classes = (j.classes?.length ? j.classes : ["SL", "3A", "2A", "1A", "CC", "2S"]).filter((c) => CLASS_NAMES[c]);
    let cls = j.cls || null;
    const clsBtns = classes.map((c) =>
      h("button", {
        type: "button",
        class: `seat-cls${cls === c ? " on" : ""}`,
        "aria-pressed": String(cls === c),
        title: CLASS_NAMES[c],
        text: c,
        on: {
          click: (e) => {
            cls = cls === c ? null : c;
            for (const b of clsBtns) {
              b.classList.toggle("on", b.textContent === cls);
              b.setAttribute("aria-pressed", String(b.textContent === cls));
            }
            void e;
          },
        },
      })
    );
    const input = (id, label, attrs, value) => [h("label", { class: "field-label", for: id, text: label }), h("input", { class: "jn-input", id, value: value || "", autocomplete: "off", ...attrs })];
    const [coachL, coach] = input("jn-coach", "Coach", { placeholder: "B2", maxLength: 5, autocapitalize: "characters" }, j.coach);
    const [seatL, seat] = input("jn-seat", "Seat or berth", { placeholder: "34 LB", maxLength: 10, autocapitalize: "characters" }, j.seat);
    const [pnrL, pnr] = input("jn-pnr", "PNR (optional)", { placeholder: "10 digits", inputMode: "numeric", maxLength: 12 }, j.pnr);
    const notes = h("textarea", { class: "jn-input", id: "jn-notes", rows: 2, maxLength: 200, placeholder: "Who's picking you up, a food order, anything to remember" });
    notes.value = j.notes || "";
    const err = h("p", { class: "field-error", role: "alert", hidden: true });
    pnr.addEventListener("input", () => (pnr.value = pnr.value.replace(/\D/g, "").slice(0, 10)));

    const save = h(
      "button",
      {
        type: "button",
        class: "cta",
        on: {
          click: () => {
            const p = pnr.value.replace(/\D/g, "");
            if (p && p.length !== 10) return void ((err.textContent = "A PNR has 10 digits. Leave it empty if you don't have it yet."), (err.hidden = false), pnr.focus());
            const details = { cls, coach: coach.value.trim().toUpperCase(), seat: seat.value.trim().toUpperCase(), pnr: p, notes: notes.value.trim() };
            // A different PNR is a different booking: the old status no longer applies.
            if (p !== (j.pnr || "")) Object.assign(details, { booking: null, pnrLinked: false });
            const ok = editing ? updateJourney(editing, details) : addJourney({ ...chosen, ...details });
            if (!ok) return void ((err.textContent = "Couldn't save on this device. Its storage may be full or switched off."), (err.hidden = false));
            add.d.close();
            toast(editing ? "Journey updated" : "Saved to My journeys");
            onSaved?.(editing ? null : ok);
          },
        },
      },
      svg(icons.bookmark),
      editing ? "Save changes" : "Save journey"
    );

    add.body.replaceChildren(
      h(
        "div",
        { class: "jn-summary" },
        h(
          "div",
          { class: "jn-summary-t" },
          h("span", { class: "jn-end" }, timeNode(j.dep), h("small", { class: "jn-end-day", text: dayOf(j.dep) })),
          h("i", { "aria-hidden": "true", text: "→" }),
          h("span", { class: "jn-end" }, timeNode(j.arr, IST, { shift: Math.max(0, dayShift(j.arr, bd)) }), h("small", { class: "jn-end-day", text: dayOf(j.arr) })),
          tripMin(j) > 0 ? h("span", { class: "jn-dur", text: duration(tripMin(j) * 60000) }) : null
        ),
        h("p", { class: "jn-summary-r", text: `${j.from.name} to ${j.to.name}` }),
        h("p", { class: "jn-summary-n" }, h("b", { class: "tn", text: j.no }), ` ${j.name}`),
        !editing && !fieldsMade?.fromResults && !j.booking ? h("button", { type: "button", class: "pill-btn", text: "Change train", on: { click: () => stepFind({ from: j.from.code, to: j.to.code, date: bd }) } }) : null
      ),
      j.booking && !editing ? h("div", { class: "jn-bk found" }, bookingHead(j.booking), passengersBlock(j.booking)) : null,
      h("label", { class: "field-label", id: "jn-class-label", text: "Class" }),
      h("div", { class: "seat-classes jn-classes", role: "group", "aria-labelledby": "jn-class-label" }, clsBtns),
      h("div", { class: "jn-two" }, h("div", {}, coachL, coach), h("div", {}, seatL, seat)),
      pnrL,
      pnr,
      h("label", { class: "field-label", for: "jn-notes", text: "Notes" }),
      notes,
      err,
      save,
      h(
        "p",
        { class: "jn-device" },
        svg(icons.info),
        j.pnrLinked
          ? "Kept only on this device. Track checks this PNR's status now and then until the chart is out, so changes reach you. Nothing is stored on our side."
          : "Kept only on this device. Your PNR stays here unless you ask for its booking status."
      )
    );
    (editing ? coach : coach).focus({ preventScroll: true });
  }

  /** Add: from scratch, or from a train picked in route search. */
  function openAdd(train = null) {
    editing = null;
    fieldsMade = { fromResults: !!train };
    if (train) {
      chosen = train;
      stepDetails();
    } else {
      chosen = null;
      stepFind();
    }
    add.d.showModal();
  }

  function openEdit(jid) {
    editing = jid;
    fieldsMade = { fromResults: true };
    stepDetails();
    add.d.showModal();
  }

  return { openAdd, openEdit, openDetail };
}
