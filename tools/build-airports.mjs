// Builds data/airports.json for the flight route finder from OurAirports (public domain):
//   curl -O https://davidmegginson.github.io/ourairports-data/airports.csv
//   curl -O https://davidmegginson.github.io/ourairports-data/countries.csv
//   node tools/build-airports.mjs airports.csv countries.csv > data/airports.json
//
// Keeps airports with scheduled passenger flights and an IATA code (the code people type and
// airlines print). Each row: [code, city, airport name, country code, size (l/m/s), other names].

import { readFileSync } from "node:fs";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else if (c !== "\r") field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}

const [airportsCsv, countriesCsv] = process.argv.slice(2);
if (!airportsCsv || !countriesCsv) {
  console.error("usage: node tools/build-airports.mjs airports.csv countries.csv > data/airports.json");
  process.exit(1);
}

// Where the listed town isn't what travellers call the place.
const CITY = {
  DEL: "Delhi",
  GOI: "Goa (Dabolim)",
  GOX: "Goa (Mopa)",
  TEZ: "Tezpur",
  JSA: "Jaisalmer",
  SAG: "Shirdi",
  IXB: "Bagdogra",
  AYJ: "Ayodhya",
  RJA: "Rajahmundry",
  KJB: "Kurnool",
  DED: "Dehradun",
  KUU: "Kullu",
  DHM: "Dharamshala",
  HWR: "Ludhiana",
  KQH: "Ajmer",
  AJL: "Aizawl",
  IXI: "North Lakhimpur",
  PNY: "Puducherry",
  SDW: "Sindhudurg",
  DXN: "Noida",
  HGI: "Itanagar",
  IXD: "Prayagraj",
  IXU: "Chhatrapati Sambhajinagar",
  IXG: "Belagavi",
  HBX: "Hubballi",
  TRZ: "Tiruchirappalli",
  MYQ: "Mysuru",
  CCJ: "Kozhikode",
  IXZ: "Port Blair",
  KNU: "Kanpur",
  PGH: "Pantnagar",
};
// Other names people search by.
const ALIAS = {
  BOM: "Bombay",
  MAA: "Madras",
  CCU: "Calcutta",
  BLR: "Bangalore",
  TRV: "Trivandrum",
  COK: "Cochin",
  CCJ: "Calicut",
  TRZ: "Trichy",
  VTZ: "Vizag",
  IXU: "Aurangabad",
  IXD: "Allahabad",
  IXG: "Belgaum",
  HBX: "Hubli",
  MYQ: "Mysore",
  IXE: "Mangalore",
  DEL: "New Delhi",
  GOI: "Goa",
  GOX: "Goa",
  PNY: "Pondicherry",
  BBI: "Bhubaneshwar",
  GAU: "Gauhati",
  SXR: "Kashmir",
  VNS: "Banaras",
  BDQ: "Baroda",
  IXB: "Siliguri Darjeeling",
};

const countries = new Map(parseCsv(readFileSync(countriesCsv, "utf8")).map((c) => [c.code, c.name]));
const airports = parseCsv(readFileSync(airportsCsv, "utf8"));

const tidy = (s) => s.replace(/\s+/g, " ").trim();
const shortName = (name) =>
  tidy(
    name
      .replace(/\s*\/\s*.*(Air Force|Air Base|INS ).*$/i, "") // "Agra Airport / Agra Air Force Station"
      .replace(/\b(International )?Airport\b/gi, "")
      .replace(/\bInternational\b/gi, "")
      .replace(/\s*[-,]\s*$/, "")
  ) || name;

const out = [];
const seen = new Set();
for (const a of airports) {
  if (a.scheduled_service !== "yes") continue;
  if (!["large_airport", "medium_airport", "small_airport"].includes(a.type)) continue;
  const code = (a.iata_code || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || seen.has(code)) continue;
  seen.add(code);
  // "Aizawl (Lengpui)" → "Aizawl", "London, Essex" → "London"
  let city = CITY[code] || tidy((a.municipality || "").replace(/\s*\(.*\)\s*$/, "").split(",")[0]);
  const name = shortName(a.name);
  if (!city) city = name;
  const size = a.type[0]; // l, m or s
  const alias = ALIAS[code] || "";
  const row = [code, city, name === city ? "" : name, a.iso_country, size];
  if (alias) row.push(alias);
  out.push(row);
}
out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
const used = [...new Set(out.map((r) => r[3]))].sort();
process.stdout.write(JSON.stringify({ countries: Object.fromEntries(used.map((c) => [c, countries.get(c) || c])), airports: out }));
console.error(`${out.length} airports in ${used.length} countries`);
