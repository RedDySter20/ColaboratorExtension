/**
 * Session URL generation (OAST / collaborator identifiers).
 */

import {
  DEFAULT_HOST,
  DEFAULT_POLLING_HOST,
  DEFAULT_POLLING_PARAM,
  DEFAULT_POLLING_PATH
} from "./constants.js";
import { correlationIdFromKey, interactionLabel, keyToBase64, randomKeyBytes } from "./crypto.js";

/**
 * Normalise a host: strips scheme, path, whitespace and trailing dots.
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeHost(value, fallback = DEFAULT_HOST) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

/**
 * @param {string} label
 * @param {string} [host]
 * @returns {string}
 */
export function buildPublicUrl(label, host = DEFAULT_HOST) {
  return `https://${label}.${normalizeHost(host)}`;
}

/**
 * Build the polling endpoint used to fetch interactions.
 * @param {string} keyB64
 * @param {{ host?: string, path?: string, param?: string }} [options]
 * @returns {string}
 */
export function buildPrivateUrl(keyB64, options = {}) {
  const host = normalizeHost(options.host ?? DEFAULT_POLLING_HOST, DEFAULT_POLLING_HOST);
  const path = options.path ?? DEFAULT_POLLING_PATH;
  const param = options.param ?? DEFAULT_POLLING_PARAM;
  return `https://${host}${path}?${param}=${encodeURIComponent(keyB64)}`;
}

/**
 * Deterministic generator for a single session: one key, many public URLs.
 */
export class SessionGenerator {
  /**
   * @param {Uint8Array} keyBytes 32 random bytes
   * @param {{ host?: string, polling?: { host?: string, path?: string, param?: string } }} [options]
   */
  constructor(keyBytes, options = {}) {
    if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
      throw new Error("Session key must be exactly 32 bytes");
    }
    this.keyBytes = keyBytes;
    this.keyB64 = keyToBase64(keyBytes);
    this.host = normalizeHost(options.host ?? DEFAULT_HOST);
    this.polling = { ...options.polling };
    this.privateUrl = buildPrivateUrl(this.keyB64, this.polling);
    this.correlationId = null;
    this.counter = -1;
  }

  /** Derives the correlation id. Must be awaited before calling `next()`. */
  async init() {
    this.correlationId = await correlationIdFromKey(this.keyBytes);
    return this;
  }

  /**
   * Advance the interaction counter.
   * @param {{ random36?: () => number }} [options]
   * @returns {{ index: number, label: string, publicUrl: string, privateUrl: string }}
   */
  next(options = {}) {
    if (!this.correlationId) throw new Error("SessionGenerator.init() must be awaited first");
    this.counter += 1;
    const label = interactionLabel(this.correlationId, this.counter, options);
    return {
      index: this.counter,
      label,
      publicUrl: buildPublicUrl(label, this.host),
      privateUrl: this.privateUrl
    };
  }

  /** @returns {number} */
  get index() {
    return this.counter;
  }
}

/**
 * Create a brand new session record (not persisted).
 * @param {{ name?: string, host?: string, polling?: object }} [options]
 * @returns {Promise<{ id: string, name: string, keyB64: string, publicUrl: string, privateUrl: string, host: string, active: boolean }>}
 */
export async function createSessionDraft(options = {}) {
  const keyBytes = randomKeyBytes(32);
  const generator = new SessionGenerator(keyBytes, {
    host: options.host,
    polling: options.polling
  });
  await generator.init();
  const first = generator.next();
  const id = crypto.randomUUID();
  return {
    id,
    name: options.name || `Session ${id.slice(0, 4)}`,
    keyB64: generator.keyB64,
    publicUrl: first.publicUrl,
    privateUrl: first.privateUrl,
    host: normalizeHost(options.host),
    active: false
  };
}
