/**
 * Protocol-aware decoding of OAST interactions.
 *
 * Collaborator servers return the raw bytes of whatever reached them (HTTP
 * request, DNS query, SMTP dialog, LDAP bind, …). This module turns those bytes
 * into something a human can read: a short summary, structured fields, a text
 * preview, printable-string extraction and an offset hex dump.
 */

import { base64ToBytes, decodeUtf8, extractStrings, hexdump, looksTextual } from "./encoding.js";

const DNS_TYPES = {
  1: "A",
  2: "NS",
  5: "CNAME",
  6: "SOA",
  10: "NULL",
  12: "PTR",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  35: "NAPTR",
  41: "OPT",
  43: "DS",
  46: "RRSIG",
  48: "DNSKEY",
  52: "TLSA",
  64: "SVCB",
  65: "HTTPS",
  255: "ANY",
  257: "CAA"
};

/** Headers that are usually interesting during a pentest. */
const INTERESTING_HEADER =
  /^(authorization|x-api-key|api-key|cookie|set-cookie|x-forwarded-for|x-auth-token|proxy-authorization|token|password|x-access-token)$/i;

/**
 * @param {string} base64
 * @returns {Uint8Array|null}
 */
export function decodeField(base64) {
  if (!base64) return null;
  try {
    const bytes = base64ToBytes(base64);
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Split an HTTP message into start line, headers and body.
 * @param {string} text
 * @returns {{ startLine: string, method: string, path: string, version: string, headers: {name:string,value:string}[], body: string }}
 */
export function parseHttpMessage(text) {
  const source = String(text ?? "");
  const separator = source.match(/\r?\n\r?\n/);
  const head = separator ? source.slice(0, separator.index) : source;
  const body = separator ? source.slice(separator.index + separator[0].length) : "";
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? "";
  const headers = [];

  for (const line of lines) {
    const index = line.indexOf(":");
    if (index > 0) {
      headers.push({ name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() });
    }
  }

  const requestLine = startLine.match(/^([A-Z][A-Z0-9-]*)\s+(\S+)(?:\s+HTTP\/([\d.]+))?$/);
  const statusLine = startLine.match(/^HTTP\/([\d.]+)\s+(\d{3})\s*(.*)$/);

  return {
    startLine,
    method: requestLine ? requestLine[1] : statusLine ? "HTTP" : "",
    path: requestLine ? requestLine[2] : "",
    version: requestLine?.[3] || statusLine?.[1] || "",
    statusCode: statusLine ? Number(statusLine[2]) : null,
    statusText: statusLine ? statusLine[3] : "",
    headers,
    body
  };
}

/**
 * Case-insensitive header lookup.
 * @param {{name:string,value:string}[]} headers
 * @param {string} name
 * @returns {string}
 */
export function headerValue(headers, name) {
  const needle = String(name).toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === needle)?.value ?? "";
}

/**
 * Parse a DNS wire-format query (what interactsh stores for `dns` interactions).
 * @param {Uint8Array} bytes
 * @returns {{ qname: string, qtype: number|null, qtypeName: string, id: number }|null}
 */
export function parseDnsQuery(bytes) {
  if (!bytes || bytes.length < 17) return null;
  const qdcount = (bytes[4] << 8) | bytes[5];
  if (qdcount < 1) return null;

  const labels = [];
  let offset = 12;
  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length === 0) {
      offset += 1;
      break;
    }
    // 0b11xxxxxx marks a compression pointer — not expected in a query.
    if (length > 63 || offset + 1 + length > bytes.length) return null;
    labels.push(decodeUtf8(bytes.subarray(offset + 1, offset + 1 + length)));
    offset += length + 1;
    if (labels.length > 24) return null;
  }
  if (!labels.length) return null;

  let qtype = null;
  if (offset + 2 <= bytes.length) qtype = (bytes[offset] << 8) | bytes[offset + 1];

  return {
    id: (bytes[0] << 8) | bytes[1],
    qname: labels.join("."),
    qtype,
    qtypeName: qtype != null ? (DNS_TYPES[qtype] ?? `TYPE${qtype}`) : ""
  };
}

/**
 * Extract `MAIL FROM` / `RCPT TO` from an SMTP dialog.
 * @param {string} text
 * @returns {{ mailFrom: string, rcptTo: string, subject: string }}
 */
export function parseSmtpDialog(text) {
  const source = String(text ?? "");
  const pick = (regex) => source.match(regex)?.[1]?.trim() ?? "";
  return {
    mailFrom: pick(/MAIL FROM:\s*<?([^>\r\n]*)>?/i),
    rcptTo: pick(/RCPT TO:\s*<?([^>\r\n]*)>?/i),
    subject: pick(/^Subject:\s*(.+)$/im)
  };
}

/**
 * @param {Uint8Array|null} bytes
 * @param {{ maxPreview?: number }} [options]
 * @returns {object}
 */
export function describePayload(bytes, options = {}) {
  if (!bytes || !bytes.length) {
    return {
      size: 0,
      empty: true,
      isText: true,
      text: "",
      preview: "",
      hex: "",
      strings: [],
      bytes: new Uint8Array(0)
    };
  }
  const maxPreview = options.maxPreview ?? 4000;
  const isText = looksTextual(bytes);
  const text = decodeUtf8(bytes);
  return {
    size: bytes.length,
    empty: false,
    isText,
    text,
    preview: text.length > maxPreview ? `${text.slice(0, maxPreview)}\n…` : text,
    hex: hexdump(bytes),
    strings: extractStrings(bytes.slice(0, 65536)),
    bytes
  };
}

/**
 * Best-effort protocol detection when the server does not label the interaction.
 * @param {Uint8Array|null} bytes
 * @returns {string}
 */
export function detectProtocol(bytes) {
  if (!bytes || !bytes.length) return "unknown";
  const head = decodeUtf8(bytes.subarray(0, 16));
  if (/^(GET|POST|PUT|HEAD|OPTIONS|PATCH|DELETE|TRACE|CONNECT)\s/.test(head)) return "http";
  if (/^(HELO|EHLO|MAIL FROM|RCPT TO|DATA)/i.test(head)) return "smtp";
  if (/^HTTP\/\d/.test(head)) return "http";
  if (bytes.length >= 12 && bytes[2] < 0x02 && bytes[4] === 0x00 && bytes[5] === 0x01) return "dns";
  return "unknown";
}

/**
 * Cheap summary for list rendering (no hexdump / string extraction).
 * @param {object} log
 * @returns {{ protocol: string, summary: string }}
 */
export function quickSummary(log) {
  const bytes = decodeField(log?.requestB64);
  let protocol = String(log?.protocol || "").toLowerCase();
  if (!protocol || protocol === "unknown") protocol = detectProtocol(bytes);
  const text = bytes ? decodeUtf8(bytes.subarray(0, 2048)) : "";
  const fallback = log?.interactionString || protocol;

  if (protocol.startsWith("http")) {
    const parsed = parseHttpMessage(text);
    if (parsed.method && parsed.path)
      return { protocol, summary: `${parsed.method} ${parsed.path}` };
    return { protocol, summary: parsed.startLine || fallback };
  }
  if (protocol === "dns") {
    const query = parseDnsQuery(bytes);
    return { protocol, summary: query?.qname || text.split(/\r?\n/)[0] || fallback };
  }
  if (protocol.startsWith("smtp")) {
    const mail = parseSmtpDialog(text);
    return { protocol, summary: mail.mailFrom ? `MAIL FROM ${mail.mailFrom}` : fallback };
  }

  // Binary dialogs (LDAP/SMB/…): prefer an extracted printable string, otherwise
  // report the size instead of showing replacement characters.
  if (!looksTextual(bytes)) {
    const printable = extractStrings(bytes.subarray(0, 4096)).find(
      (item) => item.trim().length >= 3
    );
    return {
      protocol,
      summary: printable?.trim() || `${protocol} · ${bytes.length} B (binary)`
    };
  }

  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 2);
  return { protocol, summary: firstLine?.trim() || fallback };
}

/**
 * Full description of one interaction, ready for rendering.
 * @param {object} log normalised log
 * @returns {{
 *   protocol: string,
 *   summary: string,
 *   fields: {label: string, value: string}[],
 *   request: object,
 *   response: object,
 *   strings: string[],
 *   hex: { request: string, response: string }
 * }}
 */
export function describeInteraction(log) {
  const requestBytes = decodeField(log?.requestB64);
  const responseBytes = decodeField(log?.responseB64);
  let protocol = String(log?.protocol || "").toLowerCase();
  if (!protocol || protocol === "unknown") protocol = detectProtocol(requestBytes);

  const request = describePayload(requestBytes);
  const response = describePayload(responseBytes);
  /** @type {{label: string, value: string}[]} */
  const fields = [];
  let summary = log?.interactionString || "";

  const addField = (label, value) => {
    const text = String(value ?? "").trim();
    if (text) fields.push({ label, value: text });
  };

  if (protocol.startsWith("http")) {
    const parsed = parseHttpMessage(request.text);
    if (parsed.method && parsed.path) summary = `${parsed.method} ${parsed.path}`;
    addField("Метод", parsed.method);
    addField("Путь", parsed.path);
    addField("Заголовок протокола", parsed.startLine);
    addField("Host", headerValue(parsed.headers, "host"));
    addField("User-Agent", headerValue(parsed.headers, "user-agent"));
    addField("Content-Type", headerValue(parsed.headers, "content-type"));
    addField("Content-Length", headerValue(parsed.headers, "content-length"));

    for (const header of parsed.headers) {
      if (INTERESTING_HEADER.test(header.name)) addField(header.name, header.value);
    }
    if (parsed.body) addField("Тело", parsed.body.slice(0, 2000));

    const status = parseHttpMessage(response.text);
    if (status.statusCode) {
      addField("Ответ", `${status.statusCode} ${status.statusText}`.trim());
      addField("Server", headerValue(status.headers, "server"));
    }
  } else if (protocol === "dns") {
    const query = parseDnsQuery(requestBytes);
    const textQuery = query?.qname || request.text.split(/\r?\n/)[0] || "";
    if (textQuery) summary = summary || textQuery;
    addField("Запрос", textQuery);
    addField("Тип записи", query?.qtypeName || log?.opCode || "");
    addField("Transaction ID", query ? String(query.id) : "");
  } else if (protocol.startsWith("smtp")) {
    const mail = parseSmtpDialog(request.text);
    if (mail.mailFrom) summary = `MAIL FROM ${mail.mailFrom}`;
    addField("MAIL FROM", mail.mailFrom);
    addField("RCPT TO", mail.rcptTo);
    addField("Subject", mail.subject);
  } else {
    const firstString = request.strings[0] || request.text.split(/\r?\n/)[0] || "";
    if (!summary && firstString) summary = firstString;
  }

  addField("Протокол", protocol);
  addField("Клиент", log?.client || "");
  addField("Interaction", log?.interactionString || "");
  if (request.size) addField("Размер запроса", `${request.size} B`);
  if (response.size) addField("Размер ответа", `${response.size} B`);
  addField("Ошибка", log?.error || "");

  return {
    protocol,
    summary: summary || `${protocol} interaction`,
    fields,
    request,
    response,
    strings: [...new Set([...request.strings, ...response.strings])].slice(0, 40),
    hex: { request: request.hex, response: response.hex }
  };
}

/**
 * One-line description used by reports and the log table.
 * @param {object} log
 * @returns {string}
 */
export function shortDescription(log) {
  const { summary, protocol } = describeInteraction(log);
  return `${protocol}: ${summary}`.replace(/\s+/g, " ").trim();
}
