/**
 * Markdown report generation — the artefact you actually paste into a pentest
 * report or a Jira ticket.
 */

import { describeInteraction } from "./protocol.js";

/**
 * @param {string} value
 * @returns {string} escaped for a Markdown table cell
 */
export function escapeTableCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>")
    .trim();
}

/**
 * @param {number|string} value
 * @returns {string} ISO-8601 in UTC
 */
export function formatTimestamp(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "—";
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Fenced code block that survives nested backticks.
 * @param {string} text
 * @param {string} [language]
 * @returns {string}
 */
function codeBlock(text, language = "") {
  const body = String(text ?? "").replace(/\r\n/g, "\n");
  const fence = body.includes("```") ? "````" : "```";
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * @param {object} session
 * @param {object[]} logs
 * @returns {string}
 */
export function generateSessionReport(session, logs) {
  const ordered = [...(logs ?? [])].sort((a, b) => a.ts - b.ts);
  const lines = [];
  lines.push(`## ${session?.name || session?.id || "Сессия"}`);
  lines.push("");
  lines.push(`- **Публичный URL:** \`${session?.publicUrl || "—"}\``);
  lines.push(`- **Приватный URL (polling):** \`${session?.privateUrl || "—"}\``);
  if (session?.keyB64) lines.push(`- **Ключ (base64):** \`${session.keyB64}\``);
  if (session?.createdAt) lines.push(`- **Создана:** ${formatTimestamp(session.createdAt)}`);
  lines.push(`- **Взаимодействий в отчёте:** ${ordered.length}`);
  if (session?.interactionCount && session.interactionCount > ordered.length) {
    lines.push(`- **Всего получено:** ${session.interactionCount}`);
  }
  lines.push("");

  if (!ordered.length) {
    lines.push("_Взаимодействий нет._");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| # | Время (UTC) | Протокол | Клиент | Краткое описание |");
  lines.push("|---|-------------|----------|--------|------------------|");
  ordered.forEach((log, index) => {
    const described = describeInteraction(log);
    lines.push(
      `| ${index + 1} | ${escapeTableCell(formatTimestamp(log.ts))} | ${escapeTableCell(
        described.protocol
      )} | ${escapeTableCell(log.client)} | ${escapeTableCell(described.summary)} |`
    );
  });
  lines.push("");

  const interesting = ordered.filter((log) => {
    const described = describeInteraction(log);
    return described.request.size > 0 || described.response.size > 0;
  });
  if (interesting.length) {
    lines.push("<details>");
    lines.push(`<summary>Сырые запросы/ответы (${interesting.length})</summary>`);
    lines.push("");
    interesting.forEach((log) => {
      const described = describeInteraction(log);
      lines.push(`### ${formatTimestamp(log.ts)} — ${described.protocol}`);
      lines.push("");
      if (described.request.size) {
        lines.push("**Запрос**");
        lines.push("");
        lines.push(
          codeBlock(
            described.request.isText ? described.request.text : described.request.hex,
            described.request.isText ? "http" : "text"
          )
        );
        lines.push("");
      }
      if (described.response.size) {
        lines.push("**Ответ**");
        lines.push("");
        lines.push(
          codeBlock(
            described.response.isText ? described.response.text : described.response.hex,
            described.response.isText ? "http" : "text"
          )
        );
        lines.push("");
      }
    });
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * @param {{ sessions: object[], logs: object[], generatedAt?: number, version?: string }} input
 * @returns {string}
 */
export function generateReport(input) {
  const sessions = input.sessions ?? [];
  const logs = input.logs ?? [];
  const generatedAt = input.generatedAt ?? Date.now();
  const bySession = new Map();
  for (const log of logs) {
    if (!bySession.has(log.sessionId)) bySession.set(log.sessionId, []);
    bySession.get(log.sessionId).push(log);
  }

  const lines = [];
  lines.push("# Colaborator — отчёт об OAST-взаимодействиях");
  lines.push("");
  lines.push(`Сформирован: ${formatTimestamp(generatedAt)}`);
  if (input.version) lines.push(`Версия расширения: ${input.version}`);
  lines.push("");
  lines.push(`- Сессий: **${sessions.length}**`);
  lines.push(`- Взаимодействий: **${logs.length}**`);
  lines.push("");

  const withLogs = sessions.filter((session) => (bySession.get(session.id) ?? []).length);
  const withoutLogs = sessions.filter((session) => !(bySession.get(session.id) ?? []).length);

  for (const session of withLogs) {
    lines.push(generateSessionReport(session, bySession.get(session.id)));
  }

  if (withoutLogs.length) {
    lines.push("## Сессии без взаимодействий");
    lines.push("");
    for (const session of withoutLogs) {
      lines.push(`- **${session.name}** — \`${session.publicUrl}\``);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "_Отчёт содержит данные, полученные от сервера коллаборации. Используйте их только в рамках авторизованного тестирования._"
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
export function reportFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return `colaborator-report-${stamp}.md`;
}
