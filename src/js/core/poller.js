/**
 * HTTP polling and response normalisation.
 *
 * Two server families are supported:
 *  - Burp Collaborator compatible (`{"responses": [...]}`) — oastify.com and
 *    most public collaboration servers;
 *  - interactsh (`{"data": ["<base64>", …]}`, optionally AES-encrypted with the
 *    session secret) — self-hosted instances.
 *
 * Everything network-related is injectable so the whole module is unit-testable
 * without a browser.
 */

import { POLL_TIMEOUT_MS } from "./constants.js";
import { base64ToBytes, decodeUtf8, utf8ToBase64 } from "./encoding.js";
import { normalizeLog, safeStringify } from "./models.js";
import { decryptInteractshPayload } from "./crypto.js";

/**
 * @param {unknown} payload
 * @returns {boolean}
 */
function isObject(payload) {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}

/**
 * Map one Burp Collaborator response object to a log record.
 * @param {object} response
 * @param {string} sessionId
 * @param {number} fallbackTime
 * @returns {object}
 */
export function fromBurpResponse(response, sessionId, fallbackTime = Date.now()) {
  const time = Number(response?.time);
  const client = String(response?.client ?? "");
  const clientPort = response?.clientPort != null ? String(response.clientPort) : "";
  const subDomain = response?.data?.subDomain || response?.subDomain || "";

  let requestB64 = String(response?.data?.request || "");
  if (!requestB64 && subDomain) requestB64 = utf8ToBase64(`DNS ${subDomain}`);

  return normalizeLog({
    sessionId,
    ts: Number.isFinite(time) && time > 0 ? time : fallbackTime,
    protocol: String(response?.protocol || "unknown"),
    client: clientPort ? `${client}:${clientPort}` : client,
    interactionString: String(response?.interactionString || subDomain || ""),
    opCode: String(response?.opCode || ""),
    requestB64,
    responseB64: String(response?.data?.response || ""),
    raw: isObject(response) ? response : undefined,
    source: "burp"
  });
}

/**
 * Map one interactsh interaction object to a log record.
 * @param {object} interaction
 * @param {string} sessionId
 * @param {number} fallbackTime
 * @returns {object}
 */
export function fromInteractshInteraction(interaction, sessionId, fallbackTime = Date.now()) {
  const timestamp = Date.parse(interaction?.timestamp);
  return normalizeLog({
    sessionId,
    ts: Number.isFinite(timestamp) ? timestamp : fallbackTime,
    protocol: String(interaction?.protocol || "unknown"),
    client: String(interaction?.["remote-address"] || ""),
    interactionString: String(interaction?.["full-id"] || interaction?.["unique-id"] || ""),
    opCode: String(interaction?.["q-type"] || ""),
    requestB64: String(interaction?.["raw-request"] || ""),
    responseB64: String(interaction?.["raw-response"] || ""),
    raw: isObject(interaction) ? interaction : undefined,
    source: "interactsh"
  });
}

/**
 * Decode one interactsh `data` entry: base64 → (AES-CTR) → JSON.
 * @param {string} entry
 * @param {string} [secret]
 * @param {number} [fallbackTime]
 * @returns {Promise<object|null>}
 */
export async function decodeInteractshEntry(entry, secret, fallbackTime = Date.now()) {
  if (!entry) return null;
  let bytes = base64ToBytes(String(entry));
  if (secret) {
    try {
      bytes = await decryptInteractshPayload(bytes, secret);
    } catch {
      /* not encrypted — fall through */
    }
  }
  const text = decodeUtf8(bytes).replace(/\0+$/, "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { protocol: "unknown", "raw-request": utf8ToBase64(text), timestamp: fallbackTime };
  }
}

/**
 * Normalise whatever the endpoint returned into a list of logs.
 * @param {unknown} payload parsed JSON body
 * @param {{ sessionId: string, now?: number, secret?: string }} options
 * @returns {Promise<{ logs: object[], warnings: string[], shape: string }>}
 */
export async function parsePollPayload(payload, options) {
  const sessionId = String(options.sessionId || "");
  const now = Number(options.now) || Date.now();
  const warnings = [];
  const logs = [];

  const root =
    isObject(payload) && isObject(payload.data) && Array.isArray(payload.data.responses)
      ? payload.data
      : payload;

  if (Array.isArray(root)) {
    // A bare array may contain Burp responses or interactsh entries.
    for (const item of root) {
      if (typeof item === "string") {
        const decoded = await decodeInteractshEntry(item, options.secret, now);
        if (decoded) logs.push(fromInteractshInteraction(decoded, sessionId, now));
      } else if (isObject(item)) {
        logs.push(
          item.data || item.protocol
            ? fromBurpResponse(item, sessionId, now)
            : fromInteractshInteraction(item, sessionId, now)
        );
      }
    }
    return { logs, warnings, shape: "array" };
  }

  if (isObject(root) && Array.isArray(root.responses)) {
    for (const response of root.responses) {
      if (isObject(response)) logs.push(fromBurpResponse(response, sessionId, now));
    }
    return { logs, warnings, shape: "burp" };
  }

  if (isObject(root) && Array.isArray(root.data)) {
    for (const entry of root.data) {
      if (typeof entry !== "string") continue;
      const decoded = await decodeInteractshEntry(entry, options.secret, now);
      if (decoded) logs.push(fromInteractshInteraction(decoded, sessionId, now));
      else warnings.push("Не удалось декодировать одну запись interactsh");
    }
    if (Array.isArray(root.tlddata) && root.tlddata.length) {
      warnings.push("Сервер вернул tlddata — они не отображаются");
    }
    return { logs, warnings, shape: "interactsh" };
  }

  return { logs, warnings: ["Неизвестный формат ответа сервера"], shape: "unknown" };
}

/**
 * Perform one poll for a session.
 * @param {object} session
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   secret?: string,
 *   now?: number
 * }} [options]
 * @returns {Promise<{ ok: boolean, status: number, error: string, logs: object[], warnings: string[], durationMs: number, shape: string, bodyPreview: string }>}
 */
export async function pollSession(session, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const result = {
    ok: false,
    status: 0,
    error: "",
    logs: [],
    warnings: [],
    durationMs: 0,
    shape: "",
    bodyPreview: ""
  };

  try {
    const response = await fetchImpl(session.privateUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
    result.status = response.status ?? 0;
    const text = await response.text();
    result.bodyPreview = text.slice(0, 300);

    if (!response.ok) {
      result.error = `HTTP ${result.status}${text ? `: ${text.slice(0, 140)}` : ""}`;
      return result;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      result.error = "Ответ сервера не является JSON";
      return result;
    }

    const parsed = await parsePollPayload(json, {
      sessionId: session.id,
      now,
      secret: options.secret
    });
    result.logs = parsed.logs;
    result.warnings = parsed.warnings;
    result.shape = parsed.shape;
    result.ok = true;
    return result;
  } catch (error) {
    result.error =
      error?.name === "AbortError"
        ? `Таймаут запроса (${timeoutMs} мс)`
        : error?.message || String(error);
    return result;
  } finally {
    clearTimeout(timer);
    result.durationMs = Date.now() - startedAt;
  }
}

/**
 * Self-test: requesting the public URL forces a DNS lookup, so the server
 * records an interaction that the next poll will pick up.
 * @param {string} publicUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} true when a request was attempted
 */
export async function triggerTestInteraction(publicUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    await fetchImpl(publicUrl, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    return true;
  } catch {
    // The host resolves but usually refuses the connection — the DNS query is
    // still delivered, which is what we care about.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export { safeStringify };
