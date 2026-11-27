/**
 * Binary / text helpers. Everything here is synchronous and environment agnostic
 * (browser page, service worker, Node test runner).
 */

const CHUNK = 0x8000;

/**
 * Base64-encode a byte array without blowing the call stack on large payloads.
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {string}
 */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode base64 (standard or URL-safe, with or without padding) to bytes.
 * @param {string} input
 * @returns {Uint8Array}
 */
export function base64ToBytes(input) {
  const normalized = String(input ?? "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!normalized) return new Uint8Array(0);
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** @param {string} text @returns {string} */
export function utf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(String(text ?? "")));
}

/** @param {string} input @returns {string} */
export function base64ToUtf8(input) {
  return new TextDecoder().decode(base64ToBytes(input));
}

/**
 * @param {Uint8Array} bytes
 * @param {string} [separator]
 * @returns {string}
 */
export function bytesToHex(bytes, separator = "") {
  if (!bytes || !bytes.length) return "";
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (i ? separator : "") + bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** @param {string} hex @returns {Uint8Array} */
export function hexToBytes(hex) {
  const clean = String(hex ?? "").replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Lossy UTF-8 decoding — never throws, replaces invalid sequences.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeUtf8(bytes) {
  if (!bytes || !bytes.length) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Classic `hexdump -C` style dump with offsets and an ASCII gutter.
 * @param {Uint8Array} bytes
 * @param {{ width?: number }} [options]
 * @returns {string}
 */
export function hexdump(bytes, options = {}) {
  if (!bytes || !bytes.length) return "";
  const width = options.width ?? 16;
  const half = Math.floor(width / 2);
  const lines = [];

  for (let offset = 0; offset < bytes.length; offset += width) {
    const row = bytes.subarray(offset, offset + width);
    const groups = [];
    for (let i = 0; i < width; i += 1) {
      groups.push(i < row.length ? row[i].toString(16).padStart(2, "0") : "  ");
    }
    const hex = `${groups.slice(0, half).join(" ")}  ${groups.slice(half).join(" ")}`.padEnd(
      width * 3 + 1,
      " "
    );
    let ascii = "";
    for (const byte of row) ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
  }

  return lines.join("\n");
}

/**
 * `strings(1)`-like extraction: runs of printable ASCII at least `minLength` long.
 * Useful to peek inside binary protocols (SMB/LDAP/Responder payloads).
 * @param {Uint8Array} bytes
 * @param {{ minLength?: number, encoding?: string }} [options]
 * @returns {string[]}
 */
export function extractStrings(bytes, options = {}) {
  const minLength = options.minLength ?? 4;
  if (!bytes || !bytes.length) return [];
  const text = decodeUtf8(bytes);
  const found = [];
  let current = "";

  for (const char of text) {
    const code = char.codePointAt(0);
    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    if (printable) {
      current += char;
    } else {
      if (current.length >= minLength) found.push(current);
      current = "";
    }
  }
  if (current.length >= minLength) found.push(current);
  return found;
}

/**
 * True when the payload is mostly human readable (used to pick a text preview).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function looksTextual(bytes) {
  if (!bytes || !bytes.length) return true;
  const sample = bytes.subarray(0, 512);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f)) {
      printable += 1;
    }
  }
  return printable / sample.length > 0.85;
}

/**
 * Constant-time-ish string comparison used for nothing security critical today,
 * but keeps the intent explicit if secrets are compared later.
 * @param {string} a @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/** @param {{length:number}} arrayLike @param {string} [encoding] */
export function truncateText(value, max = 400) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
