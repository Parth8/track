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
  timetableTimes,
  coachInfo,
  inDayOf,
  DAYOF_HOURS,
  bookingFrom,
  seatFrom,
  bookingDue,
  bookingChip,
  berthGuide,
  berthNo,
  coachWalk,
  BERTH_NAMES,
} from "./journeys.js";

const today = () => todayIn(IST);
/** replaceChildren without the empty slots, which it would otherwise print as "null". */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
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
  updateJourney(j.id, { booking, pnrLinked: true, cls: j.cls || data.cls || null, ...(seatFrom(booking) || {}) });
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

/**
 * Where the times come from, said plainly: checked against two timetables and the ticket, or
 * what didn't line up. Nothing when there's nothing to say.
 */
function timesNote(j) {
  const c = j.timeCheck;
  if (!c) return null;
  const both = c.sources && c.sources.fromDep === "both" && c.sources.toArr === "both";
  let text = null;
  if (c.onlyTicket) text = "Times as on your ticket. The timetable couldn't be reached to check them.";
  else if (c.fromMatch === "arrival") text = `Your ticket shows ${clock(j.fromArr)}, when the train gets to ${j.from.name}. It leaves at ${clock(j.dep)}${both ? ", as both timetables say" : ""}.`;
  else if (c.fromMatch === "neither") text = `Your ticket shows ${c.ticketFrom} at ${j.from.name}, which doesn't match the timetable (${clock(j.dep)}). Check the time on IRCTC.`;
  else if (both) text = "Times checked against two timetables and your ticket.";
  if (c.toMatch === false) text = `${text ? `${text} ` : ""}Your ticket's arrival (${c.ticketTo}) differs from the timetable's.`;
  return text ? h("p", { class: "jn-fine small jn-times-note", text }) : null;
}

/** "B3 · 59 Lower", "RAC 7", "Waitlist 12", from one passenger. */
function passengerLine(p) {
  if (p.coach && p.berth) return [p.coach, [p.berth, p.berthType].filter(Boolean).join(" ")].join(" · ");
  if (p.kind === "waitlist") return p.position ? `Waitlist ${p.position}` : "Waitlisted";
  if (p.kind === "rac") return p.position ? `RAC ${p.position}` : "RAC";
  if (p.kind === "cancelled") return "Cancelled";
  return p.current || "Status not shown";
}
const NUMBERED_COACH = /^[A-Z]{1,2}\d{1,2}$/;
const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th"}`;
const KIND_WORD = { confirmed: "Confirmed", rac: "RAC", waitlist: "Waitlist", cancelled: "Cancelled", unknown: "" };

const GENDERS = { F: "Female", M: "Male", T: "Transgender" };
/** "Parth Aggarwal · 27 · Male", from what you added; "Passenger 1" until then. */
const whoLine = (p, t) => (t?.name ? [t.name, t.age, GENDERS[t.gender]].filter(Boolean).join(" · ") : `Passenger ${p.n}`);

/**
 * Who's travelling on the booking: one row each, so a solo trip is one line and a family of six
 * is six. Public PNR status shows seats, not names, so each passenger's name, age and gender can
 * be added by hand (`travellers`, kept by passenger number, so a re-check never overwrites them).
 */
function passengersBlock(b, { travellers = {}, onSave } = {}) {
  const ps = b.passengers || [];
  const row = (p) => {
    const t = travellers[p.n];
    const li = h("li", { class: `jn-pax-row ${p.kind}` });
    const show = () =>
      fill(li, 
        h("span", { class: "jn-pax-n", "aria-hidden": "true", text: String(p.n) }),
        h("span", { class: "jn-pax-who" }, h("b", { text: passengerLine(p) }), h("small", { text: `${whoLine(p, t)}${p.booking ? ` · booked ${p.booking}` : ""}` })),
        KIND_WORD[p.kind] ? h("span", { class: `jn-pax-kind ${p.kind}`, text: KIND_WORD[p.kind] }) : null,
        onSave ? h("button", { type: "button", class: "icon-btn small jn-pax-edit", "aria-label": `${t?.name ? "Edit" : "Add"} details for passenger ${p.n}`, on: { click: edit } }, svg(icons.edit)) : null
      );
    function edit() {
      const id = (k) => `jn-pax-${p.n}-${k}`;
      const name = h("input", { class: "jn-input", id: id("name"), value: t?.name || "", maxLength: 40, autocomplete: "off", placeholder: "Name" });
      const age = h("input", { class: "jn-input", id: id("age"), value: t?.age || "", inputMode: "numeric", maxLength: 3, autocomplete: "off", placeholder: "Age" });
      const gender = h("select", { class: "jn-input", id: id("gender") }, h("option", { value: "", text: "—" }), Object.entries(GENDERS).map(([k, v]) => h("option", { value: k, text: v, selected: t?.gender === k })));
      age.addEventListener("input", () => (age.value = age.value.replace(/\D/g, "").slice(0, 3)));
      const save = () => {
        const next = { name: name.value.trim().replace(/\s+/g, " "), age: age.value ? Number(age.value) : null, gender: gender.value || null };
        onSave(p.n, next.name || next.age || next.gender ? next : null);
      };
      fill(li, 
        h("span", { class: "jn-pax-n", "aria-hidden": "true", text: String(p.n) }),
        h(
          "div",
          { class: "jn-pax-form" },
          h("label", { class: "sr-only", for: id("name"), text: `Passenger ${p.n}'s name` }),
          name,
          h("div", { class: "jn-pax-form-row" }, h("label", { class: "sr-only", for: id("age"), text: "Age" }), age, h("label", { class: "sr-only", for: id("gender"), text: "Gender" }), gender),
          h("div", { class: "jn-pax-form-row" }, h("button", { type: "button", class: "pill-btn", text: "Cancel", on: { click: show } }), h("button", { type: "button", class: "pill-btn primary", text: "Save", on: { click: save } }))
        )
      );
      name.addEventListener("keydown", (e) => e.key === "Enter" && save());
      name.focus();
    }
    show();
    return li;
  };
  return h("ol", { class: `jn-pax${ps.length === 1 ? " solo" : ""}`, "aria-label": `${ps.length} passenger${ps.length > 1 ? "s" : ""}` }, ps.map(row));
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
      sheets.openDetail(j.id); // live status opens inside, so the booking stays one place
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

export function createJourneySheets({ navigate, toast, onSaved, mountLive }) {
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

  function openDetail(jid, { focus = null } = {}) {
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
        h(
          "div",
          {},
          h("p", { class: "jn-leg-place" }, h("b", { text: s.name }), h("span", { class: "tc-code", text: s.code })),
          h("p", { class: "jn-leg-sub", text: [side === "from" ? "Board" : "Get off", pf ? `PF ${pf}` : null].filter(Boolean).join(" · ") }),
          // The train is at your station before it leaves: say when it gets in, and the halt.
          side === "from" && !actual && j.fromArr && j.fromArr !== j.dep
            ? h("p", { class: "jn-leg-sub", text: `Arrives ${clock(j.fromArr)}, ${Math.round((Date.parse(j.dep) - Date.parse(j.fromArr)) / 60000)} min halt` })
            : null
        ),
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
      timesNote(j),
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
          passengersBlock(j.booking, {
            travellers: j.travellers || {},
            onSave: (n, t) => {
              const all = { ...(j.travellers || {}) };
              if (t) all[n] = t;
              else delete all[n];
              updateJourney(j.id, { travellers: all });
              openDetail(j.id);
            },
          }),
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
    if (!past) nodes.push(platformGuide(j));
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

    if (!past && isTrackable(j) && mountLive) nodes.push(liveSection(j));
    const actions = [];
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
    fill(detail.body, nodes);
    detail.d.dataset.id = j.id;
    if (!detail.d.open) detail.d.showModal();
    if (focus === "platform") requestAnimationFrame(() => detail.body.querySelector(".jn-plat")?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "instant" : "smooth" }));

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

  /* ---------------- live status, inside the booking ---------------- */

  let liveCtl = null; // the tracker drawn in the open sheet, if any
  const liveOpen = new Set(); // journeys whose live status you've opened, kept open across redraws
  detail.d.addEventListener("close", () => (liveCtl?.stop(), (liveCtl = null)));

  /**
   * "Live status ⌄": the tracker for this trip's run and stop, expanding in place. It refreshes at
   * its own calm pace while open, and stops when folded away or the sheet closes.
   */
  function liveSection(j) {
    liveCtl?.stop();
    liveCtl = null;
    const panel = h("div", { class: "jn-live-panel", id: `jn-live-${j.id}`, hidden: true });
    const sub = isLiveNow(j) ? "On its way now" : `Your stop: ${j.to.name}`;
    const btn = h(
      "button",
      { type: "button", class: "jn-live-btn", "aria-expanded": "false", "aria-controls": panel.id },
      h("span", { class: "jn-live-ico", "aria-hidden": "true" }, svg(icons.trainFront), isLiveNow(j) ? h("i", { class: "live-dot" }) : null),
      h("span", { class: "jn-live-text" }, h("b", { text: "Live status" }), h("small", { text: sub })),
      h("span", { class: "jn-live-chev", "aria-hidden": "true" })
    );
    const set = (open) => {
      btn.setAttribute("aria-expanded", String(open));
      panel.hidden = !open;
      if (open) {
        liveOpen.add(j.id);
        liveCtl?.stop();
        liveCtl = mountLive(panel, j);
        if (motion()) panel.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
        requestAnimationFrame(() => btn.scrollIntoView({ block: "start", behavior: motion() ? "smooth" : "instant" }));
      } else {
        liveOpen.delete(j.id);
        liveCtl?.stop();
        liveCtl = null;
        panel.replaceChildren();
      }
    };
    btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true"));
    const wrap = h("section", { class: "jn-live", "aria-label": "Live status" }, btn, panel);
    if (liveOpen.has(j.id)) requestAnimationFrame(() => set(true));
    return wrap;
  }

  /* ---------------- on the platform: your coach, your berth, your platform ---------------- */

  /** Each seat on the booking (or the one you typed in), with whose it is. */
  function seatsOf(j) {
    const ps = (j.booking?.passengers || []).filter((p) => p.coach && p.berth);
    if (ps.length)
      return ps.map((p) => ({ n: p.n, who: j.travellers?.[p.n]?.name || `Passenger ${p.n}`, coach: p.coach, berth: Number(p.berth), type: p.berthType, typeFrom: p.berthFrom }));
    return j.coach ? [{ n: 1, who: "Your seat", coach: j.coach.toUpperCase(), berth: berthNo(j.seat), type: null, typeFrom: null }] : [];
  }

  const NAMES = { erail: "erail.in", confirmtkt: "ConfirmTkt", etrain: "etrain.info", railyatri: "RailYatri", ntes: "NTES" };
  const DAYOF_EVERY = 3 * 60000;
  let dayOfTimer = null; // one sheet open at a time, so one timer
  detail.d.addEventListener("close", () => clearTimeout(dayOfTimer));
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const listOf = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  // Bays in a coach, only for builds whose numbering is known. LHB and ICF coaches differ.
  const BAYS = { "3A:LHB": 9, "SL:LHB": 10, "3A:ICF": 8, "SL:ICF": 9 };
  // Every size a class's coaches come in (ICF and LHB), when the build isn't published.
  const BAY_SIZES = { "3A": [8, 9], SL: [9, 10] };
  const today_ = today;
  const motion = () => !prefersReducedMotion();

  function platformGuide(j) {
    const seats = seatsOf(j);
    if (!seats.length && !j.booking?.platform) return null;
    let info = j.coachOrder && Date.now() - Date.parse(j.coachOrder.at) < 3 * 86400000 ? j.coachOrder : null;
    let failed = null;
    let pick = 0;
    let here = null;
    let today = null; // what today's run says at your station, from /api/dayof
    let seen = null; // the tracker's platform for the last run
    const dayOf = !isPast(j) && inDayOf(j);
    const pass = h("div", { class: "jn-pass", role: "group", "aria-label": "Your platform, coach and berth" });
    const todayBox = h("div", { class: "jn-today", "aria-live": "polite" });
    const coachBox = h("div", { class: "jn-coachbox" });
    const berthBox = h("div", { class: "jn-berthbox" });
    const picker = seats.length > 1 ? h("div", { class: "jn-seatpick", role: "radiogroup", "aria-label": "Whose seat" }) : null;
    const stopAt = (code) => info?.stops?.find((s) => s.code === code) || null;
    /** "How sure?": the evidence, folded away until asked for. */
    const sure = (...lines) => {
      const body = lines.flat().filter(Boolean);
      return body.length ? h("details", { class: "jn-sure" }, h("summary", {}, "How sure?"), body.map((t) => (typeof t === "string" ? h("p", { text: t }) : t))) : null;
    };

    function paintPicker() {
      if (!picker) return;
      fill(
        picker,
        seats.map((s, i) =>
          h("button", { type: "button", role: "radio", class: "pill-btn", "aria-checked": String(i === pick), text: `${s.who.split(" ")[0]} · ${s.coach} ${s.berth}`, on: { click: () => ((pick = i), (here = null), paintAll()) } })
        )
      );
    }

    /* ---------- the answers: platform, coach, berth ---------- */

    /** The platform, and how far to trust it. Only the railway's system on the day confirms one. */
    function platformAnswer() {
      const n = today?.platform?.ntes;
      if (n?.pf) return { pf: n.pf, label: n.mark ? "Provisional" : "Confirmed", tone: "ok", says: [["The railway's enquiry system (NTES), today", n.pf]] };
      const says = [];
      if (j.booking?.platform) says.push(["Your ticket", j.booking.platform]);
      const st = stopAt(j.from.code);
      if (st?.pf && st.from?.pf === "both") says.push(["RailYatri's timetable", st.pf], ["ConfirmTkt's timetable", st.pf]);
      else if (st?.pf) says.push([`${NAMES[st.from?.pf] || "The"}'s timetable`.replace("The's", "The"), st.pf]);
      else if (st?.from?.pf && typeof st.from.pf === "object") for (const [k, v] of Object.entries(st.from.pf)) says.push([`${NAMES[k]}'s timetable`, v]);
      if (today?.platform?.railyatri) says.push(["RailYatri's live status", today.platform.railyatri]);
      if (today?.platform?.confirmtkt) says.push(["ConfirmTkt's running status", today.platform.confirmtkt]);
      if (!dayOf && seen?.pf) says.push(["The tracker, last run", seen.pf]);
      if (!says.length) return null;
      const count = new Map();
      for (const [, v] of says) count.set(v, (count.get(v) || 0) + 1);
      const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 1) return { pf: ranked[0][0], label: dayOf ? "Planned" : "Likely", tone: dayOf ? "warn" : "quiet", says };
      return { pf: ranked.slice(0, 2).map(([v]) => v).join(" or "), label: "Unsure", tone: "warn", says };
    }

    function paintPass() {
      const seat = seats[pick];
      const pf = platformAnswer();
      const g = seat?.berth ? berthGuide(j.cls, seat.berth) : null;
      const type = g ? BERTH_NAMES[g.type] : seat?.type;
      const tile = (label, value, sub, tone) => h("div", { class: `jn-pass-tile${tone ? ` ${tone}` : ""}` }, h("small", { text: label }), h("b", { text: value }), sub ? h("span", { text: sub }) : null);
      fill(pass, [
        pf ? tile("Platform", pf.pf, pf.label, pf.tone) : tile("Platform", "–", "Not published yet", "quiet"),
        seat ? tile("Coach", seat.coach, today?.coaches ? "Today's order" : j.cls ? CLASS_NAMES[j.cls] : null) : null,
        seat?.berth ? tile("Berth", String(seat.berth), type || null) : null,
      ]);
    }

    /** On the day: one slim line of what today's run says, the detail folded away. */
    function paintToday() {
      if (!dayOf) return fill(todayBox, !isPast(j) && isTrackable(j) ? h("p", { class: "jn-fine small", text: `From ${DAYOF_HOURS} hours before you board, this checks today's run with the railway's own system.` }) : null);
      if (!today) return fill(todayBox, h("p", { class: "jn-today-t" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Checking today's run…"));
      const d = today.delay || {};
      const ds = [["NTES", d.ntes], ["RailYatri", d.railyatri], ["ConfirmTkt", d.confirmtkt]].filter(([, v]) => Number.isFinite(v));
      const lo = Math.min(...ds.map(([, v]) => v));
      const hi = Math.max(...ds.map(([, v]) => v));
      const late = !ds.length ? null : hi <= 0 && lo >= -2 ? "on time" : lo === hi ? (lo > 0 ? `${lo} min late` : `${-lo} min early`) : lo <= 0 ? `up to ${hi} min late` : `${lo}–${hi} min late`;
      const ok = (today.sources || []).filter((x) => x.ok).map((x) => NAMES[x.name]);
      const no = (today.sources || []).filter((x) => !x.ok).map((x) => `${NAMES[x.name]} (${x.why})`);
      fill(
        todayBox,
        h("p", { class: "jn-today-t" }, h("span", { class: "jn-live-dot", "aria-hidden": "true" }), h("span", { text: `Today's run${late ? ` · ${late} at ${j.from.name}` : ""}` }), h("small", { text: ago(today.status.checkedAt) })),
        sure(
          ds.length > 1 && lo !== hi ? `Delay at ${j.from.name}: ${ds.map(([w, v]) => `${w} ${v} min`).join(", ")}.` : null,
          ok.length ? `Answered: ${listOf(ok)}.` : null,
          no.length ? `No answer: ${listOf(no)}.` : null,
          today.platform?.ntes?.pf || today.coaches ? null : "The railway's enquiry system hasn't confirmed the platform or coach order yet. This checks again every few minutes while it's open."
        )
      );
    }

    /* ---------- find your coach ---------- */

    function orderSure(list, live, sameAsPlan) {
      if (live) return [`Today's order at ${j.from.name}, from the railway's enquiry system (NTES).`, sameAsPlan === false ? "It differs from the published order, so go by this one." : sameAsPlan ? "It matches the published order." : null];
      const src = info.sources || [];
      const yes = src.filter((s) => s.agrees).map((s) => NAMES[s.name]);
      const no = src.filter((s) => !s.agrees).map((s) => NAMES[s.name]);
      const lines = [];
      if (info.agreement === "all") lines.push(`${listOf(yes)} list this order.`);
      else if (info.agreement === "majority") lines.push(`${listOf(yes)} list this order; ${listOf(no)} ${no.length > 1 ? "list" : "lists"} another.`);
      else if (info.agreement === "tie") lines.push(`The sources list different orders. This is ${yes[0]}'s, the most recently dated.`);
      else lines.push(`Only ${yes[0]} lists an order for this train.`);
      const front = frontLine(list);
      if (front) lines.push(front);
      lines.push("Orders change now and then; the coach display on the platform shows today's.");
      return lines;
    }

    /**
     * Which end comes in first: said only when every source that shows the engine puts it at the
     * same end, counting only reversals a timetable actually lists.
     */
    function frontLine(list) {
      if (info?.engineFirst == null || !info.stops?.length) return null;
      const i = info.stops.findIndex((s) => s.code === j.from.code);
      if (i < 0) return null;
      const before = info.stops.slice(0, i).filter((s) => s.reversal);
      const engineLeads = before.length % 2 === 0 ? info.engineFirst : !info.engineFirst;
      const lead = engineLeads ? list[0] : list.at(-1);
      return `The ${lead.id} end probably comes in first, behind the engine${before.length ? ` (it changes ends at ${listOf(before.map((s) => s.code))})` : ", as no reversal is listed before here"}.`;
    }

    function agreeChip(live) {
      if (live) return h("span", { class: "chip small ok" }, svg(icons.check), "Today's run");
      const src = info?.sources || [];
      if (!src.length) return null;
      const yes = src.filter((s) => s.agrees).length;
      return h("span", { class: `chip small ${yes === src.length ? "ok" : yes > src.length / 2 ? "quiet" : "warn"}`, text: yes === src.length ? `${yes} sources agree` : `${yes} of ${src.length} sources agree` });
    }

    // The coach order, drawn as the train. Tap the coach in front of you to see which way to walk.
    function paintCoach() {
      const seat = seats[pick];
      if (!seat) return fill(coachBox);
      if (!info && !failed && !today?.coaches) return fill(coachBox, h("div", { class: "jn-coaches-skel", "aria-hidden": "true" }, Array.from({ length: 9 }, () => h("i", { class: "skel" }))));
      const live = today?.coaches?.list?.length ? today.coaches.list.map((c) => ({ id: c.id, kind: /^[A-Z]+/.exec(c.id)?.[0] || c.id, cls: c.cls })) : null;
      if (!live && !info?.coaches) return fill(coachBox, h("p", { class: "jn-fine", text: failed || "No coach order is published for this train. The coach display on the platform shows it on the day." }));
      const list = live || info.coaches;
      const seqOf = (l) => l.filter((c) => NUMBERED_COACH.test(c.id)).map((c) => c.id).join(" ");
      const sameAsPlan = live && info?.coaches ? seqOf(live) === seqOf(info.coaches) : null;
      const mine = list.findIndex((c) => c.id === seat.coach);
      const say = h("p", { class: "jn-coach-say", role: "status", "aria-live": "polite" });
      if (mine < 0) say.textContent = `${seat.coach} isn't in the listed order. Check the coach display on the platform.`;
      else if (here == null) say.append(h("span", { class: "jn-tap", "aria-hidden": "true" }, svg(icons.tap)), "Tap the coach you're standing at");
      else {
        const walk = coachWalk(list, here, seat.coach);
        if (walk?.steps === 0) say.append(h("b", { text: "You're at your coach" }));
        else if (walk) say.append(h("b", { text: `Walk ${walk.steps} coach${walk.steps > 1 ? "es" : ""} towards ${walk.toward}` }), h("span", { class: "jn-say-sub", text: `about ${walk.meters} m` }));
      }
      const lo = here == null || mine < 0 ? -1 : Math.min(here, mine);
      const hi = here == null || mine < 0 ? -1 : Math.max(here, mine);
      const engineFirst = live ? null : info.engineFirst; // drawn only from the published order's marks
      const engine = (end) => (engineFirst === (end === "start") ? h("li", { class: "jn-loco", "aria-hidden": "true" }, h("span", { text: "Engine" })) : null);
      const strip = h(
        "ol",
        { class: `jn-coaches${here != null ? " walking" : ""}`, "aria-label": "Coach order. Tap the coach you're at." },
        engine("start"),
        list.map((c, i) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: `jn-coach${i === mine ? " mine" : ""}${i === here ? " here" : ""}${i > lo && i < hi ? " path" : ""}${NUMBERED_COACH.test(c.id) ? "" : " utility"}`,
                vars: { "--d": String(Math.abs(i - (here ?? 0))) },
                "aria-label": `${c.id}${i === mine ? ", your coach" : ""}${i === here ? ", you're here" : ""}`,
                "aria-pressed": String(i === here),
                on: { click: () => ((here = i === here ? null : i), paintCoach()) },
              },
              h("b", { text: c.id }),
              c.cls ? h("small", { text: c.cls }) : null
            )
          )
        ),
        engine("end")
      );
      fill(coachBox, [
        h("div", { class: "jn-card-head" }, h("p", { class: "jn-card-t", text: "Find your coach" }), agreeChip(!!live)),
        strip,
        say,
        sure(orderSure(list, live, sameAsPlan)),
      ]);
      // Keep both you and your coach in view, gliding there rather than jumping.
      requestAnimationFrame(() => {
        const a = (strip.querySelector(".here") || strip.querySelector(".mine"))?.closest("li");
        const b = strip.querySelector(".mine")?.closest("li") || a;
        if (!a) return;
        const mid = (Math.min(a.offsetLeft, b.offsetLeft) + Math.max(a.offsetLeft + a.offsetWidth, b.offsetLeft + b.offsetWidth)) / 2;
        strip.scrollTo({ left: mid - strip.clientWidth / 2, behavior: motion() && here != null ? "smooth" : "instant" });
      });
    }

    /* ---------- find your berth ---------- */

    /**
     * Where the bay sits in the coach, without knowing which door you came in by: said only when
     * every coach size this class comes in puts it in the same place, and in terms you can see
     * (the numbers above the bays).
     */
    function bayPlace(g, build) {
      const sizes = build && BAYS[`${g.cls}:${build}`] ? [BAYS[`${g.cls}:${build}`]] : BAY_SIZES[g.cls] || [];
      if (!sizes.length) return null;
      const place = (n) => (g.bay <= 2 ? "low" : g.bay >= n - 1 ? "high" : g.bay > n / 3 && g.bay <= n - n / 3 ? "middle" : null);
      const all = sizes.map(place);
      if (!all[0] || !all.every((x) => x === all[0])) return null;
      return { low: "near the door at the end with berth 1", high: "near the door at the end with the highest numbers", middle: "in the middle of the coach" }[all[0]];
    }

    function paintBerth() {
      const seat = seats[pick];
      if (!seat?.berth) return fill(berthBox);
      const g = berthGuide(j.cls, seat.berth);
      const from = seat.typeFrom === "railway" ? "on your booking" : seat.typeFrom === "layout" ? `from the standard numbering of ${CLASS_NAMES[j.cls] || j.cls} coaches` : null;
      if (!g)
        return fill(berthBox, [
          h("p", { class: "jn-card-t", text: "Find your berth" }),
          h("p", { class: "jn-coach-say" }, h("b", { text: `Berth ${seat.berth}${seat.type ? ` · ${seat.type}` : ""}` })),
          sure(seat.type && from ? `${seat.type}, ${from}.` : null, `${CLASS_NAMES[j.cls] || "This class"} coaches don't all number berths the same way, so it isn't drawn here.`),
        ]);
      const build = info?.coaches?.find((c) => c.id === seat.coach)?.build || null;
      const where = bayPlace(g, build);
      const main = g.places.slice(0, -2);
      const half = main.length / 2;
      const cell = (p, k) => h("span", { class: `jn-b${p.n === g.berth ? " mine" : ""}`, vars: { "--k": String(k) }, "aria-hidden": "true" }, h("b", { text: String(p.n) }), h("small", { text: p.type }));
      fill(berthBox, [
        h("p", { class: "jn-card-t", text: "Find your berth" }),
        h("p", { class: "jn-coach-say" }, h("b", { text: `Look for ${g.first}–${g.last}` }), h("span", { class: "jn-say-sub", text: `above the bay${where ? `, ${where}` : ""}` })),
        h(
          "div",
          { class: "jn-bay", role: "img", "aria-label": `Bay ${g.first} to ${g.last}. Berth ${g.berth} is the ${BERTH_NAMES[g.type].toLowerCase()} berth${g.side ? " on the side, along the aisle" : " in the main bay"}.` },
          h("span", { class: "jn-bay-face" }, main.slice(0, half).map((p, k) => cell(p, k))),
          h("span", { class: "jn-bay-face" }, main.slice(half).map((p, k) => cell(p, k + half))),
          h("span", { class: "jn-bay-aisle" }, h("small", { text: "aisle" })),
          h("span", { class: "jn-bay-face side" }, g.places.slice(-2).map((p, k) => cell(p, k + main.length)))
        ),
        h("p", { class: "jn-berth-is" }, h("b", { text: `${g.berth} · ${BERTH_NAMES[g.type]}` }), g.side ? " · along the aisle" : " · in the main bay"),
        sure(
          `${BERTH_NAMES[g.type]}${from ? `, ${from}` : ""}.`,
          "Each bay's berth numbers are marked above it, and they rise from one end of the coach to the other, so you can find it from either door.",
          !where ? "Where the bay sits in the coach depends on the coach's build, which isn't published for this train." : null
        ),
      ]);
    }

    /* ---------- loading ---------- */

    async function loadSeen() {
      if (dayOf) return; // on the day, today's run speaks instead
      const fresh = j.platformSeen && Date.now() - Date.parse(j.platformSeen.at) < 12 * 3600000 && !j.platformSeen.live ? j.platformSeen : null;
      if (fresh) return void (seen = fresh);
      try {
        const data = await api("/api/train", { no: j.no, date: addDays(today_(), -1) }, { timeout: 20000, retries: 0 });
        const stop = (data.stops || []).find((x) => x.code === j.from.code);
        seen = { pf: stop?.platform || null, live: false, at: new Date().toISOString() };
        updateJourney(j.id, { platformSeen: seen });
        paintPass();
      } catch {
        /* the other sources stand on their own */
      }
    }

    async function loadToday(force = false) {
      clearTimeout(dayOfTimer);
      if (!dayOf || !detail.d.open || detail.d.dataset.id !== j.id) return;
      try {
        today = await api("/api/dayof", { no: j.no, date: j.startDate, at: j.from.code, fresh: force ? 1 : null }, { timeout: 20000, retries: 0 });
      } catch {
        /* keep what we had; the next round tries again */
      }
      if (detail.d.open && detail.d.dataset.id === j.id) {
        paintAll();
        dayOfTimer = setTimeout(loadToday, DAYOF_EVERY);
      }
    }

    const paintAll = () => (paintPass(), paintToday(), paintPicker(), paintCoach(), paintBerth());
    paintAll();
    loadSeen();
    if (dayOf) requestAnimationFrame(() => loadToday());
    if (!info) {
      api("/api/coaches", { no: j.no }, { timeout: 20000, retries: 1 })
        .then((d) => {
          info = coachInfo(d);
          updateJourney(j.id, { coachOrder: info });
        })
        .catch((e) => (failed = e instanceof ApiError && e.code === "no_coach_order" ? null : "Couldn't reach the coach order just now."))
        .finally(paintAll);
    }

    return h(
      "section",
      { class: "jn-plat", "aria-label": "On the platform" },
      h("p", { class: "sheet-label", text: "On the platform" }),
      pass,
      todayBox,
      picker,
      seats.length ? h("div", { class: "jn-card" }, coachBox) : null,
      seats.some((x) => x.berth) ? h("div", { class: "jn-card" }, berthBox) : null
    );
  }

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

    fill(add.body, 
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
    // Three looks at the same trip, side by side: the timetable search (for the day the run
    // starts, distance and classes), the train's stops from two timetables (for the times at
    // your stations), and the ticket (checked against those times, never assumed to be either).
    const [between, info] = await Promise.all([
      d.boardDate ? api("/api/between", { from: d.from.code, to: d.to.code, date: d.boardDate }, { timeout: 15000, retries: 1 }).catch(() => null) : null,
      api("/api/coaches", { no: d.no }, { timeout: 20000, retries: 1 }).catch(() => null),
    ]);
    const tr = (between?.trains || []).find((x) => x.number === d.no && x.from.code === d.from.code && x.to.code === d.to.code);
    const tt = info?.stops ? timetableTimes(info.stops, d.from.code, d.to.code, d.boardDate, { from: d.from.time, to: d.to.time }) : null;
    const base = { cls: d.cls || null, pnr, pnrLinked: true, booking, ...(seatFrom(booking) || {}), ...(info?.coaches || info?.stops ? { coachOrder: coachInfo(info) } : {}) };
    if (tr)
      return {
        no: tr.number,
        name: d.name || tr.name,
        startDate: tr.startDate,
        from: tr.from,
        to: tr.to,
        dep: tt?.dep || tr.dep,
        arr: tt?.arr || tr.arr,
        fromArr: tt?.fromArr || null,
        schedMin: tt?.schedMin ?? tr.durationMin,
        timeCheck: tt?.check || null,
        km: tr.distanceKm ?? null,
        classes: tr.classes || [],
        ...base,
      };
    // No timetable search: the stops' times if we have them, else the ticket's own, marked as such.
    const day = d.boardDate || today();
    const dep = tt?.dep || new Date(`${day}T${d.from.time || "00:00"}:00+05:30`).toISOString();
    const arr = tt?.arr || new Date(Date.parse(dep) + (d.journeyMin || 0) * 60000).toISOString();
    return {
      no: d.no,
      name: d.name || "",
      startDate: day,
      from: { code: d.from.code, name: d.from.name },
      to: { code: d.to.code, name: d.to.name },
      dep,
      arr,
      fromArr: tt?.fromArr || null,
      schedMin: tt?.schedMin ?? d.journeyMin,
      timeCheck: tt?.check || { ticketFrom: d.from.time, ticketTo: d.to.time, fromMatch: null, toMatch: null, onlyTicket: true },
      km: null,
      classes: d.cls ? [d.cls] : [],
      ...base,
    };
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

    fill(add.body, 
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
