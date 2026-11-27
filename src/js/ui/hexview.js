/**
 * Byte viewers: printable text with per-byte tooltips, offset hexdump and
 * printable-strings extraction.
 */

import { hexdump } from "../core/encoding.js";
import { escapeHtml } from "./dom.js";

const DEFAULT_LIMIT = 20000;

/**
 * Render bytes as text; every byte carries a `0xNN` tooltip, control characters
 * are replaced by a middle dot. Newlines are preserved.
 * @param {Uint8Array|null|undefined} bytes
 * @param {{ limit?: number }} [options]
 * @returns {string} HTML
 */
export function renderPrintable(bytes, options = {}) {
  if (!bytes || !bytes.length) return '<span class="muted">пусто</span>';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const slice = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  const encoder = new TextEncoder();
  const parts = [];
  let offset = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    const isReplacement = char === "\uFFFD";
    const width = isReplacement ? 1 : encoder.encode(char).length || 1;
    const raw = slice.subarray(offset, Math.min(offset + width, slice.length));
    offset += raw.length || 1;
    const hex = Array.from(raw)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");

    if (char === "\n") {
      parts.push("<br>");
      continue;
    }
    if (char === "\r") continue;
    if (char === "\t") {
      parts.push('<span class="byte-p" title="0x09">    </span>');
      continue;
    }

    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    parts.push(
      printable
        ? `<span class="byte-p" title="${hex}">${escapeHtml(char)}</span>`
        : `<span class="byte-np" title="${hex}">·</span>`
    );
  }

  if (bytes.length > slice.length) {
    parts.push(
      `<div class="muted small">… показаны первые ${slice.length} байт из ${bytes.length}</div>`
    );
  }
  return parts.join("");
}

/**
 * Offset hexdump with an ASCII gutter, coloured per part.
 * @param {Uint8Array|null|undefined} bytes
 * @returns {string} HTML
 */
export function renderHexdump(bytes) {
  if (!bytes || !bytes.length) return '<span class="muted">пусто</span>';
  const text = hexdump(bytes);
  const rows = text.split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{8}) {2}(.*?) \|(.*)\|$/);
    if (!match) return `<div>${escapeHtml(line)}</div>`;
    const [, offset, hex, ascii] = match;
    return `<div><span class="hex-offset">${offset}</span>  <span class="hex-bytes">${escapeHtml(
      hex
    )}</span>  <span class="hex-ascii">|${escapeHtml(ascii)}|</span></div>`;
  });
  return `<div class="hexdump">${rows.join("")}</div>`;
}

/**
 * @param {string[]} strings
 * @returns {string} HTML
 */
export function renderStrings(strings) {
  const list = (strings ?? []).filter(Boolean);
  if (!list.length) return '<span class="muted">нет печатных строк</span>';
  return list
    .slice(0, 40)
    .map((value) => `<div class="strings-row">${escapeHtml(value)}</div>`)
    .join("");
}

/**
 * Pretty JSON if possible, raw text otherwise.
 * @param {string} text
 * @returns {string} HTML
 */
export function renderPretty(text) {
  const value = String(text ?? "");
  if (!value) return '<span class="muted">пусто</span>';
  try {
    return `<pre class="payload">${escapeHtml(JSON.stringify(JSON.parse(value), null, 2))}</pre>`;
  } catch {
    return `<pre class="payload">${escapeHtml(value)}</pre>`;
  }
}
