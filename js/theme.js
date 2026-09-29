// Runs before first paint (classic script in <head>) so there is no flash of the wrong theme.
// The only thing this site stores: your appearance choice, on your own device.
(function () {
  var choice = "light";
  try {
    var saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark" || saved === "auto") choice = saved;
  } catch (e) {}
  document.documentElement.dataset.theme = choice;
})();
