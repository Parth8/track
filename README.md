# Track

**A calm, ad-free live tracker for Indian trains and flights.**

Type a train or flight number, pick a date, and see where it is, whether it's late, and what that means for you. No ads, no sign-ups, no tracking, and no wall of telemetry.

**Live:** https://parth8.github.io/track/

---

## Why this exists

Most train trackers in India load hundreds of requests and megabytes of ads to answer one question: *where is my train?* Flight apps swing the other way and bury you in data you don't need.

Track is built on one idea: **show what matters to the traveller right now, and nothing else.**

- The hero is **your stop**, not the train's raw position.
- Flights reshape themselves by phase. Before takeoff the gate leads, in the air the map leads, and after landing your baggage belt leads.
- Data freshness is always visible. Stale or estimated information is labelled, never passed off as exact.
- A short "Good to know" section answers *so what?*: a long halt ahead, arriving before sunrise, a time-zone change, the weather where you're landing.

---

## Features

### Trains
- Find a train by number, or by **From and To**: pick two stations, the day you board and a time, and see every train between them. Tapping one opens its live status for the right run (worked out for you, even when it started the day before) with your stop already set.
- Station search runs on your device across 8,677 stations, by name, code, older name or nickname ("Mysore", "Bombay", "Trichy"), with each city's main station first
- Route results show departure and arrival, journey time, which days it runs, on-time record, the next one to leave and the fastest, nearby stations the train uses instead, and trains on the route that don't run that day
- **Seat availability** on every route result: tap a class (SL, 3A, 2A…) to see live IRCTC availability (available, RAC, waitlist or regret), the fare, the chance a waitlist confirms, and the next few runs. Tatkal is offered for tomorrow's trains.
- Live running status for the last 4 run dates, via a split-flap date picker
- "Your stop" countdown with delay, ETA and journey progress. Tap any station to make it your stop.
- Timeline with scheduled and actual or expected times, platforms, halts and day dividers for overnight runs
- Route map with the train placed from its last reported station
- Good to know: weather at your stop, arriving before sunrise or after dark, long halts ahead, overnight journeys, on-time record, coach order at the platform

### Flights
- Find a flight by number, or by **From and To**: pick two airports (city, airport name, code or older name like "Bombay"), a day and a time, and see every direct flight with local times at both ends, delays, cancellations, terminals and aircraft. Tapping one opens its live status. Codeshares are left out, so each flight shows once.
- Phase-aware layout: before takeoff, in the air, landed, cancelled, diverted
- Live position, altitude and speed from community ADS-B receivers, with an honest fallback when out of range
- Gate, terminal, check-in desks and baggage belt
- Good to know tiles: weather at both ends, aircraft type (narrow-body, wide-body, turboprop), flight time, distance, time-zone change, landing after dark

### Everywhere
- Shareable URLs. The whole state lives in the address bar, for example `?m=train&no=12786&d=2026-09-29&s=KCG`
- Add to home screen. Opens full-screen like an app, with no app store. The button only appears where the browser can actually add it (iPhone, iPad, Android, Chrome and Edge, Safari on a Mac) and hides once it's added. Chrome and Edge get a one-tap install as soon as they allow it, even with the panel already open. Apple devices, which can't be added by a site, get a two-step picture guide matched to their browser and version
- A settings menu at the top right (home and search screens) for appearance and clock
- Light, dark or match-device appearance (the site's own palette is the default)
- 12-hour or 24-hour clock (it follows your device until you pick). Times on a later day than the journey's start carry a "+1", as printed timetables do
- Auto-refresh while visible, paused in background tabs
- Friendly error screens with next steps, auto-retry countdowns and offline recovery
- Respects reduced motion. Keyboard and screen-reader friendly.

---

## Architecture

```
Browser (GitHub Pages: static HTML, CSS, ES modules)
   │
   │  GET /api/train | /api/between | /api/seats | /api/flight | /api/flights | /api/weather
   ▼
Cloudflare Worker ── validates input, checks origin, rate-limits, caches
   │
   ├── Trains:  crowd-sourced running feed (primary for today)
   │            official NTES enquiry (primary for past runs, fallback, coach order)
   │            published timetable (trains between two stations)
   │            IRCTC seat availability, via the same feed's seat enquiry
   ├── Flights: AeroDataBox (schedule, gate, belt, airport departure boards)
   │            adsb.lol + adsb.fi (live position, raced in parallel)
   └── Weather: Open-Meteo
   │
   ▼
Normalised JSON, one shape per mode, whichever source answered
```

The frontend never talks to a data provider directly and never learns which one answered. Swapping or adding a source is a Worker change only.

**No build step.** The site is plain HTML, CSS and native ES modules. MapLibre and the fonts are self-hosted and version-pinned.

> The Worker lives in `worker/worker.js` and is deployed separately to Cloudflare (see Deploying). Its contract is documented below.

---

## Project structure

```
index.html            Shell, security policy, the four screens, settings menu, sources sheet
manifest.webmanifest  Name, icons and full-screen mode for add to home screen
styles.css            Design tokens, light and dark themes, components, motion
js/
  main.js             Routing (URL is the only state), sessions, refresh, errors
  train.js            Train status screen
  flight.js           Flight status screen (phase-based layout)
  map.js              Lazy MapLibre map, pastel restyle, route and marker
  loader.js           Journey-style loading animation
  flip.js             Split-flap date picker
  api.js              Worker client: timeout, one retry, error normalisation
  util.js             Safe DOM builder, time zones, geometry
  icons.js            Static, trusted SVG only
  theme.js            Applies the saved appearance before first paint
  install.js          Add to home screen: which way this browser does it, if at all
  guide.js            Picture guides for adding Track on iPhone, iPad and Mac (static SVG)
  finder.js           Route finder: From/To fields (stations or airports), time picks, train results, seats
  flight-finder.js    Flight results for a route search
  stations.js         Station list loading and on-device search
  airports.js         Airport list loading and on-device search
data/stations.json    Passenger stations: [code, name, older name] (built by tools/)
data/airports.json    Airports with scheduled flights: [code, city, name, country, size, older name]
tools/                build-stations.mjs, build-airports.mjs (data lists), build-icons.mjs (app icons)
worker/worker.js      The Cloudflare Worker (data service)
tests/                Worker and station tests (node --test), browser tests for the route finder
icons/                Home-screen and app icons (PNG, rendered by tools/build-icons.mjs)
screenshots/          Install-dialog screenshots for Android and desktop Chrome (sample data, not a real journey)
vendor/maplibre/      MapLibre GL JS 6.11.2 (self-hosted)
fonts/                Fraunces, Plus Jakarta Sans and Caveat (self-hosted)
```

---

## Worker API contract

All routes are `GET`. Responses are JSON. Errors look like `{ "error": "code", "message": "Human sentence." }`.

### `GET /api/train?no=12786&date=2026-09-29`
| Param | Rule |
|---|---|
| `no` | 5 digits |
| `date` | `YYYY-MM-DD`, today back to 3 days ago (IST). Defaults to today. |

Response shape (abridged):
```json
{
  "kind": "train", "number": "12786", "name": "...", "date": "2026-09-29",
  "origin": { "code": "AP", "name": "Ashokapuram" },
  "destination": { "code": "KCG", "name": "Kacheguda" },
  "status": { "phase": "not_started | running | arrived", "delayMin": 12, "lastUpdated": "ISO", "servedStale": false },
  "position": { "kmDone": 322, "kmTotal": 769, "stationCode": "BSPL", "stationName": "...", "state": "at | passed", "kmPast": 3 },
  "stops": [{
    "code": "MBNR", "name": "...", "km": 663, "lat": 16.75, "lon": 77.99, "halts": true,
    "platform": "4", "haltMin": 2, "onTimeRating": 6, "passed": false,
    "sched":    { "arr": "ISO", "dep": "ISO" },
    "actual":   { "arr": "ISO", "dep": "ISO" },
    "expected": { "arr": "ISO", "dep": "ISO" },
    "delay":    { "arr": 12, "dep": 12 }
  }],
  "coaches": [{ "code": "KCG", "list": [{ "id": "S1" }] }]
}
```
All times are ISO 8601 with a `+05:30` offset. `stops` includes non-halting stations (`halts: false`) so the map can draw the full line.

### `GET /api/flight?no=6E6252&date=2026-09-29`
| Param | Rule |
|---|---|
| `no` | Airline code plus number, spaces optional (`6E6252`, `AI 101`) |
| `date` | Departure date, local to the departure airport, 2 days back to 7 days ahead |

Response shape (abridged):
```json
{
  "kind": "flight", "number": "6E 6252", "airline": { "name": "IndiGo", "iata": "6E" },
  "status": { "phase": "pre | air | landed | cancelled | diverted", "raw": "EnRoute", "delayDep": 0, "delayArr": -24, "inferred": false },
  "departure": { "code": "HYD", "city": "...", "tz": "Asia/Kolkata", "lat": 17.24, "lon": 78.43,
                 "sched": "ISO", "revised": "ISO", "runway": "ISO", "actual": "ISO",
                 "terminal": "2", "gate": "17", "checkIn": "8-12" },
  "arrival":   { "...same fields...": "", "belt": "2" },
  "distanceKm": 1497,
  "aircraft": { "model": "Airbus A320neo", "reg": "VT-ISA", "hex": "800c5d" },
  "position": { "lat": 23.2, "lon": 77.4, "altFt": 36000, "speedKmh": 815, "trackDeg": 350,
                "at": "ISO", "ageSec": 20, "source": "live | reported", "via": "adsb.lol" }
}
```
`position` is `null` when no receiver has heard the aircraft in the last 10 minutes. The frontend then estimates the position from the schedule and labels it as an estimate. `status.inferred` is `true` when a plane was spotted airborne before the airline updated its status.

### `GET /api/between?from=MYS&to=KCG&date=2026-10-02`
| Param | Rule |
|---|---|
| `from`, `to` | Station codes, 1 to 5 letters, different from each other |
| `date` | The day you board at `from`, `YYYY-MM-DD`, 3 days back to 120 days ahead (IST) |

Response shape (abridged):
```json
{
  "kind": "between", "date": "2026-10-02",
  "from": { "code": "MYS", "name": "Mysore Jn" }, "to": { "code": "KCG", "name": "Kacheguda" },
  "trains": [{
    "number": "12786", "name": "Ashokapuram - Kacheguda SF Express",
    "from": { "code": "MYS", "name": "Mysore Jn" }, "to": { "code": "KCG", "name": "Kacheguda" },
    "startDate": "2026-10-02", "dep": "ISO", "arr": "ISO", "durationMin": 865,
    "runDays": ["Mon", "Tue"], "onTimeRating": 9, "distanceKm": 763, "pantry": false, "special": false
  }],
  "others": [{ "number": "12975", "name": "...", "depTime": "10:30", "arrTime": "01:30", "arrDay": 1, "runDays": ["Thu", "Sat"], "nextDate": "2026-10-03" }]
}
```
`trains` are sorted by departure. `startDate` is the day the train's run began, which is the date the live tracker needs (a train you board after midnight may have started the day before). A train's `from` or `to` can be a nearby station the timetable suggests, such as Delhi Jn for New Delhi. `others` are trains on the route that don't run that day, with the next date they do.

Each train also lists `classes`, the travel classes it carries on this route (`["SL", "3A", "2A"]`).

### `GET /api/seats?no=12306&from=NDLS&to=HWH&date=2026-10-09&cls=3A&quota=GN`
| Param | Rule |
|---|---|
| `no` | Train number, 5 digits |
| `from`, `to` | The train's own boarding and destination codes from `/api/between` |
| `date` | The day you board, today to 120 days ahead |
| `cls` | `1A 2A 3A 3E EA EC EV CC FC SL 2S` |
| `quota` | `GN` (General, default) or `TQ` (Tatkal) |

```json
{
  "kind": "seats", "number": "12306", "cls": "3A", "className": "AC 3 Tier", "quota": "GN", "quotaName": "General",
  "days": [{ "date": "2026-10-09", "kind": "waitlist", "count": 47, "label": "Waitlist 47", "raw": "GNWL119/WL47",
             "fare": 3225, "baseFare": 2825, "catering": 400, "chance": 38 }],
  "updatedAt": "ISO", "source": "IRCTC"
}
```
`kind` is `available`, `rac`, `waitlist`, `regret`, `closed` or `unknown`. `days` holds the asked-for day and the next few runs. `chance` is a confirmation estimate, for waitlist and RAC only.

### `GET /api/flights?from=DEL&to=BLR&date=2026-10-02&after=17:00`
| Param | Rule |
|---|---|
| `from`, `to` | IATA airport codes, 3 letters, different from each other |
| `date` | Local departure date at `from`, yesterday to 7 days ahead |
| `after` | Optional `HH:MM`. From `12:00` on, only the afternoon half of the board is looked up |

```json
{
  "kind": "flights", "date": "2026-10-02", "from": { "code": "DEL" }, "to": { "code": "BLR", "name": "Bengaluru", "tz": "Asia/Kolkata" },
  "flights": [{
    "number": "6E 6814", "no": "6E6814", "date": "2026-10-02", "airline": { "name": "IndiGo", "iata": "6E" },
    "status": { "raw": "Expected", "phase": "pre", "delayMin": null },
    "dep": { "sched": "ISO", "local": "23:40", "localDate": "2026-10-02", "revisedLocal": null, "terminal": "1" },
    "arr": { "code": "BLR", "sched": "ISO", "local": "02:25", "localDate": "2026-10-03", "terminal": null },
    "durationMin": 165, "aircraft": "Airbus A321 NEO"
  }],
  "partial": false, "partialNote": null, "asOf": "ISO"
}
```
Built from the origin's departure board (AeroDataBox FIDS) in two 12-hour slots. Each slot is cached and shared by every search from that airport and day, whatever the destination, so a search costs at most two paid lookups and usually none. `partial` is `true` when one half of the day couldn't be loaded, and `partialNote` says why.

### `GET /api/weather?lat=17.39&lon=78.50`
Current conditions, hourly forecast and sunrise and sunset for the next few days, in the location's own time zone.

### Error codes
| Code | Status | Meaning |
|---|---|---|
| `invalid_train`, `invalid_flight`, `invalid_station`, `same_station`, `invalid_airport`, `same_airport`, `invalid_class`, `invalid_quota`, `invalid_date`, `date_out_of_range` | 400 | Input failed validation |
| `forbidden` | 403 | Request came from a site not in `ALLOWED_ORIGINS` |
| `not_found` | 404 | No run or flight for that number and date |
| `class_not_found`, `not_running`, `tatkal_closed` | 404 | That class isn't on the train, the train doesn't run that day, or Tatkal isn't open yet |
| `rate_limited` | 429 | More than 40 requests a minute from one visitor |
| `upstream_unavailable` | 502 | Every source failed or timed out |
| `flights_not_configured` | 503 | No AeroDataBox key set |
| `quota_exhausted` | 503 | Monthly flight lookups used up |
| `search_not_configured` | 503 | Flight search needs the `QUOTA` KV binding (tracking by number still works) |
| `search_paused` | 503 | Flight search used this month's `FLIGHT_SEARCH_CAP`; it resumes on the 1st |

### Freshness and caching
| Data | Fresh for | Notes |
|---|---|---|
| Train status | 45 s | The page refreshes every 60 s while visible |
| Flight status | 5 to 60 min, by phase | Protects the free flight-data quota |
| Live aircraft position | 20 s | Free, so looked up on every refresh |
| Weather | 15 min | |
| Trains between stations | 6 h | Timetables rarely change, so one lookup serves everyone |
| Seat availability | 10 min | Moves through the day, but one lookup serves everyone checking that train |
| Airport departure boards (flight search) | 15 min for today, 6 h for later days | Paid lookups, shared by every search from that airport |
| Backup copy of any result | 6 h | Served, and flagged, if every source is down |

---

## Deploying

### 1. The Worker (Cloudflare dashboard, no CLI needed)
1. Workers & Pages → Create → Hello World → name it `journey-api` → Deploy.
2. Edit code → paste `worker/worker.js` → Deploy. Do this again whenever `worker/worker.js` changes.
3. Settings → Variables and Secrets:

| Name | Type | Value |
|---|---|---|
| `ALLOWED_ORIGINS` | Text | `https://parth8.github.io` (the domain only, no path) |
| `ADB_KEY` | **Secret** | AeroDataBox key from RapidAPI (optional; flights stay off without it) |
| `ADB_HOST` | Text | Optional. Defaults to `aerodatabox.p.rapidapi.com` |
| `REQUIRE_ORIGIN` | Text | `false` only while testing in a browser tab. Remove afterwards. |
| `FLIGHT_SEARCH_CAP` | Text | Optional. Paid airport lookups flight search may use per month (default `40`, which is 80 of the free plan's 400 monthly units). `0` pauses flight search. |

4. **Flight search** needs a place to count its monthly lookups, so it can stop before live tracking runs out of quota:
   - Storage & Databases → KV → Create namespace → name it `track-quota`.
   - Back in the Worker: Settings → Bindings → Add → KV namespace → Variable name `QUOTA`, namespace `track-quota` → Deploy.

   Without it, flight search shows "almost ready" and everything else works. Each search uses at most 2 lookups from the AeroDataBox plan, and searches from the same airport and day share them.

Optionally, add a Rate Limiting binding named `LIMITER` for platform-level rate limits. Without it, the Worker uses a simpler limiter that runs separately in each Cloudflare data center.

### 2. The site (GitHub Pages)
1. Upload the repository contents with `index.html` at the root.
2. Settings → Pages → deploy from `main`, root folder.

### 3. Pointing the site at a different Worker
The Worker address appears twice at the top of `index.html`: in `<meta name="api-base">` and in the `connect-src` part of the security policy. Change both.

---

## Security and privacy

- **Strict Content Security Policy.** Scripts load only from this site. The page can connect only to its own Worker and the map tile server.
- **No untrusted HTML.** All API data is written with `textContent`. The only markup inserted is static SVG from `icons.js`.
- **Secrets stay server-side.** The AeroDataBox key lives in the Worker as a secret and never reaches the browser or this repository.
- **The Worker validates everything.** It checks each request's origin against an allowlist, rate-limits per visitor, and validates every input before calling a source.
- **Nothing about visitors is stored.** No accounts, cookies, analytics or history. The only things kept on a device are the appearance and clock choices, in `localStorage`. The Worker's KV store holds one number per month: how many flight-search lookups were used.
- **No referrers are sent.** Referrers are suppressed and credentials are omitted from API calls.

---

## Testing

```
node --test tests/*.test.mjs           # Worker, station and airport search, offline
python3 -m http.server 8765            # then, in another terminal:
node tests/finder.e2e.mjs              # route finders, seats and the clock setting in a real browser (needs Playwright)
```
Worker tests answer upstream calls from recorded responses in `tests/fixtures`, so they run offline and give the same result every time. Flight search is tested against a departure board in AeroDataBox's published format (`tests/fids.mjs`).

To refresh the airport list, download `airports.csv` and `countries.csv` from [OurAirports](https://ourairports.com/data/) and run `node tools/build-airports.mjs airports.csv countries.csv > data/airports.json`. To redraw the app icons, run `node tools/build-icons.mjs`.

To refresh the station list, save NTES's station list (the `arrStationList` array) as JSON and run `node tools/build-stations.mjs ntes.json datameet-stations.json > data/stations.json`.

---

## Known limitations

- **Train data is crowd-sourced first.** It usually matches the official feed within a minute, but it can shift. The timeline says so.
- **Train positions come from station reports.** The train is placed along the line from its last report, not from GPS.
- **ADS-B coverage over India is patchy.** Altitude and speed appear only when a community receiver can hear the aircraft. Otherwise the app shows time in the air and distance left.
- **The official railway feed may block some cloud regions.** Visitors outside India may only get the crowd-sourced source.
- **Flight data runs on a free plan.** Its monthly lookup quota is shared by everyone using this deployment.
- **Unofficial access.** Railway data is fetched from public pages without an official API. Keep usage personal and cached.
- **Route search shows direct trains and flights only.** Journeys that need a change aren't suggested.
- **Flight search has a monthly budget.** It pauses when `FLIGHT_SEARCH_CAP` is reached, so tracking by flight number keeps working. Departure boards for today are up to 15 minutes old; tap a flight for its live status.
- **Seat availability is a snapshot.** It's up to 10 minutes old and can change before you book. Book on IRCTC.

---

## Data sources and attribution

| Data | Source | Licence or terms |
|---|---|---|
| Train running status | Crowd-sourced running feed and Indian Railways NTES public enquiry | Public pages, unofficial use |
| Trains between stations | Published timetable, via the crowd-sourced feed's timetable search | Public pages, unofficial use |
| Station names and codes | Indian Railways NTES station list | Public data |
| Older station names (search only) | [datameet/railways](https://github.com/datameet/railways) | CC0 |
| Seat availability and fares | IRCTC, via the crowd-sourced feed's seat enquiry | Public pages, unofficial use |
| Airport names and codes | [OurAirports](https://ourairports.com/data/) | Public domain |
| Flight schedules, gates, belts | [AeroDataBox](https://aerodatabox.com) | Attribution required (shown on every flight screen) |
| Live aircraft positions | [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi) | ODbL (adsb.lol); non-commercial with credit (adsb.fi) |
| Map tiles | [OpenFreeMap](https://openfreemap.org), [OpenMapTiles](https://openmaptiles.org) | Free, attribution required |
| Map data | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | ODbL |
| Weather | [Open-Meteo](https://open-meteo.com) | CC BY 4.0 |

### Bundled third-party code and fonts
| Component | Version | Licence |
|---|---|---|
| MapLibre GL JS | 6.11.2 | BSD-3-Clause (`vendor/maplibre/LICENSE.txt`) |
| Fraunces | Variable (Fontsource 5.3.0) | SIL Open Font License 1.1 |
| Plus Jakarta Sans | Variable (Fontsource 5.3.0) | SIL Open Font License 1.1 |
| Caveat | 400, Latin subset (Fontsource 5.3.0) | SIL Open Font License 1.1 |

Track is not affiliated with Indian Railways, any airline, or any provider above. Always confirm times at the station or with your airline.

---

## Roadmap

Deliberately short. Depth over breadth.

- [x] Find a train by stations, date and time
- [x] Seat availability on route results
- [x] Find a flight by airports, date and time
- [ ] Small test suite for time zones, geometry, delay logic and phase rendering (Worker and station tests are in)
- [ ] "Should I leave for the station now?" nudge
- [ ] Clearer disruption explanations (diversions, reschedules, cancellations)
- [ ] Screenshots in this README

---

Built with ♥ (and coffee and Claude) by [Parth](https://parth8.github.io/portfolio/), because life's too short for trackers that fire 266 requests to show you one train.

[LinkedIn](https://linkedin.com/in/aggarwalparth) · [Portfolio](https://parth8.github.io/portfolio/)
