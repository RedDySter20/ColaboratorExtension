import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeField,
  describeInteraction,
  describePayload,
  detectProtocol,
  headerValue,
  parseDnsQuery,
  parseHttpMessage,
  parseSmtpDialog,
  quickSummary
} from "../src/js/core/protocol.js";
import { bytesToBase64, utf8ToBase64 } from "../src/js/core/encoding.js";
import { normalizeLog } from "../src/js/core/models.js";

const enc = (text) => utf8ToBase64(text);

test("parseHttpMessage splits request line, headers and body", () => {
  const raw = [
    "POST /callback?token=abc HTTP/1.1",
    "Host: xyz.oastify.com",
    "Authorization: Bearer secret-token",
    "User-Agent: curl/8.4.0",
    "Content-Type: application/json",
    "Content-Length: 13",
    "",
    '{"a":"hello"'
  ].join("\r\n");

  const parsed = parseHttpMessage(raw);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.path, "/callback?token=abc");
  assert.equal(parsed.version, "1.1");
  assert.equal(parsed.headers.length, 5);
  assert.equal(headerValue(parsed.headers, "host"), "xyz.oastify.com");
  assert.equal(headerValue(parsed.headers, "AUTHORIZATION"), "Bearer secret-token");
  assert.match(parsed.body, /hello/);
});

test("parseHttpMessage understands responses", () => {
  const parsed = parseHttpMessage("HTTP/1.1 204 No Content\r\nServer: nginx\r\n\r\n");
  assert.equal(parsed.statusCode, 204);
  assert.equal(parsed.statusText, "No Content");
  assert.equal(headerValue(parsed.headers, "server"), "nginx");
});

test("parseDnsQuery decodes a wire-format question", () => {
  const labels = ["abc123", "oastify", "com"];
  const parts = [0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  for (const label of labels)
    parts.push(label.length, ...Array.from(label, (c) => c.charCodeAt(0)));
  parts.push(0x00, 0x00, 0x01, 0x00, 0x01);

  const query = parseDnsQuery(Uint8Array.from(parts));
  assert.equal(query.qname, "abc123.oastify.com");
  assert.equal(query.qtype, 1);
  assert.equal(query.qtypeName, "A");
  assert.equal(query.id, 0x1234);
});

test("parseDnsQuery rejects garbage", () => {
  assert.equal(parseDnsQuery(new Uint8Array(4)), null);
  assert.equal(parseDnsQuery(null), null);
  assert.equal(parseDnsQuery(new Uint8Array(20)), null);
});

test("parseSmtpDialog extracts envelope fields", () => {
  const dialog =
    "EHLO test\r\nMAIL FROM:<attacker@example.com>\r\nRCPT TO:<victim@corp.test>\r\nSubject: reset\r\n";
  const parsed = parseSmtpDialog(dialog);
  assert.equal(parsed.mailFrom, "attacker@example.com");
  assert.equal(parsed.rcptTo, "victim@corp.test");
  assert.equal(parsed.subject, "reset");
});

test("detectProtocol sniffs common dialects", () => {
  assert.equal(detectProtocol(new TextEncoder().encode("GET / HTTP/1.1\r\n")), "http");
  assert.equal(detectProtocol(new TextEncoder().encode("EHLO relay\r\n")), "smtp");
  assert.equal(detectProtocol(new TextEncoder().encode("HTTP/1.1 200 OK")), "http");
  const dnsQuery = Uint8Array.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectProtocol(dnsQuery), "dns");
  assert.equal(detectProtocol(new Uint8Array(0)), "unknown");
});

test("describePayload flags empty, textual and binary payloads", () => {
  assert.equal(describePayload(null).empty, true);
  const text = describePayload(new TextEncoder().encode("hello"));
  assert.equal(text.isText, true);
  assert.equal(text.size, 5);
  assert.match(text.hex, /68 65 6c 6c 6f/);
  assert.deepEqual(text.strings, ["hello"]);

  const binary = describePayload(new Uint8Array([0, 1, 2, 0, 4]));
  assert.equal(binary.isText, false);
});

test("describeInteraction builds HTTP fields including interesting headers", () => {
  const log = normalizeLog({
    sessionId: "s1",
    protocol: "http",
    client: "10.0.0.5",
    requestB64: enc("GET /x?y=1 HTTP/1.1\r\nHost: abc.oastify.com\r\nCookie: session=1\r\n\r\n"),
    responseB64: enc("HTTP/1.1 200 OK\r\nServer: nginx\r\n\r\n"),
    ts: 1700000000000
  });

  const described = describeInteraction(log);
  assert.equal(described.protocol, "http");
  assert.equal(described.summary, "GET /x?y=1");
  const labels = described.fields.map((field) => field.label);
  assert.ok(labels.includes("Host"));
  assert.ok(labels.includes("Cookie"));
  assert.ok(labels.includes("Ответ"));
  assert.equal(described.request.size > 0, true);
  assert.match(described.request.hex, /^00000000/);
});

test("describeInteraction falls back to DNS query name", () => {
  const parts = [0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
  for (const label of ["deadbeef", "oastify", "com"]) {
    parts.push(label.length, ...Array.from(label, (c) => c.charCodeAt(0)));
  }
  parts.push(0x00, 0x00, 0x10, 0x00, 0x01);

  const log = normalizeLog({
    sessionId: "s1",
    protocol: "dns",
    requestB64: bytesToBase64(Uint8Array.from(parts))
  });
  const described = describeInteraction(log);
  assert.equal(described.protocol, "dns");
  assert.match(described.summary, /deadbeef\.oastify\.com/);
  assert.ok(
    described.fields.some((field) => field.label === "Тип записи" && field.value === "TXT")
  );
});

test("describeInteraction detects protocol when the server did not label it", () => {
  const log = normalizeLog({
    sessionId: "s1",
    protocol: "",
    requestB64: enc("GET / HTTP/1.1\r\nHost: a.oastify.com\r\n\r\n")
  });
  assert.equal(describeInteraction(log).protocol, "http");
});

test("quickSummary is cheap and protocol aware", () => {
  assert.deepEqual(
    quickSummary(
      normalizeLog({
        sessionId: "s",
        protocol: "http",
        requestB64: enc("PUT /api HTTP/1.1\r\nHost: a\r\n\r\n")
      })
    ),
    { protocol: "http", summary: "PUT /api" }
  );

  const dnsLog = normalizeLog({
    sessionId: "s",
    protocol: "dns",
    interactionString: "abcd.oastify.com"
  });
  assert.deepEqual(quickSummary(dnsLog), { protocol: "dns", summary: "abcd.oastify.com" });
});

test("decodeField tolerates malformed base64", () => {
  assert.equal(decodeField(""), null);
  assert.equal(decodeField("%%%"), null);
  assert.deepEqual([...decodeField("aGk=")], [104, 105]);
});
