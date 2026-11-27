/**
 * Cryptography and the OAST identifier scheme.
 *
 * The identifier algorithm is byte-compatible with the reference implementation
 * used by interactsh / Burp Collaborator clients:
 *
 *   key (32 random bytes)
 *     └─ SHA-1 → base36 → pad to 30 → "correlation id" (22 chars)
 *          └─ rolling base36 Vigenère cipher over `<cid>1g<counter:hex>yz`
 *               └─ 2 random chars + 1 checksum char + ciphertext = subdomain label
 *
 * Compatibility is pinned by tests/fixtures/golden.json, generated from v1.3.3.7.
 */

import { bytesToBase64, base64ToBytes, bytesToHex, hexToBytes } from "./encoding.js";

export const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RADIX = 36n;
/** Maps an ASCII code to its base36 value, -1 when the char is not in the alphabet. */
const CHAR_INDEX = buildCharIndex();

function buildCharIndex() {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  for (let i = 0; i < 26; i += 1) table[65 + i] = i; // uppercase mirrors lowercase
  return table;
}

/** @param {number} code ASCII code point @returns {number} 0..35 or -1 */
export function charIndex(code) {
  return code >= 0 && code < 128 ? CHAR_INDEX[code] : -1;
}

/** @param {Uint8Array|number[]} bytes @returns {bigint} */
export function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

/**
 * Big-endian unsigned integer → base36 string.
 * @param {bigint} value
 * @param {number} [padTo]
 * @returns {string}
 */
export function bigIntToBase36(value, padTo = 0) {
  let result = "";
  let rest = value;
  while (rest > 0n) {
    result = ALPHABET[Number(rest % RADIX)] + result;
    rest /= RADIX;
  }
  return result.padStart(padTo, "0");
}

/**
 * Derive the 22 character correlation id from the 32 byte session key.
 * @param {Uint8Array} keyBytes
 * @returns {Promise<string>}
 */
export async function correlationIdFromKey(keyBytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", keyBytes));
  const base36 = bigIntToBase36(bytesToBigInt(digest), 30);
  const truncated = base36.slice(0, 20);
  const left = truncated.slice(0, 10);
  const right = truncated.slice(10, 20);
  return `${left}${checksumChar(left)}${right}${checksumChar(right)}`;
}

/** @param {string} chunk @returns {string} */
function checksumChar(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 1) sum += chunk.charCodeAt(i);
  return ALPHABET[sum % 36];
}

/**
 * Rolling base36 cipher. The two key characters also act as the evolving
 * keystream: after each step the key byte is replaced by the emitted character.
 * @param {number[]} keyCodes two ASCII codes from ALPHABET
 * @param {string} plaintext letters/digits only
 * @returns {string}
 */
export function encodeLabel(keyCodes, plaintext) {
  if (!Array.isArray(keyCodes) || keyCodes.length !== 2) {
    throw new TypeError("encodeLabel expects exactly two key codes");
  }
  const seed = keyCodes.slice();
  const data = new TextEncoder().encode(String(plaintext));
  let out = "";

  for (let i = 0; i < data.length; i += 1) {
    const plainIndex = charIndex(data[i]);
    const keyIndex = charIndex(seed[i % 2]);
    if (plainIndex < 0 || keyIndex < 0) {
      throw new Error(`encodeLabel: character out of alphabet at position ${i}`);
    }
    const value = (plainIndex + keyIndex) % 36;
    const char = ALPHABET[value];
    out += char;
    seed[i % 2] = char.charCodeAt(0);
  }

  return out;
}

/** Uniform random integer in [0, 36) using the platform CSPRNG. */
export function secureRandom36() {
  const buffer = new Uint8Array(1);
  // Rejection sampling keeps the distribution uniform (256 % 36 = 4).
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < 252) return buffer[0] % 36;
  }
}

/**
 * Build the interaction subdomain label.
 * @param {string} correlationId 22 chars
 * @param {number} count interaction counter (hex encoded in the payload)
 * @param {{ random36?: () => number }} [options]
 * @returns {string}
 */
export function interactionLabel(correlationId, count, options = {}) {
  const random36 = options.random36 ?? secureRandom36;
  const first = ALPHABET[random36() % 36];
  const second = ALPHABET[random36() % 36];
  const check = ALPHABET[(first.charCodeAt(0) + second.charCodeAt(0)) % 36];
  const payload = `${correlationId}1g${Number(count).toString(16)}yz`;
  return `${first}${second}${check}${encodeLabel([first.charCodeAt(0), second.charCodeAt(0)], payload)}`;
}

/** @param {number} [size] @returns {Uint8Array} */
export function randomKeyBytes(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Validate and normalise a base64 encoded 256-bit key.
 * @param {string} keyB64
 * @returns {Uint8Array}
 */
export function normalizeKeyB64(keyB64) {
  const bytes = base64ToBytes(keyB64);
  if (bytes.length !== 32) {
    throw new Error("Secret key must decode to exactly 32 bytes.");
  }
  return bytes;
}

/** @param {Uint8Array} bytes @returns {string} */
export function keyToBase64(bytes) {
  return bytesToBase64(bytes);
}

// ---------------------------------------------------------------------------
// AES-CTR helper used for interactsh-style encrypted poll payloads.
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {Promise<Uint8Array>}
 */
export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * interactsh encrypts poll payloads with AES-256-CTR, key = SHA-256(secret),
 * and the first 16 bytes of the payload are the IV.
 * @param {Uint8Array} payload
 * @param {string} secret
 * @returns {Promise<Uint8Array>}
 */
export async function decryptInteractshPayload(payload, secret) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length <= 16) throw new Error("Encrypted payload is too short");
  const keyBytes = await sha256(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, [
    "decrypt"
  ]);
  const iv = bytes.subarray(0, 16);
  const ciphertext = bytes.subarray(16);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: iv, length: 128 },
    key,
    ciphertext
  );
  return new Uint8Array(plain);
}

export { bytesToHex, hexToBytes };
