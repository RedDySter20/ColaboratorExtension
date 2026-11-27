/**
 * Domain models, normalisation and pure helpers.
 * All functions here are synchronous and side-effect free, so they are easy to test.
 */

import { DEFAULT_HOST, DEFAULT_MAX_LOGS, MAX_SESSIONS } from "./constants.js";

/** @typedef {"idle"|"polling"|"error"} SessionState */

/**
 * FNV-1a — short, stable fingerprint used to de-duplicate interactions that a
 * server may return more than once.
 * @param {string} input
 * @returns {string} 8 hex chars
 */
export function fnv1a(input) {
  let hash = 0x811c9dc5;
  const text = String(input ?? "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** @param {unknown} value @returns {number|null} */
function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * @param {any} input
 * @returns {object} normalised session
 */
export function normalizeSession(input = {}) {
  const now = Date.now();
  const id = String(input?.id || crypto.randomUUID());
  return {
    id,
    name: String(input?.name || `Session ${id.slice(0, 4)}`).slice(0, 120),
    keyB64: String(input?.keyB64 || ""),
    publicUrl: String(input?.publicUrl || ""),
    privateUrl: String(input?.privateUrl || ""),
    /** Optional interactsh secret used to decrypt AES-CTR poll payloads. */
    secret: String(input?.secret || ""),
    host: String(input?.host || DEFAULT_HOST),
    active: Boolean(input?.active),
    createdAt: finiteOrNull(input?.createdAt) ?? now,
    updatedAt: finiteOrNull(input?.updatedAt) ?? now,
    lastPollAt: finiteOrNull(input?.lastPollAt),
    lastStatus: finiteOrNull(input?.lastStatus),
    lastError: String(input?.lastError || ""),
    errorCount: finiteOrNull(input?.errorCount) ?? 0,
    nextAttemptAt: finiteOrNull(input?.nextAttemptAt) ?? 0,
    interactionCount: finiteOrNull(input?.interactionCount) ?? 0,
    lastInteractionAt: finiteOrNull(input?.lastInteractionAt)
  };
}

/**
 * @param {any} input
 * @returns {object} normalised log
 */
export function normalizeLog(input = {}) {
  const ts =
    finiteOrNull(input?.ts) ??
    finiteOrNull(input?.time) ??
    (Number.isFinite(Date.parse(input?.timestamp)) ? Date.parse(input.timestamp) : Date.now());
  const sessionId = String(input?.sessionId || "");
  const protocol = String(input?.protocol || "unknown").toLowerCase();
  const client = String(input?.clientInfo || input?.client || "");
  const log = {
    id: String(input?.id || `${sessionId}-${ts}-${crypto.randomUUID()}`),
    sessionId,
    ts,
    protocol,
    client,
    interactionString: String(input?.interactionString || input?.fullId || input?.uniqueId || ""),
    opCode: String(input?.opCode || input?.qType || ""),
    requestB64: String(input?.requestB64 || input?.rawRequest || ""),
    responseB64: String(input?.responseB64 || input?.rawResponse || ""),
    error: String(input?.error || ""),
    source: String(input?.source || "poll")
  };
  if (input?.raw !== undefined) {
    log.raw = typeof input.raw === "string" ? input.raw : safeStringify(input.raw);
  }
  log.fingerprint = String(input?.fingerprint || fingerprintOf(log));
  return log;
}

/**
 * @param {object} log
 * @returns {string}
 */
export function fingerprintOf(log) {
  const parts = [
    log.sessionId,
    log.ts,
    log.protocol,
    log.client,
    log.interactionString,
    log.opCode,
    fnv1a(`${log.requestB64 || ""}\u0000${log.responseB64 || ""}`)
  ];
  return fnv1a(parts.join("|"));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Human friendly state of a session.
 * @param {object} session
 * @returns {SessionState}
 */
export function sessionState(session) {
  if (session?.lastError && session?.errorCount > 0) return "error";
  return session?.active ? "polling" : "idle";
}

/**
 * Free text match over the fields a user is likely to search for.
 * @param {object} session
 * @param {string} query
 * @returns {boolean}
 */
export function sessionMatchesQuery(session, query) {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  const haystack = [session?.name, session?.publicUrl, session?.privateUrl, session?.host]
    .join(" ")
    .toLowerCase();
  return needle.split(/\s+/).every((token) => haystack.includes(token));
}

/**
 * Decoded payload text used by the log search. Cached per log object so typing in
 * the filter box does not re-decode every payload on every keystroke.
 * @type {WeakMap<object, string>}
 */
const searchCache = new WeakMap();

/**
 * @param {string} base64
 * @returns {string}
 */
function decodeSearchPayload(base64) {
  if (!base64) return "";
  try {
    const binary = atob(base64);
    if (binary.length > 16384) return binary.slice(0, 16384);
    return decodeURIComponent(escape(binary));
  } catch {
    try {
      return atob(base64);
    } catch {
      return "";
    }
  }
}

/**
 * Case-insensitive multi-token search across protocol, client, identifiers and
 * decoded payload text.
 * @param {object} log
 * @param {string} query
 * @returns {boolean}
 */
export function logMatchesQuery(log, query) {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return true;

  let haystack = searchCache.get(log);
  if (haystack === undefined) {
    haystack = [
      log?.protocol,
      log?.client,
      log?.interactionString,
      log?.opCode,
      log?.requestB64,
      log?.responseB64,
      log?.raw,
      decodeSearchPayload(log?.requestB64),
      decodeSearchPayload(log?.responseB64)
    ]
      .join(" ")
      .toLowerCase();
    searchCache.set(log, haystack);
  }

  return needle.split(/\s+/).every((token) => haystack.includes(token));
}

/**
 * @param {object[]} sessions
 * @param {"updated"|"name"|"interactions"|"created"} [mode]
 * @returns {object[]}
 */
export function sortSessions(sessions, mode = "updated") {
  const list = [...sessions];
  switch (mode) {
    case "name":
      return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    case "interactions":
      return list.sort((a, b) => (b.interactionCount || 0) - (a.interactionCount || 0));
    case "created":
      return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    default:
      return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
}

/**
 * Validation for imported/edited sessions (lenient normalisation is not enough).
 * @param {object} session
 * @returns {string[]} list of problems, empty when valid
 */
export function validateSession(session) {
  const problems = [];
  if (!session?.id) problems.push("Session id is missing");
  if (!session?.publicUrl) problems.push("Public URL is missing");
  if (!session?.privateUrl) problems.push("Private URL is missing");
  try {
    const url = new URL(String(session?.privateUrl || ""));
    if (!/^https?:$/.test(url.protocol)) problems.push("Private URL must be http(s)");
  } catch {
    problems.push("Private URL is not a valid URL");
  }
  return problems;
}

/** Global cap check. @param {number} currentCount @returns {boolean} */
export function canAddSession(currentCount, limit = MAX_SESSIONS) {
  return currentCount < limit;
}

/**
 * @param {object} session
 * @returns {number} effective retention limit
 */
export function retentionFor(session, fallback = DEFAULT_MAX_LOGS) {
  const value = Number(session?.maxLogs);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Exponential backoff delay for consecutive poll failures.
 * @param {number} errorCount
 * @param {number} [capSec]
 * @returns {number} seconds
 */
export function backoffSeconds(errorCount, capSec = 300) {
  if (!errorCount || errorCount <= 0) return 0;
  return Math.min(capSec, 2 ** Math.min(errorCount, 9));
}
