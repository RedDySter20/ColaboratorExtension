/**
 * Optional gzip packing for log payloads.
 *
 * The storage format intentionally keeps the v1 field names (`requestB64Zip`,
 * `rawZip`, `zipCodec: "gzip-base64-v1"`) so databases created by v1.x keep
 * working after the upgrade and can still be read by older builds.
 */

const ZIP_CODEC = "gzip-base64-v1";
/** Payloads shorter than this are stored verbatim — compression would only add noise. */
const COMPRESS_THRESHOLD = 256;

/** @returns {boolean} */
export function compressionSupported() {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function readStream(stream) {
  const response = new Response(stream);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {string} text
 * @returns {Promise<string>} base64 of the gzip stream, "" when unsupported
 */
export async function gzipBase64(text) {
  if (!compressionSupported() || !text) return "";
  const bytes = new TextEncoder().encode(String(text));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const packed = await readStream(stream);
  let binary = "";
  for (const byte of packed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {Promise<string>} "" when the payload cannot be inflated
 */
export async function gunzipBase64(base64) {
  if (!compressionSupported() || !base64) return "";
  try {
    const binary = atob(String(base64).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new TextDecoder().decode(await readStream(stream));
  } catch {
    return "";
  }
}

const PACKED_FIELDS = [
  ["requestB64", "requestB64Zip"],
  ["responseB64", "responseB64Zip"],
  ["raw", "rawZip"]
];

/**
 * Compress the heavy fields of a log record before it hits IndexedDB.
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function encodeLogForStorage(log) {
  const record = { ...log };
  if (!compressionSupported()) return record;

  let packed = false;
  for (const [field, zipField] of PACKED_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length > COMPRESS_THRESHOLD) {
      const zipped = await gzipBase64(value);
      if (zipped && zipped.length < value.length) {
        record[zipField] = zipped;
        record[field] = "";
        packed = true;
      }
    }
  }
  if (packed) record.zipCodec = ZIP_CODEC;
  return record;
}

/**
 * Inverse of {@link encodeLogForStorage}. Tolerates v1 records and plain records.
 * @param {object} record
 * @returns {Promise<object>}
 */
export async function decodeLogFromStorage(record) {
  if (!record) return record;
  const log = { ...record };
  if (log.zipCodec !== ZIP_CODEC) return log;

  for (const [field, zipField] of PACKED_FIELDS) {
    if (!log[field] && log[zipField]) {
      log[field] = await gunzipBase64(log[zipField]);
    }
    delete log[zipField];
  }
  delete log.zipCodec;
  return log;
}
