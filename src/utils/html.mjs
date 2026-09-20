/**
 * Shared HTML escaping — single source of truth for server (worker ESM
 * import) and client (served as classic `window.YTUtils` bundle, since
 * inline onclick strings require classic script scope).
 */

/**
 * Escape a value for safe interpolation into HTML text and attributes.
 * Escapes &, <, >, " and ' (attribute-safe).
 * @param {*} str value to escape
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
