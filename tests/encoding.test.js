import test from "node:test";
import assert from "node:assert/strict";

import {
  base64ToBytes,
  base64ToUtf8,
  bytesToBase64,
  bytesToHex,
  decodeUtf8,
  extractStrings,
  hexToBytes,
  hexdump,
  looksTextual,
  timingSafeEqual,
  truncateText,
  utf8ToBase64
} from "../src/js/core/encoding.js";

test("base64 round-trips binary data", () => {
  const bytes = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
  const encoded = bytesToBase64(bytes);
  assert.equal(base64ToBytes(encoded).length, bytes.length);
  assert.deepEqual([...base64ToBytes(encoded)], [...bytes]);
});

test("base64 handles large payloads without stack overflow", () => {
  const bytes = new Uint8Array(300_000).fill(65);
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded.length, 400_000);
  assert.equal(base64ToBytes(encoded).length, 300_000);
});

test("base64 accepts URL-safe alphabet and missing padding", () => {
  const bytes = hexToBytes("fbff3e");
  const standard = bytesToBase64(bytes);
  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.deepEqual([...base64ToBytes(urlSafe)], [...bytes]);
});

test("utf8 helpers round-trip cyrillic text", () => {
  const text = "Привет, OAST! 🚀";
  assert.equal(base64ToUtf8(utf8ToBase64(text)), text);
});

test("hex helpers are symmetric", () => {
  assert.equal(bytesToHex(hexToBytes("00ff10"), " "), "00 ff 10");
  assert.equal(bytesToHex(new Uint8Array(0)), "");
  assert.deepEqual([...hexToBytes("00:ff:10")], [0, 255, 16]);
});

test("hexdump renders offsets, hex bytes and an ASCII gutter", () => {
  const dump = hexdump(new TextEncoder().encode("Hello world!"));
  const lines = dump.split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^00000000 {2}48 65 6c 6c 6f 20 77 6f {2}72 6c 64 21/);
  assert.match(lines[0], /\|Hello world!\|$/);
});

test("hexdump continues offsets every 16 bytes", () => {
  const dump = hexdump(new Uint8Array(20).fill(0x41));
  const lines = dump.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^00000000/);
  assert.match(lines[1], /^00000010/);
});

test("extractStrings finds printable runs", () => {
  const bytes = new TextEncoder().encode("hello\u0000world!\u0001ab");
  assert.deepEqual(extractStrings(bytes), ["hello", "world!"]);
});

test("looksTextual distinguishes text from binary", () => {
  assert.equal(looksTextual(new TextEncoder().encode("GET / HTTP/1.1\r\n")), true);
  assert.equal(looksTextual(new Uint8Array([0, 1, 2, 3, 0, 5, 0, 7])), false);
  assert.equal(looksTextual(new Uint8Array(0)), true);
});

test("decodeUtf8 never throws on invalid sequences", () => {
  assert.equal(typeof decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41])), "string");
});

test("timingSafeEqual and truncateText behave", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
  assert.equal(truncateText("abcdef", 3), "abc…");
  assert.equal(truncateText("ab", 3), "ab");
});
