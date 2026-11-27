/**
 * Early theme application. Loaded as a classic script in <head> so the correct
 * palette is set before the first paint (no flash of the wrong theme).
 * MV3 forbids inline scripts, hence a real file.
 */
(function bootTheme() {
  try {
    const mode = localStorage.getItem("colaborator-theme") || "system";
    const resolved =
      mode === "light" || mode === "dark"
        ? mode
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-mode", mode);
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
