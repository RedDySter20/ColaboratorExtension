/**
 * Lightweight toast notifications (replaces blocking `alert()` calls).
 */

import { icon } from "./icons.js";
import { escapeHtml } from "./dom.js";

let stack = null;

function ensureStack() {
  if (stack && document.body.contains(stack)) return stack;
  stack = document.createElement("div");
  stack.className = "toast-stack";
  stack.setAttribute("role", "status");
  stack.setAttribute("aria-live", "polite");
  document.body.appendChild(stack);
  return stack;
}

/**
 * @param {string} message
 * @param {{ type?: "info"|"success"|"error", timeout?: number }} [options]
 * @returns {HTMLElement}
 */
export function toast(message, options = {}) {
  const type = options.type ?? "info";
  const timeout = options.timeout ?? (type === "error" ? 5200 : 3200);
  const host = ensureStack();

  const element = document.createElement("div");
  element.className = `toast toast--${type}`;
  element.innerHTML = `${icon(type === "success" ? "check" : type === "error" ? "alert" : "info")}<div class="toast__body">${escapeHtml(message)}</div>`;
  host.appendChild(element);

  const remove = () => {
    element.classList.add("toast--leaving");
    setTimeout(() => element.remove(), 180);
  };
  const timer = setTimeout(remove, timeout);
  element.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });

  return element;
}

export const toastSuccess = (message, options) => toast(message, { ...options, type: "success" });
export const toastError = (message, options) => toast(message, { ...options, type: "error" });
export const toastInfo = (message, options) => toast(message, { ...options, type: "info" });
