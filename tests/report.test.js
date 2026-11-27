import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeTableCell,
  formatTimestamp,
  generateReport,
  generateSessionReport,
  reportFileName
} from "../src/js/core/report.js";
import { utf8ToBase64 } from "../src/js/core/encoding.js";
import { normalizeLog, normalizeSession } from "../src/js/core/models.js";

const session = normalizeSession({
  id: "s-1",
  name: "ACME | login",
  publicUrl: "https://abc.oastify.com",
  privateUrl: "https://polling.oastify.com/p?biid=x",
  keyB64: "AAAA",
  createdAt: 1700000000000,
  interactionCount: 3
});

const httpLog = normalizeLog({
  sessionId: "s-1",
  ts: 1700000000000,
  protocol: "http",
  client: "1.2.3.4:80",
  requestB64: utf8ToBase64("GET /cb HTTP/1.1\r\nHost: abc.oastify.com\r\n\r\n"),
  responseB64: utf8ToBase64("HTTP/1.1 200 OK\r\n\r\n")
});

const dnsLog = normalizeLog({
  sessionId: "s-1",
  ts: 1700000001000,
  protocol: "dns",
  client: "5.6.7.8",
  interactionString: "q1.oastify.com",
  requestB64: utf8ToBase64("DNS q1.oastify.com")
});

test("escapeTableCell escapes pipes and newlines", () => {
  assert.equal(escapeTableCell("a|b"), "a\\|b");
  assert.equal(escapeTableCell("a\nb"), "a<br>b");
  assert.equal(escapeTableCell("  spaced  "), "spaced");
  assert.equal(escapeTableCell(null), "");
});

test("formatTimestamp renders UTC ISO without milliseconds", () => {
  assert.equal(formatTimestamp(0), "1970-01-01 00:00:00 UTC");
  assert.equal(formatTimestamp("nope"), "—");
});

test("generateSessionReport includes metadata and a table", () => {
  const markdown = generateSessionReport(session, [httpLog, dnsLog]);
  assert.match(markdown, /## ACME \| login/);
  assert.match(markdown, /Публичный URL/);
  assert.match(markdown, /\| # \| Время \(UTC\) \| Протокол \| Клиент \|/);
  assert.match(markdown, /\| 1 \|/);
  assert.match(markdown, /GET \/cb/);
  assert.match(markdown, /dns/);
  assert.match(markdown, /<details>/);
});

test("generateSessionReport handles empty logs", () => {
  const markdown = generateSessionReport(session, []);
  assert.match(markdown, /Взаимодействий нет/);
  assert.doesNotMatch(markdown, /<details>/);
});

test("generateReport aggregates sessions and lists the empty ones", () => {
  const idle = normalizeSession({
    id: "s-2",
    name: "Idle session",
    publicUrl: "https://idle.oastify.com"
  });
  const markdown = generateReport({
    sessions: [session, idle],
    logs: [httpLog, dnsLog],
    generatedAt: 1700000002000,
    version: "2.0.0"
  });

  assert.match(markdown, /# Colaborator — отчёт/);
  assert.match(markdown, /Сессий: \*\*2\*\*/);
  assert.match(markdown, /Взаимодействий: \*\*2\*\*/);
  assert.match(markdown, /Версия расширения: 2\.0\.0/);
  assert.match(markdown, /## Сессии без взаимодействий/);
  assert.match(markdown, /Idle session/);
  assert.match(markdown, /только в рамках авторизованного тестирования/);
});

test("generateReport survives a completely empty database", () => {
  const markdown = generateReport({ sessions: [], logs: [] });
  assert.match(markdown, /Сессий: \*\*0\*\*/);
});

test("reportFileName is filesystem friendly", () => {
  const name = reportFileName(new Date("2024-05-06T07:08:09.123Z"));
  assert.match(name, /^colaborator-report-2024-05-06T07-08-09-123\.md$/);
});

test("code fences are widened when the payload contains backticks", () => {
  const tricky = normalizeLog({
    sessionId: "s-1",
    ts: 1700000003000,
    protocol: "http",
    requestB64: utf8ToBase64("GET /``` HTTP/1.1\r\n\r\n")
  });
  const markdown = generateSessionReport(session, [tricky]);
  assert.match(markdown, /````/);
});
