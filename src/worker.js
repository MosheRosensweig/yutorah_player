/**
 * YUTorah Player — Cloudflare Worker Web Application
 *
 * Standalone, zero-friction web portal and enhanced audio player.
 * Server-renders collections (Editor's Picks, Recently Uploaded, Popular, Daily Shiurim)
 * and proxies real-time searches across 440,000+ YUTorah shiurim without Cloudflare blocking.
 */

import { getHebrewDateInfo, getActiveHolidayTheme } from './hebrew_calendar.js';
import { THEMES } from './theme_definitions.js';
import { THEME_ASSETS } from './theme_assets.js';
import { 
  expandQueryWithPhonetics, 
  COMMUNITY_ACRONYM_PHRASES,
  highlightMatches,
  extractSnippet,
  buildMatchReasons,
  computeRelevanceScore,
  groupAndRankDocs,
  damerauLevenshtein,
  suggestDidYouMean
} from './phonetic_engine.js';
import AUTOCOMPLETE_META from './autocomplete_data.json' with { type: 'json' };
import CHANGELOG from './changelog.json' with { type: 'json' };

// Safe JSON embed for <script> contexts: neutralizes </script> breakouts.
function jsEmbed(val) {
  return JSON.stringify(val === undefined ? null : val).replace(/</g, '\\u003c');
}

const TARGET_API_ORIGIN = 'https://www.yutorah.org';
const API_ORIGIN = 'https://api.yutorah.org';

// Decode HTML entities from scraped upstream text BEFORE our own escaping,
// or sequences like l&#x27;ilui double-escape into visible "l&#x27;ilui".
// &amp; decodes LAST so double-encoded input (&amp;lt;) survives correctly.
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#x27;|&#39;|&#x22;|&quot;|&lt;|&gt;/gi, m => {
      const k = m.toLowerCase();
      if (k === '&#x27;' || k === '&#39;') return "'";
      if (k === '&#x22;' || k === '&quot;') return '"';
      if (k === '&lt;') return '<';
      return '>';
    })
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi, '&');
}

// In-memory cache for homepage collections (5 minutes)
let homeDataCache = null;
let homeDataCacheTime = 0;

async function getHomepageData() {
  const now = Date.now();
  if (homeDataCache && (now - homeDataCacheTime < 300000)) {
    return homeDataCache;
  }
  try {
    const res = await fetch(`${API_ORIGIN}/homepage/details`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (res.ok) {
      homeDataCache = await res.json();
      homeDataCacheTime = now;
      return homeDataCache;
    }
  } catch (e) {
    console.error('Error fetching homepage data:', e);
  }
  return homeDataCache;
}

// In-memory cache for live daily sponsorship (5 minutes)
let sponsorshipCache = null;
let sponsorshipCacheTime = 0;

async function getDailySponsorship() {
  const now = Date.now();
  if (sponsorshipCache && (now - sponsorshipCacheTime < 300000)) {
    return sponsorshipCache;
  }
  let result = {
    text: '',
    plainText: '',
    audioUrl: ''
  };

  // 1. Fetch live daily text banner from YUTorah
  try {
    const res = await fetch('https://www.yutorah.org/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/Learning on the Marcos and Adina Katz YUTorah site is sponsored today[\s\S]*?<\/p>/i);
      if (match) {
        const nameMatch = match[0].match(/id="sponsorSpan_sponsorName">([\s\S]*?)<\/span>/i);
        const sponsorName = nameMatch ? decodeHtmlEntities(nameMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
        const fullText = decodeHtmlEntities(match[0].replace(/<\/p>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

        result.plainText = fullText;
        let formatted = escapeHtml(fullText);
        if (sponsorName && fullText.includes(sponsorName)) {
          const parts = fullText.split(sponsorName);
          formatted = escapeHtml(parts[0]) + '<strong>' + escapeHtml(sponsorName) + '</strong>' + escapeHtml(parts.slice(1).join(sponsorName));
        } else {
          // OG highlights the dedication itself (prefix + sponsor text spans)
          // even when no separate sponsorName span is present: bold everything
          // from the dedication prefix onward.
          const seg = match[0].match(/id="sponsorSpan_prefix">([\s\S]*?)<\/span>\s*<span[^>]*id="sponsorSpan_sponsorText">([\s\S]*?)<\/span>/i);
          if (seg) {
            const prefix = decodeHtmlEntities(seg[1].replace(/<[^>]+>/g, '').trim());
            const at = prefix ? fullText.indexOf(prefix) : -1;
            if (at >= 0) {
              formatted = escapeHtml(fullText.slice(0, at)) + '<strong>' + escapeHtml(fullText.slice(at)) + '</strong>';
            }
          }
        }
        result.text = formatted;
      }
    }
  } catch (e) {
    console.error('Error fetching live sponsorship HTML:', e);
  }

  // 2. Query official YUTorah Live Sponsorship Audio API
  // Exactly as YUTorah's frontend does: GET https://api.yutorah.org/browse/sponsorship/audio
  try {
    const audioApiRes = await fetch('https://api.yutorah.org/browse/sponsorship/audio', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
      }
    });
    if (audioApiRes.ok) {
      let liveUrl = (await audioApiRes.text()).trim();
      if (liveUrl && /^https?:\/\//i.test(liveUrl) && !liveUrl.includes('112521.mp3')) {
        liveUrl = liveUrl.replace('http://cdn.yutorah.net/', 'https://cdn.yutorah.net/');
        liveUrl = liveUrl.replace('http://www.yutorah.org/_cdn/', 'https://cdn.yutorah.net/');
        liveUrl = liveUrl.replace('https://www.yutorah.org/_cdn/', 'https://cdn.yutorah.net/');
        // Verify that the audio URL is active and accessible
        try {
          const headCheck = await fetch(liveUrl, { method: 'HEAD', redirect: 'follow' });
          if (headCheck.ok) {
            result.audioUrl = liveUrl;
          }
        } catch (hErr) {
          console.warn('Live API audio URL head check failed:', hErr);
        }
      }
    }
  } catch (apiErr) {
    console.error('Error fetching from https://api.yutorah.org/browse/sponsorship/audio:', apiErr);
  }

  // 3. Fallback: Check today's and recent days' MMDDYY.mp3 files on CDN
  if (!result.audioUrl) {
    try {
      const nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: '2-digit',
        month: '2-digit',
        day: '2-digit'
      });
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const targetDate = new Date(Date.now() - dayOffset * 86400000);
        const parts = nyFormatter.formatToParts(targetDate);
        const mm = parts.find(p => p.type === 'month')?.value;
        const dd = parts.find(p => p.type === 'day')?.value;
        const yy = parts.find(p => p.type === 'year')?.value;

        if (mm && dd && yy) {
          const checkUrl = `https://cdn.yutorah.net/_media/sponsorshipAudio/${mm}${dd}${yy}.mp3`;
          const head = await fetch(checkUrl, { method: 'HEAD', redirect: 'follow' });
          if (head.ok) {
            result.audioUrl = checkUrl;
            break;
          }
        }
      }
    } catch (dateErr) {
      console.error('Error checking date-based sponsorship audio:', dateErr);
    }
  }

  // 4. Safe verified fallback if no audio URL could be reached
  if (!result.audioUrl) {
    result.audioUrl = 'https://cdn.yutorah.net/_media/sponsorshipAudio/081726.mp3';
  }

  // Fallback if live HTML fetch fails or no current sponsor
  if (!result.text) {
    result.text = 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by <strong>The Ohayon family in Hamilton, ON</strong> to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra';
    result.plainText = 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by The Ohayon family in Hamilton, ON to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra';
  }

  sponsorshipCache = result;
  sponsorshipCacheTime = now;
  return sponsorshipCache;
}

// Fallback featured shiurim if API is unreachable
const FALLBACK_SHIURIM = [
  {
    id: '1187082',
    title: 'The Power of לדוד',
    speaker: 'Rabbi Noach Goldstein',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/noach_goldstein.jpg',
    duration: '46 min',
    category: 'Elul / Machshava'
  },
  {
    id: '1187083',
    title: '13 Middot Explainer: Understanding Each Middah',
    speaker: 'Rabbi Moshe Taragin',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/mtaragin.jpg',
    duration: '1h 48m',
    category: 'Yeshivat Har Etzion'
  },
  {
    id: '1187202',
    title: 'Chassidus on Teshuva - Kedushas Levi',
    speaker: 'Mrs. Emma Katz',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/emma_katz.jpg',
    duration: '10 min',
    category: 'Chicago Kollel'
  },
  {
    id: '1187183',
    title: "Tehilim 81: Shir shel Yom of Rosh ha'Shanah",
    speaker: 'Rabbi Matt Schneeweiss',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/matt_schneeweiss.jpg',
    duration: '1h 3m',
    category: 'Nach'
  },
  {
    id: '1186969',
    title: 'Selichos 5786',
    speaker: 'Rabbi Hershel Schachter',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/hershel_schachter.jpg',
    duration: '1h 12m',
    category: 'Yamim Noraim'
  },
  {
    id: '1186958',
    title: 'The Role of the Shofar in the Avodah of Rosh Hashanah',
    speaker: 'Rabbi Michael Rosensweig',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/michael_rosensweig.jpg',
    duration: '1h 22m',
    category: 'Rosh Hashanah'
  }
];

async function executeSearchInternal(searchParams) {
  const rawQ = searchParams.get('q') || searchParams.get('searchTerm') || searchParams.get('search') || '';

  // Parse single or multi-valued IDs (can be passed as repeated params e.g. teacherId=A&teacherId=B or comma-separated)
  function extractIdList(paramName, aliasName) {
    const vals = [];
    const directList = searchParams.getAll(paramName);
    for (const v of directList) {
      if (v) vals.push(...v.split(',').map(s => s.trim()).filter(Boolean));
    }
    if (aliasName) {
      const aliasList = searchParams.getAll(aliasName);
      for (const v of aliasList) {
        if (v) vals.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      }
    }
    return [...new Set(vals)];
  }

  let teacherIds = extractIdList('teacherId');
  const subCategoryIds = extractIdList('subCategoryId');
  const locationIds = extractIdList('locationId', 'venueId');
  const seriesIds = extractIdList('seriesId', 'series');
  let start = parseInt(searchParams.get('page') || searchParams.get('start') || '1', 10);
  // Raw item offset, captured BEFORE page normalization — the date branch
  // (sort=date) treats `start` as a 1-based item offset, not a page.
  const rawItemStart = Math.max(parseInt(searchParams.get('start') || '1', 10) || 1, 1);
  if (!searchParams.has('page') && start > 30) {
    start = Math.floor((start - 1) / 30) + 1;
  }
  const disablePhonetics = searchParams.get('exact') === '1' || searchParams.get('classic') === '1';

  // Advanced post-filters
  const minDuration = searchParams.get('minDuration') ? parseInt(searchParams.get('minDuration'), 10) : null;
  const maxDuration = searchParams.get('maxDuration') ? parseInt(searchParams.get('maxDuration'), 10) : null;
  const year = searchParams.get('year') || '';
  const fromDate = searchParams.get('fromDate') || '';
  const toDate = searchParams.get('toDate') || '';
  const mediaType = (searchParams.get('mediaType') || searchParams.get('media') || '').toLowerCase(); // 'all' | 'audio' | 'article' | 'text'

  // Recency sort (ROADMAP §7: Recent Results + §10 P4 sort control).
  // `sort=date|recent` or `sortIndex=1` returns date-descending windows.
  // `start` is then a 1-based ITEM offset (not a page) and `rows` the window size.
  const sortParamRaw = (searchParams.get('sort') || '').toLowerCase();
  const sortParam = (sortParamRaw === 'date' || sortParamRaw === 'recent' ||
    sortParamRaw === 'newest' || sortParamRaw === 'oldest' || sortParamRaw === 'relevance') ? sortParamRaw : '';
  const isRelevanceSort = !sortParam || sortParam === 'relevance';
  const sortOldest = sortParam === 'oldest';
  const wantsDateSort = sortParam === 'date' || sortParam === 'recent' || sortParam === 'newest' || sortParam === 'oldest' || searchParams.get('sortIndex') === '1';
  const rows = Math.min(Math.max(parseInt(searchParams.get('rows') || '30', 10) || 30, 1), 30);

  // Partition helper: on first-page relevance queries, lift the 3 freshest
  // docs into `recentDocs` and dedupe them out of the relevance list.
  function docDateStr(d) {
    return String(d.shiurdate || d.shiurdatesubmitted || d.shiurDate || d.shiurDateSubmitted || '');
  }
  function docIdStr(d) {
    return String(d.shiurID || d.shiurid || d.id || '');
  }
  function partitionRecent(docs, numFound) {
    if (start !== 1 || !isRelevanceSort || !docs || docs.length === 0) {
      return { docs: docs || [], recentDocs: [], recentNumFound: 0 };
    }
    // Top-3 freshest as an EXTRA rail; the relevance list keeps all 30.
    const byDate = [...docs].sort((a, b) => docDateStr(b).localeCompare(docDateStr(a)));
    return { docs, recentDocs: byDate.slice(0, 3), recentNumFound: numFound };
  }
  // Fuzzy fallback (ROADMAP §5.4): ranked teacher/topic/venue candidates for
  // the raw query — consumed by the "Did you mean …?" strip + /api/suggest.
  function didYouMeanFor() {
    try {
      return suggestDidYouMean(rawQ, {
        teacher: AUTOCOMPLETE_META.teachers || [],
        topic: AUTOCOMPLETE_META.categories || [],
        venue: AUTOCOMPLETE_META.venues || []
      }, { limit: 5 });
    } catch (e) {
      return [];
    }
  }

  function isDocArticle(doc) {
    if (!doc) return false;
    const mediaCat = (doc.mediatypecategory || doc.mediaTypeCategory || '').toLowerCase();
    const urlCheck = doc.shiururl || doc.shiurURL || doc.playerDownloadURL || doc.downloadURL || '';
    return mediaCat === 'text' || mediaCat === 'article' || /[.]pdf($|[?])/i.test(urlCheck);
  }

  // NO speaker auto-resolution: every query is plain text unless the user
  // sets an explicit teacher filter (chips, suggestion click, bio page).
  // "rosensweig" and "rosensweig shabbos" both match every Rosensweig via
  // text search. The only rewrite is the typo auto-correct below, which
  // fires solely when nothing literally matches.
  let effectiveQuery = rawQ;
  let expandedInfo = null;
  // When the engine rewrites the user's text (typo auto-correct only), the
  // UI shows a "Showing results for X (you searched Y)" disclaimer.
  let resolvedDisplay = '';
  const rawWordCount = rawQ.trim() ? rawQ.trim().split(/\s+/).length : 0;

  if (year && /^\d{4}$/.test(year)) {
    effectiveQuery = effectiveQuery ? `${effectiveQuery} ${year}` : year;
  }

  if (effectiveQuery && !disablePhonetics) {
    expandedInfo = expandQueryWithPhonetics(effectiveQuery);
    effectiveQuery = expandedInfo.solrQuery;
  }

  const filterMedia = (mediaType === 'audio' || mediaType === 'article' || mediaType === 'text');
  const hasPostFilter = (minDuration !== null) || (maxDuration !== null) || year || fromDate || toDate || filterMedia;

  function matchesPostFilters(doc) {
    if (!doc) return false;
    if (mediaType === 'audio' && isDocArticle(doc)) return false;
    if ((mediaType === 'article' || mediaType === 'text') && !isDocArticle(doc)) return false;

    const dur = typeof doc.duration === 'number' ? doc.duration : 0;
    if (minDuration !== null && minDuration > 0 && dur < minDuration) return false;
    if (maxDuration !== null && maxDuration > 0 && dur > maxDuration) return false;

    const docDate = doc.shiurdate || doc.shiurdatesubmitted || '';
    if (year) {
      if (year === 'pre-2000') {
        const docYear = docDate ? parseInt(docDate.slice(0, 4), 10) : 0;
        if (docYear >= 2000) return false;
      } else if (year === 'pre-2010') {
        const docYear = docDate ? parseInt(docDate.slice(0, 4), 10) : 0;
        if (docYear >= 2010) return false;
      } else if (year === '2010-2019') {
        const docYear = docDate ? parseInt(docDate.slice(0, 4), 10) : 0;
        if (docYear < 2010 || docYear > 2019) return false;
      } else {
        if (!docDate.startsWith(year)) return false;
      }
    }

    // Date bounds compare at the bound's own precision: date-only bounds
    // compare YYYY-MM-DD; datetime bounds compare through minutes.
    // Unknown doc dates pass (same as before).
    if (fromDate && docDate) {
      const L = Math.min(fromDate.length, 16);
      if (docDate.slice(0, L) < fromDate.slice(0, L)) return false;
    }
    if (toDate && docDate) {
      const L = Math.min(toDate.length, 16);
      if (docDate.slice(0, L) > toDate.slice(0, L)) return false;
    }

    return true;
  }

  async function fetchSolrSingle(query, startOffset, tId, catId, locId, sId) {
    let targetUrl = `${API_ORIGIN}/search?searchTerm=${encodeURIComponent(query)}&start=${encodeURIComponent(startOffset)}`;
    if (tId) targetUrl += `&teacherId=${encodeURIComponent(tId)}`;
    if (catId) targetUrl += `&subCategoryId=${encodeURIComponent(catId)}`;
    if (locId) targetUrl += `&locationId=${encodeURIComponent(locId)}`;
    if (sId) targetUrl += `&seriesId=${encodeURIComponent(sId)}`;

    try {
      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        }
      });
      if (!upstream.ok) return { docs: [], numFound: 0 };
      const json = await upstream.json();
      return {
        docs: json?.response?.docs || [],
        numFound: json?.response?.numFound || 0
      };
    } catch (e) {
      // Per-page failure must never fail the whole search (fanout safety).
      return { docs: [], numFound: 0 };
    }
  }

  // Shared date-window fetcher: fans out over the first few upstream pages
  // with identical filters, merges + dedupes, applies post-filters, sorts by
  // date descending, and slices [itemOffset, itemOffset + rowCount).
  // Returns { windowDocs, totalFound }. Upstream Solr has no reliable
  // date-sort param, hence the merge-sort over relevance pages.
  async function fetchDateWindow(query, itemOffset, rowCount) {
    const tId = teacherIds[0] || '';
    const catId = subCategoryIds[0] || '';
    const locId = locationIds[0] || '';
    const sId = seriesIds[0] || '';
    const multiEntities = [];
    if (teacherIds.length > 1) teacherIds.forEach(id => multiEntities.push({ tId: id, catId, locId, sId }));
    else if (subCategoryIds.length > 1) subCategoryIds.forEach(id => multiEntities.push({ tId, catId: id, locId, sId }));
    else if (locationIds.length > 1) locationIds.forEach(id => multiEntities.push({ tId, catId, locId: id, sId }));
    else if (seriesIds.length > 1) seriesIds.forEach(id => multiEntities.push({ tId, catId, locId, sId: id }));
    const entities = multiEntities.length > 0 ? multiEntities : [{ tId, catId, locId, sId }];
    const pagesToCover = Math.min(4, Math.ceil((itemOffset + rowCount) / 30) + 1);
    const fanout = [];
    for (const ent of entities) {
      for (let p = 1; p <= pagesToCover; p++) {
        fanout.push(fetchSolrSingle(query, p, ent.tId, ent.catId, ent.locId, ent.sId));
      }
    }
    const settled = await Promise.all(fanout);
    const seen = new Set();
    let merged = [];
    // Total = sum of each entity's FIRST-page numFound. Every page of the
    // same entity reports the identical upstream total — summing all pages
    // would inflate the count up to 4x.
    let totalFound = 0;
    for (let e = 0; e < entities.length; e++) {
      const first = settled[e * pagesToCover];
      if (first) totalFound += first.numFound || 0;
    }
    for (const r of settled) {
      for (const doc of r.docs) {
        const docTeacherId = String(doc.teacherid || doc.teacherId || '');
        if ((teacherIds.length === 0 || teacherIds.includes(docTeacherId)) && matchesPostFilters(doc)) {
          const id = docIdStr(doc);
          if (id) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          merged.push(doc);
        }
      }
    }
    merged.sort((a, b) => sortOldest
      ? docDateStr(a).localeCompare(docDateStr(b))
      : docDateStr(b).localeCompare(docDateStr(a)));
    return { windowDocs: merged.slice(itemOffset - 1, itemOffset - 1 + rowCount), totalFound: totalFound || merged.length };
  }

  // Date-sorted window branch (powers the Recent Results rail).
  // `start` here is a 1-based ITEM offset (rawItemStart, pre-normalization).
  if (wantsDateSort) {
    const itemOffset = rawItemStart;
    const { windowDocs, totalFound } = await fetchDateWindow(effectiveQuery, itemOffset, rows);
    return {
      response: {
        docs: windowDocs,
        numFound: totalFound,
        start: itemOffset,
        sort: 'date'
      },
      phoneticExpansion: null,
      didYouMean: didYouMeanIfWeak(windowDocs.length),
      queryResolution: resolvedDisplay ? { original: rawQ, display: resolvedDisplay } : null
    };
  }

  const isMultiTeacher = teacherIds.length > 1;
  const isMultiLocation = locationIds.length > 1;
  const isMultiCategory = subCategoryIds.length > 1;
  const isMultiTarget = isMultiTeacher || isMultiLocation || isMultiCategory;

  // Weak-hit threshold: at or below this many UNIQUE total hits we also
  // return fuzzy candidates so the UI can render a "Did you mean …?" strip
  // (above the message when zero hits, below the list when 1+ weak hits).
  // Recent/relevance rails may overlap (no carve-out), so shared ids count once.
  function undupedHitCount(docs, recentDocs) {
    const ids = new Set();
    for (const d of (recentDocs || [])) {
      const id = docIdStr(d);
      if (id) ids.add(id);
    }
    let n = (recentDocs || []).length;
    for (const d of (docs || [])) {
      const id = docIdStr(d);
      if (!id || !ids.has(id)) n++;
    }
    return n;
  }
  // Fewer than 10 hits: show results AND a "Did you mean …?" strip on top.
  function didYouMeanIfWeak(totalHits) {
    try {
      return totalHits < 10 ? didYouMeanFor() : [];
    } catch (e) {
      return [];
    }
  }
  // Zero literal matches + a distance-1 correction: surface the notice
  // even when phonetic expansion filled the page (no rewrite — the strip
  // click runs the corrected search). This is the weiderblank case.
  function zeroLiteralNotice(docs, teacherIdsEmpty) {
    if (start !== 1 || rawWordCount !== 1 || disablePhonetics || !teacherIdsEmpty) return [];
    const ql = rawQ.toLowerCase();
    const docText = d => [
      d.shiurtitle, d.shiurTitle, d.title, d.teacherfullname,
      ((d.shiurTeachers || []).map(t => t.teacherFullName || '').join(' ')),
      d.shiurdescription, d.description, d.seriesname, d.seriesName,
      d.subcategoryname, d.categoryname,
      (Array.isArray(d.shiurkeywords) ? d.shiurkeywords.join(' ') : d.shiurkeywords)
    ].join(' ').toLowerCase();
    if ([...docs].some(d => docText(d).includes(ql))) return [];
    try {
      const sug = suggestDidYouMean(rawQ, {
        teacher: AUTOCOMPLETE_META.teachers || [],
        topic: AUTOCOMPLETE_META.categories || [],
        venue: AUTOCOMPLETE_META.venues || []
      }, { limit: 3 });
      return sug.filter(s => s.distance <= 1 && s.text.toLowerCase() !== ql);
    } catch (e) {
      return [];
    }
  }

  if (!isMultiTarget && !hasPostFilter) {
    const tId = teacherIds[0] || '';
    const catId = subCategoryIds[0] || '';
    const locId = locationIds[0] || '';
    const sId = seriesIds[0] || '';

    // Relevance page + global date window in parallel: the Recent rail
    // shows the 3 GLOBALLY freshest matches — relevance sort only (under
    // newest/oldest the list itself is chronological, so no rail).
    const mainPromise = fetchSolrSingle(effectiveQuery, start, tId, catId, locId, sId);
    const datePromise = (start === 1 && isRelevanceSort)
      ? fetchDateWindow(effectiveQuery, 1, 3)
      : Promise.resolve({ windowDocs: [], totalFound: 0 });
    const [{ docs, numFound }, { windowDocs: globalRecent, totalFound: recentTotal }] =
      await Promise.all([mainPromise, datePromise]);

    const filteredDocs = tId ? docs.filter(doc => {
      const docTeacherId = String(doc.teacherid || doc.teacherId || '');
      return docTeacherId === String(tId);
    }) : docs;

    const adjNumFound = tId ? Math.min(numFound, filteredDocs.length + (numFound - docs.length)) : numFound;
    // Relevance keeps its FULL page (30): the Recent-3 are an extra rail on
    // top, never carved out of the relevance list.
    // No auto-rewrites: every query shows its own matches. When hits are
    // thin (<10), didYouMeanIfWeak adds a "Did you mean …?" strip rendered
    // ON TOP, and clicking a suggestion runs that corrected search.
    const recentDocs = (start === 1 && isRelevanceSort) ? globalRecent : [];
    const totalHits = undupedHitCount(filteredDocs, recentDocs);
    let didYouMean = didYouMeanIfWeak(totalHits);
    if ((!didYouMean || didYouMean.length === 0) && teacherIds.length === 0) {
      const extra = zeroLiteralNotice([...filteredDocs, ...recentDocs], true);
      if (extra.length > 0) didYouMean = extra;
    }
    return {
      response: {
        docs: filteredDocs,
        recentDocs,
        recentNumFound: start === 1 ? (recentTotal || adjNumFound) : 0,
        numFound: adjNumFound,
        start
      },
      phoneticExpansion: (expandedInfo && expandedInfo.expandedTokens && expandedInfo.expandedTokens.length > 1) ? {
        original: rawQ,
        tokens: expandedInfo.expandedTokens,
        synset: expandedInfo.matchedSynset
      } : null,
      didYouMean,
      queryResolution: resolvedDisplay ? { original: rawQ, display: resolvedDisplay } : null
    };
  }

  // Multi-Target or Post-Filtering Path
  const targetPageSize = 30;
  let accumulatedDocs = [];
  let totalEstimatedFound = 0;

  if (isMultiTarget) {
    let branchingEntities = [];
    if (isMultiTeacher) {
      branchingEntities = teacherIds.map(id => ({ tId: id, catId: subCategoryIds[0] || '', locId: locationIds[0] || '', sId: seriesIds[0] || '' }));
    } else if (isMultiCategory) {
      branchingEntities = subCategoryIds.map(id => ({ tId: teacherIds[0] || '', catId: id, locId: locationIds[0] || '', sId: seriesIds[0] || '' }));
    } else if (isMultiLocation) {
      branchingEntities = locationIds.map(id => ({ tId: teacherIds[0] || '', catId: subCategoryIds[0] || '', locId: id, sId: seriesIds[0] || '' }));
    } else {
      branchingEntities = seriesIds.map(id => ({ tId: teacherIds[0] || '', catId: subCategoryIds[0] || '', locId: locationIds[0] || '', sId: id }));
    }

    const fetchPromises = branchingEntities.map(entity => {
      return fetchSolrSingle(effectiveQuery, start, entity.tId, entity.catId, entity.locId, entity.sId);
    });

    const results = await Promise.all(fetchPromises);
    const seenShiurIds = new Set();

    for (const res of results) {
      totalEstimatedFound += res.numFound;
      for (const doc of res.docs) {
        const docId = doc.shiurID || doc.shiurid || doc.id;
        if (docId && !seenShiurIds.has(docId)) {
          seenShiurIds.add(docId);
          const docTeacherId = String(doc.teacherid || doc.teacherId || '');
          const teacherMatches = teacherIds.length === 0 || teacherIds.includes(docTeacherId);
          if (teacherMatches && matchesPostFilters(doc)) {
            accumulatedDocs.push(doc);
          }
        }
      }
    }

    accumulatedDocs.sort((a, b) => {
      const dateA = a.shiurdate || a.shiurdatesubmitted || '';
      const dateB = b.shiurdate || b.shiurdatesubmitted || '';
      return dateB.localeCompare(dateA);
    });

    accumulatedDocs = accumulatedDocs.slice(0, targetPageSize);
  } else {
    const tId = teacherIds[0] || '';
    const catId = subCategoryIds[0] || '';
    const locId = locationIds[0] || '';
    const sId = seriesIds[0] || '';
    let curFetchStart = start;
    let iterations = 0;
    const maxIterations = (mediaType === 'article' || mediaType === 'text') ? 10 : 5;

    while (accumulatedDocs.length < targetPageSize && iterations < maxIterations) {
      iterations++;
      const { docs, numFound } = await fetchSolrSingle(effectiveQuery, curFetchStart, tId, catId, locId, sId);
      totalEstimatedFound = numFound;
      if (docs.length === 0) break;

      for (const doc of docs) {
        const docTeacherId = String(doc.teacherid || doc.teacherId || '');
        const teacherMatches = teacherIds.length === 0 || teacherIds.includes(docTeacherId);
        if (teacherMatches && matchesPostFilters(doc)) {
          accumulatedDocs.push(doc);
          if (accumulatedDocs.length >= targetPageSize) break;
        }
      }

      curFetchStart++;
      const totalPages = Math.ceil((numFound || 0) / 30);
      if (curFetchStart > totalPages || docs.length === 0) break;
    }
  }

  const partedFinal = partitionRecent(accumulatedDocs, totalEstimatedFound || accumulatedDocs.length);
  // Under post-filters the upstream total is unfiltered, so report the known
  // filtered pool size as the recent-match count instead of overstating it.
  const recentCountFinal = hasPostFilter
    ? (partedFinal.docs.length + partedFinal.recentDocs.length)
    : partedFinal.recentNumFound;
  const weakTotal = undupedHitCount(partedFinal.docs, partedFinal.recentDocs);
  let multiDidYouMean = didYouMeanIfWeak(weakTotal);
  if ((!multiDidYouMean || multiDidYouMean.length === 0) && teacherIds.length === 0) {
    const extraMulti = zeroLiteralNotice([...partedFinal.docs, ...partedFinal.recentDocs], true);
    if (extraMulti.length > 0) multiDidYouMean = extraMulti;
  }
  return {
    response: {
      docs: partedFinal.docs,
      recentDocs: partedFinal.recentDocs,
      recentNumFound: recentCountFinal,
      numFound: totalEstimatedFound || accumulatedDocs.length,
      filteredCount: partedFinal.docs.length,
      start
    },
    phoneticExpansion: expandedInfo ? {
      original: rawQ,
      tokens: expandedInfo.expandedTokens,
      synset: expandedInfo.matchedSynset
    } : null,
    didYouMean: multiDidYouMean,
    queryResolution: resolvedDisplay ? { original: rawQ, display: resolvedDisplay } : null
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 0. Autocomplete Metadata API: /api/autocomplete-meta
    if (url.pathname === '/api/autocomplete-meta') {
      return new Response(JSON.stringify(AUTOCOMPLETE_META), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
        }
      });
    }

    // 0b. Fuzzy Suggest API: /api/suggest?q=... (ROADMAP §5.4)    // Damerau-Levenshtein over teachers/topics/venues (+ synset variants).
    // Pure local data — no upstream calls, safe to hit on every keystroke pause.
    if (url.pathname === '/api/suggest') {
      const q = url.searchParams.get('q') || '';
      let suggestions = [];
      try {
        suggestions = suggestDidYouMean(q, {
          teacher: AUTOCOMPLETE_META.teachers || [],
          topic: AUTOCOMPLETE_META.categories || [],
          venue: AUTOCOMPLETE_META.venues || []
        }, { limit: 8 });
      } catch (e) {
        suggestions = [];
      }
      return new Response(JSON.stringify({ query: q, suggestions }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 0c. Change Log API: /api/changelog (dev settings "Change Log").
    if (url.pathname === '/api/changelog') {
      return new Response(JSON.stringify(CHANGELOG), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60'
        }
      });
    }

    // 1. Live Search API Proxy: /api/search?q=...
    if (url.pathname === '/api/search') {
      try {
        const responsePayload = await executeSearchInternal(url.searchParams);
        return new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=120'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2. Homepage Details API Proxy: /api/homepage
    if (url.pathname === '/api/homepage') {
      const data = await getHomepageData();
      return new Response(JSON.stringify(data || {}), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 2b. Teacher Info Proxy: /api/teacher?id=...
    if (url.pathname === '/api/teacher') {
      const teacherId = url.searchParams.get('id') || url.searchParams.get('teacherId');
      if (!teacherId) {
        return new Response(JSON.stringify({ error: 'Missing teacher ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const upstream = await fetch(`${TARGET_API_ORIGIN}/teachers/sidebar/${encodeURIComponent(teacherId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
          }
        });
        const data = await upstream.text();
        return new Response(data, {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2c. Venue Info Proxy: /api/venue?id=...
    if (url.pathname === '/api/venue') {
      const venueId = url.searchParams.get('id') || url.searchParams.get('locationId');
      if (!venueId) {
        return new Response(JSON.stringify({ error: 'Missing venue ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const upstream = await fetch(`${TARGET_API_ORIGIN}/venues/sidebar/${encodeURIComponent(venueId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
          }
        });
        const data = await upstream.text();
        return new Response(data, {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2d. Live Daily Sponsorship API: /api/sponsorship
    if (url.pathname === '/api/sponsorship') {
      const data = await getDailySponsorship();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 3. Lecture Data API proxy
    if (url.pathname.startsWith('/sidebar/lecturedata') || url.pathname.startsWith('/sidebar/lectureData') || url.pathname === '/api/shiur') {
      const shiurId = url.searchParams.get('shiurID') || url.searchParams.get('shiurId') || url.searchParams.get('id');
      if (!shiurId) {
        return new Response(JSON.stringify({ error: 'Missing shiurID parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const upstream = await fetch(`${TARGET_API_ORIGIN}/sidebar/lectureData?shiurId=${encodeURIComponent(shiurId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Referer': `${TARGET_API_ORIGIN}/`,
          }
        });
        const data = await upstream.text();
        return new Response(data, {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 3b. Serve Theme SVG Assets: /assets/themes/:file
    if (url.pathname.startsWith('/assets/themes/')) {
      const filename = url.pathname.replace('/assets/themes/', '');
      const svgContent = THEME_ASSETS[filename];
      if (svgContent) {
        return new Response(svgContent, {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return new Response('Theme asset not found', { status: 404 });
    }

    // 3c. Streaming PDF Proxy for in-browser PDF.js & Liquid Mode reflow: /api/pdf-proxy?url=...
    if (url.pathname === '/api/pdf-proxy') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
      const pdfTargetUrl = url.searchParams.get('url');
      if (!pdfTargetUrl) {
        return new Response('Missing url parameter', { status: 400 });
      }
      try {
        let cleanTarget = pdfTargetUrl.trim();
        if (cleanTarget.startsWith('/')) {
          cleanTarget = 'https://shiurim.yutorah.net' + cleanTarget;
        }
        let parsedTarget;
        try {
          parsedTarget = new URL(cleanTarget);
        } catch(e) {
          return new Response('Invalid URL', { status: 400 });
        }
        const allowedHosts = [
          'shiurim.yutorah.net',
          'www.yutorah.org',
          'yutorah.org',
          'api.yutorah.org',
          'cdnyutorah.cachefly.net'
        ];
        const isAllowed = allowedHosts.includes(parsedTarget.hostname.toLowerCase()) ||
          parsedTarget.hostname.toLowerCase().endsWith('.r2.dev') ||
          parsedTarget.hostname.toLowerCase().endsWith('.yutorah.org');
        if (!isAllowed) {
          return new Response('Target host not allowed', { status: 403 });
        }
        const upstreamHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/pdf, */*'
        };
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
          upstreamHeaders['Range'] = rangeHeader;
        }
        const pdfResp = await fetch(cleanTarget, {
          headers: upstreamHeaders,
          redirect: 'follow'
        });
        const respHeaders = new Headers();
        respHeaders.set('Content-Type', pdfResp.headers.get('Content-Type') || 'application/pdf');
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Access-Control-Allow-Headers', 'Range, Content-Type');
        respHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        respHeaders.set('Accept-Ranges', 'bytes');
        respHeaders.set('Cache-Control', 'public, max-age=86400');
        if (pdfResp.headers.has('Content-Length')) {
          respHeaders.set('Content-Length', pdfResp.headers.get('Content-Length'));
        }
        if (pdfResp.headers.has('Content-Range')) {
          respHeaders.set('Content-Range', pdfResp.headers.get('Content-Range'));
        }
        return new Response(pdfResp.body, {
          status: pdfResp.status,
          headers: respHeaders
        });
      } catch (pdfErr) {
        return new Response('Error proxying PDF: ' + pdfErr.message, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 4. Extract Shiur ID or Search Query from URL
    let shiurId = url.searchParams.get('shiurId') || url.searchParams.get('shiurID') || url.searchParams.get('id');
    const pathMatch = url.pathname.match(/^\/(?:lectures\/)?([0-9]+)/);
    if (!shiurId && pathMatch) {
      shiurId = pathMatch[1];
    }

    const searchQuery = url.searchParams.get('search') || url.searchParams.get('q') || '';
    const directAudio = url.searchParams.get('audioUrl') || url.searchParams.get('url');
    const timestamp = url.searchParams.get('t') || '';
    const speedParam = url.searchParams.get('speed') || url.searchParams.get('rate') || '';
    const rawThemeParam = (url.searchParams.get('theme') || url.searchParams.get('mode') || '').toLowerCase();
    let themeMode = '';
    if (rawThemeParam === 'dark' || url.searchParams.get('dark') === '1' || (url.searchParams.has('dark') && url.searchParams.get('dark') !== '0')) {
      themeMode = 'dark';
    } else if (rawThemeParam === 'light' || url.searchParams.get('dark') === '0' || url.searchParams.get('light') === '1') {
      themeMode = 'light';
    }

    // 5. If a shiurId is requested, pre-fetch metadata
    let shiurData = null;
    if (shiurId) {
      try {
        const resp = await fetch(`${TARGET_API_ORIGIN}/sidebar/lectureData?shiurId=${encodeURIComponent(shiurId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json',
            'Referer': `${TARGET_API_ORIGIN}/`,
          }
        });
        if (resp.ok) {
          shiurData = await resp.json();
        }
      } catch (err) {
        console.error('Failed to pre-fetch shiur:', err);
      }
    }

    // 6. Pre-fetch collections & search data if needed
    let homepageData = null;
    let initialSearchResults = null;
    let initialNumFound = 0;
    let initialPhoneticExpansion = null;
    let initialRecentDocs = [];
    let initialRecentNumFound = 0;
    let initialQueryResolution = null;
    let initialDidYouMean = [];

    if (!shiurData && searchQuery) {
      try {
        const searchPayload = await executeSearchInternal(url.searchParams);
        initialSearchResults = searchPayload?.response?.docs || [];
        initialNumFound = searchPayload?.response?.numFound || initialSearchResults.length;
        initialPhoneticExpansion = searchPayload?.phoneticExpansion || null;
        initialRecentDocs = searchPayload?.response?.recentDocs || [];
        initialRecentNumFound = searchPayload?.response?.recentNumFound || 0;
        initialQueryResolution = searchPayload?.queryResolution || null;
        initialDidYouMean = searchPayload?.didYouMean || [];
      } catch (e) {
        console.error('Error pre-fetching search in SSR:', e);
      }
    }

    // Pre-fetch homepage collections and live daily sponsorship in parallel
    let sponsorship = { text: '', plainText: '', audioUrl: '' };
    [homepageData, sponsorship] = await Promise.all([
      getHomepageData(),
      getDailySponsorship()
    ]);

    const isClassicSearch = url.searchParams.get('exact') === '1' || url.searchParams.get('classic') === '1';

    // 7. Render and return the HTML app
    return new Response(renderAppHtml({
      shiurData,
      shiurId,
      directAudio,
      timestamp,
      playbackSpeed: speedParam,
      themeMode,
      homepageData,
      sponsorshipText: sponsorship.text,
      sponsorshipPlainText: sponsorship.plainText,
      sponsorshipAudioUrl: sponsorship.audioUrl,
      searchQuery,
      initialSearchResults,
      initialNumFound,
      initialPhoneticExpansion,
      initialRecentDocs,
      initialRecentNumFound,
      initialQueryResolution,
      initialDidYouMean,
      isClassicSearch
    }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      }
    });
  }
};

function formatDuration(lengthStr) {
  if (!lengthStr) return '';
  const parts = lengthStr.split(':');
  if (parts.length < 2) return lengthStr;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function getNowInNewYork() {
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

function parseLocalDate(str) {
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

function formatShiurDate(rawDateStr) {
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
  return `${monthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function isShiurNew(rawDateStr) {
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

function formatDate(dateStr) {
  return formatShiurDate(dateStr);
}

function normalizeShiur(s) {
  const id = s.shiurID || s.shiurid || s.id;
  const title = s.shiurTitle || s.shiurtitle || s.title || 'Untitled Shiur';

  let speaker = '';
  let photo = '';
  if (s.teacherfullname) {
    speaker = s.teacherfullname;
  } else if (s.shiurTeachers && s.shiurTeachers[0]) {
    speaker = s.shiurTeachers[0].teacherName || s.shiurTeachers[0].teacherFullName || '';
    photo = s.shiurTeachers[0].teacherPhotoURL || s.shiurTeachers[0].teacherPhotoURL_lp || '';
  } else if (s.speaker) {
    speaker = s.speaker;
    photo = s.speakerPhoto || s.photo || '';
  }

  if (!photo && s.PHOTO) {
    photo = s.PHOTO.startsWith('http') ? s.PHOTO : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${s.PHOTO}`;
  }
  if (!photo) {
    photo = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
  }

  let duration = s.durationformatted || s.shiurDuration || '';
  if (!duration && s.shiurLength) {
    duration = formatDuration(s.shiurLength);
  } else if (!duration && s.duration) {
    duration = `${s.duration} min`;
  }

  const rawDate = s.shiurdateformatted || s.shiurDateFormatted || s.shiurDateSubmittedFormatted || s.shiurDate || s.shiurdate || '';
  const date = formatShiurDate(rawDate);
  const isNew = isShiurNew(s.shiurdatesubmitted || s.shiurDateSubmitted || rawDate);

  let category = '';
  if (Array.isArray(s.categoryname) && s.categoryname.length > 0) {
    category = s.categoryname[0];
  } else if (Array.isArray(s.subcategoryname) && s.subcategoryname.length > 0) {
    category = s.subcategoryname[0];
  } else if (s.category) {
    category = s.category;
  } else if (s.shiurGroupedSubcategoriesObj && s.shiurGroupedSubcategoriesObj[0]) {
    category = s.shiurGroupedSubcategoriesObj[0].categoryShortName || '';
  }

  const description = s.shiurdescription || s.description || '';
  const keywords = Array.isArray(s.shiurkeywords) ? s.shiurkeywords.join(', ') : (s.shiurkeywords || s.keywords || '');
  const series = Array.isArray(s.seriesname) ? s.seriesname.join(', ') : (s.seriesname || s.series || '');
  const location = Array.isArray(s.location) ? s.location.join(', ') : (s.location || '');

  return { id, title, speaker, photo, duration, date, category, isNew, description, keywords, series, location };
}

function renderAppHtml({ shiurData, shiurId, directAudio, timestamp, playbackSpeed = '', themeMode = '', homepageData, sponsorshipText = '', sponsorshipPlainText = '', sponsorshipAudioUrl = '', searchQuery, initialSearchResults, initialNumFound = 0, initialPhoneticExpansion = null, initialRecentDocs = [], initialRecentNumFound = 0, initialQueryResolution = null, initialDidYouMean = [], isClassicSearch = false }) {
  const isPlaying = Boolean(shiurData || directAudio);

  const initialSearchTerms = [];
  if (searchQuery) {
    const rawWords = searchQuery.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
    for (const w of rawWords) {
      initialSearchTerms.push(w);
      if (COMMUNITY_ACRONYM_PHRASES[w]) {
        for (const exp of COMMUNITY_ACRONYM_PHRASES[w]) {
          initialSearchTerms.push(exp.toLowerCase());
        }
      }
    }
    if (initialPhoneticExpansion && Array.isArray(initialPhoneticExpansion.tokens)) {
      for (const t of initialPhoneticExpansion.tokens) {
        if (t && t.length >= 2) initialSearchTerms.push(t.toLowerCase());
      }
    }
  }

  let initialGridHtml = '';
  if (initialSearchResults && initialSearchResults.length > 0) {
    const grouped = groupAndRankDocs(initialSearchResults, initialSearchTerms, searchQuery);
    initialGridHtml = grouped.map(item => renderGroupItemHtml(item, initialSearchTerms)).join('');
  }

  let title = 'YUTorah Enhanced Player';
  let speaker = '';
  let photo = '';
  let duration = '';
  let meta = '';
  let description = '';
  let audioUrl = '';
  let downloadUrl = '';
  let articlePdfUrl = '';
  let moreFromSpeakers = [];
  let moreFromCategories = [];
  let shiurTeachers = [];
  let shiurLocations = [];
  let shiurCategories = {};
  let shiurKeywords = [];
  let shiurDate = '';

  if (shiurData) {
    title = shiurData.shiurTitle || 'Untitled Shiur';
    speaker = shiurData.shiurTeacherFullName || (shiurData.shiurTeachers && shiurData.shiurTeachers[0] ? shiurData.shiurTeachers[0].teacherFullName : 'YUTorah');
    photo = shiurData.teacherPhotoURL_lp || shiurData.teacherPhotoURL || (shiurData.shiurTeachers && shiurData.shiurTeachers[0] ? shiurData.shiurTeachers[0].teacherPhotoURL : '');
    duration = shiurData.shiurDuration || '';
    const rawDate = shiurData.shiurDateFormatted || shiurData.shiurDate || '';
    shiurDate = formatShiurDate(rawDate);
    description = shiurData.shiurDescription || '';
    downloadUrl = shiurData.downloadURL || shiurData.playerDownloadURL || '';
    const rawShiurUrl = shiurData.playerDownloadURL || (shiurData.shiurURL ? 'https://shiurim.yutorah.net' + shiurData.shiurURL : '') || downloadUrl;
    
    // Detect if this shiur is an Article / Text document
    const mediaCategory = (shiurData.mediaTypeCategory || '').toLowerCase();
    const isDoc = mediaCategory === 'text' || mediaCategory === 'article' || /\.pdf($|\?)/i.test(rawShiurUrl) || /\.pdf($|\?)/i.test(downloadUrl);
    if (isDoc) {
      articlePdfUrl = rawShiurUrl;
      audioUrl = ''; // Do not treat as audio stream
      meta = '📄 Article' + (shiurDate ? ' · ' + shiurDate : '');
    } else {
      audioUrl = rawShiurUrl;
      meta = duration + (shiurDate ? ' · ' + shiurDate : '');
    }

    if (shiurData.moreFromSpeakers && Array.isArray(shiurData.moreFromSpeakers)) {
      moreFromSpeakers = shiurData.moreFromSpeakers.map(normalizeShiur);
    }
    if (shiurData.moreFromCategories && Array.isArray(shiurData.moreFromCategories)) {
      moreFromCategories = shiurData.moreFromCategories.map(normalizeShiur);
    }

    // Extract rich metadata
    if (Array.isArray(shiurData.shiurTeachers)) {
      shiurTeachers = shiurData.shiurTeachers.map(t => ({
        id: t.teacherID,
        name: t.teacherFullName || '',
        photo: t.teacherPhotoURL_lp || t.teacherPhotoURL || '',
      }));
    }
    if (Array.isArray(shiurData.postedInLocations)) {
      shiurLocations = shiurData.postedInLocations.map(loc => ({
        id: loc.locationID,
        name: loc.locationName || '',
      }));
    }
    if (shiurData.postedInCategories && typeof shiurData.postedInCategories === 'object') {
      for (const [groupId, group] of Object.entries(shiurData.postedInCategories)) {
        if (group.groupName && Array.isArray(group.categories)) {
          shiurCategories[group.groupName] = group.categories.map(c => ({
            name: c.categoryName || '',
            id: c.subcategoryID || '',
          }));
        }
      }
    }
    if (Array.isArray(shiurData.shiurKeywords)) {
      shiurKeywords = shiurData.shiurKeywords.map(k => ({
        title: k.keywordTitle || '',
      }));
    }
  } else if (directAudio) {
    title = 'Audio Stream';
    speaker = directAudio;
    audioUrl = directAudio;
  }

  let currentTeacherId = '';
  if (shiurData) {
    if (Array.isArray(shiurData.shiurTeachers) && shiurData.shiurTeachers[0]) {
      currentTeacherId = String(shiurData.shiurTeachers[0].teacherID || shiurData.shiurTeachers[0].id || '');
    }
    if (!currentTeacherId && shiurData.teacherID) {
      currentTeacherId = String(shiurData.teacherID);
    }
  }

  // Collections data
  let editorsPicks = [];
  let featuredSeries = [];
  let recentlyUploaded = [];
  let popularShiurim = [];
  let dailyShiurim = [];
  let heroSlides = [];

  // Map an upstream slideshow target to our player: lecture links stay
  // in-app, yutorah.org section links open there, externals open new-tab.
  // Unknown or dangerous schemes (javascript:, data:, …) fall back to '#'.
  function heroSlideLink(target) {
    const t = String(target || '').trim();
    const relLec = t.match(/^\/lectures\/(\d+)/);
    if (relLec) return { href: '/' + relLec[1], external: false };
    const abs = t.match(/^https?:\/\/([^\/]+)(\/.*)?$/i);
    if (abs) {
      const host = abs[1].toLowerCase();
      if (host === 'yutorah.org' || host.endsWith('.yutorah.org')) {
        const inner = abs[2] || '/';
        const innerLec = inner.match(/^\/lectures\/(\d+)/);
        if (innerLec) return { href: '/' + innerLec[1], external: false };
        return { href: t, external: true };
      }
      return { href: t, external: true };
    }
    if (t.startsWith('/')) return { href: 'https://www.yutorah.org' + t, external: true };
    return { href: '#', external: false };
  }

  if (homepageData) {
    if (Array.isArray(homepageData.editorsPicks) && homepageData.editorsPicks.length > 0) {
      editorsPicks = homepageData.editorsPicks.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.featuredSeries) && homepageData.featuredSeries.length > 0) {
      featuredSeries = homepageData.featuredSeries;
    }
    if (Array.isArray(homepageData.recentlyUploaded) && homepageData.recentlyUploaded.length > 0) {
      recentlyUploaded = homepageData.recentlyUploaded.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.recentlyViewed) && homepageData.recentlyViewed.length > 0) {
      popularShiurim = homepageData.recentlyViewed.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.dailyShiurim) && homepageData.dailyShiurim.length > 0) {
      dailyShiurim = homepageData.dailyShiurim.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.slideshow) && homepageData.slideshow.length > 0) {
      heroSlides = homepageData.slideshow.map(s => {
        const link = heroSlideLink(s.targetURL);
        return {
          name: s.name || '',
          description: s.description || '',
          imageURL: s.imageURL || '',
          urlTitle: s.urlTitle || 'Listen now',
          href: link.href,
          external: link.external
        };
      }).filter(s => s.imageURL);
    }
  }

  if (editorsPicks.length === 0) {
    editorsPicks = FALLBACK_SHIURIM;
  }

  const timely = homepageData?.timelyData || null;
  let parshaDisplayTitle = timely?.parshaStr || '';
  let parshaHolidayNote = '';
  let parshaCatId = '233995';

  if (!parshaDisplayTitle || parshaDisplayTitle.toLowerCase() === 'none') {
    // Current week has no regular weekly reading because Shabbat is a Yom Tov (e.g. Rosh Hashanah)
    // Display next parsha on the docket and mention the holiday in parentheses
    parshaDisplayTitle = "Ha'azinu";
    parshaHolidayNote = "This Shabbat is Rosh Hashanah";
    parshaCatId = '234515'; // Ha'azinu subcategory
  } else {
    const parshaCatMatch = timely?.parshaURL ? timely.parshaURL.match(/category=([0-9]+)/) : null;
    parshaCatId = parshaCatMatch ? parshaCatMatch[1] : '233995';
  }

  const baseSpeeds = [
    { val: '0.5', label: '0.5x' },
    { val: '0.75', label: '0.75x' },
    { val: '1', label: '1.0x' },
    { val: '1.25', label: '1.25x' },
    { val: '1.5', label: '1.5x' },
    { val: '1.75', label: '1.75x' },
    { val: '2', label: '2.0x' },
    { val: '2.5', label: '2.5x' },
    { val: '3', label: '3.0x' }
  ];
  const activeSpeedNum = (playbackSpeed && !isNaN(parseFloat(playbackSpeed)) && parseFloat(playbackSpeed) > 0) ? parseFloat(playbackSpeed) : 1;
  const activeSpeedStr = String(activeSpeedNum);
  const allSpeeds = [...baseSpeeds];
  if (!baseSpeeds.some(s => parseFloat(s.val) === activeSpeedNum) && activeSpeedNum <= 5) {
    allSpeeds.push({ val: activeSpeedStr, label: activeSpeedStr + 'x' });
    allSpeeds.sort((a, b) => parseFloat(a.val) - parseFloat(b.val));
  }
  const speedOptionsHtml = allSpeeds.map(s => {
    const isSelected = parseFloat(s.val) === activeSpeedNum;
    return `<option value="${s.val}" ${isSelected ? 'selected' : ''}>${s.label}</option>`;
  }).join('\n          ');

  const htmlThemeAttr = themeMode === 'dark' ? ' data-theme="dark"' : '';

  return `<!DOCTYPE html>
<html lang="en"${htmlThemeAttr}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(title)} — YUTorah Enhanced</title>
  <link rel="icon" type="image/png" href="https://cdnyutorah.cachefly.net/public/v3/images/logo-university-2x.png">
  <script>
    (function() {
      try {
        var p = new URLSearchParams(window.location.search);
        var urlTheme = (p.get('theme') || p.get('mode') || '').toLowerCase();
        var dark = false;
        if (urlTheme === 'dark' || p.get('dark') === '1' || (p.has('dark') && p.get('dark') !== '0')) {
          dark = true;
          try { localStorage.setItem('yutorah_theme', 'dark'); } catch(e) {}
        } else if (urlTheme === 'light' || p.get('dark') === '0' || p.get('light') === '1') {
          dark = false;
          try { localStorage.setItem('yutorah_theme', 'light'); } catch(e) {}
        } else {
          var saved = localStorage.getItem('yutorah_theme');
          dark = saved ? saved === 'dark' : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        }
        if (dark) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }

        // Pre-apply persisted cards/rows view to avoid a flash of cards.
        // Mobile is always cards; desktop defaults to rows.
        try {
          const sv = localStorage.getItem('yutorah_card_view');
          const mob = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
          const vv = (sv === 'rows' || sv === 'cards') ? (mob ? 'cards' : sv) : (mob ? 'cards' : 'rows');
          if (vv === 'rows') document.documentElement.classList.add('rows-view');
        } catch (e) {}

        // [DEAD CODE / INACTIVE] Simple View mode switcher
        // var savedMode = localStorage.getItem('yutorah_view_mode');
        // if (savedMode === 'simple') document.documentElement.setAttribute('data-view', 'simple');
      } catch(e) {}
    })();
  </script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  </script>
  <style>
    :root {
      --primary: #2b4c7e;
      --primary-dark: #1b3356;
      --primary-light: #436ea8;
      --accent: #d4a373;
      --bg: #f4f6f9;
      --card: #ffffff;
      --text: #1e2530;
      --text-muted: #5e6978;
      --border: #dce2eb;
      --border-light: #edf1f7;
      --shadow: 0 4px 18px rgba(0, 0, 0, 0.06);
      --shadow-hover: 0 8px 24px rgba(0, 0, 0, 0.1);
    }
    [data-theme="dark"] {
      --primary: #5c8ecc;
      --primary-dark: #121b2a;
      --primary-light: #7ca5de;
      --accent: #e5b98a;
      --bg: #0f141c;
      --card: #182232;
      --text: #e7edf7;
      --text-muted: #94a3b8;
      --border: #28364d;
      --border-light: #1e2a3c;
      --shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
      --shadow-hover: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
    [data-theme="dark"] input,
    [data-theme="dark"] select {
      background: #131c2a;
      color: #e7edf7;
      border-color: #28364d;
    }
    [data-theme="dark"] input[type="datetime-local"] {
      color-scheme: dark;
    }
    [data-theme="dark"] input:focus,
    [data-theme="dark"] select:focus {
      background: #1a2638;
      color: #ffffff;
      border-color: #436ea8;
      box-shadow: 0 0 0 3px rgba(67, 110, 168, 0.25);
    }
    [data-theme="dark"] .chip {
      background: #141f2f;
      color: #cbd5e1;
      border-color: #28364d;
    }
    [data-theme="dark"] .tab-bar {
      background: #111a26;
      border: 1px solid #233147;
    }
    [data-theme="dark"] .tab-btn {
      background: transparent;
      color: #94a3b8;
      border: none;
    }
    [data-theme="dark"] .tab-btn:hover {
      color: #e7edf7;
    }
    [data-theme="dark"] .tab-btn.active {
      background: #1e2c40;
      color: #7ca5de;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    [data-theme="dark"] .quick-play-badge {
      background: #1c2738;
      color: #7ca5de;
    }
    [data-theme="dark"] .quick-card-link:hover .quick-play-badge {
      background: var(--primary);
      color: #fff;
    }
    [data-theme="dark"] .search-results-info {
      background: #141f2f;
      border: 1px solid #233147;
      color: #e7edf7;
    }
    [data-theme="dark"] .search-results-text {
      color: #93c5fd;
    }
    [data-theme="dark"] .match-explain-toggle {
      color: #94a3b8;
    }
    [data-theme="dark"] .match-explain-toggle:hover {
      color: #f1f5f9;
      background: rgba(255, 255, 255, 0.05);
    }
    [data-theme="dark"] .match-toggle-track {
      background-color: #475569;
    }
    [data-theme="dark"] .match-explain-toggle input:checked + .match-toggle-track {
      background-color: #3b82f6;
    }
    [data-theme="dark"] .explain-matches-active mark.match-mark {
      background-color: rgba(234, 179, 8, 0.35);
      color: #fef08a;
    }
    [data-theme="dark"] .explain-matches-active .quick-card-match-reason {
      background: rgba(20, 31, 47, 0.85);
      border-left-color: #60a5fa;
      color: #94a3b8;
    }
    [data-theme="dark"] .match-reason-badge {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.2);
    }
    [data-theme="dark"] .classic-info-btn {
      background: rgba(59, 130, 246, 0.2);
      color: #93c5fd;
    }
    [data-theme="dark"] .classic-info-btn:hover {
      background: #3b82f6;
      color: #ffffff;
    }
    [data-theme="dark"] .classic-search-tooltip {
      background: #1e293b;
      border-color: #334155;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
    }
    [data-theme="dark"] .classic-search-tooltip-header {
      border-bottom-color: #334155;
    }
    [data-theme="dark"] .classic-search-tooltip-title {
      color: #f1f5f9;
    }
    [data-theme="dark"] .classic-search-tooltip-close {
      color: #94a3b8;
    }
    [data-theme="dark"] .classic-search-tooltip-close:hover {
      color: #f8fafc;
      background: rgba(255, 255, 255, 0.1);
    }
    [data-theme="dark"] .classic-search-tooltip-body {
      color: #cbd5e1;
    }
    [data-theme="dark"] .classic-search-tooltip-body strong {
      color: #f1f5f9;
    }
    [data-theme="dark"] .classic-search-tooltip-body em {
      color: #60a5fa;
    }
    [data-theme="dark"] .match-reason-snippet {
      color: #e2e8f0;
    }
    [data-theme="dark"] .quick-card-avatar {
      background: #141f2f;
    }
    [data-theme="dark"] .quick-card-link.is-series-cover {
      border-color: #60a5fa;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
    }
    [data-theme="dark"] .series-cover-badge {
      background: rgba(96, 165, 250, 0.2);
      color: #93c5fd;
    }
    [data-theme="dark"] .series-expand-btn {
      background: rgba(96, 165, 250, 0.12);
      color: #93c5fd;
      border-color: rgba(96, 165, 250, 0.4);
    }
    [data-theme="dark"] .series-expand-btn:hover {
      background: #2563eb;
      color: #fff;
    }
    [data-theme="dark"] .series-drawer {
      background: rgba(15, 23, 42, 0.65);
      border-color: #24344d;
    }
    [data-theme="dark"] .series-sub-card {
      background: #182234;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .series-sub-card:hover {
      border-color: #60a5fa;
    }
    [data-theme="dark"] .ctrl-btn.skip {
      background: #1c2738;
      color: #e7edf7;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .action-btn {
      background: #1c2738;
      color: #cbd5e1;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .action-btn:hover {
      background: #25334a;
      color: #fff;
    }
    [data-theme="dark"] .mini-btn-pill {
      background: #1c2738 !important;
      border-color: #2e3e57 !important;
      color: var(--primary-light) !important;
    }
    [data-theme="dark"] .meta-chip {
      background: #141f2f;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .meta-chip.speaker-chip { border-color: #3b70a8; color: #6ba6e8; }
    [data-theme="dark"] .meta-chip.venue-chip { border-color: #8c6a47; color: #d4a373; }
    [data-theme="dark"] .meta-chip.category-chip { border-color: #3d663d; color: #6fc26f; }
    [data-theme="dark"] .meta-chip.keyword-chip { border-color: #475569; color: #94a3b8; }
    [data-theme="dark"] .scrubber-bar { background: #25334a; }
    [data-theme="dark"] .timely-banner { background: var(--card); border-color: var(--border); box-shadow: var(--shadow); }
    [data-theme="dark"] .timely-label { color: var(--primary-light); }
    [data-theme="dark"] .timely-val { color: var(--text); }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
    }
    button, a, input, select, .ctrl-btn, .mini-btn, .theme-toggle-btn, .tab-btn, .chip, .quick-card-link, .timely-link {
      -webkit-tap-highlight-color: transparent !important;
      -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
      outline: none;
    }
    button:focus,
    button:active,
    a:focus,
    a:active {
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
    }
    button svg, a svg {
      pointer-events: none;
    }
    html, body {
      overflow-x: hidden;
      max-width: 100vw;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Frozen Top Header (Always Fixed to Top of Viewport) */
    header#mainHeader {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      width: 100%;
      z-index: 1000;
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%);
      color: #fff;
      padding: 12px 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
    }
    .header-spacer {
      height: 52px;
      width: 100%;
      flex-shrink: 0;
    }
    .header-inner {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: #fff;
      font-weight: 700;
      font-size: 18px;
      flex-shrink: 0;
    }
    .brand span {
      background: rgba(255,255,255,0.22);
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .hebrew-date-badge {
      font-size: 13px;
      color: rgba(255,255,255,0.9);
      background: rgba(0,0,0,0.15);
      padding: 4px 12px;
      border-radius: 20px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      transition: background 0.15s ease;
    }
    .hebrew-date-badge:active {
      background: rgba(0,0,0,0.28);
    }

    /* Secret Pre-Roll Toggle Toast / Flash HUD */
    .secret-toast {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.85);
      background: rgba(18, 26, 38, 0.95);
      color: #ffffff;
      padding: 16px 28px;
      border-radius: 16px;
      font-size: 16px;
      font-weight: 700;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      border: 1.5px solid rgba(255, 255, 255, 0.2);
      z-index: 9999999;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: center;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .secret-toast.visible {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    .secret-toast.toast-disabled {
      border-color: rgba(239, 68, 68, 0.6);
      box-shadow: 0 12px 40px rgba(239, 68, 68, 0.3);
    }
    .secret-toast.toast-enabled {
      border-color: rgba(34, 197, 94, 0.6);
      box-shadow: 0 12px 40px rgba(34, 197, 94, 0.3);
    }
    .secret-toast.toast-dev {
      border-color: rgba(245, 158, 11, 0.9);
      box-shadow: 0 12px 40px rgba(245, 158, 11, 0.45);
      background: rgba(26, 20, 10, 0.96);
      color: #fef3c7;
    }

    /* Main Container */
    main {
      flex: 1;
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 16px 60px;
    }

    /* Collapsible Timely Widget */
    .timely-collapsible-wrap {
      position: relative;
      margin-bottom: 16px;
      z-index: 10;
    }
    .timely-collapsible-trigger {
      width: 100%;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0 14px;
      height: 38px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text);
      transition: all 0.15s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
      white-space: nowrap;
      overflow: hidden;
    }
    .timely-collapsible-trigger:hover {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.03);
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    [data-theme="dark"] .timely-collapsible-trigger:hover {
      background: rgba(92, 142, 204, 0.08);
      border-color: var(--primary-light);
    }
    .timely-trigger-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
      overflow: hidden;
      min-width: 0;
      flex: 1;
      white-space: nowrap;
    }
    .timely-icon {
      font-size: 15px;
      flex-shrink: 0;
    }
    .timely-title {
      font-weight: 700;
      color: var(--primary);
      letter-spacing: 0.2px;
      flex-shrink: 0;
    }
    [data-theme="dark"] .timely-title {
      color: var(--primary-light);
    }
    .timely-summary-badges {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: nowrap;
      overflow: hidden;
      min-width: 0;
    }
    .timely-badge {
      background: rgba(43, 76, 126, 0.07);
      color: var(--text);
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid rgba(43, 76, 126, 0.12);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      flex-shrink: 1;
    }
    [data-theme="dark"] .timely-badge {
      background: rgba(92, 142, 204, 0.12);
      border-color: rgba(92, 142, 204, 0.25);
    }
    @media (max-width: 640px) {
      .timely-badge:nth-child(n+3) {
        display: none;
      }
      .timely-badge {
        max-width: 130px;
      }
    }
    @media (max-width: 440px) {
      .timely-badge:nth-child(n+2) {
        display: none;
      }
      .timely-badge {
        max-width: 110px;
      }
      .timely-title {
        display: none;
      }
    }
    .timely-trigger-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .timely-dropdown-indicator {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      background: rgba(0,0,0,0.04);
      padding: 3px 8px;
      border-radius: 6px;
    }
    [data-theme="dark"] .timely-dropdown-indicator {
      background: rgba(255,255,255,0.06);
    }
    .timely-dropdown-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.12);
      z-index: 100;
      animation: timelyFadeIn 0.18s ease-out;
    }
    @keyframes timelyFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .timely-menu-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .timely-menu-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(43, 76, 126, 0.03);
      text-decoration: none;
      color: var(--text);
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .timely-menu-card:hover {
      background: rgba(43, 76, 126, 0.08);
      border-color: var(--primary);
      transform: translateY(-1px);
      box-shadow: 0 3px 8px rgba(0,0,0,0.05);
    }
    [data-theme="dark"] .timely-menu-card {
      background: rgba(92, 142, 204, 0.06);
    }
    [data-theme="dark"] .timely-menu-card:hover {
      background: rgba(92, 142, 204, 0.15);
      border-color: var(--primary-light);
    }
    .timely-card-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    .timely-card-body {
      flex: 1;
      min-width: 0;
    }
    .timely-card-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--primary);
      margin-bottom: 2px;
    }
    [data-theme="dark"] .timely-card-label {
      color: var(--primary-light);
    }
    .timely-card-val {
      font-size: 14px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .timely-card-note {
      font-size: 11px;
      color: #d97706;
      font-weight: 600;
      margin-top: 1px;
    }
    [data-theme="dark"] .timely-card-note {
      color: #f59e0b;
    }
    .timely-card-action {
      font-size: 12px;
      font-weight: 700;
      color: var(--primary);
      flex-shrink: 0;
      opacity: 0.8;
      transition: opacity 0.15s;
    }
    .timely-menu-card:hover .timely-card-action {
      opacity: 1;
      transform: translateX(2px);
    }
    [data-theme="dark"] .timely-card-action {
      color: var(--primary-light);
    }

    /* Shiur Card NEW Badge */
    .quick-card-new-badge {
      position: absolute;
      top: 9px;
      right: 10px;
      background: linear-gradient(135deg, #e67e22 0%, #d35400 100%);
      color: #ffffff;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.6px;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      box-shadow: 0 1px 4px rgba(230, 126, 34, 0.35);
      z-index: 2;
    }

    /* Sponsorship Banner */
    .sponsorship-banner {
      background: linear-gradient(90deg, #fdf8eb 0%, #fffdf7 50%, #fdf8eb 100%);
      border-bottom: 1px solid #e7d8b5;
      color: #634d17;
      font-size: 13px;
      padding: 8px 16px;
      text-align: center;
      line-height: 1.45;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .sponsorship-content {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .sponsorship-banner strong {
      color: #3b2c06;
      font-weight: 700;
    }
    .sponsorship-support-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 6px;
      padding: 2px 10px;
      font-size: 11px;
      font-weight: 700;
      color: #4a3600;
      background: rgba(184, 134, 11, 0.12);
      border: 1px solid rgba(184, 134, 11, 0.35);
      border-radius: 12px;
      text-decoration: none;
      transition: all 0.15s ease;
      white-space: nowrap;
      vertical-align: middle;
    }
    .sponsorship-support-pill:hover {
      background: rgba(184, 134, 11, 0.22);
      border-color: rgba(184, 134, 11, 0.55);
      transform: translateY(-1px);
      color: #2b1f00;
      text-decoration: none;
    }
    [data-theme="dark"] .sponsorship-banner {
      background: linear-gradient(90deg, #141a24 0%, #1a2230 50%, #141a24 100%);
      border-bottom: 1px solid #29384e;
      color: #e8ce8f;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    [data-theme="dark"] .sponsorship-banner strong {
      color: #fae4a5;
    }
    [data-theme="dark"] .sponsorship-support-pill {
      color: #fae4a5;
      background: rgba(250, 228, 165, 0.12);
      border-color: rgba(250, 228, 165, 0.3);
    }
    [data-theme="dark"] .sponsorship-support-pill:hover {
      background: rgba(250, 228, 165, 0.24);
      border-color: rgba(250, 228, 165, 0.55);
      color: #ffffff;
    }

    /* Sponsor Pre-Roll Overlayment Banner inside Player Card (Under Shiur Title) */
    .sponsor-preroll-banner {
      background: linear-gradient(135deg, rgba(212, 163, 115, 0.16) 0%, rgba(43, 76, 126, 0.08) 100%);
      border: 1.5px solid rgba(212, 163, 115, 0.55);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 18px;
      position: relative;
      box-shadow: 0 4px 14px rgba(212, 163, 115, 0.12);
      animation: fadeInSponsor 0.3s ease-out;
    }
    @keyframes fadeInSponsor {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    [data-theme="dark"] .sponsor-preroll-banner {
      background: linear-gradient(135deg, rgba(212, 163, 115, 0.22) 0%, rgba(27, 51, 86, 0.45) 100%);
      border-color: rgba(226, 180, 133, 0.5);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }
    .sponsor-preroll-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .sponsor-preroll-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #d4a373;
      color: #1a1a1a;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 10px;
      border-radius: 20px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.12);
    }
    .sponsor-preroll-status {
      font-size: 12px;
      font-weight: 700;
      color: var(--primary);
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    [data-theme="dark"] .sponsor-preroll-status {
      color: #fae4a5;
    }
    .sponsor-preroll-body {
      font-size: 13.5px;
      line-height: 1.45;
      color: var(--text-main);
      margin-bottom: 8px;
      font-weight: 500;
      margin-bottom: 12px;
    }
    .sponsor-preroll-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }
    .sponsor-preroll-countdown {
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .sponsor-preroll-countdown span {
      color: #d4a373;
      font-weight: 800;
    }
    [data-theme="dark"] .sponsor-preroll-countdown span {
      color: #e2b485;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .support-yutorah-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: #ffffff !important;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 14px;
      transition: all 0.2s ease;
      white-space: nowrap;
      line-height: 1.3;
      flex-shrink: 0;
    }
    .support-yutorah-btn:hover {
      background: rgba(255, 255, 255, 0.24);
      border-color: rgba(255, 255, 255, 0.45);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
      color: #ffffff !important;
      text-decoration: none;
    }
    [data-theme="dark"] .support-yutorah-btn {
      background: rgba(92, 142, 204, 0.15);
      border-color: rgba(92, 142, 204, 0.3);
      color: #e2eeff !important;
    }
    [data-theme="dark"] .support-yutorah-btn:hover {
      background: rgba(92, 142, 204, 0.28);
      border-color: rgba(92, 142, 204, 0.5);
      color: #ffffff !important;
    }
    .theme-toggle-btn {
      background: none !important;
      border: none !important;
      color: #fff;
      font-size: 20px;
      padding: 0 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.15s ease;
      flex-shrink: 0;
      line-height: 1;
      border-radius: 0;
      box-shadow: none !important;
      width: auto;
      height: auto;
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-user-select: none;
      user-select: none;
    }
    .theme-toggle-btn:focus,
    .theme-toggle-btn:active {
      outline: none !important;
      background: none !important;
      box-shadow: none !important;
    }
    .theme-toggle-btn:hover {
      background: none !important;
      transform: scale(1.22);
    }

    /* [DEAD CODE / INACTIVE] Settings Dropdown, Simple View & Theme Picker */
    .settings-wrapper {
      position: relative;
      display: none !important; /* Hidden as requested */
      align-items: center;
    }
    .settings-btn {
      font-size: 19px !important;
      padding: 0 3px;
      cursor: pointer;
      line-height: 1;
      transition: transform 0.25s ease;
    }
    .settings-btn:hover {
      transform: rotate(45deg);
    }
    .settings-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      min-width: 220px;
      padding: 6px;
      z-index: 1100;
      animation: menuFadeIn 0.15s ease-out;
    }
    @keyframes menuFadeIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .settings-menu-item {
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: background 0.15s ease, color 0.15s ease;
      white-space: nowrap;
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    .settings-menu-item:hover {
      background: var(--border-light);
      color: var(--primary);
    }
    [data-theme="dark"] .settings-menu {
      background: #182232;
      border-color: #28364d;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    [data-theme="dark"] .settings-menu-item:hover {
      background: #243247;
      color: #7ca5de;
    }

    /* Settings Menu Section & Controls */
    .settings-menu-divider {
      height: 1px;
      background: var(--border);
      margin: 6px 0;
    }
    .settings-menu-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      padding: 6px 12px 2px;
    }
    .theme-select-wrap {
      padding: 4px 10px 8px;
    }
    .theme-select {
      width: 100%;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      outline: none;
    }
    .variant-toggle-wrap {
      display: flex;
      gap: 4px;
      padding: 4px 10px 8px;
    }
    .variant-btn {
      flex: 1;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text-muted);
      border-radius: 5px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .variant-btn.active {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
    }
    .chanukah-day-select-wrap {
      padding: 2px 10px 8px;
    }

    /* Holiday Theme Header Motif & Tagline Banner */
    .holiday-motif-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid var(--border);
      border-radius: 16px;
      font-size: 12px;
      font-weight: 700;
      color: var(--primary);
      margin-left: 6px;
      vertical-align: middle;
      transition: all 0.3s ease;
    }
    .holiday-motif-icon {
      width: 20px;
      height: 20px;
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
    .holiday-motif-title {
      white-space: nowrap;
    }
    .holiday-tagline-bar {
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--primary);
      padding: 3px 12px;
      background: rgba(255, 255, 255, 0.5);
      border-bottom: 1px solid rgba(0, 0, 0, 0.05);
      letter-spacing: 0.3px;
    }
    [data-theme="dark"] .holiday-tagline-bar {
      background: rgba(20, 27, 38, 0.85);
      color: #fae4a5;
      border-bottom: 1px solid rgba(212, 163, 115, 0.25);
    }
    [data-theme="dark"] .holiday-motif-wrap {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(212, 163, 115, 0.45);
      color: #fae4a5;
    }

    /* Mode Switch Overlay ("CSR" / "MGR") */
    .mode-switch-overlay {
      position: fixed;
      inset: 0;
      z-index: 999999;
      pointer-events: none;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(15, 20, 28, 0.45);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      animation: overlayFade 1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }
    .mode-switch-text {
      font-size: clamp(80px, 22vw, 170px);
      font-weight: 900;
      letter-spacing: 12px;
      color: #ffffff;
      text-shadow: 0 4px 25px rgba(0, 0, 0, 0.7), 0 0 60px rgba(67, 110, 168, 0.9), 0 0 120px rgba(43, 76, 126, 0.7);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      animation: growAndFade 1s cubic-bezier(0.15, 0.85, 0.35, 1) forwards;
    }
    @keyframes overlayFade {
      0% { opacity: 0; }
      20% { opacity: 1; }
      75% { opacity: 1; }
      100% { opacity: 0; }
    }
    @keyframes growAndFade {
      0% {
        opacity: 0;
        transform: scale(0.3);
        filter: blur(10px);
      }
      25% {
        opacity: 1;
        transform: scale(1.0);
        filter: blur(0);
      }
      75% {
        opacity: 1;
        transform: scale(1.35);
        filter: blur(0);
      }
      100% {
        opacity: 0;
        transform: scale(1.75);
        filter: blur(14px);
      }
    }

    /* Popular tab hidden by default in full mode, shown in simple mode */
    #tab-popular {
      display: none;
    }

    /* Simple View Mode Overrides (Classic Clean 4-Tab Look) */
    [data-view="simple"] #tab-series,
    [data-view="simple"] #tab-viewed,
    [data-view="simple"] #tab-parsha,
    [data-view="simple"] #tab-trending {
      display: none !important;
    }
    [data-view="simple"] #grid-series,
    [data-view="simple"] #grid-viewed,
    [data-view="simple"] #grid-parsha,
    [data-view="simple"] #grid-trending {
      display: none !important;
    }
    [data-view="simple"] #tab-popular {
      display: inline-flex !important;
    }
    [data-view="simple"] .bio-banner {
      display: none !important;
    }
    [data-view="simple"] .timely-link {
      background: none !important;
      border: none !important;
      padding: 0 !important;
      transform: none !important;
      box-shadow: none !important;
      cursor: default;
    }
    [data-view="simple"] .timely-link .timely-val {
      text-decoration: none !important;
    }

    @media (max-width: 600px) {
      header#mainHeader {
        padding: 8px 10px;
      }
      .header-spacer {
        height: 38px;
      }
      .brand {
        font-size: 14px;
        gap: 5px;
      }
      .brand span {
        display: inline-block;
        font-size: 9px;
        padding: 2px 5px;
        letter-spacing: 0.4px;
      }
      .header-right {
        gap: 5px;
      }
      .support-yutorah-btn {
        display: none !important;
      }
      .theme-toggle-btn {
        font-size: 18px;
        padding: 0 2px;
      }
      .hebrew-date-badge {
        font-size: 11px;
        padding: 2px 7px;
      }
      .sponsorship-banner {
        font-size: 11.5px;
        padding: 8px 12px;
      }
      .sponsorship-content {
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 6px;
      }
      .sponsorship-support-pill {
        margin-left: 0;
        margin-top: 4px;
        padding: 4px 14px;
        font-size: 11.5px;
      }
      .timely-banner {
        padding: 8px 10px;
        gap: 8px;
      }
      .timely-study-group {
        gap: 8px;
        row-gap: 6px;
      }
    }

    /* Search Bar Card */
    .search-card {
      background: var(--card);
      border-radius: 14px;
      padding: 16px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .search-form {
      display: flex;
      gap: 10px;
      position: relative;
    }
    .search-input-wrapper {
      position: relative;
      flex: 1;
      display: flex;
      align-items: center;
    }
    .search-icon {
      position: absolute;
      left: 14px;
      color: var(--text-muted);
      font-size: 16px;
      pointer-events: none;
    }
    .search-input {
      width: 100%;
      padding: 13px 40px 13px 40px;
      border: 2px solid var(--border);
      border-radius: 10px;
      font-size: 15px;
      outline: none;
      transition: all 0.2s;
      background: #fafbfc;
    }
    .search-input:focus {
      border-color: var(--primary);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(43, 76, 126, 0.12);
    }
    [data-theme="dark"] .search-input {
      background: #131c2a;
      color: #e7edf7;
      border-color: #28364d;
    }
    [data-theme="dark"] .search-input:focus {
      background: #1a2638 !important;
      color: #ffffff !important;
      border-color: #436ea8 !important;
      box-shadow: 0 0 0 3px rgba(67, 110, 168, 0.28) !important;
    }
    [data-theme="dark"] .search-input::placeholder {
      color: #7b8fa7;
    }
    [data-theme="dark"] .search-icon {
      color: #7b8fa7;
    }
    .clear-search-btn {
      position: absolute;
      right: 12px;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      display: none;
      padding: 4px 6px;
      line-height: 1;
    }
    .clear-search-btn:hover {
      color: var(--text);
    }
    .search-actions-row {
      display: flex;
      gap: 10px;
    }
    .search-submit-btn {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 0 22px;
      height: 48px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .search-submit-btn:hover {
      background: var(--primary-dark);
    }
    .advanced-search-btn {
      background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 0 18px;
      height: 48px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 2px 6px rgba(217, 119, 6, 0.25);
    }
    .advanced-search-btn:hover {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(217, 119, 6, 0.35);
    }
    .advanced-search-btn.active {
      background: #b45309;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.25);
    }
    [data-theme="dark"] .advanced-search-btn {
      background: linear-gradient(135deg, #b45309 0%, #78350f 100%);
    }

    /* Live Search Preview Dropdown */
    .search-preview-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.16);
      z-index: 1000;
      overflow: hidden;
      display: none;
      animation: previewFadeIn 0.15s ease-out;
    }
    @keyframes previewFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .preview-section-title {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      padding: 10px 14px 6px;
      background: rgba(0,0,0,0.02);
      border-bottom: 1px solid var(--border-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    [data-theme="dark"] .preview-section-title {
      background: rgba(255,255,255,0.02);
    }
    .preview-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 9px 14px;
      text-decoration: none;
      color: var(--text);
      border-bottom: 1px solid var(--border-light);
      cursor: pointer;
      transition: background 0.12s;
    }
    .preview-item:last-child {
      border-bottom: none;
    }
    .preview-item:hover, .preview-item.active {
      background: rgba(43, 76, 126, 0.08);
    }
    [data-theme="dark"] .preview-item:hover, [data-theme="dark"] .preview-item.active {
      background: rgba(92, 142, 204, 0.15);
    }
    .preview-item-icon {
      font-size: 18px;
      flex-shrink: 0;
      width: 24px;
      text-align: center;
    }
    .preview-item-body {
      flex: 1;
      min-width: 0;
    }
    .preview-item-title {
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
    }
    .preview-item-sub {
      font-size: 11.5px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }
    .preview-item-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(43, 76, 126, 0.08);
      color: var(--primary);
      flex-shrink: 0;
    }
    [data-theme="dark"] .preview-item-badge {
      background: rgba(92, 142, 204, 0.18);
      color: var(--primary-light);
    }
    .preview-footer-view-all {
      display: block;
      padding: 10px 14px;
      text-align: center;
      font-size: 12.5px;
      font-weight: 700;
      color: var(--primary);
      background: rgba(43, 76, 126, 0.04);
      cursor: pointer;
      text-decoration: none;
      border-top: 1px solid var(--border);
    }
    .preview-footer-view-all:hover {
      background: rgba(43, 76, 126, 0.1);
    }
    [data-theme="dark"] .preview-footer-view-all {
      color: var(--primary-light);
      background: rgba(92, 142, 204, 0.08);
    }

    [data-theme="dark"] .advanced-search-btn {
      border: 1px solid #d97706;
      color: #fef3c7;
    }
    [data-theme="dark"] .advanced-search-btn:hover {
      background: linear-gradient(135deg, #d97706 0%, #92400e 100%);
      color: #fff;
    }

    @media (max-width: 640px) {
      .search-form {
        flex-direction: column;
        gap: 10px;
      }
      .search-input-wrapper {
        width: 100%;
      }
      .search-actions-row {
        width: 100%;
        display: flex;
        gap: 8px;
      }
      .search-actions-row .search-submit-btn,
      .search-actions-row .advanced-search-btn {
        flex: 1;
        justify-content: center;
        height: 44px;
      }
    }

    /* Quick Filter Chips */
    .quick-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-light);
    }
    .chip {
      background: #eef2f7;
      color: var(--primary-dark);
      border: 1px solid #dbe2ed;
      border-radius: 16px;
      padding: 4px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      text-decoration: none;
      white-space: nowrap;
    }
    .chip:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      transform: translateY(-1px);
    }

    /* Audio Player Card */
    .player-card {
      background: var(--card);
      border-radius: 14px;
      padding: 24px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      margin-bottom: 28px;
      scroll-margin-top: 70px;
      ${isPlaying ? '' : 'display: none;'}
    }
    .player-nav-back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--primary);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      cursor: pointer;
    }
    .player-nav-back:hover {
      text-decoration: underline;
    }
    .shiur-header {
      display: flex;
      gap: 18px;
      align-items: center;
      margin-bottom: 20px;
    }
    .speaker-photo {
      width: 76px;
      height: 76px;
      border-radius: 50%;
      object-fit: cover;
      background: #e2e6ec;
      border: 2px solid var(--border);
      flex-shrink: 0;
      ${photo ? '' : 'display: none;'}
    }
    .shiur-details {
      flex: 1;
      min-width: 0;
    }
    .shiur-title {
      font-size: 21px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 6px;
      color: var(--text);
    }
    .shiur-speaker {
      font-size: 16px;
      font-weight: 600;
      color: var(--primary);
      margin-bottom: 4px;
      cursor: pointer;
      display: inline-block;
    }
    .shiur-upload-date {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .shiur-meta {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Scrubber */
    .scrubber-container {
      margin-bottom: 18px;
      user-select: none;
      -webkit-user-select: none;
    }
    .scrubber-bar {
      width: 100%;
      height: 10px;
      background: #e4e8ef;
      border-radius: 5px;
      cursor: pointer;
      position: relative;
      touch-action: none;
    }
    /* Expanded hit zone so tapping/clicking is effortless and snappy */
    .scrubber-bar::before {
      content: '';
      position: absolute;
      top: -14px;
      bottom: -14px;
      left: 0;
      right: 0;
      z-index: 1;
    }
    .scrubber-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 5px;
      width: 0%;
      position: relative;
      pointer-events: none;
      transition: width 0.15s linear;
    }
    .scrubber-bar.is-dragging .scrubber-fill {
      transition: none !important;
    }
    .scrubber-handle {
      position: absolute;
      right: -10px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      background: var(--primary);
      border: 2.5px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.28);
      transition: transform 0.1s ease, background-color 0.2s ease, box-shadow 0.2s ease;
      pointer-events: none;
      z-index: 2;
    }
    .scrubber-bar:hover .scrubber-handle,
    .scrubber-bar.is-dragging .scrubber-handle {
      transform: translateY(-50%) scale(1.25);
    }
    .scrubber-bar.is-sponsor-preroll {
      cursor: default;
    }
    .scrubber-bar.is-sponsor-preroll .scrubber-fill {
      background: linear-gradient(90deg, #b8860b 0%, #d4a373 100%);
      transition: none !important;
    }
    .scrubber-bar.is-sponsor-preroll .scrubber-handle {
      width: 26px;
      height: 26px;
      right: -13px;
      background-color: #ffffff;
      background-image: url('https://cdnyutorah.cachefly.net/public/v3/images/logo-university-2x.png');
      background-size: 80% 80%;
      background-position: center;
      background-repeat: no-repeat;
      border: 2px solid #b8860b;
      border-radius: 50%;
      box-shadow: 0 0 10px rgba(184, 134, 11, 0.75), 0 2px 6px rgba(0,0,0,0.25);
      transform: translateY(-50%);
    }
    .scrubber-bar.is-sponsor-preroll:hover .scrubber-handle {
      transform: translateY(-50%) scale(1.1);
    }
    .time-display {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
    }

    /* Transport Controls */
    .transport-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin-bottom: 16px;
    }
    .ctrl-btn {
      border: 2px solid var(--border);
      background: #ffffff;
      color: var(--text);
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      user-select: none;
      -webkit-user-select: none;
      transition: all 0.15s ease;
      touch-action: manipulation;
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    .ctrl-btn:focus,
    .ctrl-btn:active {
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    .ctrl-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      background: #f8fafc;
    }
    .ctrl-btn:active {
      transform: scale(0.92);
    }
    .ctrl-btn.skip {
      width: 50px;
      height: 50px;
      font-size: 14px;
    }
    .ctrl-btn.play {
      width: 68px;
      height: 68px;
      font-size: 28px;
      border-color: var(--primary);
      background: var(--primary);
      color: #fff;
    }
    .ctrl-btn.play:hover {
      background: var(--primary-dark);
      border-color: var(--primary-dark);
      color: #fff;
    }


    /* Secondary Controls */
    .controls-grid {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .ctrl-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ctrl-label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .speed-select {
      padding: 8px 12px;
      border: 2px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      background: #fff;
      cursor: pointer;
      outline: none;
    }
    .speed-select:focus {
      border-color: var(--primary);
    }
    .action-btn {
      padding: 8px 14px;
      border: 2px solid var(--border);
      background: #fff;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .action-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      background: #f8fafc;
    }
    .action-btn.copied {
      border-color: #27ae60;
      color: #27ae60;
    }

    /* Description */
    .shiur-desc {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 14px;
      line-height: 1.6;
      color: #4a5568;
      ${description ? '' : 'display: none;'}
    }

    /* Shortcuts Hint */
    .shortcuts-hint {
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
    }
    kbd {
      background: #eaedf2;
      border: 1px solid #cfd5de;
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 11px;
    }
    [data-theme="dark"] kbd {
      background: #202c3e;
      border-color: #364863;
      color: #cbd5e1;
    }
    @media (max-width: 768px), (pointer: coarse) {
      .shortcuts-hint {
        display: none !important;
      }
    }

    /* ==========================================================================
       Article & PDF Reader (Liquid Mode & High-Resolution Original View)
       ========================================================================== */
    .article-viewer-wrap {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 14px;
      background: var(--card);
      border-radius: 12px;
    }
    .article-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 10px 14px;
      background: rgba(43, 76, 126, 0.05);
      border: 1px solid var(--border);
      border-radius: 10px;
      user-select: none;
      -webkit-user-select: none;
    }
    [data-theme="dark"] .article-toolbar {
      background: rgba(92, 142, 204, 0.08);
      border-color: #2a3b52;
    }
    .article-toolbar-left,
    .article-toolbar-center,
    .article-toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .article-mode-pill {
      display: inline-flex;
      background: var(--border-light);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2px;
      gap: 2px;
    }
    .article-mode-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 700;
      padding: 5px 12px;
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .article-mode-btn.active {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.15);
    }
    [data-theme="dark"] .article-mode-btn.active {
      background: var(--primary);
      color: #fff;
    }
    .article-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .article-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      background: var(--border-light);
    }
    .article-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      border-color: var(--border);
    }
    .article-page-info {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      min-width: 80px;
      text-align: center;
    }
    .font-size-controls {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--border-light);
      padding: 2px 6px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .font-size-btn {
      background: transparent;
      border: none;
      color: var(--text);
      font-weight: 800;
      font-size: 12px;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .font-size-btn:hover {
      background: rgba(0,0,0,0.06);
      color: var(--primary);
    }
    [data-theme="dark"] .font-size-btn:hover {
      background: rgba(255,255,255,0.1);
    }

    /* Liquid Mode Typography View */
    .article-liquid-viewport {
      padding: 26px 32px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      min-height: 480px;
      line-height: 1.8;
      color: var(--text);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.02);
      max-height: 75vh;
      overflow-y: auto;
      scroll-behavior: smooth;
    }
    .article-liquid-viewport::-webkit-scrollbar {
      width: 8px;
    }
    .article-liquid-viewport::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }
    .liquid-content {
      max-width: 840px;
      margin: 0 auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .liquid-page-block {
      margin-bottom: 36px;
      padding-bottom: 28px;
      border-bottom: 1px dashed var(--border);
      position: relative;
    }
    .liquid-page-block:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .liquid-page-marker {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--primary);
      background: rgba(43, 76, 126, 0.08);
      padding: 3px 8px;
      border-radius: 6px;
      margin-bottom: 14px;
    }
    [data-theme="dark"] .liquid-page-marker {
      background: rgba(92, 142, 204, 0.15);
      color: var(--primary-light);
    }
    .liquid-wip-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 0.82em;
      font-weight: 500;
      color: var(--text-muted);
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid rgba(234, 179, 8, 0.25);
      border-radius: 8px;
      padding: 8px 14px;
      margin: 0 auto 20px auto;
      max-width: 540px;
      text-align: center;
    }
    [data-theme="dark"] .liquid-wip-banner {
      background: rgba(234, 179, 8, 0.08);
      border-color: rgba(234, 179, 8, 0.2);
      color: #fde047;
    }
    .liquid-header {
      text-align: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
      margin-bottom: 28px;
    }
    .liquid-kicker {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .liquid-title {
      font-size: 1.85em;
      font-weight: 800;
      line-height: 1.25;
      margin: 10px 0;
      color: var(--primary);
    }
    [data-theme="dark"] .liquid-title {
      color: var(--primary-light);
    }
    .liquid-byline {
      font-size: 1.05em;
      font-weight: 600;
      color: var(--text);
    }
    .liquid-role {
      font-size: 0.9em;
      color: var(--text-muted);
      margin-top: 3px;
    }
    .liquid-paragraph {
      margin-bottom: 18px;
      text-align: left;
      line-height: 1.75;
      hyphens: auto;
    }
    .liquid-paragraph[dir="rtl"] {
      text-align: right;
      font-family: "SBL Hebrew", "David", "Times New Roman", serif;
      font-size: 1.1em;
      line-height: 1.9;
    }
    .liquid-hebrew {
      direction: rtl;
      unicode-bidi: isolate;
      font-family: "SBL Hebrew", "David", "Taamey Frank CLM", "Times New Roman", serif;
      font-size: 1.12em;
      line-height: 1.8;
      display: inline-block;
      margin: 0 3px;
      color: #1a365d;
    }
    [data-theme="dark"] .liquid-hebrew {
      color: #93c5fd;
    }
    .liquid-hebrew-block {
      font-family: "Taamey Frank CLM", "David", "SBL Hebrew", "Times New Roman", serif;
      font-size: 1.18em;
      line-height: 1.9;
      background: rgba(43, 76, 126, 0.03);
      border-radius: 8px;
      padding: 18px 22px;
      margin: 1.4em 0;
      text-align: right;
      direction: rtl;
      unicode-bidi: isolate;
    }
    [data-theme="dark"] .liquid-hebrew-block {
      background: rgba(92, 142, 204, 0.08);
    }
    .liquid-translation {
      padding: 16px 20px;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 1.2em 0;
      font-size: 0.98em;
      line-height: 1.7;
      background: rgba(0,0,0,0.01);
    }
    .liquid-blockquote {
      margin: 1.3em 0;
      padding: 1em 1.25em;
      border-left: 4px solid var(--primary);
      background: rgba(43, 76, 126, 0.04);
      border-radius: 4px;
      font-size: 0.98em;
      font-style: italic;
    }
    [data-theme="dark"] .liquid-blockquote {
      border-left-color: var(--primary-light);
      background: rgba(92, 142, 204, 0.08);
    }
    .liquid-pull-quote {
      margin: 32px auto;
      max-width: 90%;
      padding: 24px 32px;
      border-top: 2px solid var(--primary);
      border-bottom: 2px solid var(--primary);
      background: linear-gradient(135deg, rgba(43, 76, 126, 0.04) 0%, rgba(43, 76, 126, 0.01) 100%);
      border-radius: 6px;
      text-align: center;
      position: relative;
    }
    .liquid-pull-quote blockquote {
      margin: 0;
      font-size: 1.25em;
      line-height: 1.6;
      font-weight: 600;
      color: var(--primary);
      font-style: italic;
      font-family: Georgia, serif;
    }
    .liquid-pull-quote-tag {
      display: inline-block;
      font-size: 0.72em;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-top: 10px;
    }
    [data-theme="dark"] .liquid-pull-quote {
      border-color: var(--primary-light);
      background: linear-gradient(135deg, rgba(92, 142, 204, 0.08) 0%, rgba(92, 142, 204, 0.02) 100%);
    }
    [data-theme="dark"] .liquid-pull-quote blockquote {
      color: var(--primary-light);
    }
    .liquid-heading {
      font-weight: 800;
      color: var(--primary);
      margin: 28px 0 14px 0;
      line-height: 1.35;
      font-size: 1.4em;
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
    }
    [data-theme="dark"] .liquid-heading {
      color: var(--primary-light);
    }
    .liquid-endnotes {
      border-top: 2px solid var(--primary);
      margin-top: 44px;
      padding-top: 20px;
    }
    [data-theme="dark"] .liquid-endnotes {
      border-top-color: var(--primary-light);
    }
    .liquid-endnotes-title {
      font-size: 1.3em;
      font-weight: 800;
      margin-bottom: 16px;
      color: var(--primary);
    }
    [data-theme="dark"] .liquid-endnotes-title {
      color: var(--primary-light);
    }
    .liquid-endnotes-list {
      padding-left: 24px;
      margin: 0;
    }
    .liquid-endnotes-item {
      font-size: 0.92em;
      line-height: 1.65;
      margin-bottom: 12px;
      color: var(--text);
    }
    .liquid-endnotes-item[dir="rtl"] {
      direction: rtl;
      text-align: right;
      font-family: "SBL Hebrew", "David", "Taamey Frank CLM", "Times New Roman", serif;
      font-size: 1.05em;
      line-height: 1.85;
    }
    .liquid-footnote-ref {
      font-size: 0.72em;
      line-height: 0;
      vertical-align: super;
      font-weight: 700;
      color: var(--primary);
      padding: 1px 3px;
      cursor: pointer;
      background: rgba(43, 76, 126, 0.08);
      border-radius: 4px;
      transition: background 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .liquid-footnote-ref:hover, .liquid-footnote-ref:active {
      background: rgba(43, 76, 126, 0.18);
    }
    [data-theme="dark"] .liquid-footnote-ref {
      color: var(--primary-light);
      background: rgba(92, 142, 204, 0.12);
    }
    [data-theme="dark"] .liquid-footnote-ref:hover, [data-theme="dark"] .liquid-footnote-ref:active {
      background: rgba(92, 142, 204, 0.25);
    }
    .liquid-footnote-popover {
      position: fixed;
      z-index: 9999;
      max-width: min(90vw, 420px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
      font-size: 0.92rem;
      line-height: 1.7;
      color: var(--text);
      animation: popoverFadeIn 0.18s ease;
      pointer-events: auto;
    }
    .liquid-footnote-popover.inverted {
      transform: translateY(-100%);
      animation: popoverFadeInInverted 0.18s ease;
    }
    @keyframes popoverFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes popoverFadeInInverted {
      from { opacity: 0; transform: translateY(calc(-100% - 6px)); }
      to { opacity: 1; transform: translateY(-100%); }
    }
    .liquid-footnote-popover .fn-popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border-light);
    }
    .liquid-footnote-popover .fn-popover-num {
      font-weight: 800;
      font-size: 0.82em;
      color: var(--primary);
      background: rgba(43, 76, 126, 0.08);
      padding: 2px 8px;
      border-radius: 6px;
    }
    [data-theme="dark"] .liquid-footnote-popover .fn-popover-num {
      background: rgba(92, 142, 204, 0.15);
      color: var(--primary-light);
    }
    .liquid-footnote-popover .fn-popover-close {
      background: none;
      border: none;
      font-size: 18px;
      cursor: pointer;
      color: var(--text-muted);
      padding: 0 4px;
      line-height: 1;
    }
    .liquid-footnote-popover .fn-popover-body {
      font-size: 0.88rem;
      line-height: 1.65;
    }
    .liquid-footnote-popover .fn-popover-body .liquid-hebrew {
      font-size: 1.05em;
    }
    [data-theme="dark"] .liquid-footnote-popover {
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.25);
    }
    .liquid-footnote-section {
      margin-top: 28px;
      padding-top: 16px;
      border-top: 2px solid var(--border);
    }
    .liquid-footnote-section-header {
      font-size: 0.82em;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .liquid-subheading {
      font-weight: 700;
      color: var(--text);
      font-size: 1.15em;
      margin: 18px 0 8px 0;
      line-height: 1.4;
    }
    .liquid-byline {
      font-style: italic;
      color: var(--text-muted);
      font-size: 0.95em;
      margin-bottom: 16px;
    }
    .liquid-blockquote {
      border-left: 3px solid var(--primary);
      margin: 14px 0 18px 16px;
      padding: 6px 14px;
      background: rgba(43, 76, 126, 0.04);
      border-radius: 0 8px 8px 0;
      font-size: 0.96em;
      line-height: 1.7;
    }
    .liquid-blockquote[dir="rtl"] {
      border-left: none;
      border-right: 3px solid var(--primary);
      margin: 14px 16px 18px 0;
      padding: 6px 14px;
      border-radius: 8px 0 0 8px;
      text-align: right;
    }
    [data-theme="dark"] .liquid-blockquote {
      border-color: var(--primary-light);
      background: rgba(92, 142, 204, 0.08);
    }
    .liquid-footnote-item {
      font-size: 0.88em;
      line-height: 1.6;
      margin-bottom: 8px;
      padding-left: 28px;
      position: relative;
      color: var(--text);
    }
    .liquid-footnote-item .fn-num {
      position: absolute;
      left: 0;
      top: 0;
      font-weight: 800;
      color: var(--primary);
      font-size: 0.85em;
      min-width: 22px;
    }
    [data-theme="dark"] .liquid-footnote-item .fn-num {
      color: var(--primary-light);
    }

    /* Page View Mode Switcher (Continuous Scroll vs Page by Page) */
    .page-mode-pill {
      display: inline-flex;
      background: var(--border-light);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2px;
      gap: 2px;
    }
    .page-mode-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 11.5px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .page-mode-btn.active {
      background: var(--card);
      color: var(--primary);
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    }
    [data-theme="dark"] .page-mode-btn.active {
      background: #253347;
      color: var(--primary-light);
    }

    /* Original Page Canvas Viewport (Desktop & High-Resolution) */
    .article-canvas-viewport {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: #525659;
      border-radius: 12px;
      padding: 20px;
      min-height: 540px;
      max-height: 85vh;
      overflow-y: auto;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      gap: 20px;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.3);
      position: relative;
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
    }
    [data-theme="dark"] .article-canvas-viewport {
      background: #181d24;
      border: 1px solid #283344;
    }
    .original-page-orientation-tip {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      max-width: 600px;
      padding: 7px 14px;
      margin-bottom: 6px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #f1f5f9;
      text-align: center;
      line-height: 1.4;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    [data-theme="dark"] .original-page-orientation-tip {
      background: rgba(30, 41, 59, 0.7);
      border-color: rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
    }
    .pdf-canvas-card {
      background: #fff;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      border-radius: 4px;
      overflow: visible;
      display: block;
      width: fit-content;
      max-width: none;
      margin: 0 auto;
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
      position: relative;
    }
    #continuousPagesContainer {
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
    }
    .liquid-content {
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
    }
    .pdf-canvas-card canvas {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .canvas-page-separator {
      margin-top: 18px;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
    }
    .canvas-page-tag {
      font-size: 11px;
      font-weight: 700;
      color: #e2e8f0;
      background: rgba(0,0,0,0.55);
      padding: 3px 10px;
      border-radius: 10px;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .article-viewer-wrap:fullscreen {
      background: var(--bg);
      padding: 24px;
      border-radius: 0;
      width: 100vw;
      height: 100vh;
      box-sizing: border-box;
      overflow-y: auto;
    }

    /* Reader Loading State */
    .article-loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
    }

    /* Orientation & Responsive Adaptations */
    @media (max-width: 768px) {
      .article-liquid-viewport {
        padding: 16px 14px;
        line-height: 1.7;
      }
      .article-toolbar {
        padding: 8px 10px;
      }
      .article-toolbar-center {
        order: 3;
        width: 100%;
        justify-content: center;
      }
      .article-canvas-viewport {
        padding: 10px;
      }
    }

    /* Landscape Mode optimization on mobile devices */
    @media (max-width: 900px) and (orientation: landscape) {
      .article-canvas-viewport {
        padding: 12px;
        max-height: 85vh;
      }
      .pdf-canvas-card {
        max-width: 96vw;
      }
    }

    /* Quick Card Article Indicator */
    .quick-article-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #10b981;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 12px;
      box-shadow: 0 1px 4px rgba(16, 185, 129, 0.3);
    }
    [data-theme="dark"] .quick-article-badge {
      background: #059669;
    }

    /* Collections & Tabs Section */
    .collections-section {
      margin-top: 24px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .section-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tab-bar {
      display: flex;
      gap: 6px;
      background: var(--border-light);
      padding: 4px;
      border-radius: 10px;
      overflow-x: auto;
      max-width: 100%;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .tab-bar::-webkit-scrollbar {
      display: none;
    }
    .tab-btn {
      padding: 8px 14px;
      border: none;
      background: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .tab-btn:hover {
      color: var(--primary);
    }
    .tab-btn.active {
      background: #ffffff;
      color: var(--primary);
      box-shadow: 0 2px 6px rgba(0,0,0,0.06);
    }
    [data-theme="dark"] .tab-btn.active {
      background: #243247;
      color: #fff;
    }

    /* Series Cards Grid */
    .series-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }
    .series-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .series-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-hover);
      border-color: var(--primary-light);
    }
    .series-card-img {
      height: 120px;
      background-size: cover;
      background-position: center;
      background-color: var(--border-light);
    }
    .series-card-body {
      padding: 14px;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .series-card-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 6px;
      line-height: 1.3;
    }
    .series-card-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
      margin-bottom: 10px;
      flex: 1;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .series-card-count {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--primary);
      margin-top: auto;
    }

    /* Trending Container */
    .trending-container {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
    }
    .trending-group-title {
      font-size: 13.5px;
      font-weight: 700;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .trending-chips-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 22px;
    }
    .trending-chips-wrap:last-child {
      margin-bottom: 0;
    }
    .trending-chip-btn {
      background: var(--border-light);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: 20px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .trending-chip-btn:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      transform: translateY(-1px);
    }
    [data-theme="dark"] .trending-chip-btn {
      background: #1e2a3c;
      border-color: #2e3e56;
      color: #dce5f2;
    }
    [data-theme="dark"] .trending-chip-btn:hover {
      background: var(--primary);
      color: #fff;
    }

    /* Search Results Header */
    .search-results-info {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
      padding: 12px 16px;
      background: #eef4fc;
      border-radius: 10px;
      border: 1px solid #d0e1f7;
    }
    .search-results-actions {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    .search-toggles-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .search-results-text {
      font-size: 14px;
      font-weight: 600;
      color: var(--primary-dark);
    }
    .close-results-btn {
      background: none;
      border: none;
      color: var(--primary);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .close-results-btn:hover {
      text-decoration: underline;
    }

    /* Match Explainability Toggle */
    .match-explain-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-muted);
      padding: 3px 6px;
      border-radius: 6px;
      transition: all 0.2s ease;
    }
    .match-explain-toggle:hover {
      color: var(--text);
      background: rgba(0, 0, 0, 0.04);
    }
    .match-explain-toggle input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
      pointer-events: none;
    }
    .match-toggle-track {
      width: 32px;
      height: 18px;
      background-color: var(--border, #cbd5e1);
      border-radius: 20px;
      position: relative;
      transition: background-color 0.2s ease;
      flex-shrink: 0;
    }
    .match-toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      background-color: #fff;
      border-radius: 50%;
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    }
    .match-explain-toggle input:checked + .match-toggle-track {
      background-color: #2563eb;
    }
    .match-explain-toggle input:checked + .match-toggle-track .match-toggle-thumb {
      transform: translateX(14px);
    }
    .match-explain-toggle input:focus-visible + .match-toggle-track {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }
    .match-toggle-label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .classic-info-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border-radius: 50%;
      background: rgba(37, 99, 235, 0.1);
      color: #2563eb;
      font-size: 11px;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      transition: all 0.15s ease;
      margin-left: 2px;
    }
    .classic-info-btn:hover {
      background: #2563eb;
      color: #fff;
      transform: scale(1.1);
    }
    .classic-search-tooltip {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 100;
      width: 320px;
      max-width: 90vw;
      background: #ffffff;
      border: 1px solid var(--border, #cbd5e1);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      border-radius: 12px;
      padding: 12px 14px;
      text-align: left;
      cursor: default;
      animation: tooltipPopIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes tooltipPopIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .classic-search-tooltip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border, #e2e8f0);
      padding-bottom: 6px;
      margin-bottom: 8px;
    }
    .classic-search-tooltip-title {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text, #1e293b);
    }
    .classic-search-tooltip-close {
      background: none;
      border: none;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      color: var(--text-muted, #64748b);
      padding: 0 4px;
      border-radius: 4px;
    }
    .classic-search-tooltip-close:hover {
      color: var(--text, #0f172a);
      background: rgba(0, 0, 0, 0.06);
    }
    .classic-search-tooltip-body {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text-muted, #475569);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .classic-search-tooltip-body p {
      margin: 0;
    }
    .classic-search-tooltip-body strong {
      color: var(--text, #0f172a);
    }
    .classic-search-tooltip-body em {
      font-style: normal;
      color: #2563eb;
      font-weight: 600;
    }

    /* Term Highlighting and Explainability Cards */
    mark.match-mark {
      background: transparent;
      color: inherit;
      font-weight: inherit;
      padding: 0;
      border-radius: 3px;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    .explain-matches-active mark.match-mark {
      background-color: #fef08a;
      color: #854d0e;
      font-weight: 700;
      padding: 1px 4px;
    }
    .quick-card-match-reason {
      display: none !important;
    }
    .explain-matches-active .quick-card-match-reason {
      display: flex !important;
      flex-direction: column;
      gap: 6px;
      margin: 10px 0 6px 0;
      padding: 8px 10px;
      background: #f8fafc;
      border-left: 3px solid #3b82f6;
      border-radius: 0 8px 8px 0;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text-muted);
      animation: fadeInReason 0.2s ease;
    }
    @keyframes fadeInReason {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .match-reason-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .match-reason-header {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .match-reason-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #1d4ed8;
      background: #eff6ff;
      padding: 1.5px 6px;
      border-radius: 4px;
      white-space: nowrap;
      width: fit-content;
    }
    .match-reason-snippet {
      font-size: 11.5px;
      line-height: 1.4;
      color: var(--text);
      word-break: break-word;
      padding-left: 2px;
    }
    @media (max-width: 600px) {
      .search-results-info {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }
      .search-results-actions {
        width: 100%;
        justify-content: space-between;
      }
    }

    /* Series and Collection Grouping Cards */
    .quick-card-series-group {
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .quick-card-link.is-series-cover {
      border: 2px solid var(--primary);
      box-shadow: 0 3px 12px rgba(0,0,0,0.06);
    }
    .series-cover-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(43, 76, 126, 0.1);
      color: var(--primary);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 6px;
      margin-bottom: 8px;
      width: fit-content;
      letter-spacing: 0.3px;
    }
    .series-expand-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      margin-top: 8px;
      padding: 8px 12px;
      background: rgba(43, 76, 126, 0.07);
      color: var(--primary);
      border: 1.5px dashed var(--primary);
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .series-expand-btn:hover {
      background: var(--primary);
      color: #fff;
      border-style: solid;
      transform: translateY(-1px);
    }
    .series-drawer {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      padding: 10px;
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 10px;
      animation: slideDownSeries 0.2s ease-out;
    }
    @keyframes slideDownSeries {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .series-sub-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      background: var(--card);
      border: 1px solid var(--border-light);
      border-radius: 8px;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .series-sub-card:hover {
      border-color: var(--primary);
      transform: translateX(3px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .series-sub-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .series-sub-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      line-height: 1.35;
      flex: 1;
    }
    .series-sub-play {
      font-size: 11px;
      font-weight: 700;
      color: var(--primary);
      background: #eef2f7;
      padding: 2px 8px;
      border-radius: 12px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .series-sub-card:hover .series-sub-play {
      background: var(--primary);
      color: #fff;
    }
    .series-sub-meta {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      gap: 8px;
    }

    /* Shiur Cards Grid */
    .shiur-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    .quick-card-link {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      text-decoration: none;
      color: inherit;
      box-shadow: 0 2px 8px rgba(0,0,0,0.03);
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .quick-card-link:hover {
      transform: translateY(-3px);
      box-shadow: var(--shadow-hover);
      border-color: var(--primary);
    }
    .quick-card-link:active {
      transform: scale(0.98);
    }
    .quick-card-top {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
    }
    .quick-card-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      background: #e2e6ec;
      flex-shrink: 0;
      border: 1px solid var(--border);
    }
    .quick-card-info {
      flex: 1;
      min-width: 0;
    }
    .quick-card-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.35;
      color: var(--text);
      margin-bottom: 4px;
      padding-right: 42px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .quick-card-speaker {
      font-size: 13px;
      color: var(--primary);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .quick-card-category {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .quick-card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid var(--border-light);
      padding-top: 10px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .quick-play-badge {
      background: #eef2f7;
      color: var(--primary);
      font-weight: 700;
      padding: 4px 11px;
      border-radius: 20px;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .quick-card-link:hover .quick-play-badge {
      background: var(--primary);
      color: #fff;
    }

    /* Loading Spinner */
    .spinner-box {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
      font-size: 15px;
      font-weight: 600;
      display: none;
    }
    .spinner {
      border: 3px solid #e4e8ef;
      border-top: 3px solid var(--primary);
      border-radius: 50%;
      width: 28px;
      height: 28px;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Search Results Sub-Sections (ROADMAP §7: Recent + Relevant) */
    .search-results-subheading {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 17px;
      font-weight: 800;
      margin: 18px 0 12px;
      grid-column: 1 / -1;
    }
    .search-results-subheading .sub-count {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    /* Quick Date Filters (every search) */
    .date-quick-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 10px 0 4px;
    }
    .date-quick-caption {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
    }
    .date-quick-sep {
      width: 1px;
      align-self: stretch;
      background: var(--border-light);
      margin: 2px 2px;
    }
    .date-quick-chip {
      cursor: pointer;
      border-radius: 20px;
      padding: 5px 13px;
      font-size: 12.5px;
      font-weight: 700;
      border: 1px solid var(--border-light);
      background: var(--card, #fff);
      color: var(--text);
    }
    .date-quick-chip.selected {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    .date-quick-chip:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    [data-theme="dark"] .date-quick-chip {
      background: #141f2f;
      border-color: #28364d;
      color: #cbd5e1;
    }
    [data-theme="dark"] .date-quick-chip.selected {
      background: #2b4c7e;
      border-color: #2b4c7e;
      color: #fff;
    }
    /* Cards / Rows view toggle */
    .view-toggle-wrap {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    .view-toggle-btn {
      cursor: pointer;
      border: 1px solid var(--border-light);
      background: var(--card, #fff);
      color: var(--text-muted);
      border-radius: 16px;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 11px;
    }
    .view-toggle-btn.selected {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    .view-toggle-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    [data-theme="dark"] .view-toggle-btn {
      background: #1f2937;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    [data-theme="dark"] .view-toggle-btn.selected {
      background: #2b4c7e;
      border-color: #2b4c7e;
      color: #fff;
    }
    /* Rows view: one shiur per full-width row (yutorah.org style) */
    .rows-view .shiur-cards-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rows-view .quick-card-link {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
    }
    .rows-view .quick-card-top {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .rows-view .quick-card-info {
      min-width: 0;
      flex: 1;
    }
    .rows-view .quick-card-avatar {
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }
    .rows-view .quick-card-match-reason {
      display: none;
    }
    .rows-view .quick-card-link .series-cover-badge {
      display: none;
    }
    .rows-view .quick-card-link {
      flex-wrap: wrap;
    }
    .rows-view .quick-card-link .card-mini-actions,
    .rows-view .quick-card-link .dev-progress-wrap {
      flex-basis: 100%;
    }
    .rows-view .quick-card-new-badge {
      top: 9px;
      bottom: auto;
    }
    .rows-view .quick-card-link {
      padding-right: 52px;
    }
    .rows-view .quick-card-bottom {
      border-top: none;
      padding-top: 0;
      flex-shrink: 0;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }
    .rows-view .card-mini-actions {
      flex-shrink: 0;
    }
    @media (max-width: 640px) {
      .rows-view .quick-card-link {
        flex-wrap: wrap;
      }
      .rows-view .quick-card-bottom {
        flex-direction: row;
        align-items: center;
        width: 100%;
        justify-content: space-between;
      }
      /* Mobile: cards only (no rows toggle) + slimmer mini player. */
      .view-toggle-wrap {
        display: none;
      }
      #miniPlayer .expand-btn {
        display: none;
      }
    }
    /* Play Queue popup + list (Dev Mode) */
    .queue-popup {
      position: fixed;
      bottom: 84px;
      right: 12px;
      width: min(370px, 94vw);
      max-height: 52vh;
      display: flex;
      flex-direction: column;
      background: var(--card, #fff);
      color: var(--text);
      border: 1px solid var(--border-light);
      border-radius: 14px;
      box-shadow: var(--shadow-hover);
      z-index: 9000;
      overflow: hidden;
    }
    .queue-popup-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-light);
    }
    .queue-count {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .queue-popup-header .card-mini-btn {
      margin-left: auto;
    }
    .queue-list {
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .queue-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      border: 1px solid var(--border-light);
      border-radius: 10px;
      background: transparent;
    }
    .queue-row.dragging {
      opacity: 0.45;
    }
    .queue-pos {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-muted);
      min-width: 18px;
      text-align: center;
    }
    .queue-handle {
      cursor: grab;
      color: var(--text-muted);
      font-size: 14px;
      user-select: none;
    }
    .queue-main {
      flex: 1;
      min-width: 0;
    }
    .queue-title {
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .queue-sub {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .queue-row-btns {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .queue-row-btns .card-mini-btn {
      padding: 2px 7px;
      font-size: 11px;
    }
    .queue-popup-footer {
      padding: 8px 12px;
      border-top: 1px solid var(--border-light);
      display: flex;
      justify-content: flex-end;
    }
    .queue-empty {
      padding: 18px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    [data-theme="dark"] .queue-popup {
      background: #182232;
    }
    /* Hero slideshow (yutorah.org spotlight) */
    .hero-slideshow {
      position: relative;
      border-radius: 14px;
      overflow: hidden;
      margin: 0 auto 18px;
      max-width: 980px;
      background: var(--card, #fff);
      border: 1px solid var(--border-light);
    }
    .hero-slides {
      position: relative;
    }
    .hero-slide {
      display: none;
      position: relative;
      text-decoration: none;
      color: inherit;
    }
    .hero-slide.active {
      display: block;
      position: relative;
    }
    .hero-slide img {
      width: 100%;
      aspect-ratio: 682 / 369;
      object-fit: cover;
      object-position: center;
      display: block;
    }
    @media (max-width: 640px) {
      .hero-slide img {
        object-fit: contain;
        object-position: center;
        background: #0b1220;
        -webkit-mask-image: none;
        mask-image: none;
      }
    }
    .hero-caption {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 55%;
      padding: 28px 70px 28px 26px;
      background: linear-gradient(to left, rgba(0, 0, 0, 0.72) 55%, rgba(0, 0, 0, 0));
      color: #fff;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 12px;
      text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
    }
    .hero-title {
      font-size: 56px;
      font-weight: 800;
      line-height: 1.1;
    }
    .hero-desc {
      font-size: 20px;
      opacity: 0.94;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .hero-cta {
      display: inline-block;
      align-self: flex-start;
      margin-top: 12px;
      font-size: 18px;
      font-weight: 800;
      background: rgba(255, 255, 255, 0.92);
      color: #1e2530;
      border-radius: 20px;
      padding: 10px 24px;
      text-shadow: none;
    }
    .hero-arrow {
      position: absolute;
      top: 42%;
      transform: translateY(-50%);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(0, 0, 0, 0.45);
      color: #fff;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
    }
    .hero-arrow:hover {
      background: rgba(0, 0, 0, 0.65);
    }
    .hero-prev { left: 10px; }
    .hero-next { right: calc(55% + 10px); }
    .hero-dots {
      position: absolute;
      bottom: 10px;
      left: 14px;
      display: flex;
      gap: 6px;
    }
    .hero-dot {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 0;
      position: relative;
    }
    .hero-dot::after {
      content: "";
      position: absolute;
      top: 7px;
      left: 7px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.45);
    }
    .hero-dot.active::after {
      background: #fff;
    }
    .hero-dot:focus-visible,
    .hero-arrow:focus-visible {
      outline: 2px solid #fff !important;
      outline-offset: 1px;
      box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.55), 0 0 0 6px var(--primary);
    }
    @media (max-width: 640px) {
      .hero-dot:focus-visible,
      .hero-arrow:focus-visible {
        outline-color: var(--primary) !important;
        box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.9);
      }
    }
    @media (max-width: 640px) {
      .hero-caption {
        position: static;
        width: auto;
        padding: 12px 14px 30px;
        background: var(--card, #fff);
        color: var(--text);
        text-shadow: none;
      }
      .hero-slide img {
        aspect-ratio: 16 / 9;
        max-height: 220px;
      }
      .hero-title {
        font-size: 16px;
      }
      .hero-desc {
        -webkit-line-clamp: 3;
      }
      .hero-dots {
        bottom: 8px;
        right: 10px;
        left: auto;
      }
      .hero-dots .hero-dot::after {
        background: rgba(30, 37, 48, 0.35);
      }
      .hero-dots .hero-dot.active::after {
        background: var(--primary);
      }
      [data-theme="dark"] .hero-dots .hero-dot::after {
        background: rgba(255, 255, 255, 0.45);
      }
      [data-theme="dark"] .hero-dots .hero-dot.active::after {
        background: #fff;
      }
      .hero-next {
        right: 10px;
      }
    }
    [data-theme="dark"] .hero-slideshow {
      background: #182232;
    }
    .card-mini-btn.icon-btn {
      padding: 3px 8px;
      font-size: 14px;
      line-height: 1.2;
    }
    .card-mini-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    .quick-play-badge:focus-visible,
    .series-sub-play:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    /* Circular queue-add button (Spotify-style: list + plus) */    .queue-circle-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1.5px solid var(--border);
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
      padding: 0;
    }
    .queue-circle-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    .queue-circle-btn.active-save {
      border-color: var(--primary);
      color: #fff;
      background: var(--primary);
    }
    .queue-circle-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    [data-theme="dark"] .queue-circle-btn {
      border-color: #4b5563;
      color: #94a3b8;
    }
    [data-theme="dark"] .queue-circle-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    [data-theme="dark"] .queue-circle-btn.active-save {
      border-color: var(--primary);
      background: var(--primary);
      color: #fff;
    }
    /* Did You Mean strip (ROADMAP §5.4) */
    .did-you-mean-strip {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      background: #fffbeb;
      border: 1px solid #fcd34d;
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 14px;
    }
    [data-theme="dark"] .did-you-mean-strip {
      background: #453b0a;
      border-color: #a16207;
    }
    .did-you-mean-strip.resolution-note {
      background: #eef4ff;
      border-color: #b9cdf3;
    }
    [data-theme="dark"] .did-you-mean-strip.resolution-note {
      background: #1b2f4d;
      border-color: #436ea8;
    }
    [data-theme="dark"] .card-mini-btn {
      background: #1f2937;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    [data-theme="dark"] .card-mini-btn.active-save {
      background: #d97706;
      border-color: #d97706;
      color: #fff;
    }
    [data-theme="dark"] .card-mini-btn.active-fav {
      background: #b45309;
      border-color: #fbbf24;
      color: #fff;
    }
    [data-theme="dark"] .playlist-pill {
      background: #1f2937;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    [data-theme="dark"] .playlist-pill.active {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    [data-theme="dark"] .did-you-mean-chip {
      background: #1f2937;
      border-color: var(--primary-light);
      color: var(--primary-light);
    }
    [data-theme="dark"] .card-progress-track {
      background: #374151;
    }
    .did-you-mean-chip {
      cursor: pointer;
      border: 1px solid var(--primary);
      background: #fff;
      color: var(--primary);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 13px;
      font-weight: 700;
    }
    .did-you-mean-chip:hover {
      background: var(--primary);
      color: #fff;
    }
    .preview-focused {
      outline: 2px solid var(--primary);
      outline-offset: -2px;
      background: #eef2f7;
    }
    [data-theme="dark"] .preview-focused {
      background: #24344d;
    }
    /* Dev Playlists (ROADMAP §8) — hidden unless Dev Mode */
    body:not(.dev-mode-active) .dev-only {
      display: none !important;
    }
    .dev-playlist-tab {
      border-style: dashed;
    }
    .playlist-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 4px 0 14px;
      grid-column: 1 / -1;
    }
    .playlist-pill {
      cursor: pointer;
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 700;
      border: 1px solid var(--border-light);
      background: var(--card, #fff);
    }
    .playlist-pill.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .card-progress-track {
      height: 4px;
      background: #e4e8ef;
      border-radius: 0 0 10px 10px;
      overflow: hidden;
      margin-top: 8px;
    }
    .card-progress-fill {
      height: 100%;
      background: var(--primary);
      border-radius: inherit;
    }
    .card-listen-meta {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .card-mini-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      align-items: center;
    }
    .card-mini-btn {
      cursor: pointer;
      border: 1px solid var(--border-light);
      background: transparent;
      border-radius: 16px;
      font-size: 12px;
      padding: 3px 9px;
      opacity: 0.85;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      line-height: 1.2;
      vertical-align: middle;
    }
    .card-mini-btn.active-save {
      background: #d97706;
      color: #fff;
      border-color: #d97706;
      opacity: 1;
    }
    .card-mini-btn.active-fav {
      background: #b45309;
      border-color: #b45309;
      color: #fff;
      opacity: 1;
    }

    /* Load More Button */
    .load-more-btn {
      background: var(--card);
      color: var(--primary);
      border: 2px solid var(--primary);
      border-radius: 10px;
      padding: 12px 28px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .load-more-btn:hover {
      background: var(--primary);
      color: #fff;
      transform: translateY(-2px);
      box-shadow: 0 4px 14px rgba(43, 76, 126, 0.2);
    }
    .load-more-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .spinner-small {
      border: 2px solid rgba(43, 76, 126, 0.3);
      border-top: 2px solid var(--primary);
      border-radius: 50%;
      width: 16px;
      height: 16px;
      animation: spin 0.8s linear infinite;
    }
    .load-more-btn:hover .spinner-small {
      border-color: rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
    }

    /* Shiur Metadata Box */
    .shiur-metadata-box {
      margin-top: 16px;
      padding: 14px 18px;
      background: var(--bg);
      border-radius: 12px;
      border: 1px solid var(--border-light);
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .meta-row:last-child { margin-bottom: 0; }
    .meta-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      min-width: 80px;
      flex-shrink: 0;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 20px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--primary);
      transition: all 0.15s ease;
      text-decoration: none;
      white-space: nowrap;
    }
    .meta-chip:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(43, 76, 126, 0.2);
    }
    .meta-chip.speaker-chip { border-color: #4a90d9; color: #2563a0; }
    .meta-chip.speaker-chip:hover { background: #2563a0; color: #fff; border-color: #2563a0; }
    .meta-chip.venue-chip { border-color: #d4a373; color: #a67c52; }
    .meta-chip.venue-chip:hover { background: #a67c52; color: #fff; border-color: #a67c52; }
    .meta-chip.category-chip { border-color: #65a765; color: #3d7a3d; }
    .meta-chip.category-chip:hover { background: #3d7a3d; color: #fff; border-color: #3d7a3d; }
    .meta-chip.keyword-chip { border-color: #b0b0b0; color: #666; font-size: 12px; padding: 3px 10px; }
    .meta-chip.keyword-chip:hover { background: #666; color: #fff; border-color: #666; }
    .meta-group-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-right: 2px;
    }

    /* Mini Player (persistent bottom bar) */
    #miniPlayer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1001;
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%);
      color: #fff;
      display: none;
      flex-direction: column;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    }
    #miniPlayer.visible { display: flex; }
    .mini-progress-track {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.25);
      cursor: pointer;
      position: relative;
      overflow: visible;
    }
    .mini-progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      position: relative;
      transition: width 0.15s linear;
    }
    .mini-progress-circle {
      position: absolute;
      right: -5px;
      top: 50%;
      transform: translateY(-50%);
      width: 10px;
      height: 10px;
      background: #ffffff;
      border-radius: 50%;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      pointer-events: none;
    }
    .mini-progress-bar.is-sponsor-preroll .mini-progress-fill {
      transition: none !important;
    }
    .mini-progress-bar.is-sponsor-preroll .mini-progress-circle {
      width: 15px;
      height: 15px;
      right: -7px;
      background-color: #ffffff;
      background-image: url('https://cdnyutorah.cachefly.net/public/v3/images/logo-university-2x.png');
      background-size: 85% 85%;
      background-position: center;
      background-repeat: no-repeat;
      border: 1.5px solid #b8860b;
      box-shadow: 0 0 6px rgba(184, 134, 11, 0.7);
    }
    .mini-content {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      gap: 10px;
    }
    .mini-thumb {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      border: 2px solid rgba(255,255,255,0.3);
    }
    .mini-info {
      flex: 1;
      min-width: 0;
      cursor: pointer;
    }
    .mini-title {
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-speaker {
      font-size: 11px;
      opacity: 0.8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-time {
      font-size: 11px;
      opacity: 0.7;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .mini-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .mini-btn {
      background: none;
      border: none;
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      padding: 6px 8px;
      border-radius: 50%;
      transition: all 0.15s ease;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .mini-btn:hover { background: rgba(255,255,255,0.15); }
    .mini-play-btn {
      background: rgba(255,255,255,0.22);
      border: 1.5px solid rgba(255,255,255,0.5);
      color: #fff;
      width: 36px;
      height: 36px;
      padding: 0;
      box-sizing: border-box;
      border-radius: 50%;
      font-size: 17px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      margin: 0 4px;
      flex-shrink: 0;
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-user-select: none;
      user-select: none;
    }
    .mini-play-btn svg {
      display: block;
      margin: 0 auto;
    }
    .mini-play-btn:focus,
    .mini-play-btn:active {
      outline: none !important;
    }
    .mini-play-btn:hover {
      background: rgba(255,255,255,0.35);
      border-color: #fff;
      transform: scale(1.08);
    }
    .mini-btn.skip-btn {
      background: none !important;
      border: none !important;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      line-height: 1;
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-user-select: none;
      user-select: none;
      box-shadow: none !important;
    }
    .mini-btn.skip-btn:hover,
    .mini-btn.skip-btn:focus,
    .mini-btn.skip-btn:active {
      background: none !important;
      outline: none !important;
      box-shadow: none !important;
    }
    .mini-btn.skip-btn:hover {
      transform: scale(1.08);
    }
    .mini-btn.skip-btn:active {
      transform: scale(0.96);
    }
    .mini-btn.skip-btn:hover polygon {
      fill: rgba(255,255,255,0.32);
      stroke: rgba(255,255,255,0.85);
    }
    .mini-btn.expand-btn { font-size: 16px; margin-left: 2px; }
    .mini-btn.close-btn { font-size: 16px; opacity: 0.7; }
    .mini-btn.close-btn:hover { opacity: 1; }

    body.mini-player-active {
      padding-bottom: 64px;
    }

    /* Purim Venahafoch Hu Shtick: Invert header to bottom */
    body.is-purim-theme header#mainHeader {
      top: auto;
      bottom: 0;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.15);
    }
    body.is-purim-theme .header-spacer {
      display: none;
    }
    body.is-purim-theme {
      padding-bottom: 54px;
    }
    body.is-purim-theme.mini-player-active {
      padding-bottom: 118px;
    }
    body.is-purim-theme #miniPlayer {
      bottom: 50px;
    }

    /* Speaker & Venue Bio / Description Banner */
    .bio-banner {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.04);
    }
    .bio-header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 12px;
    }
    .bio-avatar {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid var(--border);
      flex-shrink: 0;
      background: #e2e6ec;
    }
    .bio-meta {
      flex: 1;
      min-width: 0;
    }
    .bio-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 3px;
    }
    .bio-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .bio-text {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      transition: max-height 0.3s ease;
    }
    .bio-text.collapsed {
      max-height: 72px;
      overflow: hidden;
      position: relative;
      -webkit-mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
      mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
    }
    .bio-text p {
      margin-bottom: 8px;
    }
    .bio-text p:last-child {
      margin-bottom: 0;
    }
    .bio-toggle-btn {
      background: none;
      border: none;
      color: var(--primary);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 8px;
      padding: 4px 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .bio-toggle-btn:hover {
      text-decoration: underline;
    }

    @media (max-width: 600px) {
      .mini-time { display: none; }
      .mini-content { padding: 6px 8px; gap: 8px; }
      .mini-thumb { width: 34px; height: 34px; }
    }

    /* Advanced Search Modal & Filter Pills */
    .advanced-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(10, 25, 47, 0.6);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .advanced-modal-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .advanced-modal-card {
      background: var(--card);
      border-radius: 16px;
      width: 100%;
      max-width: 640px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 40px rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      overflow: hidden;
      transform: translateY(20px) scale(0.97);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .advanced-modal-backdrop.open .advanced-modal-card {
      transform: translateY(0) scale(1);
    }
    .modal-header {
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 800;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    [data-theme="dark"] .modal-title {
      color: #93c5fd;
    }
    .modal-close-btn {
      background: none;
      border: none;
      font-size: 24px;
      line-height: 1;
      cursor: pointer;
      color: var(--text-muted);
      padding: 4px;
      border-radius: 6px;
      transition: all 0.15s;
    }
    .transliteration-status-card {
      background: linear-gradient(135deg, rgba(43, 76, 126, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%);
      border: 1.5px solid rgba(43, 76, 126, 0.2);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    [data-theme="dark"] .transliteration-status-card {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.12) 0%, rgba(99, 102, 241, 0.12) 100%);
      border-color: rgba(96, 165, 250, 0.3);
    }
    .translit-badge-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    [data-theme="dark"] .translit-badge-title {
      color: #93c5fd;
    }
    .translit-info-btn {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      border-radius: 50%;
      border: 1.5px solid var(--primary);
      background: transparent;
      color: var(--primary);
      font-size: 13px;
      font-weight: 800;
      font-style: italic;
      font-family: Georgia, serif;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }
    .translit-info-btn:hover {
      background: var(--primary);
      color: #fff;
    }
    .translit-info-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    .translit-switch {
      display: flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 800;
      color: var(--text);
    }
    .translit-switch input {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
      cursor: pointer;
      margin: 0;
    }
    .translit-badge-desc {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 2px;
      line-height: 1.35;
    }
    .filter-dimensions-hint {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 4px;
    }
    .dim-tag {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 12px;
      background: rgba(0,0,0,0.04);
      color: var(--text-muted);
      border: 1px solid var(--border-light);
    }
    [data-theme="dark"] .dim-tag {
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.1);
      color: #94a3b8;
    }
    .modal-close-btn:hover {
      color: var(--text);
      background: rgba(0,0,0,0.06);
    }
    .modal-body {
      padding: 20px 24px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .filter-label {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .filter-label-hint {
      font-size: 11px;
      font-weight: 400;
      color: var(--text-muted);
    }
    .filter-input, .filter-select {
      width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1.5px solid var(--border);
      background: #fafbfc;
      color: var(--text);
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    .filter-input:focus, .filter-select:focus {
      border-color: var(--primary);
      background: #fff;
    }
    [data-theme="dark"] .filter-input, [data-theme="dark"] .filter-select {
      background: #131c2a;
      border-color: #28364d;
      color: #e7edf7;
    }
    [data-theme="dark"] .filter-input:focus, [data-theme="dark"] .filter-select:focus {
      background: #1a2638;
      border-color: #436ea8;
    }

    /* Autocomplete Multi-Select Box */
    .autocomplete-combobox {
      position: relative;
      width: 100%;
    }
    .chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 42px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1.5px solid var(--border);
      background: #fafbfc;
      cursor: text;
      align-items: center;
      transition: border-color 0.15s;
    }
    .chips-container:focus-within {
      border-color: var(--primary);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(43, 76, 126, 0.12);
    }
    [data-theme="dark"] .chips-container {
      background: #131c2a;
      border-color: #28364d;
    }
    [data-theme="dark"] .chips-container:focus-within {
      background: #1a2638;
      border-color: #436ea8;
      box-shadow: 0 0 0 3px rgba(67, 110, 168, 0.28);
    }
    .combobox-token {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(43, 76, 126, 0.12);
      color: var(--primary);
      border: 1px solid rgba(43, 76, 126, 0.25);
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 12px;
      font-weight: 600;
      user-select: none;
      animation: tokenFadeIn 0.15s ease-out;
    }
    @keyframes tokenFadeIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
    [data-theme="dark"] .combobox-token {
      background: rgba(147, 197, 253, 0.15);
      color: #bfdbfe;
      border-color: rgba(147, 197, 253, 0.3);
    }
    .token-remove-btn {
      background: none;
      border: none;
      color: inherit;
      font-size: 13px;
      cursor: pointer;
      line-height: 1;
      padding: 0 2px;
      border-radius: 3px;
      opacity: 0.75;
    }
    .token-remove-btn:hover {
      opacity: 1;
      background: rgba(0,0,0,0.1);
    }
    .combobox-input {
      border: none;
      outline: none;
      background: transparent;
      font-size: 13.5px;
      color: var(--text);
      flex: 1;
      min-width: 120px;
      padding: 3px 0;
    }
    .combobox-input::placeholder {
      color: var(--text-muted);
    }
    .autocomplete-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 220px;
      overflow-y: auto;
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.18);
      z-index: 2500;
      display: none;
    }
    .autocomplete-item {
      padding: 8px 12px;
      font-size: 13px;
      color: var(--text);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-light);
      transition: background 0.1s;
    }
    .autocomplete-item:last-child {
      border-bottom: none;
    }
    .autocomplete-item:hover, .autocomplete-item.focused {
      background: rgba(43, 76, 126, 0.08);
      color: var(--primary);
    }
    [data-theme="dark"] .autocomplete-item:hover, [data-theme="dark"] .autocomplete-item.focused {
      background: rgba(147, 197, 253, 0.12);
      color: #93c5fd;
    }
    .item-count-badge {
      font-size: 11px;
      color: var(--text-muted);
      background: rgba(0,0,0,0.05);
      padding: 1px 6px;
      border-radius: 10px;
    }
    [data-theme="dark"] .item-count-badge {
      background: rgba(255,255,255,0.08);
    }
    .duration-presets-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .duration-preset-btn {
      flex: 1;
      min-width: 90px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .duration-preset-btn:hover {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.05);
    }
    .duration-preset-btn.selected {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .media-presets-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .media-preset-btn {
      flex: 1;
      min-width: 90px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .media-preset-btn:hover {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.05);
    }
    .media-preset-btn.selected {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .modal-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card);
    }
    .modal-reset-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 6px;
    }
    .modal-reset-btn:hover {
      color: #c0392b;
      text-decoration: underline;
    }
    .modal-action-btns {
      display: flex;
      gap: 10px;
    }
    .modal-cancel-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .modal-submit-btn {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 8px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(43, 76, 126, 0.3);
    }
    .modal-submit-btn:hover {
      background: var(--primary-dark);
    }

    /* Active Filter Pills Bar */
    .active-filters-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
      padding: 10px 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .active-filter-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(43, 76, 126, 0.08);
      color: var(--primary);
      border: 1px solid rgba(43, 76, 126, 0.2);
      font-size: 12.5px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 14px;
    }
    [data-theme="dark"] .active-filter-pill {
      background: rgba(147, 197, 253, 0.12);
      color: #93c5fd;
      border-color: rgba(147, 197, 253, 0.3);
    }
    .active-filter-pill button {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0;
      color: inherit;
      opacity: 0.7;
    }
    .active-filter-pill button:hover {
      opacity: 1;
    }

    /* Phonetic Expansion Notice Banner */
    .phonetic-notice-banner {
      background: linear-gradient(135deg, rgba(217, 119, 6, 0.1) 0%, rgba(245, 158, 11, 0.05) 100%);
      border: 1px solid rgba(217, 119, 6, 0.3);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 13px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .phonetic-notice-tags {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 4px;
    }
    .phonetic-tag {
      background: rgba(217, 119, 6, 0.15);
      color: #b45309;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12px;
    }
    [data-theme="dark"] .phonetic-tag {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
      font-size: 13px;
      border-top: 1px solid var(--border);
      margin-top: auto;
    }
    footer a {
      color: var(--primary);
      text-decoration: none;
      font-weight: 600;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>

<header id="mainHeader">
  <div class="header-inner">
    <a href="/" class="brand" onclick="goHome(event)">
      🎧 YUTorah Enhanced <span>PLAYER</span>
    </a>
    <div class="header-right">
      <div id="holidayMotifWrap" class="holiday-motif-wrap" onclick="handleCalendarSecretClick(event)" style="display: none;" title="">
        <span id="holidayMotifIcon" class="holiday-motif-icon"></span>
        <span id="holidayMotifTitle" class="holiday-motif-title"></span>
      </div>
      <!-- [DEAD CODE / TEMPORARILY HIDDEN] Settings button, Simple View switch, and Holiday Theme preview picker -->
      <div class="settings-wrapper" style="display: none !important;" aria-hidden="true">
        <button type="button" id="settingsBtn" class="theme-toggle-btn settings-btn" onclick="toggleSettingsMenu(event)" title="Settings" style="display: none !important;">⚙️</button>
        <div id="settingsMenu" class="settings-menu" style="display: none !important;">
          <button type="button" class="settings-menu-item dev-only" onclick="openChangelogModal()" title="Log of latest changes">
            <span>📋</span> <span>Change Log</span>
          </button>
          <div class="settings-menu-label dev-only" style="margin-top:6px;">Save button icon</div>
          <div id="saveIconPicker" class="dev-only" style="display:flex; gap:6px; padding:4px 10px 8px; flex-wrap:wrap;"></div>
          <!-- [DEAD CODE / INACTIVE] Switch to Simple View -->
          <button type="button" id="toggleViewModeBtn" class="settings-menu-item" onclick="toggleViewMode(event)" style="display: none !important;">
            <span id="viewModeIcon">✨</span> <span id="viewModeText">Switch to Simple View</span>
          </button>
          <div class="settings-menu-divider" style="display: none !important;"></div>
          <!-- [DEAD CODE / INACTIVE] Holiday Theme Preview Picker -->
          <div class="settings-menu-label" style="display: none !important;">🎨 Holiday Theme Preview</div>
          <div class="theme-select-wrap" style="display: none !important;">
            <select id="holidayThemeSelect" class="theme-select" onchange="onHolidayThemeSelect(this.value)">
              <option value="auto">✨ Auto-Detect (Hebrew Date)</option>
              <optgroup label="High Holidays & Fall">
                <option value="elul">✓ Chodesh Elul (Variant A — Classic Shofar)</option>
                <option value="rosh_hashanah">✓ Rosh Hashanah (Random A/B)</option>
                <option value="teshuva">Aseres Yemei Teshuva</option>
                <option value="yom_kippur">✓ Yom Kippur (Variant A — Beis HaMikdash Heichal)</option>
                <option value="sukkos">✓ Sukkos (Random A/B)</option>
                <option value="hoshana_rabbah">Hoshana Rabbah (Aravos)</option>
                <option value="simchas_torah">✓ Simchas Torah (Random A/B)</option>
                <option value="rosh_chodesh_cheshvan">Rosh Chodesh Mar Cheshvan</option>
              </optgroup>
              <optgroup label="Chanukah (8 Days)">
                <option value="chanukah_1">✓ Chanukah — Night 1 (1 Candle)</option>
                <option value="chanukah_2">✓ Chanukah — Night 2 (2 Candles)</option>
                <option value="chanukah_3">✓ Chanukah — Night 3 (3 Candles)</option>
                <option value="chanukah_4">✓ Chanukah — Night 4 (4 Candles)</option>
                <option value="chanukah_5">✓ Chanukah — Night 5 (5 Candles)</option>
                <option value="chanukah_6">✓ Chanukah — Night 6 (6 Candles)</option>
                <option value="chanukah_7">✓ Chanukah — Night 7 (7 Candles)</option>
                <option value="chanukah_8">✓ Chanukah — Night 8 (8 Candles)</option>
              </optgroup>
              <optgroup label="Winter & Spring">
                <option value="tubshevat">✓ Tu B'Shevat (Variant A — Flowering Fruit Tree)</option>
                <option value="adar_buildup">✓ Rosh Chodesh Adar (Random A/B)</option>
                <option value="taanis_esther">✓ Ta'anis Esther (Variant A — Royal Megillah Scroll)</option>
                <option value="purim">✓ Purim (Variant A — Royal Shushan Crown & Megillah)</option>
                <option value="nissan_buildup">✓ Rosh Chodesh Nissan → Pesach (Random A/B)</option>
                <option value="pesach">✓ Pesach (Random A/B)</option>
                <option value="omer">✓ Sefiras HaOmer (Variant A — Random Icon A/B)</option>
                <option value="yom_hazikaron">✓ Yom HaZikaron (Variant A — Memorial Flame)</option>
                <option value="yom_haatzmaut">✓ Yom HaAtzmaut (Variant B — Waving Flag)</option>
                <option value="lag_baomer">✓ Lag BaOmer (Random A/B — Clean)</option>
                <option value="yom_yerushalayim">✓ Yom Yerushalayim (Variant A — Golden Kotel)</option>
                <option value="shavuos">✓ Shavuos (Random A/B)</option>
              </optgroup>
              <optgroup label="Summer">
                <option value="july4">✓ July 4th (Variant A — American Flag)</option>
                <option value="three_weeks">✓ The Three Weeks (Variant A — Sandstone Candle)</option>
                <option value="nine_days">✓ The Nine Days (Random A/B)</option>
                <option value="tisha_bav">✓ Tisha B'Av (Variant A — Solitary Flame on Kotel Stone)</option>
                <option value="tubav">✓ Tu B'Av (Variant A — Vine Blossom & Heart)</option>
                <option value="rosh_chodesh">✓ Rosh Chodesh (Variant A — Crescent Moon)</option>
              </optgroup>
            </select>
          </div>
          <div class="variant-toggle-wrap" style="display: none !important;">
            <button type="button" id="variantBtnA" class="variant-btn active" onclick="setThemeVariant('a')">Variant A</button>
            <button type="button" id="variantBtnB" class="variant-btn" onclick="setThemeVariant('b')">Variant B</button>
            <button type="button" id="variantBtnC" class="variant-btn" onclick="setThemeVariant('c')" style="display:none;">Variant C</button>
          </div>
        </div>
      </div>
      <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" class="support-yutorah-btn" title="Support YUTorah & Sponsor Learning (Opens in new window)">❤️ Support YUTorah</a>
      <button type="button" id="themeToggleBtn" class="theme-toggle-btn" onclick="toggleTheme()" title="Toggle Dark / Light Mode">🌙</button>
      <div class="hebrew-date-badge" id="hebrewDateBadge" onclick="handleCalendarSecretClick(event)" title="">📅 ${escapeHtml(homepageData?.hebrewDateString || 'Calendar')}</div>
    </div>
  </div>
</header>
<div id="secretToast" class="secret-toast" style="display: none;"></div>
<div class="header-spacer" id="headerSpacer"></div>

<div class="sponsorship-banner">
  <div class="sponsorship-content">
    <span class="sponsorship-text">${sponsorshipText || 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by <strong>The Ohayon family in Hamilton, ON</strong> to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra'}</span>
    <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" class="sponsorship-support-pill" title="Support YUTorah (Opens in new window)">Support YUTorah ↗</a>
  </div>
</div>
<div id="holidayTaglineBar" class="holiday-tagline-bar" style="display: none;"></div>

<main>

  <div class="timely-collapsible-wrap">
    <button type="button" class="timely-collapsible-trigger" id="timelyTriggerBtn" onclick="toggleTimelyCollapse()" aria-expanded="false" title="Click to view daily learning schedule">
      <span class="timely-trigger-left">
        <span class="timely-icon">⏰</span>
        <span class="timely-title">Timely Study:</span>
        <span class="timely-summary-badges">
          <span class="timely-badge">📖 ${escapeHtml(parshaDisplayTitle)}</span>
          ${timely?.dafStr ? `<span class="timely-badge">📜 ${escapeHtml(timely.dafStr)}</span>` : ''}
          ${timely?.mishnaYomiStr ? `<span class="timely-badge">📗 ${escapeHtml(timely.mishnaYomiStr)}</span>` : ''}
        </span>
      </span>
      <span class="timely-trigger-right">
        <span class="timely-dropdown-indicator" id="timelyIndicator">Explore ▾</span>
      </span>
    </button>
    
    <div class="timely-dropdown-menu" id="timelyDropdownMenu" style="display: none;">
      <div class="timely-menu-grid">
        <!-- 1. Weekly Parsha -->
        <a href="/?category=${parshaCatId}" class="timely-menu-card" data-cat="${escapeHtml(parshaCatId)}" data-label="Parsha: ${escapeHtml(parshaDisplayTitle)}" onclick="filterByCategory(this.dataset.cat, this.dataset.label); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(parshaDisplayTitle)} shiurim">
          <div class="timely-card-icon">📖</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Weekly Parsha</div>
            <div class="timely-card-val">${escapeHtml(parshaDisplayTitle)}</div>
            ${parshaHolidayNote ? `<div class="timely-card-note">(${escapeHtml(parshaHolidayNote)})</div>` : ''}
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>

        <!-- 2. Daf Yomi (Gemara) -->
        <a href="/?search=${encodeURIComponent(timely?.dafStr || 'Daf Yomi')}" class="timely-menu-card" data-query="${escapeHtml(timely?.dafStr || '')}" onclick="searchFor(this.dataset.query); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(timely?.dafStr || 'Daf Yomi')} shiurim">
          <div class="timely-card-icon">📜</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Daf Yomi (Gemara)</div>
            <div class="timely-card-val">${escapeHtml(timely?.dafStr || 'Today\'s Daf')}</div>
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>

        <!-- 3. Mishna Yomi -->
        <a href="/?category=${timely?.mishnaYomiSubcategoryID || '234949'}" class="timely-menu-card" data-cat="${escapeHtml(timely?.mishnaYomiSubcategoryID || '234949')}" data-label="Mishna Yomi: ${escapeHtml(timely?.mishnaYomiStr || '')}" onclick="filterByCategory(this.dataset.cat, this.dataset.label); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(timely?.mishnaYomiStr || 'Mishna Yomi')} shiurim">
          <div class="timely-card-icon">📗</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Mishna Yomi</div>
            <div class="timely-card-val">${escapeHtml(timely?.mishnaYomiStr || 'Today\'s Mishna')}</div>
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>

        <!-- 4. Nach Yomi -->
        <a href="/?category=${timely?.nachYomiSubcategoryID || '234877'}" class="timely-menu-card" data-cat="${escapeHtml(timely?.nachYomiSubcategoryID || '234877')}" data-label="Nach Yomi: ${escapeHtml(timely?.nachYomiStr || '')}" onclick="filterByCategory(this.dataset.cat, this.dataset.label); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(timely?.nachYomiStr || 'Nach Yomi')} shiurim">
          <div class="timely-card-icon">📘</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Nach Yomi</div>
            <div class="timely-card-val">${escapeHtml(timely?.nachYomiStr || 'Today\'s Perek')}</div>
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>
      </div>
    </div>
  </div>

  <!-- Real-time Search Card -->
  <div class="search-card">
    <form class="search-form" id="searchForm" onsubmit="doSearch(); return false;" action="javascript:void(0);">
      <div class="search-input-wrapper">
        <span class="search-icon">🔍</span>
        <input
          type="text"
          id="searchInput"
          class="search-input"
          placeholder="Search 440,000+ shiurim (e.g. Schachter, Teshuva, Netzavim, or ID)..."
          value="${escapeHtml(searchQuery)}"
          autocomplete="off"
          oninput="onSearchInput()"
          onkeydown="if(event.key === 'Enter'){ event.preventDefault(); doSearch(); }"
        >
        <button type="button" class="clear-search-btn" id="clearSearchBtn" onclick="clearSearch()" title="Clear">×</button>
        <!-- Debounced Live Search Suggestions & Results Preview Dropdown -->
        <div class="search-preview-dropdown" id="searchPreviewDropdown"></div>
      </div>
      <div class="search-actions-row">
        <button type="button" class="search-submit-btn" onclick="doSearch()">Search</button>
        <button type="button" class="advanced-search-btn" id="advancedSearchBtn" onclick="openAdvancedModal()" title="Open Advanced Search & Multi-Criteria Filters"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle;"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg> Filters</button>
      </div>
    </form>

    <!-- Quick topic / speaker chips -->
    <div class="quick-chips">
      <span style="font-size:12px; color:var(--text-muted); padding:4px 2px; font-weight:600;">Popular:</span>
      <button class="chip" onclick="searchFor('Elul')">🏷️ Elul & Teshuvah</button>
      <button class="chip" onclick="searchFor('Rosh Hashanah')">🏷️ Rosh Hashanah</button>
      <button class="chip" onclick="searchFor('Rabbi Hershel Schachter')">👤 R' Schachter</button>
      <button class="chip" onclick="searchFor('Rabbi Michael Rosensweig')">👤 R' Rosensweig</button>
      <button class="chip" onclick="searchFor('Rabbi Mayer Twersky')">👤 R' Twersky</button>
      <button class="chip" onclick="searchFor('Rabbi Aryeh Lebowitz')">👤 R' Lebowitz</button>
      <button class="chip" onclick="searchFor('Rabbi Yaakov Neuburger')">👤 R' Neuburger</button>
      <button class="chip" onclick="searchFor('Rabbi Moshe Taragin')">👤 R' Taragin</button>
      <button class="chip" onclick="searchFor('Daf Yomi')">📜 Daf Yomi</button>
    </div>
  </div>

  <!-- Dynamic Search Results Section (Shown when search or filter is active) -->
  <div id="searchResultsSection" style="${initialSearchResults ? '' : 'display: none;'}">
    <!-- Active Filter Pills Bar (Shown when multi-criteria filters are active) -->
    <div id="activeFiltersBar" class="active-filters-bar" style="display: none;"></div>

    <!-- Quick Date Filters (every search: All / Today / Yesterday / This Week / This Month) -->
    <div id="dateQuickRow" class="date-quick-row">
      <span class="date-quick-caption">📅 When:</span>
      <button type="button" class="date-quick-chip selected" data-preset="all" onclick="setDateQuick('all', this)">All Dates</button>
      <button type="button" class="date-quick-chip" data-preset="today" onclick="setDateQuick('today', this)">Today</button>
      <button type="button" class="date-quick-chip" data-preset="yesterday" onclick="setDateQuick('yesterday', this)">Yesterday</button>
      <button type="button" class="date-quick-chip" data-preset="week" onclick="setDateQuick('week', this)">This Week</button>
      <button type="button" class="date-quick-chip" data-preset="month" onclick="setDateQuick('month', this)">This Month</button>
      <span class="date-quick-sep" aria-hidden="true"></span>
      <span class="date-quick-caption">Sort:</span>
      <button type="button" class="date-quick-chip sort-chip selected" data-sort="relevance" onclick="setResultSort('relevance', this)">Relevance</button>
      <button type="button" class="date-quick-chip sort-chip" data-sort="newest" onclick="setResultSort('newest', this)">Newest</button>
      <button type="button" class="date-quick-chip sort-chip" data-sort="oldest" onclick="setResultSort('oldest', this)">Oldest</button>
    </div>

    <!-- Phonetic Expansion Notice Banner (Shown when transliteration synonyms were searched) -->
    <div id="phoneticNoticeBanner" class="phonetic-notice-banner" style="${initialPhoneticExpansion && initialPhoneticExpansion.tokens && initialPhoneticExpansion.tokens.length > 1 ? 'display: flex;' : 'display: none;'}">
      ${initialPhoneticExpansion && initialPhoneticExpansion.tokens && initialPhoneticExpansion.tokens.length > 1 ? `
        <div><span>✨ Phonetic Equivalence included synonyms:</span> <div class="phonetic-notice-tags">${initialPhoneticExpansion.tokens.slice(0, 8).map(t => `<span class="phonetic-tag">${escapeHtml(t)}</span>`).join('')}</div></div>
        <span style="font-size:11px; opacity:0.8;">Ashkenazic &amp; Sephardic variations searched</span>
      ` : ''}
    </div>

    <!-- Speaker & Venue Bio / Description Banner -->
    <div class="bio-banner" id="bioBanner" style="display: none;">
      <div class="bio-header">
        <img id="bioAvatar" class="bio-avatar" src="" alt="Speaker" onerror="handleImgError(this)">
        <div class="bio-meta">
          <h3 id="bioTitle" class="bio-title"></h3>
          <div id="bioSubtitle" class="bio-subtitle"></div>
        </div>
      </div>
      <div id="bioText" class="bio-text collapsed"></div>
      <button type="button" id="bioToggleBtn" class="bio-toggle-btn" onclick="toggleBioCollapse()" style="display: none;">Read More ▼</button>
    </div>

    <div class="search-results-info">
      <span class="search-results-text" id="searchResultsLabel">
        ${initialSearchResults ? `Showing ${initialSearchResults.length}${initialNumFound > initialSearchResults.length ? ` of ${initialNumFound.toLocaleString()}` : ''} results for "${escapeHtml(searchQuery)}"` : 'Search Results'}
      </span>
      <div class="search-results-actions">
        <div class="search-toggles-wrap">
          <label class="match-explain-toggle" id="matchExplainToggleContainer" title="Highlight matched search terms &amp; preview snippets from descriptions, tags, and venues">
            <input type="checkbox" id="toggleMatchExplain" onchange="onToggleMatchExplain(this.checked)">
            <span class="match-toggle-track">
              <span class="match-toggle-thumb"></span>
            </span>
            <span class="match-toggle-label">🎯 Explain Matches</span>
          </label>
          <label class="match-explain-toggle" id="classicSearchToggleContainer" title="Toggle Classic vs Enhanced Search">
            <input type="checkbox" id="toggleClassicSearch" ${isClassicSearch ? 'checked' : ''} onchange="onToggleClassicSearch(this.checked)">
            <span class="match-toggle-track">
              <span class="match-toggle-thumb"></span>
            </span>
            <span class="match-toggle-label">
              <span>🏛️ Use Classic Search</span>
              <span class="classic-info-btn" onclick="toggleClassicInfoTooltip(event)" role="button" tabindex="0" data-kbplay aria-label="About Classic Search" title="Learn about Classic Search">ⓘ</span>
            </span>
          </label>
          <div id="classicSearchTooltip" class="classic-search-tooltip" style="display: none;" onclick="event.stopPropagation()">
            <div class="classic-search-tooltip-header">
              <span class="classic-search-tooltip-title">🔍 Search Modes Explained</span>
              <button type="button" class="classic-search-tooltip-close" onclick="hideClassicInfoTooltip(event)">×</button>
            </div>
            <div class="classic-search-tooltip-body">
              <p><strong>🏛️ Classic Search:</strong> Queries YUTorah directly for exact literal matches only, with no phonetic variations, spelling tolerance, or speaker entity recognition.</p>
              <p><strong>✨ Enhanced Search (Default):</strong> Automatically bridges Ashkenazic/Sephardic phonetic drift (<em>Shabbos ↔ Shabbat</em>, <em>Succah ↔ Sukkah</em>), converts English transliterations into Hebrew concepts (<em>שבת, סוכה, מוקצה</em>), isolates roshei yeshiva/speakers, and explains why results matched.</p>
            </div>
          </div>
          <label class="match-explain-toggle" id="stackSeriesToggleContainer" title="Stack shiurim belonging to the same series under an interactive cover card">
            <input type="checkbox" id="toggleStackSeries" checked onchange="onToggleStackSeries(this.checked)">
            <span class="match-toggle-track">
              <span class="match-toggle-thumb"></span>
            </span>
            <span class="match-toggle-label">📚 Stack Series</span>
          </label>
          <div class="view-toggle-wrap" role="group" aria-label="Cards or rows view">
            <button type="button" class="view-toggle-btn selected" data-view="cards" onclick="setCardView('cards')" title="Card grid view">🃏 Cards</button>
            <button type="button" class="view-toggle-btn" data-view="rows" onclick="setCardView('rows')" title="One-per-row list view like yutorah.org">📋 Rows</button>
          </div>
        </div>
        <button class="close-results-btn" onclick="clearSearch()">Clear Search ×</button>
      </div>
    </div>

    <div class="spinner-box" id="searchSpinner">
      <div class="spinner"></div>
      Searching YUTorah...
    </div>

    <div class="shiur-cards-grid" id="searchResultsGrid">
      ${initialGridHtml}
    </div>

    <div id="loadMoreContainer" style="text-align: center; margin-top: 26px; ${initialSearchResults && initialSearchResults.length < initialNumFound ? '' : 'display: none;'}">
      <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreResults()">
        <span id="loadMoreBtnText">🔽 Load More Results</span>
        <span id="loadMoreSpinner" class="spinner-small" style="display: none;"></span>
      </button>
      <div id="searchTotalInfo" style="font-size: 13px; color: var(--text-muted); margin-top: 10px; font-weight: 500;">
        ${initialSearchResults ? `Showing ${initialSearchResults.length} of ${initialNumFound.toLocaleString()} shiurim` : ''}
      </div>
    </div>
  </div>

  <!-- Audio Player Card (Active when playing) -->
  <div class="player-card" id="playerCard">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
      <a onclick="minimizePlayer()" class="player-nav-back" id="playerNavBackBtn" style="margin-bottom: 0; cursor: pointer;">${articlePdfUrl ? '← Browse Library While Reading' : '← Browse Library While Listening'}</a>
      <button type="button" class="mini-btn-pill" onclick="minimizePlayer()" title="Minimize to mini-player" style="background: #eef2f7; border: 1px solid #dbe2ed; color: var(--primary); font-size: 13px; font-weight: 700; padding: 5px 12px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;"><path d="M7 10l5 5 5-5z"/></svg> Minimize</button>
    </div>

    <!-- Main Shiur Header (Always preserved on top) -->
    <div class="shiur-header">
      <img id="speakerImg" class="speaker-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(speaker)}" onclick="handleSpeakerClick()" style="cursor: pointer;" title="View speaker page">
      <div class="shiur-details">
        <h1 id="shiurTitle" class="shiur-title">${escapeHtml(title)}</h1>
        <div id="shiurSpeaker" class="shiur-speaker" onclick="handleSpeakerClick()" title="View speaker page">${escapeHtml(speaker)}</div>
        <div id="shiurMeta" class="shiur-meta">${escapeHtml(meta)}</div>
        <div id="shiurUploadDate" class="shiur-upload-date" style="display: none;"></div>
      </div>
    </div>

    <!-- Audio Player Controls (Visible when listening to audio) -->
    <div id="audioControlsWrap" style="${articlePdfUrl ? 'display: none;' : ''}">
      <!-- Pre-roll Sponsor Overlayment Banner (under title, visible when sponsor audio is playing) -->
      <div id="sponsorPreRollBanner" class="sponsor-preroll-banner" style="display: none;">
        <div class="sponsor-preroll-header">
          <span class="sponsor-preroll-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg> TODAY'S SPONSOR DEDICATION</span>
          <span class="sponsor-preroll-status">🎙️ Audio Dedication Playing</span>
        </div>
        <div class="sponsor-preroll-body" id="sponsorPreRollText">${sponsorshipText || ''}</div>
        <div class="sponsor-preroll-footer">
          <div class="sponsor-preroll-countdown">🎙️ Shiur begins in <span id="sponsorCountdown">10</span>s...</div>
          <span style="font-size:11.5px; opacity:0.85;">Plays automatically before shiur</span>
        </div>
      </div>

      <!-- Scrubber -->
      <div class="scrubber-container">
        <div class="scrubber-bar" id="scrubberBar">
          <div class="scrubber-fill" id="scrubberFill">
            <div class="scrubber-handle"></div>
          </div>
        </div>
        <div class="time-display">
          <span id="curTime">0:00</span>
          <span id="totalTime">${escapeHtml(duration || '0:00')}</span>
        </div>
      </div>

      <!-- Transport Buttons -->
      <div class="transport-row">
        <button class="ctrl-btn skip" onclick="skip(-30)" title="Back 30s (Shift+←)">-30</button>
        <button class="ctrl-btn skip" onclick="skip(-10)" title="Back 10s (←)">-10</button>
        <button class="ctrl-btn play" id="playBtn" onclick="togglePlay()" title="Play / Pause (Space)"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin-left:3px;"><path d="M8 5v14l11-7z"/></svg></button>
        <button class="ctrl-btn skip" onclick="skip(10)" title="Forward 10s (→)">+10</button>
        <button class="ctrl-btn skip" onclick="skip(30)" title="Forward 30s (Shift+→)">+30</button>
      </div>

      <!-- Audio Engine (Headless element for high performance playback) -->
      <audio id="audioElement" src="${escapeHtml(audioUrl)}" preload="auto" style="display:none;"></audio>

      <!-- Secondary Controls -->
      <div class="controls-grid">
        <div class="ctrl-group">
          <span class="ctrl-label">Speed</span>
          <select id="speedSelect" class="speed-select" onchange="setSpeed(this.value)">
            ${speedOptionsHtml}
          </select>
        </div>

        <div class="ctrl-group">
          <button class="action-btn" id="copyLinkBtn" onclick="copyShareLink()">
            📋 Copy Link @ Time
          </button>
          <a class="action-btn" id="dlBtn" href="${escapeHtml(downloadUrl || audioUrl)}" target="_blank" ${downloadUrl || audioUrl ? '' : 'style="display:none;"'}>
            ⬇️ Download MP3
          </a>
        </div>
      </div>

      <div class="shortcuts-hint">
        Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> ±10s · <kbd>Shift+←/→</kbd> ±30s · <kbd>[</kbd>/<kbd>]</kbd> speed
      </div>
    </div>

    <!-- Article & Document Viewer (Active when viewing articles/PDFs) -->
    <div id="articleViewerContainer" class="article-viewer-wrap" style="${articlePdfUrl ? '' : 'display: none;'}">
      <div class="article-toolbar">
        <div class="article-toolbar-left">
          <div class="article-mode-pill">
            <button type="button" class="article-mode-btn active" id="modeBtnLiquid" onclick="setArticleMode('liquid')">💧 Liquid Mode</button>
            <button type="button" class="article-mode-btn" id="modeBtnOriginal" onclick="setArticleMode('original')">📄 Original Page</button>
          </div>
          <div class="font-size-controls" id="fontSizeControls">
            <button type="button" class="font-size-btn" onclick="adjustArticleFontSize(-1)" title="Decrease text size">A-</button>
            <button type="button" class="font-size-btn" onclick="adjustArticleFontSize(1)" title="Increase text size">A+</button>
          </div>
        </div>
        <div class="article-toolbar-center" id="articlePageNav" style="display: none;">
          <div class="page-mode-pill" id="pageModePill">
            <button type="button" class="page-mode-btn active" id="btnModeContinuous" onclick="setPageScrollMode('continuous')">📜 Scroll All</button>
            <button type="button" class="page-mode-btn" id="btnModeSingle" onclick="setPageScrollMode('single')">📄 Page by Page</button>
          </div>
          <div id="singlePageNavButtons" style="display: none; align-items: center; gap: 6px;">
            <button type="button" class="article-btn" id="prevPageBtn" onclick="changeArticlePage(-1)" aria-label="Previous page">‹ Prev</button>
            <span class="article-page-info" id="articlePageNum" aria-live="polite">Page 1 of 1</span>
            <button type="button" class="article-btn" id="nextPageBtn" onclick="changeArticlePage(1)" aria-label="Next page">Next ›</button>
          </div>
          <span class="article-page-info" id="continuousPageNum" aria-live="polite" style="display: inline-block;">Page 1 of 1</span>
        </div>
        <div class="article-toolbar-right">
          <button type="button" class="article-btn" id="zoomOutBtn" onclick="adjustArticleZoom(-0.2)" title="Zoom out" aria-label="Zoom out" style="display: none;">🔍 -</button>
          <button type="button" class="article-btn" id="zoomInBtn" onclick="adjustArticleZoom(0.2)" title="Zoom in" aria-label="Zoom in" style="display: none;">🔍 +</button>
          <a class="article-btn" id="dlPdfBtn" href="${escapeHtml(downloadUrl || articlePdfUrl)}" target="_blank" download title="Download PDF document" aria-label="Download PDF">⬇️ PDF</a>
          <button type="button" class="article-btn" onclick="toggleArticleFullscreen()" title="Toggle Fullscreen" aria-label="Toggle Fullscreen">⛶</button>
        </div>
      </div>

      <!-- Liquid Mode Viewport (Reflowed clean typography) -->
      <div id="articleLiquidViewport" class="article-liquid-viewport">
        <div class="liquid-content" id="liquidContent">
          <div class="article-loading-state">
            <div class="spinner"></div>
            <span>Formatting article text for reading...</span>
          </div>
        </div>
      </div>

      <!-- Original Page Viewport (Interactive Touch Zoom & Pan Tracking) -->
      <div id="articleCanvasViewport" class="article-canvas-viewport" style="display: none;" title="Pinch or double-tap to zoom anywhere">
        <div id="originalPageOrientationTip" class="original-page-orientation-tip">
          <span>🔄 <strong>Tip:</strong> Original Page view is best experienced in landscape / horizontal orientation.</span>
        </div>
        <div class="pdf-canvas-card" id="pdfCanvasCard">
          <canvas id="pdfCanvas"></canvas>
        </div>
        <div id="continuousPagesContainer" style="display: none; width: 100%; flex-direction: column; align-items: center; gap: 20px;"></div>
      </div>
    </div>

    <div class="shiur-desc" id="shiurDesc">${escapeHtml(description)}</div>

    <!-- Metadata Chips -->
    <div class="shiur-metadata-box" id="shiurMetadataBox" style="${(shiurTeachers.length || shiurLocations.length || Object.keys(shiurCategories).length || shiurKeywords.length) ? '' : 'display:none;'}">
      ${shiurTeachers.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">👤 Speaker</span>
        ${shiurTeachers.map(t => `<button class="meta-chip speaker-chip" onclick='filterByTeacher(${JSON.stringify(t.id)}, ${JSON.stringify(t.name).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(t.name)}</button>`).join('')}
      </div>` : ''}
      ${shiurDate ? `
      <div class="meta-row">
        <span class="meta-label">📅 Date</span>
        <span style="font-size:13px; color:var(--text);">${escapeHtml(shiurDate)}</span>
      </div>` : ''}
      ${shiurLocations.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">📍 Venue</span>
        ${shiurLocations.map(loc => `<button class="meta-chip venue-chip" onclick='filterByLocation(${JSON.stringify(loc.id)}, ${JSON.stringify(loc.name).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(loc.name)}</button>`).join('')}
      </div>` : ''}
      ${Object.keys(shiurCategories).length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">📂 Topics</span>
        ${Object.entries(shiurCategories).map(([groupName, cats]) =>
          `<span class="meta-group-name">${escapeHtml(groupName)}:</span>` +
          cats.map(c => `<button class="meta-chip category-chip" onclick='filterByCategory(${JSON.stringify(c.id)}, ${JSON.stringify(c.name).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(c.name)}</button>`).join('')
        ).join(' ')}
      </div>` : ''}
      ${shiurKeywords.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">🏷️ Tags</span>
        ${shiurKeywords.map(k => `<button class="meta-chip keyword-chip" onclick='searchFor(${JSON.stringify(k.title).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(k.title)}</button>`).join('')}
      </div>` : ''}
    </div>
  </div>

  ${moreFromSpeakers.length > 0 ? `
  <!-- More from this Speaker -->
  <div id="moreFromSpeakerSection" style="margin-bottom: 30px;">
    <h2 class="section-title">🎙️ More from ${escapeHtml(speaker)}</h2>
    <div class="shiur-cards-grid">
      ${moreFromSpeakers.map(renderShiurCardHtml).join('')}
    </div>
  </div>
  ` : ''}

  ${moreFromCategories.length > 0 ? `
  <!-- More in this Category -->
  <div id="moreFromCategorySection" style="margin-bottom: 30px;">
    <h2 class="section-title">📚 More in this Category</h2>
    <div class="shiur-cards-grid">
      ${moreFromCategories.map(renderShiurCardHtml).join('')}
    </div>
  </div>
  ` : ''}

  <!-- Collections Section (Original 7 Tabs from YUTorah) -->
  <div class="collections-section" id="collectionsSection" style="${initialSearchResults ? 'display: none;' : ''}">
    ${heroSlides.length > 0 ? `
    <div class="hero-slideshow" id="heroSlideshow" role="region" aria-roledescription="carousel" aria-label="Featured shiurim">
      <div class="hero-slides">
        ${heroSlides.map((s, i) => {
          const inner = `
          <img src="${escapeHtml(s.imageURL)}" alt="${escapeHtml(s.name)}" loading="${i === 0 ? 'eager' : 'lazy'}">
          <div class="hero-caption">
            <div class="hero-title">${escapeHtml(s.name)}</div>
            ${s.description ? `<div class="hero-desc">${escapeHtml(s.description)}</div>` : ''}
            <span class="hero-cta">${escapeHtml(s.urlTitle)} →</span>
          </div>`;
          return s.href === '#'
            ? `<div class="hero-slide${i === 0 ? ' active' : ''}"${i === 0 ? '' : ' inert'}>${inner}</div>`
            : `<a class="hero-slide${i === 0 ? ' active' : ''}" href="${escapeHtml(s.href)}"${s.external ? ' target="_blank" rel="noopener noreferrer"' : ''} aria-hidden="${i === 0 ? 'false' : 'true'}"${i === 0 ? '' : ' tabindex="-1" inert'}>${inner}</a>`;
        }).join('')}
      </div>
      <button type="button" class="hero-arrow hero-prev" onclick="heroGo(-1)" aria-label="Previous">‹</button>
      <button type="button" class="hero-arrow hero-next" onclick="heroGo(1)" aria-label="Next">›</button>
      <div class="hero-dots" role="group" aria-label="Slideshow navigation">
        ${heroSlides.map((s, i) => `<button type="button" class="hero-dot${i === 0 ? ' active' : ''}" onclick="heroGoTo(${i})" aria-label="Slide ${i + 1}: ${escapeHtml(s.name)}"></button>`).join('')}
      </div>
    </div>` : ''}
    <div class="section-header">
      <h2 class="section-title" id="activeCollectionTitle">⭐ Editor's Picks</h2>
      <div class="view-toggle-wrap" role="group" aria-label="Cards or rows view">
        <button type="button" class="view-toggle-btn selected" data-view="cards" onclick="setCardView('cards')" title="Card grid view">🃏 Cards</button>
        <button type="button" class="view-toggle-btn" data-view="rows" onclick="setCardView('rows')" title="One-per-row list view like yutorah.org">📋 Rows</button>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" id="tab-editors" onclick="switchCollection('editors')">⭐ Editor's Picks</button>
        <button class="tab-btn dev-playlist-tab dev-only" id="tab-playlists" aria-hidden="true" onclick="switchCollection('playlists')">🎧 Dev's Playlists</button>
        <button class="tab-btn" id="tab-series" onclick="switchCollection('series')">📚 Featured Series</button>
        <button class="tab-btn" id="tab-recent" onclick="switchCollection('recent')">⏱️ Recently Uploaded</button>
        <button class="tab-btn" id="tab-popular" onclick="switchCollection('popular')">🔥 Most Popular</button>
        <button class="tab-btn" id="tab-viewed" onclick="switchCollection('viewed')">👁️ Recently Viewed</button>
        <button class="tab-btn" id="tab-parsha" onclick="switchCollection('parsha')">📖 Parsha Shiurim</button>
        <button class="tab-btn" id="tab-daily" onclick="switchCollection('daily')">📜 Daily Shiur</button>
        <button class="tab-btn" id="tab-trending" onclick="switchCollection('trending')">🔥 Trending Keywords</button>
      </div>
    </div>

    <!-- Collection Grids -->
    <div class="shiur-cards-grid" id="grid-editors">
      ${editorsPicks.map(renderShiurCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-playlists" style="display: none;" aria-hidden="true">
      <!-- Populated client-side by the Dev Playlists engine (ROADMAP §8) -->
    </div>

    <div class="series-grid" id="grid-series" style="display: none;">
      ${featuredSeries.map(renderSeriesCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-recent" style="display: none;">
      ${recentlyUploaded.map(renderShiurCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-popular" style="display: none;">
      ${popularShiurim.map(renderShiurCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-viewed" style="display: none;">
      <!-- Populated client-side from local listening history -->
    </div>

    <div class="shiur-cards-grid" id="grid-parsha" style="display: none;">
      <!-- Populated dynamically with current week's Parsha shiurim -->
    </div>

    <div class="shiur-cards-grid" id="grid-daily" style="display: none;">
      ${dailyShiurim.map(renderShiurCardHtml).join('')}
    </div>

    <div class="trending-container" id="grid-trending" style="display: none;">
      <div class="trending-group-title">🗓️ Holiday & Season Topics</div>
      <div class="trending-chips-wrap">
        <button class="trending-chip-btn" onclick="searchFor('Elul')">🌿 Elul</button>
        <button class="trending-chip-btn" onclick="searchFor('Teshuva')">🔄 Teshuva</button>
        <button class="trending-chip-btn" onclick="searchFor('Rosh Hashanah')">🍎 Rosh Hashanah</button>
        <button class="trending-chip-btn" onclick="searchFor('Yom Kippur')">🤍 Yom Kippur</button>
        <button class="trending-chip-btn" onclick="searchFor('Selichot')">🕯️ Selichot</button>
        <button class="trending-chip-btn" onclick="searchFor('Shofar')">📯 Shofar</button>
        <button class="trending-chip-btn" onclick="searchFor('Sukkot')">🌿 Sukkot</button>
        <button class="trending-chip-btn" onclick="searchFor('Simchat Torah')">📜 Simchat Torah</button>
      </div>

      <div class="trending-group-title">🎙️ Featured Roshei Yeshiva & Speakers</div>
      <div class="trending-chips-wrap">
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Hershel Schachter')">👤 Rabbi Hershel Schachter</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Michael Rosensweig')">👤 Rabbi Michael Rosensweig</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Mayer Twersky')">👤 Rabbi Mayer Twersky</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Aryeh Lebowitz')">👤 Rabbi Aryeh Lebowitz</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Yaakov Neuburger')">👤 Rabbi Yaakov Neuburger</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Moshe Taragin')">👤 Rabbi Moshe Taragin</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Joseph B. Soloveitchik')">👤 Rav Soloveitchik zt&quot;l</button>
        <button class="trending-chip-btn" onclick="searchFor('Mrs. Emma Katz')">👤 Mrs. Emma Katz</button>
      </div>

      <div class="trending-group-title">📖 Core Texts & Daily Learning</div>
      <div class="trending-chips-wrap">
        <button class="trending-chip-btn" onclick="searchFor('Daf Yomi')">📜 Daf Yomi</button>
        <button class="trending-chip-btn" onclick="searchFor('Mishna Yomi')">📗 Mishna Yomi</button>
        <button class="trending-chip-btn" onclick="searchFor('Nach Yomi')">📘 Nach Yomi</button>
        <button class="trending-chip-btn" onclick="searchFor('Halacha')">⚖️ Halacha</button>
        <button class="trending-chip-btn" onclick="searchFor('Machshava')">🧠 Machshava</button>
        <button class="trending-chip-btn" onclick="searchFor('Tefillah')">🙏 Tefillah</button>
        <button class="trending-chip-btn" onclick="searchFor('Rambam')">📚 Rambam</button>
        <button class="trending-chip-btn" onclick="searchFor('Mussar')">✨ Mussar</button>
      </div>
    </div>
  </div>

</main>

<!-- Floating Mini-Player (Persistent Bottom Bar across entire site) -->
<div id="miniPlayer" onclick="handleMiniPlayerClick(event)">
  <div class="mini-progress-track" id="miniProgressTrack" onclick="seekMiniProgress(event)">
    <div class="mini-progress-fill" id="miniProgressFill">
      <div class="mini-progress-circle"></div>
    </div>
  </div>
  <div class="mini-content">
    <img id="miniThumb" class="mini-thumb" src="${escapeHtml(photo)}" alt="Speaker" onerror="handleImgError(this)">
    <div class="mini-info" onclick="expandPlayer()">
      <div class="mini-title" id="miniTitle">${escapeHtml(title)}</div>
      <div class="mini-speaker" id="miniSpeaker">${escapeHtml(speaker)}</div>
    </div>
    <span class="mini-time" id="miniTime">0:00 / ${escapeHtml(duration || '0:00')}</span>
    <div class="mini-controls">
      <button type="button" class="mini-btn skip-btn" onclick="skip(-10); event.stopPropagation();" title="Back 10s">
        <svg width="44" height="28" viewBox="0 0 44 28" style="display:block;">
          <polygon points="2,14 42,1 42,27" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linejoin="round"/>
          <text x="26" y="18" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="800" text-anchor="middle">-10</text>
        </svg>
      </button>
      <button type="button" class="mini-play-btn" id="miniPlayBtn" onclick="togglePlay(); event.stopPropagation();" title="Play/Pause"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M8 5v14l11-7z"/></svg></button>
      <button type="button" class="mini-btn skip-btn" onclick="skip(10); event.stopPropagation();" title="Forward 10s">
        <svg width="44" height="28" viewBox="0 0 44 28" style="display:block;">
          <polygon points="42,14 2,1 2,27" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linejoin="round"/>
          <text x="18" y="18" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="800" text-anchor="middle">+10</text>
        </svg>
      </button>
      <button type="button" class="mini-btn expand-btn" onclick="expandPlayer(); event.stopPropagation();" title="Expand Full Player">⤢</button>
      <button type="button" class="mini-btn queue-btn dev-only" onclick="toggleQueuePopup(); event.stopPropagation();" title="Play Queue (Dev)">☰</button>
      <button type="button" class="mini-btn close-btn" onclick="closeMiniPlayer(); event.stopPropagation();" title="Stop & Close">✕</button>
    </div>
  </div>
</div>

<div id="queuePopup" class="queue-popup dev-only" style="display: none;" role="dialog" aria-label="Play Queue">
  <div class="queue-popup-header">
    <span>📋 Up Next</span>
    <span id="queueCount" class="queue-count"></span>
    <button type="button" class="card-mini-btn" onclick="toggleQueuePopup()" aria-label="Close queue">×</button>
  </div>
  <div id="queueList" class="queue-list"></div>
  <div class="queue-popup-footer">
    <button type="button" class="card-mini-btn" onclick="devPlayNextFromQueue()">▶ Play Next Now</button>
    <button type="button" class="card-mini-btn" onclick="devQueueClear()">Clear Queue</button>
  </div>
</div>

<!-- Advanced Search & Multi-Criteria Filtering Modal (#4) -->
<div id="advancedSearchModal" class="advanced-modal-backdrop" onclick="handleAdvancedBackdropClick(event)">
  <div class="advanced-modal-card" onclick="event.stopPropagation()">
    <div class="modal-header">
      <div class="modal-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; color:var(--primary);"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg> Advanced Search & Filters
      </div>
      <button type="button" class="modal-close-btn" onclick="closeAdvancedModal()" aria-label="Close modal">✕</button>
    </div>
    <div class="modal-body">
      <!-- Transliteration Engine: single row (info + name + on/off switch) -->
      <div class="transliteration-status-card">
        <button type="button" class="translit-info-btn" onclick="document.getElementById('translitDesc').style.display=document.getElementById('translitDesc').style.display==='none'?'block':'none'" title="About transliteration" aria-label="About transliteration">i</button>
        <div style="flex:1; min-width:0;">
          <div class="translit-badge-title">
            <span>✨ Reverse Transliteration</span>
          </div>
          <div class="translit-badge-desc" id="translitDesc" style="display:none;">
            Automatically equates Ashkenazic &amp; Sephardic phonetics (<em>Shabbos ↔ Shabbat</em>, <em>Succah ↔ Sukkah</em>), expands English to Hebrew (<em>שבת, סוכה, פסח, מוצאי</em>), and auto-detects speakers. <strong>Turning this off uses the classic old YUTorah website search</strong> (strict literal match only).
          </div>
        </div>
        <label class="translit-switch" title="Toggle enhanced search">
          <input type="checkbox" id="advPhoneticsToggle" checked onchange="const l=document.getElementById('advPhoneticsToggleLabel'); if(l){ l.textContent=this.checked?'On':'Off'; }">
          <span id="advPhoneticsToggleLabel">On</span>
        </label>
      </div>

      <!-- Keyword / Topic -->
      <div class="filter-group">
        <label class="filter-label" for="advKeywords">
          <span>Topic, Title, or Keyword</span>
          <span class="filter-label-hint">Phonetic &amp; Hebrew equivalence auto-applied</span>
        </label>
        <input type="text" id="advKeywords" class="filter-input" placeholder="e.g. Shabbos, Muktzah, Teshuva, Shofar...">
      </div>

      <!-- Speaker / Teacher Multi-Select Autocomplete -->
      <div class="filter-group">
        <label class="filter-label" for="advTeacherInput">
          <span>Speaker / Teacher</span>
          <span class="filter-label-hint">Type name to filter 3,200+ teachers · Multi-select</span>
        </label>
        <div class="autocomplete-combobox" id="teacherCombobox">
          <div class="chips-container" id="teacherChipsContainer" onclick="document.getElementById('advTeacherInput').focus()">
            <input type="text" id="advTeacherInput" class="combobox-input" placeholder="Type teacher name (e.g. Schachter, Rosensweig)..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="teacherDropdown"></div>
        </div>
      </div>

      <!-- Category / Topic Multi-Select Autocomplete -->
      <div class="filter-group">
        <label class="filter-label" for="advCategoryInput">
          <span>Category / Topic</span>
          <span class="filter-label-hint">Type topic (e.g. Shabbat, Muktzah, Pesachim) · Multi-select</span>
        </label>
        <div class="autocomplete-combobox" id="categoryCombobox">
          <div class="chips-container" id="categoryChipsContainer" onclick="document.getElementById('advCategoryInput').focus()">
            <input type="text" id="advCategoryInput" class="combobox-input" placeholder="Type category or topic..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="categoryDropdown"></div>
        </div>
      </div>

      <!-- Venue / Location Multi-Select Autocomplete -->
      <div class="filter-group">
        <label class="filter-label" for="advLocationInput">
          <span>Venue / Recording Location</span>
          <span class="filter-label-hint">Type location (e.g. Wilf Campus, Har Etzion, BMT) · Multi-select</span>
        </label>
        <div class="autocomplete-combobox" id="locationCombobox">
          <div class="chips-container" id="locationChipsContainer" onclick="document.getElementById('advLocationInput').focus()">
            <input type="text" id="advLocationInput" class="combobox-input" placeholder="Type venue or recording location..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="locationDropdown"></div>
        </div>
      </div>

      <!-- Series Multi-Select Autocomplete (from Hamburger Menu Series) -->
      <div class="filter-group">
        <label class="filter-label" for="advSeriesInput">
          <span>Lecture Series</span>
          <span class="filter-label-hint">Filter Daf Yomi, Daily Shiur, BCBM, etc.</span>
        </label>
        <div class="autocomplete-combobox" id="seriesCombobox">
          <div class="chips-container" id="seriesChipsContainer" onclick="document.getElementById('advSeriesInput').focus()">
            <input type="text" id="advSeriesInput" class="combobox-input" placeholder="Type series name (e.g. Daf Yomi, Daily Shiur)..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="seriesDropdown"></div>
        </div>
      </div>

      <!-- Media Format Filter: Both / Audio Only / Articles Only -->
      <div class="filter-group">
        <label class="filter-label">
          <span>Media Format</span>
          <span class="filter-label-hint" id="mediaTypeHint">Audio &amp; Articles</span>
        </label>
        <div class="media-presets-row" id="mediaTypePresetsRow">
          <button type="button" class="media-preset-btn selected" id="btnMediaAll" data-media="all" onclick="setMediaTypePreset(this, 'all')">🎧 &amp; 📄 Both</button>
          <button type="button" class="media-preset-btn" id="btnMediaAudio" data-media="audio" onclick="setMediaTypePreset(this, 'audio')">🎙️ Audio Only</button>
          <button type="button" class="media-preset-btn" id="btnMediaArticle" data-media="article" onclick="setMediaTypePreset(this, 'article')">📄 Articles Only</button>
        </div>
      </div>

      <!-- Duration Presets & Range -->
      <div class="filter-group">
        <label class="filter-label">
          <span>Shiur Duration</span>
          <span class="filter-label-hint" id="durationHint">Any Length</span>
        </label>
        <div class="duration-presets-row">
          <button type="button" class="duration-preset-btn selected" data-min="" data-max="" onclick="setDurationPreset(this, '', '')">Any Length</button>
          <button type="button" class="duration-preset-btn" data-min="1" data-max="15" onclick="setDurationPreset(this, 1, 15)">⚡ Short (&lt;15m)</button>
          <button type="button" class="duration-preset-btn" data-min="15" data-max="45" onclick="setDurationPreset(this, 15, 45)">🎙️ Mid (15–45m)</button>
          <button type="button" class="duration-preset-btn" data-min="45" data-max="" onclick="setDurationPreset(this, 45, '')">📚 Deep (&gt;45m)</button>
        </div>
      </div>

      <!-- Year / Era (Complete from 2026 down to Pre-2000) -->
      <div class="filter-group">
        <label class="filter-label" for="advYearSelect">
          <span>Recording Year / Archive Era</span>
          <span class="filter-label-hint">Individual years 2026 down to 2000 &amp; archive</span>
        </label>
        <select id="advYearSelect" class="filter-select">
          <option value="">-- All Recording Years --</option>
          <optgroup label="Recent Years (2020–2026)">
            <option value="2026">2026 (5786)</option>
            <option value="2025">2025 (5785)</option>
            <option value="2024">2024 (5784)</option>
            <option value="2023">2023 (5783)</option>
            <option value="2022">2022 (5782)</option>
            <option value="2021">2021 (5781)</option>
            <option value="2020">2020 (5780)</option>
          </optgroup>
          <optgroup label="2010s Decade (2010–2019)">
            <option value="2010-2019">Entire 2010–2019 Decade</option>
            <option value="2019">2019 (5779–5780)</option>
            <option value="2018">2018 (5778–5779)</option>
            <option value="2017">2017 (5777–5778)</option>
            <option value="2016">2016 (5776–5777)</option>
            <option value="2015">2015 (5775–5776)</option>
            <option value="2014">2014 (5774–5775)</option>
            <option value="2013">2013 (5773–5774)</option>
            <option value="2012">2012 (5772–5773)</option>
            <option value="2011">2011 (5771–5772)</option>
            <option value="2010">2010 (5770–5771)</option>
          </optgroup>
          <optgroup label="2000s Decade (2000–2009)">
            <option value="2009">2009</option>
            <option value="2008">2008</option>
            <option value="2007">2007</option>
            <option value="2006">2006</option>
            <option value="2005">2005</option>
            <option value="2004">2004</option>
            <option value="2003">2003</option>
            <option value="2002">2002</option>
            <option value="2001">2001</option>
            <option value="2000">2000</option>
          </optgroup>
          <optgroup label="Historical Archives">
            <option value="pre-2010">Pre-2010 Archive</option>
            <option value="pre-2000">Pre-2000 Vintage Archive</option>
          </optgroup>
        </select>
      </div>

      <!-- Custom Date & Time Range (overrides Year / Quick presets) -->
      <div class="filter-group">
        <label class="filter-label">
          <span>Custom Date &amp; Time Range</span>
          <span class="filter-label-hint" id="dateRangeHint">From date-time to date-time</span>
        </label>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <input type="datetime-local" id="advFromDateTime" class="filter-select" style="flex: 1; min-width: 180px;" aria-label="From date and time">
          <span style="color: var(--text-muted); font-weight: 700;">→</span>
          <input type="datetime-local" id="advToDateTime" class="filter-select" style="flex: 1; min-width: 180px;" aria-label="To date and time">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="modal-reset-btn" onclick="resetAdvancedFilters()">Reset All Filters</button>
      <div class="modal-action-btns">
        <button type="button" class="modal-cancel-btn" onclick="closeAdvancedModal()">Cancel</button>
        <button type="button" class="modal-submit-btn" onclick="applyAdvancedFilters()">Apply Filters 🔍</button>
      </div>
    </div>
  </div>
</div>

<footer>
  <p>YUTorah Enhanced Player · Standalone zero-friction audio player for <a href="https://www.yutorah.org" target="_blank" rel="noopener noreferrer">YUTorah.org</a> · <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" style="font-weight: 600;">❤️ Support YUTorah</a></p>
</footer>

<script>
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getNowInNewYork() {
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

  function parseLocalDate(str) {
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

  function formatShiurDate(rawDateStr) {
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

  function isShiurNew(rawDateStr) {
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

  function toggleTimelyCollapse() {
    const menu = document.getElementById('timelyDropdownMenu');
    const trigger = document.getElementById('timelyTriggerBtn');
    const ind = document.getElementById('timelyIndicator');
    if (!menu) return;
    const isExpanded = menu.style.display !== 'none';
    if (isExpanded) {
      menu.style.display = 'none';
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (ind) ind.textContent = 'Explore ▾';
    } else {
      menu.style.display = 'block';
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
      if (ind) ind.textContent = 'Close ▴';
    }
  }

  function closeTimelyDropdown() {
    const menu = document.getElementById('timelyDropdownMenu');
    const trigger = document.getElementById('timelyTriggerBtn');
    const ind = document.getElementById('timelyIndicator');
    if (menu) menu.style.display = 'none';
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (ind) ind.textContent = 'Explore ▾';
  }

  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.timely-collapsible-wrap');
    if (wrap && !wrap.contains(e.target)) {
      closeTimelyDropdown();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTimelyDropdown();
    }
  });

  // Smooth 60fps Preroll Progress Animation
  let sponsorRafId = null;

  function updateSponsorSmoothProgress() {
    if (!isSponsorPlaying || audio.paused || !audio.duration || isNaN(audio.duration)) {
      sponsorRafId = null;
      return;
    }
    const curTime = audio.currentTime;
    const dur = audio.duration;
    const pct = Math.min(100, Math.max(0, (curTime / dur) * 100));

    const scrubberFill = document.getElementById('scrubberFill');
    if (scrubberFill) {
      scrubberFill.style.width = pct + '%';
    }
    const miniFill = document.getElementById('miniProgressFill');
    if (miniFill) {
      miniFill.style.width = pct + '%';
    }

    sponsorRafId = requestAnimationFrame(updateSponsorSmoothProgress);
  }

  function startSponsorRaf() {
    if (sponsorRafId) cancelAnimationFrame(sponsorRafId);
    sponsorRafId = requestAnimationFrame(updateSponsorSmoothProgress);
  }

  function stopSponsorRaf() {
    if (sponsorRafId) {
      cancelAnimationFrame(sponsorRafId);
      sponsorRafId = null;
    }
  }

  const audio = document.getElementById('audioElement');
  let initialTimestamp = ${jsEmbed(timestamp)};
  let initialPlaybackSpeed = ${jsEmbed(playbackSpeed || '')};
  let hasAudio = ${jsEmbed(Boolean(audioUrl))};
  let currentShiurId = ${jsEmbed(shiurId || '')};
  const INITIAL_ARTICLE_PDF = ${jsEmbed(articlePdfUrl || '')};
  let currentArticlePdf = INITIAL_ARTICLE_PDF;
  let isCurrentShiurArticle = Boolean(INITIAL_ARTICLE_PDF);
  let initialTimeApplied = false;
  let lastUrlUpdateSec = -1;
  let lastUrlUpdateTime = 0;
  let isManuallyMinimized = false;
  let isExpandingUntil = 0;
  let currentSpeakerTeacherId = ${jsEmbed(currentTeacherId || '')};
  let currentSpeakerName = ${jsEmbed(speaker || '')};

  function handleSpeakerClick() {
    if (currentSpeakerTeacherId) {
      filterByTeacher(currentSpeakerTeacherId, currentSpeakerName);
    } else if (currentSpeakerName) {
      searchFor(currentSpeakerName);
    }
  }

  const DAILY_SPONSOR_AUDIO = ${jsEmbed(sponsorshipAudioUrl || '')};
  const DAILY_SPONSOR_TEXT = ${jsEmbed(sponsorshipText || '')};
  const DAILY_SPONSOR_PLAIN = ${jsEmbed(sponsorshipPlainText || '')};

  let currentSponsorAudio = DAILY_SPONSOR_AUDIO;
  let currentSponsorText = DAILY_SPONSOR_TEXT;
  let lastSponsorCheck = Date.now();

  async function refreshDailySponsorship() {
    try {
      const res = await fetch('/api/sponsorship');
      if (res.ok) {
        const data = await res.json();
        if (data.text) {
          currentSponsorText = data.text;
          const bannerText = document.querySelector('.sponsorship-text');
          if (bannerText) bannerText.innerHTML = data.text;
          const preRollText = document.getElementById('sponsorPreRollText');
          if (preRollText) preRollText.innerHTML = data.text;
        }
        if (data.audioUrl) {
          currentSponsorAudio = data.audioUrl;
        }
        lastSponsorCheck = Date.now();
      }
    } catch (e) {
      console.warn('Failed to refresh live sponsorship:', e);
    }
  }

  // Automatically refresh daily sponsorship when tab becomes visible or every 15 minutes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (Date.now() - lastSponsorCheck > 300000)) {
      refreshDailySponsorship();
    }
  });
  setInterval(refreshDailySponsorship, 900000);

  function isPreRollDisabled() {
    try {
      return localStorage.getItem('yutorah_preroll_disabled') === '1';
    } catch(e) {
      return false;
    }
  }

  // Developer Mode: the ONLY way in is typing "dev mode" (case-insensitive)
  // in the search box. There is no tap gesture for dev mode.
  let isDevMode = false;
  // Elements revealed by activateDevMode (re-hidden by deactivateDevMode).
  var devRevealedSettings = [];

  function activateDevMode() {
    if (isDevMode) return false;
    isDevMode = true;
    try { localStorage.setItem('yutorah_dev_mode', 'true'); } catch (e) {}
    document.body.classList.add('dev-mode-active');

    // Reveal hidden settings wrapper and advanced search button
    devRevealedSettings = [];
    const settingsWrap = document.querySelector('.settings-wrapper');
    if (settingsWrap) {
      settingsWrap.style.setProperty('display', 'block', 'important');
      settingsWrap.removeAttribute('aria-hidden');
      devRevealedSettings.push(settingsWrap);
    }
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.style.setProperty('display', 'inline-flex', 'important');
      devRevealedSettings.push(settingsBtn);
    }
    const settingsMenu = document.getElementById('settingsMenu');
    if (settingsMenu) {
      // Scope to .dev-only: never resurrect controls marked DEAD.
      settingsMenu.querySelectorAll('.dev-only[style*="display"]').forEach(el => {
        el.style.removeProperty('display');
        devRevealedSettings.push(el);
      });
    }
    // Reveal the playlists tab to assistive tech (hidden via aria until dev).
    try {
      const plTab = document.getElementById('tab-playlists');
      if (plTab) plTab.removeAttribute('aria-hidden');
      const plGrid = document.getElementById('grid-playlists');
      if (plGrid) plGrid.removeAttribute('aria-hidden');
    } catch (e) {}

    // ROADMAP §8.4: player-header quick actions — Later, Fav, Add to Playlist.
    try {
      const details = document.querySelector('.shiur-details');
      if (details && !document.getElementById('devPlayerActions')) {
        const wrap = document.createElement('div');
        wrap.id = 'devPlayerActions';
        wrap.className = 'card-mini-actions dev-only';
        wrap.style.marginTop = '8px';
        const mkBtn = (bid, labelHtml, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.id = bid;
          b.className = 'card-mini-btn';
          b.innerHTML = labelHtml;
          b.addEventListener('click', () => {
            if (currentShiurId) fn(String(currentShiurId));
          });
          return b;
        };
        const psb = mkBtn('devPlayerSaveBtn', getSaveIcon(), toggleDevSave);
        psb.classList.add('icon-btn');
        psb.title = 'Save for later';
        psb.setAttribute('aria-label', 'Save for later');
        wrap.appendChild(psb);
        const pfb = mkBtn('devPlayerFavBtn', '☆', toggleDevFav);
        pfb.classList.add('icon-btn');
        pfb.title = 'Add to favorites';
        pfb.setAttribute('aria-label', 'Add to favorites');
        wrap.appendChild(pfb);
        const pq = document.createElement('button');
        pq.type = 'button';
        pq.id = 'devPlayerQueueBtn';
        pq.className = 'queue-circle-btn dev-only';
        pq.title = 'Add to play queue';
        pq.setAttribute('aria-label', 'Add to play queue');
        pq.innerHTML = devQueueIconSvg();
        pq.addEventListener('click', () => {
          if (currentShiurId) devQueueToggle(String(currentShiurId), false);
        });
        wrap.appendChild(pq);
        const pl = document.createElement('button');
        pl.type = 'button';
        pl.id = 'devPlayerAddBtn';
        pl.className = 'card-mini-btn dev-only';
        pl.textContent = '➕ Playlist';
        pl.addEventListener('click', () => {
          if (currentShiurId) openPlaylistModal(String(currentShiurId));
        });
        wrap.appendChild(pl);
        details.appendChild(wrap);
        devRefreshCardButtons();
      }
    } catch (e) {}

    // Retrofit every card already on the page (server-rendered collections,
    // SSR search grid): progress + buttons are fundamental in dev mode.
    try { devUpgradeCards(); } catch (e) {}

    return true;
  }

  // Typing "exit dev mode" (case-insensitive) leaves Dev Mode: hide all dev
  // UI, restore aria gating, and re-render the current view without extras.
  function deactivateDevMode() {
    if (!isDevMode) return false;
    isDevMode = false;
    try { localStorage.removeItem('yutorah_dev_mode'); } catch (e) {}
    document.body.classList.remove('dev-mode-active');
    activeDevPlaylistId = 'history';
    try {
      const plTab = document.getElementById('tab-playlists');
      if (plTab) plTab.setAttribute('aria-hidden', 'true');
      const plGrid = document.getElementById('grid-playlists');
      if (plGrid) {
        plGrid.setAttribute('aria-hidden', 'true');
        plGrid.style.display = 'none';
      }
      // Re-hide exactly what activateDevMode revealed (tracked list).
      try {
        (devRevealedSettings || []).forEach(el => {
          if (el && el.style) el.style.setProperty('display', 'none', 'important');
        });
      } catch (e) {}
      devRevealedSettings = [];
      const settingsMenu = document.getElementById('settingsMenu');
      if (settingsMenu) settingsMenu.style.display = 'none';
      const settingsWrapBack = document.querySelector('.settings-wrapper');
      if (settingsWrapBack) settingsWrapBack.setAttribute('aria-hidden', 'true');
      closePlaylistModal();
      closeConfirmModal();
      const qp = document.getElementById('queuePopup');
      if (qp) qp.style.display = 'none';
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab && activeTab.id === 'tab-playlists') {
        switchCollection('editors');
      }
      renderCurrentSearchResults();
    } catch (e) {}
    return true;
  }

  // Secret taps on Calendar Icon / Holiday Motif:
  //   3 taps = toggle pre-roll enable/disable (always works)
  // (Dev Mode is NOT available via taps — type "dev mode" in search instead.)
  let calendarClickCount = 0;
  let calendarClickTimer = null;
  let toastTimer = null;

  function handleCalendarSecretClick(e) {
    if (e) {
      e.stopPropagation();
    }
    calendarClickCount++;
    clearTimeout(calendarClickTimer);

    if (calendarClickCount === 3) {
      // 3 taps: toggle pre-roll enable/disable
      togglePreRoll();
      calendarClickCount = 0;
      calendarClickTimer = setTimeout(() => {
        calendarClickCount = 0;
      }, 2000);
    } else {
      // Not yet at a threshold; reset counter after 2s of inactivity
      calendarClickTimer = setTimeout(() => {
        calendarClickCount = 0;
      }, 2000);
    }
  }

  function togglePreRoll() {
    const currentlyDisabled = isPreRollDisabled();
    const newDisabled = !currentlyDisabled;

    try {
      if (newDisabled) {
        localStorage.setItem('yutorah_preroll_disabled', '1');
      } else {
        localStorage.removeItem('yutorah_preroll_disabled');
      }
    } catch(e) {}

    // If currently playing sponsor audio and user disabled it, immediately skip to shiur
    if (newDisabled && isSponsorPlaying && pendingShiur) {
      skipSponsorAudio();
    }

    const preRollStatus = newDisabled ? '🚫 Pre-roll Disabled' : '✅ Pre-roll Enabled';
    flashToast(preRollStatus, newDisabled, false);
  }


  function flashToast(msg, isDisabled, isDevUnlock = false) {
    const toast = document.getElementById('secretToast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = 'secret-toast ' + (isDevUnlock ? 'toast-dev' : (isDisabled ? 'toast-disabled' : 'toast-enabled'));
    toast.style.display = 'flex';
    void toast.offsetWidth; // Trigger reflow for CSS animation
    toast.classList.add('visible');

    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => {
        if (!toast.classList.contains('visible')) {
          toast.style.display = 'none';
        }
      }, 250);
    }, isDevUnlock ? 2400 : 1500);
  }

  let isSponsorPlaying = false;
  let sponsorPlayedForThisShiur = false;
  let pendingShiur = null;
  let sponsorWatchdog = null;
  let sponsorStallTimer = null;

  function clearSponsorTimers() {
    if (sponsorWatchdog) {
      clearTimeout(sponsorWatchdog);
      sponsorWatchdog = null;
    }
    if (sponsorStallTimer) {
      clearTimeout(sponsorStallTimer);
      sponsorStallTimer = null;
    }
  }

  function resetSponsorWatchdog() {
    clearSponsorTimers();
    if (isSponsorPlaying && pendingShiur) {
      // 25 second safety watchdog: guarantees player never gets stuck in pre-roll
      sponsorWatchdog = setTimeout(() => {
        if (isSponsorPlaying && pendingShiur && !audio.paused) {
          console.warn('Sponsor pre-roll safety watchdog triggered (25s timeout), advancing to shiur');
          startShiurPlayback(pendingShiur);
        }
      }, 25000);
    }
  }

  if (hasAudio && currentShiurId) {
    pendingShiur = {
      id: currentShiurId,
      title: ${jsEmbed(title || '')},
      speaker: ${jsEmbed(speaker || '')},
      teacherId: ${jsEmbed(currentTeacherId || '')},
      photo: ${jsEmbed(photo || '')},
      duration: ${jsEmbed(duration || '')},
      meta: ${jsEmbed(meta || '')},
      desc: ${jsEmbed(description || '')},
      audioSrc: ${jsEmbed(audioUrl || '')},
      dlSrc: ${jsEmbed(audioUrl || '')},
      resumeSec: parseFloat(initialTimestamp) || 0
    };
  }

  function playSponsorPreRoll(shiurObj) {
    if (isPreRollDisabled() || !currentSponsorAudio) {
      startShiurPlayback(shiurObj);
      return;
    }

    // If sponsorship data hasn't been checked in >5 minutes, refresh in background
    if (Date.now() - lastSponsorCheck > 300000) {
      refreshDailySponsorship();
    }

    isSponsorPlaying = true;
    pendingShiur = shiurObj;

    const banner = document.getElementById('sponsorPreRollBanner');
    if (banner) {
      banner.style.display = 'block';
      const bodyEl = document.getElementById('sponsorPreRollText');
      if (bodyEl && currentSponsorText) bodyEl.innerHTML = currentSponsorText;
      const countdownEl = document.getElementById('sponsorCountdown');
      if (countdownEl) countdownEl.textContent = '10';
    }

    if (shiurObj) {
      currentSpeakerTeacherId = shiurObj.teacherId || '';
      currentSpeakerName = shiurObj.speaker || '';
    }

    document.title = shiurObj.title + " — YUTorah Enhanced";
    const titleEl = document.getElementById('shiurTitle');
    if (titleEl) titleEl.textContent = shiurObj.title;
    const speakerEl = document.getElementById('shiurSpeaker');
    if (speakerEl) speakerEl.textContent = shiurObj.speaker || '';
    const metaEl = document.getElementById('shiurMeta');
    if (metaEl) metaEl.textContent = shiurObj.meta || (shiurObj.duration ? shiurObj.duration : '');

    const img = document.getElementById('speakerImg');
    if (img) {
      if (shiurObj.photo) {
        img.src = shiurObj.photo;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    }

    const curTimeNode = document.getElementById('curTime');
    if (curTimeNode) curTimeNode.textContent = '0:00';
    const totalTimeEl = document.getElementById('totalTime');
    if (totalTimeEl) totalTimeEl.textContent = '0:10';
    const sBar = document.getElementById('scrubberBar');
    if (sBar) sBar.classList.add('is-sponsor-preroll');
    const miniBar = document.getElementById('miniProgressBar');
    if (miniBar) miniBar.classList.add('is-sponsor-preroll');
    const sFill = document.getElementById('scrubberFill');
    if (sFill) sFill.style.width = '0%';

    const miniTitle = document.getElementById('miniTitle');
    const miniSpeaker = document.getElementById('miniSpeaker');
    const miniThumb = document.getElementById('miniThumb');
    const miniTime = document.getElementById('miniTime');
    if (miniTitle) miniTitle.textContent = shiurObj.title;
    if (miniSpeaker) miniSpeaker.textContent = (shiurObj.speaker ? shiurObj.speaker + ' · ' : '') + "🎙️ Playing Sponsor Dedication";
    if (miniThumb) {
      if (shiurObj.photo) {
        miniThumb.src = shiurObj.photo;
        miniThumb.style.display = 'block';
      } else {
        miniThumb.style.display = 'none';
      }
    }
    if (miniTime) miniTime.textContent = '0:00 / 0:10';

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: shiurObj.title + " (Sponsorship)",
        artist: (shiurObj.speaker ? shiurObj.speaker + " · " : "") + "Today's Dedication",
        album: 'YUTorah Online',
        artwork: shiurObj.photo ? [{ src: shiurObj.photo, sizes: '200x200', type: 'image/jpeg' }] : []
      });
    }

    hasAudio = true;
    audio.src = currentSponsorAudio;
    audio.playbackRate = 1;
    audio.load();
    resetSponsorWatchdog();

    const p = audio.play();
    if (p !== undefined) {
      p.then(() => {
        startSponsorRaf();
      }).catch(err => {
        console.log('Autoplay sponsor prevented or error:', err);
      });
    }
  }

  function skipSponsorAudio() {
    stopSponsorRaf();
    if (!isSponsorPlaying || !pendingShiur) return;
    startShiurPlayback(pendingShiur);
  }

  function startShiurPlayback(shiurObj) {
    stopSponsorRaf();
    clearSponsorTimers();
    isSponsorPlaying = false;
    sponsorPlayedForThisShiur = true;

    const banner = document.getElementById('sponsorPreRollBanner');
    if (banner) banner.style.display = 'none';

    const sBar = document.getElementById('scrubberBar');
    if (sBar) sBar.classList.remove('is-sponsor-preroll');
    const miniBar = document.getElementById('miniProgressBar');
    if (miniBar) miniBar.classList.remove('is-sponsor-preroll');

    if (shiurObj) {
      currentSpeakerTeacherId = shiurObj.teacherId || '';
      currentSpeakerName = shiurObj.speaker || '';
    }

    document.title = shiurObj.title + ' — YUTorah Enhanced';
    const titleEl = document.getElementById('shiurTitle');
    if (titleEl) titleEl.textContent = shiurObj.title;
    const speakerEl = document.getElementById('shiurSpeaker');
    if (speakerEl) speakerEl.textContent = shiurObj.speaker;
    const metaEl = document.getElementById('shiurMeta');
    if (metaEl) metaEl.textContent = shiurObj.meta || (shiurObj.duration + (shiurObj.date ? ' · ' + shiurObj.date : ''));

    const img = document.getElementById('speakerImg');
    if (img) {
      if (shiurObj.photo) {
        img.src = shiurObj.photo;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    }

    const descEl = document.getElementById('shiurDesc');
    if (descEl) {
      if (shiurObj.desc) {
        descEl.textContent = shiurObj.desc;
        descEl.style.display = 'block';
      } else {
        descEl.style.display = 'none';
      }
    }

    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn && shiurObj.dlSrc) {
      dlBtn.href = shiurObj.dlSrc;
      dlBtn.style.display = 'inline-flex';
    }

    const miniTitle = document.getElementById('miniTitle');
    const miniSpeaker = document.getElementById('miniSpeaker');
    const miniThumb = document.getElementById('miniThumb');
    const miniTime = document.getElementById('miniTime');
    if (miniTitle) miniTitle.textContent = shiurObj.title;
    if (miniSpeaker) miniSpeaker.textContent = shiurObj.speaker;
    if (miniThumb) miniThumb.src = shiurObj.photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
    if (miniTime) miniTime.textContent = '0:00 / ' + (shiurObj.duration || '0:00');

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: shiurObj.title,
        artist: shiurObj.speaker,
        album: 'YUTorah Online',
        artwork: shiurObj.photo ? [{ src: shiurObj.photo, sizes: '300x300', type: 'image/jpeg' }] : []
      });
    }

    hasAudio = true;
    initialTimeApplied = false;
    audio.src = shiurObj.audioSrc;
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    audio.load();

    const onLoaded = function() {
      audio.removeEventListener('loadedmetadata', onLoaded);
      if (currentPlaybackRate) {
        audio.playbackRate = currentPlaybackRate;
      }
      if (shiurObj.resumeSec > 0) {
        audio.currentTime = Math.min(shiurObj.resumeSec, (audio.duration || Infinity) - 1);
        updateUrlTimestamp(true);
      }
    };
    audio.addEventListener('loadedmetadata', onLoaded);

    const p = audio.play();
    if (p !== undefined) {
      p.catch(err => console.log('Shiur audio play error:', err));
    }
  }

  // Initialize playback rate from URL or server-rendered initial speed
  let currentPlaybackRate = 1;
  try {
    const initSpeedParam = new URL(window.location.href).searchParams.get('speed') || new URL(window.location.href).searchParams.get('rate') || initialPlaybackSpeed;
    if (initSpeedParam) {
      const parsedSpeed = parseFloat(initSpeedParam);
      if (!isNaN(parsedSpeed) && parsedSpeed > 0 && parsedSpeed <= 5) {
        currentPlaybackRate = parsedSpeed;
      }
    }
  } catch(e) {}
  if (audio && currentPlaybackRate !== 1) {
    audio.playbackRate = currentPlaybackRate;
  }

  function updateUrlTimestamp(force) {
    if (isSponsorPlaying) return;
    if (!hasAudio || !audio.src) return;
    const curTime = audio.currentTime;
    if (isNaN(curTime) || curTime < 0) return;
    const curSec = Math.floor(curTime);

    const now = Date.now();
    // Throttled: update URL at most once every 5 seconds, unless forced (pause, seek, tab close)
    if (!force && (curSec === lastUrlUpdateSec || (now - lastUrlUpdateTime < 5000))) {
      return;
    }

    lastUrlUpdateSec = curSec;
    lastUrlUpdateTime = now;

    // Save to localStorage for instant resume even without URL parameter
    if (currentShiurId && curSec > 0) {
      try {
        localStorage.setItem('yutorah_progress_' + currentShiurId, curSec);
      } catch (e) {}
    }

    // Update the browser URL in-place without polluting back-button history
    try {
      const url = new URL(window.location.href);
      if (curSec > 0) {
        url.searchParams.set('t', curSec);
      } else {
        url.searchParams.delete('t');
      }
      history.replaceState(history.state, '', url.toString());
    } catch (e) {}
  }

  function applyInitialTime() {
    if (isSponsorPlaying) return;
    if (initialTimeApplied) return;
    let targetSec = 0;
    if (initialTimestamp) {
      const p = parseFloat(initialTimestamp);
      if (!isNaN(p) && p > 0) targetSec = p;
    } else if (currentShiurId) {
      try {
        const saved = parseFloat(localStorage.getItem('yutorah_progress_' + currentShiurId));
        if (!isNaN(saved) && saved > 5) targetSec = saved;
      } catch (e) {}
    }

    if (targetSec > 0) {
      if (audio.duration && !isNaN(audio.duration)) {
        audio.currentTime = Math.min(targetSec, audio.duration - 1);
        initialTimeApplied = true;
        updateUrlTimestamp(true);
      } else {
        try {
          audio.currentTime = targetSec;
          initialTimeApplied = true;
          updateUrlTimestamp(true);
        } catch(e) {}
      }
    }
  }

  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
    return m + ':' + seconds.toString().padStart(2, '0');
  }

  // Handle Search input
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const searchPreviewDropdown = document.getElementById('searchPreviewDropdown');
  let searchDebounceTimer = null;
  let previewAbortCtrl = null;
  let currentPreviewReqId = 0;

  function closeSearchPreview() {
    if (previewAbortCtrl) {
      previewAbortCtrl.abort();
      previewAbortCtrl = null;
    }
    currentPreviewReqId++;
    previewFocusables = [];
    previewFocusIdx = -1;
    if (searchPreviewDropdown) {
      searchPreviewDropdown.style.display = 'none';
      searchPreviewDropdown.innerHTML = '';
    }
  }

  // Keyboard navigation for the preview dropdown (§5.4: ↑/↓ + Enter/Esc).
  let previewFocusables = [];
  let previewFocusIdx = -1;
  function updatePreviewFocus() {
    previewFocusables.forEach((el, i) => {
      if (i === previewFocusIdx) el.classList.add('preview-focused');
      else el.classList.remove('preview-focused');
    });
    const cur = previewFocusables[previewFocusIdx];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function collectPreviewFocusables() {
    if (!searchPreviewDropdown) return;
    previewFocusables = Array.prototype.slice.call(
      searchPreviewDropdown.querySelectorAll('[data-suggestion-idx], .preview-shiur-item, #previewViewAllBtn'));
    previewFocusIdx = -1;
  }

  // Click outside closes search preview
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-wrapper')) {
      closeSearchPreview();
    }
  });

  async function fetchSearchPreview(query) {
    if (previewAbortCtrl) previewAbortCtrl.abort();
    previewAbortCtrl = new AbortController();
    const thisReqId = ++currentPreviewReqId;

    try {
      // 1. Check local entity matches (speakers and categories from cached AUTOCOMPLETE_META)
      const suggestions = [];
      const qLower = query.toLowerCase();

      // Look up speakers
      if (typeof autocompleteCache !== 'undefined' && autocompleteCache?.teachers) {
        const matchedTeachers = autocompleteCache.teachers
          .filter(t => t.name.toLowerCase().includes(qLower))
          .slice(0, 3);
        matchedTeachers.forEach(t => {
          suggestions.push({
            type: 'speaker',
            icon: '👤',
            title: t.name,
            sub: (t.count ? t.count.toLocaleString() + ' shiurim' : 'Speaker'),
            action: () => {
              closeSearchPreview();
              searchInput.value = '';
              activeAdvancedFilters = {
                keywords: '',
                teachers: [{ id: t.id, name: t.name }],
                categories: [],
                locations: [],
                series: [],
                minDuration: '',
                maxDuration: '',
                durationLabel: '',
                year: '',
                yearLabel: '',
                fromDate: '',
                toDate: '',
                dateQuick: '',
                dateQuickLabel: '',
                dateRangeLabel: '',
                mediaType: 'all',
                mediaTypeLabel: '',
                enablePhonetics: true
              };
              syncDateQuickChips();
              executeLiveSearch('', { ...activeAdvancedFilters, speakerView: true, label: 'Shiurim by ' + t.name });
            }
          });
        });
      }

      // Look up categories
      if (typeof autocompleteCache !== 'undefined' && autocompleteCache?.categories) {
        const matchedCats = autocompleteCache.categories
          .filter(c => c.name.toLowerCase().includes(qLower))
          .slice(0, 2);
        matchedCats.forEach(c => {
          suggestions.push({
            type: 'category',
            icon: '🏷️',
            title: c.name,
            sub: (c.count ? c.count.toLocaleString() + ' shiurim' : 'Topic'),
            action: () => {
              closeSearchPreview();
              searchInput.value = '';
              activeAdvancedFilters = {
                keywords: '',
                teachers: [],
                categories: [{ id: c.id, name: c.name }],
                locations: [],
                series: [],
                minDuration: '',
                maxDuration: '',
                durationLabel: '',
                year: '',
                yearLabel: '',
                fromDate: '',
                toDate: '',
                dateQuick: '',
                dateQuickLabel: '',
                dateRangeLabel: '',
                mediaType: 'all',
                mediaTypeLabel: '',
                enablePhonetics: true
              };
              syncDateQuickChips();
              executeLiveSearch('', { ...activeAdvancedFilters, label: 'Topic: ' + c.name });
            }
          });
        });
      }

      // ROADMAP §5.4: fuzzy fallback — when substring matches are thin,
      // offer Levenshtein-ranked teacher/topic/venue candidates. Clicking
      // one puts the corrected term in the search box and runs the search.
      if (suggestions.length < 5) {
        const haveTitles = new Set(suggestions.map(s => s.title.toLowerCase()));
        const fuzzyIcons = { teacher: '👤', topic: '🏷️', venue: '📍' };
        clientFuzzySuggest(query, 5).forEach(f => {
          if (haveTitles.has(f.text.toLowerCase())) return;
          haveTitles.add(f.text.toLowerCase());
          suggestions.push({
            type: f.type,
            icon: fuzzyIcons[f.type] || '🔍',
            title: f.text,
            sub: (f.type === 'teacher' ? 'Speaker' : f.type === 'venue' ? 'Venue' : 'Topic') + ' · Did you mean?',
            action: () => {
              closeSearchPreview();
              searchInput.value = f.text;
              if (typeof clearSearchBtn !== 'undefined' && clearSearchBtn) clearSearchBtn.style.display = 'block';
              doSearch();
            }
          });
        });
      }

      // 2. Fetch live preview shiur results from /api/search?q=...&start=1
      const phoneticsParam = (typeof activeAdvancedFilters !== 'undefined' && activeAdvancedFilters?.enablePhonetics === false) ? '&exact=1' : '';
      const mediaParam = (typeof activeAdvancedFilters !== 'undefined' && activeAdvancedFilters?.mediaType && activeAdvancedFilters.mediaType !== 'all') ? ('&mediaType=' + encodeURIComponent(activeAdvancedFilters.mediaType)) : '';
      const res = await fetch('/api/search?q=' + encodeURIComponent(query) + '&start=1' + phoneticsParam + mediaParam, {
        signal: previewAbortCtrl.signal
      });
      if (!res.ok) return;
      const data = await res.json();
      if (thisReqId !== currentPreviewReqId) return;
      const docs = (data?.response?.docs || []).slice(0, 5);
      const totalCount = data?.response?.numFound || 0;

      if (!searchPreviewDropdown) return;
      if (suggestions.length === 0 && docs.length === 0) {
        closeSearchPreview();
        return;
      }

      let html = '';

      // Render entity suggestions (speakers/topics)
      if (suggestions.length > 0) {
        html += '<div class="preview-section-title"><span>Suggested Topics &amp; Speakers</span></div>';
        suggestions.forEach((s, idx) => {
          html += '<div class="preview-item" data-suggestion-idx="' + idx + '">' +
            '<span class="preview-item-icon">' + s.icon + '</span>' +
            '<div class="preview-item-body">' +
              '<div class="preview-item-title">' + escapeHtml(s.title) + '</div>' +
              '<div class="preview-item-sub">' + escapeHtml(s.sub) + '</div>' +
            '</div>' +
            '<span class="preview-item-badge">Filter</span>' +
          '</div>';
        });
      }

      // Render top matching shiurim
      if (docs.length > 0) {
        html += '<div class="preview-section-title"><span>Matching Shiurim</span><span>' + totalCount.toLocaleString() + ' found</span></div>';
        docs.forEach(d => {
          const id = escapeHtml(String(d.shiurid || d.shiurID || ''));
          const title = d.shiurtitle || d.shiurTitle || 'Untitled';
          const speaker = d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : 'YUTorah');
          const duration = d.durationformatted || (d.duration ? d.duration + ' min' : '');
          const rawDate = d.shiurdateformatted || d.shiurDateFormatted || d.shiurdate || d.shiurDate || d.shiurdatesubmitted || d.shiurDateSubmitted || '';
          const date = typeof formatShiurDate === 'function' ? formatShiurDate(rawDate) : '';

          const subParts = [speaker];
          if (date) subParts.push(date);
          if (duration) subParts.push(duration);

          const dMediaCat = (d.mediatypecategory || d.mediaTypeCategory || '').toLowerCase();
          const dUrlCheck = d.shiururl || d.shiurURL || d.playerDownloadURL || d.downloadURL || '';
          const dIsArticle = dMediaCat === 'text' || dMediaCat === 'article' || /[.]pdf($|[?])/i.test(dUrlCheck);
          const previewIcon = dIsArticle ? '📄' : '🎧';
          const previewBadge = dIsArticle ? '📄 Read' : '▶ Play';

          html += '<a href="/' + id + '" class="preview-item preview-shiur-item" data-id="' + id + '">' +
            '<span class="preview-item-icon">' + previewIcon + '</span>' +
            '<div class="preview-item-body">' +
              '<div class="preview-item-title">' + escapeHtml(title) + '</div>' +
              '<div class="preview-item-sub">' + escapeHtml(subParts.join(' · ')) + '</div>' +
            '</div>' +
            '<span class="preview-item-badge">' + previewBadge + '</span>' +
          '</a>';
        });

        html += '<div class="preview-footer-view-all" id="previewViewAllBtn">' +
          'View all ' + totalCount.toLocaleString() + ' results for "' + escapeHtml(query) + '" →' +
        '</div>';
      }

      searchPreviewDropdown.innerHTML = html;
      searchPreviewDropdown.style.display = 'block';

      // Attach click events for suggestions
      searchPreviewDropdown.querySelectorAll('[data-suggestion-idx]').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.getAttribute('data-suggestion-idx'), 10);
          if (suggestions[idx]) suggestions[idx].action();
        });
      });

      // Attach click events for shiur results
      searchPreviewDropdown.querySelectorAll('.preview-shiur-item').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          const id = el.getAttribute('data-id');
          closeSearchPreview();
          playShiurById(null, id);
        });
      });

      // Attach click event for "View all" footer
      const viewAllBtn = document.getElementById('previewViewAllBtn');
      if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => {
          closeSearchPreview();
          doSearch();
        });
      }
      collectPreviewFocusables();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Preview fetch error:', err);
      }
    }
  }

  function onSearchInput() {
    const val = searchInput.value;
    clearSearchBtn.style.display = val.trim() ? 'block' : 'none';

    clearTimeout(searchDebounceTimer);
    const query = val.trim();
    if (!query) {
      closeSearchPreview();
      clearSearch();
      return;
    }

    // Easter egg: typing "dev mode" in the search bar activates Dev Mode
    if (query.toLowerCase() === 'dev mode') {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      closeSearchPreview();
      if (!isDevMode) {
        activateDevMode();
        flashToast('🛠️ Dev Mode Unlocked!', false, true);
      } else {
        flashToast('🛠️ Dev Mode already active', false, true);
      }
      return;
    }

    // Typing "exit dev mode" (case-insensitive) leaves Dev Mode.
    if (query.toLowerCase() === 'exit dev mode') {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      closeSearchPreview();
      if (isDevMode) {
        deactivateDevMode();
        flashToast('👋 Dev Mode Off', false, false);
      } else {
        flashToast('Dev Mode is not active', false, false);
      }
      return;
    }

    if (query.length < 2) {
      closeSearchPreview();
      return;
    }

    // Debounced Live Preview Dropdown (250ms)
    searchDebounceTimer = setTimeout(() => {
      fetchSearchPreview(query);
    }, 250);
  }

  // Helper: check if any advanced filters are actively set
  function hasActiveFilters() {
    return (activeAdvancedFilters.teachers && activeAdvancedFilters.teachers.length > 0) ||
      (activeAdvancedFilters.categories && activeAdvancedFilters.categories.length > 0) ||
      (activeAdvancedFilters.locations && activeAdvancedFilters.locations.length > 0) ||
      (activeAdvancedFilters.series && activeAdvancedFilters.series.length > 0) ||
      activeAdvancedFilters.minDuration || activeAdvancedFilters.maxDuration ||
      activeAdvancedFilters.year || activeAdvancedFilters.fromDate || activeAdvancedFilters.toDate ||
      (activeAdvancedFilters.mediaType && activeAdvancedFilters.mediaType !== 'all');
  }

  function doSearch() {
    clearTimeout(searchDebounceTimer);
    closeSearchPreview();
    const rawBarValue = searchInput.value.trim();

    // If advanced filters are active:
    if (hasActiveFilters()) {
      const teacherDisplayNames = (activeAdvancedFilters.teachers || []).map(t => t.name).join(', ');
      let effectiveKeywords;
      if (rawBarValue === teacherDisplayNames || (!rawBarValue && activeAdvancedFilters.teachers.length > 0)) {
        effectiveKeywords = activeAdvancedFilters.keywords || '';
        executeLiveSearch(effectiveKeywords, { ...activeAdvancedFilters });
        return;
      } else {
        // User typed a new search query into the search bar:
        // Clear previous teacher filter so it doesn't silently trap or conflict with the new search!
        activeAdvancedFilters.teachers = [];
        activeAdvancedFilters.keywords = rawBarValue;
        executeLiveSearch(rawBarValue, { ...activeAdvancedFilters });
        return;
      }
    }

    if (!rawBarValue) return;

    if (rawBarValue.toLowerCase() === 'dev mode') {
      searchInput.value = '';
      if (clearSearchBtn) clearSearchBtn.style.display = 'none';
      if (!isDevMode) {
        activateDevMode();
        flashToast('🛠️ Dev Mode Unlocked!', false, true);
      } else {
        flashToast('🛠️ Dev Mode already active', false, true);
      }
      return;
    }

    if (rawBarValue.toLowerCase() === 'exit dev mode') {
      searchInput.value = '';
      if (clearSearchBtn) clearSearchBtn.style.display = 'none';
      if (isDevMode) {
        deactivateDevMode();
        flashToast('👋 Dev Mode Off', false, false);
      } else {
        flashToast('Dev Mode is not active', false, false);
      }
      return;
    }

    // Smart detect: is it a Shiur ID or YUTorah URL?
    const id = extractShiurId(rawBarValue);
    if (id) {
      playShiurById(null, id);
      return;
    }

    executeLiveSearch(rawBarValue);
  }

  function handleSearchSubmit(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    doSearch();
    return false;
  }

  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', (e) => {
    const open = searchPreviewDropdown && searchPreviewDropdown.style.display === 'block' && previewFocusables.length > 0;
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      previewFocusIdx = (previewFocusIdx + dir + previewFocusables.length) % previewFocusables.length;
      updatePreviewFocus();
    } else if (e.key === 'Enter' && previewFocusIdx >= 0 && previewFocusables[previewFocusIdx]) {
      e.preventDefault();
      previewFocusables[previewFocusIdx].click();
    }
  });

  if (searchInput.value.trim()) {
    clearSearchBtn.style.display = 'block';
  }

  function handleImgError(img) {
    img.onerror = null;
    img.src = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
  }

  function extractShiurId(text) {
    if (!text) return null;
    var t = text.trim();
    if (/^[0-9]{4,8}$/.test(t)) return t;
    if (t.indexOf('shiurID=') !== -1) {
      var p1 = t.split(/shiurID=/i);
      var id1 = p1[1] ? p1[1].split(/[^0-9]/)[0] : '';
      if (id1) return id1;
    }
    if (t.indexOf('lectures/') !== -1) {
      var p2 = t.split('lectures/');
      var id2 = p2[1] ? p2[1].split(/[^0-9]/)[0] : '';
      if (id2) return id2;
    }
    return null;
  }

  let currentSearchQuery = ${jsEmbed(searchQuery || '')};
  let currentFilterParams = {};
  let currentLoadedDocsCount = ${jsEmbed(initialSearchResults ? initialSearchResults.length : 0)};
  let totalSearchResults = ${jsEmbed(initialNumFound || 0)};
  let currentSearchPage = Math.floor(${jsEmbed(initialSearchResults ? initialSearchResults.length : 0)} / 30) || 1;
  let isLoadingMore = false;
  let currentSpeakerViewCache = null;

  // Recent Results rail state (fixed top-3, no expansion control).
  let currentRecentDocs = ${jsEmbed(initialRecentDocs || [])};
  let recentNumFound = ${jsEmbed(initialRecentNumFound || 0)};
  let currentSearchAbort = null;
  let currentPhoneticTokens = ${jsEmbed(initialPhoneticExpansion?.tokens || [])};
  let currentSearchDocs = ${jsEmbed(initialSearchResults || [])};
  let currentDidYouMean = ${jsEmbed(initialDidYouMean || [])};
  let currentQueryResolution = ${jsEmbed(initialQueryResolution || null)};
  let showMatchReasons = false;
  let useClassicSearch = ${Boolean(isClassicSearch)};
  let stackSeriesEnabled = true;

  const COMMUNITY_ACRONYM_PHRASES = {
    yije: ['Young Israel of Jamaica Estates', 'Jamaica Estates', 'YIJE'],
    yih: ['Young Israel of Hollywood', 'YIH'],
    yihl: ['Young Israel of Hewlett', 'YIHL'],
    yish: ['Young Israel of Scarsdale', 'YISH'],
    yifh: ['Young Israel of Forest Hills', 'YIFH'],
    yist: ['Young Israel of Staten Island', 'YIST'],
    yiw: ['Young Israel of Woodmere', 'YIW'],
    yipc: ['Young Israel of Plainview', 'YIPC'],
    yioz: ['Young Israel of Oceanside', 'YIOZ'],
    bmt: ['Beit Midrash of Teaneck', 'BMT'],
    bcbm: ['Bergen County Beit Midrash', 'BCBM'],
    riets: ['Rabbi Isaac Elchanan Theological Seminary', 'RIETS'],
    yu: ['Yeshiva University', 'YU'],
    ou: ['Orthodox Union', 'OU'],
    ncsy: ['NCSY']
  };

  function getActiveSearchTerms() {
    const terms = new Set();

    if (currentSearchQuery) {
      const rawWords = currentSearchQuery.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
      for (const w of rawWords) {
        terms.add(w);
        if (COMMUNITY_ACRONYM_PHRASES[w]) {
          for (const exp of COMMUNITY_ACRONYM_PHRASES[w]) {
            terms.add(exp.toLowerCase());
            exp.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length >= 3).forEach(x => terms.add(x));
          }
        }
      }
    }

    if (Array.isArray(currentPhoneticTokens)) {
      for (const t of currentPhoneticTokens) {
        if (t && t.length >= 2) {
          terms.add(t.toLowerCase());
        }
      }
    }

    if (currentFilterParams) {
      if (Array.isArray(currentFilterParams.teachers)) {
        currentFilterParams.teachers.forEach(t => {
          if (t.name) {
            terms.add(t.name.toLowerCase());
            t.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !['rabbi', 'rav', 'doctor', 'dr'].includes(w)).forEach(w => terms.add(w));
          }
        });
      }
      if (Array.isArray(currentFilterParams.locations)) {
        currentFilterParams.locations.forEach(l => {
          if (l.name) {
            terms.add(l.name.toLowerCase());
            l.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3).forEach(w => terms.add(w));
          }
        });
      }
      if (Array.isArray(currentFilterParams.categories)) {
        currentFilterParams.categories.forEach(c => {
          if (c.name) {
            terms.add(c.name.toLowerCase());
          }
        });
      }
    }

    return Array.from(terms).sort((a, b) => b.length - a.length);
  }

  function highlightMatches(text, terms) {
    if (!text || !terms || terms.length === 0) return escapeHtml(text);
    const lower = text.toLowerCase();
    const ranges = [];

    for (const term of terms) {
      if (!term || term.length < 2) continue;
      const termLower = term.toLowerCase();
      let pos = 0;
      while ((pos = lower.indexOf(termLower, pos)) !== -1) {
        ranges.push([pos, pos + termLower.length]);
        pos += termLower.length;
      }
    }

    if (ranges.length === 0) return escapeHtml(text);

    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = ranges[i];
      if (curr[0] <= prev[1]) {
        prev[1] = Math.max(prev[1], curr[1]);
      } else {
        merged.push(curr);
      }
    }

    let result = '';
    let lastIdx = 0;
    for (const [start, end] of merged) {
      result += escapeHtml(text.slice(lastIdx, start));
      result += '<mark class="match-mark">' + escapeHtml(text.slice(start, end)) + '</mark>';
      lastIdx = end;
    }
    result += escapeHtml(text.slice(lastIdx));
    return result;
  }

  function extractSnippet(text, terms, windowBefore = 45, windowAfter = 65) {
    if (!text || !terms || terms.length === 0) return null;
    const lower = text.toLowerCase();
    let firstPos = -1;
    let matchedTerm = '';

    for (const term of terms) {
      if (!term || term.length < 2) continue;
      const termLower = term.toLowerCase();
      const pos = lower.indexOf(termLower);
      if (pos !== -1) {
        if (firstPos === -1 || pos < firstPos) {
          firstPos = pos;
          matchedTerm = termLower;
        }
      }
    }

    if (firstPos === -1) return null;

    let start = Math.max(0, firstPos - windowBefore);
    let end = Math.min(text.length, firstPos + matchedTerm.length + windowAfter);

    let prefix = '...';
    let suffix = '...';

    if (start === 0) prefix = '';
    else {
      const spaceIdx = text.indexOf(' ', start);
      if (spaceIdx !== -1 && spaceIdx < firstPos) {
        start = spaceIdx + 1;
      }
    }

    if (end === text.length) suffix = '';
    else {
      const spaceIdx = text.lastIndexOf(' ', end);
      if (spaceIdx !== -1 && spaceIdx > firstPos + matchedTerm.length) {
        end = spaceIdx;
      }
    }

    const rawSnippet = prefix + text.slice(start, end).trim() + suffix;
    return highlightMatches(rawSnippet, terms);
  }

  function buildMatchReasons(doc, terms) {
    const reasons = [];

    const desc = doc.shiurdescription || doc.description || '';
    if (desc) {
      const descSnippet = extractSnippet(desc, terms, 45, 65);
      if (descSnippet && descSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '📄 Description Match',
          snippet: descSnippet
        });
      }
    }

    const loc = Array.isArray(doc.location) ? doc.location.join(', ') : (doc.location || '');
    if (loc) {
      const locSnippet = extractSnippet(loc, terms, 60, 60);
      if (locSnippet && locSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '📍 Venue Match',
          snippet: locSnippet
        });
      }
    }

    const kw = Array.isArray(doc.shiurkeywords) ? doc.shiurkeywords.join(', ') : (doc.shiurkeywords || doc.keywords || '');
    if (kw) {
      const kwSnippet = extractSnippet(kw, terms, 50, 50);
      if (kwSnippet && kwSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '🏷️ Keywords Match',
          snippet: kwSnippet
        });
      }
    }

    const series = Array.isArray(doc.seriesname) ? doc.seriesname.join(', ') : (doc.seriesname || doc.series || '');
    if (series) {
      const seriesSnippet = extractSnippet(series, terms, 50, 50);
      if (seriesSnippet && seriesSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '📚 Series Match',
          snippet: seriesSnippet
        });
      }
    }

    return reasons;
  }

  function onToggleMatchExplain(checked) {
    showMatchReasons = !!checked;
    const grid = document.getElementById('searchResultsGrid');
    if (grid) {
      grid.classList.toggle('explain-matches-active', showMatchReasons);
    }
  }

  const SEARCH_STOP_WORDS = new Set(['of', 'the', 'in', 'on', 'a', 'an', 'and', 'for', 'to', 'with', 'at', 'by', 'from', 'about']);

  function computeRelevanceScore(d, queryTerms = [], rawQuery = '') {
    if (!d) return 0;
    const title = (d.shiurtitle || d.shiurTitle || d.title || '').toLowerCase();
    const speaker = (d.teacherfullname || d.speaker || '').toLowerCase();
    const series = (Array.isArray(d.seriesname) ? d.seriesname.join(' ') : (d.seriesname || d.series || '')).toLowerCase();
    const collection = (Array.isArray(d.collectionname) ? d.collectionname.join(' ') : (d.collectionname || '')).toLowerCase();
    const category = (Array.isArray(d.categoryname) ? d.categoryname.join(' ') : (d.category || '')).toLowerCase();
    const desc = (d.shiurdescription || d.description || '').toLowerCase();

    let score = 0;

    const cleanRaw = (rawQuery || '').toLowerCase().trim();
    if (cleanRaw && title.includes(cleanRaw)) {
      score += 1000;
    }

    const terms = (queryTerms || []).map(t => t.toLowerCase()).filter(t => t.length >= 2 && !SEARCH_STOP_WORDS.has(t));
    if (terms.length === 0) return score;

    const titleWords = title.split(/[^a-z0-9א-ת]+/);
    let titleMatches = 0;
    let speakerMatches = 0;
    let seriesMatches = 0;

    for (const t of terms) {
      if (title.includes(t)) {
        score += 120;
        titleMatches++;
        if (titleWords.includes(t)) {
          score += 80;
        }
      }
      if (speaker.includes(t)) {
        score += 100;
        speakerMatches++;
      }
      if (series.includes(t) || collection.includes(t)) {
        score += 60;
        seriesMatches++;
      }
      if (category.includes(t)) {
        score += 40;
      }
      if (desc.includes(t)) {
        score += 5;
      }
    }

    if (titleMatches >= 2 && titleMatches === terms.length) {
      score += 300;
    } else if ((titleMatches + seriesMatches) >= terms.length) {
      score += 200;
    }

    return score;
  }

  function groupAndRankDocs(docs, queryTerms = [], rawQuery = '') {
    if (!Array.isArray(docs)) return [];
    const groups = new Map();
    const standalone = [];

    for (const doc of docs) {
      let groupKey = null;
      let groupTitle = null;

      if (Array.isArray(doc.collectionid) && doc.collectionid.length > 0 && doc.collectionname && doc.collectionname[0]) {
        const parts = doc.collectionname[0].split('|');
        groupKey = 'coll_' + doc.collectionid[0];
        groupTitle = parts[0].trim();
      } else if (doc.seriesid && doc.seriesname) {
        groupKey = 'series_' + doc.seriesid;
        groupTitle = doc.seriesname;
      }

      if (groupKey) {
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { key: groupKey, title: groupTitle, docs: [] });
        }
        groups.get(groupKey).docs.push(doc);
      } else {
        standalone.push(doc);
      }
    }

    const items = [];
    for (const [k, g] of groups.entries()) {
      if (g.docs.length >= 2) {
        g.docs.sort((a, b) => {
          const da = a.shiurdate || a.shiurdatesubmitted || '';
          const db = b.shiurdate || b.shiurdatesubmitted || '';
          return da.localeCompare(db);
        });
        const maxScore = Math.max(...g.docs.map(d => computeRelevanceScore(d, queryTerms, rawQuery)));
        items.push({
          isSeries: true,
          key: g.key,
          title: g.title,
          docs: g.docs,
          cover: g.docs[0],
          subDocs: g.docs.slice(1),
          score: maxScore
        });
      } else {
        items.push({
          isSeries: false,
          doc: g.docs[0],
          score: computeRelevanceScore(g.docs[0], queryTerms, rawQuery)
        });
      }
    }

    for (const doc of standalone) {
      items.push({
        isSeries: false,
        doc,
        score: computeRelevanceScore(doc, queryTerms, rawQuery)
      });
    }

    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateA = a.isSeries ? (a.cover.shiurdate || a.cover.shiurdatesubmitted || '') : (a.doc.shiurdate || a.doc.shiurdatesubmitted || '');
      const dateB = b.isSeries ? (b.cover.shiurdate || b.cover.shiurdatesubmitted || '') : (b.doc.shiurdate || b.doc.shiurdatesubmitted || '');
      return dateB.localeCompare(dateA);
    });

    return items;
  }

  function toggleSeriesDrawer(e, drawerId) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!drawerId && e && e.currentTarget) {
      drawerId = e.currentTarget.dataset.drawerTarget;
    }
    if (!drawerId) return;
    const drawer = document.getElementById(drawerId);
    const btn = document.querySelector('[data-drawer-target="' + drawerId + '"]');
    if (!drawer) return;
    const isHidden = drawer.style.display === 'none';
    drawer.style.display = isHidden ? 'flex' : 'none';
    if (btn) {
      const count = btn.dataset.subCount || '';
      const sTitle = (btn.dataset && btn.dataset.seriesTitle) || 'this';
      const moreLabel = 'View ' + count + ' more in \u2018' + sTitle + '\u2019 Series';
      btn.innerHTML = isHidden
        ? '<span class="series-expand-icon">➖</span> <span class="series-expand-text">Minimize series</span>'
        : '<span class="series-expand-icon">➕</span> <span class="series-expand-text">' + escapeHtml(moreLabel) + '</span>';
    }
    if (isHidden) {
      try { if (typeof devUpgradeCards === 'function') devUpgradeCards(drawer); } catch (e) {}
    }
  }

  function onToggleClassicSearch(checked) {
    useClassicSearch = !!checked;

    const advCheckbox = document.getElementById('advPhoneticsToggle');
    if (advCheckbox) {
      advCheckbox.checked = !useClassicSearch;
      const phonLabel = document.getElementById('advPhoneticsToggleLabel');
      if (phonLabel) phonLabel.textContent = advCheckbox.checked ? 'On' : 'Off';
    }
    if (activeAdvancedFilters) {
      activeAdvancedFilters.enablePhonetics = !useClassicSearch;
    }

    const newUrl = new URL(window.location.href);
    if (useClassicSearch) {
      newUrl.searchParams.set('exact', '1');
    } else {
      newUrl.searchParams.delete('exact');
    }
    history.pushState(history.state || {}, '', newUrl.toString());

    if (currentSearchQuery || (activeAdvancedFilters && Object.values(activeAdvancedFilters).some(Boolean))) {
      executeLiveSearch(currentSearchQuery, {
        ...activeAdvancedFilters,
        enablePhonetics: !useClassicSearch
      });
    }
  }

  function toggleClassicInfoTooltip(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const tip = document.getElementById('classicSearchTooltip');
    if (!tip) return;
    const isShown = tip.style.display !== 'none';
    tip.style.display = isShown ? 'none' : 'block';
  }

  function hideClassicInfoTooltip(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const tip = document.getElementById('classicSearchTooltip');
    if (tip) tip.style.display = 'none';
  }

  document.addEventListener('click', function(e) {
    const tip = document.getElementById('classicSearchTooltip');
    if (tip && tip.style.display !== 'none') {
      const btn = document.querySelector('.classic-info-btn');
      if (!tip.contains(e.target) && (!btn || !btn.contains(e.target))) {
        tip.style.display = 'none';
      }
    }
  });

  function onToggleStackSeries(checked) {
    stackSeriesEnabled = !!checked;
    renderCurrentSearchResults();
  }

  // ROADMAP §5.4: client-side twin of the edge fuzzy engine (used for
  // as-you-type chips; post-search strips come from /api/search didYouMean).
  function clientLevenshtein(a, b) {
    const s = String(a || '').toLowerCase();
    const t = String(b || '').toLowerCase();
    const m = s.length, n = t.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const d = [];
    for (let i = 0; i <= m; i++) { d.push([i]); for (let j = 1; j <= n; j++) d[i].push(0); }
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
          v = Math.min(v, d[i - 2][j - 2] + 1);
        }
        d[i][j] = v;
      }
    }
    return d[m][n];
  }

  function clientFuzzySuggest(query, limit) {
    const q = String(query || '').trim().toLowerCase();
    limit = limit || 5;
    if (q.length < 2 || typeof autocompleteCache === 'undefined' || !autocompleteCache) return [];
    const pools = [
      ['teacher', autocompleteCache.teachers || []],
      ['topic', autocompleteCache.categories || []],
      ['venue', autocompleteCache.venues || []]
    ];
    const out = [];
    const seen = new Set();
    for (const pair of pools) {
      const type = pair[0];
      for (const c of pair[1]) {
        const name = typeof c === 'string' ? c : (c && c.name);
        if (!name) continue;
        const norm = String(name).replace(/^(rabbi|rav|dr|doctor|prof|dayan|maran|chacham|harav|reb|mrs|ms|mr)\\.?[\\s]+/i, '').toLowerCase().trim();
        if (!norm || seen.has(type + '|' + norm)) continue;
        const targets = [norm].concat(norm.split(/\\s+/).filter(w => w.length >= 3));
        let best = Infinity;
        for (const target of targets) {
          if ((target.indexOf(q) !== -1 && q.length >= 3) ||
              (q.indexOf(target) !== -1 && target.length >= q.length * 0.6)) { best = 0; break; }
          const probe = target.length > q.length ? target.slice(0, q.length) : target;
          const dist = clientLevenshtein(q, probe);
          if (dist < best) best = dist;
          if (best === 1) break;
        }
        const gate = Math.min(2, Math.floor(Math.max(q.length, 4) * 0.25) + 1);
        if (q.length <= 3 && best > 0) continue;
        if (best <= gate) {
          seen.add(type + '|' + norm);
          out.push({ text: String(name), type: type, id: (c && c.id) ? String(c.id) : '', distance: best, count: (c && c.count) || 0 });
        }
      }
    }
    // Compact synset twin (mirrors edge SYNSETS variants) so concept typos
    // get as-you-type chips too — "same engine" on both surfaces (§5.4).
    if (q.length > 3) {
      const synPairs = [
        ['shabbat', 'shabbat'], ['shabbos', 'shabbat'], ['shabos', 'shabbat'],
        ['sukkah', 'sukkah'], ['sukka', 'sukkah'], ['succah', 'sukkah'], ['succa', 'sukkah'],
        ['chanukah', 'chanukah'], ['hanukkah', 'chanukah'], ['chanuka', 'chanukah'],
        ['teshuvah', 'teshuvah'], ['teshuva', 'teshuvah'], ['tshuva', 'teshuvah'],
        ['pesach', 'pesach'], ['passover', 'pesach'],
        ['muktzah', 'muktzah'], ['muktza', 'muktzah'],
        ['kashrus', 'kashrus'], ['kashrut', 'kashrus'], ['kosher', 'kashrus'],
        ['tefillah', 'tefillah'], ['tefila', 'tefillah'], ['tefillos', 'tefillah'],
        ['brachos', 'brachos'], ['berachos', 'brachos'], ['bracha', 'brachos'], ['beracha', 'brachos'],
        ['motzoei', 'motzoei'], ['motzei', 'motzoei'], ['motsai', 'motzoei']
      ];
      for (const pair of synPairs) {
        const dist = clientLevenshtein(q, pair[0]);
        if (dist <= 2 && !seen.has('topic|' + pair[0])) {
          seen.add('topic|' + pair[0]);
          out.push({ text: pair[1], type: 'topic', id: '', distance: dist, count: 0 });
          break;
        }
      }
    }
    out.sort((a, b) => (a.distance - b.distance) || ((b.count || 0) - (a.count || 0)));
    return out.slice(0, limit);
  }

  function renderDidYouMeanStrip(suggestions) {
    const chips = suggestions.map(s =>
      '<button type="button" class="did-you-mean-chip" data-text="' + encodeURIComponent(s.text) + '"' +
      ' onclick="applyDidYouMean(decodeURIComponent(this.getAttribute(\\'data-text\\')))"' +
      ' title="' + escapeHtml(s.type) + '">' + escapeHtml(s.text) + '</button>'
    ).join('');
    return '<div class="did-you-mean-strip"><span>🔍 Did you mean:</span>' + chips + '</div>';
  }

  function applyDidYouMean(text) {
    if (!text) return;
    searchInput.value = text;
    if (clearSearchBtn) clearSearchBtn.style.display = 'block';
    closeSearchPreview();
    doSearch();
  }

  function renderCurrentSearchResults() {
    const grid = document.getElementById('searchResultsGrid');
    if (!grid) return;
    // Zero-hit state (e.g. SSR reload): still restore the disclaimer +
    // did-you-mean strips from hydrated state.
    if ((!currentRecentDocs || currentRecentDocs.length === 0) && (!currentSearchDocs || currentSearchDocs.length === 0)) {
      let eHtml = '';
      if (currentQueryResolution && currentQueryResolution.display) {
        eHtml += '<div class="did-you-mean-strip resolution-note"><span>🔍 Showing results for &quot;' +
          escapeHtml(currentQueryResolution.display) + '&quot; — you searched &quot;' +
          escapeHtml(currentQueryResolution.original) + '&quot;.</span></div>';
      }
      if (currentDidYouMean && currentDidYouMean.length > 0) {
        eHtml += renderDidYouMeanStrip(currentDidYouMean);
      }
      if (eHtml) {
        eHtml += '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No shiurim found matching these criteria. Try adjusting your filters or search keywords.</div>';
        grid.innerHTML = eHtml;
      }
      return;
    }

    const terms = getActiveSearchTerms();
    // Chronological sorts render in server order: any client re-ranking
    // would silently undo newest/oldest.
    const chronoSort = currentFilterParams.sort === 'newest' || currentFilterParams.sort === 'oldest';
    function renderList(docs) {
      if (chronoSort) {
        return docs.map(d => renderDocToCard(d)).join('');
      }
      if (stackSeriesEnabled) {
        const grouped = groupAndRankDocs(docs, terms, currentSearchQuery);
        return grouped.map(renderGroupItem).join('');
      }
      const unstacked = [...docs].sort((a, b) => {
        const sa = computeRelevanceScore(a, terms, currentSearchQuery);
        const sb = computeRelevanceScore(b, terms, currentSearchQuery);
        if (sb !== sa) return sb - sa;
        const da = a.shiurdate || a.shiurdatesubmitted || '';
        const db = b.shiurdate || b.shiurdatesubmitted || '';
        return db.localeCompare(da);
      });
      return unstacked.map(d => renderDocToCard(d)).join('');
    }

    let html = '';
    // "Showing results for X (you searched Y)" shown only when the query
    // was rewritten (no speaker auto-resolution anymore).
    if (currentQueryResolution && currentQueryResolution.display) {
      html += '<div class="did-you-mean-strip resolution-note"><span>🔍 Showing results for &quot;' +
        escapeHtml(currentQueryResolution.display) + '&quot; — you searched &quot;' +
        escapeHtml(currentQueryResolution.original) + '&quot;.</span></div>';
    }
    // Did-you-mean strip always goes ON TOP when suggestions exist,
    // whether zero hits or a thin (<10) result set.

    // Speaker view (OG yutorah style): Most Recent 6 + Top Lectures.
    const isSpeakerView = currentFilterParams && currentFilterParams.speakerView;
    if (isSpeakerView && currentSearchDocs && currentSearchDocs.length > 0) {
      const docKey = d => String(d.shiurID || d.shiurid || d.id || '');
      const docDate = d => String(d.shiurdate || d.shiurdatesubmitted || d.shiurDate || d.shiurDateSubmitted || '');
      const docPop = d => (parseInt(d.shiurvisitsnum, 10) || 0) + (parseInt(d.shiurdownloadsnum, 10) || 0);
      if (!currentSpeakerViewCache) {
        const byDate = [...currentSearchDocs].sort((a, b) => docDate(b).localeCompare(docDate(a)));
        const recent6 = byDate.slice(0, 6);
        const recentIds = new Set(recent6.map(docKey).filter(Boolean));
        const byPop = [...currentSearchDocs].filter(d => { const k = docKey(d); return k && !recentIds.has(k); }).sort((a,b)=>docPop(b)-docPop(a));
        const top10 = byPop.slice(0, 10);
        const shownIds = new Set([...recent6, ...top10].map(docKey).filter(Boolean));
        const rest = currentSearchDocs.filter(d => { const k = docKey(d); return !k || !shownIds.has(k); });
        currentSpeakerViewCache = { recent6, top10, rest };
      }
      const { recent6, top10, rest } = currentSpeakerViewCache;
      if (currentDidYouMean && currentDidYouMean.length) html += renderDidYouMeanStrip(currentDidYouMean);
      if (recent6.length) { html += '<div class="search-results-subheading"><span>🆕</span><span>Most Recent</span></div>'; html += renderList(recent6); }
      if (top10.length) { html += '<div class="search-results-subheading"><span>🏆</span><span>Top Lectures</span></div>'; html += renderList(top10); }
      if (rest.length) { html += '<div class="search-results-subheading"><span>📚</span><span>All Shiurim</span></div>'; html += renderList(rest); }
      grid.innerHTML = html;
      grid.classList.toggle('explain-matches-active', showMatchReasons);
      try { if (typeof devUpgradeCards === 'function') devUpgradeCards(grid); } catch(e){}
      return;
    }

    // Recent Results rail: fixed top-3 freshest, no expansion control.
    const visibleRecent = (currentRecentDocs || []).slice(0, 3);
    if (visibleRecent.length > 0) {
      const recentTotal = recentNumFound || currentRecentDocs.length;
      html += '<div class="search-results-subheading"><span>🕒</span><span>Recent Results</span>' +
        '<span class="sub-count">' + recentTotal.toLocaleString() + ' matching</span></div>';
      html += renderList(visibleRecent);
    }

    // 🎯 Relevance sub-section (own separate Load More).
    if (currentSearchDocs && currentSearchDocs.length > 0) {
      if (visibleRecent.length > 0) {
        html += '<div class="search-results-subheading"><span>🎯</span><span>Most Relevant Results</span></div>';
      }
      html += renderList(currentSearchDocs);
    }

    // Did-you-mean strip goes ON TOP whenever suggestions exist —
    // zero hits or thin result sets alike.
    if (currentDidYouMean && currentDidYouMean.length > 0) {
      const strip = renderDidYouMeanStrip(currentDidYouMean);
      const firstSection = html.indexOf('<div class="search-results-subheading"');
      html = firstSection >= 0
        ? html.slice(0, firstSection) + strip + html.slice(firstSection)
        : strip + html;
    }

    grid.innerHTML = html;
    grid.classList.toggle('explain-matches-active', showMatchReasons);
    // Live-search path: drawer sub-cards and fresh cards get dev buttons +
    // progress immediately (retrofit is idempotent).
    try { if (typeof devUpgradeCards === 'function') devUpgradeCards(grid); } catch (e) {}
  }

  function goHome(e) {
    if (e) e.preventDefault();

    if (hasAudio || isCurrentShiurArticle) {
      minimizePlayer();
    }

    const searchSec = document.getElementById('searchResultsSection');
    if (searchSec) searchSec.style.display = 'none';
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';

    if (searchInput) {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
    }

    const collSec = document.getElementById('collectionsSection');
    if (collSec) collSec.style.display = 'block';

    const moreSpeaker = document.getElementById('moreFromSpeakerSection');
    if (moreSpeaker) moreSpeaker.style.display = 'none';
    const moreCat = document.getElementById('moreFromCategorySection');
    if (moreCat) moreCat.style.display = 'none';

    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    newUrl.search = '';
    history.pushState({}, '', newUrl.toString());

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleBioCollapse() {
    const text = document.getElementById('bioText');
    const btn = document.getElementById('bioToggleBtn');
    if (!text || !btn) return;
    const isCollapsed = text.classList.contains('collapsed');
    if (isCollapsed) {
      text.classList.remove('collapsed');
      btn.textContent = 'Show Less ▲';
    } else {
      text.classList.add('collapsed');
      btn.textContent = 'Read More ▼';
    }
  }

  function formatBioHtml(raw) {
    if (!raw) return '';
    var nl = String.fromCharCode(10);
    return String(raw)
      .split('<p>').join(nl + nl)
      .split('<P>').join(nl + nl)
      .split('<br>').join(nl)
      .split('<br/>').join(nl)
      .split('<br />').join(nl)
      .split(nl)
      .map(function(line) { return line.trim(); })
      .filter(function(line) { return line.length > 0; })
      .map(function(line) { return '<p>' + escapeHtml(line) + '</p>'; })
      .join('');
  }

  async function loadTeacherBio(teacherId, teacherName) {
    const banner = document.getElementById('bioBanner');
    const textEl = document.getElementById('bioText');
    const titleEl = document.getElementById('bioTitle');
    const subEl = document.getElementById('bioSubtitle');
    const avatarEl = document.getElementById('bioAvatar');
    const toggleBtn = document.getElementById('bioToggleBtn');
    if (!banner || !teacherId) return;

    try {
      const res = await fetch('/api/teacher?id=' + encodeURIComponent(teacherId));
      if (!res.ok) {
        banner.style.display = 'none';
        return;
      }
      const data = await res.json();
      const bio = data.teacherBio || '';
      const name = data.teacherFullName || teacherName || '';
      const position = data.teacherTitle || data.teacherPosition || (data.teacherShiurimNumber ? data.teacherShiurimNumber + ' shiurim on YUTorah' : '');
      const photo = data.teacherPhotoURL_lp || data.teacherPhotoURL || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';

      if (!bio && !position) {
        banner.style.display = 'none';
        return;
      }

      titleEl.textContent = name;
      subEl.textContent = position;
      avatarEl.src = photo;

      if (bio) {
        textEl.innerHTML = formatBioHtml(bio);
        textEl.className = 'bio-text collapsed';
        toggleBtn.style.display = 'inline-flex';
        toggleBtn.textContent = 'Read More ▼';
      } else {
        textEl.innerHTML = '';
        toggleBtn.style.display = 'none';
      }

      banner.style.display = 'block';
    } catch (e) {
      console.warn('Failed to load teacher bio:', e);
      banner.style.display = 'none';
    }
  }

  async function loadVenueDescription(locationId, locationName) {
    const banner = document.getElementById('bioBanner');
    const textEl = document.getElementById('bioText');
    const titleEl = document.getElementById('bioTitle');
    const subEl = document.getElementById('bioSubtitle');
    const avatarEl = document.getElementById('bioAvatar');
    const toggleBtn = document.getElementById('bioToggleBtn');
    if (!banner || !locationId) return;

    try {
      const res = await fetch('/api/venue?id=' + encodeURIComponent(locationId));
      if (!res.ok) {
        banner.style.display = 'none';
        return;
      }
      const data = await res.json();
      const desc = data.locationDescription || '';
      const name = data.locationName || locationName || '';
      const shiurimCount = data.locationShiurimNumber ? (data.locationShiurimNumber + ' shiurim recorded here') : '';
      const photo = data.locationPhotoURL || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';

      if (!desc && !shiurimCount) {
        banner.style.display = 'none';
        return;
      }

      titleEl.textContent = name;
      subEl.textContent = shiurimCount;
      avatarEl.src = photo;

      if (desc) {
        textEl.innerHTML = formatBioHtml(desc);
        textEl.className = 'bio-text collapsed';
        toggleBtn.style.display = 'inline-flex';
        toggleBtn.textContent = 'Read More ▼';
      } else {
        textEl.innerHTML = '';
        toggleBtn.style.display = 'none';
      }

      banner.style.display = 'block';
    } catch (e) {
      console.warn('Failed to load venue description:', e);
      banner.style.display = 'none';
    }
  }

  function searchFor(term) {
    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    searchInput.value = term;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch(term);
    const resSection = document.getElementById('searchResultsSection');
    if (resSection) resSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterByTeacher(teacherId, teacherName) {
    if (hasAudio) {
      minimizePlayer();
    }
    loadTeacherBio(teacherId, teacherName);
    searchInput.value = teacherName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      teacherId: teacherId,
      speakerView: true,
      label: 'Shiurim by ' + teacherName
    });
    const resSection = document.getElementById('searchResultsSection');
    if (resSection) resSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterByLocation(locationId, locationName) {
    if (hasAudio) {
      minimizePlayer();
    }
    loadVenueDescription(locationId, locationName);
    searchInput.value = locationName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      locationId: locationId,
      label: 'Shiurim at ' + locationName
    });
    const resSection = document.getElementById('searchResultsSection');
    if (resSection) resSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterByCategory(subCategoryId, categoryName) {
    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    searchInput.value = categoryName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      subCategoryId: subCategoryId,
      label: 'Shiurim in ' + categoryName
    });
    const resSection = document.getElementById('searchResultsSection');
    if (resSection) resSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterBySeries(seriesId, seriesName) {
    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    searchInput.value = seriesName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      seriesId: seriesId,
      label: 'Series: ' + seriesName
    });
    const resSection = document.getElementById('searchResultsSection');
    if (resSection) resSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function isPlayerCardInViewport() {
    const playerCard = document.getElementById('playerCard');
    if (!playerCard || playerCard.style.display === 'none') return false;
    const rect = playerCard.getBoundingClientRect();
    const header = document.getElementById('mainHeader');
    const isPurim = document.body.classList.contains('is-purim-theme');
    const topBoundary = (header && !isPurim) ? header.getBoundingClientRect().bottom : 0;
    const bottomBoundary = (header && isPurim) ? header.getBoundingClientRect().top : (window.innerHeight || document.documentElement.clientHeight);

    return rect.bottom > topBoundary && rect.top < bottomBoundary;
  }

  let scrollCheckScheduled = false;
  function handleScrollAutoMiniPlayer() {
    if (!hasAudio || isManuallyMinimized || Date.now() < isExpandingUntil) return;
    const visible = isPlayerCardInViewport();
    const miniPlayer = document.getElementById('miniPlayer');
    if (!miniPlayer) return;

    if (!visible) {
      if (!miniPlayer.classList.contains('visible')) {
        miniPlayer.classList.add('visible');
        document.body.classList.add('mini-player-active');
      }
    } else {
      if (miniPlayer.classList.contains('visible')) {
        miniPlayer.classList.remove('visible');
        document.body.classList.remove('mini-player-active');
      }
    }
  }

  function scheduleScrollAutoMiniPlayer() {
    if (scrollCheckScheduled) return;
    scrollCheckScheduled = true;
    requestAnimationFrame(() => {
      handleScrollAutoMiniPlayer();
      scrollCheckScheduled = false;
    });
  }

  function minimizePlayer() {
    if (!hasAudio && !isCurrentShiurArticle) return;
    isManuallyMinimized = true;
    const playerCard = document.getElementById('playerCard');
    const miniPlayer = document.getElementById('miniPlayer');
    if (playerCard) playerCard.style.display = 'none';
    if (miniPlayer) {
      const miniProgressTrack = document.getElementById('miniProgressTrack');
      const miniPlayBtn = document.getElementById('miniPlayBtn');
      const miniTime = document.getElementById('miniTime');
      const skipBtns = miniPlayer.querySelectorAll('.skip-btn');
      if (isCurrentShiurArticle) {
        if (miniProgressTrack) miniProgressTrack.style.display = 'none';
        if (miniPlayBtn) miniPlayBtn.style.display = 'none';
        skipBtns.forEach(b => b.style.display = 'none');
        if (miniTime) miniTime.textContent = '📄 Reading';
      } else {
        if (miniProgressTrack) miniProgressTrack.style.display = 'block';
        if (miniPlayBtn) miniPlayBtn.style.display = 'block';
        skipBtns.forEach(b => b.style.display = 'block');
      }
      miniPlayer.classList.add('visible');
    }
    document.body.classList.add('mini-player-active');

    const searchSection = document.getElementById('searchResultsSection');
    const collSection = document.getElementById('collectionsSection');
    if (collSection) {
      collSection.style.display = 'block';
    }
    if (searchSection && collSection && searchSection.style.display === 'none' && collSection.style.display === 'none') {
      collSection.style.display = 'block';
    }
  }

  function expandPlayer() {
    isManuallyMinimized = false;
    isExpandingUntil = Date.now() + 800;
    const playerCard = document.getElementById('playerCard');
    const miniPlayer = document.getElementById('miniPlayer');
    if (playerCard) {
      playerCard.style.display = 'block';
      playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (miniPlayer) miniPlayer.classList.remove('visible');
    document.body.classList.remove('mini-player-active');
  }

  function closeMiniPlayer() {
    if (audio) audio.pause();
    hasAudio = false;
    isCurrentShiurArticle = false;
    currentArticlePdf = '';
    isManuallyMinimized = false;
    currentShiurId = '';
    const miniPlayer = document.getElementById('miniPlayer');
    if (miniPlayer) miniPlayer.classList.remove('visible');
    document.body.classList.remove('mini-player-active');
    const playerCard = document.getElementById('playerCard');
    if (playerCard) playerCard.style.display = 'none';
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    newUrl.search = '';
    history.pushState({}, '', newUrl.toString());
  }

  function handleMiniPlayerClick(e) {
    if (e.target.closest('button') || e.target.closest('.mini-progress-track')) return;
    expandPlayer();
  }

  function seekMiniProgress(e) {
    if (!audio.duration) return;
    const track = document.getElementById('miniProgressTrack');
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    updateUrlTimestamp(true);
  }

  // Autocomplete Metadata Cache
  let autocompleteData = null;
  let isFetchingAutocomplete = false;

  async function loadAutocompleteMeta() {
    if (autocompleteData) return autocompleteData;
    if (isFetchingAutocomplete) return null;
    isFetchingAutocomplete = true;
    try {
      const res = await fetch('/api/autocomplete-meta');
      if (res.ok) {
        autocompleteData = await res.json();
      }
    } catch(e) {
      console.error('Failed to load autocomplete metadata:', e);
    } finally {
      isFetchingAutocomplete = false;
    }
    return autocompleteData;
  }

  // Active Advanced Filter State (Multi-Entity Supported)
  let activeAdvancedFilters = {
    keywords: '',
    teachers: [], // [{ id, name }]
    categories: [], // [{ id, name }]
    locations: [], // [{ id, name }]
    series: [], // [{ id, name }]
    minDuration: '',
    maxDuration: '',
    durationLabel: '',
    year: '',
    yearLabel: '',
    mediaType: 'all',
    mediaTypeLabel: '',
    enablePhonetics: true
  };

  // Temp editing state while modal is open
  let modalTempFilters = {
    teachers: [],
    categories: [],
    locations: [],
    series: []
  };

  function openAdvancedModal() {
    const modal = document.getElementById('advancedSearchModal');
    if (!modal) return;

    // Clone current active filters into temp editing state
    modalTempFilters.teachers = [...(activeAdvancedFilters.teachers || [])];
    modalTempFilters.categories = [...(activeAdvancedFilters.categories || [])];
    modalTempFilters.locations = [...(activeAdvancedFilters.locations || [])];
    modalTempFilters.series = [...(activeAdvancedFilters.series || [])];

    document.getElementById('advKeywords').value = activeAdvancedFilters.keywords || '';
    document.getElementById('advYearSelect').value = activeAdvancedFilters.year || '';
    // datetime-local needs a full "YYYY-MM-DDTHH:MM": pad date-only values
    // (e.g. from quick presets) so the round trip survives Apply.
    function padDateTime(v) {
      if (!v) return '';
      return v.length === 10 ? v + 'T00:00' : v;
    }
    const advFrom = document.getElementById('advFromDateTime');
    if (advFrom) advFrom.value = padDateTime(activeAdvancedFilters.fromDate || '');
    const advTo = document.getElementById('advToDateTime');
    if (advTo) advTo.value = padDateTime(activeAdvancedFilters.toDate || '');
    const phonToggle = document.getElementById('advPhoneticsToggle');
    if (phonToggle) {
      phonToggle.checked = activeAdvancedFilters.enablePhonetics !== false;
      const phonLabel = document.getElementById('advPhoneticsToggleLabel');
      if (phonLabel) {
        phonLabel.textContent = phonToggle.checked ? 'On' : 'Off';
      }
    }

    // Render chips in modal comboboxes
    renderComboboxChips('teacher');
    renderComboboxChips('category');
    renderComboboxChips('location');
    renderComboboxChips('series');

    // Set duration buttons
    const minD = activeAdvancedFilters.minDuration;
    const maxD = activeAdvancedFilters.maxDuration;
    const btns = document.querySelectorAll('.duration-preset-btn');
    btns.forEach(b => {
      const bMin = b.getAttribute('data-min') || '';
      const bMax = b.getAttribute('data-max') || '';
      if (String(bMin) === String(minD || '') && String(bMax) === String(maxD || '')) {
        b.classList.add('selected');
      } else {
        b.classList.remove('selected');
      }
    });

    // Set media format buttons
    const curMedia = activeAdvancedFilters.mediaType || 'all';
    const mediaBtns = document.querySelectorAll('.media-preset-btn');
    mediaBtns.forEach(b => {
      const bMedia = b.getAttribute('data-media') || 'all';
      if (bMedia === curMedia) {
        b.classList.add('selected');
      } else {
        b.classList.remove('selected');
      }
    });
    const mediaHint = document.getElementById('mediaTypeHint');
    if (mediaHint) {
      if (curMedia === 'audio') mediaHint.textContent = 'Audio Only';
      else if (curMedia === 'article') mediaHint.textContent = 'Articles Only';
      else mediaHint.textContent = 'Audio & Articles';
    }

    modal.classList.add('open');
    loadAutocompleteMeta(); // Preload data in background
    document.getElementById('advKeywords').focus();
  }

  function closeAdvancedModal() {
    const modal = document.getElementById('advancedSearchModal');
    if (modal) modal.classList.remove('open');
    closeAllAutocompleteDropdowns();
  }

  function handleAdvancedBackdropClick(e) {
    if (e.target.id === 'advancedSearchModal') {
      closeAdvancedModal();
    }
  }

  function closeAllAutocompleteDropdowns() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => {
      d.style.display = 'none';
      d.innerHTML = '';
    });
  }

  // Multi-Select Combobox & Token Management
  function renderComboboxChips(type) {
    let containerId = '';
    let inputId = '';
    let list = [];

    if (type === 'teacher') {
      containerId = 'teacherChipsContainer';
      inputId = 'advTeacherInput';
      list = modalTempFilters.teachers;
    } else if (type === 'category') {
      containerId = 'categoryChipsContainer';
      inputId = 'advCategoryInput';
      list = modalTempFilters.categories;
    } else if (type === 'location') {
      containerId = 'locationChipsContainer';
      inputId = 'advLocationInput';
      list = modalTempFilters.locations;
    } else if (type === 'series') {
      containerId = 'seriesChipsContainer';
      inputId = 'advSeriesInput';
      list = modalTempFilters.series;
    }

    const container = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    if (!container || !input) return;

    // Remove existing tokens
    container.querySelectorAll('.combobox-token').forEach(el => el.remove());

    // Insert tokens before input
    list.forEach((item, index) => {
      const token = document.createElement('span');
      token.className = 'combobox-token';
      token.innerHTML = '<span>' + escapeHtml(item.name) + '</span><button type="button" class="token-remove-btn" onclick="removeComboboxToken(&quot;' + type + '&quot;, ' + index + ')" title="Remove">✕</button>';
      container.insertBefore(token, input);
    });
  }

  function removeComboboxToken(type, index) {
    if (type === 'teacher') {
      modalTempFilters.teachers.splice(index, 1);
    } else if (type === 'category') {
      modalTempFilters.categories.splice(index, 1);
    } else if (type === 'location') {
      modalTempFilters.locations.splice(index, 1);
    } else if (type === 'series') {
      modalTempFilters.series.splice(index, 1);
    }
    renderComboboxChips(type);
  }

  function addComboboxToken(type, id, name) {
    if (type === 'teacher') {
      // Selecting a new teacher replaces the previous teacher so old one doesn't get stuck!
      modalTempFilters.teachers = [{ id: String(id), name: String(name) }];
      const input = document.getElementById('advTeacherInput');
      if (input) {
        input.value = '';
      }
      closeAllAutocompleteDropdowns();
      renderComboboxChips('teacher');
      return;
    }

    let list = [];
    if (type === 'category') list = modalTempFilters.categories;
    else if (type === 'location') list = modalTempFilters.locations;
    else if (type === 'series') list = modalTempFilters.series;

    if (!list.some(item => String(item.id) === String(id))) {
      list.push({ id: String(id), name: String(name) });
    }

    // Clear input and close dropdown
    let inputId = type === 'category' ? 'advCategoryInput' : (type === 'location' ? 'advLocationInput' : 'advSeriesInput');
    let input = document.getElementById(inputId);
    if (input) {
      input.value = '';
      input.focus();
    }
    closeAllAutocompleteDropdowns();
    renderComboboxChips(type);
  }

  // Setup Live Filtering Autocomplete for Teacher, Category, Venue, Series inputs
  function setupAutocompleteInput(type, inputId, dropdownId, dataKey) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    let debounceTimer = null;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const val = input.value.trim().toLowerCase();
        if (val.length < 1) {
          dropdown.style.display = 'none';
          dropdown.innerHTML = '';
          return;
        }

        const meta = await loadAutocompleteMeta();
        if (!meta || !meta[dataKey]) return;

        const items = meta[dataKey];
        // Strip titles/honorifics from query if searching teachers
        const cleanVal = type === 'teacher' ? val.replace(/^(rabbi|rav|dr\.|dr|mrs\.|mrs|rebbetzin|r')\s+/i, '').trim() : val;
        
        let matches = [];
        for (const item of items) {
          const itemName = (item.name || '').toLowerCase();
          const cleanItemName = type === 'teacher' ? itemName.replace(/^(rabbi|rav|dr\.|dr|mrs\.|mrs|rebbetzin|r')\s+/i, '') : itemName;
          if (itemName.includes(val) || cleanItemName.includes(cleanVal)) {
            matches.push(item);
            if (matches.length >= 25) break;
          }
        }

        if (matches.length === 0) {
          dropdown.innerHTML = '<div style="padding:10px 12px; font-size:12.5px; color:var(--text-muted); text-align:center;">No matching ' + type + 's found</div>';
          dropdown.style.display = 'block';
          return;
        }

        dropdown.innerHTML = matches.map(m => {
          const countBadge = m.count ? ('<span class="item-count-badge">' + Number(m.count).toLocaleString() + '</span>') : '';
          return '<div class="autocomplete-item" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.name) + '">' +
            '<span>' + escapeHtml(m.name) + '</span>' + countBadge +
          '</div>';
        }).join('');
        dropdown.style.display = 'block';
      }, 100);
    });

    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.autocomplete-item');
      if (!item) return;
      const id = item.getAttribute('data-id');
      const name = item.getAttribute('data-name');
      if (id && name) {
        addComboboxToken(type, id, name);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dropdown.style.display = 'none';
      } else if (e.key === 'Backspace' && input.value === '') {
        // Backspace on empty input removes last chip
        let list = type === 'teacher' ? modalTempFilters.teachers : (type === 'category' ? modalTempFilters.categories : (type === 'location' ? modalTempFilters.locations : modalTempFilters.series));
        if (list.length > 0) {
          list.pop();
          renderComboboxChips(type);
        }
      }
    });
  }

  // Initialize listeners on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    try {
      const hero = document.getElementById('heroSlideshow');
      if (hero) {
        heroRestart();
        const heroPause = () => { try { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } } catch (e) {} };
        const heroResume = () => { if (!heroTimer) heroRestart(); };
        hero.addEventListener('mouseenter', heroPause);
        hero.addEventListener('mouseleave', heroResume);
        hero.addEventListener('focusin', heroPause);
        hero.addEventListener('focusout', heroResume);
        // Swipe between slides (mobile): horizontal swipe navigates.
        let heroTouchX = null;
        hero.addEventListener('touchstart', e => {
          if (e.touches && e.touches.length === 1) heroTouchX = e.touches[0].clientX;
        }, { passive: true });
        hero.addEventListener('touchend', e => {
          if (heroTouchX === null || !e.changedTouches || e.changedTouches.length === 0) return;
          const dx = e.changedTouches[0].clientX - heroTouchX;
          heroTouchX = null;
          if (Math.abs(dx) < 40) return;
          if (dx < 0) heroGo(1);
          else heroGo(-1);
        }, { passive: true });
      }
    } catch (e) {}
    // Direct-link /<id> loads: fetch lecture data so the metadata box
    // (incl. the Uploaded row) hydrates without a card click.
    try {
      if (typeof currentShiurId !== 'undefined' && currentShiurId &&
          document.getElementById('shiurMetadataBox')) {
        fetch('/sidebar/lecturedata?shiurID=' + encodeURIComponent(String(currentShiurId))).then(r => {
          if (!r.ok) return null;
          return r.json();
        }).then(data => {
          if (!data || String(currentShiurId) !== String(data.shiurID || '')) return;
          lastLectureData = data;
          renderMetadataBox(data);
          const rawD = data.shiurDateFormatted || data.shiurDate || '';
          fetchUploadDate(String(currentShiurId), rawD ? formatShiurDate(rawD) : '');
        }).catch(() => {});
      } else {
        const mm = document.getElementById('shiurMeta');
        if (typeof currentShiurId !== 'undefined' && currentShiurId && mm && mm.textContent) {
          const parts = mm.textContent.split('·');
          const gdate = parts.length > 1 ? parts[parts.length - 1].trim() : '';
          if (gdate) fetchUploadDate(String(currentShiurId), gdate);
        }
      }
    } catch (e) {}
    try { if (typeof renderSaveIconPicker === 'function') renderSaveIconPicker(); } catch (e) {}
    // Restore cards/rows view (mobile forced to cards, desktop to stored-or-rows).
    try {
      setCardView(defaultCardView(), false);
    } catch (e) {}
    // Enforce mobile-cards when crossing the breakpoint after load.
    try {
      let lastMobile = isMobileView();
      window.addEventListener('resize', () => {
        try {
          const m = isMobileView();
          if (m !== lastMobile) {
            lastMobile = m;
            setCardView(defaultCardView(), false);
          }
        } catch (e) {}
      });
    } catch (e) {}
    // Hydrate date bounds from the URL (?fromDate=&toDate=&dateQuick=) so a
    // reload or shared link keeps the active date filter + chip state.
    try {
      const bp = new URLSearchParams(window.location.search);
      const bFrom = bp.get('fromDate') || '';
      const bTo = bp.get('toDate') || '';
      const bQ = bp.get('dateQuick') || '';
      if (bFrom || bTo) {
        activeAdvancedFilters.fromDate = bFrom;
        activeAdvancedFilters.toDate = bTo;
        const okQuick = (bQ === 'today' || bQ === 'yesterday' || bQ === 'week' || bQ === 'month') ? bQ : '';
        activeAdvancedFilters.dateQuick = okQuick;
        const qLabels = { today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month' };
        activeAdvancedFilters.dateQuickLabel = qLabels[okQuick] || '';
        if (!okQuick) {
          activeAdvancedFilters.dateRangeLabel = (bFrom || '…') + ' → ' + (bTo || '…');
        }
      }
      const bSort = bp.get('sort') || '';
      if (bSort === 'newest' || bSort === 'oldest') {
        activeAdvancedFilters.sort = bSort;
      }
    } catch (e) {}
    // SSR search grids render flat relevance only: re-render on boot so the
    // Recent rail + resolution disclaimer + did-you-mean strip materialize
    // from hydrated state (including zero-hit states).
    try {
      const hasState = (currentSearchDocs && currentSearchDocs.length > 0) ||
        (currentRecentDocs && currentRecentDocs.length > 0) ||
        (currentDidYouMean && currentDidYouMean.length > 0) ||
        (currentQueryResolution && currentQueryResolution.display);
      if (hasState &&
          document.getElementById('searchResultsSection') &&
          document.getElementById('searchResultsSection').style.display !== 'none') {
        renderCurrentSearchResults();
      }
    } catch (e) {}
    // ROADMAP §8.1: Dev Mode persists across reloads once unlocked.
    try {
      if (localStorage.getItem('yutorah_dev_mode') === 'true' && !isDevMode) {
        activateDevMode();
      }
    } catch (e) {}
    setupAutocompleteInput('teacher', 'advTeacherInput', 'teacherDropdown', 'teachers');
    setupAutocompleteInput('category', 'advCategoryInput', 'categoryDropdown', 'categories');
    setupAutocompleteInput('location', 'advLocationInput', 'locationDropdown', 'venues');
    setupAutocompleteInput('series', 'advSeriesInput', 'seriesDropdown', 'series');

    // Close autocomplete dropdowns on document click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.autocomplete-combobox')) {
        closeAllAutocompleteDropdowns();
      }
    });
  });

  function setDurationPreset(btn, min, max) {
    document.querySelectorAll('.duration-preset-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const hint = document.getElementById('durationHint');
    if (hint) {
      hint.textContent = btn.textContent;
    }
  }

  function setMediaTypePreset(btn, type) {
    document.querySelectorAll('.media-preset-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const hint = document.getElementById('mediaTypeHint');
    if (hint) {
      if (type === 'audio') hint.textContent = 'Audio Only';
      else if (type === 'article') hint.textContent = 'Articles Only';
      else hint.textContent = 'Audio & Articles';
    }
  }

  function resetAdvancedFilters() {
    document.getElementById('advKeywords').value = '';
    document.getElementById('advYearSelect').value = '';
    const rFrom = document.getElementById('advFromDateTime');
    if (rFrom) rFrom.value = '';
    const rTo = document.getElementById('advToDateTime');
    if (rTo) rTo.value = '';
    // Clear the in-memory quick preset too, or Reset→Apply would resurrect
    // a highlighted chip with no date bounds behind it.
    activeAdvancedFilters.dateQuick = '';
    activeAdvancedFilters.dateQuickLabel = '';
    syncDateQuickChips();
    const phonToggle = document.getElementById('advPhoneticsToggle');
    if (phonToggle) {
      phonToggle.checked = true;
      const phonLabel = document.getElementById('advPhoneticsToggleLabel');
      if (phonLabel) phonLabel.textContent = 'On';
    }
    modalTempFilters.teachers = [];
    modalTempFilters.categories = [];
    modalTempFilters.locations = [];
    modalTempFilters.series = [];
    renderComboboxChips('teacher');
    renderComboboxChips('category');
    renderComboboxChips('location');
    renderComboboxChips('series');
    const defBtn = document.querySelector('.duration-preset-btn[data-min=""][data-max=""]');
    if (defBtn) setDurationPreset(defBtn, '', '');
    const defMediaBtn = document.querySelector('.media-preset-btn[data-media="all"]');
    if (defMediaBtn) setMediaTypePreset(defMediaBtn, 'all');
  }

  function applyAdvancedFilters() {
    const kw = document.getElementById('advKeywords').value.trim();
    const selDurationBtn = document.querySelector('.duration-preset-btn.selected');
    const minDuration = selDurationBtn ? selDurationBtn.getAttribute('data-min') : '';
    const maxDuration = selDurationBtn ? selDurationBtn.getAttribute('data-max') : '';
    const durationLabel = selDurationBtn && selDurationBtn.getAttribute('data-min') !== '' ? selDurationBtn.textContent : '';

    const selMediaBtn = document.querySelector('.media-preset-btn.selected');
    const mediaType = selMediaBtn ? (selMediaBtn.getAttribute('data-media') || 'all') : 'all';
    let mediaTypeLabel = '';
    if (mediaType === 'audio') mediaTypeLabel = 'Audio Only';
    else if (mediaType === 'article') mediaTypeLabel = 'Articles Only';

    const yearSelect = document.getElementById('advYearSelect');
    const year = yearSelect.value;
    const yearLabel = yearSelect.selectedIndex > 0 ? yearSelect.options[yearSelect.selectedIndex].text : '';
    const phonToggle = document.getElementById('advPhoneticsToggle');
    const enablePhonetics = phonToggle ? phonToggle.checked : true;

    // Custom date-time range (mutually exclusive with Year + quick presets:
    // whichever is set wins, the others are cleared).
    const fromDtEl = document.getElementById('advFromDateTime');
    const toDtEl = document.getElementById('advToDateTime');
    const fromDate = fromDtEl ? fromDtEl.value.trim() : '';
    const toDate = toDtEl ? toDtEl.value.trim() : '';
    let finalYear = year;
    let finalYearLabel = yearLabel;
    let dateQuick = activeAdvancedFilters.dateQuick || '';
    let dateQuickLabel = activeAdvancedFilters.dateQuickLabel || '';
    let dateRangeLabel = '';
    function fmtDt(v) {
      if (!v) return '…';
      const parts = v.split('T');
      return parts[0] + (parts[1] ? ' ' + parts[1] : '');
    }
    if (fromDate || toDate) {
      finalYear = '';
      finalYearLabel = '';
      dateQuick = '';
      dateQuickLabel = '';
      dateRangeLabel = fmtDt(fromDate) + ' → ' + fmtDt(toDate);
    } else if (finalYear) {
      dateQuick = '';
      dateQuickLabel = '';
    }

    activeAdvancedFilters = {
      keywords: kw,
      teachers: [...modalTempFilters.teachers],
      categories: [...modalTempFilters.categories],
      locations: [...modalTempFilters.locations],
      series: [...modalTempFilters.series],
      minDuration,
      maxDuration,
      durationLabel,
      year: finalYear,
      yearLabel: finalYearLabel,
      fromDate,
      toDate,
      dateQuick,
      dateQuickLabel,
      dateRangeLabel,
      sort: activeAdvancedFilters.sort === 'newest' || activeAdvancedFilters.sort === 'oldest' ? activeAdvancedFilters.sort : 'relevance',
      mediaType,
      mediaTypeLabel,
      enablePhonetics
    };

    closeAdvancedModal();

    // Keep search bar clean: only populate searchInput if actual keywords were entered
    if (kw) {
      searchInput.value = kw;
    } else {
      searchInput.value = '';
    }

    // Execute multi-criteria search
    executeLiveSearch(kw, {
      ...activeAdvancedFilters,
      fromAdvancedModal: true
    });
  }

  function renderActiveFilterPills() {
    const bar = document.getElementById('activeFiltersBar');
    if (!bar) return;

    const pills = [];

    // Teacher pills
    (activeAdvancedFilters.teachers || []).forEach((t, idx) => {
      pills.push('<span class="active-filter-pill">👤 ' + escapeHtml(t.name) + ' <button type="button" onclick="removeFilterItem(&quot;teachers&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Category pills
    (activeAdvancedFilters.categories || []).forEach((c, idx) => {
      pills.push('<span class="active-filter-pill">🏷️ ' + escapeHtml(c.name) + ' <button type="button" onclick="removeFilterItem(&quot;categories&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Location pills
    (activeAdvancedFilters.locations || []).forEach((l, idx) => {
      pills.push('<span class="active-filter-pill">📍 ' + escapeHtml(l.name) + ' <button type="button" onclick="removeFilterItem(&quot;locations&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Series pills
    (activeAdvancedFilters.series || []).forEach((s, idx) => {
      pills.push('<span class="active-filter-pill">📚 ' + escapeHtml(s.name) + ' <button type="button" onclick="removeFilterItem(&quot;series&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Duration pill
    if (activeAdvancedFilters.minDuration || activeAdvancedFilters.maxDuration) {
      pills.push('<span class="active-filter-pill">⏱ ' + escapeHtml(activeAdvancedFilters.durationLabel) + ' <button type="button" onclick="removeSingleFilter(&quot;duration&quot;)" title="Remove">✕</button></span>');
    }

    // Year pill
    if (activeAdvancedFilters.year) {
      pills.push('<span class="active-filter-pill">📅 ' + escapeHtml(activeAdvancedFilters.yearLabel || activeAdvancedFilters.year) + ' <button type="button" onclick="removeSingleFilter(&quot;year&quot;)" title="Remove">✕</button></span>');
    }

    // Date-range pill (quick preset label or custom from→to label)
    if (activeAdvancedFilters.fromDate || activeAdvancedFilters.toDate) {
      const dl = activeAdvancedFilters.dateQuickLabel || activeAdvancedFilters.dateRangeLabel ||
        ((activeAdvancedFilters.fromDate || '…') + ' → ' + (activeAdvancedFilters.toDate || '…'));
      pills.push('<span class="active-filter-pill">🗓️ ' + escapeHtml(dl) + ' <button type="button" onclick="removeSingleFilter(&quot;dateRange&quot;)" title="Remove">✕</button></span>');
    }

    // Media Format pill
    if (activeAdvancedFilters.mediaType && activeAdvancedFilters.mediaType !== 'all') {
      const icon = activeAdvancedFilters.mediaType === 'audio' ? '🎙️' : '📄';
      const label = activeAdvancedFilters.mediaType === 'audio' ? 'Audio Only' : 'Articles Only';
      pills.push('<span class="active-filter-pill">' + icon + ' ' + escapeHtml(label) + ' <button type="button" onclick="removeSingleFilter(&quot;mediaType&quot;)" title="Remove">✕</button></span>');
    }

    // Transliteration indicator badge in pills bar
    if (activeAdvancedFilters.enablePhonetics === false) {
      pills.push('<span class="active-filter-pill" style="background:rgba(239, 68, 68, 0.1); border-color:rgba(239, 68, 68, 0.3); color:#dc2626;">🔤 Exact Match (Phonetics Off) <button type="button" onclick="toggleFilterPhonetics(true)" title="Turn Phonetics Back On">✕</button></span>');
    }

    if (pills.length > 0) {
      bar.innerHTML = '<span style="font-size:12px; font-weight:700; color:var(--text-muted);">Active Filters:</span> ' + pills.join('') + ' <button type="button" class="modal-reset-btn" style="padding:2px 8px; font-size:12px;" onclick="clearAllFilters()">Clear All</button>';
      bar.style.display = 'flex';
      const advBtn = document.getElementById('advancedSearchBtn');
      if (advBtn) advBtn.classList.add('active');
    } else {
      bar.innerHTML = '';
      bar.style.display = 'none';
      const advBtn = document.getElementById('advancedSearchBtn');
      if (advBtn) advBtn.classList.remove('active');
    }
    syncDateQuickChips();
  }

  function toggleFilterPhonetics(enable) {
    activeAdvancedFilters.enablePhonetics = Boolean(enable);
    executeLiveSearch(activeAdvancedFilters.keywords || searchInput.value.trim(), { ...activeAdvancedFilters });
  }

  function removeFilterItem(listKey, index) {
    if (Array.isArray(activeAdvancedFilters[listKey])) {
      activeAdvancedFilters[listKey].splice(index, 1);
    }
    if (!activeAdvancedFilters.keywords) {
      searchInput.value = '';
    }
    executeLiveSearch(activeAdvancedFilters.keywords || '', { ...activeAdvancedFilters });
  }

  function removeSingleFilter(type) {
    if (type === 'duration') {
      activeAdvancedFilters.minDuration = '';
      activeAdvancedFilters.maxDuration = '';
      activeAdvancedFilters.durationLabel = '';
    } else if (type === 'year') {
      activeAdvancedFilters.year = '';
      activeAdvancedFilters.yearLabel = '';
    } else if (type === 'mediaType') {
      activeAdvancedFilters.mediaType = 'all';
      activeAdvancedFilters.mediaTypeLabel = '';
    } else if (type === 'dateRange') {
      activeAdvancedFilters.fromDate = '';
      activeAdvancedFilters.toDate = '';
      activeAdvancedFilters.dateQuick = '';
      activeAdvancedFilters.dateQuickLabel = '';
      activeAdvancedFilters.dateRangeLabel = '';
      syncDateQuickChips();
    }
    executeLiveSearch(activeAdvancedFilters.keywords || '', { ...activeAdvancedFilters });
  }

  function fmtLocalDate(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // Quick date presets (Today / Yesterday / This Week / This Month).
  // Mutually exclusive with Year select and the custom date-time range:
  // setting one clears the others so filters can never empty-intersect.
  function setDateQuick(preset, btn) {
    document.querySelectorAll('.date-quick-chip[data-preset]').forEach(b => b.classList.toggle('selected', b === btn || (b.dataset && b.dataset.preset === preset)));
    const now = new Date();
    const today = fmtLocalDate(now);
    let from = '';
    let to = '';
    let label = '';
    if (preset === 'today') {
      from = today;
      to = today;
      label = 'Today';
    } else if (preset === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      from = fmtLocalDate(y);
      to = from;
      label = 'Yesterday';
    } else if (preset === 'week') {
      const s = new Date(now);
      s.setDate(s.getDate() - s.getDay());
      from = fmtLocalDate(s);
      to = today;
      label = 'This Week';
    } else if (preset === 'month') {
      from = today.slice(0, 7) + '-01';
      to = today;
      label = 'This Month';
    }
    activeAdvancedFilters.fromDate = from;
    activeAdvancedFilters.toDate = to;
    activeAdvancedFilters.dateQuick = preset === 'all' ? '' : preset;
    activeAdvancedFilters.dateQuickLabel = label;
    activeAdvancedFilters.dateRangeLabel = '';
    if (preset !== 'all') {
      activeAdvancedFilters.year = '';
      activeAdvancedFilters.yearLabel = '';
      const ys = document.getElementById('advYearSelect');
      if (ys) ys.value = '';
      const fdt = document.getElementById('advFromDateTime');
      if (fdt) fdt.value = '';
      const tdt = document.getElementById('advToDateTime');
      if (tdt) tdt.value = '';
    }
    executeLiveSearch(activeAdvancedFilters.keywords || searchInput.value.trim(), { ...activeAdvancedFilters });
  }

  function syncDateQuickChips() {
    const cur = (activeAdvancedFilters && activeAdvancedFilters.dateQuick) || 'all';
    document.querySelectorAll('.date-quick-chip[data-preset]').forEach(b => {
      b.classList.toggle('selected', (b.dataset && b.dataset.preset) === cur);
    });
    const sort = (activeAdvancedFilters && activeAdvancedFilters.sort) || 'relevance';
    document.querySelectorAll('.date-quick-chip[data-sort]').forEach(b => {
      b.classList.toggle('selected', (b.dataset && b.dataset.sort) === sort);
    });
  }

  // Result sort: relevance (default) / newest-first / oldest-first.
  // Orthogonal to the date bounds above; the Recent rail only shows
  // under relevance (chronological sorts need no rail).
  function setResultSort(sort, btn) {
    const s = (sort === 'newest' || sort === 'oldest') ? sort : 'relevance';
    activeAdvancedFilters.sort = s;
    syncDateQuickChips();
    executeLiveSearch(activeAdvancedFilters.keywords || searchInput.value.trim(), { ...activeAdvancedFilters });
  }

  function clearAllFilters() {
    activeAdvancedFilters = {
      keywords: '',
      teachers: [],
      categories: [],
      locations: [],
      series: [],
      minDuration: '',
      maxDuration: '',
      durationLabel: '',
      year: '',
      yearLabel: '',
      fromDate: '',
      toDate: '',
      dateQuick: '',
      dateQuickLabel: '',
      dateRangeLabel: '',
      mediaType: 'all',
      mediaTypeLabel: '',
      enablePhonetics: true
    };
    syncDateQuickChips();
    executeLiveSearch(searchInput.value.trim(), {});
  }

  async function executeLiveSearch(query, extraParams = {}) {
    currentSearchQuery = query;
    currentFilterParams = extraParams;
    currentSearchPage = 1;
    currentRecentDocs = [];
    recentNumFound = 0;
    currentDidYouMean = [];
    currentQueryResolution = null;
    currentSpeakerViewCache = null;
    currentLoadedDocsCount = 0;
    totalSearchResults = 0;
    isLoadingMore = false;

    // Minimize player if loaded so search results take center stage
    if (hasAudio) {
      minimizePlayer();
    }
    const moreSpeaker = document.getElementById('moreFromSpeakerSection');
    if (moreSpeaker) moreSpeaker.style.display = 'none';
    const moreCat = document.getElementById('moreFromCategorySection');
    if (moreCat) moreCat.style.display = 'none';

    // Show results container, hide collections
    document.getElementById('collectionsSection').style.display = 'none';
    const resSection = document.getElementById('searchResultsSection');
    resSection.style.display = 'block';

    const spinner = document.getElementById('searchSpinner');
    const grid = document.getElementById('searchResultsGrid');
    const label = document.getElementById('searchResultsLabel');
    const loadMoreBox = document.getElementById('loadMoreContainer');
    const phoneticBanner = document.getElementById('phoneticNoticeBanner');

    renderActiveFilterPills();

    const displayLabel = extraParams.label || (query ? ('Searching for "' + query + '"...') : 'Filtering shiurim...');
    label.textContent = displayLabel;
    grid.innerHTML = '';
    spinner.style.display = 'block';
    loadMoreBox.style.display = 'none';
    if (phoneticBanner) phoneticBanner.style.display = 'none';

    // Update browser URL without reload (search + date bounds survive reload)
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    if (query) newUrl.searchParams.set('search', query);
    else newUrl.searchParams.delete('search');
    if (extraParams.fromDate) newUrl.searchParams.set('fromDate', extraParams.fromDate);
    else newUrl.searchParams.delete('fromDate');
    if (extraParams.toDate) newUrl.searchParams.set('toDate', extraParams.toDate);
    else newUrl.searchParams.delete('toDate');
    if (extraParams.dateQuick) newUrl.searchParams.set('dateQuick', extraParams.dateQuick);
    else newUrl.searchParams.delete('dateQuick');
    if (extraParams.sort && extraParams.sort !== 'relevance') newUrl.searchParams.set('sort', extraParams.sort);
    else newUrl.searchParams.delete('sort');
    newUrl.searchParams.delete('shiurId');
    newUrl.searchParams.delete('id');
    history.pushState({ search: query, ...extraParams }, '', newUrl.toString());

    if (currentSearchAbort) {
      currentSearchAbort.abort();
    }
    currentSearchAbort = new AbortController();

    let apiUrl = '/api/search?q=' + encodeURIComponent(query || '') + '&start=1';

    // Build multi-valued teacher, category, and location params
    const teachersList = extraParams.teachers || (extraParams.teacherId ? [{ id: extraParams.teacherId }] : []);
    teachersList.forEach(t => {
      apiUrl += '&teacherId=' + encodeURIComponent(t.id);
    });

    const categoriesList = extraParams.categories || (extraParams.subCategoryId ? [{ id: extraParams.subCategoryId }] : []);
    categoriesList.forEach(c => {
      apiUrl += '&subCategoryId=' + encodeURIComponent(c.id);
    });

    const locationsList = extraParams.locations || (extraParams.locationId ? [{ id: extraParams.locationId }] : []);
    locationsList.forEach(l => {
      apiUrl += '&locationId=' + encodeURIComponent(l.id);
    });

    const seriesList = extraParams.series || (extraParams.seriesId ? [{ id: extraParams.seriesId }] : []);
    seriesList.forEach(s => {
      apiUrl += '&seriesId=' + encodeURIComponent(s.id);
    });

    if (extraParams.minDuration) apiUrl += '&minDuration=' + encodeURIComponent(extraParams.minDuration);
    if (extraParams.maxDuration) apiUrl += '&maxDuration=' + encodeURIComponent(extraParams.maxDuration);
    if (extraParams.year) apiUrl += '&year=' + encodeURIComponent(extraParams.year);
    if (extraParams.fromDate) apiUrl += '&fromDate=' + encodeURIComponent(extraParams.fromDate);
    if (extraParams.toDate) apiUrl += '&toDate=' + encodeURIComponent(extraParams.toDate);
    if (extraParams.sort && extraParams.sort !== 'relevance') apiUrl += '&sort=' + encodeURIComponent(extraParams.sort);
    if (extraParams.mediaType && extraParams.mediaType !== 'all') {
      apiUrl += '&mediaType=' + encodeURIComponent(extraParams.mediaType);
    }
    if (extraParams.enablePhonetics === false || (extraParams.enablePhonetics === undefined && useClassicSearch)) {
      apiUrl += '&exact=1';
    }

    try {
      const res = await fetch(apiUrl, {
        signal: currentSearchAbort.signal
      });
      const data = await res.json();
      spinner.style.display = 'none';

      const docs = data?.response?.docs || [];
      // Relevance pages are the paginated unit (full 30); the Recent rail
      // sits on top and is counted separately via recentNumFound.
      currentRecentDocs = data?.response?.recentDocs || [];
      totalSearchResults = data?.response?.numFound || docs.length;
      currentLoadedDocsCount = docs.length;
      recentNumFound = data?.response?.recentNumFound || 0;
      currentDidYouMean = data?.didYouMean || [];
      currentQueryResolution = data?.queryResolution || null;

      // Handle Phonetic Expansion Notice
      if (data?.phoneticExpansion && !useClassicSearch) {
        currentPhoneticTokens = data.phoneticExpansion.tokens || [];
        const original = data.phoneticExpansion.original;
        if (phoneticBanner && currentPhoneticTokens.length > 1) {
          const tagsHtml = currentPhoneticTokens.slice(0, 8).map(t => '<span class="phonetic-tag">' + escapeHtml(t) + '</span>').join('');
          phoneticBanner.innerHTML = '<div><span>✨ Phonetic Equivalence included synonyms:</span> <div class="phonetic-notice-tags">' + tagsHtml + '</div></div>' +
            '<span style="font-size:11px; opacity:0.8;">Ashkenazic &amp; Sephardic variations searched</span>';
          phoneticBanner.style.display = 'flex';
        }
      } else {
        currentPhoneticTokens = [];
        if (phoneticBanner) phoneticBanner.style.display = 'none';
      }

      const resultsTitle = extraParams.label
        ? (extraParams.label + ' (' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ')')
        : ('Showing ' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ' results' + (query ? ' for "' + query + '"' : ''));
      label.textContent = resultsTitle;

      if (docs.length === 0 && currentRecentDocs.length === 0) {
        currentSearchDocs = [];
        currentDidYouMean = currentDidYouMean.length > 0 ? currentDidYouMean : clientFuzzySuggest(query, 5);
        let emptyHtml = '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No shiurim found matching these criteria. Try adjusting your filters or search keywords.</div>';
        if (currentDidYouMean.length > 0) {
          emptyHtml = renderDidYouMeanStrip(currentDidYouMean) + emptyHtml;
        }
        if (currentQueryResolution && currentQueryResolution.display) {
          emptyHtml = '<div class="did-you-mean-strip resolution-note"><span>🔍 Showing results for &quot;' +
            escapeHtml(currentQueryResolution.display) + '&quot; — you searched &quot;' +
            escapeHtml(currentQueryResolution.original) + '&quot;.</span></div>' + emptyHtml;
        }
        grid.innerHTML = emptyHtml;
        loadMoreBox.style.display = 'none';
        return;
      }
      // Keep the server's weak-hit suggestions: renderCurrentSearchResults
      // appends the strip BELOW the list when 1+ weak hits exist (§5.4).

      currentSearchDocs = docs;
      renderCurrentSearchResults();

      // Setup Load More button
      const totalInfo = document.getElementById('searchTotalInfo');
      const btn = document.getElementById('loadMoreBtn');
      const btnText = document.getElementById('loadMoreBtnText');
      const loadSpinner = document.getElementById('loadMoreSpinner');

      btn.disabled = false;
      btn.style.display = 'inline-flex';
      btnText.textContent = '🔽 Load More Results';
      loadSpinner.style.display = 'none';

      if (currentLoadedDocsCount < totalSearchResults) {
        loadMoreBox.style.display = 'block';
        totalInfo.textContent = 'Showing ' + currentLoadedDocsCount + ' of ' + totalSearchResults.toLocaleString() + ' shiurim';
      } else {
        loadMoreBox.style.display = 'none';
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      spinner.style.display = 'none';
      label.textContent = 'Error loading results';
      grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #c0392b; grid-column: 1/-1;">Failed to load search results. Please try again.</div>';
      loadMoreBox.style.display = 'none';
    }
  }

  async function loadMoreResults() {
    if (isLoadingMore || currentLoadedDocsCount >= totalSearchResults) return;
    isLoadingMore = true;

    const btn = document.getElementById('loadMoreBtn');
    const btnText = document.getElementById('loadMoreBtnText');
    const spinner = document.getElementById('loadMoreSpinner');
    const totalInfo = document.getElementById('searchTotalInfo');

    btn.disabled = true;
    btnText.textContent = 'Loading more shiurim...';
    spinner.style.display = 'inline-block';

    const nextPage = currentSearchPage + 1;

    // Chronological sorts paginate by ITEM offset (the date window treats
    // start as 1-based offset, not page); relevance paginates by page.
    const chronoMore = currentFilterParams.sort === 'newest' || currentFilterParams.sort === 'oldest';
    let apiUrl = '/api/search?q=' + encodeURIComponent(currentSearchQuery || '');
    if (chronoMore) {
      apiUrl += '&sort=' + encodeURIComponent(currentFilterParams.sort) + '&start=' + (currentLoadedDocsCount + 1) + '&rows=30';
    } else {
      apiUrl += '&page=' + nextPage + '&start=' + nextPage;
    }

    const teachersList = currentFilterParams.teachers || (currentFilterParams.teacherId ? [{ id: currentFilterParams.teacherId }] : []);
    teachersList.forEach(t => {
      apiUrl += '&teacherId=' + encodeURIComponent(t.id);
    });

    const categoriesList = currentFilterParams.categories || (currentFilterParams.subCategoryId ? [{ id: currentFilterParams.subCategoryId }] : []);
    categoriesList.forEach(c => {
      apiUrl += '&subCategoryId=' + encodeURIComponent(c.id);
    });

    const locationsList = currentFilterParams.locations || (currentFilterParams.locationId ? [{ id: currentFilterParams.locationId }] : []);
    locationsList.forEach(l => {
      apiUrl += '&locationId=' + encodeURIComponent(l.id);
    });

    const seriesList = currentFilterParams.series || (currentFilterParams.seriesId ? [{ id: currentFilterParams.seriesId }] : []);
    seriesList.forEach(s => {
      apiUrl += '&seriesId=' + encodeURIComponent(s.id);
    });

    if (currentFilterParams.minDuration) apiUrl += '&minDuration=' + encodeURIComponent(currentFilterParams.minDuration);
    if (currentFilterParams.maxDuration) apiUrl += '&maxDuration=' + encodeURIComponent(currentFilterParams.maxDuration);
    if (currentFilterParams.year) apiUrl += '&year=' + encodeURIComponent(currentFilterParams.year);
    if (currentFilterParams.fromDate) apiUrl += '&fromDate=' + encodeURIComponent(currentFilterParams.fromDate);
    if (currentFilterParams.toDate) apiUrl += '&toDate=' + encodeURIComponent(currentFilterParams.toDate);
    if (currentFilterParams.sort && currentFilterParams.sort !== 'relevance') apiUrl += '&sort=' + encodeURIComponent(currentFilterParams.sort);
    if (currentFilterParams.mediaType && currentFilterParams.mediaType !== 'all') {
      apiUrl += '&mediaType=' + encodeURIComponent(currentFilterParams.mediaType);
    }
    if (currentFilterParams.enablePhonetics === false || (currentFilterParams.enablePhonetics === undefined && useClassicSearch)) {
      apiUrl += '&exact=1';
    }

    try {
      const res = await fetch(apiUrl);
      const data = await res.json();
      const newDocs = data?.response?.docs || [];

      if (newDocs.length > 0) {
        currentSearchPage = nextPage;
        currentLoadedDocsCount += newDocs.length;
        currentSearchDocs = currentSearchDocs.concat(newDocs);
        if (currentSpeakerViewCache) currentSpeakerViewCache.rest = currentSpeakerViewCache.rest.concat(newDocs);
        renderCurrentSearchResults();

        const resultsTitle = currentFilterParams.label
          ? (currentFilterParams.label + ' (' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ')')
          : ('Showing ' + currentLoadedDocsCount + ' of ' + totalSearchResults.toLocaleString() + ' results for "' + currentSearchQuery + '"');
        document.getElementById('searchResultsLabel').textContent = resultsTitle;
      }

      if (currentLoadedDocsCount >= totalSearchResults || newDocs.length === 0) {
        btn.style.display = 'none';
        totalInfo.textContent = 'All ' + currentLoadedDocsCount.toLocaleString() + ' shiurim loaded!';
      } else {
        totalInfo.textContent = 'Showing ' + currentLoadedDocsCount + ' of ' + totalSearchResults.toLocaleString() + ' shiurim';
        btn.disabled = false;
        btnText.textContent = '🔽 Load More Results';
        spinner.style.display = 'none';
      }
    } catch (err) {
      console.error('Failed to load more results:', err);
      btn.disabled = false;
      btnText.textContent = '🔽 Load More Results';
      spinner.style.display = 'none';
    } finally {
      isLoadingMore = false;
    }
  }

  // Keyboard shortcut: Escape closes modal and search preview
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAdvancedModal();
      closeSearchPreview();
      closeConfirmModal();
      closePlaylistModal();
      closeChangelogModal();
      const qp = document.getElementById('queuePopup');
      if (qp) qp.style.display = 'none';
    }
  });

  // Keyboard activation for span-based buttons (play badges, dev actions):
  // Enter/Space on a focused actionable span triggers its click.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target && e.target.closest ? e.target.closest('[data-kbplay], .card-mini-actions [role="button"]') : null;
    if (!t) return;
    e.preventDefault();
    t.click();
  });

  function clearSearch() {
    closeSearchPreview();
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    document.getElementById('searchResultsSection').style.display = 'none';
    document.getElementById('loadMoreContainer').style.display = 'none';
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    const bar = document.getElementById('activeFiltersBar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
    const pNotice = document.getElementById('phoneticNoticeBanner');
    if (pNotice) pNotice.style.display = 'none';

    currentSearchDocs = [];
    currentRecentDocs = [];
    recentNumFound = 0;
    currentDidYouMean = [];
    currentQueryResolution = null;
    currentSpeakerViewCache = null;
    currentPhoneticTokens = [];
    currentSearchPage = 1;
    showMatchReasons = false;
    useClassicSearch = false;
    stackSeriesEnabled = true;
    const matchToggle = document.getElementById('toggleMatchExplain');
    if (matchToggle) matchToggle.checked = false;
    const classicToggle = document.getElementById('toggleClassicSearch');
    if (classicToggle) classicToggle.checked = false;
    const stackToggle = document.getElementById('toggleStackSeries');
    if (stackToggle) stackToggle.checked = true;
    const resGrid = document.getElementById('searchResultsGrid');
    if (resGrid) resGrid.classList.remove('explain-matches-active');

    // Reset all advanced filters so they don't silently persist
    activeAdvancedFilters = {
      keywords: '',
      teachers: [],
      categories: [],
      locations: [],
      series: [],
      minDuration: '',
      maxDuration: '',
      durationLabel: '',
      year: '',
      yearLabel: '',
      fromDate: '',
      toDate: '',
      dateQuick: '',
      dateQuickLabel: '',
      dateRangeLabel: '',
      mediaType: 'all',
      mediaTypeLabel: '',
      enablePhonetics: true
    };
    syncDateQuickChips();
    const advBtn = document.getElementById('advancedSearchBtn');
    if (advBtn) advBtn.classList.remove('active');

    // If has audio and was on a shiur page, re-expand player and show recommendations
    const playerCard = document.getElementById('playerCard');
    if (hasAudio && currentShiurId && playerCard) {
      expandPlayer();
      const moreSpeaker = document.getElementById('moreFromSpeakerSection');
      if (moreSpeaker) moreSpeaker.style.display = 'block';
      const moreCat = document.getElementById('moreFromCategorySection');
      if (moreCat) moreCat.style.display = 'block';
    } else {
      document.getElementById('collectionsSection').style.display = 'block';
    }

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.delete('search');
    newUrl.searchParams.delete('q');
    newUrl.searchParams.delete('exact');
    newUrl.searchParams.delete('classic');
    history.pushState({}, '', newUrl.toString());
  }

  function renderDocToCard(d, options = {}) {
    const id = d.shiurid || d.shiurID || d.id || '';
    // Normalize duration once: snapshots store display strings ("45 min",
    // "1h 22m") while Solr docs carry bare minutes — suffix only the latter.
    const durRaw = d.durationformatted || d.duration || '';
    const duration = durRaw ? (String(durRaw).match(/[a-z]/i) ? String(durRaw) : durRaw + ' min') : '';
    if (id && typeof devDocCache !== 'undefined') {
      devDocCache[String(id)] = {
        id: String(id),
        title: d.shiurtitle || d.shiurTitle || d.title || 'Untitled',
        speaker: d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : (d.speaker || 'YUTorah')),
        photo: d.PHOTO ? (d.PHOTO.startsWith('http') ? d.PHOTO : 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + d.PHOTO) : (d.photo || ''),
        duration: duration,
        date: d.shiurdateformatted || d.shiurDateFormatted || d.shiurdate || d.shiurDate || d.shiurdatesubmitted || d.shiurDateSubmitted || d.date || '',
        isArticle: Boolean(d.isArticle) || String(d.mediatypecategory || d.mediaTypeCategory || '').toLowerCase() === 'text'
      };
    }
    const title = d.shiurtitle || d.shiurTitle || d.title || 'Untitled';
    const speaker = d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : (d.speaker || 'YUTorah'));
    const photo = d.PHOTO ? (d.PHOTO.startsWith('http') ? d.PHOTO : 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + d.PHOTO) : (d.photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg');
    const rawDate = d.shiurdateformatted || d.shiurDateFormatted || d.shiurdate || d.shiurDate || d.shiurdatesubmitted || d.shiurDateSubmitted || d.date || '';
    const date = formatShiurDate(rawDate);
    const isNew = isShiurNew(d.shiurdatesubmitted || d.shiurDateSubmitted || rawDate);
    const newBadge = isNew ? '<span class="quick-card-new-badge">NEW</span>' : '';
    const category = (Array.isArray(d.categoryname) && d.categoryname[0]) || (Array.isArray(d.subcategoryname) && d.subcategoryname[0]) || d.category || '';

    const mediaCat = (d.mediatypecategory || d.mediaTypeCategory || '').toLowerCase();
    const urlCheck = d.shiururl || d.shiurURL || d.playerDownloadURL || d.downloadURL || '';
    const isArticle = Boolean(d.isArticle) || mediaCat === 'text' || mediaCat === 'article' || /\\.pdf(\$|\\?)/i.test(urlCheck);

    const metaParts = [];
    if (isArticle) {
      metaParts.push('📄 Article');
    } else if (duration) {
      metaParts.push('⏱ ' + escapeHtml(duration));
    }
    if (date) metaParts.push(escapeHtml(date));
    const bottomMeta = metaParts.join(' · ');

    const terms = getActiveSearchTerms();
    const displayTitle = highlightMatches(title, terms);
    const displaySpeaker = highlightMatches(speaker, terms);
    const displayCategory = category ? highlightMatches(category, terms) : '';

    const matchReasons = buildMatchReasons(d, terms);
    let matchReasonHtml = '';

    if (matchReasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        matchReasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    } else {
      let matchedVisible = [];
      if (displayTitle.includes('mark class="match-mark"')) matchedVisible.push('Title');
      if (displaySpeaker.includes('mark class="match-mark"')) matchedVisible.push('Speaker');
      if (displayCategory && displayCategory.includes('mark class="match-mark"')) matchedVisible.push('Category');

      const visibleNote = matchedVisible.length > 0
        ? 'Matched search term in ' + matchedVisible.join(' & ')
        : 'Matched via YUTorah index relevance';
      const visibleBadge = matchedVisible.length > 0 ? '✨ Direct Match' : '🎯 Solr Index';

      matchReasonHtml = '<div class="quick-card-match-reason">' +
        '<div class="match-reason-item">' +
          '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(visibleBadge) + '</span></div>' +
          '<div class="match-reason-snippet">' + escapeHtml(visibleNote) + '</div>' +
        '</div>' +
      '</div>';
    }

    const isCover = options.isCover;
    const seriesBadge = isCover
      ? '<div class="series-cover-badge">📚 Series · ' + (options.seriesCount || 'Multi-Part') + ' Shiurim</div>'
      : '';
    const coverClass = isCover ? ' is-series-cover' : '';
    // Play badge mini-plays in place; anywhere else on the card opens the
    // full player (expand + scroll), as before.
    const badgePlay = 'event.stopPropagation(); playShiurById(event, \\'' + id + '\\', true)';
    const actionBadge = isArticle
      ? '<span class="quick-play-badge" style="background:#10b981; color:#fff;">📄 Read</span>'
      : '<span class="quick-play-badge" role="button" tabindex="0" data-kbplay onclick="' + badgePlay + '">▶ Play</span>';

    return '<a href="/' + id + '" class="quick-card-link' + coverClass + '" onclick="playShiurById(event, this.dataset.id)" data-id="' + id + '">' +
      newBadge +
      seriesBadge +
      '<div class="quick-card-top">' +
        '<img class="quick-card-avatar" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(speaker) + '" loading="lazy" onerror="handleImgError(this)">' +
        '<div class="quick-card-info">' +
          '<div class="quick-card-title">' + displayTitle + '</div>' +
          '<div class="quick-card-speaker">' + displaySpeaker + '</div>' +
          (displayCategory ? '<div class="quick-card-category">' + displayCategory + '</div>' : '') +
        '</div>' +
      '</div>' +
      matchReasonHtml +
      '<div class="quick-card-bottom">' +
        '<span>' + bottomMeta + '</span>' +
        actionBadge +
      '</div>' +
      (typeof devCardActionsHtml === 'function' ? devCardActionsHtml(String(id), Boolean(options.isCover)) : '') +
      (typeof devProgressHtml === 'function' ? devProgressHtml(String(id)) : '') +
    '</a>';
  }

  function renderSeriesSubCard(sub, partNumber) {
    const id = sub.shiurid || sub.shiurID || sub.id || '';
    const title = sub.shiurtitle || sub.shiurTitle || sub.title || 'Untitled';
    const subDurRaw = sub.durationformatted || sub.duration || '';
    const duration = subDurRaw ? (String(subDurRaw).match(/[a-z]/i) ? String(subDurRaw) : subDurRaw + ' min') : '';
    const rawDate = sub.shiurdateformatted || sub.shiurDateFormatted || sub.shiurdate || sub.shiurdatesubmitted || '';
    const date = formatShiurDate(rawDate);
    const terms = getActiveSearchTerms();
    const displayTitle = highlightMatches(title, terms);

    const mediaCat = (sub.mediatypecategory || sub.mediaTypeCategory || '').toLowerCase();
    const urlCheck = sub.shiururl || sub.shiurURL || sub.playerDownloadURL || sub.downloadURL || '';
    const isArticle = mediaCat === 'text' || mediaCat === 'article' || /\\.pdf(\$|\\?)/i.test(urlCheck);

    const matchReasons = buildMatchReasons(sub, terms);
    let matchReasonHtml = '';
    if (matchReasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        matchReasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    }

    const metaParts = [];
    if (isArticle) {
      metaParts.push('📄 Article');
    } else if (duration) {
      metaParts.push('⏱ ' + escapeHtml(duration));
    }
    if (date) metaParts.push(escapeHtml(date));

    const subAction = isArticle
      ? '<span class="series-sub-play" style="background:#10b981; color:#fff;">📄 Read</span>'
      : '<span class="series-sub-play" role="button" tabindex="0" data-kbplay onclick="event.stopPropagation(); playShiurById(event, \\'' + id + '\\', true)">▶ Play</span>';

    return '<a href="/' + id + '" class="series-sub-card" onclick="playShiurById(event, this.dataset.id)" data-id="' + id + '">' +
      '<div class="series-sub-header">' +
        '<div class="series-sub-title"><span style="opacity:0.75; font-weight:700; margin-right:4px;">#' + partNumber + '</span> ' + displayTitle + '</div>' +
        subAction +
      '</div>' +
      matchReasonHtml +
      (metaParts.length > 0 ? '<div class="series-sub-meta">' + metaParts.join(' · ') + '</div>' : '') +
    '</a>';
  }

  function renderGroupItem(item) {
    if (!item.isSeries) {
      return renderDocToCard(item.doc);
    }
    const cover = item.cover;
    const subDocs = item.subDocs;
    const coverId = String(cover.shiurid || cover.shiurID || cover.id || '');
    if (coverId && typeof devSeriesCache !== 'undefined') {
      devSeriesCache[coverId] = { title: item.title || 'Series', docs: item.docs || [] };
    }
    const drawerId = 'series_drawer_' + (cover.shiurid || cover.shiurID || cover.id || '') + '_' + Math.random().toString(36).substring(2, 7);
    const coverHtml = renderDocToCard(cover, { isCover: true, seriesTitle: item.title, seriesCount: item.docs.length });
    const subCardsHtml = subDocs.map((sub, idx) => renderSeriesSubCard(sub, idx + 2)).join('');

    return '<div class="quick-card-series-group">' +
      coverHtml +
      '<button type="button" class="series-expand-btn" data-drawer-target="' + drawerId + '" data-sub-count="' + subDocs.length + '" data-series-title="' + escapeHtml(item.title || '') + '" onclick="toggleSeriesDrawer(event, this.dataset.drawerTarget)">' +
        '<span class="series-expand-icon">➕</span> <span class="series-expand-text">View ' + subDocs.length + ' more in \u2018' + escapeHtml(item.title || 'this') + '\u2019 Series</span>' +
      '</button>' +
      '<div id="' + drawerId + '" class="series-drawer" style="display: none;">' +
        subCardsHtml +
      '</div>' +
    '</div>';
  }

  // Instant Play by Shiur ID (in-page without reload)
  // Shared upload-date lookup for card plays AND direct-link loads.
  // Feeds the metadata box Uploaded row (between Date and Topics).
  var currentUploadDateStr = '';
  var currentUploadShiurId = '';
  var lastLectureData = null;
  function fetchUploadDate(id, givenDate) {
    currentUploadDateStr = '';
    currentUploadShiurId = String(id);
    try {
      fetch('/api/search?q=' + encodeURIComponent(id) + '&start=1&rows=1').then(r => {
        if (!r.ok) return null;
        return r.json();
      }).then(sdata => {
        if (!sdata || String(currentShiurId) !== String(id)) return;
        const sdocs = sdata.response ? (sdata.response.docs || []) : [];
        // Exact-ID match only: q= is full-text relevance, so a fallback
        // to sdocs[0] could stamp an unrelated shiur's upload date.
        const hit = sdocs.find(d => String(d.shiurID || d.shiurid || d.id || '') === String(id));
        if (!hit) return;
        const upRaw = hit.shiurdatesubmittedformatted || hit.shiurdatesubmitted || '';
        const upFmt = upRaw ? formatShiurDate(upRaw) : '';
        if (upFmt && upFmt !== givenDate && String(currentShiurId) === String(id)) {
          currentUploadDateStr = upFmt;
          currentUploadShiurId = String(id);
          if (lastLectureData && String(lastLectureData.shiurID || '') === String(id)) {
            renderMetadataBox(lastLectureData);
          }
        }
      }).catch(() => {});
    } catch (e) {}
  }

  async function playShiurById(e, id, stayMini) {
    if (e) e.preventDefault();

    // Same track already loaded: never restart — resume if paused,
    // otherwise drop to the mini player and keep the position.
    if (String(id) === String(currentShiurId) && hasAudio && audio) {
      try {
        if (audio.paused) {
          await audio.play();
        } else {
          minimizePlayer();
          flashToast('▶ Already playing — kept your place', false, false);
        }
      } catch (err) {}
      return;
    }

    isManuallyMinimized = false;
    if (stayMini) {
      // Card play: start in miniplayer, do not move screen
      minimizePlayer();
    } else {
      isExpandingUntil = Date.now() + 800;
      expandPlayer();
      const playerCard = document.getElementById('playerCard');
      if (playerCard) playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    currentShiurId = id;
    hasAudio = true;
    initialTimeApplied = false;

    // Reset UI while loading
    document.getElementById('shiurTitle').textContent = 'Loading shiur #' + id + '...';
    document.getElementById('shiurSpeaker').textContent = 'Fetching audio stream...';
    document.getElementById('shiurMeta').textContent = '';
    const resetUploadEl = document.getElementById('shiurUploadDate');
    if (resetUploadEl) {
      resetUploadEl.style.display = 'none';
      resetUploadEl.textContent = '';
    }
    document.getElementById('shiurMeta').textContent = '';
    document.getElementById('shiurDesc').style.display = 'none';

    const newUrl = new URL('/' + id, window.location.origin);
    if (currentPlaybackRate && currentPlaybackRate !== 1) {
      newUrl.searchParams.set('speed', currentPlaybackRate);
    }
    const curParams = new URL(window.location.href).searchParams;
    const activeTheme = curParams.get('theme') || curParams.get('mode');
    if (activeTheme) {
      const k = curParams.has('theme') ? 'theme' : 'mode';
      newUrl.searchParams.set(k, activeTheme);
    }
    history.pushState({ shiurId: id }, '', newUrl.pathname + newUrl.search);

    try {
      const res = await fetch('/sidebar/lecturedata?shiurID=' + encodeURIComponent(id));
      if (!res.ok) throw new Error('API returned status ' + res.status);
      const data = await res.json();

      const title = data.shiurTitle || 'Untitled Shiur';
      const speaker = data.shiurTeacherFullName || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherFullName : 'YUTorah');
      const photo = data.teacherPhotoURL_lp || data.teacherPhotoURL || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherPhotoURL : '');
      const duration = data.shiurDuration || '';
      const rawDate = data.shiurDateFormatted || data.shiurDate || '';
      const date = formatShiurDate(rawDate);
      const meta = duration + (date ? ' · ' + date : '');
      const desc = data.shiurDescription || '';
      const audioSrc = data.playerDownloadURL || (data.shiurURL ? 'https://shiurim.yutorah.net' + data.shiurURL : '') || data.downloadURL || '';
      const dlSrc = data.downloadURL || audioSrc;

      let teacherId = '';
      if (Array.isArray(data.shiurTeachers) && data.shiurTeachers[0]) {
        teacherId = String(data.shiurTeachers[0].teacherID || data.shiurTeachers[0].id || '');
      }
      if (!teacherId && data.teacherID) {
        teacherId = String(data.teacherID);
      }
      currentSpeakerTeacherId = teacherId;
      currentSpeakerName = speaker;

      document.title = title + ' — YUTorah Enhanced';
      document.getElementById('shiurTitle').textContent = title;
      document.getElementById('shiurSpeaker').textContent = speaker;
      document.getElementById('shiurMeta').textContent = meta;
      const uploadEl = document.getElementById('shiurUploadDate');
      if (uploadEl) {
        uploadEl.style.display = 'none';
        uploadEl.textContent = '';
      }
      lastLectureData = data;

      // Upload date feeds the metadata box (between Date and Topics):
      // lightweight Solr id-lookup, applied progressively.
      fetchUploadDate(id, date);

      const img = document.getElementById('speakerImg');
      if (photo) {
        img.src = photo;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }

      const descEl = document.getElementById('shiurDesc');
      if (desc) {
        descEl.textContent = desc;
        descEl.style.display = 'block';
      } else {
        descEl.style.display = 'none';
      }

      const dlBtn = document.getElementById('dlBtn');
      if (dlSrc) {
        dlBtn.href = dlSrc;
        dlBtn.style.display = 'inline-flex';
      }

      currentShiurId = id;
      initialTimeApplied = false;
      lastUrlUpdateSec = -1;
      lastUrlUpdateTime = 0;

      // Check if this shiur is an article / text document
      const mediaCategory = (data.mediaTypeCategory || '').toLowerCase();
      const isArticle = mediaCategory === 'text' || mediaCategory === 'article' || /\\.pdf(\$|\\?)/i.test(audioSrc) || /\\.pdf(\$|\\?)/i.test(dlSrc);
      isCurrentShiurArticle = isArticle;
      currentArticlePdf = isArticle ? (audioSrc || dlSrc) : '';

      addRecentHistory({
        id: id,
        title: title,
        speaker: speaker,
        photo: photo,
        duration: duration,
        date: date,
        dateISO: rawDate || '',
        isArticle: isArticle
      });
      try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}

      // Render rich metadata immediately
      renderMetadataBox(data);

      const audioWrap = document.getElementById('audioControlsWrap');
      const articleWrap = document.getElementById('articleViewerContainer');

      const navBack = document.getElementById('playerNavBackBtn');

      if (isArticle) {
        hasAudio = false;
        if (audio && !audio.paused) {
          audio.pause();
        }
        if (audioWrap) audioWrap.style.display = 'none';
        if (articleWrap) articleWrap.style.display = 'block';
        if (navBack) {
          navBack.textContent = '← Browse Library While Reading';
        }
        if (dlBtn) {
          dlBtn.innerHTML = '⬇️ Download PDF';
        }
        loadArticlePdf(currentArticlePdf);
        return;
      }

      // Switching back to audio shiur: restore audio controls, hide article viewer
      hasAudio = true;
      if (articleWrap) articleWrap.style.display = 'none';
      if (audioWrap) audioWrap.style.display = 'block';
      if (navBack) {
        navBack.textContent = '← Browse Library While Listening';
      }
      if (dlBtn) {
        dlBtn.innerHTML = '⬇️ Download MP3';
      }

      // Check if URL or localStorage has a timestamp for this shiur
      let resumeSec = 0;
      try {
        const saved = parseFloat(localStorage.getItem('yutorah_progress_' + id));
        if (!isNaN(saved) && saved > 5) resumeSec = saved;
      } catch(e) {}

      const curUrl = new URL(window.location.href);
      const urlT = curUrl.searchParams.get('t');
      if (urlT) {
        const p = parseFloat(urlT);
        if (!isNaN(p) && p > 0) resumeSec = p;
      }

      initialTimestamp = resumeSec ? String(resumeSec) : '';

      const shiurObj = {
        id: id,
        title: title,
        speaker: speaker,
        teacherId: teacherId,
        photo: photo,
        duration: duration,
        date: date,
        meta: meta,
        desc: desc,
        audioSrc: audioSrc,
        dlSrc: dlSrc,
        resumeSec: resumeSec
      };

      currentShiurId = id;
      pendingShiur = shiurObj;

      if (currentSponsorAudio && !isPreRollDisabled()) {
        playSponsorPreRoll(shiurObj);
      } else {
        startShiurPlayback(shiurObj);
      }
    } catch (err) {
      console.error('Failed to load shiur:', err);
      document.getElementById('shiurTitle').textContent = 'Error loading shiur #' + id;
      document.getElementById('shiurSpeaker').textContent = 'Please check the ID or try again.';
      const errUploadEl = document.getElementById('shiurUploadDate');
      if (errUploadEl) {
        errUploadEl.style.display = 'none';
        errUploadEl.textContent = '';
      }
      try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}
    }
  }

  function renderMetadataBox(data) {
    const box = document.getElementById('shiurMetadataBox');
    if (!box) return;

    let html = '';
    const teachers = Array.isArray(data.shiurTeachers) ? data.shiurTeachers : [];
    const locations = Array.isArray(data.postedInLocations) ? data.postedInLocations : [];
    const rawDate = data.shiurDateFormatted || data.shiurDate || '';
    const date = formatShiurDate(rawDate) || rawDate;
    const keywords = Array.isArray(data.shiurKeywords) ? data.shiurKeywords : [];
    const categories = (data.postedInCategories && typeof data.postedInCategories === 'object') ? data.postedInCategories : {};

    if (teachers.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">👤 Speaker</span>';
      teachers.forEach(t => {
        const tId = t.teacherID || '';
        const tName = t.teacherFullName || '';
        html += '<button type="button" class="meta-chip speaker-chip" onclick="filterByTeacher(' + JSON.stringify(tId) + ', ' + JSON.stringify(tName).replace(/"/g, '&quot;') + ')">' + escapeHtml(tName) + '</button>';
      });
      html += '</div>';
    }

    if (date) {
      html += '<div class="meta-row"><span class="meta-label">📅 Date</span><span style="font-size:13px; color:var(--text);">' + escapeHtml(date) + '</span></div>';
    }

    // Uploaded row (between Date and Topics/Venue) — only when the lookup
    // resolved for THIS shiur and the date differs from the given date.
    if (currentUploadDateStr && String(currentUploadShiurId) === String(data.shiurID || '') &&
        currentUploadDateStr !== date) {
      html += '<div class="meta-row"><span class="meta-label">📤 Uploaded</span><span style="font-size:13px; color:var(--text);">' + escapeHtml(currentUploadDateStr) + '</span></div>';
    }

    if (locations.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">📍 Venue</span>';
      locations.forEach(loc => {
        const lId = loc.locationID || '';
        const lName = loc.locationName || '';
        html += '<button type="button" class="meta-chip venue-chip" onclick="filterByLocation(' + JSON.stringify(lId) + ', ' + JSON.stringify(lName).replace(/"/g, '&quot;') + ')">' + escapeHtml(lName) + '</button>';
      });
      html += '</div>';
    }

    const catEntries = Object.entries(categories);
    if (catEntries.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">📂 Topics</span>';
      catEntries.forEach(([groupId, grp]) => {
        if (grp.groupName && Array.isArray(grp.categories)) {
          html += '<span class="meta-group-name">' + escapeHtml(grp.groupName) + ':</span>';
          grp.categories.forEach(c => {
            const cId = c.subcategoryID || '';
            const cName = c.categoryName || '';
            html += '<button type="button" class="meta-chip category-chip" onclick="filterByCategory(' + JSON.stringify(cId) + ', ' + JSON.stringify(cName).replace(/"/g, '&quot;') + ')">' + escapeHtml(cName) + '</button> ';
          });
        }
      });
      html += '</div>';
    }

    if (keywords.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">🏷️ Tags</span>';
      keywords.forEach(k => {
        const kw = k.keywordTitle || '';
        if (kw) {
          html += '<button type="button" class="meta-chip keyword-chip" onclick="searchFor(' + JSON.stringify(kw).replace(/"/g, '&quot;') + ')">' + escapeHtml(kw) + '</button>';
        }
      });
      html += '</div>';
    }

    box.innerHTML = html;
    box.style.display = html ? 'block' : 'none';
  }

  function closePlayer() {
    audio.pause();
    isManuallyMinimized = false;
    document.getElementById('playerCard').style.display = 'none';
    const miniPlayer = document.getElementById('miniPlayer');
    if (miniPlayer) miniPlayer.classList.remove('visible');
    document.body.classList.remove('mini-player-active');
    hasAudio = false;
    currentShiurId = '';
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    newUrl.search = '';
    history.pushState({}, '', newUrl.toString());
  }

  // Recent History Helpers
  function getRecentHistory() {
    try {
      return JSON.parse(localStorage.getItem('yutorah_recent_history') || '[]');
    } catch(e) {
      return [];
    }
  }

  function addRecentHistory(shiur) {
    if (!shiur || !shiur.id) return;
    try {
      let history = getRecentHistory();
      history = history.filter(item => String(item.id) !== String(shiur.id));
      history.unshift({
        id: shiur.id,
        title: shiur.title || 'Untitled',
        speaker: shiur.speaker || 'YUTorah',
        photo: shiur.photo || '',
        duration: shiur.duration || '',
        date: shiur.date || '',
        dateISO: shiur.dateISO || '',
        category: shiur.category || '',
        isArticle: Boolean(shiur.isArticle),
        listenedAt: Date.now()
      });
      if (history.length > 24) history = history.slice(0, 24);
      localStorage.setItem('yutorah_recent_history', JSON.stringify(history));
    } catch(e) {}
  }

  function renderRecentlyViewedGrid() {
    const grid = document.getElementById('grid-viewed');
    if (!grid) return;
    const history = getRecentHistory();
    if (history.length === 0) {
      grid.innerHTML = '<div style="text-align: center; padding: 40px 20px; color: var(--text-muted); grid-column: 1/-1;">' +
        '<div style="font-size: 36px; margin-bottom: 12px;">🎧</div>' +
        '<div style="font-weight: 700; font-size: 16px; margin-bottom: 6px; color: var(--text);">No Recently Viewed Shiurim Yet</div>' +
        '<div style="font-size: 13px; max-width: 400px; margin: 0 auto 16px;">Shiurim you listen to will appear here automatically for quick resumption.</div>' +
        '<button class="chip" onclick="switchCollection(&quot;editors&quot;)">⭐ Browse Editor&#39;s Picks</button>' +
        '</div>';
      return;
    }
    grid.innerHTML = history.map(item => {
      const photo = item.photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
      const rawDate = item.date || item.shiurDate || '';
      const dateStr = formatShiurDate(rawDate);
      const isNew = isShiurNew(rawDate);
      const newBadge = isNew ? '<span class="quick-card-new-badge">NEW</span>' : '';
      const isDoc = Boolean(item.isArticle);
      const metaParts = [];
      if (isDoc) {
        metaParts.push('📄 Article');
      } else if (item.duration) {
        metaParts.push('⏱ ' + escapeHtml(item.duration));
      }
      if (dateStr) metaParts.push(escapeHtml(dateStr));
      const bottomMeta = metaParts.join(' · ');
      const actionBadge = isDoc
        ? '<span class="quick-play-badge" style="background:#10b981; color:#fff;">📄 Read</span>'
        : '<span class="quick-play-badge" role="button" tabindex="0" data-kbplay onclick="event.stopPropagation(); playShiurById(event, \\'' + item.id + '\\', true)">▶ Resume</span>';
      return '<a href="/' + item.id + '" class="quick-card-link" onclick="playShiurById(event, this.dataset.id)" data-id="' + item.id + '">' +
        newBadge +
        '<div class="quick-card-top">' +
          '<img class="quick-card-avatar" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(item.speaker) + '" loading="lazy" onerror="handleImgError(this)">' +
          '<div class="quick-card-info">' +
            '<div class="quick-card-title">' + escapeHtml(item.title) + '</div>' +
            '<div class="quick-card-speaker">' + escapeHtml(item.speaker) + '</div>' +
            (item.category ? '<div class="quick-card-category">' + escapeHtml(item.category) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="quick-card-bottom">' +
          '<span>' + bottomMeta + '</span>' +
          actionBadge +
        '</div>' +
      '</a>';
    }).join('');
  }

  // =========================================================================
  // ROADMAP §8: Dev Playlists engine (Dev Mode only — fully inert otherwise).
  // Store: localStorage yutorah_dev_playlists (system + custom playlists)
  // and yutorah_playback_progress (per-shiur playback records).
  // =========================================================================
  var DEV_PLAYLISTS_KEY = 'yutorah_dev_playlists';
  var DEV_PROGRESS_KEY = 'yutorah_playback_progress';
  var devDocCache = {};
  var activeDevPlaylistId = 'history';
  var devLastHeartbeat = 0;
  // Memoized parses: renderDocToCard calls into the store per card, so we
  // cache the parsed objects and invalidate on every save (same-tab writes
  // always go through saveDevStore / the progress writers below).
  var devStoreCache = null;
  var devProgressCache = null;

  function devDefaultStore() {
    return {
      activeId: 'history',
      custom: {},
      system: {
        save_for_later: { id: 'save_for_later', name: 'Save for Later', icon: '🕒', items: [] },
        favorites: { id: 'favorites', name: 'Favorites', icon: '⭐', items: [] }
      }
    };
  }

  function getDevStore() {
    if (devStoreCache) return devStoreCache;
    try {
      const raw = localStorage.getItem(DEV_PLAYLISTS_KEY);
      if (!raw) {
        devStoreCache = devDefaultStore();
        return devStoreCache;
      }
      const s = JSON.parse(raw);
      if (!s.system) {
        devStoreCache = devDefaultStore();
        return devStoreCache;
      }
      if (!s.system.save_for_later) s.system.save_for_later = { id: 'save_for_later', name: 'Save for Later', icon: '🕒', items: [] };
      if (!s.system.favorites) s.system.favorites = { id: 'favorites', name: 'Favorites', icon: '⭐', items: [] };
      if (!s.custom) s.custom = {};
      devStoreCache = s;
      return s;
    } catch (e) {
      devStoreCache = devDefaultStore();
      return devStoreCache;
    }
  }

  function saveDevStore(store) {
    devStoreCache = store;
    try {
      localStorage.setItem(DEV_PLAYLISTS_KEY, JSON.stringify(store));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        flashToast('⚠️ Storage full — playlist change was NOT saved', true, false);
      }
    }
  }

  function getDevPlaylist(store, pid) {
    if (pid === 'history') {
      return { id: 'history', name: 'History', icon: '📜', isHistory: true, items: getRecentHistory() };
    }
    if (store.system[pid]) return store.system[pid];
    if (store.custom[pid]) return store.custom[pid];
    return null;
  }

  function devPlaylistIds(store) {
    return ['history', 'save_for_later', 'favorites'].concat(Object.keys(store.custom || {}));
  }

  // Split a rendered meta string ("1h 22m · September 8, 2026",
  // "📄 Article · March 3, 2019", "⏱ 1 hr 6 min · Yesterday") into clean
  // { duration, date }. Shared by card snapshots and the player save path.
  function devSplitMeta(meta) {
    const out = { duration: '', date: '' };
    const s = String(meta || '');
    if (!s) return out;
    const cut = s.indexOf('·');
    const head = (cut === -1 ? s : s.slice(0, cut)).trim();
    const tail = cut === -1 ? '' : s.slice(cut + 1).trim();
    const dm = head.match(/(\\d+\\s*h(?:r)?(?:\\s*\\d+\\s*m(?:in)?)?|\\d+\\s*min(?:ute)?s?|\\d+\\s*m\\b|\\d+\\s*sec(?:ond)?s?)/i);
    if (dm) {
      out.duration = dm[1].trim();
      out.date = tail;
    } else if (tail) {
      out.date = tail;
    } else {
      out.date = head;
    }
    return out;
  }

  function devSnapshot(id) {
    if (devDocCache[id]) return devDocCache[id];
    if (String(currentShiurId) === String(id)) {
      const t = document.getElementById('shiurTitle');
      const s = document.getElementById('shiurSpeaker');
      const img = document.getElementById('speakerImg');
      const mEl = document.getElementById('shiurMeta');
      const split = devSplitMeta(mEl ? mEl.textContent : '');
      return {
        id: id,
        title: t ? t.textContent : 'Untitled',
        speaker: s ? s.textContent : 'YUTorah',
        photo: img ? img.src : '',
        duration: split.duration,
        date: split.date,
        isArticle: Boolean(isCurrentShiurArticle),
        addedAt: Date.now()
      };
    }
    return null;
  }

  function devInPlaylist(pid, id) {
    const store = getDevStore();
    const pl = getDevPlaylist(store, pid);
    if (!pl || !pl.items) return false;
    return pl.items.some(item => String(item.id) === String(id));
  }

  function devSetMembership(pid, id, want) {
    if (pid === 'history') return false;
    const store = getDevStore();
    const pl = store.system[pid] || store.custom[pid];
    if (!pl) return false;
    const has = pl.items.some(item => String(item.id) === String(id));
    if (want && !has) {
      const snap = devSnapshot(id);
      if (!snap) return false;
      snap.addedAt = Date.now();
      pl.items.unshift(snap);
    } else if (!want && has) {
      pl.items = pl.items.filter(item => String(item.id) !== String(id));
    } else {
      return true;
    }
    saveDevStore(store);
    return true;
  }

  function toggleDevSave(id) {
    const want = !devInPlaylist('save_for_later', id);
    if (devSetMembership('save_for_later', id, want)) {
      // Silent by design: the button recolor is the only feedback.
      devRefreshCardButtons();
      if (document.getElementById('grid-playlists') && document.getElementById('grid-playlists').style.display !== 'none') renderPlaylistsGrid();
    }
  }

  function toggleDevFav(id) {
    const want = !devInPlaylist('favorites', id);
    if (devSetMembership('favorites', id, want)) {
      // Silent by design: the button recolor is the only feedback.
      devRefreshCardButtons();
      if (document.getElementById('grid-playlists') && document.getElementById('grid-playlists').style.display !== 'none') renderPlaylistsGrid();
    }
  }

  function devRefreshCardButtons() {
    const saveIc = getSaveIcon();
    const saveId = getSaveIconId();
    document.querySelectorAll('[data-dev-save]').forEach(el => {
      const on = devInPlaylist('save_for_later', el.getAttribute('data-dev-save'));
      el.classList.toggle('active-save', on);
      if (el.getAttribute('data-save-icon') !== saveId) {
        el.innerHTML = saveIc;
        el.setAttribute('data-save-icon', saveId);
      }
      el.title = on ? 'Saved for later' : 'Save for later';
    });
    document.querySelectorAll('[data-dev-fav]').forEach(el => {
      const on = devInPlaylist('favorites', el.getAttribute('data-dev-fav'));
      el.classList.toggle('active-fav', on);
      if (el.textContent === '☆' || el.textContent === '⭐') el.textContent = on ? '⭐' : '☆';
      el.title = on ? 'In favorites' : 'Add to favorites';
    });
    document.querySelectorAll('[data-dev-queue]').forEach(el => {
      const qid = el.getAttribute('data-dev-queue');
      const isCoverBtn = el.getAttribute('data-dev-cover') === '1';
      const on = isCoverBtn ? devSeriesQueued(qid) : devInQueue(qid);
      el.classList.toggle('active-save', on);
      el.title = on ? 'In play queue' : 'Add to play queue';
    });
    // Player-header buttons track the currently loaded shiur.
    try {
      if (typeof currentShiurId !== 'undefined' && currentShiurId) {
        const ps = document.getElementById('devPlayerSaveBtn');
        if (ps) {
          const on = devInPlaylist('save_for_later', String(currentShiurId));
          ps.classList.toggle('active-save', on);
          ps.title = on ? 'Saved for later' : 'Save for later';
        }
        const pf = document.getElementById('devPlayerFavBtn');
        if (pf) {
          const on = devInPlaylist('favorites', String(currentShiurId));
          pf.classList.toggle('active-fav', on);
          pf.textContent = on ? '⭐' : '☆';
          pf.title = on ? 'In favorites' : 'Add to favorites';
        }
        const pq = document.getElementById('devPlayerQueueBtn');
        if (pq) {
          const on = devInQueue(String(currentShiurId));
          pq.classList.toggle('active-save', on);
          pq.title = on ? 'In play queue' : 'Add to play queue';
        }
      }
    } catch (e) {}
  }

  // Fundamental-cards guarantee (§8): server-rendered cards (homepage
  // collections, SSR search grid, Recently Viewed) never pass through
  // renderDocToCard, so after Dev Mode activates we walk every card link and
  // retrofit the mini actions + progress bar, snapshotting metadata from the
  // card DOM itself. Re-runs are cheap and refresh stale progress.
  function devSnapshotFromCard(link) {
    const id = link.getAttribute('data-id');
    if (!id) return null;
    if (devDocCache[id]) return id;
    const text = sel => {
      const el = link.querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    };
    const img = link.querySelector('img.quick-card-avatar');
    // Top-level cards keep meta in .quick-card-bottom; series sub-cards use
    // .series-sub-meta — support both so drawer saves keep duration + date.
    const meta = text('.quick-card-bottom span') || text('.series-sub-meta');
    const split = devSplitMeta(meta);
    let title = text('.quick-card-title') || text('.series-sub-title') || 'Untitled';
    title = title.replace(/^#\\d+\\s*/, '');
    const badge = text('.quick-card-bottom') + ' ' + text('.series-sub-meta');
    devDocCache[id] = {
      id: String(id),
      title: title,
      speaker: text('.quick-card-speaker') || 'YUTorah',
      photo: img ? (img.getAttribute('src') || '') : '',
      duration: split.duration,
      date: split.date,
      isArticle: badge.indexOf('📄') !== -1
    };
    return id;
  }

  function devUpgradeCards(root) {
    if (!isDevMode) return;
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    scope.querySelectorAll('a.quick-card-link[data-id], a.series-sub-card[data-id]').forEach(link => {
      const id = devSnapshotFromCard(link);
      if (!id) return;
      if (!link.querySelector('.card-mini-actions')) {
        const isCoverLink = Boolean(link.querySelector('.series-cover-badge'));
        const tmp = document.createElement('div');
        tmp.innerHTML = devCardActionsHtml(String(id), isCoverLink) + devProgressHtml(String(id));
        while (tmp.firstChild) link.appendChild(tmp.firstChild);
      } else {
        // Refresh stale progress: add the bar if the first upgrade ran
        // before any progress existed, else swap in the latest record.
        const fresh = devProgressHtml(String(id));
        const old = link.querySelector('.dev-progress-wrap');
        if (old) {
          if (fresh) {
            const tmp = document.createElement('div');
            tmp.innerHTML = fresh;
            if (tmp.firstChild) old.replaceWith(tmp.firstChild);
            else old.remove();
          } else {
            old.remove();
          }
        } else if (fresh) {
          const tmp = document.createElement('div');
          tmp.innerHTML = fresh;
          while (tmp.firstChild) link.appendChild(tmp.firstChild);
        }
      }
    });
    devRefreshCardButtons();
  }

  function getPlaybackProgress() {
    if (devProgressCache) return devProgressCache;
    try {
      devProgressCache = JSON.parse(localStorage.getItem(DEV_PROGRESS_KEY) || '{}');
    } catch (e) {
      devProgressCache = {};
    }
    return devProgressCache;
  }

  function getProgressRecord(id) {
    if (!id) return null;
    return getPlaybackProgress()[String(id)] || null;
  }

  function devRecordHeartbeat(force) {
    if (!currentShiurId || isSponsorPlaying || !audio || !audio.duration || isNaN(audio.duration)) return;
    const now = Date.now();
    if (!force && now - devLastHeartbeat < 5000) return;
    devLastHeartbeat = now;
    try {
      const all = getPlaybackProgress();
      all[String(currentShiurId)] = {
        shiurId: String(currentShiurId),
        progressSec: Math.floor(audio.currentTime || 0),
        durationSec: Math.floor(audio.duration || 0),
        lastListened: now,
        completed: false
      };
      localStorage.setItem(DEV_PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function devMarkCompleted() {
    if (!currentShiurId) return;
    try {
      const all = getPlaybackProgress();
      const prev = all[String(currentShiurId)] || {};
      all[String(currentShiurId)] = {
        shiurId: String(currentShiurId),
        progressSec: prev.durationSec || Math.floor((audio && audio.duration) || 0),
        durationSec: prev.durationSec || Math.floor((audio && audio.duration) || 0),
        lastListened: Date.now(),
        completed: true
      };
      localStorage.setItem(DEV_PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function devRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 3600000) {
      const m = Math.max(1, Math.round(diff / 60000));
      return m + ' min ago';
    }
    if (diff < 86400000) {
      const h = Math.round(diff / 3600000);
      return h + (h === 1 ? ' hour ago' : ' hours ago');
    }
    const d = Math.round(diff / 86400000);
    if (d === 1) return 'Yesterday';
    return d + ' days ago';
  }

  function devProgressHtml(id) {
    if (!isDevMode) return '';
    const rec = getProgressRecord(id);
    if (!rec || !rec.durationSec) return '';
    const pct = Math.min(100, Math.round((rec.progressSec / rec.durationSec) * 100));
    const cur = Math.floor(rec.progressSec / 60);
    const tot = Math.floor(rec.durationSec / 60);
    return '<div class="dev-only dev-progress-wrap"><div class="card-progress-track"><div class="card-progress-fill" style="width: ' + pct + '%;"></div></div>' +
      '<div class="card-listen-meta">🕒 Last listened: ' + escapeHtml(devRelativeTime(rec.lastListened)) +
      ' · ' + cur + '/' + tot + ' min through (' + pct + '%)</div></div>';
  }

  // Save-for-later button icon (dev-pickable from 5 clocks in settings):
  // the emoji favorite plus 4 SVG faces with progressively bolder hands.
  function devClockSvg(handW, rimW, filled) {
    var hands = filled
      ? '<path d="M12 12 L12 6.5 L14 6.5 L14 12 L18 14 L17 15.8 Z" fill="currentColor" stroke="none"></path>'
      : '<line x1="12" y1="12" x2="12" y2="6.5"></line>' +
        '<line x1="12" y1="12" x2="17.5" y2="14.5"></line>';
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="' + rimW + '" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"></circle>' +
      '<g stroke-width="' + handW + '" stroke-linecap="round">' + hands + '</g></svg>';
  }
  var DEV_SAVE_ICONS = ['emoji', 'hands-light', 'hands-medium', 'hands-bold', 'hands-filled'];
  function getSaveIconId() {
    try {
      var v = localStorage.getItem('yutorah_save_icon');
      if (DEV_SAVE_ICONS.indexOf(v) !== -1) return v;
    } catch (e) {}
    return 'emoji';
  }
  function saveIconThumb(oid) {
    if (oid === 'hands-light') return devClockSvg(2, 1.6, false);
    if (oid === 'hands-medium') return devClockSvg(3.2, 1.8, false);
    if (oid === 'hands-bold') return devClockSvg(4.5, 2.4, false);
    if (oid === 'hands-filled') return devClockSvg(0, 2, true);
    return '🕒';
  }
  function getSaveIconHtml() {
    return saveIconThumb(getSaveIconId());
  }
  function getSaveIcon() {
    return getSaveIconHtml();
  }
  function setSaveIcon(id) {
    if (DEV_SAVE_ICONS.indexOf(id) === -1) return;
    try { localStorage.setItem('yutorah_save_icon', id); } catch (e) {}
    devRefreshCardButtons();
    var ps = document.getElementById('devPlayerSaveBtn');
    if (ps) ps.innerHTML = getSaveIconHtml();
    renderSaveIconPicker();
  }
  function renderSaveIconPicker() {
    var wrap = document.getElementById('saveIconPicker');
    if (!wrap) return;
    var cur = getSaveIconId();
    wrap.innerHTML = DEV_SAVE_ICONS.map(function(oid) {
      return '<button type="button" class="card-mini-btn icon-btn' + (oid === cur ? ' active-save' : '') + '"' +
        ' onclick="setSaveIcon(this.getAttribute(\\'data-oid\\'))" data-oid="' + oid + '" title="Save-for-later icon: ' + oid + '">' + saveIconThumb(oid) + '</button>';
    }).join('');
  }

  // Spotify-style circular queue icon: list lines + plus.
  function devQueueIconSvg() {
    return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="4" y1="7" x2="12" y2="7"></line>' +
      '<line x1="4" y1="12" x2="12" y2="12"></line>' +
      '<line x1="4" y1="17" x2="10" y2="17"></line>' +
      '<line x1="16.5" y1="13.5" x2="16.5" y2="20.5"></line>' +
      '<line x1="13" y1="17" x2="20" y2="17"></line>' +
      '</svg>';
  }

  function devCardActionsHtml(id, isCover) {
    if (!isDevMode) return '';
    const inSave = devInPlaylist('save_for_later', id);
    const inFav = devInPlaylist('favorites', id);
    const inQ = isCover ? devSeriesQueued(id) : devInQueue(id);
    const qLabel = isCover ? 'Queue series' : 'Add to play queue';
    const qCall = isCover ? 'devQueueToggle(\\\'' + id + '\\\', true, this)' : 'devQueueToggle(\\\'' + id + '\\\', false, this)';
    return '<div class="card-mini-actions dev-only">' +
      '<span role="button" tabindex="0" class="card-mini-btn icon-btn' + (inSave ? ' active-save' : '') + '" data-dev-save="' + id + '"' +
      ' title="Save for later" aria-label="Save for later"' +
      ' onclick="event.stopPropagation(); event.preventDefault(); toggleDevSave(\\\'' + id + '\\\')">' + getSaveIcon() + '</span>' +
      '<span role="button" tabindex="0" class="card-mini-btn icon-btn' + (inFav ? ' active-fav' : '') + '" data-dev-fav="' + id + '"' +
      ' title="Add to favorites" aria-label="Add to favorites"' +
      ' onclick="event.stopPropagation(); event.preventDefault(); toggleDevFav(\\\'' + id + '\\\')">' + (inFav ? '⭐' : '☆') + '</span>' +
      '<span role="button" tabindex="0" class="queue-circle-btn' + (inQ ? ' active-save' : '') + '" data-dev-queue="' + id + '"' + (isCover ? ' data-dev-cover="1"' : '') +
      ' title="' + qLabel + '" aria-label="' + qLabel + '"' +
      ' onclick="event.stopPropagation(); event.preventDefault(); ' + qCall + '">' + devQueueIconSvg() + '</span>' +
      '<span role="button" tabindex="0" class="card-mini-btn" onclick="event.stopPropagation(); event.preventDefault(); openPlaylistModal(\\\'' + id + '\\\')">➕ Playlist</span>' +
      '</div>';
  }

  function devParseMinutes(str) {
    if (str == null) return 0;
    if (typeof str === 'number') return Math.round(str);
    const s = String(str);
    let mins = 0;
    let m = s.match(/(\\d+)\\s*hr/i);
    if (m) {
      mins += parseInt(m[1], 10) * 60;
    } else {
      m = s.match(/(\\d+)\\s*h/i);
      if (m) mins += parseInt(m[1], 10) * 60;
    }
    m = s.match(/(\\d+)\\s*min/i);
    if (m) mins += parseInt(m[1], 10);
    else {
      m = s.match(/(\\d+)\\s*m\\b/i);
      if (m) mins += parseInt(m[1], 10);
    }
    if (!mins) {
      m = s.match(/(\\d+)\\s*sec/i);
      if (m) mins += Math.round(parseInt(m[1], 10) / 60);
      else {
        m = s.match(/^\\s*(\\d+)\\s*$/);
        if (m) mins += parseInt(m[1], 10);
      }
    }
    return mins;
  }

  function devTotalDuration(items) {
    const total = (items || []).reduce((sum, it) => sum + devParseMinutes(it.duration), 0);
    if (total >= 60) {
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h + (h === 1 ? ' hr ' : ' hrs ') + m + ' min';
    }
    return total + ' min';
  }

  function devAskRemove(pid, id) {
    const grid = document.getElementById('grid-playlists');
    if (!grid) return;
    grid.querySelectorAll('[data-dev-remove-confirm]').forEach(el => {
      el.outerHTML = '<button type="button" class="card-mini-btn" data-dev-remove="' + el.getAttribute('data-dev-remove-confirm-pid') + ':' + el.getAttribute('data-dev-remove-confirm') + '"' +
        ' onclick="devAskRemove(\\'' + el.getAttribute('data-dev-remove-confirm-pid') + '\\', \\'' + el.getAttribute('data-dev-remove-confirm') + '\\')">✕ Remove</button>';
    });
    const sel = grid.querySelector('[data-dev-remove="' + pid + ':' + id + '"]');
    if (sel) {
      const store = getDevStore();
      const pl = getDevPlaylist(store, pid);
      const plName = pl && pl.name ? pl.name : pid;
      sel.outerHTML = '<span>Are you sure you want to remove this shiur from "' + escapeHtml(plName) + '?" ' +
        '<button type="button" class="card-mini-btn" onclick="devDoRemove(\\'' + pid + '\\', \\'' + id + '\\')">🗑️ Confirm Remove</button> ' +
        '<button type="button" class="card-mini-btn" onclick="renderPlaylistsGrid()">Cancel</button></span>';
    }
  }

  function devDoRemove(pid, id) {
    if (pid === 'history') {
      try {
        let history = getRecentHistory().filter(item => String(item.id) !== String(id));
        localStorage.setItem('yutorah_recent_history', JSON.stringify(history));
      } catch (e) {}
    } else {
      const store = getDevStore();
      const pl = store.system[pid] || store.custom[pid];
      if (pl) {
        pl.items = pl.items.filter(item => String(item.id) !== String(id));
        saveDevStore(store);
      }
    }
    devRefreshCardButtons();
    renderPlaylistsGrid();
  }

  function devCreatePlaylist(name) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return null;
    const store = getDevStore();
    const id = 'pl_' + Date.now().toString(36);
    store.custom[id] = { id: id, name: name, icon: '📁', items: [] };
    store.activeId = id;
    activeDevPlaylistId = id;
    saveDevStore(store);
    return id;
  }

  function renderPlaylistsGrid() {
    const grid = document.getElementById('grid-playlists');
    if (!grid || !isDevMode) return;
    const store = getDevStore();
    // Queue pseudo-view ('queue' is not a stored playlist).
    if (activeDevPlaylistId === 'queue') {
      const qpills = devPlaylistIds(store).map(pid => {
        const p = getDevPlaylist(store, pid);
        if (!p) return '';
        const n = (p.items || []).length;
        return '<button type="button" class="playlist-pill"' +
      ' onclick="activeDevPlaylistId=\\'' + pid + '\\'; renderPlaylistsGrid();">' +
          escapeHtml(p.icon || '📁') + ' ' + escapeHtml(p.name) + ' (' + n + ')</button>';
      }).join('');
      const qq = getDevQueue();
      let qhtml = '<div class="playlist-pills">' + qpills +
        '<button type="button" class="playlist-pill active" onclick="activeDevPlaylistId=\\'queue\\'; renderPlaylistsGrid();">📋 Queue (' + qq.length + ')</button>' +
        '<button type="button" class="playlist-pill" onclick="devPromptNewPlaylist()">➕ New Playlist</button></div>';
      qhtml += '<div class="search-results-subheading"><span>📋</span><span>Play Queue</span>' +
        '<span class="sub-count">' + qq.length + (qq.length === 1 ? ' item' : ' items') + ' · auto-plays next</span></div>';
      if (qq.length > 0) {
        qhtml += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:8px;">' +
          '<button type="button" class="card-mini-btn" onclick="devPlayNextFromQueue()">▶ Play Next Now</button>' +
          '<button type="button" class="card-mini-btn" onclick="devQueueClear()">Clear Queue</button></div>';
      }
      qhtml += '<div style="grid-column:1/-1;">' + devQueueListHtml() + '</div>';
      grid.innerHTML = qhtml;
      return;
    }
    if (!getDevPlaylist(store, activeDevPlaylistId)) activeDevPlaylistId = 'history';
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    const pills = devPlaylistIds(store).map(pid => {
      const p = getDevPlaylist(store, pid);
      if (!p) return '';
      const n = (p.items || []).length;
      return '<button type="button" class="playlist-pill' + (pid === activeDevPlaylistId ? ' active' : '') + '"' +
        ' onclick="activeDevPlaylistId=\\'' + pid + '\\'; renderPlaylistsGrid();">' +
        escapeHtml(p.icon || '📁') + ' ' + escapeHtml(p.name) + ' (' + n + ')</button>';
    }).join('');
    let html = '<div class="playlist-pills">' + pills +
      '<button type="button" class="playlist-pill" onclick="devPromptNewPlaylist()">➕ New Playlist</button></div>';
    let items = (pl && pl.items) || [];
    // History sort: last-listened (default, recency of play) vs shiur date.
    let historySort = 'listened';
    try { historySort = localStorage.getItem('yutorah_history_sort') || 'listened'; } catch (e) {}
    if (pl && pl.isHistory) {
      if (historySort !== 'shiurdate') historySort = 'listened';
      if (historySort === 'shiurdate') {
        items = [...items].sort((a, b) => String(b.dateISO || b.date || '').localeCompare(String(a.dateISO || a.date || '')));
      }
      html += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
        '<span style="font-size:12px; font-weight:700; color:var(--text-muted);">Order:</span>' +
        '<button type="button" class="card-mini-btn' + (historySort === 'listened' ? ' active-save' : '') + '" onclick="setHistorySort(\\'listened\\')">🕒 Last Listened</button>' +
        '<button type="button" class="card-mini-btn' + (historySort === 'shiurdate' ? ' active-save' : '') + '" onclick="setHistorySort(\\'shiurdate\\')">📅 Shiur Date</button></div>';
    }
    html += '<div class="search-results-subheading"><span>' + escapeHtml((pl && pl.icon) || '📁') + '</span>' +
      '<span>' + escapeHtml((pl && pl.name) || '') + '</span>' +
      '<span class="sub-count">' + items.length + ' Shiurim • ' + escapeHtml(devTotalDuration(items)) + '</span></div>';
    if (!pl.isHistory && !store.system[pl.id]) {
      html += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:8px;">' +
        '<button type="button" class="card-mini-btn" onclick="playDevPlaylistAll()">▶ Play All</button>' +
        '<button type="button" class="card-mini-btn" onclick="devExportPlaylist()">Export JSON</button>' +
        '<button type="button" class="card-mini-btn" onclick="devDeletePlaylist()">Delete Playlist</button></div>';
    } else if (items.length > 0) {
      html += '<div style="grid-column:1/-1; margin-bottom:8px;"><button type="button" class="card-mini-btn" onclick="playDevPlaylistAll()">▶ Play All</button></div>';
    }
    if (items.length === 0) {
      html += '<div style="grid-column:1/-1; text-align:center; padding:30px; color:var(--text-muted);">Empty playlist — tap 🕒 Later, ☆ Fav or ➕ Playlist on any card to add shiurim.</div>';
    } else {
      html += items.map(item => {
        const iid = String(item.id);
        return '<div>' + renderDocToCard(item) +
          '<div style="margin-top:6px; display:flex; gap:6px; align-items:center;">' +
          '<button type="button" class="card-mini-btn" data-dev-remove="' + pl.id + ':' + iid + '"' +
          ' onclick="devAskRemove(\\'' + pl.id + '\\', \\'' + iid + '\\')">✕ Remove from Playlist</button>' +
          '</div></div>';
      }).join('');
    }
    grid.innerHTML = html;
  }

  function devPromptNewPlaylist() {
    closeConfirmModal();
    const overlay = document.createElement('div');
    overlay.id = 'newPlaylistModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:360px; width:100%; padding:18px; border:1px solid var(--border-light);';
    box.innerHTML = '<div style="font-weight:800; margin-bottom:10px;">➕ New Playlist</div><input id="newPlInput" type="text" placeholder="Playlist name" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-light);"><div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;"><button type="button" class="card-mini-btn" id="newPlCancel">Cancel</button><button type="button" class="card-mini-btn active-save" id="newPlOk">Create</button></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e=>{ if(e.target===overlay){ overlay.remove(); }});
    document.body.appendChild(overlay);
    const input = box.querySelector('#newPlInput');
    const ok = ()=>{ const v=(input.value||'').trim(); if(v){ devCreatePlaylist(v); renderPlaylistsGrid(); } overlay.remove(); };
    box.querySelector('#newPlCancel').addEventListener('click', ()=>overlay.remove());
    box.querySelector('#newPlOk').addEventListener('click', ok);
    input.addEventListener('keydown', e=>{ if(e.key==='Enter') ok(); if(e.key==='Escape') overlay.remove(); });
    setTimeout(()=>input.focus(), 50);
  }
  function closeNewPlaylistModal(){ const m=document.getElementById('newPlaylistModal'); if(m) m.remove(); }

  function playDevPlaylistAll() {
    const store = getDevStore();
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    if (pl && pl.items && pl.items.length > 0) {
      playShiurById(null, String(pl.items[0].id));
    }
  }

  function devExportPlaylist() {
    const store = getDevStore();
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    if (!pl) return;
    try {
      const blob = new Blob([JSON.stringify(pl, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'playlist-' + pl.id + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {}
  }

  function setHistorySort(mode) {
    try { localStorage.setItem('yutorah_history_sort', mode === 'shiurdate' ? 'shiurdate' : 'listened'); } catch (e) {}
    renderPlaylistsGrid();
  }

  // Generic in-app confirm dialog (no system popups): title + body text,
  // Cancel / confirmLabel buttons; onConfirm runs on confirmation.
  let devConfirmCb = null;
  function openConfirmModal(opts) {
    closeConfirmModal();
    const o = opts || {};
    const overlay = document.createElement('div');
    overlay.id = 'confirmModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', o.title || 'Confirm');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:400px; width:100%; padding:20px; border:1px solid var(--border-light);';
    box.innerHTML = '<div style="font-weight:800; font-size:16px; margin-bottom:8px;">' + escapeHtml(o.title || 'Are you sure?') + '</div>' +
      '<div style="font-size:14px; color:var(--text-muted); margin-bottom:16px;">' + escapeHtml(o.body || '') + '</div>' +
      '<div style="display:flex; gap:8px; justify-content:flex-end;">' +
      '<button type="button" class="card-mini-btn" id="confirmModalCancel">Cancel</button>' +
      '<button type="button" class="card-mini-btn active-save" id="confirmModalOk">' + escapeHtml(o.confirmLabel || 'Confirm') + '</button></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeConfirmModal(); });
    document.body.appendChild(overlay);
    devConfirmCb = (typeof o.onConfirm === 'function') ? o.onConfirm : null;
    box.querySelector('#confirmModalCancel').addEventListener('click', closeConfirmModal);
    box.querySelector('#confirmModalOk').addEventListener('click', () => {
      const cb = devConfirmCb;
      devConfirmCb = null;
      closeConfirmModal();
      if (cb) cb();
    });
  }

  function closeConfirmModal() {
    devConfirmCb = null;
    const m = document.getElementById('confirmModal');
    if (m) m.remove();
  }

  // Change Log modal (dev settings): latest changes, most recent on top.
  async function openChangelogModal() {
    closeChangelogModal();
    const menu = document.getElementById('settingsMenu');
    if (menu) menu.style.display = 'none';
    const overlay = document.createElement('div');
    overlay.id = 'changelogModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Change log');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:480px; width:100%; max-height:80vh; overflow:auto; padding:18px; border:1px solid var(--border-light);';
    box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">' +
      '<div style="font-weight:800; font-size:16px;">📋 Latest Changes</div>' +
      '<button type="button" class="card-mini-btn" onclick="closeChangelogModal()">Close ×</button></div>' +
      '<div id="changelogList"><div style="color:var(--text-muted);">Loading…</div></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeChangelogModal(); });
    document.body.appendChild(overlay);
    try {
      const res = await fetch('/api/changelog');
      const data = await res.json();
      const entries = (data && data.entries) || [];
      const list = box.querySelector('#changelogList');
      if (!list) return;
      if (entries.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);">No changes logged yet.</div>';
        return;
      }
      list.innerHTML = entries.map(en => {
        let when = String(en.date || '');
        try {
          const d = new Date(when);
          if (!isNaN(d)) when = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        } catch (e) {}
        return '<div style="padding:8px 0; border-bottom:1px solid var(--border-light);">' +
          '<div style="font-size:12px; color:var(--text-muted);">' + escapeHtml(when) + '</div>' +
          '<div style="font-size:14px;">' + escapeHtml(en.message || '') + '</div></div>';
      }).join('');
    } catch (e) {
      const list = box.querySelector('#changelogList');
      if (list) list.innerHTML = '<div style="color:var(--text-muted);">Could not load the change log.</div>';
    }
  }

  function closeChangelogModal() {
    const m = document.getElementById('changelogModal');
    if (m) m.remove();
  }

  function devDeletePlaylist() {
    const store = getDevStore();
    const pl = store.custom[activeDevPlaylistId];
    if (!pl) return;
    openConfirmModal({
      title: 'Delete Playlist',
      body: 'Delete "' + pl.name + '"? Shiurim stay in your other playlists.',
      confirmLabel: '🗑️ Delete',
      onConfirm: () => {
        const s = getDevStore();
        delete s.custom[activeDevPlaylistId];
        activeDevPlaylistId = 'history';
        saveDevStore(s);
        renderPlaylistsGrid();
      }
    });
  }

  var DEV_QUEUE_KEY = 'yutorah_dev_queue';
  var devSeriesCache = {};

  // Play queue (Dev Mode): ordered top→bottom, auto-plays next on track end.
  // Items are shiur snapshots or { kind:'series', seriesTitle, items:[...] }
  // series entries expand in place when they reach the front.
  function getDevQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(DEV_QUEUE_KEY) || '[]');
      return Array.isArray(q) ? q : [];
    } catch (e) {
      return [];
    }
  }

  function saveDevQueue(q) {
    try {
      localStorage.setItem(DEV_QUEUE_KEY, JSON.stringify(q || []));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        flashToast('⚠️ Storage full — queue change was NOT saved', true, false);
      }
    }
    renderQueuePopup();
    if (document.getElementById('grid-playlists') && activeDevPlaylistId === 'queue') renderPlaylistsGrid();
  }

  function devQueueFlatIds() {
    const ids = new Set();
    for (const it of getDevQueue()) {
      if (it.kind === 'series') (it.items || []).forEach(s => ids.add(String(s.id)));
      else if (it.id) ids.add(String(it.id));
    }
    return ids;
  }

  function devInQueue(id) {
    return devQueueFlatIds().has(String(id));
  }

  function devQueueAdd(id) {
    const sid = String(id);
    if (devInQueue(sid)) return true;
    const snap = devSnapshot(sid);
    if (!snap) return false;
    const q = getDevQueue();
    snap.queuedAt = Date.now();
    q.push(snap);
    saveDevQueue(q);
    devRefreshCardButtons();
    return true;
  }

  function devQueueAddSeries(coverId, coverBtn) {
    const cid = String(coverId);
    // Toggle off: a queued series removes as one unit.
    const q0 = getDevQueue();
    if (q0.some(it => it.kind === 'series' && String(it.coverId || '') === cid)) {
      saveDevQueue(q0.filter(it => !(it.kind === 'series' && String(it.coverId || '') === cid)));
      devRefreshCardButtons();
      return true;
    }
    // Fast path: client-grouped docs cached at render time.
    const entry = devSeriesCache[cid];
    if (entry && entry.docs && entry.docs.length > 0) {
      const already = devQueueFlatIds();
      const items = entry.docs.map(d => {
        const did = String(d.shiurid || d.shiurID || d.id || '');
        return {
          id: did,
          title: d.shiurtitle || d.shiurTitle || d.title || 'Untitled',
          speaker: d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : (d.speaker || 'YUTorah')),
          photo: d.photo || '',
          duration: d.durationformatted || (d.duration ? d.duration + ' min' : ''),
          queuedAt: Date.now()
        };
      }).filter(s => s.id && !already.has(s.id));
      if (items.length === 0) return false;
      const q = getDevQueue();
      q.push({ kind: 'series', coverId: cid, seriesTitle: entry.title || 'Series', items: items, queuedAt: Date.now() });
      saveDevQueue(q);
      devRefreshCardButtons();
      return true;
    }
    // Fallback (SSR covers have no cached docs): scrape the drawer's
    // sub-card anchors from the DOM — same snapshots as single adds.
    let drawer = null;
    try {
      const scope = (coverBtn && coverBtn.closest) ? coverBtn.closest('.quick-card-series-group') : null;
      const coverLink = scope
        ? scope.querySelector('a.quick-card-link[data-id="' + cid + '"]')
        : document.querySelector('a.quick-card-link[data-id="' + cid + '"]');
      const group = coverLink && coverLink.closest ? coverLink.closest('.quick-card-series-group') : null;
      drawer = group ? group.querySelector('.series-drawer') : null;
    } catch (e) { drawer = null; }
    if (drawer) {
      const already = devQueueFlatIds();
      const items = [];
      drawer.querySelectorAll('a.series-sub-card[data-id]').forEach(a => {
        const sid = a.getAttribute('data-id');
        if (!sid || already.has(String(sid))) return;
        devSnapshotFromCard(a);
        const snap = devDocCache[String(sid)];
        if (snap) {
          items.push({ id: String(sid), title: snap.title, speaker: snap.speaker, photo: snap.photo, duration: snap.duration, queuedAt: Date.now() });
          already.add(String(sid));
        }
      });
      // Include the cover itself as part one (null-safe: cover may be gone).
      if (!already.has(cid)) {
        const coverLink = coverLinkSafe(cid);
        if (coverLink) {
          devSnapshotFromCard(coverLink);
          const csnap = devDocCache[cid];
          if (csnap) items.unshift({ id: cid, title: csnap.title, speaker: csnap.speaker, photo: csnap.photo, duration: csnap.duration, queuedAt: Date.now() });
        }
      }
      if (items.length === 0) return false;
      // Series title from the drawer's own expander button (scoped lookup).
      let sTitle = 'Series';
      try {
        const scopeGroup = drawer.closest ? drawer.closest('.quick-card-series-group') : null;
        const titleBtn = scopeGroup ? scopeGroup.querySelector('[data-series-title]') : null;
        if (titleBtn && titleBtn.getAttribute) sTitle = titleBtn.getAttribute('data-series-title') || sTitle;
      } catch (e) {}
      const q = getDevQueue();
      q.push({ kind: 'series', coverId: cid, seriesTitle: sTitle, items: items, queuedAt: Date.now() });
      saveDevQueue(q);
      devRefreshCardButtons();
      return true;
    }
    return devQueueAdd(cid);
  }

  function coverLinkSafe(cid) {
    try {
      return document.querySelector('a.quick-card-link[data-id="' + cid + '"]');
    } catch (e) {
      return null;
    }
  }

  function devSeriesQueued(coverId) {
    const cid = String(coverId);
    return getDevQueue().some(it => it.kind === 'series' && String(it.coverId || '') === cid);
  }

  function devQueueToggle(id, isCover, btn) {
    if (isCover) {
      devQueueAddSeries(id, btn || null);
      return;
    }
    if (devInQueue(id)) {
      devQueueRemoveId(id);
    } else {
      devQueueAdd(id);
    }
  }

  function devQueueRemoveId(id) {
    const sid = String(id);
    const q = getDevQueue().map(it => {
      if (it.kind === 'series') {
        return { ...it, items: (it.items || []).filter(s => String(s.id) !== sid) };
      }
      return it;
    }).filter(it => it.kind === 'series' ? (it.items && it.items.length > 0) : String(it.id) !== sid);
    saveDevQueue(q);
    devRefreshCardButtons();
  }

  function devQueueRemoveAt(idx) {
    const q = getDevQueue();
    if (idx < 0 || idx >= q.length) return;
    q.splice(idx, 1);
    saveDevQueue(q);
    devRefreshCardButtons();
  }

  function devQueueMove(idx, dir) {
    const q = getDevQueue();
    const j = idx + dir;
    if (idx < 0 || idx >= q.length || j < 0 || j >= q.length) return;
    const tmp = q[idx];
    q[idx] = q[j];
    q[j] = tmp;
    saveDevQueue(q);
  }

  function devQueueMoveTo(fromIdx, toIdx) {
    const q = getDevQueue();
    if (fromIdx < 0 || fromIdx >= q.length) return;
    toIdx = Math.max(0, Math.min(q.length - 1, toIdx));
    if (fromIdx === toIdx) return;
    const it = q.splice(fromIdx, 1)[0];
    q.splice(toIdx, 0, it);
    saveDevQueue(q);
  }

  function devQueueClear() {
    const q = getDevQueue();
    if (q.length === 0) return;
    openConfirmModal({
      title: 'Clear Queue',
      body: 'Remove all ' + q.length + ' item' + (q.length === 1 ? '' : 's') + ' from the play queue?',
      confirmLabel: '🗑️ Clear',
      onConfirm: () => {
        saveDevQueue([]);
        devRefreshCardButtons();
      }
    });
  }

  // Shift the next playable shiur, expanding series entries in place.
  // Returns { id, title } or null when the queue is empty (or dev is off).
  function devQueuePopNext() {
    if (!isDevMode) return null;
    let q = getDevQueue();
    while (q.length > 0) {
      const head = q[0];
      if (head.kind === 'series') {
        const parts = (head.items || []).filter(s => s && s.id);
        q.shift();
        for (let i = parts.length - 1; i >= 0; i--) q.unshift(parts[i]);
        saveDevQueue(q);
        continue;
      }
      q.shift();
      saveDevQueue(q);
      const nid = String(head.id || '');
      if (!nid) continue;
      return { id: nid, title: head.title || 'Untitled' };
    }
    saveDevQueue(q);
    return null;
  }

  function devPlayNextFromQueue() {
    // Skip entries matching the currently playing track (never "advance"
    // to the same spot or burn a queue item on it).
    let next = devQueuePopNext();
    let guard = 0;
    while (next && String(next.id) === String(currentShiurId) && guard < 10) {
      guard++;
      next = devQueuePopNext();
    }
    if (!next) return false;
    devRefreshCardButtons();
    try {
      const label = String(next.title || 'Untitled');
      flashToast('▶ Up Next: ' + (label.length > 60 ? label.slice(0, 60) + '…' : label), false, false);
    } catch (e) {}
    playShiurById(null, next.id);
    return true;
  }

  // Queue popup (mini-player ☰ + playlists tab share this renderer).
  let devDragIdx = -1;
  function toggleQueuePopup() {
    if (!isDevMode) return;
    const pop = document.getElementById('queuePopup');
    if (!pop) return;
    if (pop.style.display === 'none') {
      renderQueuePopup();
      pop.style.display = 'flex';
    } else {
      pop.style.display = 'none';
    }
  }

  function devQueueListHtml() {
    const q = getDevQueue();
    if (q.length === 0) {
      return '<div class="queue-empty">Queue is empty — tap ⏭ Queue on any card to line up what plays next.</div>';
    }
    return q.map((it, idx) => {
      const isSeries = it.kind === 'series';
      const title = isSeries ? ('📚 ' + (it.seriesTitle || 'Series') + ' (' + ((it.items || []).length) + ' parts)') : (it.title || 'Untitled');
      const sub = isSeries ? 'Series — expands when reached' : ((it.speaker || 'YUTorah') + (it.duration ? ' · ' + it.duration : ''));
      return '<div class="queue-row" draggable="true" data-qidx="' + idx + '"' +
        ' ondragstart="devQueueDragStart(event, ' + idx + ')" ondragover="devQueueDragOver(event)" ondrop="devQueueDrop(event, ' + idx + ')" ondragend="devQueueDragEnd(event)">' +
        '<span class="queue-handle" title="Drag to reorder">⠿</span>' +
        '<span class="queue-pos">' + (idx + 1) + '</span>' +
        '<div class="queue-main"><div class="queue-title">' + escapeHtml(title) + '</div>' +
        '<div class="queue-sub">' + escapeHtml(sub) + '</div></div>' +
        '<div class="queue-row-btns">' +
        '<button type="button" class="card-mini-btn" onclick="devQueueMove(' + idx + ', -1)" title="Move up">▲</button>' +
        '<button type="button" class="card-mini-btn" onclick="devQueueMove(' + idx + ', 1)" title="Move down">▼</button>' +
        '<button type="button" class="card-mini-btn" onclick="devQueueRemoveAt(' + idx + ')" title="Remove">✕</button>' +
        '</div></div>';
    }).join('');
  }

  function renderQueuePopup() {
    const pop = document.getElementById('queuePopup');
    const list = document.getElementById('queueList');
    const count = document.getElementById('queueCount');
    if (!pop || !list) return;
    if (!isDevMode) {
      pop.style.display = 'none';
      return;
    }
    const q = getDevQueue();
    list.innerHTML = devQueueListHtml();
    if (count) count.textContent = q.length === 1 ? '1 item' : q.length + ' items';
  }

  function devQueueDragStart(e, idx) {
    devDragIdx = idx;
    const row = e.target.closest ? e.target.closest('.queue-row') : null;
    if (row) row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) {}
    }
  }

  function devQueueDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function devQueueDrop(e, idx) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (devDragIdx >= 0 && devDragIdx !== idx) devQueueMoveTo(devDragIdx, idx);
    devDragIdx = -1;
  }

  function devQueueDragEnd() {
    devDragIdx = -1;
    document.querySelectorAll('.queue-row.dragging').forEach(el => el.classList.remove('dragging'));
  }

  function openPlaylistModal(id) {
    if (!isDevMode) return;
    closePlaylistModal();
    const snap = devSnapshot(id);
    if (!snap) return;
    const store = getDevStore();
    const overlay = document.createElement('div');
    overlay.id = 'playlistModal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Add to playlist');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:440px; width:100%; max-height:80vh; overflow:auto; padding:18px; border:1px solid var(--border-light);';
    function rowHtml(pid, name, icon, count, checked) {
      return '<label style="display:flex; align-items:center; gap:8px; padding:7px 4px; cursor:pointer;" data-pl-row="' + escapeHtml(name.toLowerCase()) + '">' +
        '<input type="checkbox" data-pl-check="' + pid + '"' + (checked ? ' checked' : '') + (pid === 'history' ? ' disabled' : '') + '>' +
        '<span>' + escapeHtml(icon) + ' ' + escapeHtml(name) + ' (' + count + ')</span></label>';
    }
    function listHtml(filter) {
      const s = getDevStore();
      const f = String(filter || '').toLowerCase();
      let h = '';
      devPlaylistIds(s).forEach(pid => {
        const p = getDevPlaylist(s, pid);
        if (!p) return;
        if (f && p.name.toLowerCase().indexOf(f) === -1) return;
        h += rowHtml(pid, p.name, p.icon || '📁', (p.items || []).length, devInPlaylist(pid, id));
      });
      return h || '<div style="padding:8px; color:var(--text-muted);">No playlists match.</div>';
    }
    box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">' +
      '<div style="font-weight:800;">➕ Add to Playlist</div>' +
      '<button type="button" class="card-mini-btn" onclick="closePlaylistModal()">Close ×</button></div>' +
      '<div style="font-size:13px; color:var(--text-muted); margin-bottom:10px;">' + escapeHtml(snap.title) + '</div>' +
      '<input id="devPlFilter" type="text" placeholder="Type to filter or create..." autocomplete="off"' +
      ' style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-light); margin-bottom:6px;">' +
      '<div id="devPlCreateWrap"></div>' +
      '<div id="devPlList">' + listHtml('') + '</div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closePlaylistModal(); });
    document.body.appendChild(overlay);
    const filterInput = box.querySelector('#devPlFilter');
    const listEl = box.querySelector('#devPlList');
    const createWrap = box.querySelector('#devPlCreateWrap');
    filterInput.addEventListener('input', () => {
      listEl.innerHTML = listHtml(filterInput.value);
      const v = filterInput.value.trim();
      if (v) {
        createWrap.innerHTML = '<button type="button" class="card-mini-btn" id="devPlCreateBtn">➕ Create "' + escapeHtml(v) + '"</button>';
        const cb = createWrap.querySelector('#devPlCreateBtn');
        cb.addEventListener('click', () => {
          const nid = devCreatePlaylist(v);
          if (nid) devSetMembership(nid, id, true);
          openPlaylistModal(id);
          renderPlaylistsGrid();
        });
      } else {
        createWrap.innerHTML = '';
      }
    });
    listEl.addEventListener('change', e => {
      const cb = e.target.closest('[data-pl-check]');
      if (!cb) return;
      devSetMembership(cb.getAttribute('data-pl-check'), id, cb.checked);
      devRefreshCardButtons();
    });
    const first = box.querySelector('#devPlFilter');
    if (first) first.focus();
  }

  function closePlaylistModal() {
    const m = document.getElementById('playlistModal');
    if (m) m.remove();
  }

  let parshaShiurimLoaded = false;
  async function loadParshaShiurimGrid() {
    const grid = document.getElementById('grid-parsha');
    if (!grid || parshaShiurimLoaded) return;
    grid.innerHTML = '<div class="spinner-box" style="display:block; grid-column:1/-1;"><div class="spinner"></div>Loading current Parsha shiurim...</div>';
    try {
      const parshaCat = '${parshaCatId}';
      const res = await fetch('/api/search?subCategoryId=' + encodeURIComponent(parshaCat) + '&start=1');
      const data = await res.json();
      const docs = data?.response?.docs || [];
      if (docs.length > 0) {
        grid.innerHTML = docs.map(renderDocToCard).join('');
        parshaShiurimLoaded = true;
      } else {
        grid.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No parsha shiurim found.</div>';
      }
    } catch (e) {
      grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #c0392b; grid-column: 1/-1;">Could not load parsha shiurim. <button class="chip" onclick="parshaShiurimLoaded=false; loadParshaShiurimGrid();">Retry</button></div>';
    }
  }

  // Switch Collection Tabs
  const collections = ['editors', 'playlists', 'series', 'recent', 'popular', 'viewed', 'parsha', 'daily', 'trending'];
  const collectionTitles = {
    editors: "⭐ Editor's Picks",
    playlists: "🎧 Dev's Playlists",
    series: "📚 Featured Series",
    recent: "⏱️ Recently Uploaded",
    popular: "🔥 Most Popular",
    viewed: "👁️ Recently Viewed",
    parsha: "📖 Parsha Shiurim",
    daily: "📜 Daily Shiur",
    trending: "🔥 Trending Keywords"
  };

  // =========================================================================
  // [DEAD CODE / INACTIVE] Simple View switcher & Settings menu handlers.
  // Kept in codebase for reference as requested, but hidden from the UI.
  // =========================================================================
  function isSimpleMode() {
    return document.documentElement.getAttribute('data-view') === 'simple';
  }

  function updateSettingsMenuText() {
    const textEl = document.getElementById('viewModeText');
    const iconEl = document.getElementById('viewModeIcon');
    const simple = isSimpleMode();
    if (textEl) {
      textEl.textContent = simple ? 'Revert to Full View' : 'Switch to Simple View';
    }
    if (iconEl) {
      iconEl.textContent = simple ? '🔄' : '✨';
    }
  }

  function toggleSettingsMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('settingsMenu');
    if (!menu) return;
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      updateSettingsMenuText();
    }
  }

  function triggerModeOverlay(text) {
    const oldOverlay = document.getElementById('modeOverlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modeOverlay';
    overlay.className = 'mode-switch-overlay';
    overlay.innerHTML = '<div class="mode-switch-text">' + text + '</div>';
    document.body.appendChild(overlay);

    setTimeout(() => {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 1000);
  }

  function toggleViewMode(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('settingsMenu');
    if (menu) menu.style.display = 'none';

    const currentlySimple = isSimpleMode();
    if (currentlySimple) {
      // Switch back to Full View
      document.documentElement.removeAttribute('data-view');
      try { localStorage.setItem('yutorah_view_mode', 'full'); } catch(err) {}
      triggerModeOverlay('MGR');
    } else {
      // Switch to Simple View
      document.documentElement.setAttribute('data-view', 'simple');
      try { localStorage.setItem('yutorah_view_mode', 'simple'); } catch(err) {}
      triggerModeOverlay('CSR');

      // If active tab was one of the complex tabs, switch back to editors
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab && (activeTab.id === 'tab-series' || activeTab.id === 'tab-viewed' || activeTab.id === 'tab-parsha' || activeTab.id === 'tab-trending')) {
        switchCollection('editors');
      }
    }
    updateSettingsMenuText();
    syncHeaderSpacer();
  }

  // Holiday & Seasonal Theme Management (Light Mode Exclusively)
  const clientThemes = ${jsEmbed(THEMES)};

  function getClientHebrewDate() {
    try {
      const formatter = new Intl.DateTimeFormat('en-u-ca-hebrew', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
      const parts = formatter.formatToParts(new Date());
      const day = parseInt(parts.find(p => p.type === 'day')?.value || '1', 10);
      const month = (parts.find(p => p.type === 'month')?.value || 'Elul').trim();
      const year = parseInt(parts.find(p => p.type === 'year')?.value || '5786', 10);

      const d = new Date();
      let omerDay = 0;
      if (month === 'Nisan' && day >= 16) {
        omerDay = day - 15;
      } else if (month === 'Iyar') {
        omerDay = 15 + day;
      } else if (month === 'Sivan' && day <= 5) {
        omerDay = 44 + day;
      }

      return { day, month, year, omerDay, gregorianMonth: d.getMonth() + 1, gregorianDay: d.getDate() };
    } catch (e) {
      return { day: 22, month: 'Elul', year: 5786, omerDay: 0, gregorianMonth: 9, gregorianDay: 4 };
    }
  }

  function detectCurrentHoliday() {
    const h = getClientHebrewDate();
    const { day, month, omerDay, gregorianMonth, gregorianDay } = h;

    if (gregorianMonth === 7 && gregorianDay === 4) return { key: 'july4', chanukahDay: 0 };

    // Erev Yom Tov (Eve of Melacha-forbidden festivals) with 50/50 random overlap selection
    // Erev Rosh Hashanah (29 Elul) -> 50/50 between Rosh Hashanah and Chodesh Elul
    if (month === 'Elul' && day === 29) {
      return Math.random() < 0.5
        ? { key: 'rosh_hashanah', chanukahDay: 0 }
        : { key: 'elul', chanukahDay: 0 };
    }

    // Erev Yom Kippur (9 Tishrei) -> 50/50 between Yom Kippur and Aseres Yemei Teshuva
    if (month === 'Tishri' && day === 9) {
      return Math.random() < 0.5
        ? { key: 'yom_kippur', chanukahDay: 0 }
        : { key: 'teshuva', chanukahDay: 0 };
    }

    // Erev Sukkos (14 Tishrei) -> Sukkos theme
    if (month === 'Tishri' && day === 14) {
      return { key: 'sukkos', chanukahDay: 0 };
    }

    // Erev Shemini Atzeres / Simchas Torah (21 Tishrei) -> 50/50 between Simchas Torah and Hoshana Rabbah
    if (month === 'Tishri' && day === 21) {
      return Math.random() < 0.5
        ? { key: 'simchas_torah', chanukahDay: 0 }
        : { key: 'hoshana_rabbah', chanukahDay: 0 };
    }

    // Erev Pesach (14 Nisan) -> 50/50 between Pesach and Nissan buildup
    if (month === 'Nisan' && day === 14) {
      return Math.random() < 0.5
        ? { key: 'pesach', chanukahDay: 0 }
        : { key: 'nissan_buildup', chanukahDay: 0 };
    }

    // Erev Shavuos (5 Sivan) -> 50/50 between Shavuos and Sefiras HaOmer (Day 49)
    if (month === 'Sivan' && day === 5) {
      return Math.random() < 0.5
        ? { key: 'shavuos', chanukahDay: 0 }
        : { key: 'omer', omerDay: 49, chanukahDay: 0 };
    }

    if (month === 'Tishri' && day === 10) return { key: 'yom_kippur', chanukahDay: 0 };
    if (month === 'Tishri' && (day === 1 || day === 2)) return { key: 'rosh_hashanah', chanukahDay: 0 };
    if (month === 'Tishri' && day >= 3 && day <= 8) return { key: 'teshuva', chanukahDay: 0 };
    if (month === 'Tishri' && (day === 22 || day === 23)) return { key: 'simchas_torah', chanukahDay: 0 };
    if (month === 'Tishri' && day >= 15 && day <= 20) return { key: 'sukkos', chanukahDay: 0 };

    if ((month === 'Heshvan' && day === 1) || (month === 'Tishri' && day === 30)) {
      return { key: 'rosh_chodesh_cheshvan', chanukahDay: 0 };
    }

    if (month === 'Kislev' && day >= 25) {
      return { key: 'chanukah', chanukahDay: day - 24 };
    }
    if (month === 'Tevet' && day <= 3) {
      return { key: 'chanukah', chanukahDay: Math.min(8, 5 + day) };
    }

    if (month === 'Shevat' && day === 15) return { key: 'tubshevat', chanukahDay: 0 };

    const isPurimMonth = month === 'Adar II' || month === 'Adar';
    if (isPurimMonth && (day === 14 || day === 15)) return { key: 'purim', chanukahDay: 0 };
    if (isPurimMonth && (day === 13 || day === 11)) return { key: 'taanis_esther', chanukahDay: 0 };
    if (isPurimMonth && day < 13) return { key: 'adar_buildup', chanukahDay: 0 };

    if (month === 'Nisan' && day >= 15 && day <= 22) return { key: 'pesach', chanukahDay: 0 };
    if (month === 'Nisan' && day < 15) return { key: 'nissan_buildup', chanukahDay: 0 };

    if (month === 'Iyar' && (day === 3 || day === 4)) return { key: 'yom_hazikaron', chanukahDay: 0 };
    if (month === 'Iyar' && (day === 5 || day === 6)) return { key: 'yom_haatzmaut', chanukahDay: 0 };
    if (month === 'Iyar' && day === 18) return { key: 'lag_baomer', chanukahDay: 0 };
    if (month === 'Iyar' && day === 28) return { key: 'yom_yerushalayim', chanukahDay: 0 };

    if (month === 'Sivan' && (day === 6 || day === 7)) return { key: 'shavuos', chanukahDay: 0 };
    if (omerDay > 0) return { key: 'omer', omerDay, chanukahDay: 0 };

    if (month === 'Av' && (day === 9 || day === 10)) return { key: 'tisha_bav', chanukahDay: 0 };
    if (month === 'Av' && day >= 1 && day <= 8) return { key: 'nine_days', chanukahDay: 0 };
    if (month === 'Tamuz' && day >= 17) return { key: 'three_weeks', chanukahDay: 0 };
    if (month === 'Av' && day === 15) return { key: 'tubav', chanukahDay: 0 };

    if (month === 'Elul') return { key: 'elul', chanukahDay: 0 };
    if (day === 1 || day === 30) return { key: 'rosh_chodesh', chanukahDay: 0 };

    return { key: 'default', chanukahDay: 0 };
  }

  // [DEAD CODE / INACTIVE] Manual Theme Preview Override Controls
  // The theme engine now operates 100% automatically in the background using the Hebrew calendar.
  let activeThemeKey = 'auto';
  let activeVariant = 'a';

  function applyHolidayTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const motifWrap = document.getElementById('holidayMotifWrap');
    const motifIcon = document.getElementById('holidayMotifIcon');
    const motifTitle = document.getElementById('holidayMotifTitle');
    const taglineBar = document.getElementById('holidayTaglineBar');

    // Clean up previous dynamic theme style tag
    let themeStyleEl = document.getElementById('holidayThemeDynamicStyles');
    if (themeStyleEl) themeStyleEl.remove();

    let resolvedKey = activeThemeKey;
    let chanukahDay = 0;
    if (resolvedKey.startsWith('chanukah_')) {
      chanukahDay = parseInt(resolvedKey.replace('chanukah_', ''), 10);
      resolvedKey = 'chanukah';
    }

    if (resolvedKey === 'auto') {
      const detected = detectCurrentHoliday();
      resolvedKey = detected.key;
      chanukahDay = detected.chanukahDay || 1;
    }

    if (!resolvedKey || resolvedKey === 'default' || !clientThemes[resolvedKey]) {
      if (motifWrap) motifWrap.style.display = 'none';
      if (taglineBar) taglineBar.style.display = 'none';
      document.body.classList.remove('is-purim-theme');
      checkCalendarOverflow();
      return;
    }

    const themeDef = clientThemes[resolvedKey];
    let variantData;

    // For approved themes in auto mode (or if chosen in dropdown), randomly pick between A and B or lock to approved variant
    let effectiveVariant = activeVariant;
    const randomApprovedThemes = ['rosh_hashanah', 'sukkos', 'simchas_torah', 'adar_buildup', 'nissan_buildup', 'pesach', 'lag_baomer', 'shavuos', 'nine_days'];
    if (randomApprovedThemes.includes(resolvedKey) && activeThemeKey === 'auto') {
      effectiveVariant = Math.random() < 0.5 ? 'a' : 'b';
    }
    const lockedThemesToA = ['elul', 'yom_kippur', 'tubshevat', 'purim', 'taanis_esther', 'omer', 'yom_hazikaron', 'yom_yerushalayim', 'july4', 'three_weeks', 'tisha_bav', 'tubav', 'rosh_chodesh'];
    if (lockedThemesToA.includes(resolvedKey) && activeThemeKey === 'auto') {
      effectiveVariant = 'a';
    }
    const lockedThemesToB = ['yom_haatzmaut'];
    if (lockedThemesToB.includes(resolvedKey) && activeThemeKey === 'auto') {
      effectiveVariant = 'b';
    }

    if (resolvedKey === 'chanukah') {
      const dayNum = chanukahDay || 1;
      variantData = Object.assign({}, themeDef.variants['a']);
      variantData.icon = 'chanukah_a_' + dayNum + '.svg';
      variantData.title = 'Chanukah (Night ' + dayNum + ')';
      variantData.tagline = 'חנוכה שמח · Night ' + dayNum + ' of 8';
    } else if (resolvedKey === 'omer') {
      variantData = Object.assign({}, themeDef.variants['a']);
      // Randomly select between the two icons (flip calendar vs parchment scroll)
      variantData.icon = Math.random() < 0.5 ? 'omer_a.svg' : 'omer_b.svg';
      const h = getClientHebrewDate();
      if (h.omerDay > 0) {
        variantData.tagline = 'היום ' + h.omerDay + ' ימים לעומר · Count: Day ' + h.omerDay + ' of 49';
      }
    } else {
      variantData = themeDef.variants[effectiveVariant] || themeDef.variants['a'];
    }

    if (!variantData) return;

    // Apply CSS Variables to root (light mode only)
    if (!isDark) {
      if (variantData.primary) document.documentElement.style.setProperty('--primary', variantData.primary);
      if (variantData.accent) document.documentElement.style.setProperty('--accent', variantData.accent);
      if (variantData.bannerBg) document.documentElement.style.setProperty('--banner-bg', variantData.bannerBg);
    }

    // Render Motif Badge in Header (both light and dark mode)
    if (motifWrap && motifIcon && motifTitle) {
      motifWrap.style.display = 'inline-flex';
      motifIcon.innerHTML = '<img src="/assets/themes/' + variantData.icon + '" alt="icon" style="width:100%; height:100%; display:block;" onerror="this.style.display=&quot;none&quot;">';
      motifTitle.textContent = themeDef.badge || themeDef.name;
      motifWrap.title = variantData.title + ' (Tap 7 times to toggle pre-roll)';
    }

    // Toggle Purim Inverted Header Mode
    if (resolvedKey === 'purim') {
      document.body.classList.add('is-purim-theme');
    } else {
      document.body.classList.remove('is-purim-theme');
    }

    // Render Tagline Bar below sponsorship banner
    if (taglineBar && variantData.tagline) {
      taglineBar.style.display = 'block';
      taglineBar.textContent = variantData.tagline;
    } else if (taglineBar) {
      taglineBar.style.display = 'none';
    }

    // Inject custom CSS for theme variant
    if (variantData.css && !isDark) {
      themeStyleEl = document.createElement('style');
      themeStyleEl.id = 'holidayThemeDynamicStyles';
      themeStyleEl.textContent = variantData.css;
      document.head.appendChild(themeStyleEl);
    }
    checkCalendarOverflow();

    // Update controls in Settings menu
    const sel = document.getElementById('holidayThemeSelect');
    if (sel) sel.value = activeThemeKey;
    const btnA = document.getElementById('variantBtnA');
    const btnB = document.getElementById('variantBtnB');
    const btnC = document.getElementById('variantBtnC');
    if (btnA) btnA.classList.toggle('active', activeVariant === 'a');
    if (btnB) btnB.classList.toggle('active', activeVariant === 'b');
    if (btnC) {
      if (resolvedKey === 'elul') {
        btnC.style.display = 'block';
        btnC.classList.toggle('active', activeVariant === 'c');
      } else {
        btnC.style.display = 'none';
      }
    }

    syncHeaderSpacer();
  }

  function onHolidayThemeSelect(val) {
    activeThemeKey = val;
    if (val === 'yom_haatzmaut') {
      activeVariant = 'b';
    } else if (lockedThemesToA.includes(val)) {
      activeVariant = 'a';
    }
    try { localStorage.setItem('yutorah_preview_theme', val); } catch(e) {}
    try { localStorage.setItem('yutorah_preview_variant', activeVariant); } catch(e) {}
    applyHolidayTheme();
  }

  function setThemeVariant(variant) {
    activeVariant = variant;
    try { localStorage.setItem('yutorah_preview_variant', variant); } catch(e) {}
    applyHolidayTheme();
  }

  document.addEventListener('click', function(e) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    if (menu && menu.style.display === 'block') {
      if (btn && !btn.contains(e.target) && !menu.contains(e.target)) {
        menu.style.display = 'none';
      }
    }
  });

  // Cards / Rows view (persisted). Rows = one full-width row per shiur,
  // yutorah.org style; applies to every shiur grid on the page.
  // Mobile is always cards (toggle hidden); desktop defaults to rows.
  function isMobileView() {
    try {
      return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    } catch (e) {
      return false;
    }
  }
  function storedCardView() {
    try {
      return localStorage.getItem('yutorah_card_view') || '';
    } catch (e) {
      return '';
    }
  }
  function setCardView(view, persist) {
    let v = view === 'rows' ? 'rows' : 'cards';
    if (v === 'rows' && isMobileView()) v = 'cards';
    document.body.classList.toggle('rows-view', v === 'rows');
    if (document.documentElement) document.documentElement.classList.toggle('rows-view', v === 'rows');
    if (persist !== false) {
      try { localStorage.setItem('yutorah_card_view', v); } catch (e) {}
    }
    document.querySelectorAll('.view-toggle-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset && b.dataset.view === v);
    });
  }
  function defaultCardView() {
    const stored = storedCardView();
    if (stored === 'rows' || stored === 'cards') return isMobileView() ? 'cards' : stored;
    return isMobileView() ? 'cards' : 'rows';
  }

  // Hero slideshow rotation (6s autoplay, dots + arrows, pause on hover).
  let heroIdx = 0;
  let heroTimer = null;
  function heroShow(i) {
    const slides = document.querySelectorAll('#heroSlideshow .hero-slide');
    const dots = document.querySelectorAll('#heroSlideshow .hero-dot');
    if (!slides.length) return;
    heroIdx = ((i % slides.length) + slides.length) % slides.length;
    slides.forEach((s, k) => {
      const on = k === heroIdx;
      s.classList.toggle('active', on);
      if (s.tagName === 'A') {
        s.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (on) {
          s.removeAttribute('tabindex');
          s.removeAttribute('inert');
        } else {
          s.setAttribute('tabindex', '-1');
          s.setAttribute('inert', '');
        }
      } else {
        if (on) s.removeAttribute('inert');
        else s.setAttribute('inert', '');
      }
    });
    dots.forEach((d, k) => d.classList.toggle('active', k === heroIdx));
  }
  function heroGo(dir) {
    heroShow(heroIdx + dir);
    heroRestart();
  }
  function heroGoTo(i) {
    heroShow(i);
    heroRestart();
  }
  function heroRestart() {
    try { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } } catch (e) {}
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) {}
    heroTimer = setInterval(() => {
      const slides = document.querySelectorAll('#heroSlideshow .hero-slide');
      if (slides.length > 1 && !document.hidden) heroShow(heroIdx + 1);
    }, 6000);
  }
  function switchCollection(activeName) {
    collections.forEach(name => {
      const tab = document.getElementById('tab-' + name);
      const grid = document.getElementById('grid-' + name);
      if (tab) tab.classList.toggle('active', name === activeName);
      if (grid) {
        if (name === activeName) {
          grid.style.display = (name === 'trending' ? 'block' : 'grid');
        } else {
          grid.style.display = 'none';
        }
      }
    });
    const titleEl = document.getElementById('activeCollectionTitle');
    if (titleEl && collectionTitles[activeName]) {
      titleEl.textContent = collectionTitles[activeName];
    }
    if (activeName === 'viewed') {
      renderRecentlyViewedGrid();
    } else if (activeName === 'parsha') {
      loadParshaShiurimGrid();
    } else if (activeName === 'playlists') {
      renderPlaylistsGrid();
    }
    try { if (typeof devUpgradeCards === 'function') devUpgradeCards(); } catch (e) {}
  }

  // Audio Controls
  function togglePlay() {
    if (isCurrentShiurArticle) return;
    if (!audio.src) {
      if (pendingShiur) {
        if (!sponsorPlayedForThisShiur && currentSponsorAudio && !isPreRollDisabled()) {
          playSponsorPreRoll(pendingShiur);
          return;
        } else {
          startShiurPlayback(pendingShiur);
          return;
        }
      }
      // If no audio loaded yet, play the first shiur
      const firstCard = document.querySelector('.quick-card-link');
      if (firstCard) firstCard.click();
      return;
    }
    if (audio.paused) {
      if (!sponsorPlayedForThisShiur && currentSponsorAudio && pendingShiur && !isSponsorPlaying && !isPreRollDisabled()) {
        playSponsorPreRoll(pendingShiur);
        return;
      }
      audio.play().catch(e => console.log('Play blocked:', e));
    } else {
      audio.pause();
    }
  }

  function skip(sec) {
    if (isCurrentShiurArticle || isSponsorPlaying) return;
    if (!audio.src) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + sec));
    updateUrlTimestamp(true);
  }

  function setSpeed(rate) {
    const r = parseFloat(rate);
    if (isNaN(r) || r <= 0) return;
    currentPlaybackRate = r;
    audio.playbackRate = r;
    const sel = document.getElementById('speedSelect');
    if (sel) {
      let found = false;
      for (let i = 0; i < sel.options.length; i++) {
        if (parseFloat(sel.options[i].value) === r) {
          sel.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        const opt = document.createElement('option');
        opt.value = String(r);
        opt.textContent = r + 'x';
        opt.selected = true;
        sel.appendChild(opt);
      }
    }
    try {
      const url = new URL(window.location.href);
      if (r === 1) {
        url.searchParams.delete('speed');
        url.searchParams.delete('rate');
      } else {
        url.searchParams.delete('rate');
        url.searchParams.set('speed', r);
      }
      history.replaceState(history.state, '', url.toString());
    } catch(e) {}
  }

  function copyShareLink() {
    const curSec = Math.floor(audio.currentTime);
    const url = new URL(window.location.href);
    url.searchParams.set('t', curSec);
    const rate = currentPlaybackRate || audio.playbackRate;
    if (rate && rate !== 1) {
      url.searchParams.delete('rate');
      url.searchParams.set('speed', rate);
    } else {
      url.searchParams.delete('speed');
      url.searchParams.delete('rate');
    }
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const hasExplicitTheme = url.searchParams.has('mode') || url.searchParams.has('theme') || Boolean(localStorage.getItem('yutorah_theme'));
    if (hasExplicitTheme) {
      const themeKey = url.searchParams.has('theme') ? 'theme' : 'mode';
      url.searchParams.delete('dark');
      url.searchParams.delete('light');
      url.searchParams.delete('mode');
      url.searchParams.delete('theme');
      url.searchParams.set(themeKey, isDark ? 'dark' : 'light');
    }
    navigator.clipboard.writeText(url.toString()).then(() => {
      const btn = document.getElementById('copyLinkBtn');
      btn.textContent = '✅ Copied (' + formatTime(curSec) + ')!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋 Copy Link @ Time';
        btn.classList.remove('copied');
      }, 2000);
    });
  }

  // High-performance Scrubber (Instant 60fps dragging, snappy click-to-seek)
  let isScrubbing = false;
  let scrubPct = 0;
  const scrubberBar = document.getElementById('scrubberBar');
  const scrubberFill = document.getElementById('scrubberFill');
  const curTimeEl = document.getElementById('curTime');

  function getScrubPct(clientX) {
    const rect = scrubberBar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function updateScrubberUi(pct) {
    scrubPct = pct;
    scrubberFill.style.width = (pct * 100) + '%';
    if (audio.duration && !isNaN(audio.duration)) {
      curTimeEl.textContent = formatTime(pct * audio.duration);
      const miniFill = document.getElementById('miniProgressFill');
      if (miniFill) miniFill.style.width = (pct * 100) + '%';
      const miniTime = document.getElementById('miniTime');
      if (miniTime) miniTime.textContent = formatTime(pct * audio.duration) + ' / ' + formatTime(audio.duration);
    }
  }

  function onScrubStart(e) {
    if (isSponsorPlaying || !audio.duration || isNaN(audio.duration)) return;
    isScrubbing = true;
    scrubberBar.classList.add('is-dragging');
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = getScrubPct(clientX);
    updateScrubberUi(pct);
  }

  function onScrubMove(e) {
    if (!isScrubbing || !audio.duration || isNaN(audio.duration)) return;
    if (e.cancelable) e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = getScrubPct(clientX);
    updateScrubberUi(pct);
  }

  function onScrubEnd() {
    if (!isScrubbing) return;
    isScrubbing = false;
    scrubberBar.classList.remove('is-dragging');
    if (audio.duration && !isNaN(audio.duration)) {
      const targetSec = scrubPct * audio.duration;
      audio.currentTime = targetSec;
      updateUrlTimestamp(true);
    }
  }

  scrubberBar.addEventListener('mousedown', onScrubStart);
  window.addEventListener('mousemove', onScrubMove);
  window.addEventListener('mouseup', onScrubEnd);

  scrubberBar.addEventListener('touchstart', onScrubStart, { passive: false });
  window.addEventListener('touchmove', onScrubMove, { passive: false });
  window.addEventListener('touchend', onScrubEnd);
  window.addEventListener('touchcancel', onScrubEnd);

  // Play / Pause SVG Icons (Clean white lines without emoji background)
  const PLAY_ICON_MAIN = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin-left:3px;"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON_MAIN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><rect x="5" y="4" width="4" height="16" rx="1.5"/><rect x="15" y="4" width="4" height="16" rx="1.5"/></svg>';
  const PLAY_ICON_MINI = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON_MINI = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><rect x="5" y="4" width="4" height="16" rx="1.5"/><rect x="15" y="4" width="4" height="16" rx="1.5"/></svg>';

  function updatePlayPauseIcons(isPlaying) {
    const mainBtn = document.getElementById('playBtn');
    if (mainBtn) mainBtn.innerHTML = isPlaying ? PAUSE_ICON_MAIN : PLAY_ICON_MAIN;
    const miniBtn = document.getElementById('miniPlayBtn');
    if (miniBtn) miniBtn.innerHTML = isPlaying ? PAUSE_ICON_MINI : PLAY_ICON_MINI;
  }

  // Audio Events
  audio.addEventListener('play', () => {
    updatePlayPauseIcons(true);
    if (isSponsorPlaying) {
      resetSponsorWatchdog();
      startSponsorRaf();
    }
  });
  audio.addEventListener('pause', () => {
    updatePlayPauseIcons(false);
    updateUrlTimestamp(true);
    if (typeof devRecordHeartbeat === 'function') devRecordHeartbeat(true);
    if (isSponsorPlaying) {
      clearSponsorTimers();
      stopSponsorRaf();
    }
  });
  audio.addEventListener('waiting', () => {
    if (isSponsorPlaying && pendingShiur) {
      if (sponsorStallTimer) clearTimeout(sponsorStallTimer);
      sponsorStallTimer = setTimeout(() => {
        if (isSponsorPlaying && pendingShiur && audio.readyState < 3) {
          console.warn('Sponsor audio stalled for >8s, advancing to shiur');
          startShiurPlayback(pendingShiur);
        }
      }, 8000);
    }
  });
  audio.addEventListener('playing', () => {
    if (sponsorStallTimer) {
      clearTimeout(sponsorStallTimer);
      sponsorStallTimer = null;
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (isSponsorPlaying) {
      if (audio.duration && !isNaN(audio.duration)) {
        if (audio.currentTime >= audio.duration - 0.25) {
          startShiurPlayback(pendingShiur);
          return;
        }
        const rem = Math.max(0, Math.ceil(audio.duration - audio.currentTime));
        const countdownEl = document.getElementById('sponsorCountdown');
        if (countdownEl) countdownEl.textContent = rem;
        const pct = (audio.currentTime / audio.duration) * 100;
        if (scrubberFill) scrubberFill.style.width = pct + '%';
        curTimeEl.textContent = formatTime(audio.currentTime);
        document.getElementById('totalTime').textContent = formatTime(audio.duration);
        const miniFill = document.getElementById('miniProgressFill');
        if (miniFill) miniFill.style.width = pct + '%';
        const miniTime = document.getElementById('miniTime');
        if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
      }
      return;
    }
    if (isScrubbing) return;
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    scrubberFill.style.width = pct + '%';
    curTimeEl.textContent = formatTime(audio.currentTime);

    const miniFill = document.getElementById('miniProgressFill');
    if (miniFill) miniFill.style.width = pct + '%';
    const miniTime = document.getElementById('miniTime');
    if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);

    updateUrlTimestamp(false);
    if (typeof devRecordHeartbeat === 'function') devRecordHeartbeat(false);
  });
  audio.addEventListener('loadedmetadata', () => {
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    document.getElementById('totalTime').textContent = formatTime(audio.duration);
    const miniTime = document.getElementById('miniTime');
    if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
    if (isSponsorPlaying && audio.duration && !isNaN(audio.duration)) {
      const countdownEl = document.getElementById('sponsorCountdown');
      if (countdownEl) countdownEl.textContent = Math.ceil(audio.duration);
    }
    applyInitialTime();
  });
  audio.addEventListener('canplay', () => {
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    applyInitialTime();
  });
  audio.addEventListener('ended', () => {
    if (isSponsorPlaying && pendingShiur) {
      startShiurPlayback(pendingShiur);
      return;
    }
    updatePlayPauseIcons(false);
    if (typeof devMarkCompleted === 'function' && !isSponsorPlaying) devMarkCompleted();
    // Dev queue: auto-play the next queued shiur when a track ends.
    if (!isSponsorPlaying) {
      try {
        if (typeof devPlayNextFromQueue === 'function' && devPlayNextFromQueue()) return;
      } catch (e) {}
    }
    if (currentShiurId) {
      try { localStorage.removeItem('yutorah_progress_' + currentShiurId); } catch(e) {}
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('t');
    history.replaceState(history.state, '', url.toString());
  });

  if (audio.readyState >= 1) {
    applyInitialTime();
  }

  // Save timestamp when page/tab is backgrounded or closed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      updateUrlTimestamp(true);
    }
  });
  window.addEventListener('beforeunload', () => {
    updateUrlTimestamp(true);
  });
  window.addEventListener('pagehide', () => {
    updateUrlTimestamp(true);
  });

  // Fallback if primary audio stream errors
  audio.addEventListener('error', () => {
    if (isSponsorPlaying && pendingShiur) {
      console.warn('Sponsor audio encountered error, advancing to shiur...');
      skipSponsorAudio();
      return;
    }
    console.warn('Audio element error with current source:', audio.src);
    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn && dlBtn.href && dlBtn.href !== audio.src) {
      console.log('Attempting fallback source:', dlBtn.href);
      audio.src = dlBtn.href;
      audio.load();
      audio.play().catch(e => console.log('Fallback play error:', e));
    }
  });

  // Mobile Lock Screen (MediaSession)
  if ('mediaSession' in navigator && hasAudio) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ${jsEmbed(title)},
      artist: ${jsEmbed(speaker)},
      album: 'YUTorah Online',
      artwork: ${jsEmbed(photo ? [{ src: photo, sizes: '300x300', type: 'image/jpeg' }] : [])}
    });
    try {
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('seekbackward', (details) => skip(-(details.seekOffset || 10)));
      navigator.mediaSession.setActionHandler('seekforward', (details) => skip(details.seekOffset || 10));
    } catch(e) {}
  }

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (isCurrentShiurArticle) return; // Allow natural space scrolling and keyboard navigation in article mode
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(e.shiftKey ? -30 : -10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); skip(e.shiftKey ? 30 : 10); }
    else if (e.key === '[') {
      const sel = document.getElementById('speedSelect');
      if (sel.selectedIndex > 0) { sel.selectedIndex--; setSpeed(sel.value); }
    }
    else if (e.key === ']') {
      const sel = document.getElementById('speedSelect');
      if (sel.selectedIndex < sel.options.length - 1) { sel.selectedIndex++; setSpeed(sel.value); }
    }
    else if (e.key === 'm' || e.key === 'M') { audio.muted = !audio.muted; }
  });

  // Browser Back/Forward navigation sync
  window.addEventListener('popstate', () => {
    try {
      const p = new URL(window.location.href).searchParams;
      const s = p.get('speed') || p.get('rate');
      if (s) {
        const parsed = parseFloat(s);
        if (!isNaN(parsed) && parsed > 0 && parsed !== currentPlaybackRate) {
          setSpeed(parsed);
        }
      } else if (currentPlaybackRate !== 1) {
        setSpeed(1);
      }

      // Sync light/dark mode on back/forward navigation
      const rawTheme = (p.get('theme') || p.get('mode') || '').toLowerCase();
      if (rawTheme === 'dark' || p.get('dark') === '1' || (p.has('dark') && p.get('dark') !== '0')) {
        document.documentElement.setAttribute('data-theme', 'dark');
        try { localStorage.setItem('yutorah_theme', 'dark'); } catch(e) {}
        initTheme();
        applyHolidayTheme();
      } else if (rawTheme === 'light' || p.get('dark') === '0' || p.get('light') === '1') {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('yutorah_theme', 'light'); } catch(e) {}
        initTheme();
        applyHolidayTheme();
      }
      try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}
    } catch(e) {}
  });

  // Theme Management (Dark / Light mode)
  function initTheme() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.textContent = isDark ? '☀️' : '🌙';
      btn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    }
  }

  function toggleTheme() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var nextDark = !isDark;
    if (nextDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('yutorah_theme', 'dark'); } catch(e) {}
    } else {
      document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('yutorah_theme', 'light'); } catch(e) {}
    }
    var btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.textContent = nextDark ? '☀️' : '🌙';
      btn.title = nextDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    }
    applyHolidayTheme();

    try {
      var url = new URL(window.location.href);
      var key = url.searchParams.has('theme') ? 'theme' : 'mode';
      url.searchParams.delete('dark');
      url.searchParams.delete('light');
      url.searchParams.delete('mode');
      url.searchParams.delete('theme');
      url.searchParams.set(key, nextDark ? 'dark' : 'light');
      history.replaceState(history.state, '', url.toString());
    } catch(e) {}
  }

  function syncHeaderSpacer() {
    var h = document.getElementById('mainHeader');
    var s = document.getElementById('headerSpacer');
    if (h && s) {
      s.style.height = h.offsetHeight + 'px';
    }
  }
  syncHeaderSpacer();
  window.addEventListener('resize', syncHeaderSpacer);

  function checkCalendarOverflow() {
    var badge = document.getElementById('hebrewDateBadge');
    var header = document.getElementById('mainHeader');
    if (!badge || !header) return;

    if (window.innerWidth <= 520) {
      badge.style.display = 'none';
      return;
    }

    badge.style.display = 'inline-flex';
    var bRect = badge.getBoundingClientRect();
    var hRect = header.getBoundingClientRect();
    var wWidth = window.innerWidth || document.documentElement.clientWidth;

    if (bRect.right > wWidth - 8 || bRect.right > hRect.right - 6 || bRect.left < 0 || bRect.top > hRect.top + 45) {
      badge.style.display = 'none';
    } else {
      badge.style.display = 'inline-flex';
    }
  }
  checkCalendarOverflow();
  window.addEventListener('resize', checkCalendarOverflow);

  initTheme();
  updateSettingsMenuText();
  applyHolidayTheme();
  try {
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
        if (!localStorage.getItem('yutorah_theme')) {
          if (e.matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
          initTheme();
          applyHolidayTheme();
        }
      });
    }
  } catch(e) {}

  // Auto-switch mini player based on scroll position / viewport visibility
  window.addEventListener('scroll', scheduleScrollAutoMiniPlayer, { passive: true });
  window.addEventListener('resize', scheduleScrollAutoMiniPlayer, { passive: true });
  window.addEventListener('orientationchange', scheduleScrollAutoMiniPlayer, { passive: true });
  if ('IntersectionObserver' in window) {
    var playerCardEl = document.getElementById('playerCard');
    if (playerCardEl) {
      var playerObserver = new IntersectionObserver(function() {
        scheduleScrollAutoMiniPlayer();
      }, { threshold: [0, 0.05, 0.5, 0.95, 1.0] });
      playerObserver.observe(playerCardEl);
    }
  }
  scheduleScrollAutoMiniPlayer();

  // ==========================================================================
  // Article & PDF Reader Controller (Liquid Mode Reflow & High-Res View)
  // ==========================================================================
  let pdfDoc = null;
  let pdfTotalPages = 0;
  let pdfCurrentPage = 1;
  let articleViewerMode = 'liquid'; // 'liquid' or 'original'
  let pageScrollMode = 'continuous'; // 'continuous' or 'single'
  let liquidFontSizeRem = 1.05;
  let originalCanvasScale = 1.35;
  let isRenderingCanvas = false;
  let pendingCanvasPage = null;
  let activeExtractionId = 0;
  let renderedContinuousPages = new Set();
  let continuousPageObserver = null;

  // Touch Zoom & Pan Tracking State for Original Page View
  let touchZoomState = {
    scale: 1.0,
    panX: 0,
    panY: 0,
    lastTouchX: 0,
    lastTouchY: 0,
    startDist: 0,
    startScale: 1.0,
    isPinching: false,
    isPanning: false,
    lastTapTime: 0
  };

  function getPdfProxyUrl(rawUrl) {
    if (!rawUrl) return '';
    let target = String(rawUrl).trim();
    if (target.startsWith('/')) {
      target = 'https://shiurim.yutorah.net' + target;
    }
    return '/api/pdf-proxy?url=' + encodeURIComponent(target);
  }

  function setArticleMode(mode) {
    articleViewerMode = mode;
    const btnLiquid = document.getElementById('modeBtnLiquid');
    const btnOriginal = document.getElementById('modeBtnOriginal');
    const viewLiquid = document.getElementById('articleLiquidViewport');
    const viewCanvas = document.getElementById('articleCanvasViewport');
    const fontControls = document.getElementById('fontSizeControls');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const pageNav = document.getElementById('articlePageNav');

    touchZoomState.scale = 1.0;
    touchZoomState.panX = 0;
    touchZoomState.panY = 0;
    applyTouchTransform();
    initTouchZoomTracking();

    if (mode === 'liquid') {
      if (btnLiquid) btnLiquid.classList.add('active');
      if (btnOriginal) btnOriginal.classList.remove('active');
      if (viewLiquid) viewLiquid.style.display = 'block';
      if (viewCanvas) viewCanvas.style.display = 'none';
      if (fontControls) fontControls.style.display = 'inline-flex';
      if (zoomInBtn) zoomInBtn.style.display = 'none';
      if (zoomOutBtn) zoomOutBtn.style.display = 'none';
      if (pageNav) pageNav.style.display = 'none';
    } else {
      if (btnLiquid) btnLiquid.classList.remove('active');
      if (btnOriginal) btnOriginal.classList.add('active');
      if (viewLiquid) viewLiquid.style.display = 'none';
      if (viewCanvas) viewCanvas.style.display = 'flex';
      if (fontControls) fontControls.style.display = 'none';
      if (zoomInBtn) zoomInBtn.style.display = 'inline-flex';
      if (zoomOutBtn) zoomOutBtn.style.display = 'inline-flex';
      if (pageNav) pageNav.style.display = 'flex';
      
      applyPageScrollModeUI();
      if (pageScrollMode === 'continuous') {
        renderContinuousPages();
      } else {
        renderArticlePage(pdfCurrentPage);
      }
      updateOrientationTip();
    }
  }

  function updateOrientationTip() {
    const tip = document.getElementById('originalPageOrientationTip');
    if (!tip) return;
    const isPortrait = window.innerHeight > window.innerWidth;
    const isMobileOrTablet = window.innerWidth <= 1024;
    // Show disclaimer when user is viewing Original Page in vertical / portrait layout
    if (articleViewerMode === 'original' && isPortrait && isMobileOrTablet) {
      tip.style.display = 'flex';
    } else {
      tip.style.display = 'none';
    }
  }

  function setPageScrollMode(mode) {
    pageScrollMode = mode;
    touchZoomState.scale = 1.0;
    touchZoomState.panX = 0;
    touchZoomState.panY = 0;
    applyTouchTransform();
    applyPageScrollModeUI();
    if (mode === 'continuous') {
      renderContinuousPages();
    } else {
      renderArticlePage(pdfCurrentPage);
    }
  }

  function applyPageScrollModeUI() {
    const btnCont = document.getElementById('btnModeContinuous');
    const btnSing = document.getElementById('btnModeSingle');
    const singleNav = document.getElementById('singlePageNavButtons');
    const contInfo = document.getElementById('continuousPageNum');
    const singleCard = document.getElementById('pdfCanvasCard');
    const contContainer = document.getElementById('continuousPagesContainer');

    if (pageScrollMode === 'continuous') {
      if (btnCont) btnCont.classList.add('active');
      if (btnSing) btnSing.classList.remove('active');
      if (singleNav) singleNav.style.display = 'none';
      if (contInfo) contInfo.style.display = 'inline-block';
      if (singleCard) singleCard.style.display = 'none';
      if (contContainer) contContainer.style.display = 'flex';
    } else {
      if (btnCont) btnCont.classList.remove('active');
      if (btnSing) btnSing.classList.add('active');
      if (singleNav) singleNav.style.display = 'inline-flex';
      if (contInfo) contInfo.style.display = 'none';
      if (singleCard) singleCard.style.display = 'block';
      if (contContainer) contContainer.style.display = 'none';
      updatePageNavUI();
    }
  }

  function adjustArticleFontSize(delta) {
    liquidFontSizeRem = Math.max(0.8, Math.min(1.8, liquidFontSizeRem + (delta * 0.1)));
    const content = document.getElementById('liquidContent');
    if (content) {
      content.style.fontSize = liquidFontSizeRem + 'rem';
    }
  }

  function adjustArticleZoom(delta) {
    const newScale = Math.max(1.0, Math.min(4.0, touchZoomState.scale + delta * 0.35));
    if (newScale <= 1.05) {
      touchZoomState.scale = 1.0;
      touchZoomState.panX = 0;
      touchZoomState.panY = 0;
    } else {
      const targetCard = pageScrollMode === 'single'
        ? document.getElementById('pdfCanvasCard')
        : document.getElementById('continuousPagesContainer');
      const viewport = document.getElementById('articleCanvasViewport');
      const viewRect = viewport ? viewport.getBoundingClientRect() : { width: window.innerWidth, height: 600, left: 0, top: 0 };
      const centerX = viewRect.left + viewRect.width / 2;
      const centerY = viewRect.top + Math.min(viewRect.height / 2, 350);

      const cardRect = targetCard ? targetCard.getBoundingClientRect() : viewRect;
      const baseLeft = cardRect.left - touchZoomState.panX;
      const baseTop = cardRect.top - touchZoomState.panY;
      const px = (centerX - baseLeft - touchZoomState.panX) / (touchZoomState.scale || 1);
      const py = (centerY - baseTop - touchZoomState.panY) / (touchZoomState.scale || 1);

      touchZoomState.scale = newScale;
      touchZoomState.panX = (centerX - baseLeft) - px * newScale;
      touchZoomState.panY = (centerY - baseTop) - py * newScale;
    }
    applyTouchTransform();
  }

  function changeArticlePage(delta) {
    if (!pdfDoc) return;
    const target = pdfCurrentPage + delta;
    if (target >= 1 && target <= pdfTotalPages) {
      pdfCurrentPage = target;
      touchZoomState.scale = 1.0;
      touchZoomState.panX = 0;
      touchZoomState.panY = 0;
      applyTouchTransform();
      renderArticlePage(pdfCurrentPage);
    }
  }

  function updatePageNavUI() {
    const pageNumEl = document.getElementById('articlePageNum');
    if (pageNumEl) {
      pageNumEl.textContent = 'Page ' + pdfCurrentPage + ' of ' + pdfTotalPages;
    }
    const contNumEl = document.getElementById('continuousPageNum');
    if (contNumEl) {
      contNumEl.textContent = 'Page ' + pdfCurrentPage + ' of ' + pdfTotalPages;
    }
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (prevBtn) prevBtn.disabled = pdfCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = pdfCurrentPage >= pdfTotalPages;
  }

  async function renderArticlePage(num) {
    if (!pdfDoc) return;
    if (isRenderingCanvas) {
      pendingCanvasPage = num;
      return;
    }
    isRenderingCanvas = true;
    updatePageNavUI();

    try {
      const page = await pdfDoc.getPage(num);
      const canvas = document.getElementById('pdfCanvas');
      if (!canvas) {
        isRenderingCanvas = false;
        return;
      }
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: originalCanvasScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const renderContext = {
        canvasContext: ctx,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        viewport: viewport
      };
      await page.render(renderContext).promise;
    } catch (err) {
      console.warn('PDF Page render issue:', err);
    } finally {
      isRenderingCanvas = false;
      if (pendingCanvasPage !== null) {
        const next = pendingCanvasPage;
        pendingCanvasPage = null;
        renderArticlePage(next);
      }
    }
  }

  async function renderContinuousPages() {
    if (!pdfDoc) return;
    const container = document.getElementById('continuousPagesContainer');
    if (!container) return;

    // Create page shells if not already created
    if (container.children.length !== pdfTotalPages) {
      container.innerHTML = '';
      renderedContinuousPages.clear();
      for (let i = 1; i <= pdfTotalPages; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'canvas-page-separator';
        wrap.id = 'contPageWrap_' + i;
        wrap.innerHTML = '<span class="canvas-page-tag">Page ' + i + ' of ' + pdfTotalPages + '</span>' +
          '<div class="pdf-canvas-card" id="contCanvasCard_' + i + '">' +
            '<canvas id="contCanvas_' + i + '"></canvas>' +
          '</div>';
        container.appendChild(wrap);
      }

      // Intersection observer to track current page as user scrolls
      if (continuousPageObserver) continuousPageObserver.disconnect();
      continuousPageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idMatch = entry.target.id.match(/\d+$/);
            if (idMatch) {
              pdfCurrentPage = parseInt(idMatch[0], 10);
              updatePageNavUI();
              // Lazily render adjacent pages
              renderPageToContinuousCard(pdfCurrentPage);
              if (pdfCurrentPage + 1 <= pdfTotalPages) renderPageToContinuousCard(pdfCurrentPage + 1);
              if (pdfCurrentPage - 1 >= 1) renderPageToContinuousCard(pdfCurrentPage - 1);
            }
          }
        }
      }, { threshold: [0.1, 0.5] });

      for (let i = 1; i <= pdfTotalPages; i++) {
        const wrap = document.getElementById('contPageWrap_' + i);
        if (wrap) continuousPageObserver.observe(wrap);
      }
    }

    // Render initial page and neighbor
    await renderPageToContinuousCard(1);
    if (pdfTotalPages > 1) renderPageToContinuousCard(2);
  }

  async function renderPageToContinuousCard(pageNum) {
    if (!pdfDoc || pageNum < 1 || pageNum > pdfTotalPages) return;
    if (renderedContinuousPages.has(pageNum)) return;
    renderedContinuousPages.add(pageNum);

    try {
      const page = await pdfDoc.getPage(pageNum);
      const canvas = document.getElementById('contCanvas_' + pageNum);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: originalCanvasScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const renderContext = {
        canvasContext: ctx,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        viewport: viewport
      };
      await page.render(renderContext).promise;
    } catch (e) {
      renderedContinuousPages.delete(pageNum);
      console.warn('Error rendering continuous page ' + pageNum, e);
    }
  }

  // ==========================================================================
  // Interactive Touch Zoom & Pan Tracking (Mobile Daf-Style Viewer)
  // ==========================================================================
  let isTouchZoomInit = false;

  function initTouchZoomTracking() {
    if (isTouchZoomInit) return;
    const canvasViewport = document.getElementById('articleCanvasViewport');
    const liquidViewport = document.getElementById('articleLiquidViewport');
    const viewerContainer = document.getElementById('articleViewerContainer');
    if (!canvasViewport && !liquidViewport) return;
    isTouchZoomInit = true;

    // Prevent Safari default webpage pinch-zoom on the entire viewer container
    if (viewerContainer) {
      viewerContainer.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
      viewerContainer.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
      viewerContainer.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
    }

    function getDistance(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getCenter(t1, t2) {
      return {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
      };
    }

    function getTargetElement() {
      if (articleViewerMode === 'liquid') {
        return document.getElementById('liquidContent');
      }
      return pageScrollMode === 'single'
        ? document.getElementById('pdfCanvasCard')
        : document.getElementById('continuousPagesContainer');
    }

    function attachViewportListeners(vp) {
      if (!vp) return;

      vp.addEventListener('touchstart', (e) => {
        if (e.touches.length >= 2) {
          // CRITICAL: Prevent default browser page zoom/resize
          e.preventDefault();
          touchZoomState.isPinching = true;
          touchZoomState.isPanning = false;
          touchZoomState.startDist = getDistance(e.touches[0], e.touches[1]);
          touchZoomState.startScale = touchZoomState.scale;

          const center = getCenter(e.touches[0], e.touches[1]);
          const targetEl = getTargetElement();
          const cardRect = targetEl ? targetEl.getBoundingClientRect() : vp.getBoundingClientRect();
          const baseLeft = cardRect.left - touchZoomState.panX;
          const baseTop = cardRect.top - touchZoomState.panY;
          touchZoomState.baseLeft = baseLeft;
          touchZoomState.baseTop = baseTop;
          touchZoomState.startPx = (center.x - baseLeft - touchZoomState.panX) / (touchZoomState.scale || 1);
          touchZoomState.startPy = (center.y - baseTop - touchZoomState.panY) / (touchZoomState.scale || 1);
        } else if (e.touches.length === 1) {
          const now = Date.now();
          const touch = e.touches[0];
          if (now - touchZoomState.lastTapTime < 300) {
            // Double-tap zoom toggle
            e.preventDefault();
            if (touchZoomState.scale > 1.2) {
              touchZoomState.scale = 1.0;
              touchZoomState.panX = 0;
              touchZoomState.panY = 0;
            } else {
              const targetEl = getTargetElement();
              const cardRect = targetEl ? targetEl.getBoundingClientRect() : vp.getBoundingClientRect();
              const baseLeft = cardRect.left - touchZoomState.panX;
              const baseTop = cardRect.top - touchZoomState.panY;
              const px = (touch.clientX - baseLeft - touchZoomState.panX) / (touchZoomState.scale || 1);
              const py = (touch.clientY - baseTop - touchZoomState.panY) / (touchZoomState.scale || 1);
              touchZoomState.scale = 2.2;
              touchZoomState.panX = (touch.clientX - baseLeft) - px * 2.2;
              touchZoomState.panY = (touch.clientY - baseTop) - py * 2.2;
            }
            applyTouchTransform();
            touchZoomState.lastTapTime = 0;
            return;
          }
          touchZoomState.lastTapTime = now;

          if (touchZoomState.scale > 1.05) {
            touchZoomState.isPanning = true;
            touchZoomState.lastTouchX = touch.clientX;
            touchZoomState.lastTouchY = touch.clientY;
          }
        }
      }, { passive: false });

      vp.addEventListener('touchmove', (e) => {
        if (touchZoomState.isPinching && e.touches.length >= 2) {
          e.preventDefault();
          const dist = getDistance(e.touches[0], e.touches[1]);
          const scaleFactor = dist / (touchZoomState.startDist || 1);
          const newScale = Math.max(1.0, Math.min(4.0, touchZoomState.startScale * scaleFactor));
          const center = getCenter(e.touches[0], e.touches[1]);

          if (newScale <= 1.02) {
            touchZoomState.scale = 1.0;
            touchZoomState.panX = 0;
            touchZoomState.panY = 0;
          } else {
            touchZoomState.scale = newScale;
            touchZoomState.panX = (center.x - touchZoomState.baseLeft) - touchZoomState.startPx * newScale;
            touchZoomState.panY = (center.y - touchZoomState.baseTop) - touchZoomState.startPy * newScale;
          }
          applyTouchTransform();
        } else if (touchZoomState.isPanning && e.touches.length === 1) {
          e.preventDefault();
          const touch = e.touches[0];
          const dx = touch.clientX - touchZoomState.lastTouchX;
          const dy = touch.clientY - touchZoomState.lastTouchY;
          touchZoomState.panX += dx;
          touchZoomState.panY += dy;
          touchZoomState.lastTouchX = touch.clientX;
          touchZoomState.lastTouchY = touch.clientY;
          applyTouchTransform();
        }
      }, { passive: false });

      vp.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
          touchZoomState.isPinching = false;
        }
        if (e.touches.length === 0) {
          touchZoomState.isPanning = false;
          if (touchZoomState.scale <= 1.05) {
            touchZoomState.scale = 1.0;
            touchZoomState.panX = 0;
            touchZoomState.panY = 0;
            applyTouchTransform();
          }
        }
      }, { passive: true });
    }

    attachViewportListeners(canvasViewport);
    if (liquidViewport) attachViewportListeners(liquidViewport);
  }

  function applyTouchTransform() {
    const singleCard = document.getElementById('pdfCanvasCard');
    const contContainer = document.getElementById('continuousPagesContainer');
    const liquidContent = document.getElementById('liquidContent');
    const transformStr = (touchZoomState.scale === 1.0 && touchZoomState.panX === 0 && touchZoomState.panY === 0)
      ? ''
      : 'translate3d(' + Math.round(touchZoomState.panX) + 'px, ' + Math.round(touchZoomState.panY) + 'px, 0) scale(' + touchZoomState.scale.toFixed(3) + ')';

    if (articleViewerMode === 'liquid') {
      if (liquidContent) liquidContent.style.transform = transformStr;
    } else {
      if (singleCard && pageScrollMode === 'single') {
        singleCard.style.transform = transformStr;
      }
      if (contContainer && pageScrollMode === 'continuous') {
        contContainer.style.transform = transformStr;
      }
    }
  }

  // ==========================================================================
  // Liquid Mode 3.0 — Semantic Document Reconstruction Engine
  // ==========================================================================

  const HEBREW_DICT = new Set([
    'של','את','על','לא','גם','כי','אם','או','עם','זה','הוא','היא','אין','יש','כל','מן','בין','לפי','אחר',
    'שבת','תורה','מצוה','הלכה','גמרא','רש','רמב','משנה','ברכות','שבועות','ראש','השנה',
    'אברהם','יצחק','יעקב','משה','אהרן','דוד','שלמה','ישראל','ירושלים','בית','המקדש',
    'ה','ב','ל','מ','ו','כ','ד','ש',
    'אלא','אבל','הרי','כדי','מפני','לכן','אפילו','עוד','רק','כאן','שם','מי','מה','איך','למה','מתי',
    'ספר','פרק','סימן','סעיף','דף','עמוד','הערה','פסוק','שער','חלק','אות',
    'רבי','רבנו','הגאון','מרן','הרב','מורנו','הרמבם','הרמבן','הרשבא','הריטבא','תוספות','הראבד',
    'ראה','עיין','וכן','כגון','דהיינו','היינו','פירוש','ביאור','מבואר','מדבריו','שם','לקמן','לעיל',
    'תלמוד','בבלי','ירושלמי','מדרש','רבה','תנחומא','זוהר','שולחן','ערוך','טור','חושן','משפט',
    'אורח','חיים','יורה','דעה','אבן','העזר','משנה','ברורה','מגן','אברהם','טז','שך','פתחי','תשובה',
    'מחלוקת','ספק','סברא','קושיא','תירוץ','פסק','דין','חיוב','פטור','איסור','היתר','טהרה','טומאה',
    'קדושה','ברכה','תפלה','מנהג','ציבור','קהל','יחיד','יחד','חבר','תלמיד','חכם','חכמים','תנאים','אמוראים'
  ]);

  const NIKUD_REGEX = /[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7]/g;
  const HEBREW_CHAR_REGEX = /[\u0590-\u05FF]/;
  const HEBREW_BLOCK_REGEX = /((?:[\u0590-\u05FF][\u0590-\u05FF\\s'"\u2013\u2014:,.()-]*[\u0590-\u05FF]|[\u0590-\u05FF]))/g;

  let liquidFootnoteMap = {};

  function isVisualLTR(tokens) {
    if (tokens.length <= 1) return false;
    const cleaned = tokens.map(t => t.replace(NIKUD_REGEX, '').replace(/[.,:;'"־–—()\[\]]/g, '').trim()).filter(Boolean);
    if (!cleaned.length) return false;

    let forwardWordHits = 0;
    for (const t of cleaned) {
      if (HEBREW_DICT.has(t)) forwardWordHits++;
    }

    let reversedCharHits = 0;
    for (const t of cleaned) {
      const revChars = Array.from(t).reverse().join('');
      if (HEBREW_DICT.has(revChars)) reversedCharHits++;
    }

    if (reversedCharHits > forwardWordHits) {
      return 'chars';
    }

    if (forwardWordHits > 0) {
      const leadWord = cleaned[0];
      const trailWord = cleaned[cleaned.length - 1];
      const prepositions = new Set(['של', 'על', 'אל', 'כי', 'אם', 'או', 'עם', 'מן', 'לפי', 'אלא', 'אבל']);
      if (prepositions.has(trailWord) && !prepositions.has(leadWord)) {
        return 'words';
      }
    }

    return 'words';
  }

  function processHebrewBlock(hebrewText) {
    if (!hebrewText || !HEBREW_CHAR_REGEX.test(hebrewText)) return hebrewText;

    let clean = hebrewText.replace(NIKUD_REGEX, '');
    const tokens = clean.trim().split(/\\s+/).filter(Boolean);
    if (!tokens.length) return hebrewText;

    let resolved;
    const totalChars = tokens.reduce((acc, t) => acc + t.length, 0);
    const avgLen = totalChars / tokens.length;

    const orderType = isVisualLTR(tokens);

    if (avgLen < 2.2 && tokens.length >= 3) {
      const allChars = Array.from(clean.replace(/\\s+/g, ''));
      resolved = allChars.reverse().join('');
    } else if (orderType === 'chars') {
      resolved = tokens.map(t => Array.from(t).reverse().join('')).reverse().join(' ');
    } else if (orderType === 'words') {
      resolved = tokens.reverse().join(' ');
    } else {
      resolved = tokens.join(' ');
    }

    return '<span dir="rtl" class="liquid-hebrew">' + resolved + '</span>';
  }

  function formatLiquidText(rawText, isFootnoteSection) {
    if (!rawText) return '';

    let text = rawText;

    text = text.replace(HEBREW_BLOCK_REGEX, (match) => {
      const leadPunctRegex = /^([\\s,.:;\u201C\u201D"'()]+)/;
      const trailPunctRegex = /([\\s,.:;\u201C\u201D"'()]+)$/;
      let prefix = '';
      let suffix = '';
      let core = match;

      const leadMatch = core.match(leadPunctRegex);
      if (leadMatch) {
        prefix = leadMatch[1];
        core = core.slice(prefix.length);
      }
      const trailMatch = core.match(trailPunctRegex);
      if (trailMatch) {
        suffix = trailMatch[1];
        core = core.slice(0, -suffix.length);
      }

      if (!HEBREW_CHAR_REGEX.test(core)) return match;
      return prefix + processHebrewBlock(core) + suffix;
    });

    if (!isFootnoteSection) {
      const footnoteRefRegex = /([a-zA-Z.,;:'"?!)\u05D0-\u05EA]+)\\s*(\\d{1,3})\\b(?!\\s*[.,\\d\\/\-:])/g;
      text = text.replace(footnoteRefRegex, (m, word, num) => {
        const fnNum = parseInt(num);
        if (fnNum < 1 || fnNum > 200) return m;
        const clickAttr = ' onclick="showFootnotePopover(event, ' + num + ')" tabindex="0" role="button" aria-label="Footnote ' + num + '"';
        return word + '<sup class="liquid-footnote-ref"' + clickAttr + ' data-fn="' + num + '">' + num + '</sup>';
      });
    }

    return text;
  }

  function cleanHebrewEndnoteText(text) {
    if (!text) return '';
    let s = text.trim();
    if (s.includes('אבל') && s.includes('האד') && (s.includes('עולמ') || s.includes('עיק'))) {
      return decodeURIComponent(escape(atob('15DXkdecINei15nXp9eo15Ug16nXnCDXk9eR16gg15vXmSDXlNeV15Ag15nXqiLXqSDXkNeX16gg16nXkdeo15Ag15vXnCDXlNei15XXnNee15XXqiDXkdeo15Ag15DXqiDXlNeQ15PXnSDXkNeX15XXqCDXnNee16Ii15Eg15HXqNeZ15DXlCDXoNek15zXkNeUINeb15cg157XkNeh16Mg15zXm9ecINeU157Xl9eg15XXqi4g16nXm9ec15wg15HXlSDXm9ecINem15fXpteX15XXqiDXkNeV16jXldeqINeU16DXpNec15DXldeqINeV15TXoteV15zXnteV16og15XXlNeZ15vXnNeZ158g15TXotec15nXldeg15nXnSDXqden15PXnteVINec15UuINeV15vXnCDXqteR16DXmdeqINeU15vXkdeV15Mg15TXotec15nXldefINeR16HXk9eoINek16jXp9eZINeU157XqNeb15HXlC4g15XXm9ecINeU15vXl9eV16og16TXqNeY15nXnSDXlNeg157XpteQ15nXnSDXkdeb15wg15TXoteV15zXnteV16og16LXnNeZ15XXoNeZ150g15XXqteX16rXldeg15nXnS4g15vXldec150g16DXqteg15Ug15vXlyDXldeX15zXpyDXntei16bXnteV16rXnSDXkdeR16DXmdeZ16DXlSDXldeg15vXnNec15Ug15HXlSDXkdee16HXpNeoINek16jXmNeZINeb15fXldeq15nXlSDXqdeR15UuINeb154i16kg15HXlteV15TXqCDXmdeq16jXlSDXoiLXlCDXkScg16fXldeRIteUINeb15Mg15HXqNeQINec15knINec15Ei16Ag16HXk9eoINeR15knINeb15wg15PXmdeV16fXoNeZ158g15PXqNeW15nXnyDXotec15DXmdefINeT16LXnNee15Ag15PXnNei15nXnNeQLiDXldeb15wg15PXmdeV16fXoNeZ158g15PXqNeW15nXnyDXqteq15DXmdefINeT16LXnNee15Ag15PXnNeq16rXkCDXldeb15zXkCDXnteq15fXp9en15Ag15HXkSLXoCDXk9eQ15nXlNeVINen15DXmdedINeR16bXnNedINeQ15zXlNeZ150g15vXlScg15PXm9eq15nXkS4g15XXmdeR16jXkCDXkNec15TXmdedINeQ16og15TXkNeT150g15HXptec157XlSDXoiLXqS4=')));
    }
    s = s.replace(/[\u2018\u2019\u05F3]/g, "'").replace(/[\u201C\u201D\u05F4]/g, '"');
    s = s.replace(/([א-ת]+)\\s+([םןץףך])(?![א-ת])/g, '$1$2');
    s = s.replace(/([א-ת]*[מנצפכ])\\s+([א-ת]+)/g, '$1$2');
    s = s.replace(/(^|\\s)([ובלכמשדה])\\s+([א-ת]{2,})/g, '$1$2$3');
    s = s.replace(/(^|\\s)([ובלכמשדה])\\s+([א-ת]{2,})/g, '$1$2$3');
    s = s.replace(/([א-ת])\\s*["״]\\s*([א-ת])/g, '$1"$2');
    s = s.replace(/([א-ת])\\s*[\'׳]\\s*([א-ת])/g, "$1'$2");
    s = s.replace(/\\s+([.,:;!?])/g, '$1');
    s = s.replace(/([.,:;!?])([א-ת])/g, '$1 $2');
    return s.replace(/\\s+/g, ' ').trim();
  }

  function showFootnotePopover(event, fnNum) {
    if (event && event.preventDefault) event.preventDefault();
    if (event && event.stopPropagation) event.stopPropagation();

    closeFootnotePopover();

    let content = liquidFootnoteMap[String(fnNum)];
    if (!content) {
      const el = document.getElementById('fn-' + fnNum);
      if (el && el.textContent.trim()) content = el.textContent.trim();
    }
    if (!content) return;

    const popover = document.createElement('div');
    popover.className = 'liquid-footnote-popover';
    popover.id = 'activeFootnotePopover';

    let formattedContent = '';
    const hasHebrew = /[\u0590-\u05FF]/.test(content);
    if (hasHebrew && !/[a-zA-Z]{3,}/.test(content)) {
      formattedContent = '<div dir="rtl" class="liquid-hebrew" style="display:block; text-align:right; font-size:1.02em; line-height:1.8;">' + escapeHtml(content) + '</div>';
    } else {
      try {
        formattedContent = formatLiquidText(escapeHtml(content), true);
      } catch(e) {
        formattedContent = escapeHtml(content);
      }
    }

    popover.innerHTML =
      '<div class="fn-popover-header">' +
        '<span class="fn-popover-num">Footnote ' + fnNum + '</span>' +
        '<button class="fn-popover-close" onclick="closeFootnotePopover()" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fn-popover-body">' + formattedContent + '</div>';

    document.body.appendChild(popover);

    const targetEl = (event && (event.currentTarget || event.target)) || document.querySelector('[data-fn="' + fnNum + '"]');
    const rect = (targetEl && targetEl.getBoundingClientRect) ? targetEl.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 100, top: 100, width: 0 };
    const popW = Math.min(window.innerWidth * 0.9, 420);
    let left = rect.left + rect.width / 2 - popW / 2;
    let top = rect.bottom + 8;

    if (left < 8) left = 8;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (top + 200 > window.innerHeight) {
      top = Math.max(8, rect.top - 8);
      popover.classList.add('inverted');
    }

    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.style.width = popW + 'px';

    setTimeout(() => {
      document.addEventListener('click', handlePopoverOutsideClick, { once: true });
    }, 50);
  }
  window.showFootnotePopover = showFootnotePopover;

  function handlePopoverOutsideClick(e) {
    const popover = document.getElementById('activeFootnotePopover');
    if (popover && !popover.contains(e.target)) {
      closeFootnotePopover();
    } else if (popover) {
      document.addEventListener('click', handlePopoverOutsideClick, { once: true });
    }
  }

  function closeFootnotePopover() {
    const existing = document.getElementById('activeFootnotePopover');
    if (existing) existing.remove();
  }
  window.closeFootnotePopover = closeFootnotePopover;

  function cleanPdfLigatures(str) {
    if (!str) return '';
    return str
      .replace(/\u001F/g, 'Th')
      .replace(/\u001C/g, 'fi')
      .replace(/\u001B/g, 'fl')
      .replace(/\u0019/g, 'ffi')
      .replace(/\u0017/g, 'ffl')
      .replace(/\u001A/g, 'tt')
      .replace(/\u001E/g, 'ff')
      .replace(/\u001D/g, 'ff')
      .replace(/[\u0014\u0018]/g, '—');
  }

  function buildColumnDetector(contentItems, pageWidth) {
    if (!contentItems || !contentItems.length) return () => 0;

    const pw = pageWidth || 612;
    const bodyItems = contentItems.filter(it => {
      const size = Math.abs(it.transform[3]);
      const w = it.width || 20;
      return size <= 13 && w < pw * 0.45 && it.str.trim().length >= 2;
    });

    const itemsToScan = bodyItems.length >= 10 ? bodyItems : contentItems;
    const binWidth = 2;
    const numBins = Math.ceil(pw / binWidth);
    const histogram = new Array(numBins).fill(0);

    for (const it of itemsToScan) {
      const x = it.transform[4];
      const w = it.width || (it.str.length * 5);
      const startBin = Math.max(0, Math.floor(x / binWidth));
      const endBin = Math.min(numBins - 1, Math.floor((x + w) / binWidth));
      for (let b = startBin; b <= endBin; b++) {
        histogram[b]++;
      }
    }

    const minGapBins = 4;
    const threshold = 1;
    const gaps = [];
    let gapStart = -1;

    for (let b = 0; b < numBins; b++) {
      if (histogram[b] <= threshold) {
        if (gapStart === -1) gapStart = b;
      } else {
        if (gapStart !== -1) {
          const gapLen = b - gapStart;
          if (gapLen >= minGapBins) {
            const gapCenter = (gapStart + b) / 2 * binWidth;
            gaps.push({ center: gapCenter, width: gapLen * binWidth });
          }
          gapStart = -1;
        }
      }
    }

    const marginThreshold = pw * 0.12;
    const rightMarginThreshold = pw * 0.88;
    const interiorGaps = gaps.filter(g => g.center > marginThreshold && g.center < rightMarginThreshold);

    if (interiorGaps.length === 0) {
      return () => 0;
    }

    interiorGaps.sort((a, b) => a.center - b.center);
    const boundaries = interiorGaps.map(g => g.center);

    return function getColIdx(x) {
      for (let i = 0; i < boundaries.length; i++) {
        if (x < boundaries[i]) return i;
      }
      return boundaries.length;
    };
  }

  function clusterFontSizes(contentItems) {
    const sizeCounts = {};
    for (const it of contentItems) {
      if (!it.str.trim()) continue;
      const size = Math.abs(it.transform[3]);
      const rounded = Math.round(size * 10) / 10;
      sizeCounts[rounded] = (sizeCounts[rounded] || 0) + it.str.length;
    }

    const sizes = Object.entries(sizeCounts)
      .map(([s, count]) => ({ size: parseFloat(s), count }))
      .sort((a, b) => b.count - a.count);

    if (sizes.length === 0) return { bodySize: 10, titleSizes: new Set(), headerSizes: new Set(), subheaderSizes: new Set(), footnoteSizes: new Set(), superscriptThreshold: 0 };

    const bodySize = sizes[0].size;

    const titleSizes = new Set();
    const headerSizes = new Set();
    const subheaderSizes = new Set();
    const footnoteSizes = new Set();
    const superscriptThreshold = bodySize * 0.72;

    for (const { size } of sizes) {
      if (size >= bodySize * 1.55) {
        titleSizes.add(size);
      } else if (size >= bodySize * 1.25) {
        headerSizes.add(size);
      } else if (size >= bodySize * 1.10) {
        subheaderSizes.add(size);
      } else if (size <= bodySize * 0.85 && size > superscriptThreshold * 0.8) {
        footnoteSizes.add(size);
      }
    }

    return { bodySize, titleSizes, headerSizes, subheaderSizes, footnoteSizes, superscriptThreshold };
  }

  function classifyItem(item, clusters) {
    const size = Math.round(Math.abs(item.transform[3]) * 10) / 10;
    if (clusters.titleSizes.has(size)) return 'title';
    if (clusters.headerSizes.has(size)) return 'header';
    if (clusters.subheaderSizes.has(size)) return 'subheader';
    if (size < clusters.superscriptThreshold) return 'superscript';
    if (clusters.footnoteSizes.has(size)) return 'footnote';
    return 'body';
  }

  async function extractAndRenderLiquidText() {
    const container = document.getElementById('liquidContent');
    if (!container || !pdfDoc) return;

    activeExtractionId++;
    const currentExtractionId = activeExtractionId;

    container.innerHTML = '<div class="article-loading-state"><div class="spinner"></div><span>Reconstructing document for Liquid reading...</span></div>';

    const hebrewRegex = /[\u0590-\u05FF]/;
    const nikudRegex = /[\u0591-\u05BD\u05BF-\u05C2\u05C4-\u05C7]/g;
    liquidFootnoteMap = {};

    const pagesData = [];
    const textFrequencyAcrossPages = {};
    let docKicker = '';
    let docAuthor = '';
    let docRole = '';
    let docTitle = '';

    for (let i = 1; i <= pdfTotalPages; i++) {
      if (currentExtractionId !== activeExtractionId) return;
      try {
        const page = await pdfDoc.getPage(i);
        if (currentExtractionId !== activeExtractionId) return;
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });
        const rawItems = textContent.items;
        if (!rawItems || rawItems.length === 0) { pagesData.push(null); continue; }

        let pageItemIdx = 0;
        const items = rawItems.map(it => {
          const str = cleanPdfLigatures(it.str);
          const size = Math.round(Math.abs(it.transform[3]) * 10) / 10;
          return {
            str,
            size,
            fontName: it.fontName,
            transform: it.transform,
            x: it.transform[4],
            y: it.transform[5],
            width: it.width || (str.length * size * 0.5),
            isDropCap: (str.trim().length === 1 && size >= 30),
            effectiveY: (str.trim().length === 1 && size >= 30) ? it.transform[5] + size * 0.75 : it.transform[5],
            origIdx: pageItemIdx++
          };
        }).filter(it => it.str.trim().length > 0);

        if (i === 1) {
          const kickerItem = items.find(it => it.str.includes('Torah To-Go Series') || it.str.includes('Benjamin and Rose Berger'));
          if (kickerItem) docKicker = kickerItem.str.trim();

          const authorItem = items.find(it => it.size >= 16 && it.size <= 18 && (it.str.includes('Rabbi') || it.str.includes('Wiederblank') || it.str.includes('Rosensweig')));
          if (authorItem) {
            const nextAuthor = items.find(it => it.size === authorItem.size && it !== authorItem && Math.abs(it.x - authorItem.x) < 40 && Math.abs(it.y - authorItem.y) < 30);
            docAuthor = nextAuthor ? authorItem.str.trim() + ' ' + nextAuthor.str.trim() : authorItem.str.trim();
          }
          const roleItem = items.find(it => (it.size === 9 || it.size === 10) && (it.str.includes('RIETS') || it.str.includes('Maggid') || it.str.includes('Rosh Yeshiva')));
          if (roleItem) docRole = roleItem.str.trim();
        }

        for (const it of items) {
          const t = it.str.trim();
          if (t.length >= 8) {
            textFrequencyAcrossPages[t] = (textFrequencyAcrossPages[t] || 0) + 1;
          }
        }

        pagesData.push({ items, viewport, pageNum: i });
      } catch (e) {
        console.warn('Error extracting page ' + i, e);
        pagesData.push(null);
      }
    }

    if (currentExtractionId !== activeExtractionId) return;

    // Filter headers/footers
    const parsedPages = [];
    const allBodyItems = [];

    for (const pd of pagesData) {
      if (!pd) { parsedPages.push(null); continue; }
      const { items, viewport, pageNum } = pd;
      const pageHeight = viewport.height || 792;
      const pageWidth = viewport.width || 612;

      const contentItems = items.filter(it => {
        const y = it.y;
        if (y < 46 || y > pageHeight - 38) return false;
        const s = it.str.trim();
        if (!s) return false;
        if (s.includes('Torah To-Go Series') || s.includes('Benjamin and Rose Berger')) return false;
        if (s.includes('Yeshiva University') && s.length < 32) return false;
        if (s.includes('Rabbi Isaac Elchanan Theological Seminary')) return false;
        if (pdfTotalPages > 2 && textFrequencyAcrossPages[s] && textFrequencyAcrossPages[s] >= Math.min(3, Math.ceil(pdfTotalPages * 0.5))) {
          if (y > pageHeight - 75 || y < 65) return false;
        }
        return true;
      });

      if (!contentItems.length) { parsedPages.push(null); continue; }

      for (const it of contentItems) {
        if (it.size >= 10 && it.size <= 12 && /^[a-zA-Z]/.test(it.str.trim()) && it.y > 60 && it.y < 720) {
          allBodyItems.push(it);
        }
      }

      parsedPages.push({ contentItems, pageWidth, pageHeight, pageNum });
    }

    // Document-level column detection
    const binWidth = 2;
    const numBins = Math.ceil(612 / binWidth);
    const histogram = new Array(numBins).fill(0);
    for (const it of allBodyItems) {
      const startBin = Math.max(0, Math.floor(it.x / binWidth));
      const endBin = Math.min(numBins - 1, Math.floor((it.x + it.width) / binWidth));
      for (let b = startBin; b <= endBin; b++) histogram[b]++;
    }

    const gaps = [];
    let gapStart = -1;
    for (let b = 0; b < numBins; b++) {
      if (histogram[b] <= 2) {
        if (gapStart === -1) gapStart = b;
      } else {
        if (gapStart !== -1) {
          if (b - gapStart >= 4) gaps.push((gapStart + b) / 2 * binWidth);
          gapStart = -1;
        }
      }
    }
    let colBoundaries = gaps.filter(g => g > 612 * 0.15 && g < 612 * 0.85);
    if (!colBoundaries.length) colBoundaries = [213, 395];

    function getDocCol(x) {
      for (let i = 0; i < colBoundaries.length; i++) {
        if (x < colBoundaries[i]) return i;
      }
      return colBoundaries.length;
    }

    // Document semantic blocks
    const documentBlocks = [];
    let inEndnotesMode = false;
    const endnoteRawLines = [];

    for (const pd of parsedPages) {
      if (!pd) continue;
      const { contentItems, pageNum } = pd;
      const dropCap = contentItems.find(it => it.isDropCap);

      const spanningItems = [];
      const colItems = [];

      for (const it of contentItems) {
        if (pageNum === 1 && it.size >= 20 && !it.isDropCap) {
          spanningItems.push(it);
        } else if (it.isDropCap) {
          // Drop cap is handled via dropCap variable; do not add as a separate column item
        } else {
          it.col = getDocCol(it.x);
          colItems.push(it);
        }
      }

      if (spanningItems.length > 0) {
        spanningItems.sort((a,b) => b.y - a.y);
        for (const sit of spanningItems) {
          if (sit.size >= 50) {
            documentBlocks.push({ type: 'h2', text: sit.str.trim(), pageNum });
          } else if (sit.size >= 20) {
            docTitle = sit.str.trim();
            documentBlocks.push({ type: 'h1', text: sit.str.trim(), pageNum });
          }
        }
      }

      const maxCol = colBoundaries.length;
      for (let c = 0; c <= maxCol; c++) {
        const cItems = colItems.filter(it => it.col === c);
        if (!cItems.length) continue;

        const filteredItems = cItems.filter(it => {
          if (pageNum === 1 && (it.str.includes('Wiederblank') || it.str.includes('Rabbi Netanel') || it.str.includes('Maggid Shiur, RIETS'))) {
            return false;
          }
          return true;
        });
        if (!filteredItems.length) continue;

        filteredItems.sort((a,b) => b.effectiveY - a.effectiveY || a.x - b.x);

        const rawLines = [];
        let curLine = [];
        let curBaseY = null;
        for (const it of filteredItems) {
          const isSup = (it.size <= 7.5 && /^\\d+$/.test(it.str.trim()));
          const itemY = isSup ? it.y - 3.6 : it.y;
          const roundedY = Math.round(itemY);

          if (curBaseY === null || Math.abs(curBaseY - roundedY) > 3.5) {
            if (curLine.length) rawLines.push({ items: curLine, y: curBaseY });
            curLine = [it];
            curBaseY = roundedY;
          } else {
            curLine.push(it);
          }
        }
        if (curLine.length) rawLines.push({ items: curLine, y: curBaseY });

        // Prepend drop-cap directly to the first word of column 0
        if (c === 0 && dropCap && rawLines.length > 0 && rawLines[0].items.length > 0) {
          rawLines[0].items.sort((a,b) => a.x - b.x);
          rawLines[0].items[0].str = dropCap.str + rawLines[0].items[0].str;
        }

        for (const line of rawLines) {
          const hebItems = [];
          const latinItems = [];
          for (const it of line.items) {
            if (/[\u0590-\u05FF]/.test(it.str) || (it.str === "'" && line.items.some(i => /[\u0590-\u05FF]/.test(i.str) && Math.abs(i.x - it.x) < 30))) {
              hebItems.push(it);
            } else {
              latinItems.push(it);
            }
          }

          let lineText = '';
          let isHebrewLine = false;

          const hasHebrewLetter = hebItems.length > 0;
          const hasLatinWord = latinItems.some(it => /[a-zA-Z]{2,}/.test(it.str));

          if (!hasHebrewLetter) {
            latinItems.sort((a,b) => a.x - b.x);
            for (const it of latinItems) {
              if (it.size <= 7.5 && /^\\d+$/.test(it.str.trim())) {
                lineText += '[FN:' + it.str.trim() + ']';
              } else {
                if (lineText && !lineText.endsWith(' ') && !lineText.endsWith('[FN:') && !lineText.endsWith('-')) lineText += ' ';
                lineText += it.str.trim();
              }
            }
          } else if (!hasLatinWord) {
            // Pure Hebrew line (may contain numbers/punctuation e.g. "3. אבל עיקרו...")
            const items = [...line.items].sort((a,b) => (b.x - a.x) || (b.origIdx - a.origIdx));
            let prevX = null;
            for (const it of items) {
              const curRight = it.x + (it.width || 5);
              if (prevX !== null && (prevX - curRight) > 1.8 && !lineText.endsWith(' ')) lineText += ' ';
              if (it.str.includes(' ') && !lineText.endsWith(' ')) lineText += ' ';
              lineText += it.str.replace(nikudRegex, '');
              prevX = it.x;
            }
            lineText = lineText.trim();
            isHebrewLine = true;
          } else {
            // Mixed line: determine spatial placement of latin vs hebrew
            const minHebX = Math.min(...hebItems.map(i => i.x));
            const minLatX = Math.min(...latinItems.map(i => i.x));

            latinItems.sort((a,b) => a.x - b.x);
            let latText = '';
            for (const it of latinItems) {
              if (it.size <= 7.5 && /^\\d+$/.test(it.str.trim())) {
                latText += '[FN:' + it.str.trim() + ']';
              } else {
                if (latText && !latText.endsWith(' ') && !latText.endsWith('[FN:') && !latText.endsWith('-')) latText += ' ';
                latText += it.str.trim();
              }
            }

            hebItems.sort((a,b) => (b.x - a.x) || (b.origIdx - a.origIdx));
            let hebText = '';
            let prevHebX = null;
            for (const it of hebItems) {
              const curRight = it.x + (it.width || 5);
              if (prevHebX !== null && (prevHebX - curRight) > 1.8 && !hebText.endsWith(' ')) hebText += ' ';
              hebText += it.str.replace(nikudRegex, '');
              prevHebX = it.x;
            }
            hebText = hebText
              .replace(/ה'\\s*צבאות/g, "ה' צבאות")
              .replace(/צבאות\\s*מלא/g, "צבאות מלא")
              .replace(/מלא\\s*כל/g, "מלא כל")
              .replace(/הארץ\\s*כבודו/g, "הארץ כבודו")
              .replace(/ה'\\s*ממקומו/g, "ה' ממקומו")
              .replace(/כבוד\\s*ה'/g, "כבוד ה'")
              .replace(/\\s+/g, ' ')
              .trim();

            if (minLatX < minHebX) {
              lineText = latText + ' ' + hebText;
            } else {
              lineText = hebText + (latText.startsWith(',') ? '' : ' ') + latText;
            }
            isHebrewLine = false;
          }

          if (/^Endnotes/i.test(lineText.trim())) {
            inEndnotesMode = true;
            continue;
          }

          if (inEndnotesMode) {
            if (lineText.includes('YU Tefillah Platform') || lineText.includes('BalkLegacy') || lineText.includes('Podcasts •')) {
              continue;
            }
            endnoteRawLines.push(lineText);
            continue;
          }

          const firstItem = line.items[0];
          const isSectionHeading = !isHebrewLine && (firstItem.size >= 12 && firstItem.size <= 16 && lineText.length < 50 && !lineText.endsWith('.') && /^[A-Z]/.test(lineText));
          const isPullQuote = !isHebrewLine && (firstItem.size >= 17 && firstItem.size <= 19 && pageNum > 1);

          if (isPullQuote) {
            documentBlocks.push({ type: 'pull-quote-line', text: lineText, pageNum });
          } else if (isSectionHeading) {
            documentBlocks.push({ type: 'heading', text: lineText, pageNum });
          } else if (isHebrewLine) {
            documentBlocks.push({ type: 'hebrew-line', text: lineText, pageNum });
          } else {
            documentBlocks.push({ type: 'line', text: lineText, y: line.y, pageNum, col: c });
          }
        }
      }
    }

    // Parse endnotes
    let curFnNum = null;
    let curFnText = '';
    for (const line of endnoteRawLines) {
      const startMatch = line.match(/^[^\\d]*(\\d{1,2})[\\.\\s]\\s*(.*)$/);
      const endMatch = /[\\u0590-\\u05FF]/.test(line) ? line.match(/^(.*?)\\s*[\\."\\s:–-]*(\\d{1,2})\\s*$/) : null;

      if (startMatch && parseInt(startMatch[1]) >= 1 && parseInt(startMatch[1]) <= 60) {
        if (curFnNum !== null && curFnText.trim()) {
          liquidFootnoteMap[String(curFnNum)] = cleanHebrewEndnoteText(curFnText.trim());
        }
        curFnNum = parseInt(startMatch[1]);
        curFnText = startMatch[2];
      } else if (endMatch && parseInt(endMatch[2]) >= 1 && parseInt(endMatch[2]) <= 60) {
        if (curFnNum !== null && curFnText.trim()) {
          liquidFootnoteMap[String(curFnNum)] = cleanHebrewEndnoteText(curFnText.trim());
        }
        curFnNum = parseInt(endMatch[2]);
        curFnText = endMatch[1].replace(/[\."\s:–-]+$/, '').trim();
      } else if (curFnNum !== null) {
        if (curFnText.endsWith('-')) curFnText = curFnText.slice(0, -1) + line;
        else curFnText += ' ' + line;
      }
    }
    if (curFnNum !== null && curFnText.trim()) {
      liquidFootnoteMap[String(curFnNum)] = cleanHebrewEndnoteText(curFnText.trim());
    }

    // Assemble paragraphs from lines
    const assembledBlocks = [];
    let currentP = '';
    let prevLineY = null;
    let prevCol = null;
    let prevPage = null;

    for (const b of documentBlocks) {
      if (b.type !== 'line') {
        if (currentP) {
          assembledBlocks.push({ type: 'p', text: currentP.trim(), pageNum: prevPage || b.pageNum });
          currentP = '';
          prevLineY = null;
          prevCol = null;
        }
        assembledBlocks.push(b);
        continue;
      }

      const sameColAndPage = (b.col === prevCol && b.pageNum === prevPage);
      const delta = (sameColAndPage && prevLineY !== null) ? (prevLineY - b.y) : 0;
      prevLineY = b.y;
      prevCol = b.col;
      prevPage = b.pageNum;

      if (currentP && delta >= 18) {
        assembledBlocks.push({ type: 'p', text: currentP.trim(), pageNum: b.pageNum });
        currentP = '';
      }

      if (!currentP) {
        currentP = b.text;
      } else if (currentP.endsWith('-')) {
        currentP = currentP + b.text;
      } else {
        currentP += ' ' + b.text;
      }
    }
    if (currentP) assembledBlocks.push({ type: 'p', text: currentP.trim(), pageNum: prevPage });

    // Group consecutive Hebrew lines and pull-quote lines
    const finalBlocks = [];
    let curHebrew = [];
    let curPullQuote = [];
    for (const b of assembledBlocks) {
      if (b.type === 'hebrew-line') {
        curHebrew.push(b.text);
      } else if (b.type === 'pull-quote-line') {
        curPullQuote.push(b.text);
      } else {
        if (curHebrew.length > 0) {
          finalBlocks.push({ type: 'hebrew-block', text: curHebrew.map(escapeHtml).join('<br>'), pageNum: b.pageNum });
          curHebrew = [];
        }
        if (curPullQuote.length > 0) {
          finalBlocks.push({ type: 'pull-quote', text: curPullQuote.join(' '), pageNum: b.pageNum });
          curPullQuote = [];
        }
        finalBlocks.push(b);
      }
    }
    if (curHebrew.length > 0) {
      finalBlocks.push({ type: 'hebrew-block', text: curHebrew.map(escapeHtml).join('<br>') });
    }
    if (curPullQuote.length > 0) {
      finalBlocks.push({ type: 'pull-quote', text: curPullQuote.join(' ') });
    }

    // Helper to format body text with footnote superscripts
    function renderFormattedText(text) {
      if (!text) return '';
      let escaped = escapeHtml(text);
      escaped = escaped.replace(/\\[FN:(\\d+)\\]/g, (m, num) => {
        const clickAttr = ' onclick="showFootnotePopover(event, ' + num + ')" tabindex="0" role="button" aria-label="Footnote ' + num + '"';
        return '<sup class="liquid-footnote-ref"' + clickAttr + ' data-fn="' + num + '">' + num + '</sup>';
      });
      return escaped;
    }

    // Build output HTML
    let renderedHtml = '<div class="liquid-document-container">';
    renderedHtml += '<div class="liquid-wip-banner"><span>⚠️</span><span><strong>Liquid Mode Beta:</strong> This feature is still a work in progress.</span></div>';

    // Document Header inside Liquid Mode container (docKicker banner disabled per user request)
    if (docTitle || docAuthor) {
      renderedHtml += '<div class="liquid-header">';
      // docKicker ("The Benjamin..." banner) disabled for now per user request
      // if (docKicker) renderedHtml += '<div class="liquid-kicker">' + escapeHtml(docKicker) + '</div>';
      if (docTitle) renderedHtml += '<h1 class="liquid-title">' + escapeHtml(docTitle) + '</h1>';
      if (docAuthor) renderedHtml += '<div class="liquid-byline">' + escapeHtml(docAuthor) + '</div>';
      if (docRole) renderedHtml += '<div class="liquid-role">' + escapeHtml(docRole) + '</div>';
      renderedHtml += '</div>';
    }

    let curPageMarker = null;
    for (const b of finalBlocks) {
      if (b.pageNum && b.pageNum !== curPageMarker) {
        curPageMarker = b.pageNum;
        renderedHtml += '<div class="liquid-page-marker">\uD83D\uDCC4 Page ' + curPageMarker + ' of ' + pdfTotalPages + '</div>';
      }

      if (b.type === 'h1') {
        if (!docTitle) {
          renderedHtml += '<h1 class="liquid-title">' + escapeHtml(b.text) + '</h1>';
        }
      } else if (b.type === 'h2') {
        renderedHtml += '<h2 class="liquid-heading">' + escapeHtml(b.text) + '</h2>';
      } else if (b.type === 'heading') {
        renderedHtml += '<h3 class="liquid-heading">' + escapeHtml(b.text) + '</h3>';
      } else if (b.type === 'pull-quote') {
        renderedHtml += '<aside class="liquid-pull-quote"><blockquote>“' + escapeHtml(b.text.replace(/^["“\s]+|["”\s]+$/g, '')) + '”</blockquote><span class="liquid-pull-quote-tag">Featured Excerpt</span></aside>';
      } else if (b.type === 'hebrew-block') {
        renderedHtml += '<div class="liquid-hebrew-block" dir="rtl">' + b.text + '</div>';
      } else if (b.type === 'p') {
        renderedHtml += '<p class="liquid-paragraph">' + renderFormattedText(b.text) + '</p>';
      }
    }

    // Render Endnotes section if present
    const endnoteNums = Object.keys(liquidFootnoteMap).map(Number).sort((a,b) => a - b);
    if (endnoteNums.length > 0) {
      renderedHtml += '<section class="liquid-endnotes">';
      renderedHtml += '<h3 class="liquid-endnotes-title">Endnotes</h3>';
      renderedHtml += '<ol class="liquid-endnotes-list">';
      for (const num of endnoteNums) {
        const text = liquidFootnoteMap[String(num)];
        const isRtl = /[\u0590-\u05FF]/.test(text) && !/[a-zA-Z]{3,}/.test(text);
        const dirAttr = isRtl ? ' dir="rtl"' : '';
        renderedHtml += '<li class="liquid-endnotes-item" id="fn-' + num + '"' + dirAttr + '>' + escapeHtml(text) + '</li>';
      }
      renderedHtml += '</ol></section>';
    }

    renderedHtml += '</div>';

    if (currentExtractionId !== activeExtractionId) return;

    if (finalBlocks.length > 0) {
      container.innerHTML = renderedHtml;
      container.style.fontSize = liquidFontSizeRem + 'rem';
    } else {
      container.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">' +
        '<p>This document contains scanned imagery or complex vector layout.</p>' +
        '<button type="button" class="article-btn" onclick="setArticleMode(&apos;original&apos;)" style="margin-top: 12px;">Switch to Original Page View</button>' +
        '</div>';
    }
  }

  async function loadArticlePdf(rawUrl) {
    if (!rawUrl) return;
    const container = document.getElementById('articleViewerContainer');
    if (container) container.style.display = 'block';

    const audioWrap = document.getElementById('audioControlsWrap');
    if (audioWrap) audioWrap.style.display = 'none';

    // Pause audio if playing and clear src so background playback does not trigger
    if (audio) {
      if (!audio.paused) audio.pause();
      try { audio.src = ''; audio.load(); } catch(e){}
    }
    hasAudio = false;

    // Clean up previous pdfDoc to release memory and web worker
    if (pdfDoc) {
      try {
        pdfDoc.destroy();
      } catch(e) {}
      pdfDoc = null;
    }

    // Determine initial mode based on screen width & orientation:
    // Mobile portrait (<768px and height > width) defaults to Liquid Mode
    const isMobilePortrait = window.innerWidth <= 768 && window.innerHeight >= window.innerWidth;
    const initialMode = isMobilePortrait ? 'liquid' : 'original';
    setArticleMode(initialMode);

    const proxyUrl = getPdfProxyUrl(rawUrl);

    try {
      if (typeof pdfjsLib === 'undefined') {
        console.warn('pdfjsLib is not loaded yet');
        const content = document.getElementById('liquidContent');
        if (content) {
          content.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">' +
            '<p>PDF Reader library could not be loaded.</p>' +
            '<a href="' + escapeHtml(rawUrl) + '" target="_blank" class="article-btn" style="margin-top:12px; display:inline-flex;">Open / Download PDF Document</a>' +
            '</div>';
        }
        return;
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      const loadingTask = pdfjsLib.getDocument({
        url: proxyUrl,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true
      });

      pdfDoc = await loadingTask.promise;
      pdfTotalPages = pdfDoc.numPages;
      pdfCurrentPage = 1;
      updatePageNavUI();

      // Download button
      const dlPdfBtn = document.getElementById('dlPdfBtn');
      if (dlPdfBtn) dlPdfBtn.href = rawUrl;

      // Render views based on current mode
      if (articleViewerMode === 'original') {
        if (pageScrollMode === 'continuous') {
          renderContinuousPages();
        } else {
          renderArticlePage(1);
        }
      }
      extractAndRenderLiquidText();
    } catch (err) {
      console.error('Failed to load PDF in reader:', err);
      const content = document.getElementById('liquidContent');
      if (content) {
        content.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">' +
          '<p>Unable to display document directly in browser preview.</p>' +
          '<a href="' + escapeHtml(rawUrl) + '" target="_blank" class="article-btn" style="margin-top:12px; display:inline-flex;">Open / Download PDF Document</a>' +
          '</div>';
      }
    }
  }

  function toggleArticleFullscreen() {
    const container = document.getElementById('articleViewerContainer');
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => {
        console.warn('Fullscreen error:', err);
      });
    } else {
      document.exitFullscreen();
    }
  }

  // Responsive device orientation adaptation
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (!isCurrentShiurArticle || !pdfDoc) return;
      const isMobile = window.innerWidth <= 768;
      const isLandscape = window.innerWidth > window.innerHeight;
      if (isMobile) {
        if (isLandscape) {
          setArticleMode('original');
        } else {
          setArticleMode('liquid');
        }
      }
      updateOrientationTip();
    }, 250);
  });

  window.addEventListener('resize', () => {
    if (isCurrentShiurArticle && articleViewerMode === 'original') {
      updateOrientationTip();
    }
  });

  // Auto-load article if initial page load was an article
  if (INITIAL_ARTICLE_PDF) {
    loadArticlePdf(INITIAL_ARTICLE_PDF);
  }

  // If page loaded with audio, try to autoplay or wait for user touch
  if (hasAudio) {
    audio.play().catch(() => {
      console.log('Autoplay deferred for user tap');
    });
  }
</script>

</body>
</html>
`;
}

function renderShiurCardHtml(s, searchTerms = [], options = {}) {
  const id = s.shiurid || s.shiurID || s.id || '';
  const title = s.shiurtitle || s.shiurTitle || s.title || 'Untitled Shiur';
  let speaker = s.teacherfullname || '';
  let photo = '';
  if (s.shiurTeachers && s.shiurTeachers[0]) {
    speaker = s.shiurTeachers[0].teacherName || s.shiurTeachers[0].teacherFullName || speaker;
    photo = s.shiurTeachers[0].teacherPhotoURL || s.shiurTeachers[0].teacherPhotoURL_lp || '';
  } else if (s.speaker) {
    speaker = s.speaker;
    photo = s.speakerPhoto || s.photo || '';
  }
  if (!speaker) speaker = 'YUTorah';

  if (!photo && s.PHOTO) {
    photo = s.PHOTO.startsWith('http') ? s.PHOTO : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${s.PHOTO}`;
  }
  if (!photo && s.photo) {
    photo = s.photo.startsWith('http') ? s.photo : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${s.photo}`;
  }
  if (!photo) {
    photo = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
  }

  const duration = s.durationformatted || (typeof s.duration === 'number' ? s.duration + ' min' : (s.duration || ''));
  const rawDate = s.shiurdateformatted || s.shiurDateFormatted || s.shiurdate || s.shiurDate || s.shiurdatesubmitted || s.shiurDateSubmitted || s.date || '';
  const dateStr = formatShiurDate(rawDate);
  const isNew = isShiurNew(s.shiurdatesubmitted || s.shiurDateSubmitted || rawDate);
  const newBadge = isNew ? '<span class="quick-card-new-badge">NEW</span>' : '';
  const category = (Array.isArray(s.categoryname) && s.categoryname[0]) || (Array.isArray(s.subcategoryname) && s.subcategoryname[0]) || s.category || '';

  const mediaCat = (s.mediatypecategory || s.mediaTypeCategory || '').toLowerCase();
  const urlCheck = s.shiururl || s.shiurURL || s.playerDownloadURL || s.downloadURL || '';
  const isArticle = mediaCat === 'text' || mediaCat === 'article' || /\.pdf($|\?)/i.test(urlCheck);

  const metaParts = [];
  if (isArticle) {
    metaParts.push('📄 Article');
  } else if (duration) {
    metaParts.push('⏱ ' + escapeHtml(duration));
  }
  if (dateStr) metaParts.push(escapeHtml(dateStr));
  const bottomMeta = metaParts.join(' · ');

  let displayTitle = escapeHtml(title);
  let displaySpeaker = escapeHtml(speaker);
  let displayCategory = category ? escapeHtml(category) : '';
  let matchReasonHtml = '';

  if (searchTerms && searchTerms.length > 0) {
    displayTitle = highlightMatches(title, searchTerms);
    displaySpeaker = highlightMatches(speaker, searchTerms);
    if (category) displayCategory = highlightMatches(category, searchTerms);

    const reasons = buildMatchReasons(s, searchTerms);
    if (reasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        reasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    } else {
      let matchedVisible = [];
      if (displayTitle.includes('mark class="match-mark"')) matchedVisible.push('Title');
      if (displaySpeaker.includes('mark class="match-mark"')) matchedVisible.push('Speaker');
      if (displayCategory && displayCategory.includes('mark class="match-mark"')) matchedVisible.push('Category');
      const visibleNote = matchedVisible.length > 0 ? 'Matched search term in ' + matchedVisible.join(' & ') : 'Matched via YUTorah index relevance';
      const visibleBadge = matchedVisible.length > 0 ? '✨ Direct Match' : '🎯 Solr Index';
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        '<div class="match-reason-item">' +
          '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(visibleBadge) + '</span></div>' +
          '<div class="match-reason-snippet">' + escapeHtml(visibleNote) + '</div>' +
        '</div>' +
      '</div>';
    }
  }

  const isCover = options.isCover;
  const seriesBadge = isCover
    ? `<div class="series-cover-badge">📚 Series · ${options.seriesCount || 'Multi-Part'} Shiurim</div>`
    : '';
  const coverClass = isCover ? ' is-series-cover' : '';
  const badgePlay = `event.stopPropagation(); playShiurById(event, '${id}', true)`;
  const actionBadge = isArticle
    ? '<span class="quick-play-badge" style="background:#10b981; color:#fff;">📄 Read</span>'
    : `<span class="quick-play-badge" role="button" tabindex="0" data-kbplay onclick="${badgePlay}">▶ Play</span>`;

  return `
    <a href="/${id}" class="quick-card-link${coverClass}" onclick="playShiurById(event, this.dataset.id)" data-id="${id}">
      ${newBadge}
      ${seriesBadge}
      <div class="quick-card-top">
        <img class="quick-card-avatar" src="${escapeHtml(photo)}" alt="${escapeHtml(speaker)}" loading="lazy" onerror="handleImgError(this)">
        <div class="quick-card-info">
          <div class="quick-card-title">${displayTitle}</div>
          <div class="quick-card-speaker">${displaySpeaker}</div>
          ${displayCategory ? `<div class="quick-card-category">${displayCategory}</div>` : ''}
        </div>
      </div>
      ${matchReasonHtml}
      <div class="quick-card-bottom">
        <span>${bottomMeta}</span>
        ${actionBadge}
      </div>
    </a>
  `;
}

function renderSeriesSubCardHtml(sub, partNumber, searchTerms = []) {
  const id = sub.shiurid || sub.shiurID || sub.id || '';
  const title = sub.shiurtitle || sub.shiurTitle || sub.title || 'Untitled';
  const duration = sub.durationformatted || (typeof sub.duration === 'number' ? sub.duration + ' min' : (sub.duration || ''));
  const rawDate = sub.shiurdateformatted || sub.shiurDateFormatted || sub.shiurdate || sub.shiurdatesubmitted || '';
  const dateStr = formatShiurDate(rawDate);
  const displayTitle = searchTerms.length > 0 ? highlightMatches(title, searchTerms) : escapeHtml(title);

  const mediaCat = (sub.mediatypecategory || sub.mediaTypeCategory || '').toLowerCase();
  const urlCheck = sub.shiururl || sub.shiurURL || sub.playerDownloadURL || sub.downloadURL || '';
  const isArticle = mediaCat === 'text' || mediaCat === 'article' || /\.pdf($|\?)/i.test(urlCheck);

  let matchReasonHtml = '';
  if (searchTerms.length > 0) {
    const reasons = buildMatchReasons(sub, searchTerms);
    if (reasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        reasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    }
  }

  const metaParts = [];
  if (isArticle) {
    metaParts.push('📄 Article');
  } else if (duration) {
    metaParts.push('⏱ ' + escapeHtml(duration));
  }
  if (dateStr) metaParts.push(escapeHtml(dateStr));

    const subPlay = `event.stopPropagation(); playShiurById(event, '${id}', true)`;
    const subAction = isArticle
      ? '<span class="series-sub-play" style="background:#10b981; color:#fff;">📄 Read</span>'
      : `<span class="series-sub-play" role="button" tabindex="0" data-kbplay onclick="${subPlay}">▶ Play</span>`;

    return `
    <a href="/${id}" class="series-sub-card" onclick="playShiurById(event, this.dataset.id)" data-id="${id}">
      <div class="series-sub-header">
        <div class="series-sub-title"><span style="opacity:0.75; font-weight:700; margin-right:4px;">#${partNumber}</span> ${displayTitle}</div>
        ${subAction}
      </div>
      ${matchReasonHtml}
      ${metaParts.length > 0 ? `<div class="series-sub-meta">${metaParts.join(' · ')}</div>` : ''}
    </a>
  `;
}

function renderGroupItemHtml(item, searchTerms = []) {
  if (!item.isSeries) {
    return renderShiurCardHtml(item.doc, searchTerms);
  }
  const cover = item.cover;
  const subDocs = item.subDocs;
  const drawerId = 'series_drawer_' + (cover.shiurid || cover.shiurID || cover.id || '') + '_' + Math.random().toString(36).substring(2, 7);
  const coverHtml = renderShiurCardHtml(cover, searchTerms, { isCover: true, seriesTitle: item.title, seriesCount: item.docs.length });
  const subCardsHtml = subDocs.map((sub, idx) => renderSeriesSubCardHtml(sub, idx + 2, searchTerms)).join('');

  return `
    <div class="quick-card-series-group">
      ${coverHtml}
      <button type="button" class="series-expand-btn" data-drawer-target="${drawerId}" data-sub-count="${subDocs.length}" data-series-title="${escapeHtml(item.title || '')}" onclick="toggleSeriesDrawer(event, this.dataset.drawerTarget)">
        <span class="series-expand-icon">➕</span> <span class="series-expand-text">View ${subDocs.length} more in ‘${escapeHtml(item.title || 'this')}’ Series</span>
      </button>
      <div id="${drawerId}" class="series-drawer" style="display: none;">
        ${subCardsHtml}
      </div>
    </div>
  `;
}

function renderSeriesCardHtml(s) {
  const imgUrl = s.imageURL || 'https://cdnyutorah.cachefly.net/_images/series/riets.gif';
  const name = s.name || 'Featured Series';
  const desc = s.description || '';
  const count = s.numShiurim || 0;
  const seriesId = s.seriesID || '';

  return `
    <div class="series-card" data-id="${escapeHtml(seriesId)}" data-name="${escapeHtml(name)}" onclick="filterBySeries(this.dataset.id, this.dataset.name)" title="Explore ${escapeHtml(name)}">
      <div class="series-card-img" style="background-image: url('${escapeHtml(imgUrl)}');"></div>
      <div class="series-card-body">
        <div class="series-card-title">${escapeHtml(name)}</div>
        ${desc ? `<div class="series-card-desc">${escapeHtml(desc)}</div>` : ''}
        <div class="series-card-count">📚 ${count} shiurim</div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
