/**
 * Inline SVG icon set (stroke based, inherits currentColor).
 * Kept as a tiny module instead of an icon font: no network, no CSP issues.
 */

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4.5 4.5"/>',
  play: '<path d="M6 4.5 19 12 6 19.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  external:
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  refresh:
    '<path d="M21 4v6h-6"/><path d="M3 20v-6h6"/><path d="M20.5 9A9 9 0 0 0 5 5.5L3 9"/><path d="M3.5 15A9 9 0 0 0 19 18.5l2-3.5"/>',
  settings:
    '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 9v5M12 17.5v.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 3 3-2 2-2-2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 7 7 8 4-1 7-4 7-8V6z"/><path d="m9 12 2 2 4-4"/>',
  radio:
    '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="m7 10 3 2-3 2M13 14h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'
};

/**
 * @param {keyof typeof PATHS|string} name
 * @param {{ size?: number, className?: string, strokeWidth?: number }} [options]
 * @returns {string} SVG markup
 */
export function icon(name, options = {}) {
  const path = PATHS[name] ?? PATHS.info;
  const size = options.size ?? 16;
  const stroke = options.strokeWidth ?? 1.7;
  const className = options.className ? ` class="${options.className}"` : "";
  const filled = name === "play" || name === "stop" || name === "bolt";
  return `<svg${className} width="${size}" height="${size}" viewBox="0 0 24 24" fill="${
    filled ? "currentColor" : "none"
  }" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
