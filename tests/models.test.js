import test from "node:test";
import assert from "node:assert/strict";

import {
  backoffSeconds,
  canAddSession,
  fingerprintOf,
  logMatchesQuery,
  normalizeLog,
  normalizeSession,
  retentionFor,
  safeStringify,
  sessionMatchesQuery,
  sessionState,
  sortSessions,
  validateSession
} from "../src/js/core/models.js";
import { MAX_SESSIONS } from "../src/js/core/constants.js";

test("normalizeSession fills defaults and coerces types", () => {
  const session = normalizeSession({ id: "abc", name: "Test" });
  assert.equal(session.id, "abc");
  assert.equal(session.name, "Test");
  assert.equal(session.active, false);
  assert.equal(session.interactionCount, 0);
  assert.equal(session.host, "oastify.com");
  assert.ok(session.createdAt > 0);
  assert.equal(session.lastPollAt, null);
});

test("normalizeSession clamps the name and tolerates junk", () => {
  const session = normalizeSession({ name: "x".repeat(400), createdAt: "nope", lastStatus: "500" });
  assert.equal(session.name.length, 120);
  assert.ok(Number.isFinite(session.createdAt));
  assert.equal(session.lastStatus, 500);
});

test("normalizeLog understands legacy field names", () => {
  const log = normalizeLog({
    sessionId: "s1",
    protocol: "HTTP",
    clientInfo: "1.2.3.4:4444",
    time: 1700000000000,
    rawRequest: "cmVx",
    rawResponse: "cmVz",
    fullId: "abcd.oastify.com"
  });
  assert.equal(log.protocol, "http");
  assert.equal(log.client, "1.2.3.4:4444");
  assert.equal(log.ts, 1700000000000);
  assert.equal(log.requestB64, "cmVx");
  assert.equal(log.responseB64, "cmVz");
  assert.equal(log.interactionString, "abcd.oastify.com");
  assert.match(log.fingerprint, /^[0-9a-f]{8}$/);
});

test("normalizeLog parses ISO timestamps", () => {
  const log = normalizeLog({ sessionId: "s", timestamp: "2024-05-01T10:00:00Z" });
  assert.equal(log.ts, Date.parse("2024-05-01T10:00:00Z"));
});

test("fingerprints are stable and content sensitive", () => {
  const base = { sessionId: "s", ts: 1, protocol: "dns", client: "c", interactionString: "i" };
  const a = normalizeLog({ ...base, requestB64: "AAA" });
  const b = normalizeLog({ ...base, requestB64: "AAA" });
  const c = normalizeLog({ ...base, requestB64: "BBB" });
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.notEqual(fingerprintOf(a), fingerprintOf(c));
});

test("sessionState reflects polling and errors", () => {
  assert.equal(sessionState({ active: false }), "idle");
  assert.equal(sessionState({ active: true }), "polling");
  assert.equal(sessionState({ active: true, lastError: "boom", errorCount: 1 }), "error");
});

test("sessionMatchesQuery supports multiple tokens", () => {
  const session = normalizeSession({
    name: "ACME login",
    publicUrl: "https://abc.oastify.com",
    privateUrl: "https://polling.oastify.com:443/burpresults?biid=x"
  });
  assert.equal(sessionMatchesQuery(session, ""), true);
  assert.equal(sessionMatchesQuery(session, "acme"), true);
  assert.equal(sessionMatchesQuery(session, "acme abc"), true);
  assert.equal(sessionMatchesQuery(session, "acme nope"), false);
});

test("logMatchesQuery searches payloads and protocol", () => {
  const log = normalizeLog({
    sessionId: "s",
    protocol: "http",
    client: "10.1.1.1",
    requestB64: "R0VUIC9jYWxsYmFjaw=="
  });
  assert.equal(logMatchesQuery(log, "http"), true);
  assert.equal(logMatchesQuery(log, "10.1"), true);
  assert.equal(logMatchesQuery(log, "callback"), true);
  assert.equal(logMatchesQuery(log, "zzz"), false);
});

test("sortSessions supports every mode", () => {
  const sessions = [
    normalizeSession({ id: "a", name: "Beta", updatedAt: 1, createdAt: 3, interactionCount: 5 }),
    normalizeSession({ id: "b", name: "Alpha", updatedAt: 2, createdAt: 1, interactionCount: 0 })
  ];
  assert.deepEqual(
    sortSessions(sessions, "updated").map((s) => s.id),
    ["b", "a"]
  );
  assert.deepEqual(
    sortSessions(sessions, "name").map((s) => s.id),
    ["b", "a"]
  );
  assert.deepEqual(
    sortSessions(sessions, "created").map((s) => s.id),
    ["a", "b"]
  );
  assert.deepEqual(
    sortSessions(sessions, "interactions").map((s) => s.id),
    ["a", "b"]
  );
  // Input is not mutated
  assert.equal(sessions[0].id, "a");
});

test("validateSession reports missing and malformed URLs", () => {
  assert.deepEqual(
    validateSession({ id: "a", publicUrl: "x", privateUrl: "https://x.test/p" }),
    []
  );
  assert.ok(validateSession({}).length >= 3);
  assert.ok(validateSession({ id: "a", publicUrl: "u", privateUrl: "not a url" }).length >= 1);
});

test("capacity helpers respect the global limit", () => {
  assert.equal(canAddSession(MAX_SESSIONS - 1), true);
  assert.equal(canAddSession(MAX_SESSIONS), false);
  assert.equal(canAddSession(0, 1), true);
  assert.equal(canAddSession(1, 1), false);
});

test("retentionFor falls back and respects overrides", () => {
  assert.equal(retentionFor({ maxLogs: 100 }, 500), 100);
  assert.equal(retentionFor({}, 500), 500);
  assert.equal(retentionFor({ maxLogs: 0 }, 42), 42);
});

test("backoffSeconds grows exponentially and caps", () => {
  assert.equal(backoffSeconds(0), 0);
  assert.equal(backoffSeconds(1), 2);
  assert.equal(backoffSeconds(3), 8);
  assert.equal(backoffSeconds(20), 300);
  assert.equal(backoffSeconds(20, 60), 60);
});

test("safeStringify never throws", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(safeStringify(circular), "[object Object]");
  assert.match(safeStringify({ a: 1 }), /"a": 1/);
});
