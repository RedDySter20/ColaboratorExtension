/**
 * Promise-based confirmation modal — replaces `window.confirm()` so the UI stays
 * consistent and keyboard accessible.
 */

import { escapeHtml } from "./dom.js";
import { icon } from "./icons.js";

/**
 * @param {{
 *   title: string,
 *   message?: string,
 *   confirmText?: string,
 *   cancelText?: string,
 *   danger?: boolean,
 *   details?: string
 * }} options
 * @returns {Promise<boolean>} true when confirmed
 */
export function confirmDialog(options) {
  const {
    title,
    message = "",
    confirmText = "Подтвердить",
    cancelText = "Отмена",
    danger = true,
    details = ""
  } = options;

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${escapeHtml(title)}</h2>
        ${message ? `<p>${escapeHtml(message)}</p>` : ""}
        ${details ? `<pre class="payload small" style="margin-top:12px">${escapeHtml(details)}</pre>` : ""}
        <div class="modal__actions">
          <button type="button" class="btn btn--secondary" data-cancel>${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${danger ? "btn--danger" : ""}" data-confirm>${
            danger ? icon("trash") : icon("check")
          }${escapeHtml(confirmText)}</button>
        </div>
      </div>`;

    const previouslyFocused = document.activeElement;
    const finish = (value) => {
      document.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };

    backdrop.querySelector("[data-cancel]").addEventListener("click", () => finish(false));
    backdrop.querySelector("[data-confirm]").addEventListener("click", () => finish(true));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(false);
    });
    document.addEventListener("keydown", onKeyDown, true);

    document.body.appendChild(backdrop);
    backdrop.querySelector("[data-confirm]").focus();
  });
}
