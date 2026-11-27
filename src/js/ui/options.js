/**
 * Options page: settings, storage statistics, import/export and host permissions.
 */

import {
  MAX_MAX_LOGS,
  MAX_POLL_INTERVAL_SEC,
  MIN_MAX_LOGS,
  MIN_POLL_INTERVAL_SEC
} from "../core/constants.js";
import { generateReport, reportFileName } from "../core/report.js";
import {
  clearAllData,
  exportPayload,
  getStats,
  importPayload,
  parseImportText
} from "../core/repository.js";
import { DEFAULT_SETTINGS, getSettings, resetSettings, updateSettings } from "../core/settings.js";
import { downloadText, escapeHtml, qs } from "./dom.js";
import { confirmDialog } from "./modal.js";
import { appVersion, applyTheme, bindThemeToggle, initTheme } from "./theme.js";
import { toastError, toastSuccess } from "./toast.js";

const dom = {};
const cache = (selector) => (dom[selector] ??= qs(selector));

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

async function renderSettings() {
  const settings = await getSettings();
  cache("#pollInterval").value = String(settings.pollIntervalSec);
  cache("#maxLogs").value = String(settings.maxLogsPerSession);
  cache("#pollOnOpen").checked = settings.pollOnOpen;
  cache("#autoResume").checked = settings.autoResume;
  cache("#notifications").checked = settings.notifications;
  cache("#themeSelect").value = settings.theme;
  cache("#defaultHost").value = settings.defaultHost;
}

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 * @param {string} [message]
 */
async function save(patch, message = "Сохранено") {
  const settings = await updateSettings(patch);
  await renderSettings();
  toastSuccess(message);
  return settings;
}

function bindSettings() {
  cache("#pollInterval").addEventListener("change", (event) => {
    const value = Number.parseInt(event.target.value, 10);
    if (value < MIN_POLL_INTERVAL_SEC || value > MAX_POLL_INTERVAL_SEC) {
      toastError(`Интервал должен быть от ${MIN_POLL_INTERVAL_SEC} до ${MAX_POLL_INTERVAL_SEC} с`);
      renderSettings();
      return;
    }
    save({ pollIntervalSec: value }, "Интервал опроса обновлён");
  });

  cache("#maxLogs").addEventListener("change", (event) => {
    const value = Number.parseInt(event.target.value, 10);
    if (value < MIN_MAX_LOGS || value > MAX_MAX_LOGS) {
      toastError(`Хранить можно от ${MIN_MAX_LOGS} до ${MAX_MAX_LOGS} логов`);
      renderSettings();
      return;
    }
    save({ maxLogsPerSession: value }, "Лимит логов обновлён");
  });

  cache("#pollOnOpen").addEventListener("change", (event) =>
    save({ pollOnOpen: event.target.checked })
  );
  cache("#autoResume").addEventListener("change", (event) =>
    save({ autoResume: event.target.checked })
  );
  cache("#notifications").addEventListener("change", (event) =>
    save({ notifications: event.target.checked })
  );

  cache("#themeSelect").addEventListener("change", async (event) => {
    const settings = await save({ theme: event.target.value }, "Тема обновлена");
    const { applyTheme } = await import("./theme.js");
    applyTheme(settings.theme);
  });

  cache("#defaultHost").addEventListener("change", (event) => {
    const value = String(event.target.value || "").trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) {
      toastError("Укажите домен, например oastify.com");
      renderSettings();
      return;
    }
    save({ defaultHost: value }, "Домен по умолчанию обновлён");
  });
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

async function renderStats() {
  const stats = await getStats();
  cache("#statSessions").textContent = String(stats.sessions);
  cache("#statActive").textContent = String(stats.activeSessions);
  cache("#statLogs").textContent = String(stats.logs);
  cache("#statSize").textContent = formatSize(stats.approxBytes);
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

function bindData() {
  cache("#refreshStatsBtn").addEventListener("click", async () => {
    await renderStats();
    toastSuccess("Статистика обновлена");
  });

  cache("#exportAllBtn").addEventListener("click", async () => {
    const payload = await exportPayload();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadText(
      `colaborator-backup-${stamp}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    toastSuccess(`Экспортировано: сессий ${payload.sessions.length}, логов ${payload.logs.length}`);
  });

  cache("#exportReportBtn").addEventListener("click", async () => {
    const payload = await exportPayload();
    const markdown = generateReport({
      sessions: payload.sessions,
      logs: payload.logs,
      generatedAt: Date.now(),
      version: appVersion()
    });
    downloadText(reportFileName(), markdown, "text/markdown;charset=utf-8");
    toastSuccess("Отчёт сохранён");
  });

  cache("#importBtn").addEventListener("click", () => cache("#importFile").click());
  cache("#importFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const mode = cache("#importMode").value;
    if (mode === "replace") {
      const ok = await confirmDialog({
        title: "Заменить все данные?",
        message: "Текущие сессии и логи будут удалены перед импортом.",
        confirmText: "Заменить"
      });
      if (!ok) return;
    }

    try {
      const payload = parseImportText(await file.text());
      const result = await importPayload(payload, { mode });
      await renderStats();
      toastSuccess(
        `Импорт: сессий ${result.sessions}, логов ${result.logs}` +
          (result.skippedSessions ? `, пропущено сессий: ${result.skippedSessions}` : "")
      );
    } catch (error) {
      toastError(error?.message || String(error));
    }
  });

  cache("#clearAllBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Удалить все данные?",
      message: "Все сессии и все логи будут удалены без возможности восстановления.",
      confirmText: "Удалить всё"
    });
    if (!ok) return;
    await clearAllData();
    await renderStats();
    toastSuccess("Все данные удалены");
  });

  cache("#resetSettingsBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Сбросить настройки?",
      message: "Параметры вернутся к значениям по умолчанию. Данные не пострадают.",
      confirmText: "Сбросить",
      danger: false
    });
    if (!ok) return;
    await resetSettings();
    await renderSettings();
    applyTheme(DEFAULT_SETTINGS.theme);
    toastSuccess("Настройки сброшены");
  });
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

async function renderPermissions() {
  const badge = cache("#permState");
  try {
    const granted = await chrome.permissions.contains({ origins: ["https://*/*"] });
    badge.textContent = granted ? "разрешено" : "только *.oastify.com";
    badge.className = `badge ${granted ? "badge--ok" : ""}`;
  } catch {
    badge.textContent = "недоступно";
    badge.className = "badge badge--warn";
  }
}

function bindPermissions() {
  cache("#requestPermBtn").addEventListener("click", async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ["https://*/*"] });
      await renderPermissions();
      granted
        ? toastSuccess("Разрешение выдано для https://*")
        : toastError("Разрешение не выдано");
    } catch (error) {
      toastError(error?.message || String(error));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  await initTheme();
  bindThemeToggle();

  cache("#appVersion").textContent = appVersion();
  cache("#aboutText").innerHTML =
    `Colaborator ${escapeHtml(appVersion())} — OAST-дашборд для авторизованного тестирования. ` +
    "Поддерживает Burp Collaborator-совместимые серверы и self-hosted interactsh.";

  await renderSettings();
  await renderStats();
  await renderPermissions();

  bindSettings();
  bindData();
  bindPermissions();

  cache("#openDashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("html/popup.html") });
  });

  // Keep the numbers fresh if polling is running in the background.
  window.setInterval(() => renderStats().catch(() => {}), 10000);
}

main().catch((error) => {
  console.error("[options] init failed", error);
  toastError(`Ошибка запуска: ${error?.message || error}`);
});
