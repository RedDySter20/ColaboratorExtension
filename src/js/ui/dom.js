/**
 * DOM utilities shared by all pages: escaping, selection, formatting, clipboard
 * and file download. No framework, no build step.
 */

/**
 * @param {unknown} value
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @template {Element} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T|null}
 */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * @template {Element} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T[]}
 */
export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * @param {Element|Window|Document} target
 * @param {string} type
 * @param {(event: any) => void} handler
 * @param {AddEventListenerOptions} [options]
 * @returns {() => void} unsubscribe
 */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * @param {number} ms
 * @returns {string} e.g. "12 с", "3 мин", "2 ч"
 */
export function formatRelative(ms) {
  const timestamp = Number(ms);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const delta = Date.now() - timestamp;
  if (delta < 0) return "только что";
  const seconds = Math.round(delta / 1000);
  if (seconds < 10) return "только что";
  if (seconds < 60) return `${seconds} с назад`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return new Date(timestamp).toLocaleDateString("ru-RU");
}

/**
 * @param {number} ts
 * @returns {string} date + time, locale aware
 */
export function formatDateTime(ts) {
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

/**
 * @param {number} ts
 * @returns {string} HH:MM:SS
 */
export function formatTime(ts) {
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("ru-RU", { hour12: false });
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Copy text to the clipboard, with a textarea fallback for older contexts.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * @param {string} filename
 * @param {string} content
 * @param {string} [mime]
 */
export function downloadText(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * @template {(...args:any[]) => any} F
 * @param {F} fn
 * @param {number} wait
 * @returns {F}
 */
export function debounce(fn, wait = 150) {
  let timer = 0;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * @param {string} tag
 * @param {object} [attributes]
 * @param {(Node|string)[]} [children]
 * @returns {HTMLElement}
 */
export function createEl(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "html") element.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value != null) {
      element.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

/**
 * Copy text and report the result through a callback.
 * @param {string} text
 * @param {(ok: boolean, text: string) => void} [notify]
 * @returns {Promise<boolean>}
 */
export async function copyAndNotify(text, notify) {
  const ok = await copyToClipboard(text);
  notify?.(ok, text);
  return ok;
}
