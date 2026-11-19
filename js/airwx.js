// An airport's own weather, in plain words. METAR is what the airport observed (every half hour
// or so); TAF is its forecast, in time windows. Both are what pilots and airlines plan with, so
// they say more about a flight than a city forecast does: visibility, fog, storms, wind.

const WX = {
  TS: "thunderstorm", RA: "rain", DZ: "drizzle", SN: "snow", SG: "snow grains", PL: "ice pellets", GR: "hail", GS: "small hail",
  FG: "fog", BR: "mist", HZ: "haze", FU: "smoke", DU: "dust", SA: "sand", VA: "volcanic ash", SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm", PO: "dust whirls", UP: "precipitation",
};
const QUAL = { MI: "shallow", BC: "patches of", PR: "partial", DR: "drifting", BL: "blowing", SH: "showers of", FZ: "freezing" };
const COVER = { FEW: "a few clouds", SCT: "scattered clouds", BKN: "mostly cloudy", OVC: "overcast", VV: "sky hidden", CAVOK: "clear", SKC: "clear", CLR: "clear", NSC: "no low cloud", NCD: "clear" };

/** "BR HZ" → "mist and haze"; "-TSRA" → "light thunderstorm with rain"; "VCSH" → "showers nearby". */
export function wxWords(code) {
  if (!code) return null;
  const parts = String(code)
    .split(/\s+/)
    .map((t) => {
      let s = t;
      let lead = "";
      let near = false;
      if (s.startsWith("-")) ((lead = "light "), (s = s.slice(1)));
      else if (s.startsWith("+")) ((lead = "heavy "), (s = s.slice(1)));
      if (s.startsWith("VC")) ((near = true), (s = s.slice(2)));
      const bits = [];
      let q = "";
      for (const k of Object.keys(QUAL)) if (s.startsWith(k)) ((q = QUAL[k]), (s = s.slice(2)));
      const ts = s.startsWith("TS");
      if (ts) s = s.slice(2);
      while (s.length >= 2) {
        const w = WX[s.slice(0, 2)];
        if (w) bits.push(w);
        s = s.slice(2);
      }
      let words = ts ? `thunderstorm${bits.length ? ` with ${bits.join(" and ")}` : ""}` : `${q ? `${q} ` : ""}${bits.join(" and ")}`;
      if (q === "showers of" && !bits.length) words = "showers";
      words = `${lead}${words}`.trim();
      return words ? (near ? `${words} nearby` : words) : null;
    })
    .filter(Boolean);
  return parts.length ? (parts.length === 2 ? parts.join(" and ") : parts.join(", ")) : null;
}

/** The sky: "clear", "scattered clouds", from the cloud layers (lowest that matters). */
export function skyWords(clouds, cover) {
  if (cover && COVER[cover] && !clouds?.length) return COVER[cover];
  const order = ["OVC", "BKN", "SCT", "FEW", "VV"];
  const worst = order.find((c) => (clouds || []).some((x) => x.cover === c));
  const cb = (clouds || []).some((x) => x.type === "CB");
  return worst ? `${COVER[worst]}${cb ? ", storm clouds" : ""}` : cover ? COVER[cover] || null : null;
}

/** "4 km", "800 m", "10 km or more". */
export function visWords(km, plus = false) {
  if (km == null) return null;
  if (km >= 9.9 || plus) return "10 km or more";
  return km < 1 ? `${Math.round((km * 1000) / 50) * 50} m` : `${Math.round(km * 10) / 10} km`;
}

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** "calm", "light, variable", "18 km/h from the NE, gusting 37". */
export function windWords(dir, kt, gust) {
  if (kt == null) return null;
  const kmh = (k) => Math.round(k * 1.852);
  if (kt < 2) return "calm";
  const from = dir === "VRB" || dir == null ? "variable" : `from the ${DIRS[Math.round(((+dir % 360) + 360) % 360 / 45) % 8]}`;
  return `${kmh(kt)} km/h ${from}${gust ? `, gusting ${kmh(gust)}` : ""}`;
}

/** The forecast window covering a moment: changes that apply then, on top of the base. */
export function forecastAt(fc, iso) {
  const t = Date.parse(iso);
  if (!fc?.periods?.length || !Number.isFinite(t)) return null;
  const inside = fc.periods.filter((p) => Date.parse(p.from) <= t && t < Date.parse(p.to));
  if (!inside.length) return null;
  // Base and FM/BECMG set the conditions; TEMPO and PROB are spells that may come and go
  const main = [...inside].reverse().find((p) => !p.change || p.change === "FM" || p.change === "BECMG") || inside[0];
  const spells = inside.filter((p) => p.change === "TEMPO" || p.change === "PROB" || p.probability);
  return { main, spells };
}

/** Conditions that slow airports down: low visibility, fog, storms, strong gusts. */
export function rough(p) {
  if (!p) return null;
  if (/TS/.test(p.wx || "")) return "Thunderstorms";
  if (/FG/.test(p.wx || "") || (p.visKm != null && p.visKm < 1)) return "Fog or very low visibility";
  if (p.visKm != null && p.visKm < 1.6) return "Low visibility";
  if ((p.gustKt || 0) >= 30) return "Strong gusts";
  return null;
}

/** One line for a set of conditions: "Haze, 4 km visibility, wind 9 km/h from the NW". */
export function conditions(p) {
  if (!p) return null;
  const what = wxWords(p.wx) || skyWords(p.clouds, p.cover);
  const vis = visWords(p.visKm, p.visPlus);
  const wind = windWords(p.windDir, p.windKt, p.gustKt);
  return [what ? what.charAt(0).toUpperCase() + what.slice(1) : null, vis ? `${vis} visibility` : null, wind ? `wind ${wind}` : null].filter(Boolean).join(", ");
}
