// A Delhi departure board in AeroDataBox's FIDS format (withLeg=true), for any date and half-day.
// Shapes follow the published OpenAPI spec: AirportFidsContract → departures[] of AirportFlightContract.

const AIRPORTS = {
  BLR: { icao: "VOBL", iata: "BLR", name: "Bengaluru", shortName: "Bengaluru", municipalityName: "Bengaluru", countryCode: "IN", timeZone: "Asia/Kolkata", offset: 330 },
  BOM: { icao: "VABB", iata: "BOM", name: "Mumbai", shortName: "Mumbai", municipalityName: "Mumbai", countryCode: "IN", timeZone: "Asia/Kolkata", offset: 330 },
  DXB: { icao: "OMDB", iata: "DXB", name: "Dubai", shortName: "Dubai", municipalityName: "Dubai", countryCode: "AE", timeZone: "Asia/Dubai", offset: 240 },
};
const AIRLINES = { "6E": ["IndiGo", "IGO"], AI: ["Air India", "AIC"], QP: ["Akasa Air", "AKJ"], IX: ["Air India Express", "AXB"], EK: ["Emirates", "UAE"], VS: ["Virgin Atlantic", "VIR"] };

// [number, to, dep (local), arr (local at destination), arrival day offset, status, extra]
const BOARD = [
  ["EK 511", "DXB", "04:25", "06:35", 0, "Expected", { model: "Boeing 777-300ER" }],
  ["6E 2131", "BLR", "06:00", "08:45", 0, "Expected", { model: "Airbus A321 NEO", terminal: "1" }],
  ["AI 2803", "BLR", "07:10", "10:00", 0, "Expected", { model: "Airbus A320", terminal: "3" }],
  ["VS 8110", "BLR", "07:10", "10:00", 0, "Expected", { codeshare: "IsCodeshared" }],
  ["QP 1381", "BLR", "08:20", "11:05", 0, "Delayed", { delay: 45, model: "Boeing 737 MAX 8", terminal: "1" }],
  ["6E 204", "BOM", "09:00", "11:10", 0, "Expected", {}],
  ["6E 6352", "BLR", "09:40", "12:25", 0, "Canceled", { terminal: "1" }],
  ["6E 9001", "BLR", "10:30", "13:00", 0, "Expected", { cargo: true }],
  ["IX 1124", "BLR", "11:30", "14:15", 0, "Expected", { terminal: "3" }],
  ["6E 5338", "BLR", "13:15", "16:05", 0, "Expected", { model: "Airbus A320 NEO", terminal: "1" }],
  ["AI 2807", "BLR", "15:00", "17:50", 0, "Expected", { model: "Airbus A321", terminal: "3" }],
  ["6E 2516", "BLR", "17:45", "20:35", 0, "Expected", { terminal: "1" }],
  ["QP 1356", "BLR", "19:20", "22:05", 0, "Expected", { terminal: "1" }],
  ["AI 2820", "BLR", "21:00", "23:50", 0, "Expected", { terminal: "3" }],
  ["6E 6814", "BLR", "23:40", "02:25", 1, "Expected", { terminal: "1" }],
];

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pad = (n) => String(n).padStart(2, "0");
function time(date, hhmm, offsetMin, plusMin = 0) {
  const [H, M] = hhmm.split(":").map(Number);
  const local = Date.UTC(...date.split("-").map((v, i) => (i === 1 ? v - 1 : +v)), H, M) + plusMin * 60000;
  const utc = new Date(local - offsetMin * 60000);
  const l = new Date(local);
  const sign = offsetMin >= 0 ? "+" : "-";
  const off = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return {
    utc: `${utc.toISOString().slice(0, 10)} ${utc.toISOString().slice(11, 16)}Z`,
    local: `${l.toISOString().slice(0, 10)} ${l.toISOString().slice(11, 16)}${off}`,
  };
}

/** Departures from DEL on `date` between `fromHHMM` and `toHHMM` (local). */
export function delDepartures(date, fromHHMM = "00:00", toHHMM = "23:59") {
  const departures = [];
  for (const [number, to, dep, arr, arrDay, status, x] of BOARD) {
    if (dep < fromHHMM || dep > toHHMM) continue;
    const ap = AIRPORTS[to];
    const [name, icao] = AIRLINES[number.slice(0, 2)];
    const { offset, ...airport } = ap;
    departures.push({
      departure: {
        scheduledTime: time(date, dep, 330),
        ...(x.delay ? { revisedTime: time(date, dep, 330, x.delay) } : {}),
        terminal: x.terminal,
        quality: ["Basic", "Live"],
      },
      arrival: {
        airport,
        scheduledTime: time(addDays(date, arrDay), arr, offset),
        ...(x.delay ? { revisedTime: time(addDays(date, arrDay), arr, offset, x.delay) } : {}),
        quality: ["Basic"],
      },
      number,
      callSign: `${icao}${number.slice(3)}`,
      status,
      codeshareStatus: x.codeshare || "IsOperator",
      isCargo: !!x.cargo,
      aircraft: x.model ? { model: x.model } : undefined,
      airline: { name, iata: number.slice(0, 2), icao },
    });
  }
  return { departures };
}

/** Answer a FIDS request URL (…/flights/airports/iata/DEL/2026-10-02T00:00/2026-10-02T11:59?…). */
export function fidsAnswer(url) {
  const m = /\/flights\/airports\/iata\/([A-Z]{3})\/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})\/\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(String(url));
  if (!m) return null;
  if (m[1] !== "DEL") return new Response(null, { status: 204 });
  return new Response(JSON.stringify(delDepartures(m[2], m[3], m[4])), { headers: { "Content-Type": "application/json" } });
}

/** A Workers KV stand-in. */
export class MemoryKV {
  constructor() {
    this.map = new Map();
    this.puts = 0;
  }
  async get(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  async put(k, v) {
    this.puts++;
    this.map.set(k, String(v));
  }
}
