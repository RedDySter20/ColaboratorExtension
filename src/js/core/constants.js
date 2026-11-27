/**
 * Global constants shared by the service worker, the pages and the tests.
 * Keep this module dependency-free so it can be imported anywhere.
 */

export const APP_NAME = "Colaborator";
export const APP_TAGLINE = "OAST interaction dashboard for authorized security testing";

/** Hard product limit — mirrors the original extension behaviour. */
export const MAX_SESSIONS = 10;

/** Default OAST host used to mint public URLs. */
export const DEFAULT_HOST = "oastify.com";
/**
 * Default polling endpoint (Burp Collaborator compatible).
 * The explicit `:443` is kept for byte-for-byte parity with pre-2.0 sessions.
 */
export const DEFAULT_POLLING_HOST = "polling.oastify.com:443";
export const DEFAULT_POLLING_PATH = "/burpresults";
export const DEFAULT_POLLING_PARAM = "biid";

/** IndexedDB. The name/version are kept compatible with v1.x so upgrades keep data. */
export const DB_NAME = "session_manager_pro";
export const DB_VERSION = 2;
export const STORE_SESSIONS = "sessions";
export const STORE_LOGS = "logs";

/** Log retention defaults. */
export const DEFAULT_MAX_LOGS = 500;
export const MIN_MAX_LOGS = 50;
export const MAX_MAX_LOGS = 5000;
/** How many logs the session page renders at once (rest is paginated). */
export const LOG_PAGE_SIZE = 100;

/** Polling defaults (Chrome enforces a 30 s floor for alarm periods). */
export const DEFAULT_POLL_INTERVAL_SEC = 60;
export const MIN_POLL_INTERVAL_SEC = 30;
export const MAX_POLL_INTERVAL_SEC = 900;
export const ALARM_NAME = "colaborator-poller";
export const POLL_TIMEOUT_MS = 15000;
/** Backoff after consecutive failures: 2^n seconds, capped. */
export const MAX_BACKOFF_SEC = 300;

/** Export format. */
export const EXPORT_FORMAT = "colaborator-extension";
export const EXPORT_VERSION = 2;

/** Message bus types (UI ⇄ service worker). */
export const MESSAGE = Object.freeze({
  ENSURE_ALARM: "poller:ensure",
  SYNC_NOW: "poller:sync",
  POLL_ONE: "poller:poll-one",
  TEST_INTERACTION: "poller:test-interaction",
  CLEAR_UNREAD: "ui:clear-unread",
  SESSIONS_UPDATED: "sessions:updated",
  LOGS_ADDED: "logs:added",
  POLL_FINISHED: "poller:finished"
});

/** Protocols emitted by Burp/interactsh servers, used for filters & icons. */
export const PROTOCOLS = Object.freeze([
  "dns",
  "http",
  "https",
  "smtp",
  "smtps",
  "ldap",
  "ldaps",
  "smb",
  "ftp",
  "ftps",
  "tcp",
  "responder",
  "smtp",
  "unknown"
]);
