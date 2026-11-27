import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";

import {
  addLog,
  addLogs,
  clearAllData,
  countLogs,
  countSessions,
  deleteLogs,
  deleteSession,
  exportPayload,
  getSession,
  getStats,
  importPayload,
  listLogs,
  listSessions,
  normalizeImportPayload,
  parseImportText,
  recordPollResult,
  saveSession,
  saveSessions,
  trimLogs
} from "../src/js/core/repository.js";
import { closeDatabase } from "../src/js/core/db.js";
import { STORE_LOGS } from "../src/js/core/constants.js";
import { utf8ToBase64 } from "../src/js/core/encoding.js";

const baseSession = {
  id: "s-1",
  name: "Session one",
  keyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  publicUrl: "https://abc.oastify.com",
  privateUrl: "https://polling.oastify.com:443/burpresults?biid=x"
};

function makeLog(overrides = {}) {
  return {
    sessionId: "s-1",
    ts: 1700000000000,
    protocol: "http",
    client: "1.2.3.4:99",
    interactionString: "abc.oastify.com",
    requestB64: utf8ToBase64("GET / HTTP/1.1\r\nHost: abc.oastify.com\r\n\r\n"),
    ...overrides
  };
}

beforeEach(async () => {
  await clearAllData();
});

after(async () => {
  await closeDatabase();
});

test("sessions round-trip through IndexedDB", async () => {
  await saveSession(baseSession);
  const session = await getSession("s-1");
  assert.equal(session.name, "Session one");
  assert.equal(session.host, "oastify.com");
  assert.equal(await countSessions(), 1);

  const listed = await listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "s-1");
});

test("saveSession bumps updatedAt and normalises input", async () => {
  const first = await saveSession({ ...baseSession, updatedAt: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await saveSession({ ...first, name: "Renamed" });
  assert.equal(second.name, "Renamed");
  assert.ok(second.updatedAt > first.updatedAt);
});

test("saveSessions stores many sessions at once", async () => {
  const count = await saveSessions([
    { ...baseSession, id: "a", name: "A" },
    { ...baseSession, id: "b", name: "B" }
  ]);
  assert.equal(count, 2);
  assert.equal((await listSessions()).length, 2);
});

test("addLogs de-duplicates by fingerprint", async () => {
  const log = makeLog();
  const first = await addLogs([log]);
  assert.deepEqual(first, { added: 1, skipped: 0 });

  const second = await addLogs([{ ...log }]);
  assert.deepEqual(second, { added: 0, skipped: 1 });

  // Duplicates inside the same batch are collapsed too.
  const third = await addLogs([makeLog(), makeLog()]);
  assert.deepEqual(third, { added: 0, skipped: 2 });
  assert.equal(await countLogs("s-1"), 1);
});

test("addLog reports whether the interaction was new", async () => {
  assert.equal(await addLog(makeLog({ ts: 2 })), true);
  assert.equal(await addLog(makeLog({ ts: 2 })), false);
});

test("listLogs returns newest first with filters and paging", async () => {
  await addLogs([
    makeLog({ ts: 1, protocol: "dns" }),
    makeLog({ ts: 2, protocol: "http" }),
    makeLog({ ts: 3, protocol: "http", requestB64: utf8ToBase64("GET /admin HTTP/1.1") })
  ]);

  const all = await listLogs("s-1");
  assert.equal(all.total, 3);
  assert.deepEqual(
    all.items.map((log) => log.ts),
    [3, 2, 1]
  );

  const httpOnly = await listLogs("s-1", { protocol: "http" });
  assert.equal(httpOnly.filtered, 2);

  const paged = await listLogs("s-1", { limit: 1, offset: 1 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.items[0].ts, 2);

  const searched = await listLogs("s-1", { query: "admin" });
  assert.equal(searched.filtered, 1);
  assert.equal(searched.items[0].ts, 3);
});

test("listLogs on an unknown session is empty", async () => {
  assert.deepEqual(await listLogs("missing"), { items: [], total: 0, filtered: 0 });
});

test("large payloads are gzip-packed and restored transparently", async () => {
  const bigRequest = utf8ToBase64(`GET /${"a".repeat(4000)} HTTP/1.1`);
  await addLog(makeLog({ requestB64: bigRequest }));

  const { withStore } = await import("../src/js/core/db.js");
  const { promisifyRequest } = await import("../src/js/core/db.js");
  const raw = await withStore(STORE_LOGS, "readonly", (store) => promisifyRequest(store.getAll()));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].zipCodec, "gzip-base64-v1");
  assert.equal(raw[0].requestB64, "");
  assert.ok(raw[0].requestB64Zip.length > 0);

  const { items } = await listLogs("s-1");
  assert.equal(items[0].requestB64, bigRequest);
});

test("trimLogs keeps the newest entries", async () => {
  await addLogs([makeLog({ ts: 1 }), makeLog({ ts: 2 }), makeLog({ ts: 3 }), makeLog({ ts: 4 })]);
  const removed = await trimLogs("s-1", 2);
  assert.equal(removed, 2);
  const { items } = await listLogs("s-1");
  assert.deepEqual(
    items.map((log) => log.ts),
    [4, 3]
  );
  assert.equal(await trimLogs("s-1", 10), 0);
});

test("deleteLogs removes only the target session", async () => {
  await addLogs([makeLog({ ts: 1 }), makeLog({ ts: 2 })]);
  await addLog(makeLog({ sessionId: "s-2", ts: 3 }));
  assert.equal(await deleteLogs("s-1"), 2);
  assert.equal(await countLogs("s-1"), 0);
  assert.equal(await countLogs("s-2"), 1);
});

test("deleteSession cascades to logs", async () => {
  await saveSession(baseSession);
  await addLog(makeLog());
  await deleteSession("s-1");
  assert.equal(await getSession("s-1"), null);
  assert.equal(await countLogs("s-1"), 0);
});

test("recordPollResult tracks status, errors, backoff and counters", async () => {
  await saveSession(baseSession);

  const ok = await recordPollResult("s-1", { status: 200, at: 1000, added: 2 });
  assert.equal(ok.lastStatus, 200);
  assert.equal(ok.lastError, "");
  assert.equal(ok.errorCount, 0);
  assert.equal(ok.interactionCount, 2);
  assert.equal(ok.nextAttemptAt, 0);

  const failed = await recordPollResult("s-1", { status: 0, error: "boom", at: 2000 });
  assert.equal(failed.errorCount, 1);
  assert.ok(failed.nextAttemptAt > 2000);
  assert.equal(failed.interactionCount, 2);

  const failedAgain = await recordPollResult("s-1", { error: "boom", at: 3000 });
  assert.equal(failedAgain.errorCount, 2);
  assert.ok(failedAgain.nextAttemptAt - 3000 > failed.nextAttemptAt - 2000);

  const recovered = await recordPollResult("s-1", { status: 200, at: 4000, added: 1 });
  assert.equal(recovered.errorCount, 0);
  assert.equal(recovered.interactionCount, 3);

  assert.equal(await recordPollResult("missing", {}), null);
});

test("exportPayload produces a versioned, readable dump", async () => {
  await saveSession(baseSession);
  await addLog(makeLog());
  const payload = await exportPayload();
  assert.equal(payload.version, 2);
  assert.equal(payload.format, "colaborator-extension");
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.logs.length, 1);
  assert.equal(payload.logs[0].sessionId, "s-1");
  assert.ok(JSON.stringify(payload).includes("https://abc.oastify.com"));
});

test("importPayload merges without duplicates", async () => {
  await saveSession(baseSession);
  await addLog(makeLog());

  const result = await importPayload({
    sessions: [
      { ...baseSession, name: "Imported" },
      { ...baseSession, id: "s-2", name: "Second" }
    ],
    logs: [makeLog(), makeLog({ ts: 999 })]
  });

  assert.equal(result.sessions, 2);
  assert.equal(result.logs, 1);
  assert.equal(await countLogs("s-1"), 2);
  assert.equal((await getSession("s-1")).name, "Imported");
});

test("importPayload respects the 10 session limit on merge", async () => {
  const existing = Array.from({ length: 10 }, (_, index) => ({
    ...baseSession,
    id: `existing-${index}`,
    name: `E${index}`
  }));
  await saveSessions(existing);

  const result = await importPayload({
    sessions: [{ ...baseSession, id: "extra", name: "Extra" }],
    logs: []
  });
  assert.equal(result.sessions, 0);
  assert.equal(result.skippedSessions, 1);
  assert.equal(await countSessions(), 10);
});

test("importPayload replace wipes previous data", async () => {
  await saveSession(baseSession);
  await addLog(makeLog());

  const result = await importPayload(
    { sessions: [{ ...baseSession, id: "new", name: "New" }], logs: [] },
    { mode: "replace" }
  );
  assert.equal(result.sessions, 1);
  assert.equal(await countSessions(), 1);
  assert.equal(await getSession("s-1"), null);
  assert.equal(await countLogs("s-1"), 0);
});

test("importPayload drops logs that reference unknown sessions", async () => {
  await saveSession(baseSession);
  const result = await importPayload({
    sessions: [baseSession],
    logs: [makeLog({ sessionId: "ghost" }), makeLog()]
  });
  assert.equal(result.logs, 1);
  assert.equal(result.skippedLogs, 1);
});

test("normalizeImportPayload accepts legacy and wrapped shapes", () => {
  assert.deepEqual(normalizeImportPayload([baseSession]), { sessions: [baseSession], logs: [] });
  assert.deepEqual(normalizeImportPayload({ data: { sessions: [baseSession], logs: [] } }), {
    sessions: [baseSession],
    logs: []
  });
  assert.throws(() => normalizeImportPayload({}), /нет сессий/);
  assert.throws(() => normalizeImportPayload(null), /пустой/);
});

test("parseImportText accepts JSON and legacy base64 JSON", () => {
  const payload = { sessions: [baseSession], logs: [] };
  assert.equal(parseImportText(JSON.stringify(payload)).sessions.length, 1);
  assert.equal(parseImportText(utf8ToBase64(JSON.stringify(payload))).sessions.length, 1);
  assert.throws(() => parseImportText("   "), /пуст/);
  assert.throws(() => parseImportText("!!!not-base64!!!"), /не удалось/);
});

test("getStats summarises the database", async () => {
  await saveSession({ ...baseSession, active: true });
  await addLog(makeLog());
  const stats = await getStats();
  assert.equal(stats.sessions, 1);
  assert.equal(stats.activeSessions, 1);
  assert.equal(stats.logs, 1);
  assert.ok(stats.approxBytes > 0);
});

test("clearAllData empties both stores", async () => {
  await saveSession(baseSession);
  await addLog(makeLog());
  await clearAllData();
  assert.equal(await countSessions(), 0);
  assert.equal(await countLogs("s-1"), 0);
});
