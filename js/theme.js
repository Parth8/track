// Runs before first paint (classic script in <head>) so there is no flash of the wrong theme.
// The only things this site stores: your appearance and clock choices, on your own device.
(function () {
  var choice = "light";
  var clock = "12";
  try {
    var saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark" || saved === "auto") choice = saved;
  } catch (e) {}
  try {
    var savedClock = localStorage.getItem("clock");
    if (savedClock === "12" || savedClock === "24") clock = savedClock;
    else {
      // No choice yet: follow the device's own clock.
      var o = new Intl.DateTimeFormat(navigator.language || "en-IN", { hour: "numeric" }).resolvedOptions();
      if (o.hourCycle === "h23" || o.hourCycle === "h24" || o.hour12 === false) clock = "24";
    }
  } catch (e) {}
  document.documentElement.dataset.theme = choice;
  document.documentElement.dataset.clock = clock;
})();
