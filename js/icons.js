// Static, trusted markup only. Never interpolate data into these strings.
const s = (body, vb = "0 0 24 24") =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  back: s('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  next: s('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  up: s('<path d="M6 15l6-6 6 6"/>'),
  down: s('<path d="M6 9l6 6 6-6"/>'),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  share: s('<path d="M12 4v11M7 9l5-5 5 5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
  refresh: s('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
  pin: s('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  info: s('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  gate: s('<path d="M4 20V5a1 1 0 0 1 1-1h8v16M13 20h7M9 12h.01"/>'),
  belt: s('<rect x="5" y="7" width="14" height="12" rx="2"/><path d="M9 7V4h6v3M9 11v4M15 11v4"/>'),
  message: s('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  clock: s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  cup: s('<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M11 3v3"/>'),
  moonTrain: s('<path d="M4 17h16M7 17l-2 3M17 17l2 3"/><rect x="6" y="5" width="12" height="11" rx="3"/><path d="M9 9h6"/>'),
  coach: s('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h2M11 11h2M15 11h2M6 17v2M18 17v2"/>'),
  fog: s('<path d="M4 9h16M3 13h18M5 17h14"/>'),
  plane: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c.9 0 1.4 1.8 1.4 3.2v4.3l7.6 4.5v2.2l-7.6-2.5v4.6l2.5 2v1.7l-3.9-1.2-3.9 1.2v-1.7l2.5-2v-4.6L3 16.2V14l7.6-4.5V5.2C10.6 3.8 11.1 2 12 2z"/></svg>',
  plane2: s('<path d="M3 20h18M5 16l3.5-1 3-7 2 .5-1 5.5 5-1.5 1.5-3 1.5.5-1 4.5-13.5 4z"/>'),

  sun: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="#FFE2A8" stroke="#D9922E" stroke-width="1.8"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="#D9922E" stroke-width="1.8"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="#FFF3C9" stroke="#8B7FD0" stroke-width="1.8"/><path d="M17 4.5v2M16 5.5h2" stroke="#8B7FD0" stroke-width="1.6"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z" fill="#EEF2F8" stroke="#7F8FA8" stroke-width="1.8"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a3.5 3.5 0 0 0 1 7z" fill="#E6EEF8" stroke="#5F80A8" stroke-width="1.8"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5" stroke="#5F80A8" stroke-width="1.8"/></svg>',
  storm: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7a3.5 3.5 0 0 0 1 7z" fill="#E4E3F3" stroke="#6A64A8" stroke-width="1.8"/><path d="M12 15l-2 4h3l-2 3.5" stroke="#D9922E" stroke-width="1.8"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="#6F9CC9" stroke-width="1.8"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 17a7 7 0 0 1 14 0z" fill="#FFD9A8" stroke="#C0773A" stroke-width="1.8"/><path d="M3 20h18M12 4v3M4.9 8.9l1.4 1.4M19.1 8.9l-1.4 1.4" stroke="#C0773A" stroke-width="1.8"/></svg>',
};

export const art = {
  train: `<svg viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="16" y="6" width="32" height="40" rx="11" fill="var(--card)" stroke="currentColor" stroke-width="2.2"/>
    <rect x="21" y="13" width="22" height="12" rx="4" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="2.2"/>
    <path d="M32 6v7" stroke="currentColor" stroke-width="2.2"/>
    <circle class="art-light" cx="24" cy="36" r="2.6" fill="#FFD98A" stroke="currentColor" stroke-width="1.6"/>
    <circle class="art-light r" cx="40" cy="36" r="2.6" fill="#FFD98A" stroke="currentColor" stroke-width="1.6"/>
    <path d="M22 46l-7 11M42 46l7 11M11 57h42M17 52h30" stroke="currentColor" stroke-width="2.2"/></svg>`,
  plane: `<svg viewBox="0 0 88 64" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path class="art-cloud" d="M58 22a6 6 0 0 1 11-3a5 5 0 0 1 9 4h-20" fill="var(--card)" stroke="currentColor" stroke-width="2.2"/>
    <path class="art-cloud two" d="M6 46a5 5 0 0 1 9-3a4 4 0 0 1 8 3h-17" fill="var(--card)" stroke="currentColor" stroke-width="2.2"/>
    <path class="art-plane" d="M36 8c2.4 0 3 4 3 7v10l19 11v5l-19-6v11l6 5v4l-9-3-9 3v-4l6-5V30l-19 6v-5l19-11V15c0-3 .6-7 3-7z" fill="var(--card)" stroke="currentColor" stroke-width="2.2"/></svg>`,
  empty: `<svg viewBox="0 0 200 150" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="100" cy="62" r="54" fill="var(--tint)"/>
    <path d="M84 26h32a10 10 0 0 1 10 10v38H74V36a10 10 0 0 1 10-10z" fill="var(--card)" stroke="var(--accent)" stroke-width="3"/>
    <rect x="82" y="34" width="36" height="16" rx="5" fill="var(--tint)" stroke="var(--accent)" stroke-width="3"/>
    <path d="M80 74l-22 60M120 74l22 60M40 134h120M66 112h68M72 94h56" stroke="var(--line)" stroke-width="3"/></svg>`,
  slow: `<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="14" fill="none" stroke="var(--tint)" stroke-width="4"/><path class="arc" d="M18 4a14 14 0 0 1 14 14" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/></svg>`,
};

/** WMO weather code to label and icon. */
export function weatherLook(code, isDay = true) {
  if (code == null) return { label: "Weather unavailable", icon: icons.cloud };
  if (code === 0) return { label: isDay ? "clear skies" : "a clear night", icon: isDay ? icons.sun : icons.moon };
  if (code <= 2) return { label: "a few clouds", icon: isDay ? icons.sun : icons.moon };
  if (code === 3) return { label: "overcast", icon: icons.cloud };
  if (code <= 48) return { label: "fog", icon: icons.cloud };
  if (code <= 57) return { label: "drizzle", icon: icons.rain };
  if (code <= 67) return { label: "rain", icon: icons.rain };
  if (code <= 77) return { label: "snow", icon: icons.snow };
  if (code <= 82) return { label: "showers", icon: icons.rain };
  if (code <= 86) return { label: "snow showers", icon: icons.snow };
  return { label: "thunderstorms", icon: icons.storm };
}

const t = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

Object.assign(icons, {
  themeLight: t('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>'),
  themeDark: t('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  themeAuto: t('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>'),
  // aircraft seen from above, nose up
  jetNarrow: t('<path d="M12 2.5c.8 0 1.3 1.4 1.3 2.6v4.6l7.2 4.1v1.9l-7.2-2.2v4.6l2.3 1.7v1.5L12 20.3l-3.6 1v-1.5l2.3-1.7v-4.6l-7.2 2.2v-1.9l7.2-4.1V5.1c0-1.2.5-2.6 1.3-2.6z"/>'),
  jetWide: t('<path d="M12 2c1.2 0 1.9 1.6 1.9 3v4.3l8.1 4.3v2.1l-8.1-2.3v4.4l2.6 1.9v1.6L12 20.2l-4.5 1.1v-1.6l2.6-1.9v-4.4L2 15.7v-2.1l8.1-4.3V5c0-1.4.7-3 1.9-3z"/><path d="M6.2 12.1v1.6M17.8 12.1v1.6"/>'),
  turboprop: t('<path d="M12 3c.7 0 1.1 1.2 1.1 2.2v4.4h7.4v2h-7.4v5.3l2.2 1.6v1.4L12 19l-3.3.9v-1.4l2.2-1.6v-5.3H3.5v-2h7.4V5.2C10.9 4.2 11.3 3 12 3z"/><path d="M5.5 8.2v3M18.5 8.2v3"/>'),
  route: t('<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h6a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h6"/>'),
  timer: t('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9.5 2.5h5"/>'),
  desk: t('<path d="M3 11h18M5 11v8M19 11v8M8 7h8l1 4H7l1-4z"/>'),
  terminal: t('<path d="M3 20h18M5 20V9l7-4 7 4v11M9 20v-5h6v5"/>'),
  globe: t('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  offline: t('<path d="M2 8.8a15 15 0 0 1 4.2-2.6M9.3 5.3A15 15 0 0 1 22 8.8M5 12.4a10 10 0 0 1 4-2.1M15 10.4a10 10 0 0 1 4 2M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/>'),
  signal: t('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a15 15 0 0 1 20 0"/>'),
  tap: t('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10.5V9a1.5 1.5 0 0 1 3 0v2M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.9-2.6L4 14.8a1.5 1.5 0 0 1 2.4-1.8L9 15"/>'),
  heart: t('<path d="M12 20s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>'),
});

/** Rough body type from an aircraft model string. */
export function bodyType(model) {
  const m = (model || "").toUpperCase();
  if (!m) return null;
  if (/ATR|Q400|DASH ?8|DHC|TURBOPROP|SAAB|KING AIR|CARAVAN|TWIN OTTER|DO ?228/.test(m)) return { label: "Turboprop", icon: icons.turboprop };
  if (/A3[3-8]\d|A350|A380|747|767|777|787|A300|A310|MD-11|IL-96/.test(m)) return { label: "Wide-body jet", icon: icons.jetWide };
  if (/E1[79]\d|EMBRAER|CRJ|ERJ|SUPERJET|SSJ|E-JET/.test(m)) return { label: "Regional jet", icon: icons.jetNarrow };
  return { label: "Narrow-body jet", icon: icons.jetNarrow };
}
