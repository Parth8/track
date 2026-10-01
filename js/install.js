// Add to home screen. Works out how this browser installs a web app, so the
// button only shows where it can actually help. Nothing is stored.

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPads ask for the desktop site
const isAndroid = /Android/.test(ua);
// Safari 17+ on a Mac can add any site to the Dock
const isMacSafari =
  !isIOS && /Macintosh/.test(ua) && /Version\/(1[7-9]|[2-9]\d)/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);

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

/** "prompt" | "ios" | "android" | "mac", or null when there's nothing to offer (already added, or unsupported). */
export function installWay() {
  if (added || standalone()) return null;
  if (deferred) return "prompt";
  if (isIOS) return "ios";
  if (isMacSafari) return "mac";
  if (isAndroid) return "android";
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
