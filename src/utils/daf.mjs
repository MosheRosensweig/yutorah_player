/**
 * Daf Yomi cycle math — single source of truth for the server (worker ESM
 * import) and the Daf page template (constants embedded via ${}).
 *
 * Canonical facts: 36 masechtot (no Shekalim), 2711 dafim, anchor
 * 2019-12-28 UTC = cycle-14 day 0 = Berachos 2. Folio numbering starts
 * at 2 per masechta.
 */

export const DAF_MASECHTOT = [
  ['Berachos', 64], ['Shabbos', 157], ['Eruvin', 105], ['Pesachim', 121],
  ['Yoma', 88], ['Sukkah', 56], ['Beitzah', 40], ['Rosh Hashanah', 35],
  ['Taanis', 31], ['Megillah', 32], ['Moed Katan', 29], ['Chagigah', 27],
  ['Yevamos', 122], ['Kesubos', 112], ['Nedarim', 91], ['Nazir', 66],
  ['Sotah', 49], ['Gittin', 90], ['Kiddushin', 82], ['Bava Kamma', 119],
  ['Bava Metzia', 119], ['Bava Basra', 176], ['Sanhedrin', 113], ['Makkos', 24],
  ['Shevuos', 49], ['Avodah Zarah', 76], ['Horayos', 14], ['Zevachim', 120],
  ['Menachos', 110], ['Chullin', 142], ['Bechoros', 61], ['Arachin', 34],
  ['Temurah', 34], ['Kerisos', 28], ['Meilah', 22], ['Niddah', 73]
];

export const DAF_CYCLE_DAYS = 2711;
export const DAF_ANCHOR_UTC = Date.UTC(2019, 11, 28);

/**
 * Cycle-day index for a UTC calendar date (handles pre-anchor dates).
 */
export function dafIndexForDateUTC(y, m, d) {
  const days = Math.floor((Date.UTC(y, m - 1, d) - DAF_ANCHOR_UTC) / 86400000);
  return ((days % DAF_CYCLE_DAYS) + DAF_CYCLE_DAYS) % DAF_CYCLE_DAYS;
}

/**
 * Tractate + folio for a cycle-day index.
 */
export function dafRefForIndexUTC(idx) {
  let rest = idx;
  for (const pair of DAF_MASECHTOT) {
    if (rest < pair[1]) return { masechta: pair[0], daf: rest + 2, count: pair[1] };
    rest -= pair[1];
  }
  return { masechta: 'Berachos', daf: 2, count: 64 };
}

/**
 * Normalize tractate spellings: underscores/hyphens/case/whitespace.
 */
export function dafNormMasechta(s) {
  return String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Cycle-day index for a tractate + folio, or -1 when unknown/out of range.
 */
export function dafIndexForRefUTC(masechta, daf) {
  let acc = 0;
  const want = dafNormMasechta(masechta);
  for (const pair of DAF_MASECHTOT) {
    if (pair[0].toLowerCase() === want) {
      const n = parseInt(daf, 10);
      if (!isNaN(n) && n >= 2 && n <= pair[1] + 1) return acc + (n - 2);
      return -1;
    }
    acc += pair[1];
  }
  return -1;
}

/**
 * Strict calendar-date validation (rejects 2026-13-99 style input).
 */
export function dafValidDateISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
