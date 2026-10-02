// Airports for the flight route finder. The list (data/airports.json, built by
// tools/build-airports.mjs from OurAirports) loads once, the first time it's needed,
// and every search runs on the device.

// What most people mean by a city's name, and the busiest airports worldwide.
const HUB = new Set(
  (
    "DEL BOM BLR HYD MAA CCU AMD PNQ COK GOI GOX JAI LKO GAU TRV IXC PAT SXR VNS BBI IDR NAG ATQ CCJ IXE CJB VTZ IXB IXZ " +
    "DXB AUH DOH SIN LHR JFK BKK KUL HKG FRA CDG SFO ORD YYZ SYD MEL NRT HND ICN AMS IST MCT BAH KWI RUH JED CMB KTM DAC MLE"
  ).split(" ")
);
export const POPULAR = ["DEL", "BOM", "BLR", "HYD", "MAA", "CCU", "GOI", "PNQ", "AMD", "COK"];
// India's busiest airports, busiest first: breaks ties like "ban" (Bengaluru before Varanasi).
const BUSY = "DEL BOM BLR HYD MAA CCU AMD COK PNQ GOX GOI GAU JAI LKO TRV CCJ IXC PAT SXR BBI VNS IDR NAG".split(" ");

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const wordsOf = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

let all = null;
let byCode = null;
let loading = null;

export function loadAirports() {
  if (!loading) {
    loading = fetch(new URL("../data/airports.json", import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`airports ${r.status}`);
        return r.json();
      })
      .then(({ countries, airports }) => {
        // Cities with more than one airport in the same country (London, New York, Goa).
        const perCity = new Map();
        for (const [, city, , cc] of airports) perCity.set(`${city}|${cc}`, (perCity.get(`${city}|${cc}`) || 0) + 1);
        all = airports.map(([code, city, airport, cc, size, alias]) => {
          // A city with more than one airport shows which one: "London Heathrow", "Goa (Mopa)".
          const shared = perCity.get(`${city}|${cc}`) > 1 && airport;
          // "Colombo Bandaranaike", "London Heathrow": city first, then what tells the airports apart.
          const rest = shared ? airport.replace(new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "").replace(/\s+/g, " ").trim() : "";
          const name = !shared ? city : rest ? `${city} ${rest}` : airport;
          return {
            code,
            name,
            city,
            airport: airport || null,
            cc,
            country: countries[cc] || cc,
            alias: alias || null,
            words: wordsOf(`${name} ${city}`),
            airportWords: wordsOf(airport || ""),
            aliasWords: wordsOf(alias || ""),
            flat: squash(name),
            cityFlat: squash(city),
            size,
            hub: HUB.has(code),
          };
        });
        byCode = new Map(all.map((a) => [a.code, a]));
        return all;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

export const airportsReady = () => !!all;
export const airportByCode = (code) => (byCode && byCode.get(String(code || "").toUpperCase())) || null;

/** Best matches for a city, airport name, older name ("Bombay") or code. Returns [{ station, via }]. */
export function searchAirports(query, limit = 8) {
  if (!all) return [];
  const flat = squash(query);
  if (!flat) return [];
  const qWords = wordsOf(query);
  const asCode = flat.toUpperCase();
  const out = [];
  for (const a of all) {
    let score = 0;
    let via = "name";
    if (a.code === asCode) score = 900;
    else if (a.flat.startsWith(flat) || a.cityFlat.startsWith(flat)) score = 700;
    else if (qWords.every((w) => a.words.some((x) => x.startsWith(w)))) score = 560;
    else if (qWords.every((w) => a.aliasWords.some((x) => x.startsWith(w)))) {
      score = 520;
      via = "alias";
    } else if (qWords.every((w) => a.airportWords.some((x) => x.startsWith(w)))) {
      score = 460;
      via = "airport";
    } else if (flat.length >= 3 && [...a.words, ...a.airportWords].some((w) => w.includes(flat))) score = 200;
    if (!score) continue;
    if (a.cc === "IN") score += 180;
    if (a.hub) score += 150;
    const busy = BUSY.indexOf(a.code);
    if (busy >= 0) score += 60 - busy * 2;
    score += a.size === "l" ? 90 : a.size === "m" ? 30 : 0;
    score -= a.name.length * 0.3;
    out.push({ station: a, via, score });
  }
  out.sort((x, y) => y.score - x.score || (x.station.name < y.station.name ? -1 : 1));
  return out.slice(0, limit);
}

/** Free text to one airport when it's unambiguous: a code, or a city with one airport. */
export function resolveAirport(text) {
  if (!all) return null;
  const flat = squash(text || "");
  if (!flat) return null;
  // A name beats a code that happens to match ("goa" is Goa, not Genoa's GOA); two matches wait for a pick.
  const named = all.filter((a) => a.flat === flat || a.cityFlat === flat || a.aliasWords.join("") === flat || squash(a.alias || "") === flat);
  if (named.length) return named.length === 1 ? named[0] : null;
  return flat.length === 3 ? byCode.get(flat.toUpperCase()) || null : null;
}

/** Everything the From/To fields need to search airports. */
export const airportSource = {
  kind: "flight",
  load: loadAirports,
  ready: airportsReady,
  byCode: airportByCode,
  search: searchAirports,
  resolve: resolveAirport,
  popular: () => POPULAR.map(airportByCode).filter(Boolean),
  popularHeading: "Popular airports",
  noun: "airport",
  placeholder: "City, airport or code",
  loadingText: "Loading airports",
  loadFail: "Couldn't load the airport list. Check your connection and try again.",
  empty: (q) => `No airport matches “${q}”. Try its 3-letter code, like HYD.`,
  sub: (a, via) =>
    via === "alias" && a.alias
      ? `Also known as ${a.alias}`
      : [a.name === a.city || !a.airport || a.name.includes(a.airport) ? null : a.airport, a.cc === "IN" ? null : a.country].filter(Boolean).join(" · ") || null,
};
