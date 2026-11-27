/**
 * Theme handling: `system` | `light` | `dark`.
 *
 * `theme-boot.js` applies the cached value synchronously (before first paint) to
 * avoid a flash; this module keeps it in sync with the persisted user settings.
 */

import { DEFAULT_SETTINGS, getSettings, updateSettings } from "../core/settings.js";

export const THEME_KEY = "colaborator-theme";
export const THEME_MODES = ["system", "light", "dark"];

/**
 * Extension version straight from the manifest.
 * @returns {string}
 */
export function appVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "2.0.0";
  }
}

/** @param {"light"|"dark"|"system"} mode @returns {"light"|"dark"} */
export function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * @param {"light"|"dark"|"system"} mode
 */
export function applyTheme(mode) {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-mode", mode);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage may be unavailable */
  }
  const label = resolved === "dark" ? "Светлая тема" : "Тёмная тема";
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.title = label;
    button.setAttribute("aria-label", label);
    const text = button.querySelector("[data-theme-label]");
    if (text) text.textContent = label;
  }
}

/** @returns {"light"|"dark"|"system"} */
export function currentThemeMode() {
  return document.documentElement.getAttribute("data-theme-mode") ?? "system";
}

/**
 * Initialise the theme from settings (falls back to the cached value).
 * @returns {Promise<void>}
 */
export async function initTheme() {
  let mode = currentThemeMode();
  try {
    const settings = await getSettings();
    mode = settings.theme ?? DEFAULT_SETTINGS.theme;
  } catch {
    /* keep cached mode */
  }
  applyTheme(mode);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentThemeMode() === "system") applyTheme("system");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes?.settings?.newValue) return;
    const next = changes.settings.newValue.theme;
    if (next && next !== currentThemeMode()) applyTheme(next);
  });
}

/**
 * Toggle light/dark (system resolves to its opposite) and persist the choice.
 * @returns {Promise<"light"|"dark">}
 */
export async function toggleTheme() {
  const next = resolveTheme(currentThemeMode()) === "dark" ? "light" : "dark";
  applyTheme(next);
  await updateSettings({ theme: next });
  return next;
}

/**
 * Bind every `[data-theme-toggle]` element on the page.
 */
export function bindThemeToggle() {
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.addEventListener("click", () => {
      toggleTheme().catch(() => {});
    });
  }
}
