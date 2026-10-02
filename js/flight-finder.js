// Flight route finder results: every direct flight from one airport to another on a day.
// Tapping a flight opens its live status. Built from the origin's departure board, which the
// Worker caches and shares, so a search costs at most two paid lookups and usually none.

import { h, svg, hm, timeNode, addDays, todayIn, IST, longDate, duration, fmtMin, ago } from "./util.js";
import { icons, art } from "./icons.js";
import { api, ApiError } from "./api.js";
import { loadAirports, airportByCode } from "./airports.js";
import { shortDay, weekday, nameSize, errIcon } from "./finder.js";

const today = () => todayIn(IST);
const minutesOf = (hhmm) => (/^\d{2}:\d{2}$/.test(hhmm || "") ? +hhmm.slice(0, 2) * 60 + +hhmm.slice(3) : null);
const daysApart = (a, b) => (a && b ? Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) : 0);

/** How far back and ahead flight search goes: what flight tracking can show. */
export const flightRouteRange = () => [addDays(today(), -1), addDays(today(), 7)];

export function createFlightResults({ root, title, sub, navigate, toast, footer }) {
  const memo = new Map();
  const cards = new Map();
  let current = null; // { key, r, data, expanded, scrollY }
  let token = 0;
  let focusStep = null;

  const keyOf = (r) => `${r.from}|${r.to}|${r.date}|${minutesOf(r.time) >= 720 ? "pm" : "all"}`;
  const placeOf = (code, data, side) => {
    const a = airportByCode(code);
    return a ? a.name : data?.[side]?.name || code;
  };

  function head(r, data, { loading = false } = {}) {
    const fromName = placeOf(r.from, data, "from");
    const toName = placeOf(r.to, data, "to");
    title.textContent = `${r.from} to ${r.to}`;
    sub.textContent = longDate(r.date);
    document.title = `Flights ${fromName} to ${toName}`;
    const [min, max] = flightRouteRange();
    const step = (n) => {
      const d = addDays(r.date, n);
      return h(
        "button",
        {
          type: "button",
          class: `day-step ${n < 0 ? "prev" : "next"}`,
          disabled: d < min || d > max,
          "aria-label": `${n < 0 ? "Previous" : "Next"} day, ${longDate(d)}`,
          on: {
            click: () => {
              focusStep = n < 0 ? "prev" : "next";
              navigate({ m: "flight", from: r.from, to: r.to, d, t: r.time }, { replace: true, instant: true, keepFocus: true });
            },
          },
        },
        n < 0 ? svg(icons.back) : null,
        h("span", { text: weekday(d) }),
        n > 0 ? svg(icons.next) : null
      );
    };
    return h(
      "section",
      { class: `card route-card${loading ? " loading" : ""}`, "aria-label": `${fromName} to ${toName}` },
      h(
        "div",
        { class: `rc-ends${nameSize(fromName, toName)}` },
        h("div", { class: "rc-end" }, h("span", { class: "rc-code", text: r.from }), h("strong", { class: "display", text: fromName })),
        h("div", { class: "rc-mid fly", "aria-hidden": "true" }, h("i"), h("b", {}, svg(icons.plane))),
        h("div", { class: "rc-end to" }, h("span", { class: "rc-code", text: r.to }), h("strong", { class: "display", text: toName }))
      ),
      h(
        "div",
        { class: "rc-meta" },
        step(-1),
        h(
          "div",
          { class: "rc-when" },
          h("strong", { text: r.date === today() ? `Today · ${shortDay(r.date)}` : shortDay(r.date) }),
          h("span", { text: r.time ? `Leaving after ${hm(r.time)}` : "Any time of day" })
        ),
        step(1)
      )
    );
  }

  function skeleton() {
    const bar = (w, ht) => h("span", { class: "skel", vars: { width: w, height: ht } });
    return h(
      "div",
      { class: "train-list", "aria-hidden": "true" },
      [0, 1, 2].map((i) => h("div", { class: "tcard skel-card", vars: { "--i": String(i) } }, bar("70%", "28px"), bar("50%", "14px"), bar("35%", "14px")))
    );
  }

  /** What the airline says right now, as a chip. Future days have nothing live to say. */
  function statusChip(f, isToday) {
    const s = f.status;
    if (s.phase === "cancelled") return { cls: "bad", text: "Cancelled" };
    if (s.phase === "diverted") return { cls: "late", text: "Diverted" };
    if (s.phase === "landed") return { cls: "ok", text: "Landed" };
    if (s.phase === "air") return { cls: "ok", text: "In the air" };
    if (s.raw === "Boarding") return { cls: "accent", text: "Boarding" };
    if (s.raw === "GateClosed") return { cls: "late", text: "Gate closed" };
    if (s.delayMin != null && s.delayMin >= 10) return { cls: "late", text: `Delayed ${fmtMin(s.delayMin)}` };
    if (isToday && s.raw === "CheckIn") return { cls: "info", text: "Check-in open" };
    return null;
  }

  function flightCard(f, r, i, flags, settled = false) {
    const isToday = r.date === today();
    const depDate = f.dep.localDate || r.date;
    const arrShift = Math.max(0, daysApart(depDate, f.arr.localDate));
    const late = f.status.delayMin != null && f.status.delayMin >= 10 && f.dep.revisedLocal;
    const chip = statusChip(f, isToday);
    const cancelled = f.status.phase === "cancelled";
    const fromName = placeOf(r.from, current.data, "from");
    const toName = placeOf(r.to, current.data, "to");
    const depText = hm(f.dep.local);
    const arrText = f.arr.local ? hm(f.arr.local) : "--:--";

    const label =
      `${f.airline.name} ${f.number}. Leaves ${fromName} at ${depText}${late ? `, now ${hm(f.dep.revisedLocal)}` : ""}` +
      `, lands in ${toName} at ${arrText}${arrShift === 1 ? " the next day" : arrShift > 1 ? ` ${arrShift} days later` : ""}.` +
      `${f.durationMin ? ` ${duration(f.durationMin * 60000)}.` : ""}${chip ? ` ${chip.text}.` : ""}${flags.length ? ` ${flags.map((x) => x.text).join(". ")}.` : ""} Track live.`;

    const card = h(
      "article",
      { class: `tcard linked fcard${cancelled ? " cancelled" : ""}${settled ? " settled" : ""}`, vars: { "--i": String(i) } },
      h("a", {
        class: "tc-link",
        href: `?m=flight&no=${f.no}&d=${depDate}`,
        "aria-label": label,
        on: {
          click: (e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            navigate({ m: "flight", no: f.no, d: depDate }, { state: { from: "results" } });
          },
        },
      }),
      h(
        "div",
        { class: "tc-body", "aria-hidden": "true" },
        flags.length || chip
          ? h(
              "span",
              { class: "tc-flags" },
              flags.map((x) => h("span", { class: `chip ${x.cls}`, text: x.text })),
              chip ? h("span", { class: `chip ${chip.cls}`, text: chip.text }) : null
            )
          : null,
        h(
          "span",
          { class: "tc-times" },
          h("span", { class: `tc-t${late ? " was" : ""}` }, timeNode(null, IST, { text: depText })),
          h("span", { class: "tc-line fly" }, h("i"), h("b", { text: f.durationMin ? duration(f.durationMin * 60000) : "" }), h("i")),
          h("span", { class: "tc-t" }, timeNode(null, IST, { text: arrText, shift: arrShift }))
        ),
        late
          ? h("span", { class: "fc-now" }, svg(icons.clock), `Now leaves ${hm(f.dep.revisedLocal)}${f.arr.revisedLocal ? ` · lands ${hm(f.arr.revisedLocal)}` : ""}`)
          : null,
        h("span", { class: "tc-codes" }, h("span", { text: [r.from, f.dep.terminal ? `T${f.dep.terminal}` : null].filter(Boolean).join(" · ") }), h("span", { text: r.to })),
        h("span", { class: "tc-name" }, h("span", { class: "tc-no tn", text: f.number }), h("span", { text: f.airline.name })),
        f.aircraft ? h("span", { class: "fc-meta", text: f.aircraft }) : null
      ),
      h("span", { class: "tc-foot", "aria-hidden": "true" }, h("span", { class: "tc-go" }, "Track live", svg(icons.next)))
    );
    const li = h("li", { "data-no": f.no }, card);
    cards.set(f.no, () => flightCard(f, r, i, flags, true));
    return li;
  }

  function paint() {
    const { r, data } = current;
    const nodes = [head(r, data)];
    const flights = data.flights || [];
    const tMin = minutesOf(r.time);
    const isToday = r.date === today();

    if (data.partial && data.partialNote) nodes.push(h("div", { class: "banner info", role: "note" }, svg(icons.info), h("span", { text: `Some flights may be missing. ${data.partialNote}` })));

    if (!flights.length) {
      nodes.push(
        h(
          "div",
          { class: "empty compact" },
          svg(art.empty),
          h("h2", { class: "display", text: "No direct flights here" }),
          h("p", {
            text: `We couldn't find a direct flight from ${placeOf(r.from, data, "from")} to ${placeOf(r.to, data, "to")} on ${shortDay(r.date)}${tMin != null ? ` after ${hm(r.time)}` : ""}. Try another day or a nearby airport.`,
          }),
          h("button", { type: "button", class: "cta secondary", text: "Change search", on: { click: () => editSearch() } })
        )
      );
    } else {
      const flags = new Map();
      const add = (f, x) => f && flags.set(f.no, [...(flags.get(f.no) || []), x]);
      const leaves = (f) => Date.parse(f.dep.revised || f.dep.sched);
      if (isToday) add(flights.find((f) => f.status.phase === "pre" && leaves(f) > Date.now() && (tMin == null || minutesOf(f.dep.local) >= tMin)), { cls: "accent", text: "Next to leave" });
      const timed = flights.filter((f) => f.durationMin && f.status.phase !== "cancelled");
      if (timed.length >= 3) {
        const fastest = timed.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
        if (timed.filter((f) => f.durationMin === fastest.durationMin).length === 1) add(fastest, { cls: "info", text: "Shortest" });
      }

      const earlier = tMin == null ? [] : flights.filter((f) => minutesOf(f.dep.local) < tMin);
      const later = flights.filter((f) => !earlier.includes(f));
      const showEarlier = current.expanded || !later.length;

      nodes.push(
        h(
          "p",
          { class: "rc-count" },
          h("strong", { text: `${flights.length} flight${flights.length > 1 ? "s" : ""}` }),
          later.length && earlier.length ? ` · ${later.length} after ${hm(r.time)}` : "",
          h("span", { text: isToday && data.asOf ? `Checked ${ago(data.asOf)}` : "Sorted by departure" })
        )
      );
      if (!later.length && earlier.length)
        nodes.push(h("div", { class: "banner info", role: "note" }, svg(icons.info), h("span", { text: `Nothing leaves after ${hm(r.time)} that day. Here's what leaves earlier.` })));

      const list = h("ol", { class: "train-list", "aria-label": "Flights" });
      let i = 0;
      if (earlier.length && !showEarlier) {
        list.append(
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: "fold-btn",
                "aria-expanded": "false",
                on: {
                  click: () => {
                    current.expanded = true;
                    const y = window.scrollY;
                    paint();
                    window.scrollTo({ top: y, behavior: "instant" });
                    root.querySelector(".tc-link")?.focus({ preventScroll: true });
                  },
                },
              },
              svg(icons.up),
              `${earlier.length} earlier flight${earlier.length > 1 ? "s" : ""}, before ${hm(r.time)}`
            )
          )
        );
      }
      for (const f of showEarlier ? flights : later) list.append(flightCard(f, r, i++, flags.get(f.no) || []));
      nodes.push(list);
    }

    nodes.push(
      h(
        "footer",
        { class: "status-foot" },
        h(
          "p",
          { class: "legend-note" },
          "Local times at each airport. Codeshares are left out, so each flight shows once under the airline that flies it. Flight data by ",
          h("a", { href: "https://aerodatabox.com", target: "_blank", rel: "noopener noreferrer", text: "AeroDataBox" }),
          "."
        ),
        footer()
      )
    );
    root.replaceChildren(...nodes);
    root.setAttribute("aria-busy", "false");
    restoreStepFocus(true);
  }

  function restoreStepFocus(done) {
    if (!focusStep) return;
    const btn = root.querySelector(`.day-step.${focusStep}`);
    (btn && !btn.disabled ? btn : root.querySelector(".day-step:not(:disabled)"))?.focus({ preventScroll: true });
    if (done) focusStep = null;
  }

  function paintError(err) {
    const { r } = current;
    const tryAgain = { label: "Try again", run: () => load(true) };
    const edit = { label: "Change search", secondary: true, run: editSearch };
    const byNumber = { label: "Track by flight number", run: () => navigate({ m: "flight" }) };
    const map = {
      offline: ["You're offline", "Check your connection. This page tries again by itself the moment you're back.", [tryAgain]],
      invalid_airport: ["We couldn't use those airports", err.message, [edit]],
      same_airport: ["From and To are the same", "Pick two different airports.", [edit]],
      invalid_date: ["That date doesn't look right", err.message, [edit]],
      date_out_of_range: ["That date is out of range", err.message, [edit]],
      rate_limited: ["That's a lot of searching", "Give it a minute, then try again.", [tryAgain, edit]],
      search_paused: ["Flight search is resting", err.message, [byNumber]],
      quota_exhausted: ["Flight data is resting", "This month's free flight lookups are used up. Trains still work.", []],
      // The page is newer than its data service, or flight search isn't switched on there yet.
      not_found: ["Flight search is almost ready", "Finding flights by airport is still being switched on. Track by flight number for now.", [byNumber]],
      search_not_configured: ["Flight search is almost ready", "Finding flights by airport is still being switched on. Track by flight number for now.", [byNumber]],
      flights_not_configured: ["Flights aren't switched on yet", "The site's flight data isn't connected yet. Trains work.", []],
      forbidden: ["This page can't reach live data", "The site isn't connected to its data service yet.", []],
      not_configured: ["This page can't reach live data", "The site isn't connected to its data service yet.", []],
    };
    const [t, b, actions] = map[err.code] || ["Schedules are taking a moment", "The flight schedule service didn't answer in time. It usually clears within a minute.", [tryAgain, edit]];
    root.replaceChildren(
      head(r, null),
      h(
        "div",
        { class: "empty compact", role: "alert" },
        h("span", { class: "err-icon" }, svg(errIcon(err.code))),
        h("h2", { class: "display", text: t }),
        h("p", { text: b })
      ),
      h("div", { class: "actions" }, actions.map((a) => h("button", { type: "button", class: `cta${a.secondary ? " secondary" : ""}`, text: a.label, on: { click: a.run } })))
    );
    root.setAttribute("aria-busy", "false");
  }

  function editSearch() {
    const { r } = current;
    navigate({ m: "flight", by: "route", from: r.from, to: r.to, d: r.date, t: r.time });
  }

  async function load(force = false) {
    const mine = ++token;
    const { r, key } = current;
    if (!force && memo.has(key) && Date.now() - memo.get(key).at < 5 * 60000) {
      current.data = memo.get(key).data;
      return paint();
    }
    root.setAttribute("aria-busy", "true");
    root.replaceChildren(head(r, null, { loading: true }), skeleton());
    restoreStepFocus(false);
    try {
      if (!navigator.onLine) throw new ApiError("offline", "You're offline.");
      const [data] = await Promise.all([
        api("/api/flights", { from: r.from, to: r.to, date: r.date, after: r.time }, { timeout: 25000, retries: 1 }),
        loadAirports().catch(() => null),
      ]);
      if (mine !== token) return;
      memo.set(key, { data, at: Date.now() });
      current.data = data;
      paint();
    } catch (err) {
      if (mine !== token) return;
      paintError(err instanceof ApiError ? err : new ApiError("network", "Could not reach live data."));
    }
  }

  const showing = () => !!current && !root.closest("[hidden]") && document.body.dataset.mode === "flight";
  window.addEventListener("online", () => {
    if (showing() && !current.data) load(true);
  });

  return {
    open(r, { pop = false } = {}) {
      const key = keyOf(r);
      const same = current && current.key === key;
      const keepScroll = pop && same ? current.scrollY : 0;
      current = { key, r, data: null, expanded: same ? current.expanded : false, scrollY: 0, mode: "flight" };
      load();
      return keepScroll;
    },
    leave(scrollY) {
      if (current) current.scrollY = scrollY;
    },
    /** Another search took over the shared list: drop any answer still on its way. */
    pause() {
      token++;
    },
    redraw() {
      if (!showing() || !current.data) return;
      const y = window.scrollY;
      paint();
      window.scrollTo({ top: y, behavior: "instant" });
    },
    swap() {
      if (!current) return;
      const { r } = current;
      navigate({ m: "flight", from: r.to, to: r.from, d: r.date, t: r.time }, { instant: true });
      toast("Showing the return journey");
    },
  };
}
