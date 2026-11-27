/**
 * Persistence layer: sessions, interaction logs, import/export, statistics.
 *
 * Every public function is async and hides IndexedDB details from the UI and the
 * service worker. Log payloads are compressed transparently (see compression.js).
 */

import {
  MAX_SESSIONS,
  STORE_LOGS,
  STORE_SESSIONS,
  EXPORT_FORMAT,
  EXPORT_VERSION
} from "./constants.js";
import { promisifyRequest, runTransaction, withStore } from "./db.js";
import { decodeLogFromStorage, encodeLogForStorage } from "./compression.js";
import {
  backoffSeconds,
  fingerprintOf,
  logMatchesQuery,
  normalizeLog,
  normalizeSession,
  safeStringify,
  sortSessions
} from "./models.js";

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ sort?: "updated"|"name"|"interactions"|"created" }} [options]
 * @returns {Promise<object[]>}
 */
export async function listSessions(options = {}) {
  const records = await withStore(STORE_SESSIONS, "readonly", (store) =>
    promisifyRequest(store.getAll())
  );
  return sortSessions(records.map(normalizeSession), options.sort ?? "updated");
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getSession(id) {
  if (!id) return null;
  const record = await withStore(STORE_SESSIONS, "readonly", (store) =>
    promisifyRequest(store.get(String(id)))
  );
  return record ? normalizeSession(record) : null;
}

/**
 * Insert or update a session. `updatedAt` is refreshed automatically.
 * @param {object} session
 * @returns {Promise<object>} the stored session
 */
export async function saveSession(session) {
  const normalized = normalizeSession({ ...session, updatedAt: Date.now() });
  await withStore(STORE_SESSIONS, "readwrite", (store) => {
    store.put(normalized);
  });
  return normalized;
}

/**
 * @param {object[]} sessions
 * @returns {Promise<number>} number of stored sessions
 */
export async function saveSessions(sessions) {
  const normalized = (sessions ?? []).map((session) => normalizeSession(session));
  await withStore(STORE_SESSIONS, "readwrite", (store) => {
    for (const session of normalized) store.put(session);
  });
  return normalized.length;
}

/**
 * Delete a session together with all of its logs.
 * @param {string} id
 */
export async function deleteSession(id) {
  await deleteLogs(id);
  await withStore(STORE_SESSIONS, "readwrite", (store) => {
    store.delete(String(id));
  });
}

/**
 * Number of stored sessions.
 * @returns {Promise<number>}
 */
export async function countSessions() {
  return withStore(STORE_SESSIONS, "readonly", (store) => promisifyRequest(store.count()));
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Persist new interactions, skipping duplicates already stored for the session.
 * @param {object[]} logs
 * @returns {Promise<{added: number, skipped: number}>}
 */
export async function addLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return { added: 0, skipped: 0 };

  const normalized = logs.map((log) => normalizeLog(log));
  const existing = await withStore(STORE_LOGS, "readonly", (store) => {
    const index = store.index("fingerprint");
    return Promise.all(normalized.map((log) => promisifyRequest(index.getKey(log.fingerprint))));
  });

  const seen = new Set();
  const fresh = normalized.filter((log, index) => {
    if (existing[index] !== undefined) return false;
    if (seen.has(log.fingerprint)) return false;
    seen.add(log.fingerprint);
    return true;
  });

  if (fresh.length) {
    const records = await Promise.all(fresh.map((log) => encodeLogForStorage(log)));
    await withStore(STORE_LOGS, "readwrite", (store) => {
      for (const record of records) store.put(record);
    });
  }

  return { added: fresh.length, skipped: normalized.length - fresh.length };
}

/**
 * Convenience wrapper for a single interaction.
 * @param {object} log
 * @returns {Promise<boolean>} true when it was new
 */
export async function addLog(log) {
  const { added } = await addLogs([log]);
  return added > 0;
}

/**
 * Read the session logs, newest first.
 * @param {string} sessionId
 * @param {{ limit?: number, offset?: number, protocol?: string, query?: string }} [options]
 * @returns {Promise<{ items: object[], total: number, filtered: number }>}
 */
export async function listLogs(sessionId, options = {}) {
  if (!sessionId) return { items: [], total: 0, filtered: 0 };
  const records = await withStore(STORE_LOGS, "readonly", (store) =>
    promisifyRequest(store.index("sessionId").getAll(String(sessionId)))
  );

  const decoded = await Promise.all(records.map((record) => decodeLogFromStorage(record)));
  const logs = decoded.map((record) => normalizeLog(record)).sort((a, b) => b.ts - a.ts);

  const protocol = String(options.protocol ?? "").toLowerCase();
  const query = options.query ?? "";
  let filtered = logs;
  if (protocol) filtered = filtered.filter((log) => log.protocol === protocol);
  if (query) filtered = filtered.filter((log) => logMatchesQuery(log, query));

  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Number(options.limit);
  const items =
    Number.isFinite(limit) && limit > 0
      ? filtered.slice(offset, offset + limit)
      : filtered.slice(offset);

  return { items, total: logs.length, filtered: filtered.length };
}

/**
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
export async function countLogs(sessionId) {
  return withStore(STORE_LOGS, "readonly", (store) =>
    promisifyRequest(store.index("sessionId").count(String(sessionId)))
  );
}

/**
 * Delete all logs of a session.
 * @param {string} sessionId
 * @returns {Promise<number>} deleted count
 */
export async function deleteLogs(sessionId) {
  return withStore(STORE_LOGS, "readwrite", async (store) => {
    const keys = await promisifyRequest(store.index("sessionId").getAllKeys(String(sessionId)));
    for (const key of keys) store.delete(key);
    return keys.length;
  });
}

/**
 * Keep only the newest `max` logs of a session.
 * @param {string} sessionId
 * @param {number} max
 * @returns {Promise<number>} deleted count
 */
export async function trimLogs(sessionId, max) {
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return withStore(STORE_LOGS, "readwrite", async (store) => {
    const index = store.index("sessionId");
    const records = await promisifyRequest(index.getAll(String(sessionId)));
    if (records.length <= limit) return 0;
    records.sort((a, b) => a.ts - b.ts);
    const doomed = records.slice(0, records.length - limit);
    for (const record of doomed) store.delete(record.id);
    return doomed.length;
  });
}

/* -------------------------------------------------------------------------- */
/* Aggregates                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Persist the outcome of one poll: status, error, backoff and interaction counters.
 * @param {string} sessionId
 * @param {{ status?: number, error?: string, at?: number, added?: number, backoffCap?: number }} result
 * @returns {Promise<object|null>} updated session
 */
export async function recordPollResult(sessionId, result = {}) {
  const session = await getSession(sessionId);
  if (!session) return null;

  const at = Number(result.at) || Date.now();
  const error = String(result.error || "");
  const errorCount = error ? (session.errorCount || 0) + 1 : 0;

  const updated = {
    ...session,
    lastPollAt: at,
    lastStatus: Number.isFinite(result.status) ? result.status : null,
    lastError: error,
    errorCount,
    nextAttemptAt: error ? at + backoffSeconds(errorCount, result.backoffCap) * 1000 : 0,
    updatedAt: at
  };

  if (result.added > 0) {
    updated.interactionCount = (session.interactionCount || 0) + result.added;
    updated.lastInteractionAt = at;
  }

  await withStore(STORE_SESSIONS, "readwrite", (store) => {
    store.put(updated);
  });
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Export / import                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Full data dump, payloads inflated for readability.
 * @returns {Promise<object>}
 */
export async function exportPayload() {
  const sessions = await listSessions({ sort: "created" });
  const records = await withStore(STORE_LOGS, "readonly", (store) =>
    promisifyRequest(store.getAll())
  );
  const logs = await Promise.all(records.map((record) => decodeLogFromStorage(record)));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    app: "ColaboratorExtension",
    sessions,
    logs: logs.map((log) => normalizeLog(log))
  };
}

/**
 * Accept the shapes produced by v1.x, v2.x and hand-written files.
 * @param {unknown} payload
 * @returns {{ sessions: object[], logs: object[] }}
 */
export function normalizeImportPayload(payload) {
  if (!payload) throw new Error("Импорт: пустой файл");
  if (Array.isArray(payload)) return { sessions: payload, logs: [] };
  if (typeof payload !== "object") throw new Error("Импорт: ожидается JSON-объект");

  const root = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const sessions = Array.isArray(root.sessions) ? root.sessions : [];
  const logs = Array.isArray(root.logs) ? root.logs : [];
  if (!sessions.length && !logs.length) {
    throw new Error("Импорт: в файле нет сессий");
  }
  return { sessions, logs };
}

/**
 * Merge (default) or replace the database with an imported payload.
 * @param {unknown} payload
 * @param {{ mode?: "merge"|"replace" }} [options]
 * @returns {Promise<{ sessions: number, logs: number, skippedSessions: number, skippedLogs: number }>}
 */
export async function importPayload(payload, options = {}) {
  const mode = options.mode === "replace" ? "replace" : "merge";
  const { sessions: rawSessions, logs: rawLogs } = normalizeImportPayload(payload);

  if (mode === "replace") await clearAllData();

  const existing = mode === "replace" ? [] : await listSessions({ sort: "created" });
  const existingIds = new Set(existing.map((session) => session.id));

  // De-duplicate by id (last definition wins), then respect the global limit.
  const byId = new Map();
  for (const raw of rawSessions) {
    const session = normalizeSession(raw);
    if (session.id) byId.set(session.id, session);
  }

  let capacity = Math.max(0, MAX_SESSIONS - existing.length);
  let skippedSessions = 0;
  const toStore = [];
  for (const session of byId.values()) {
    if (existingIds.has(session.id)) {
      toStore.push(session); // update in place, does not consume capacity
      continue;
    }
    if (capacity <= 0) {
      skippedSessions += 1;
      continue;
    }
    capacity -= 1;
    toStore.push(session);
  }

  if (toStore.length) await saveSessions(toStore);

  const acceptedIds = new Set([...existingIds, ...toStore.map((session) => session.id)]);
  const logs = rawLogs
    .map((log) => normalizeLog(log))
    .filter((log) => log.sessionId && acceptedIds.has(log.sessionId));

  let logsImported = 0;
  for (const log of logs) {
    if (await addLog(log)) logsImported += 1;
  }

  return {
    sessions: toStore.length,
    logs: logsImported,
    skippedSessions,
    skippedLogs: rawLogs.length - logs.length
  };
}

/**
 * Parse a text file: plain JSON or the legacy base64-wrapped JSON.
 * @param {string} text
 * @returns {object}
 */
export function parseImportText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Импорт: файл пуст");
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to base64 */
  }
  try {
    const binary = atob(raw.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Импорт: не удалось разобрать файл (ожидается JSON или base64-JSON)");
  }
}

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                */
/* -------------------------------------------------------------------------- */

/** Remove every session and log. */
export async function clearAllData() {
  await runTransaction([STORE_SESSIONS, STORE_LOGS], "readwrite", (stores) => {
    stores[STORE_SESSIONS].clear();
    stores[STORE_LOGS].clear();
  });
}

/**
 * Rough database statistics for the options page.
 * @returns {Promise<{sessions:number, activeSessions:number, logs:number, approxBytes:number}>}
 */
export async function getStats() {
  const sessions = await listSessions({ sort: "created" });
  const logRecords = await withStore(STORE_LOGS, "readonly", (store) =>
    promisifyRequest(store.getAll())
  );
  const approxBytes = logRecords.reduce((total, record) => total + safeStringify(record).length, 0);
  return {
    sessions: sessions.length,
    activeSessions: sessions.filter((session) => session.active).length,
    logs: logRecords.length,
    approxBytes
  };
}

export { fingerprintOf };
