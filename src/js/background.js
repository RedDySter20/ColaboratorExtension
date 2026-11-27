/**
 * Colaborator — MV3 service worker.
 *
 * Responsibilities:
 *  - keep a `chrome.alarms` tick aligned with the user's polling interval;
 *  - poll every active session (bounded concurrency, per-session backoff);
 *  - persist new interactions, trim retention, update counters;
 *  - show the unread badge and desktop notifications;
 *  - expose a small message API to the popup / session / options pages.
 */

import { ALARM_NAME, MAX_BACKOFF_SEC, MESSAGE, MIN_POLL_INTERVAL_SEC } from "./core/constants.js";
import { getSettings } from "./core/settings.js";
import {
  addLogs,
  deleteLogs,
  deleteSession,
  getSession,
  listSessions,
  recordPollResult,
  saveSession,
  trimLogs
} from "./core/repository.js";
import { pollSession, triggerTestInteraction } from "./core/poller.js";

const POLL_CONCURRENCY = 3;
const UNREAD_KEY = "unread";
const LAST_NOTIFIED_KEY = "lastNotifiedSessionId";

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

/** Serialises poll cycles so two alarms never overlap. */
let queue = Promise.resolve();

/**
 * @param {() => Promise<any>} task
 * @returns {Promise<any>}
 */
function enqueue(task) {
  const next = queue.then(task).catch((error) => {
    console.error("[colaborator] poll task failed", error);
  });
  queue = next;
  return next;
}

/**
 * Run `worker` over `items` with at most `limit` concurrent calls.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Broadcast to every open extension page, ignoring "no receiver" errors. */
function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message)?.catch(() => {});
  } catch {
    /* no listeners */
  }
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {number} count
 * @returns {Promise<void>}
 */
async function renderBadge(count) {
  const text = count > 0 ? (count > 999 ? "999+" : String(count)) : "";
  try {
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
      await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    }
  } catch (error) {
    console.warn("[colaborator] badge update failed", error);
  }
}

/**
 * @param {number} increment
 * @returns {Promise<void>}
 */
async function bumpUnread(increment) {
  if (increment <= 0) return;
  const stored = await chrome.storage.local.get(UNREAD_KEY);
  const next = Math.min(9999, Number(stored?.[UNREAD_KEY] || 0) + increment);
  await chrome.storage.local.set({ [UNREAD_KEY]: next });
  await renderBadge(next);
}

/** @returns {Promise<void>} */
async function clearUnread() {
  await chrome.storage.local.set({ [UNREAD_KEY]: 0 });
  await renderBadge(0);
}

/* -------------------------------------------------------------------------- */
/* Polling                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} settings
 * @returns {Promise<void>}
 */
async function ensureAlarm(settings) {
  const periodInMinutes = Math.max(MIN_POLL_INTERVAL_SEC, settings.pollIntervalSec) / 60;
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing && Math.abs((existing.periodInMinutes ?? 0) - periodInMinutes) < 0.001) return;
  if (existing) await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes
  });
}

/**
 * Poll a single session, persist results and update aggregates.
 * @param {object} session
 * @param {object} settings
 * @returns {Promise<{sessionId: string, added: number, error: string, skipped?: boolean}>}
 */
async function pollOneSession(session, settings) {
  const base = { sessionId: session.id, added: 0, error: "" };
  const now = Date.now();
  if (session.nextAttemptAt && session.nextAttemptAt > now) {
    return { ...base, skipped: true };
  }

  const outcome = await pollSession(session, { secret: session.secret });
  let added = 0;

  if (outcome.ok && outcome.logs.length) {
    const write = await addLogs(outcome.logs);
    added = write.added;
    if (added > 0) await trimLogs(session.id, settings.maxLogsPerSession);
  }

  const updated = await recordPollResult(session.id, {
    status: outcome.status,
    error: outcome.error,
    at: now + outcome.durationMs,
    added,
    backoffCap: MAX_BACKOFF_SEC
  });

  if (added > 0) {
    broadcast({ type: MESSAGE.LOGS_ADDED, sessionId: session.id, added });
  }
  broadcast({ type: MESSAGE.SESSIONS_UPDATED, sessionId: session.id });

  return {
    sessionId: session.id,
    added,
    error: outcome.error,
    sessionName: updated?.name || session.name,
    protocols: [...new Set(outcome.logs.map((log) => log.protocol))].slice(0, 4)
  };
}

/**
 * Poll every active session and aggregate notifications.
 * @param {{ onlySessionId?: string, includeInactive?: boolean }} [options]
 * @returns {Promise<{polled: number, added: number}>}
 */
async function pollSessions(options = {}) {
  const settings = await getSettings();
  const sessions = await listSessions();
  let candidates = sessions;
  if (options.onlySessionId) {
    candidates = sessions.filter((session) => session.id === options.onlySessionId);
  } else if (!options.includeInactive) {
    candidates = sessions.filter((session) => session.active);
  }
  if (!candidates.length) return { polled: 0, added: 0 };

  const results = await mapLimit(candidates, POLL_CONCURRENCY, (session) =>
    pollOneSession(session, settings)
  );

  const withHits = results.filter((result) => result?.added > 0);
  const totalAdded = withHits.reduce((sum, result) => sum + result.added, 0);

  if (totalAdded > 0) {
    await bumpUnread(totalAdded);
    if (settings.notifications) await notifyInteractions(withHits, totalAdded);
  }

  broadcast({ type: MESSAGE.POLL_FINISHED, polled: results.length, added: totalAdded });
  return { polled: results.length, added: totalAdded };
}

/**
 * One desktop notification per cycle (avoids notification spam).
 * @param {object[]} hits
 * @param {number} total
 * @returns {Promise<void>}
 */
async function notifyInteractions(hits, total) {
  const top = hits.slice(0, 3);
  const lines = top.map(
    (hit) => `${hit.sessionName || hit.sessionId}: ${hit.added} (${hit.protocols.join(", ")})`
  );
  if (hits.length > top.length) lines.push(`…и ещё ${hits.length - top.length} сессий`);

  const notificationId = `colaborator-batch-${Date.now()}`;
  try {
    await chrome.storage.local.set({ [LAST_NOTIFIED_KEY]: hits[0].sessionId });
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `Colaborator: ${total} новых взаимодействий`,
      message: lines.join("\n"),
      priority: 2
    });
  } catch (error) {
    console.warn("[colaborator] notification failed", error);
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ reason?: string }} [details]
 * @returns {Promise<void>}
 */
async function bootstrap(details = {}) {
  const settings = await getSettings();
  await ensureAlarm(settings);

  if (details.reason === "install") {
    // Never start polling on a fresh install before the user hits Start.
    await chrome.storage.local.set({ [UNREAD_KEY]: 0 });
  }

  if (!settings.autoResume) {
    const sessions = await listSessions();
    const active = sessions.filter((session) => session.active);
    for (const session of active)
      await saveSession({ ...session, active: false, nextAttemptAt: 0 });
  }

  const stored = await chrome.storage.local.get(UNREAD_KEY);
  await renderBadge(Number(stored?.[UNREAD_KEY] || 0));
}

chrome.runtime.onInstalled.addListener((details) => {
  bootstrap(details).catch((error) => console.error("[colaborator] install failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap({ reason: "startup" }).catch((error) =>
    console.error("[colaborator] startup failed", error)
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  enqueue(() => pollSessions());
});

chrome.notifications.onClicked.addListener(async () => {
  const stored = await chrome.storage.local.get(LAST_NOTIFIED_KEY);
  const sessionId = stored?.[LAST_NOTIFIED_KEY];
  const url = sessionId
    ? chrome.runtime.getURL(`html/session.html?id=${encodeURIComponent(sessionId)}`)
    : chrome.runtime.getURL("html/popup.html");
  await chrome.tabs.create({ url });
  await clearUnread();
});

/* -------------------------------------------------------------------------- */
/* Message API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} message
 * @returns {Promise<object>}
 */
async function handleMessage(message) {
  switch (message?.type) {
    case MESSAGE.ENSURE_ALARM: {
      const settings = await getSettings();
      await ensureAlarm(settings);
      return { ok: true, settings };
    }
    case MESSAGE.SYNC_NOW: {
      const settings = await getSettings();
      await ensureAlarm(settings);
      enqueue(() => pollSessions());
      return { ok: true, queued: true };
    }
    case MESSAGE.POLL_ONE: {
      if (!message.sessionId) return { ok: false, error: "sessionId is required" };
      const settings = await getSettings();
      await ensureAlarm(settings);
      const result = await enqueue(() =>
        pollSessions({ onlySessionId: message.sessionId, includeInactive: true })
      );
      return { ok: true, ...result };
    }
    case MESSAGE.TEST_INTERACTION: {
      const session = await getSession(message.sessionId);
      if (!session) return { ok: false, error: "Сессия не найдена" };
      await triggerTestInteraction(session.publicUrl);
      // Give the collaboration server a moment, then poll once.
      setTimeout(() => {
        enqueue(() => pollSessions({ onlySessionId: session.id, includeInactive: true })).catch(
          () => {}
        );
      }, 5000);
      return { ok: true };
    }
    case MESSAGE.CLEAR_UNREAD: {
      await clearUnread();
      return { ok: true };
    }
    case "session:delete": {
      if (!message.sessionId) return { ok: false, error: "sessionId is required" };
      await deleteSession(message.sessionId);
      broadcast({ type: MESSAGE.SESSIONS_UPDATED });
      return { ok: true };
    }
    case "session:clear-logs": {
      if (!message.sessionId) return { ok: false, error: "sessionId is required" };
      const deleted = await deleteLogs(message.sessionId);
      broadcast({ type: MESSAGE.LOGS_ADDED, sessionId: message.sessionId, added: 0 });
      return { ok: true, deleted };
    }
    default:
      return { ok: false, error: `Unknown message: ${message?.type ?? "none"}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true; // async response
});

// The worker may be started by an alarm before onInstalled/onStartup ran.
bootstrap().catch((error) => console.error("[colaborator] bootstrap failed", error));
