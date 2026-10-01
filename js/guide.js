// Picture guides for adding Track on Apple devices, where the browser can't do it for us.
// Static, trusted SVG only (numbers below are layout, never data). Colours come from CSS
// classes in styles.css, so the drawings follow the light and dark themes:
//   d device body · s soft content · i icon strokes · t text · hl highlight · m pencil circle · p tap pulse

const frame = (body, viewBox = "0 0 120 150") =>
  `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;
const wide = (body) => frame(body, "0 26 120 94"); // iPad and Mac drawings are landscape

/** A hand-drawn loop around (cx, cy), drawn on like a pencil, plus a one-off tap pulse. */
const mark = (cx, cy, rx, ry, tilt = -6) =>
  `<circle class="p" cx="${cx}" cy="${cy}" r="${Math.min(rx, ry)}"/>` +
  `<path class="m" pathLength="1" transform="rotate(${tilt} ${cx} ${cy})" d="M${cx + rx} ${cy - ry * 0.15}A${rx} ${ry} 0 1 1 ${cx + rx * 0.8} ${cy - ry * 0.7}l3 -2"/>`;

const phone = `<rect class="d" x="18" y="4" width="84" height="142" rx="14"/>`;
const page = (top = 18) =>
  `<rect class="s" x="28" y="${top}" width="46" height="6" rx="3"/>` +
  `<rect class="s" x="28" y="${top + 12}" width="64" height="30" rx="5"/>` +
  `<rect class="s" x="28" y="${top + 48}" width="56" height="5" rx="2.5"/>` +
  `<rect class="s" x="28" y="${top + 58}" width="38" height="5" rx="2.5"/>`;
const shareIcon = (x, y, k = 1) =>
  `<path class="i" transform="translate(${x} ${y}) scale(${k})" d="M-4 0v5h8v-5M0 -5v7M-2.5 -2.5 0 -5l2.5 2.5"/>`;

/* ---------------- step 1: find Share ---------------- */

// iPhone Safari, iOS 15 to 18: address bar at the bottom, Share in the middle of the toolbar
const safari =
  phone +
  page() +
  `<rect class="s" x="26" y="106" width="68" height="11" rx="5.5"/>` +
  `<path class="i" d="M34 125l-4 4 4 4M44 125l4 4-4 4M71 125h4.5a1.5 1.5 0 0 1 1.5 1.5V133h-4.5a1.5 1.5 0 0 1-1.5-1.5zM84 127h6v6h-6zM87 124h6v6"/>` +
  shareIcon(60, 129) +
  mark(60, 129, 10, 9);

// iPhone Safari, iOS 26 and later: Share sits in the ••• menu
const safari26 =
  phone +
  page() +
  `<rect class="d" x="44" y="62" width="52" height="48" rx="9"/>` +
  `<rect class="hl" x="48" y="66" width="44" height="14" rx="5"/>` +
  shareIcon(55, 73.5, 0.8) +
  `<text class="t" x="61" y="76">Share</text>` +
  `<rect class="s" x="52" y="86" width="34" height="5" rx="2.5"/><rect class="s" x="52" y="97" width="28" height="5" rx="2.5"/>` +
  `<circle class="s" cx="30" cy="130" r="7"/><path class="i" d="M31.5 127l-3 3 3 3"/>` +
  `<rect class="s" x="41" y="124" width="44" height="12" rx="6"/>` +
  `<circle class="hl" cx="93" cy="130" r="7"/><path class="i" d="M90 130h.01M93 130h.01M96 130h.01"/>` +
  mark(70, 73, 26, 10);

// iPad Safari: Share at the top right of the toolbar
const ipad =
  `<rect class="d" x="4" y="32" width="112" height="82" rx="9"/>` +
  `<path class="i" d="M14 40h6v7h-6zM29 41l-3 2.5 3 2.5M35 41l3 2.5-3 2.5"/>` +
  `<rect class="s" x="44" y="39" width="34" height="9" rx="4.5"/>` +
  shareIcon(89, 44, 0.8) +
  `<path class="i" d="M98 41v6M95 44h6M105 42h5v5h-5z"/>` +
  `<rect class="s" x="14" y="56" width="40" height="5" rx="2.5"/><rect class="s" x="14" y="66" width="92" height="26" rx="5"/><rect class="s" x="14" y="98" width="60" height="5" rx="2.5"/>` +
  mark(89, 44, 9, 8);

// Chrome on iPhone or iPad: Share inside the address bar
const chrome =
  phone +
  `<rect class="s" x="26" y="16" width="68" height="12" rx="6"/>` +
  shareIcon(86, 22.5, 0.75) +
  page(36) +
  `<path class="i" d="M32 126l-4 4 4 4M44 126l4 4-4 4M60 126v8M56 130h8M72 127h6v6h-6zM86 130h.01M89 130h.01M92 130h.01"/>` +
  mark(86, 22, 9, 8);

/* ---------------- step 2: Add to Home Screen ---------------- */

const row = (y, label, hot = false) =>
  `<rect class="${hot ? "hl" : "s"}" x="24" y="${y}" width="72" height="12" rx="4"/>` +
  (label ? `<text class="t sm" x="28" y="${y + 8}">${label}</text>` : `<rect class="d" x="28" y="${y + 4}" width="36" height="4" rx="2"/>`);

// the share sheet slides up from the bottom (iPhone, Safari or Chrome)
const sheet =
  phone +
  page() +
  `<rect class="d" x="18" y="46" width="84" height="100" rx="14"/>` +
  `<rect class="s" x="26" y="54" width="10" height="10" rx="3"/><rect class="s" x="40" y="55" width="30" height="4" rx="2"/>` +
  [32, 48, 64, 80].map((x) => `<circle class="s" cx="${x + 4}" cy="76" r="6"/>`).join("") +
  row(90) +
  row(104) +
  row(118, "Add to Home Screen", true) +
  `<path class="i" d="M88 121.5h6v6h-6zM91 122.8v3.4M89.3 124.5h3.4"/>` +
  row(132) +
  mark(60, 124, 40, 10, -3);

// on iPad the same list opens as a popover under the Share button
const ipadSheet =
  `<rect class="d" x="4" y="32" width="112" height="82" rx="9"/>` +
  `<rect class="s" x="44" y="39" width="34" height="9" rx="4.5"/>` +
  shareIcon(89, 44, 0.8) +
  `<rect class="s" x="14" y="56" width="40" height="5" rx="2.5"/><rect class="s" x="14" y="66" width="40" height="26" rx="5"/>` +
  `<rect class="d" x="38" y="52" width="74" height="56" rx="7"/>` +
  `<rect class="s" x="43" y="57" width="64" height="9" rx="3"/><rect class="s" x="43" y="70" width="64" height="9" rx="3"/>` +
  `<rect class="hl" x="43" y="83" width="64" height="10" rx="3"/><text class="t sm" x="46" y="90">Add to Home Screen</text>` +
  `<rect class="s" x="43" y="97" width="64" height="7" rx="3"/>` +
  mark(75, 88, 36, 9, -3);

/* ---------------- Safari on a Mac ---------------- */

const macWindow = (menuOpen) =>
  `<rect class="d" x="4" y="30" width="112" height="84" rx="6"/>` +
  `<rect class="s" x="4" y="30" width="112" height="10" rx="3"/>` +
  `<text class="t sm" x="9" y="37.5">Safari</text><text class="t sm" x="35" y="37.5">File</text><text class="t sm" x="54" y="37.5">Edit</text><text class="t sm" x="73" y="37.5">View</text>` +
  `<rect class="s" x="14" y="50" width="56" height="5" rx="2.5"/><rect class="s" x="14" y="60" width="92" height="30" rx="5"/>` +
  (menuOpen
    ? `<rect class="d" x="30" y="41" width="60" height="58" rx="5"/>` +
      `<rect class="s" x="35" y="46" width="38" height="4" rx="2"/><rect class="s" x="35" y="55" width="30" height="4" rx="2"/><rect class="s" x="35" y="64" width="42" height="4" rx="2"/>` +
      `<rect class="hl" x="33" y="74" width="54" height="11" rx="3"/><text class="t sm" x="36" y="81.5">Add to Dock…</text>` +
      `<rect class="s" x="35" y="90" width="34" height="4" rx="2"/>` +
      mark(60, 79.5, 30, 9, -3)
    : mark(41, 35, 10, 7));

/** Two pictures per setup: find the menu, then the item to choose. */
export const guideArt = {
  safari: [frame(safari), frame(sheet)],
  safari26: [frame(safari26), frame(sheet)],
  ipad: [wide(ipad), wide(ipadSheet)],
  chrome: [frame(chrome), frame(sheet)],
  mac: [wide(macWindow(false)), wide(macWindow(true))],
};
