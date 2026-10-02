// Add to home screen. Works out how this browser installs a web app, so the
// button only shows where it can actually help. Nothing is stored.

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPads ask for the desktop site
const isAndroid = /Android/.test(ua);
// Safari 17+ on a Mac can add any site to the Dock
const isMacSafari =
  !isIOS && /Macintosh/.test(ua) && /Version\/(1[7-9]|[2-9]\d)/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);

// Chrome and Edge on a computer can always install from their menu, even before
// they're ready to offer their own one-click prompt (that waits for a click and 30 s on the page).
const isEdge = !isIOS && !isAndroid && /Edg\//.test(ua);
const isChrome = !isIOS && !isAndroid && !isEdge && /Chrome\//.test(ua) && !/OPR\//.test(ua);

const iosVersion = (ua.match(/OS (\d+)_/) || [])[1];
/** Safari can be opened straight from another browser or an app (x-safari-https://) from iOS 17 on. */
export const canOpenSafari = isIOS && (!iosVersion || +iosVersion >= 17);

/**
 * Which picture guide fits this Apple setup, so the drawing matches the screen in front of them:
 * "safari" (iPhone, iOS 15 to 18), "safari26" (iPhone, Share under •••), "ipad", "chrome" (Chrome on iOS),
 * "mac", "firefox", "edge", "other" (another iPhone browser), "open-safari" (only Safari can add from here),
 * or null for plain text steps.
 */
export const appleGuide = (() => {
  if (isMacSafari) return "mac";
  if (!isIOS) return null;
  const os = ua.match(/OS (\d+)_(\d+)/); // iPads in desktop mode don't say, and they're new enough
  const before164 = os && (+os[1] < 16 || (+os[1] === 16 && +os[2] < 4));
  const safariVersion = +(ua.match(/Version\/(\d+)/)?.[1] || 0); // iOS 26 Safari still says "OS 18_6"
  const isIPad = /iPad/.test(ua) || /Macintosh/.test(ua);
  if (/CriOS/.test(ua)) return before164 ? "open-safari" : "chrome";
  if (/FxiOS/.test(ua)) return before164 ? "open-safari" : "firefox";
  if (/EdgiOS/.test(ua)) return before164 ? "open-safari" : "edge";
  if (/OPiOS|DuckDuckGo|YaBrowser|Brave/.test(ua)) return before164 ? "open-safari" : "other";
  // apps' built-in browsers (Instagram, Facebook, Google app and others) have no Add to Home Screen
  if (!/Safari\//.test(ua) || /FBAN|FBAV|Instagram|GSA\/|Line\/|LinkedInApp|Snapchat|Twitter/.test(ua)) return "open-safari";
  if (isIPad) return "ipad";
  return safariVersion >= 26 ? "safari26" : "safari";
})();

/** Where the app will live once added, for the button's wording. */
export const installPlace = isIOS || isAndroid ? "home" : isMacSafari ? "dock" : "desktop";

let deferred = null; // Chrome and Edge hand us their own install prompt
let added = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(installWay()));

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // our button replaces the browser's own banner
  deferred = e;
  notify();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  added = true;
  notify();
});

const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/** "prompt" | "ios" | "android" | "mac" | "edge" | "chrome", or null when there's nothing to offer (already added, or unsupported). */
export function installWay() {
  if (added || standalone()) return null;
  if (deferred) return "prompt";
  if (isIOS) return "ios";
  if (isMacSafari) return "mac";
  if (isAndroid) return "android";
  if (isEdge) return "edge";
  if (isChrome) return "chrome";
  return null;
}

export function onInstallChange(fn) {
  listeners.add(fn);
}

/** Show the browser's install dialog. Resolves true if the person said yes. */
export async function promptInstall() {
  const e = deferred;
  if (!e) return false;
  deferred = null; // each prompt can only be shown once
  e.prompt();
  const { outcome } = await e.userChoice;
  notify();
  return outcome === "accepted";
}
