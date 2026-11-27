/**
 * User settings, persisted in chrome.storage.local.
 *
 * Settings are intentionally small and flat so the options page can render them
 * generically and the service worker can read them cheaply.
 */

import {
  DEFAULT_HOST,
  DEFAULT_MAX_LOGS,
  DEFAULT_POLL_INTERVAL_SEC,
  MAX_MAX_LOGS,
  MAX_POLL_INTERVAL_SEC,
  MIN_MAX_LOGS,
  MIN_POLL_INTERVAL_SEC
} from "./constants.js";

export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS = Object.freeze({
  /** "system" | "light" | "dark" */
  theme: "system",
  /** Polling cadence in seconds (Chrome enforces >= 30). */
  pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
  /** Log retention per session. */
  maxLogsPerSession: DEFAULT_MAX_LOGS,
  /** Desktop notification on new interactions. */
  notifications: true,
  /** Resume polling for sessions that were active before the browser restart. */
  autoResume: true,
  /** Host used for newly created public URLs. */
  defaultHost: DEFAULT_HOST,
  /** Sort order of the session list. */
  sortMode: "updated",
  /** Poll immediately when a session page is opened. */
  pollOnOpen: true
});

/**
 * @param {number} value
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * Coerce arbitrary input into a valid settings object.
 * @param {Partial<typeof DEFAULT_SETTINGS>|null|undefined} input
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    theme: ["system", "light", "dark"].includes(source.theme)
      ? source.theme
      : DEFAULT_SETTINGS.theme,
    pollIntervalSec: clampInt(
      source.pollIntervalSec,
      MIN_POLL_INTERVAL_SEC,
      MAX_POLL_INTERVAL_SEC,
      DEFAULT_SETTINGS.pollIntervalSec
    ),
    maxLogsPerSession: clampInt(
      source.maxLogsPerSession,
      MIN_MAX_LOGS,
      MAX_MAX_LOGS,
      DEFAULT_SETTINGS.maxLogsPerSession
    ),
    notifications:
      typeof source.notifications === "boolean"
        ? source.notifications
        : DEFAULT_SETTINGS.notifications,
    autoResume:
      typeof source.autoResume === "boolean" ? source.autoResume : DEFAULT_SETTINGS.autoResume,
    defaultHost:
      typeof source.defaultHost === "string" && source.defaultHost.trim()
        ? source.defaultHost.trim()
        : DEFAULT_SETTINGS.defaultHost,
    sortMode: ["updated", "name", "interactions", "created"].includes(source.sortMode)
      ? source.sortMode
      : DEFAULT_SETTINGS.sortMode,
    pollOnOpen:
      typeof source.pollOnOpen === "boolean" ? source.pollOnOpen : DEFAULT_SETTINGS.pollOnOpen
  };
}

/**
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 * @returns {Promise<typeof DEFAULT_SETTINGS>} the merged settings
 */
export async function updateSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function resetSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

/**
 * Subscribe to settings changes; returns an unsubscribe function.
 * @param {(settings: typeof DEFAULT_SETTINGS) => void} callback
 * @returns {() => void}
 */
export function onSettingsChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName !== "local" || !changes?.[SETTINGS_KEY]) return;
    callback(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
