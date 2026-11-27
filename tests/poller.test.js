import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";

import {
  decodeInteractshEntry,
  fromBurpResponse,
  fromInteractshInteraction,
  parsePollPayload,
  pollSession,
  triggerTestInteraction
} from "../src/js/core/poller.js";
import { bytesToBase64, utf8ToBase64 } from "../src/js/core/encoding.js";

const SESSION = {
  id: "session-1",
  privateUrl: "https://polling.oastify.com:443/burpresults?biid=abc"
};

/** Minimal Response double. */
function fakeResponse(body, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

const burpPayload = {
  responses: [
    {
      protocol: "dns",
      client: "10.0.0.9",
      clientPort: 55123,
      time: 1700000000000,
      interactionString: "a1b2c3.oastify.com",
      opCode: "TXT",
      data: { request: utf8ToBase64("dns-bytes"), response: utf8ToBase64("ok") }
    },
    {
      protocol: "http",
      client: "10.0.0.9",
      clientPort: 55124,
      time: 1700000001000,
      interactionString: "def456.oastify.com",
      data: {
        request: utf8ToBase64("GET / HTTP/1.1\r\nHost: def456.oastify.com\r\n\r\n"),
        response: utf8ToBase64("HTTP/1.1 200 OK\r\n\r\n")
      }
    }
  ]
};

test("fromBurpResponse maps every field and derives a DNS request", () => {
  const log = fromBurpResponse(
    {
      protocol: "dns",
      client: "1.1.1.1",
      clientPort: 53,
      time: 5,
      data: { subDomain: "x.oastify.com" }
    },
    "s1"
  );
  assert.equal(log.client, "1.1.1.1:53");
  assert.equal(log.ts, 5);
  assert.equal(log.requestB64, utf8ToBase64("DNS x.oastify.com"));
  assert.equal(log.source, "burp");
  assert.equal(log.protocol, "dns");
});

test("fromInteractshInteraction maps interactsh field names", () => {
  const log = fromInteractshInteraction(
    {
      protocol: "dns",
      "unique-id": "u1",
      "full-id": "full.oastify.com",
      "q-type": "TXT",
      "raw-request": "cmVx",
      "raw-response": "cmVz",
      "remote-address": "9.9.9.9:1234",
      timestamp: "2024-01-02T03:04:05Z"
    },
    "s2"
  );
  assert.equal(log.client, "9.9.9.9:1234");
  assert.equal(log.interactionString, "full.oastify.com");
  assert.equal(log.opCode, "TXT");
  assert.equal(log.ts, Date.parse("2024-01-02T03:04:05Z"));
  assert.equal(log.source, "interactsh");
});

test("parsePollPayload handles Burp responses", async () => {
  const result = await parsePollPayload(burpPayload, { sessionId: "s1", now: 1 });
  assert.equal(result.shape, "burp");
  assert.equal(result.logs.length, 2);
  assert.equal(result.logs[0].protocol, "dns");
  assert.equal(result.logs[0].sessionId, "s1");
  assert.equal(result.logs[1].protocol, "http");
});

test("parsePollPayload handles a bare array of Burp responses", async () => {
  const result = await parsePollPayload(burpPayload.responses, { sessionId: "s1", now: 1 });
  assert.equal(result.shape, "array");
  assert.equal(result.logs.length, 2);
});

test("parsePollPayload decodes interactsh base64 JSON", async () => {
  const interaction = {
    protocol: "dns",
    "full-id": "abc.oastify.com",
    "raw-request": "cmVx",
    "remote-address": "1.2.3.4",
    timestamp: "2024-01-01T00:00:00Z"
  };
  const payload = { data: [bytesToBase64(new TextEncoder().encode(JSON.stringify(interaction)))] };
  const result = await parsePollPayload(payload, { sessionId: "s1" });
  assert.equal(result.shape, "interactsh");
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].interactionString, "abc.oastify.com");
});

test("decodeInteractshEntry decrypts AES-CTR payloads when a secret is set", async () => {
  const secret = "s3cr3t-token";
  const interaction = {
    protocol: "http",
    "full-id": "enc.oastify.com",
    timestamp: "2024-01-01T00:00:00Z"
  };
  const plaintext = Buffer.from(JSON.stringify(interaction), "utf8");

  const key = nodeCrypto.createHash("sha256").update(secret).digest();
  const iv = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const entry = Buffer.concat([iv, ciphertext]).toString("base64");

  const extracted = await decodeInteractshEntry(entry, secret);
  assert.equal(extracted["full-id"], "enc.oastify.com");

  // Without the secret the payload stays opaque — no crash, no silent data loss.
  const result = await parsePollPayload({ data: [entry] }, { sessionId: "s1" });
  assert.equal(result.logs.length, 1);
  assert.equal(result.warnings.length, 0);
});

test("parsePollPayload tolerates unknown shapes", async () => {
  const result = await parsePollPayload({ nope: true }, { sessionId: "s1" });
  assert.equal(result.shape, "unknown");
  assert.equal(result.logs.length, 0);
  assert.equal(result.warnings.length, 1);
});

test("pollSession returns logs on success", async () => {
  const outcome = await pollSession(SESSION, { fetchImpl: async () => fakeResponse(burpPayload) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.error, "");
  assert.equal(outcome.logs.length, 2);
  assert.ok(outcome.durationMs >= 0);
});

test("pollSession reports HTTP errors", async () => {
  const outcome = await pollSession(SESSION, {
    fetchImpl: async () => fakeResponse("nope", { status: 500, ok: false })
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 500);
  assert.match(outcome.error, /HTTP 500/);
  assert.equal(outcome.logs.length, 0);
});

test("pollSession reports non-JSON responses", async () => {
  const outcome = await pollSession(SESSION, { fetchImpl: async () => fakeResponse("<html>") });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /JSON/);
});

test("pollSession reports network failures", async () => {
  const outcome = await pollSession(SESSION, {
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    }
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Failed to fetch/);
});

test("pollSession enforces a timeout", async () => {
  const outcome = await pollSession(SESSION, {
    timeoutMs: 10,
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Таймаут/);
});

test("triggerTestInteraction always resolves", async () => {
  assert.equal(
    await triggerTestInteraction("https://x.oastify.com", {
      fetchImpl: async () => fakeResponse("")
    }),
    true
  );
  assert.equal(
    await triggerTestInteraction("https://x.oastify.com", {
      fetchImpl: async () => {
        throw new Error("dns only");
      }
    }),
    true
  );
});

test("parsePollPayload ignores tlddata but surfaces a warning", async () => {
  const result = await parsePollPayload({ data: [], tlddata: ["x"] }, { sessionId: "s" });
  assert.equal(result.logs.length, 0);
  assert.equal(result.warnings.length, 1);
});
