// Renders the app icon in every size the site needs, from the one mark below.
//   NODE_PATH=$(npm root -g) node tools/build-icons.mjs
//
// The mark is one journey line: heavy and level on the ground (trains, mint), lifting into a
// light dashed arc that fades as it climbs (flights, sky blue), with the live dot where they meet.
// It's the same idea as the route line on every card in the app, just drawn bold.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * full: fill the whole square (iOS and Android round the corners themselves).
 * k: scale the drawing about the centre (maskable icons keep it inside the safe circle).
 * small: thicker lines and longer dashes, for 16 and 32 pixel favicons.
 */
export function mark({ full = false, k = 1, small = false, id = "t" } = {}) {
  const rx = full ? 0 : 15;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="${id}b" x1="0" y1="64" x2="64" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#173a2d"/><stop offset="1" stop-color="#1c2e4c"/></linearGradient>
    <linearGradient id="${id}d" x1="37.1" y1="30.8" x2="57" y2="8" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b3d4f7"/><stop offset="1" stop-color="#b3d4f7" stop-opacity="0.3"/></linearGradient>
    <clipPath id="${id}c"><rect width="64" height="64" rx="${rx}"/></clipPath>
  </defs>
  <rect width="64" height="64" rx="${rx}" fill="url(#${id}b)"/>
  <g clip-path="url(#${id}c)"><g transform="translate(32 32) scale(${k}) translate(-32 -32)">
    <path d="M37.14 30.76 C 41.78 24.05, 47.94 15.93, 58.00 8.00" fill="none" stroke="url(#${id}d)" stroke-width="${small ? 5.4 : 4.4}" stroke-linecap="round" stroke-dasharray="${small ? "9 7" : "6.4 5.4"}"/>
    <path d="M-16 51 C 10 51.5, 22 50, 29.5 41.5" fill="none" stroke="#8fd3ad" stroke-width="${small ? 8.5 : 7.6}" stroke-linecap="round"/>
    <circle cx="29.5" cy="41.5" r="${small ? 11 : 12}" fill="#8fd3ad" fill-opacity="0.28"/>
    <circle cx="29.5" cy="41.5" r="${small ? 7.4 : 7}" fill="#faf7f2"/>
  </g></g>
</svg>`;
}

const ROOT = new URL("../", import.meta.url);
const pngs = {
  // iOS rounds the corners itself, so fill the whole square.
  "icons/apple-touch-icon.png": [180, mark({ full: true })],
  // Rounded, for desktop and launchers that show the icon as it is.
  "icons/icon-192.png": [192, mark()],
  "icons/icon-512.png": [512, mark()],
  // Android crops to any shape inside the central 80% circle: keep the dot and arc inside it.
  "icons/icon-maskable-512.png": [512, mark({ full: true, k: 0.82 })],
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  writeFileSync(new URL("favicon.svg", ROOT), mark({ small: true }).replace(/\n\s*/g, ""));
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const [file, [size, svg]] of Object.entries(pngs)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
    await page.screenshot({ path: new URL(file, ROOT).pathname, omitBackground: true });
    await page.close();
    console.log(file, size);
  }
  await browser.close();
}
