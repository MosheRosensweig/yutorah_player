/**
 * Shared duration formatters — single source of truth for server (worker
 * ESM import) and client (served as classic `window.YTUtils` bundle).
 * Pure functions, no DOM, no network.
 */

/**
 * Normalize a duration string ("90", "1:30", "1h 20m", "45 min") into a
 * compact display form ("1h 30m", "45 min"). Pass-through when unparseable.
 * @param {string} lengthStr
 * @returns {string}
 */
export function formatDuration(lengthStr) {
  if (!lengthStr) return '';
  const s = String(lengthStr).trim();
  if (!s) return '';
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      if (!isNaN(m)) {
        if (m >= 60) {
          const h = Math.floor(m / 60);
          const remM = m % 60;
          return remM > 0 ? (h + 'h ' + remM + 'm') : (h + 'h');
        }
        return m + ' min';
      }
    } else if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!isNaN(h) && !isNaN(m)) {
        if (h > 0) return m > 0 ? (h + 'h ' + m + 'm') : (h + 'h');
        return m + ' min';
      }
    }
  }
  const hm = s.match(/(\d+)\s*h(?:r)?(?:\s*(\d+)\s*m(?:in)?)?/i);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = hm[2] ? parseInt(hm[2], 10) : 0;
    if (m > 0) return h + 'h ' + m + 'm';
    return h + 'h';
  }
  const mm = s.match(/(\d+)\s*min/i);
  if (mm) {
    return parseInt(mm[1], 10) + ' min';
  }
  if (/^\d+$/.test(s)) {
    const totalM = parseInt(s, 10);
    if (totalM >= 60) {
      const h = Math.floor(totalM / 60);
      const remM = totalM % 60;
      return remM > 0 ? (h + 'h ' + remM + 'm') : (h + 'h');
    }
    return totalM + ' min';
  }
  return s;
}

/**
 * Format seconds as m:ss or h:mm:ss player timestamps.
 * @param {number} sec
 * @returns {string}
 */
export function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
  return m + ':' + seconds.toString().padStart(2, '0');
}
