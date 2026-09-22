/**
 * Shared date helpers — single source of truth for server (worker ESM
 * import) and client (served as classic `window.YTUtils` bundle).
 * Pure functions, no DOM, no network. `?.` optional chaining is used;
 * supported by Workers and all modern browsers.
 */

/**
 * New-York-midnight "today" used for Today/Yesterday relative labels.
 * @returns {Date}
 */
export function getNowInNewYork() {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });
    const parts = formatter.formatToParts(new Date());
    const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026', 10);
    const month = parseInt(parts.find(p => p.type === 'month')?.value || '9', 10) - 1;
    const day = parseInt(parts.find(p => p.type === 'day')?.value || '6', 10);
    return new Date(year, month, day);
  } catch (e) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
}

/**
 * Parse YMD, MDY, or anything Date.parse accepts. Null when unparseable.
 * @param {string} str
 * @returns {Date|null}
 */
export function parseLocalDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  const ymd = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) {
    return new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
  }
  const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (mdy) {
    return new Date(parseInt(mdy[3], 10), parseInt(mdy[1], 10) - 1, parseInt(mdy[2], 10));
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  return null;
}

/**
 * Display date: Today / Yesterday / "Month D, YYYY". Pass-through when
 * unparseable.
 * @param {string} rawDateStr
 * @returns {string}
 */
export function formatShiurDate(rawDateStr) {
  if (!rawDateStr) return '';
  const trimmed = String(rawDateStr).trim();
  if (trimmed === 'Today' || trimmed === 'Yesterday') return trimmed;

  const d = parseLocalDate(trimmed);
  if (!d || isNaN(d.getTime())) return trimmed;

  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nyMidnight = getNowInNewYork().getTime();
  const diffDays = Math.round((nyMidnight - dMidnight) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return monthNames[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

/**
 * NEW badge predicate: within one day either side of NY today.
 * @param {string} rawDateStr
 * @returns {boolean}
 */
export function isShiurNew(rawDateStr) {
  if (!rawDateStr) return false;
  const trimmed = String(rawDateStr).trim();
  if (trimmed === 'Today' || trimmed === 'Yesterday') return true;
  const d = parseLocalDate(trimmed);
  if (!d || isNaN(d.getTime())) return false;
  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nyMidnight = getNowInNewYork().getTime();
  const diffDays = Math.round((nyMidnight - dMidnight) / 86400000);
  return diffDays <= 1 && diffDays >= -1;
}
