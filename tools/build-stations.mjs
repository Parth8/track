// Builds data/stations.json for the route finder's station suggestions.
//
//   node tools/build-stations.mjs <ntes-stations.json> [datameet-stations.json] > data/stations.json
//
// ntes-stations.json: the array from NTES's station list (arrStationList: [{code, name}, ...]).
// datameet-stations.json (optional, CC0, github.com/datameet/railways): adds older names as
// search aliases, so "Mysore" still finds Mysuru Jn.
//
// Output: [[code, name], [code, name, alias], ...], passenger stations only, sorted by code.

import { readFileSync } from "node:fs";

const [ntesPath, datameetPath] = process.argv.slice(2);
if (!ntesPath) {
  console.error("usage: node tools/build-stations.mjs <ntes-stations.json> [datameet-stations.json]");
  process.exit(1);
}

// Signal cabins, block huts, goods sheds, sidings and the like: nobody boards a train there.
const NOT_PASSENGER =
  /\b(CABIN|BLOCK HUT|BLK HUT|GOODS|G\/SHED|SIDING|YARD|MARSHALLING|M\/S|LTD|PVT|CORPO|CREW LOBBY|TERMINALS P|E DEPOT|PANEL|THROUGH|TP NO)\b|\bBH\b|\bB\.?H\.?$|BYPASS CABIN|^BLOCK /i;
// Internal placeholders that carry no real station name.
const JUNK = new Set(["BENL", "CNBL", "CWDA", "DEMU", "GK", "JTIN", "KAMR", "PLK", "RPWN", "SSCR"]);
// Kept in capitals when they appear as a word in a name.
const KEEP_UPPER = new Set([
  "KSR", "CSMT", "SMVT", "SMVB", "MGR", "NSC", "LTT", "CST", "BG", "MG", "NG", "PH", "CBD", "MRTS", "ITI", "BHEL", "IBP",
  "DLF", "JNU", "II", "III", "IV", "SAS", "DR", "BZR", "RD", "A", "B", "C", "D", "N", "S", "E", "W", "K", "G", "T", "L", "M", "P",
]);
const WORD_FIX = { DR: "Dr", RD: "Rd", BZR: "Bzr" };

function titleCase(raw) {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .split(/(\s+|[()\-/,])/)
    .map((w) => {
      if (!/[A-Za-z]/.test(w)) return w;
      const up = w.toUpperCase();
      if (WORD_FIX[up]) return WORD_FIX[up];
      if (/^([A-Z]\.)+[A-Z]?\.?$/.test(up)) return up; // P.H., B.G.
      if (KEEP_UPPER.has(up) && up.length > 1) return up;
      if (up.includes(".")) return up.split(".").map((p) => (p ? p[0] + p.slice(1).toLowerCase() : p)).join(".");
      return up[0] + up.slice(1).toLowerCase();
    })
    .join("")
    .replace(/\bJn\.$/, "Jn");
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ntes = JSON.parse(readFileSync(ntesPath, "utf8"));
const aliases = new Map();
if (datameetPath) {
  for (const f of JSON.parse(readFileSync(datameetPath, "utf8")).features) {
    const { code, name } = f.properties || {};
    if (code && name) aliases.set(code.toUpperCase(), name);
  }
}

const seen = new Set();
const out = [];
for (const { code: c, name: n } of ntes) {
  const code = String(c || "").trim().toUpperCase();
  const name = String(n || "").trim();
  if (!/^[A-Z]{1,5}$/.test(code) || seen.has(code)) continue; // codes with digits are internal
  if (!name || JUNK.has(code) || NOT_PASSENGER.test(name)) continue;
  seen.add(code);
  const row = [code, titleCase(name)];
  const old = aliases.get(code);
  // Only a genuinely different older name is worth searching on (Mysore for Mysuru, Allahabad for Prayagraj).
  if (old) {
    const a = squash(old).replace(/(jn|junction|halt|ph|h)$/, "");
    const b = squash(name).replace(/(jn|junction|halt|ph|h)$/, "");
    if (a && a !== b && a !== squash(code) && !b.includes(a) && !a.includes(b)) row.push(titleCase(old));
  }
  out.push(row);
}
out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
process.stdout.write("[\n" + out.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");
console.error(`${out.length} stations (${ntes.length - out.length} left out), ${out.filter((r) => r[2]).length} with an older name`);
