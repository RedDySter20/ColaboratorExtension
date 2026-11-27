/**
 * Session workspace controller: session list, interaction log, inspector,
 * polling controls, exports and keyboard navigation.
 */

import { LOG_PAGE_SIZE, MAX_SESSIONS, MESSAGE } from "../core/constants.js";
import { createSessionDraft } from "../core/generator.js";
import { logMatchesQuery, sessionMatchesQuery, sessionState } from "../core/models.js";
import { describeInteraction, quickSummary } from "../core/protocol.js";
import { generateReport, reportFileName } from "../core/report.js";
import {
  deleteLogs,
  deleteSession,
  getSession,
  listLogs,
  listSessions,
  saveSession
} from "../core/repository.js";
import { getSettings } from "../core/settings.js";
import {
  copyToClipboard,
  debounce,
  downloadText,
  escapeHtml,
  formatBytes,
  formatDateTime,
  formatRelative,
  formatTime,
  qs,
  qsa
} from "./dom.js";
import { renderHexdump, renderPrintable, renderStrings } from "./hexview.js";
import { icon } from "./icons.js";
import { confirmDialog } from "./modal.js";
import { ensureOriginPermission } from "./permissions.js";
import { bindThemeToggle, initTheme } from "./theme.js";
import { toastError, toastInfo, toastSuccess } from "./toast.js";

const state = {
  sessionId: new URLSearchParams(location.search).get("id"),
  session: null,
  sessions: [],
  sessionsQuery: "",
  logs: [],
  logQuery: "",
  protocol: "",
  visible: LOG_PAGE_SIZE,
  selectedLogId: null,
  target: "request",
  mode: "text",
  keyVisible: false,
  autoRefresh: true,
  nameDirty: false,
  drawerOpen: false
};

const dom = {};
const cache = (selector) => (dom[selector] ??= qs(selector));

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  await initTheme();
  bindThemeToggle();

  cacheDom();
  bindEvents();

  await loadSessions();
  if (!state.sessionId) state.sessionId = state.sessions[0]?.id ?? null;

  if (!state.sessionId) {
    renderEmptyWorkspace();
    return;
  }

  await loadSession();
  await loadLogs();
  renderAll();

  chrome.runtime.sendMessage({ type: MESSAGE.ENSURE_ALARM }).catch(() => {});
  chrome.runtime.sendMessage({ type: MESSAGE.CLEAR_UNREAD }).catch(() => {});

  const settings = await getSettings();
  if (settings.pollOnOpen && state.session) {
    chrome.runtime
      .sendMessage({ type: MESSAGE.POLL_ONE, sessionId: state.session.id })
      .catch(() => {});
  }

  window.setInterval(async () => {
    if (!state.autoRefresh || !state.sessionId) return;
    await refreshQuietly();
  }, 5000);
}

function cacheDom() {
  [
    "#sessionList",
    "#sessionSearch",
    "#sessionName",
    "#statusBadge",
    "#sessionMeta",
    "#publicUrl",
    "#privateUrl",
    "#secretKey",
    "#errorBanner",
    "#togglePoll",
    "#logFilter",
    "#protocolFilter",
    "#logCount",
    "#logList",
    "#logsMore",
    "#loadMore",
    "#autoRefresh",
    "#inspector",
    "#inspectorBackdrop",
    "#inspProtocol",
    "#inspTime",
    "#inspSummary",
    "#inspFields",
    "#inspViews",
    "#inspPayload",
    "#saveName",
    "#revealKey",
    "#editPublicUrl",
    "#editPrivateUrl",
    "#editSecret",
    "#saveAdvanced"
  ].forEach(cache);
}

/* -------------------------------------------------------------------------- */
/* Data loading                                                               */
/* -------------------------------------------------------------------------- */

async function loadSessions() {
  state.sessions = await listSessions({ sort: "updated" });
}

async function loadSession() {
  state.session = await getSession(state.sessionId);
  if (state.session) return;

  // The session was deleted in another tab — fall back to the first available one.
  const fallback = state.sessions.find((session) => session.id !== state.sessionId) ?? null;
  if (fallback) {
    state.sessionId = fallback.id;
    state.session = await getSession(fallback.id);
    history.replaceState(null, "", `?id=${encodeURIComponent(fallback.id)}`);
  }
}

async function loadLogs() {
  if (!state.sessionId) return;
  const { items } = await listLogs(state.sessionId);
  state.logs = items;
}

async function refreshQuietly() {
  const previousCount = state.logs.length;
  await Promise.all([loadSessions(), loadSession(), loadLogs()]);
  renderSidebar();
  renderHeader();
  renderLogs({ keepScroll: true });
  if (state.logs.length !== previousCount && state.selectedLogId) renderInspector();
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderLogs();
  if (!state.selectedLogId && state.logs.length) {
    selectLog(state.logs[0].id, { openDrawer: false });
    return;
  }
  renderInspector();
}

function renderEmptyWorkspace() {
  cache("#sessionList").innerHTML = '<div class="empty-state small">Нет сессий</div>';
  cache("#logList").innerHTML = `<div class="empty-state">
    ${icon("radio", { size: 28 })}
    <div><b>Нет активной сессии</b></div>
    <div class="small">Создайте сессию, чтобы начать собирать взаимодействия.</div>
    <button class="btn" data-action="new-session">${icon("plus")}Создать сессию</button>
  </div>`;
  cache("#sessionName").value = "";
  cache("#publicUrl").textContent = "—";
  cache("#privateUrl").textContent = "—";
  cache("#secretKey").textContent = "—";
  cache("#sessionMeta").textContent = "—";
  cache("#statusBadge").textContent = "—";
}

function renderSidebar() {
  const container = cache("#sessionList");
  const sessions = state.sessions.filter((session) =>
    sessionMatchesQuery(session, state.sessionsQuery)
  );

  if (!sessions.length) {
    container.innerHTML = `<div class="empty-state small">${
      state.sessions.length ? "Ничего не найдено" : "Сессий пока нет"
    }</div>`;
    return;
  }

  container.innerHTML = sessions
    .map((session) => {
      const status = sessionState(session);
      const dot =
        status === "polling"
          ? '<span class="dot dot--ok"></span>'
          : status === "error"
            ? '<span class="dot dot--danger"></span>'
            : '<span class="dot"></span>';
      const host = String(session.publicUrl || "").replace(/^https?:\/\//, "");
      return `<div class="session-item ${session.id === state.sessionId ? "is-active" : ""}" data-id="${escapeHtml(
        session.id
      )}" role="button" tabindex="0">
        <div class="session-item__name">${dot}<span>${escapeHtml(session.name)}</span></div>
        <div class="session-item__sub" title="${escapeHtml(host)}">${escapeHtml(host)}</div>
        <div class="session-item__meta">
          <span>${session.interactionCount || 0} находок</span>
          <span>${escapeHtml(session.lastPollAt ? formatRelative(session.lastPollAt) : "—")}</span>
        </div>
      </div>`;
    })
    .join("");
}

function renderHeader() {
  const session = state.session;
  if (!session) return renderEmptyWorkspace();

  if (!state.nameDirty) cache("#sessionName").value = session.name;
  cache("#publicUrl").textContent = session.publicUrl || "—";
  cache("#privateUrl").textContent = session.privateUrl || "—";
  cache("#secretKey").textContent = state.keyVisible
    ? session.keyB64 || "—"
    : maskSecret(session.keyB64);

  const status = sessionState(session);
  const badge = cache("#statusBadge");
  badge.textContent =
    status === "polling" ? "polling: ON" : status === "error" ? "ошибка" : "polling: OFF";
  badge.className = `badge ${
    status === "polling" ? "badge--ok" : status === "error" ? "badge--danger" : ""
  }`;

  cache("#togglePoll").textContent = session.active ? "Stop" : "Start";
  cache("#togglePoll").className = `btn ${session.active ? "btn--secondary" : ""}`;

  const parts = [
    `Создана: ${formatDateTime(session.createdAt)}`,
    `Последний опрос: ${session.lastPollAt ? formatRelative(session.lastPollAt) : "—"}`,
    `Всего находок: ${session.interactionCount || 0}`
  ];
  if (session.lastStatus) parts.push(`HTTP ${session.lastStatus}`);
  cache("#sessionMeta").textContent = parts.join(" · ");

  const banner = cache("#errorBanner");
  if (session.lastError) {
    banner.hidden = false;
    banner.textContent = `Ошибка опроса: ${session.lastError}`;
  } else {
    banner.hidden = true;
  }

  if (!cache("#advanced").open) {
    cache("#editPublicUrl").value = session.publicUrl || "";
    cache("#editPrivateUrl").value = session.privateUrl || "";
    cache("#editSecret").value = session.secret || "";
  }

  document.title = `${session.name} — Colaborator`;
  renderProtocolFilter();
}

async function saveAdvanced() {
  if (!state.session) return;
  const publicUrl = cache("#editPublicUrl").value.trim();
  const privateUrl = cache("#editPrivateUrl").value.trim();
  const secret = cache("#editSecret").value.trim();

  for (const [label, value] of [
    ["Public URL", publicUrl],
    ["Private URL", privateUrl]
  ]) {
    try {
      new URL(value);
    } catch {
      toastError(`${label}: некорректный URL`);
      return;
    }
  }

  const allowed = await ensureOriginPermission(privateUrl);
  if (!allowed) {
    toastError("Браузер не выдал разрешение на этот домен — опрос не сработает");
    return;
  }

  state.session = await saveSession({ ...state.session, publicUrl, privateUrl, secret });
  await loadSessions();
  renderSidebar();
  renderHeader();
  toastSuccess("Параметры сессии сохранены");
}

function maskSecret(keyB64) {
  const value = String(keyB64 || "");
  if (value.length <= 12) return value || "—";
  return `${value.slice(0, 6)}${"•".repeat(12)}${value.slice(-4)}`;
}

function filteredLogs() {
  return state.logs.filter((log) => {
    if (state.protocol && log.protocol !== state.protocol) return false;
    return logMatchesQuery(log, state.logQuery);
  });
}

function renderLogs(options = {}) {
  const container = cache("#logList");
  const scrollTop = options.keepScroll ? container.scrollTop : 0;
  const logs = filteredLogs();
  cache("#logCount").textContent = `${logs.length} / ${state.logs.length}`;

  if (!logs.length) {
    container.innerHTML = `<div class="empty-state">
      ${icon(state.logs.length ? "filter" : "radio", { size: 26 })}
      <div><b>${state.logs.length ? "Ничего не найдено" : "Взаимодействий пока нет"}</b></div>
      <div class="small">${
        state.logs.length
          ? "Измените фильтр или протокол."
          : "Отправьте публичный URL в уязвимый параметр и нажмите «Проверить»."
      }</div>
    </div>`;
    cache("#logsMore").hidden = true;
    return;
  }

  const visible = logs.slice(0, state.visible);
  container.innerHTML = visible
    .map((log) => {
      const { protocol, summary } = quickSummary(log);
      const isNew = state.session && log.ts > (state.session.lastPollAt || 0);
      return `<button type="button" class="log-row ${
        log.id === state.selectedLogId ? "is-selected" : ""
      }" data-log-id="${escapeHtml(log.id)}">
        <span class="log-row__time">${escapeHtml(formatTime(log.ts))}</span>
        <span><span class="tag tag--${escapeHtml(protocol)}">${escapeHtml(protocol)}</span></span>
        <span class="log-row__summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}${
          isNew ? '<span class="log-row__new"></span>' : ""
        }</span>
        <span class="log-row__client" title="${escapeHtml(log.client)}">${escapeHtml(log.client)}</span>
      </button>`;
    })
    .join("");

  const more = cache("#logsMore");
  const remaining = logs.length - visible.length;
  more.hidden = remaining <= 0;
  if (remaining > 0) {
    cache("#loadMore").textContent = `Показать ещё (${remaining})`;
  }
  container.scrollTop = scrollTop;
}

function renderProtocolFilter() {
  const select = cache("#protocolFilter");
  const counts = new Map();
  for (const log of state.logs) counts.set(log.protocol, (counts.get(log.protocol) || 0) + 1);
  const options = [
    `<option value="">Все протоколы (${state.logs.length})</option>`,
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([protocol, count]) =>
          `<option value="${escapeHtml(protocol)}">${escapeHtml(protocol)} (${count})</option>`
      )
  ];
  const previous = state.protocol;
  select.innerHTML = options.join("");
  select.value = previous;
  if (select.value !== previous) {
    state.protocol = "";
    select.value = "";
  }
}

function selectedLog() {
  return state.logs.find((log) => log.id === state.selectedLogId) ?? null;
}

function renderInspector(options = {}) {
  const log = selectedLog();
  const views = cache("#inspViews");
  const fields = cache("#inspFields");

  if (!log) {
    cache("#inspProtocol").textContent = "—";
    cache("#inspProtocol").className = "tag";
    cache("#inspTime").textContent = "";
    cache("#inspSummary").textContent = "Выберите взаимодействие из списка";
    fields.innerHTML = "";
    views.hidden = true;
    return;
  }

  const described = describeInteraction(log);
  cache("#inspProtocol").textContent = described.protocol;
  cache("#inspProtocol").className = `tag tag--${described.protocol}`;
  cache("#inspTime").textContent = formatDateTime(log.ts);
  cache("#inspSummary").textContent = described.summary;

  fields.innerHTML = described.fields
    .map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`)
    .join("");

  views.hidden = false;
  renderPayload(described);
  if (options.openInspector !== false) openDrawer();
}

function renderPayload(described) {
  const container = cache("#inspPayload");
  const payload = described[state.target === "response" ? "response" : "request"];

  for (const button of qsa("#inspTarget [data-target]")) {
    button.setAttribute("aria-pressed", String(button.dataset.target === state.target));
  }
  for (const button of qsa("#inspMode [data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  }

  if (!payload || payload.empty) {
    container.innerHTML = `<div class="muted small">${
      state.target === "response" ? "Ответ не сохранён сервером" : "Запрос пуст"
    }</div>`;
    return;
  }

  if (state.mode === "hex") container.innerHTML = renderHexdump(payload.bytes);
  else if (state.mode === "strings") container.innerHTML = renderStrings(payload.strings);
  else container.innerHTML = `<div class="byteview">${renderPrintable(payload.bytes)}</div>`;

  const size = `<div class="hint small" style="margin-bottom:6px">${formatBytes(payload.size)}</div>`;
  container.insertAdjacentHTML("afterbegin", size);
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

function selectLog(id, options = {}) {
  state.selectedLogId = id;
  for (const row of qsa(".log-row")) row.classList.toggle("is-selected", row.dataset.logId === id);
  renderInspector({ openInspector: options.openDrawer !== false });
}

async function togglePolling() {
  if (!state.session) return;
  const active = !state.session.active;
  await saveSession({ ...state.session, active, nextAttemptAt: 0 });
  await loadSession();
  renderHeader();
  if (active) {
    chrome.runtime
      .sendMessage({ type: MESSAGE.POLL_ONE, sessionId: state.session.id })
      .catch(() => {});
    toastInfo("Polling запущен");
  } else {
    toastInfo("Polling остановлен");
  }
}

async function pollNow() {
  if (!state.session) return;
  toastInfo("Запрашиваю сервер…");
  const response = await chrome.runtime
    .sendMessage({ type: MESSAGE.POLL_ONE, sessionId: state.session.id })
    .catch(() => null);
  await refreshQuietly();
  if (response?.ok) {
    toastSuccess(
      response.added ? `Новых взаимодействий: ${response.added}` : "Новых взаимодействий нет"
    );
  } else if (state.session?.lastError) {
    toastError(state.session.lastError);
  } else {
    toastError(response?.error || "Не удалось опросить сервер");
  }
}

async function testInteraction() {
  if (!state.session) return;
  const response = await chrome.runtime
    .sendMessage({ type: MESSAGE.TEST_INTERACTION, sessionId: state.session.id })
    .catch(() => null);
  if (!response?.ok) {
    toastError(response?.error || "Не удалось отправить тестовый запрос");
    return;
  }
  toastInfo("Тестовый запрос отправлен — результат появится через несколько секунд");
  window.setTimeout(() => refreshQuietly().catch(() => {}), 7000);
}

async function saveName() {
  if (!state.session) return;
  const value = cache("#sessionName").value.trim();
  if (!value) {
    toastError("Имя не может быть пустым");
    return;
  }
  state.session = await saveSession({ ...state.session, name: value });
  state.nameDirty = false;
  cache("#saveName").hidden = true;
  await loadSessions();
  renderSidebar();
  toastSuccess("Имя сохранено");
}

async function clearLogs() {
  if (!state.session) return;
  const ok = await confirmDialog({
    title: "Очистить логи сессии?",
    message: `Будет удалено взаимодействий: ${state.logs.length}. Действие необратимо.`,
    confirmText: "Очистить"
  });
  if (!ok) return;
  await deleteLogs(state.session.id);
  state.selectedLogId = null;
  await loadLogs();
  renderLogs();
  renderInspector();
  renderHeader();
  toastSuccess("Логи очищены");
}

async function removeSession() {
  if (!state.session) return;
  const ok = await confirmDialog({
    title: `Удалить «${state.session.name}»?`,
    message: "Сессия и все взаимодействия будут удалены без возможности восстановления.",
    confirmText: "Удалить"
  });
  if (!ok) return;

  const id = state.session.id;
  await deleteLogs(id);
  await deleteSession(id);
  await loadSessions();
  const next = state.sessions[0];
  if (next) {
    state.sessionId = next.id;
    state.selectedLogId = null;
    history.replaceState(null, "", `?id=${encodeURIComponent(next.id)}`);
    await loadSession();
    await loadLogs();
    renderAll();
  } else {
    location.href = chrome.runtime.getURL("html/popup.html");
  }
  toastSuccess("Сессия удалена");
}

async function createSession() {
  if (state.sessions.length >= MAX_SESSIONS) {
    toastError(`Достигнут лимит: ${MAX_SESSIONS} сессий`);
    return;
  }
  const settings = await getSettings();
  const draft = await createSessionDraft({ host: settings.defaultHost });
  const saved = await saveSession(draft);
  await loadSessions();
  switchSession(saved.id);
  toastSuccess(`Сессия «${saved.name}» создана`);
}

async function switchSession(id) {
  if (!id) return;
  state.sessionId = id;
  state.selectedLogId = null;
  state.visible = LOG_PAGE_SIZE;
  history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
  await loadSession();
  await loadLogs();
  renderAll();
}

function exportReport() {
  if (!state.session) return;
  const markdown = generateReport({
    sessions: [state.session],
    logs: filteredLogs(),
    generatedAt: Date.now(),
    version: chrome.runtime.getManifest().version
  });
  downloadText(reportFileName(), markdown, "text/markdown;charset=utf-8");
  toastSuccess("Отчёт сохранён");
}

function exportJson() {
  if (!state.session) return;
  const payload = {
    format: "colaborator-extension",
    version: 2,
    exportedAt: Date.now(),
    sessions: [state.session],
    logs: state.logs
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadText(
    `colaborator-session-${stamp}.json`,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
  toastSuccess("JSON сохранён");
}

async function copyField(field) {
  if (!state.session) return;
  const value = state.session[field] ?? "";
  const ok = await copyToClipboard(value);
  ok ? toastSuccess("Скопировано") : toastError("Буфер обмена недоступен");
}

async function copyPayload(part) {
  const log = selectedLog();
  if (!log) return;
  const base64 = state.target === "response" ? log.responseB64 : log.requestB64;
  let value = base64;
  if (part === "hex") {
    const described = describeInteraction(log);
    value = described[state.target].hex ?? "";
  } else if (part === "json") {
    value = JSON.stringify(log, null, 2);
  }
  if (!value) {
    toastError("Нечего копировать");
    return;
  }
  const ok = await copyToClipboard(value);
  ok ? toastSuccess("Скопировано") : toastError("Буфер обмена недоступен");
}

/* -------------------------------------------------------------------------- */
/* Drawer (narrow screens)                                                    */
/* -------------------------------------------------------------------------- */

function openDrawer() {
  if (window.matchMedia("(max-width: 1100px)").matches) {
    cache("#inspector").classList.add("is-open");
    cache("#inspectorBackdrop").classList.add("is-open");
    state.drawerOpen = true;
  }
}

function closeDrawer() {
  cache("#inspector").classList.remove("is-open");
  cache("#inspectorBackdrop").classList.remove("is-open");
  state.drawerOpen = false;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  cache("#sessionList").addEventListener("click", (event) => {
    if (event.target.closest('[data-action="new-session"]')) return createSession();
    const item = event.target.closest("[data-id]");
    if (item) switchSession(item.dataset.id);
  });

  cache("#sessionList").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const item = event.target.closest("[data-id]");
    if (item) switchSession(item.dataset.id);
  });

  cache("#sessionSearch").addEventListener(
    "input",
    debounce((event) => {
      state.sessionsQuery = event.target.value;
      renderSidebar();
    }, 120)
  );

  cache("#newSessionBtn").addEventListener("click", createSession);
  cache("#backBtn").addEventListener("click", () => {
    location.href = chrome.runtime.getURL("html/popup.html");
  });
  cache("#optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  cache("#togglePoll").addEventListener("click", togglePolling);
  cache("#pollNow").addEventListener("click", pollNow);
  cache("#testInteraction").addEventListener("click", testInteraction);
  cache("#deleteSessionBtn").addEventListener("click", removeSession);
  cache("#clearLogs").addEventListener("click", clearLogs);
  cache("#exportReport").addEventListener("click", exportReport);
  cache("#exportJson").addEventListener("click", exportJson);

  cache("#saveAdvanced").addEventListener("click", () => {
    saveAdvanced().catch((error) => toastError(error?.message || String(error)));
  });

  cache("#revealKey").addEventListener("click", () => {
    state.keyVisible = !state.keyVisible;
    renderHeader();
  });

  cache("#refreshLogs").addEventListener("click", async () => {
    await refreshQuietly();
    toastInfo("Список обновлён");
  });

  cache("#saveName").addEventListener("click", saveName);
  cache("#sessionName").addEventListener("input", () => {
    state.nameDirty = true;
    cache("#saveName").hidden = false;
  });
  cache("#sessionName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveName();
    if (event.key === "Escape") {
      state.nameDirty = false;
      cache("#saveName").hidden = true;
      cache("#sessionName").value = state.session?.name ?? "";
    }
  });
  cache("#sessionName").addEventListener("blur", () => {
    if (!state.nameDirty) return;
    if (cache("#sessionName").value.trim() === state.session?.name) {
      state.nameDirty = false;
      cache("#saveName").hidden = true;
    }
  });

  cache("#logFilter").addEventListener(
    "input",
    debounce((event) => {
      state.logQuery = event.target.value;
      state.visible = LOG_PAGE_SIZE;
      renderLogs();
    }, 130)
  );

  cache("#protocolFilter").addEventListener("change", (event) => {
    state.protocol = event.target.value;
    state.visible = LOG_PAGE_SIZE;
    renderLogs();
  });

  cache("#autoRefresh").addEventListener("change", (event) => {
    state.autoRefresh = event.target.checked;
  });

  cache("#loadMore").addEventListener("click", () => {
    state.visible += LOG_PAGE_SIZE;
    renderLogs({ keepScroll: true });
  });

  cache("#logList").addEventListener("click", (event) => {
    if (event.target.closest('[data-action="new-session"]')) return createSession();
    const row = event.target.closest("[data-log-id]");
    if (row) selectLog(row.dataset.logId);
  });

  for (const button of qsa("#inspTarget [data-target]")) {
    button.addEventListener("click", () => {
      state.target = button.dataset.target;
      const log = selectedLog();
      if (log) renderPayload(describeInteraction(log));
    });
  }

  for (const button of qsa("#inspMode [data-mode]")) {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      const log = selectedLog();
      if (log) renderPayload(describeInteraction(log));
    });
  }

  for (const button of qsa("[data-copy-part]")) {
    button.addEventListener("click", () => copyPayload(button.dataset.copyPart));
  }

  for (const button of qsa("[data-copy]")) {
    button.addEventListener("click", () => copyField(button.dataset.copy));
  }

  cache("#inspClose").addEventListener("click", () => {
    state.selectedLogId = null;
    for (const row of qsa(".log-row")) row.classList.remove("is-selected");
    renderInspector();
    closeDrawer();
  });
  cache("#inspectorBackdrop").addEventListener("click", closeDrawer);

  document.addEventListener("keydown", onKeyDown);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;
    if (
      message.type === MESSAGE.LOGS_ADDED ||
      message.type === MESSAGE.SESSIONS_UPDATED ||
      message.type === MESSAGE.POLL_FINISHED
    ) {
      debouncedRefresh();
    }
  });
}

const debouncedRefresh = debounce(() => {
  refreshQuietly().catch(() => {});
}, 300);

function onKeyDown(event) {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

  if (event.key === "Escape") {
    if (state.drawerOpen) closeDrawer();
    else if (state.selectedLogId) {
      state.selectedLogId = null;
      for (const row of qsa(".log-row")) row.classList.remove("is-selected");
      renderInspector();
    }
    return;
  }
  if (typing) return;

  if (event.key === "/") {
    event.preventDefault();
    cache("#logFilter").focus();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    moveSelection(-1);
  }
}

function moveSelection(delta) {
  const logs = filteredLogs().slice(0, state.visible);
  if (!logs.length) return;
  const current = logs.findIndex((log) => log.id === state.selectedLogId);
  const next = current < 0 ? 0 : Math.min(logs.length - 1, Math.max(0, current + delta));
  selectLog(logs[next].id);
  document.querySelector(`[data-log-id="${CSS.escape(logs[next].id)}"]`)?.scrollIntoView({
    block: "nearest"
  });
}

main().catch((error) => {
  console.error("[session] init failed", error);
  toastError(`Ошибка запуска: ${error?.message || error}`);
});
