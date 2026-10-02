// Station names and codes for the route finder. The list (data/stations.json, built by
// tools/build-stations.mjs from NTES's station list) loads once, the first time it's needed,
// and every search after that runs on the device: instant, and nothing is sent anywhere.

// Big stations people search for most. They rank first when a search matches several.
const MAJOR = new Set(
  (
    "NDLS DLI NZM DEE ANVT DEC CSMT MMCT LTT BDTS DR TNA KYN PUNE PNVL HWH SDAH KOAA SHM SRC MAS MS TBM SBC SMVB YPR BNC " +
    "KJM SC HYB KCG LPI CHZ BZA VSKP TPTY RU GNT RJY NLR ADI ST BRC RJT JP AII JU BKN UDZ KOTA LKO LJN CNB PRYJ BSB GKP PNBE DNR " +
    "PPTA RNC HTE TATA DHN ASN BBS PURI CTC GHY KYQ NJP KIR MFP DBG BJU BPL RKMP ET JBP INDB UJN NGP R BSP DURG GWL VGLJ AGC " +
    "MTJ ALJN ASR JAT SVDK LDH UMB CDG DDN HW BRY MB ERS ERN TVC CLT CBE MDU TPJ SA ED MAQ MAJN MAO BGM UBL MYS GTL DMM NED " +
    "AWB CPSN SUR MMR NK BSL AK BPQ WL KZJ DDU AY BE GZB MTC HRI SPN KGP BLS JSME SBP RTM KGM HDW"
  ).split(" ")
);

// The main station of each big city: what most people mean when they type the city's name.
const HUB = new Set(
  "NDLS MAS HWH CSMT MMCT SBC SC HYB PUNE ADI LKO PNBE BSB JP BPL NGP GHY TVC ERS BBS CNB PRYJ AGC ASR CDG MAO".split(" ")
);

// A few official names are long enough to be hard to read in a list.
const DISPLAY = {
  MAS: "MGR Chennai Central",
  SBC: "KSR Bengaluru",
  CSMT: "Mumbai CSMT",
  MMCT: "Mumbai Central",
  LTT: "Mumbai LTT",
  DDU: "Pt. Deen Dayal Upadhyaya Jn",
  CPSN: "Chhatrapati Sambhajinagar",
};
// Extra words people use for these stations.
const EXTRA = {
  MAS: "Chennai Central Madras",
  SBC: "Bangalore Bengaluru City",
  CSMT: "Chhatrapati Shivaji Maharaj Terminus Mumbai VT Bombay",
  MMCT: "Bombay Central BCT",
  LTT: "Lokmanya Tilak Terminus Kurla",
  NDLS: "Delhi",
  DLI: "Old Delhi",
  HWH: "Kolkata Calcutta",
  SDAH: "Kolkata Calcutta",
  KOAA: "Kolkata Chitpur",
  SC: "Hyderabad",
  KCG: "Hyderabad",
  CPSN: "Aurangabad",
  PRYJ: "Allahabad",
  DDU: "Mughalsarai",
  VGLJ: "Jhansi",
  RKMP: "Habibganj Bhopal",
  BSB: "Banaras Varanasi",
  AY: "Ayodhya",
  MAO: "Goa Margao",
  VSG: "Goa Vasco",
  THVM: "Goa",
  KRMI: "Goa Panaji",
  TPJ: "Trichy",
  VSKP: "Vizag",
  ERS: "Kochi Cochin",
  ERN: "Kochi Cochin",
  CLT: "Calicut",
  TVC: "Trivandrum",
  BRC: "Baroda",
  GGN: "Gurugram",
  MAQ: "Mangaluru",
  MAJN: "Mangaluru",
  CBE: "Kovai",
  JAT: "Jammu",
  SVDK: "Katra Vaishno Devi",
  BSBS: "Varanasi",
};
export const POPULAR = ["NDLS", "CSMT", "HWH", "MAS", "SBC", "SC", "PUNE", "ADI", "LKO", "PNBE"];

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const wordsOf = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

let all = null; // [{ code, name, alias, words, aliasWords, flat, aliasFlat, major }]
let byCode = null;
let loading = null;

/** Load the list once. Safe to call many times. */
export function loadStations() {
  if (!loading) {
    loading = fetch(new URL("../data/stations.json", import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`stations ${r.status}`);
        return r.json();
      })
      .then((rows) => {
        all = rows.map(([code, official, alias]) => {
          const name = DISPLAY[code] || official;
          const extra = [alias, DISPLAY[code] ? official : null, EXTRA[code]].filter(Boolean).join(" ");
          return {
            code,
            name,
            alias: alias || null,
            words: wordsOf(name),
            aliasWords: wordsOf(extra),
            flat: squash(name),
            aliasFlat: squash(extra),
            major: MAJOR.has(code),
            hub: HUB.has(code),
          };
        });
        byCode = new Map(all.map((s) => [s.code, s]));
        return all;
      })
      .catch((err) => {
        loading = null; // let the next attempt try again
        throw err;
      });
  }
  return loading;
}

export const stationsReady = () => !!all;

/** A station by code, or null (also null until the list has loaded). */
export function stationByCode(code) {
  return (byCode && byCode.get(String(code || "").toUpperCase())) || null;
}

/** The name to show for a code, falling back to what we were given. */
export const stationName = (code, fallback) => stationByCode(code)?.name || fallback || code;

/**
 * Best matches for what someone typed: code, name, older name or a nickname
 * ("Bombay", "Mysore"). Returns [{ station, via }] where `via` says what matched.
 */
export function searchStations(query, limit = 8) {
  if (!all) return [];
  const q = query.trim().toLowerCase();
  const flat = squash(q);
  if (!flat) return [];
  const qWords = wordsOf(q);
  const asCode = flat.toUpperCase();
  const out = [];

  for (const s of all) {
    let score = 0;
    let via = "name";
    // An exact code ranks high, but a city's main station still wins ("del" is New Delhi before Denduluru).
    if (s.code === asCode) score = 700;
    else if (s.flat.startsWith(flat)) score = 640;
    else if (qWords.length && qWords.every((w) => s.words.some((x) => x.startsWith(w)))) score = s.words[0].startsWith(qWords[0]) ? 560 : 470;
    else if (flat.length <= 4 && s.code.startsWith(asCode)) score = 420;
    else if (qWords.length && qWords.every((w) => s.aliasWords.some((x) => x.startsWith(w)))) {
      score = 380;
      via = "alias";
    } else if (flat.length >= 3 && s.words.some((w) => w.includes(flat))) score = 220;
    else if (flat.length >= 4 && s.aliasWords.some((w) => w.includes(flat))) {
      score = 180;
      via = "alias";
    }
    if (!score) continue;
    if (s.major) score += 140;
    if (s.hub) score += 260;
    if (/ jn$/i.test(s.name)) score += 15;
    if (/\b(halt|h|p\.?h\.?)$/i.test(s.name)) score -= 45;
    score -= s.name.length * 0.4; // shorter names first among equals
    out.push({ station: s, via, score });
  }
  out.sort((a, b) => b.score - a.score || (a.station.name < b.station.name ? -1 : 1));
  return out.slice(0, limit);
}

/** Resolve free text to one station when it's unambiguous: an exact code or exact name. */
export function resolveStation(text) {
  if (!all) return null;
  const flat = squash(text);
  if (!flat) return null;
  const exactCode = byCode.get(flat.toUpperCase());
  if (exactCode) return exactCode;
  const exactName = all.filter((s) => s.flat === flat || squash(s.alias || "") === flat);
  return exactName.length === 1 ? exactName[0] : null;
}

/** Everything the From/To fields need to search stations. */
export const stationSource = {
  kind: "train",
  load: loadStations,
  ready: stationsReady,
  byCode: stationByCode,
  search: searchStations,
  resolve: resolveStation,
  popular: () => POPULAR.map(stationByCode).filter(Boolean),
  popularHeading: "Popular stations",
  noun: "station",
  placeholder: "Station name or code",
  loadingText: "Loading stations",
  loadFail: "Couldn't load the station list. Check your connection and try again.",
  empty: (q) => `No station matches “${q}”. Try its code, like MYS.`,
  sub: (st, via) => (via === "alias" && st.alias ? `Also known as ${st.alias}` : null),
};
