/**
 * Optional host permissions helper.
 *
 * The extension ships with access to `*.oastify.com` only. Custom (self-hosted)
 * collaboration servers need an explicit grant — requested the first time the
 * user saves such a URL.
 */

/**
 * @param {string} url
 * @returns {string|null} origin such as `https://example.com`
 */
export function originOf(url) {
  try {
    const parsed = new URL(String(url));
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** @param {string} url @returns {boolean} */
export function isDefaultHost(url) {
  const origin = originOf(url);
  if (!origin) return false;
  const host = new URL(origin).hostname;
  return host === "oastify.com" || host.endsWith(".oastify.com");
}

/**
 * Make sure the extension may call `url`.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function ensureOriginPermission(url) {
  if (isDefaultHost(url)) return true;
  const origin = originOf(url);
  if (!origin) return false;

  try {
    const origins = [`${origin}/*`];
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}
