/**
 * Popup controller: session dashboard with search, filters, bulk actions,
 * import/export and live updates from the service worker.
 */

import { MAX_SESSIONS, MESSAGE } from "../core/constants.js";
import { createSessionDraft } from "../core/generator.js";
import { utf8ToBase64 } from "../core/encoding.js";
import { sessionMatchesQuery, sessionState } from "../core/models.js";
import {
  countSessions,
  deleteLogs,
  deleteSession,
  exportPayload,
  importPayload,
  listSessions,
  parseImportText,
  saveSession
} from "../core/repository.js";
import { getSettings, updateSettings } from "../core/settings.js";
import {
  copyToClipboard,
  debounce,
  downloadText,
  escapeHtml,
  formatRelative,
  qs,
  qsa
} from "./dom.js";
import { icon } from "./icons.js";
import { confirmDialog } from "./modal.js";
import { bindThemeToggle, initTheme } from "./theme.js";
import { toastError, toastInfo, toastSuccess } from "./toast.js";

const state = {
  sessions: [],
  query: "",
  filter: "all",
  sort: "updated",
  selected: new Set()
};

const dom = {};

/** @param {string} selector */
function cache(selector) {
  dom[selector] = qs(selector);
  return dom[selector];
}

async function main() {
  [
    "#sessionList",
    "#countBadge",
    "#search",
    "#sortSelect",
    "#bulkBar",
    "#selectedCount",
    "#hintText",
    "#importFile",
    "#addBtn",
    "#startSelected",
    "#stopSelected",
    "#deleteSelected",
    "#clearSelection",
    "#exportBtn",
    "#importBtn",
    "#optionsBtn"
  ].forEach(cache);

  await initTheme();
  bindThemeToggle();

  const settings = await getSettings();
  state.sort = settings.sortMode;
  dom["#sortSelect"].value = settings.sortMode;
  dom["#hintText"].textContent = `опрос: ${settings.pollIntervalSec} с`;

  bindEvents();
  await refresh();
  chrome.runtime.sendMessage({ type: MESSAGE.CLEAR_UNREAD }).catch(() => {});
  chrome.runtime.sendMessage({ type: MESSAGE.ENSURE_ALARM }).catch(() => {});
  window.setInterval(() => refresh().catch(() => {}), 15000);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

async function refresh() {
  state.sessions = await listSessions({ sort: state.sort });
  render();
}

function visibleSessions() {
  return state.sessions.filter((session) => {
    if (!sessionMatchesQuery(session, state.query)) return false;
    const status = sessionState(session);
    if (state.filter === "active") return status === "polling";
    if (state.filter === "error") return status === "error";
    return true;
  });
}

function render() {
  const total = state.sessions.length;
  dom["#countBadge"].textContent = `${total} / ${MAX_SESSIONS}`;
  dom["#countBadge"].className = total >= MAX_SESSIONS ? "badge badge--warn" : "badge";

  // Drop selections that no longer exist.
  const ids = new Set(state.sessions.map((session) => session.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  renderBulkBar();

  const sessions = visibleSessions();
  if (!sessions.length) {
    dom["#sessionList"].innerHTML = emptyStateHtml(total);
    return;
  }
  dom["#sessionList"].innerHTML = sessions.map(sessionCardHtml).join("");
}

function renderBulkBar() {
  const count = state.selected.size;
  dom["#bulkBar"].hidden = count === 0;
  dom["#selectedCount"].textContent = String(count);
}

function emptyStateHtml(total) {
  if (total === 0) {
    return `<div class="empty-state">
      ${icon("radio", { size: 30 })}
      <div><b>Пока нет сессий</b></div>
      <div class="small">Создайте сессию, чтобы получить публичный URL для проверки OAST-взаимодействий.</div>
      <button class="btn" data-action="add">${icon("plus")}Создать сессию</button>
    </div>`;
  }
  return `<div class="empty-state">
    ${icon("search", { size: 26 })}
    <div><b>Ничего не найдено</b></div>
    <div class="small">Измените запрос или фильтр.</div>
    <button class="btn btn--secondary" data-action="reset-filters">Сбросить</button>
  </div>`;
}

/**
 * @param {object} session
 * @returns {string}
 */
function sessionCardHtml(session) {
  const status = sessionState(session);
  const isSelected = state.selected.has(session.id);
  const dot =
    status === "polling"
      ? '<span class="dot dot--ok dot--live"></span>'
      : status === "error"
        ? '<span class="dot dot--danger"></span>'
        : '<span class="dot"></span>';
  const host = String(session.publicUrl || "").replace(/^https?:\/\//, "");
  const hits = session.interactionCount || 0;

  return `<article class="session-card ${status === "polling" ? "session-card--active" : ""} ${
    status === "error" ? "session-card--error" : ""
  }" data-session-id="${escapeHtml(session.id)}">
    <div class="session-card__head">
      <label class="session-card__check" title="Выбрать">
        <input type="checkbox" data-action="select" ${isSelected ? "checked" : ""} aria-label="Выбрать сессию" />
      </label>
      <span class="session-card__name" data-action="open" title="Открыть сессию">${escapeHtml(
        session.name
      )}</span>
      ${dot}
      <span class="badge ${status === "polling" ? "badge--ok" : status === "error" ? "badge--danger" : ""}">${
        status === "polling" ? "ON" : status === "error" ? "ERR" : "OFF"
      }</span>
    </div>
    <div class="session-card__url">${icon("link", { size: 12 })}<span title="${escapeHtml(
      session.publicUrl
    )}">${escapeHtml(host)}</span></div>
    <div class="session-card__meta">
      <span>${icon("clock", { size: 11 })} ${escapeHtml(
        session.lastPollAt ? formatRelative(session.lastPollAt) : "не опрашивалась"
      )}</span>
      <span class="${hits ? "hit" : ""}">${icon("activity", { size: 11 })} ${hits}</span>
      ${
        session.lastStatus ? `<span class="mono">HTTP ${escapeHtml(session.lastStatus)}</span>` : ""
      }
    </div>
    ${
      status === "error" && session.lastError
        ? `<div class="session-card__error" title="${escapeHtml(session.lastError)}">${escapeHtml(
            session.lastError.slice(0, 140)
          )}</div>`
        : ""
    }
    <div class="session-card__actions">
      <button class="btn btn--secondary" data-action="open">${icon("external", {
        size: 13
      })}Открыть</button>
      <button class="btn btn--secondary" data-action="copy-url" title="Скопировать публичный URL">${icon(
        "copy",
        { size: 13 }
      )}URL</button>
      <button class="btn btn--secondary" data-action="toggle">${icon(
        status === "polling" ? "stop" : "play",
        { size: 12 }
      )}${status === "polling" ? "Stop" : "Start"}</button>
      <button class="icon-btn" data-action="delete" title="Удалить сессию">${icon("trash", {
        size: 15
      })}</button>
    </div>
  </article>`;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  dom["#search"].addEventListener(
    "input",
    debounce((event) => {
      state.query = event.target.value;
      render();
    }, 120)
  );

  dom["#sortSelect"].addEventListener("change", async (event) => {
    state.sort = event.target.value;
    await updateSettings({ sortMode: state.sort });
    await refresh();
  });

  for (const button of qsa("[data-filter]")) {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      for (const other of qsa("[data-filter]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      render();
    });
  }

  dom["#sessionList"].addEventListener("click", onListClick);
  dom["#sessionList"].addEventListener("change", onListChange);
  dom["#addBtn"].addEventListener("click", createSession);
  dom["#startSelected"].addEventListener("click", () => bulkToggle(true));
  dom["#stopSelected"].addEventListener("click", () => bulkToggle(false));
  dom["#deleteSelected"].addEventListener("click", bulkDelete);
  dom["#clearSelection"].addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  dom["#exportBtn"].addEventListener("click", exportSessions);
  dom["#importBtn"].addEventListener("click", () => dom["#importFile"].click());
  dom["#importFile"].addEventListener("change", importSessions);
  dom["#optionsBtn"].addEventListener("click", () => chrome.runtime.openOptionsPage());

  document.addEventListener("keydown", onKeyDown);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === MESSAGE.LOGS_ADDED || message.type === MESSAGE.SESSIONS_UPDATED) {
      debouncedRefresh();
    }
  });
}

const debouncedRefresh = debounce(() => refresh().catch(() => {}), 250);

function onKeyDown(event) {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (event.key === "/" && !typing) {
    event.preventDefault();
    dom["#search"].focus();
  } else if ((event.key === "n" || event.key === "N" || event.key === "т") && !typing) {
    event.preventDefault();
    createSession();
  } else if (event.key === "Escape") {
    if (state.query) {
      state.query = "";
      dom["#search"].value = "";
      render();
    }
  }
}

function findSession(element) {
  const card = element.closest?.("[data-session-id]");
  if (!card) return null;
  return state.sessions.find((session) => session.id === card.dataset.sessionId) ?? null;
}

async function onListClick(event) {
  const actionElement = event.target.closest("[data-action]");
  const action = actionElement?.dataset.action;

  if (action === "add") return createSession();
  if (action === "reset-filters") {
    state.query = "";
    state.filter = "all";
    dom["#search"].value = "";
    for (const button of qsa("[data-filter]")) {
      button.setAttribute("aria-pressed", String(button.dataset.filter === "all"));
    }
    return render();
  }
  if (action === "select") return; // handled by change

  const session = findSession(event.target);
  if (!session) return;

  if (action === "open") return openSession(session.id);
  if (action === "copy-url") {
    const ok = await copyToClipboard(session.publicUrl);
    return ok ? toastSuccess("Публичный URL скопирован") : toastError("Не удалось скопировать");
  }
  if (action === "copy-config") {
    const config = {
      id: session.id,
      name: session.name,
      keyB64: session.keyB64,
      publicUrl: session.publicUrl,
      privateUrl: session.privateUrl,
      active: session.active,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    };
    const ok = await copyToClipboard(utf8ToBase64(JSON.stringify(config)));
    return ok ? toastSuccess("Конфигурация скопирована") : toastError("Не удалось скопировать");
  }
  if (action === "toggle") return toggleSession(session, !session.active);
  if (action === "delete") return removeSession(session);
}

function onListChange(event) {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action !== "select") return;
  const session = findSession(event.target);
  if (!session) return;
  if (event.target.checked) state.selected.add(session.id);
  else state.selected.delete(session.id);
  renderBulkBar();
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

function openSession(id) {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`html/session.html?id=${encodeURIComponent(id)}`)
  });
}

async function createSession() {
  const total = await countSessions();
  if (total >= MAX_SESSIONS) {
    toastError(`Достигнут лимит: ${MAX_SESSIONS} сессий`);
    return;
  }
  try {
    const settings = await getSettings();
    const draft = await createSessionDraft({ host: settings.defaultHost });
    const saved = await saveSession(draft);
    await refresh();
    toastSuccess(`Сессия «${saved.name}» создана`);
    chrome.runtime.sendMessage({ type: MESSAGE.ENSURE_ALARM }).catch(() => {});
  } catch (error) {
    toastError(error?.message || String(error));
  }
}

async function toggleSession(session, active) {
  await saveSession({ ...session, active, nextAttemptAt: 0 });
  if (active) {
    chrome.runtime.sendMessage({ type: MESSAGE.POLL_ONE, sessionId: session.id }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({ type: MESSAGE.SYNC_NOW }).catch(() => {});
  }
  await refresh();
  toastInfo(active ? "Polling запущен" : "Polling остановлен");
}

async function bulkToggle(active) {
  const ids = [...state.selected];
  if (!ids.length) return;
  for (const id of ids) {
    const session = state.sessions.find((item) => item.id === id);
    if (session) await saveSession({ ...session, active, nextAttemptAt: 0 });
  }
  await refresh();
  toastInfo(`${active ? "Запущено" : "Остановлено"}: ${ids.length}`);
  if (active) chrome.runtime.sendMessage({ type: MESSAGE.SYNC_NOW }).catch(() => {});
}

async function removeSession(session) {
  const ok = await confirmDialog({
    title: `Удалить «${session.name}»?`,
    message: "Сессия и все её логи будут удалены без возможности восстановления.",
    confirmText: "Удалить",
    danger: true
  });
  if (!ok) return;
  await deleteLogs(session.id);
  await deleteSession(session.id);
  state.selected.delete(session.id);
  await refresh();
  toastSuccess("Сессия удалена");
}

async function bulkDelete() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: `Удалить ${ids.length} сессий?`,
    message: "Логи всех выбранных сессий будут потеряны.",
    confirmText: "Удалить",
    danger: true
  });
  if (!ok) return;
  for (const id of ids) {
    await deleteLogs(id);
    await deleteSession(id);
  }
  state.selected.clear();
  await refresh();
  toastSuccess(`Удалено сессий: ${ids.length}`);
}

async function exportSessions() {
  const payload = await exportPayload();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadText(`colaborator-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json");
  toastSuccess(`Экспортировано сессий: ${payload.sessions.length}, логов: ${payload.logs.length}`);
}

async function importSessions(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = parseImportText(await file.text());
    const result = await importPayload(payload, { mode: "merge" });
    await refresh();
    chrome.runtime.sendMessage({ type: MESSAGE.SYNC_NOW }).catch(() => {});
    toastSuccess(
      `Импорт: сессий ${result.sessions}, логов ${result.logs}` +
        (result.skippedSessions ? `, пропущено ${result.skippedSessions}` : "")
    );
  } catch (error) {
    toastError(error?.message || String(error));
  }
}

main().catch((error) => {
  console.error("[popup] init failed", error);
  toastError(`Ошибка запуска: ${error?.message || error}`);
});
