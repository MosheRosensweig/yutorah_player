/**
 * YUTorah Player — Cloudflare Worker Web Application
 *
 * Standalone, zero-friction web portal and enhanced audio player.
 * Server-renders collections (Editor's Picks, Recently Uploaded, Popular, Daily Shiurim)
 * and proxies real-time searches across 440,000+ YUTorah shiurim without Cloudflare blocking.
 */

const TARGET_API_ORIGIN = 'https://www.yutorah.org';
const API_ORIGIN = 'https://api.yutorah.org';

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Live Search API Proxy: /api/search?q=...
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') || url.searchParams.get('searchTerm') || '';
      const teacherId = url.searchParams.get('teacherId') || '';
      const subCategoryId = url.searchParams.get('subCategoryId') || '';
      const locationId = url.searchParams.get('locationId') || url.searchParams.get('venueId') || '';
      const seriesId = url.searchParams.get('seriesId') || url.searchParams.get('series') || '';
      const start = url.searchParams.get('start') || '1';

      let targetUrl = `${API_ORIGIN}/search?searchTerm=${encodeURIComponent(q)}&start=${encodeURIComponent(start)}`;
      if (teacherId) targetUrl += `&teacherId=${encodeURIComponent(teacherId)}`;
      if (subCategoryId) targetUrl += `&subCategoryId=${encodeURIComponent(subCategoryId)}`;
      if (locationId) targetUrl += `&locationId=${encodeURIComponent(locationId)}`;
      if (seriesId) targetUrl += `&seriesId=${encodeURIComponent(seriesId)}`;

      try {
        const upstream = await fetch(targetUrl, {
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
            'Cache-Control': 'public, max-age=300'
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

    // 4. Extract Shiur ID or Search Query from URL
    let shiurId = url.searchParams.get('shiurId') || url.searchParams.get('shiurID') || url.searchParams.get('id');
    const pathMatch = url.pathname.match(/^\/(?:lectures\/)?([0-9]+)/);
    if (!shiurId && pathMatch) {
      shiurId = pathMatch[1];
    }

    const searchQuery = url.searchParams.get('search') || url.searchParams.get('q') || '';
    const directAudio = url.searchParams.get('audioUrl') || url.searchParams.get('url');
    const timestamp = url.searchParams.get('t') || '';

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

    if (!shiurData && searchQuery) {
      try {
        const searchResp = await fetch(`${API_ORIGIN}/search?searchTerm=${encodeURIComponent(searchQuery)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (searchResp.ok) {
          const searchJson = await searchResp.json();
          initialSearchResults = (searchJson?.response?.docs || []).map(normalizeShiur);
          initialNumFound = searchJson?.response?.numFound || initialSearchResults.length;
        }
      } catch (e) {
        console.error('Error pre-fetching search:', e);
      }
    }

    // Pre-fetch homepage collections for cards
    homepageData = await getHomepageData();

    // 7. Render and return the HTML app
    return new Response(renderAppHtml({
      shiurData,
      shiurId,
      directAudio,
      timestamp,
      homepageData,
      searchQuery,
      initialSearchResults,
      initialNumFound
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

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) {
    return dateStr;
  }
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

  let date = s.shiurdateformatted || s.shiurDateFormatted || s.shiurDateSubmittedFormatted || '';
  if (!date && s.shiurDate) {
    date = formatDate(s.shiurDate);
  }

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

  return { id, title, speaker, photo, duration, date, category };
}

function renderAppHtml({ shiurData, shiurId, directAudio, timestamp, homepageData, searchQuery, initialSearchResults, initialNumFound = 0 }) {
  const isPlaying = Boolean(shiurData || directAudio);

  let title = 'YUTorah Enhanced Player';
  let speaker = '';
  let photo = '';
  let duration = '';
  let meta = '';
  let description = '';
  let audioUrl = '';
  let downloadUrl = '';
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
    shiurDate = shiurData.shiurDateFormatted || '';
    meta = duration + (shiurDate ? ' · ' + shiurDate : '');
    description = shiurData.shiurDescription || '';
    downloadUrl = shiurData.downloadURL || shiurData.playerDownloadURL || '';
    audioUrl = shiurData.playerDownloadURL || (shiurData.shiurURL ? 'https://shiurim.yutorah.net' + shiurData.shiurURL : '') || downloadUrl;

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

  // Collections data
  let editorsPicks = [];
  let featuredSeries = [];
  let recentlyUploaded = [];
  let popularShiurim = [];
  let dailyShiurim = [];

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
  }

  if (editorsPicks.length === 0) {
    editorsPicks = FALLBACK_SHIURIM;
  }

  const timely = homepageData?.timelyData || null;
  const parshaCatMatch = timely?.parshaURL ? timely.parshaURL.match(/category=([0-9]+)/) : null;
  const parshaCatId = parshaCatMatch ? parshaCatMatch[1] : '233995';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(title)} — YUTorah Enhanced</title>
  <script>
    (function() {
      try {
        var saved = localStorage.getItem('yutorah_theme');
        var dark = saved ? saved === 'dark' : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      } catch(e) {}
    })();
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
    [data-theme="dark"] .quick-card-avatar {
      background: #141f2f;
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

    /* Header */
    header {
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%);
      color: #fff;
      padding: 14px 20px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.12);
      position: sticky;
      top: 0;
      z-index: 100;
      width: 100%;
      overflow-x: hidden;
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
    }

    /* Main Container */
    main {
      flex: 1;
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 16px 60px;
    }

    /* Timely Banner (Parsha / Daf Yomi / Theme Switcher) */
    .timely-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 16px;
      margin-bottom: 18px;
      font-size: 13px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.03);
    }
    .timely-study-group {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      row-gap: 6px;
    }
    .timely-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .timely-label {
      font-weight: 700;
      color: var(--primary);
    }
    .timely-val {
      color: var(--text);
    }
    .timely-link {
      text-decoration: none;
      cursor: pointer;
      padding: 3px 8px;
      border-radius: 6px;
      transition: all 0.15s ease;
      background: rgba(43, 76, 126, 0.05);
      border: 1px solid rgba(43, 76, 126, 0.12);
    }
    .timely-link:hover {
      background: rgba(43, 76, 126, 0.12);
      border-color: rgba(43, 76, 126, 0.28);
      transform: translateY(-1px);
    }
    .timely-link .timely-val {
      text-decoration: underline;
      text-decoration-color: rgba(43, 76, 126, 0.4);
      text-underline-offset: 3px;
    }
    [data-theme="dark"] .timely-link {
      background: rgba(92, 142, 204, 0.1);
      border-color: rgba(92, 142, 204, 0.2);
    }
    [data-theme="dark"] .timely-link:hover {
      background: rgba(92, 142, 204, 0.2);
      border-color: rgba(92, 142, 204, 0.35);
    }
    [data-theme="dark"] .timely-link .timely-val {
      text-decoration-color: rgba(92, 142, 204, 0.5);
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
    [data-theme="dark"] .sponsorship-banner {
      background: linear-gradient(90deg, #141a24 0%, #1a2230 50%, #141a24 100%);
      border-bottom: 1px solid #29384e;
      color: #e8ce8f;
    }
    [data-theme="dark"] .sponsorship-banner strong {
      color: #fae4a5;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
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

    @media (max-width: 600px) {
      header {
        padding: 8px 10px;
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
        gap: 4px;
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
        padding: 6px 10px;
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
    .search-submit-btn {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 0 22px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .search-submit-btn:hover {
      background: var(--primary-dark);
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
    }
    .scrubber-handle {
      position: absolute;
      right: -9px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      background: var(--primary);
      border: 2.5px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.28);
      transition: transform 0.1s ease;
      pointer-events: none;
      z-index: 2;
    }
    .scrubber-bar:hover .scrubber-handle,
    .scrubber-bar.is-dragging .scrubber-handle {
      transform: translateY(-50%) scale(1.25);
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
      margin-bottom: 16px;
      padding: 12px 16px;
      background: #eef4fc;
      border-radius: 10px;
      border: 1px solid #d0e1f7;
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

    /* Shiur Cards Grid */
    .shiur-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    .quick-card-link {
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
      z-index: 999;
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%);
      color: #fff;
      display: none;
      flex-direction: column;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    }
    #miniPlayer.visible { display: flex; }
    .mini-progress-track {
      width: 100%;
      height: 3px;
      background: rgba(255,255,255,0.2);
      cursor: pointer;
    }
    .mini-progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s linear;
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

<header>
  <div class="header-inner">
    <a href="/" class="brand" onclick="goHome(event)">
      🎧 YUTorah Enhanced <span>PLAYER</span>
    </a>
    <div class="header-right">
      <button type="button" id="themeToggleBtn" class="theme-toggle-btn" onclick="toggleTheme()" title="Toggle Dark / Light Mode">🌙</button>
      ${homepageData?.hebrewDateString ? `<div class="hebrew-date-badge">📅 ${escapeHtml(homepageData.hebrewDateString)}</div>` : ''}
    </div>
  </div>
</header>

<div class="sponsorship-banner">
  <div class="sponsorship-content">
    <span class="sponsorship-icon">🎗️</span>
    <span class="sponsorship-text">Learning on the Marcos and Adina Katz YUTorah site is sponsored today for a refuah shleimah for <strong>Avraham Yitzchak Fishel ben Chaina Shifra</strong></span>
  </div>
</div>

<main>

  <div class="timely-banner">
    <div class="timely-study-group">
      ${timely?.parshaStr ? `<a href="/?category=${parshaCatId}" class="timely-item timely-link" onclick="filterByCategory('${parshaCatId}', 'Parsha: ${escapeHtml(timely.parshaStr).replace(/'/g, "\\'")}'); return false;" title="Browse ${escapeHtml(timely.parshaStr)} shiurim"><span class="timely-label">📖 Parsha:</span> <span class="timely-val">${escapeHtml(timely.parshaStr)}</span></a>` : ''}
      ${timely?.dafStr ? `<a href="/?search=${encodeURIComponent(timely.dafStr)}" class="timely-item timely-link" onclick="searchFor('${escapeHtml(timely.dafStr).replace(/'/g, "\\'")}'); return false;" title="Browse ${escapeHtml(timely.dafStr)} shiurim"><span class="timely-label">📜 Daf Yomi:</span> <span class="timely-val">${escapeHtml(timely.dafStr)}</span></a>` : ''}
      ${timely?.mishnaYomiStr ? `<a href="/?category=${timely?.mishnaYomiSubcategoryID || '234949'}" class="timely-item timely-link" onclick="filterByCategory('${timely?.mishnaYomiSubcategoryID || '234949'}', 'Mishna Yomi: ${escapeHtml(timely.mishnaYomiStr).replace(/'/g, "\\'")}'); return false;" title="Browse ${escapeHtml(timely.mishnaYomiStr)} shiurim"><span class="timely-label">📗 Mishna:</span> <span class="timely-val">${escapeHtml(timely.mishnaYomiStr)}</span></a>` : ''}
      ${timely?.nachYomiStr ? `<a href="/?category=${timely?.nachYomiSubcategoryID || '234877'}" class="timely-item timely-link" onclick="filterByCategory('${timely?.nachYomiSubcategoryID || '234877'}', 'Nach Yomi: ${escapeHtml(timely.nachYomiStr).replace(/'/g, "\\'")}'); return false;" title="Browse ${escapeHtml(timely.nachYomiStr)} shiurim"><span class="timely-label">📘 Nach:</span> <span class="timely-val">${escapeHtml(timely.nachYomiStr)}</span></a>` : ''}
      ${!timely?.parshaStr && !timely?.dafStr && homepageData?.hebrewDateString ? `<div class="timely-item"><span class="timely-label">📅 Date:</span> <span class="timely-val">${escapeHtml(homepageData.hebrewDateString)}</span></div>` : ''}
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
      </div>
      <button type="button" class="search-submit-btn" onclick="doSearch()">Search</button>
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
        ${initialSearchResults ? `Showing ${initialSearchResults.length} results for "${escapeHtml(searchQuery)}"` : 'Search Results'}
      </span>
      <button class="close-results-btn" onclick="clearSearch()">Clear Search ×</button>
    </div>

    <div class="spinner-box" id="searchSpinner">
      <div class="spinner"></div>
      Searching YUTorah...
    </div>

    <div class="shiur-cards-grid" id="searchResultsGrid">
      ${initialSearchResults ? initialSearchResults.map(renderShiurCardHtml).join('') : ''}
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
      <a onclick="minimizePlayer()" class="player-nav-back" style="margin-bottom: 0; cursor: pointer;">← Browse Library While Listening</a>
      <button type="button" class="mini-btn-pill" onclick="minimizePlayer()" title="Minimize to mini-player" style="background: #eef2f7; border: 1px solid #dbe2ed; color: var(--primary); font-size: 13px; font-weight: 700; padding: 5px 12px; border-radius: 8px; cursor: pointer;">🗕 Minimize</button>
    </div>
    <div class="shiur-header">
      <img id="speakerImg" class="speaker-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(speaker)}">
      <div class="shiur-details">
        <h1 id="shiurTitle" class="shiur-title">${escapeHtml(title)}</h1>
        <div id="shiurSpeaker" class="shiur-speaker">${escapeHtml(speaker)}</div>
        <div id="shiurMeta" class="shiur-meta">${escapeHtml(meta)}</div>
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
          <option value="0.5">0.5x</option>
          <option value="0.75">0.75x</option>
          <option value="1" selected>1.0x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="1.75">1.75x</option>
          <option value="2">2.0x</option>
          <option value="2.5">2.5x</option>
          <option value="3">3.0x</option>
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

    <div class="shiur-desc" id="shiurDesc">${escapeHtml(description)}</div>

    <!-- Metadata Chips -->
    <div class="shiur-metadata-box" id="shiurMetadataBox" style="${(shiurTeachers.length || shiurLocations.length || Object.keys(shiurCategories).length || shiurKeywords.length) ? '' : 'display:none;'}">
      ${shiurTeachers.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">👤 Speaker</span>
        ${shiurTeachers.map(t => `<button class="meta-chip speaker-chip" onclick="filterByTeacher(${JSON.stringify(t.id)}, ${JSON.stringify(t.name).replace(/'/g, '&#39;')})">${escapeHtml(t.name)}</button>`).join('')}
      </div>` : ''}
      ${shiurDate ? `
      <div class="meta-row">
        <span class="meta-label">📅 Date</span>
        <span style="font-size:13px; color:var(--text);">${escapeHtml(shiurDate)}</span>
      </div>` : ''}
      ${shiurLocations.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">📍 Venue</span>
        ${shiurLocations.map(loc => `<button class="meta-chip venue-chip" onclick="filterByLocation(${JSON.stringify(loc.id)}, ${JSON.stringify(loc.name).replace(/'/g, '&#39;')})">${escapeHtml(loc.name)}</button>`).join('')}
      </div>` : ''}
      ${Object.keys(shiurCategories).length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">📂 Topics</span>
        ${Object.entries(shiurCategories).map(([groupName, cats]) =>
          `<span class="meta-group-name">${escapeHtml(groupName)}:</span>` +
          cats.map(c => `<button class="meta-chip category-chip" onclick="filterByCategory(${JSON.stringify(c.id)}, ${JSON.stringify(c.name).replace(/'/g, '&#39;')})">${escapeHtml(c.name)}</button>`).join('')
        ).join(' ')}
      </div>` : ''}
      ${shiurKeywords.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">🏷️ Tags</span>
        ${shiurKeywords.map(k => `<button class="meta-chip keyword-chip" onclick="searchFor(${JSON.stringify(k.title).replace(/'/g, '&#39;')})">${escapeHtml(k.title)}</button>`).join('')}
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
    <div class="section-header">
      <h2 class="section-title" id="activeCollectionTitle">⭐ Editor's Picks</h2>
      <div class="tab-bar">
        <button class="tab-btn active" id="tab-editors" onclick="switchCollection('editors')">⭐ Editor's Picks</button>
        <button class="tab-btn" id="tab-series" onclick="switchCollection('series')">📚 Featured Series</button>
        <button class="tab-btn" id="tab-recent" onclick="switchCollection('recent')">⏱️ Recently Uploaded</button>
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

    <div class="series-grid" id="grid-series" style="display: none;">
      ${featuredSeries.map(renderSeriesCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-recent" style="display: none;">
      ${recentlyUploaded.map(renderShiurCardHtml).join('')}
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
    <div class="mini-progress-fill" id="miniProgressFill"></div>
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
          <polygon points="4,14 40,2 40,26" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linejoin="round"/>
          <text x="26" y="18" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="800" text-anchor="middle">-10</text>
        </svg>
      </button>
      <button type="button" class="mini-play-btn" id="miniPlayBtn" onclick="togglePlay(); event.stopPropagation();" title="Play/Pause"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin-left:2px;"><path d="M8 5v14l11-7z"/></svg></button>
      <button type="button" class="mini-btn skip-btn" onclick="skip(10); event.stopPropagation();" title="Forward 10s">
        <svg width="44" height="28" viewBox="0 0 44 28" style="display:block;">
          <polygon points="40,14 4,2 4,26" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linejoin="round"/>
          <text x="18" y="18" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="800" text-anchor="middle">+10</text>
        </svg>
      </button>
      <button type="button" class="mini-btn expand-btn" onclick="expandPlayer(); event.stopPropagation();" title="Expand Full Player">⤢</button>
      <button type="button" class="mini-btn close-btn" onclick="closeMiniPlayer(); event.stopPropagation();" title="Stop & Close">✕</button>
    </div>
  </div>
</div>

<footer>
  <p>YUTorah Enhanced Player · Standalone zero-friction audio player for <a href="https://www.yutorah.org" target="_blank">YUTorah.org</a></p>
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

  const audio = document.getElementById('audioElement');
  let initialTimestamp = ${JSON.stringify(timestamp)};
  let hasAudio = ${JSON.stringify(Boolean(audioUrl))};
  let currentShiurId = ${JSON.stringify(shiurId || '')};
  let initialTimeApplied = false;
  let lastUrlUpdateSec = -1;
  let lastUrlUpdateTime = 0;

  function updateUrlTimestamp(force) {
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
  let searchDebounceTimer = null;

  function onSearchInput() {
    const val = searchInput.value;
    clearSearchBtn.style.display = val.trim() ? 'block' : 'none';

    clearTimeout(searchDebounceTimer);
    const query = val.trim();
    if (!query) {
      clearSearch();
      return;
    }
    if (query.length < 2) return;

    searchDebounceTimer = setTimeout(() => {
      executeLiveSearch(query);
    }, 300);
  }

  function doSearch() {
    clearTimeout(searchDebounceTimer);
    const query = searchInput.value.trim();
    if (!query) return;

    // Smart detect: is it a Shiur ID or YUTorah URL?
    const id = extractShiurId(query);
    if (id) {
      playShiurById(null, id);
      return;
    }

    executeLiveSearch(query);
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

  let currentSearchQuery = ${JSON.stringify(searchQuery || '')};
  let currentFilterParams = {};
  let currentLoadedDocsCount = ${JSON.stringify(initialSearchResults ? initialSearchResults.length : 0)};
  let totalSearchResults = ${JSON.stringify(initialNumFound || 0)};
  let isLoadingMore = false;
  let currentSearchAbort = null;

  function goHome(e) {
    if (e) e.preventDefault();

    if (hasAudio) {
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

  function minimizePlayer() {
    if (!hasAudio) return;
    const playerCard = document.getElementById('playerCard');
    const miniPlayer = document.getElementById('miniPlayer');
    if (playerCard) playerCard.style.display = 'none';
    if (miniPlayer) miniPlayer.classList.add('visible');
    document.body.classList.add('mini-player-active');

    const searchSection = document.getElementById('searchResultsSection');
    const collSection = document.getElementById('collectionsSection');
    if (searchSection && collSection && searchSection.style.display === 'none' && collSection.style.display === 'none') {
      collSection.style.display = 'block';
    }
  }

  function expandPlayer() {
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
    audio.pause();
    hasAudio = false;
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

  async function executeLiveSearch(query, extraParams = {}) {
    currentSearchQuery = query;
    currentFilterParams = extraParams;
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

    const displayLabel = extraParams.label || ('Searching for "' + query + '"...');
    label.textContent = displayLabel;
    grid.innerHTML = '';
    spinner.style.display = 'block';
    loadMoreBox.style.display = 'none';

    // Update browser URL without reload
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    if (query) newUrl.searchParams.set('search', query);
    else newUrl.searchParams.delete('search');
    newUrl.searchParams.delete('shiurId');
    newUrl.searchParams.delete('id');
    history.pushState({ search: query, ...extraParams }, '', newUrl.toString());

    if (currentSearchAbort) {
      currentSearchAbort.abort();
    }
    currentSearchAbort = new AbortController();

    let apiUrl = '/api/search?q=' + encodeURIComponent(query || '') + '&start=1';
    if (extraParams.teacherId) apiUrl += '&teacherId=' + encodeURIComponent(extraParams.teacherId);
    if (extraParams.locationId) apiUrl += '&locationId=' + encodeURIComponent(extraParams.locationId);
    if (extraParams.subCategoryId) apiUrl += '&subCategoryId=' + encodeURIComponent(extraParams.subCategoryId);
    if (extraParams.seriesId) apiUrl += '&seriesId=' + encodeURIComponent(extraParams.seriesId);

    try {
      const res = await fetch(apiUrl, {
        signal: currentSearchAbort.signal
      });
      const data = await res.json();
      spinner.style.display = 'none';

      const docs = data?.response?.docs || [];
      totalSearchResults = data?.response?.numFound || docs.length;
      currentLoadedDocsCount = docs.length;

      const resultsTitle = extraParams.label
        ? (extraParams.label + ' (' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ')')
        : ('Showing ' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ' results for "' + query + '"');
      label.textContent = resultsTitle;

      if (docs.length === 0) {
        grid.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No shiurim found. Try searching for speaker name, topic, or venue.</div>';
        loadMoreBox.style.display = 'none';
        return;
      }

      grid.innerHTML = docs.map(renderDocToCard).join('');

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

    const nextStart = currentLoadedDocsCount + 1;

    let apiUrl = '/api/search?q=' + encodeURIComponent(currentSearchQuery || '') + '&start=' + nextStart;
    if (currentFilterParams.teacherId) apiUrl += '&teacherId=' + encodeURIComponent(currentFilterParams.teacherId);
    if (currentFilterParams.locationId) apiUrl += '&locationId=' + encodeURIComponent(currentFilterParams.locationId);
    if (currentFilterParams.subCategoryId) apiUrl += '&subCategoryId=' + encodeURIComponent(currentFilterParams.subCategoryId);
    if (currentFilterParams.seriesId) apiUrl += '&seriesId=' + encodeURIComponent(currentFilterParams.seriesId);

    try {
      const res = await fetch(apiUrl);
      const data = await res.json();
      const newDocs = data?.response?.docs || [];

      if (newDocs.length > 0) {
        currentLoadedDocsCount += newDocs.length;
        const grid = document.getElementById('searchResultsGrid');
        grid.insertAdjacentHTML('beforeend', newDocs.map(renderDocToCard).join(''));

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
      btnText.textContent = 'Retry Loading More';
      spinner.style.display = 'none';
    } finally {
      isLoadingMore = false;
    }
  }

  function clearSearch() {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    document.getElementById('searchResultsSection').style.display = 'none';
    document.getElementById('loadMoreContainer').style.display = 'none';
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';

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
    history.pushState({}, '', newUrl.toString());
  }

  function renderDocToCard(d) {
    const id = d.shiurid || d.shiurID || '';
    const title = d.shiurtitle || d.shiurTitle || 'Untitled';
    const speaker = d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : 'YUTorah');
    const photo = d.PHOTO ? (d.PHOTO.startsWith('http') ? d.PHOTO : 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + d.PHOTO) : 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
    const duration = d.durationformatted || (d.duration ? d.duration + ' min' : '');
    const date = d.shiurdateformatted || '';
    const category = (Array.isArray(d.categoryname) && d.categoryname[0]) || (Array.isArray(d.subcategoryname) && d.subcategoryname[0]) || '';

    const metaParts = [];
    if (duration) metaParts.push('⏱ ' + escapeHtml(duration));
    if (date) metaParts.push(escapeHtml(date));
    const bottomMeta = metaParts.join(' · ');

    return '<a href="/' + id + '" class="quick-card-link" onclick="playShiurById(event, this.dataset.id)" data-id="' + id + '">' +
      '<div class="quick-card-top">' +
        '<img class="quick-card-avatar" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(speaker) + '" loading="lazy" onerror="handleImgError(this)">' +
        '<div class="quick-card-info">' +
          '<div class="quick-card-title">' + escapeHtml(title) + '</div>' +
          '<div class="quick-card-speaker">' + escapeHtml(speaker) + '</div>' +
          (category ? '<div class="quick-card-category">' + escapeHtml(category) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="quick-card-bottom">' +
        '<span>' + bottomMeta + '</span>' +
        '<span class="quick-play-badge">▶ Play</span>' +
      '</div>' +
    '</a>';
  }

  // Instant Play by Shiur ID (in-page without reload)
  async function playShiurById(e, id) {
    if (e) e.preventDefault();

    const playerCard = document.getElementById('playerCard');
    playerCard.style.display = 'block';
    playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    document.getElementById('shiurTitle').textContent = 'Loading shiur #' + id + '...';
    document.getElementById('shiurSpeaker').textContent = 'Fetching audio stream...';
    document.getElementById('shiurMeta').textContent = '';
    document.getElementById('shiurDesc').style.display = 'none';

    history.pushState({ shiurId: id }, '', '/' + id);

    try {
      const res = await fetch('/sidebar/lecturedata?shiurID=' + encodeURIComponent(id));
      if (!res.ok) throw new Error('API returned status ' + res.status);
      const data = await res.json();

      const title = data.shiurTitle || 'Untitled Shiur';
      const speaker = data.shiurTeacherFullName || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherFullName : 'YUTorah');
      const photo = data.teacherPhotoURL_lp || data.teacherPhotoURL || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherPhotoURL : '');
      const duration = data.shiurDuration || '';
      const date = data.shiurDateFormatted || '';
      const meta = duration + (date ? ' · ' + date : '');
      const desc = data.shiurDescription || '';
      const audioSrc = data.playerDownloadURL || (data.shiurURL ? 'https://shiurim.yutorah.net' + data.shiurURL : '') || data.downloadURL || '';
      const dlSrc = data.downloadURL || audioSrc;

      document.title = title + ' — YUTorah Enhanced';
      document.getElementById('shiurTitle').textContent = title;
      document.getElementById('shiurSpeaker').textContent = speaker;
      document.getElementById('shiurMeta').textContent = meta;

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
      hasAudio = true;
      initialTimeApplied = false;
      lastUrlUpdateSec = -1;
      lastUrlUpdateTime = 0;

      addRecentHistory({
        id: id,
        title: title,
        speaker: speaker,
        photo: photo,
        duration: duration,
        date: date
      });

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

      // Start playing
      audio.src = audioSrc;
      audio.load();

      if (resumeSec > 0) {
        const onLoaded = function() {
          audio.removeEventListener('loadedmetadata', onLoaded);
          audio.currentTime = resumeSec;
          updateUrlTimestamp(true);
        };
        audio.addEventListener('loadedmetadata', onLoaded);
      }

      const p = audio.play();
      if (p !== undefined) {
        p.catch(err => console.log('Autoplay notification:', err));
      }

      // Update mini player info
      const miniTitle = document.getElementById('miniTitle');
      const miniSpeaker = document.getElementById('miniSpeaker');
      const miniThumb = document.getElementById('miniThumb');
      const miniTime = document.getElementById('miniTime');
      if (miniTitle) miniTitle.textContent = title;
      if (miniSpeaker) miniSpeaker.textContent = speaker;
      if (miniThumb) miniThumb.src = photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
      if (miniTime) miniTime.textContent = '0:00 / ' + (duration || '0:00');

      // Render rich metadata
      renderMetadataBox(data);

      // MediaSession
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title,
          artist: speaker,
          album: 'YUTorah Online',
          artwork: photo ? [{ src: photo, sizes: '300x300', type: 'image/jpeg' }] : []
        });
      }
    } catch (err) {
      console.error('Failed to load shiur:', err);
      document.getElementById('shiurTitle').textContent = 'Error loading shiur #' + id;
      document.getElementById('shiurSpeaker').textContent = 'Please check the ID or try again.';
    }
  }

  function renderMetadataBox(data) {
    const box = document.getElementById('shiurMetadataBox');
    if (!box) return;

    let html = '';
    const teachers = Array.isArray(data.shiurTeachers) ? data.shiurTeachers : [];
    const locations = Array.isArray(data.postedInLocations) ? data.postedInLocations : [];
    const date = data.shiurDateFormatted || '';
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
        category: shiur.category || ''
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
      const metaParts = [];
      if (item.duration) metaParts.push('⏱ ' + escapeHtml(item.duration));
      if (item.date) metaParts.push(escapeHtml(item.date));
      const bottomMeta = metaParts.join(' · ');
      return '<a href="/' + item.id + '" class="quick-card-link" onclick="playShiurById(event, this.dataset.id)" data-id="' + item.id + '">' +
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
          '<span class="quick-play-badge">▶ Resume</span>' +
        '</div>' +
      '</a>';
    }).join('');
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

  // Switch Collection Tabs (All 7 original YUTorah tabs)
  const collections = ['editors', 'series', 'recent', 'viewed', 'parsha', 'daily', 'trending'];
  const collectionTitles = {
    editors: "⭐ Editor's Picks",
    series: "📚 Featured Series",
    recent: "⏱️ Recently Uploaded",
    viewed: "👁️ Recently Viewed",
    parsha: "📖 Parsha Shiurim",
    daily: "📜 Daily Shiur",
    trending: "🔥 Trending Keywords"
  };

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
    }
  }

  // Audio Controls
  function togglePlay() {
    if (!audio.src) {
      // If no audio loaded yet, play the first shiur
      const firstCard = document.querySelector('.quick-card-link');
      if (firstCard) firstCard.click();
      return;
    }
    if (audio.paused) {
      audio.play().catch(e => console.log('Play blocked:', e));
    } else {
      audio.pause();
    }
  }

  function skip(sec) {
    if (!audio.src) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + sec));
    updateUrlTimestamp(true);
  }

  function setSpeed(rate) {
    audio.playbackRate = parseFloat(rate);
  }

  function copyShareLink() {
    const curSec = Math.floor(audio.currentTime);
    const url = new URL(window.location.href);
    url.searchParams.set('t', curSec);
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
    if (!audio.duration || isNaN(audio.duration)) return;
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
  const PLAY_ICON_MINI = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin-left:2px;"><path d="M8 5v14l11-7z"/></svg>';
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
  });
  audio.addEventListener('pause', () => {
    updatePlayPauseIcons(false);
    updateUrlTimestamp(true);
  });
  audio.addEventListener('timeupdate', () => {
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
  });
  audio.addEventListener('loadedmetadata', () => {
    document.getElementById('totalTime').textContent = formatTime(audio.duration);
    const miniTime = document.getElementById('miniTime');
    if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
    applyInitialTime();
  });
  audio.addEventListener('canplay', () => {
    applyInitialTime();
  });
  audio.addEventListener('ended', () => {
    updatePlayPauseIcons(false);
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
      title: ${JSON.stringify(title)},
      artist: ${JSON.stringify(speaker)},
      album: 'YUTorah Online',
      artwork: ${JSON.stringify(photo ? [{ src: photo, sizes: '300x300', type: 'image/jpeg' }] : [])}
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
  }

  initTheme();
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
        }
      });
    }
  } catch(e) {}

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

function renderShiurCardHtml(s) {
  const metaParts = [];
  if (s.duration) metaParts.push('⏱ ' + escapeHtml(s.duration));
  if (s.date) metaParts.push(escapeHtml(s.date));
  const bottomMeta = metaParts.join(' · ');

  return `
    <a href="/${s.id}" class="quick-card-link" onclick="playShiurById(event, this.dataset.id)" data-id="${s.id}">
      <div class="quick-card-top">
        <img class="quick-card-avatar" src="${escapeHtml(s.photo)}" alt="${escapeHtml(s.speaker)}" loading="lazy" onerror="handleImgError(this)">
        <div class="quick-card-info">
          <div class="quick-card-title">${escapeHtml(s.title)}</div>
          <div class="quick-card-speaker">${escapeHtml(s.speaker)}</div>
          ${s.category ? `<div class="quick-card-category">${escapeHtml(s.category)}</div>` : ''}
        </div>
      </div>
      <div class="quick-card-bottom">
        <span>${bottomMeta}</span>
        <span class="quick-play-badge">▶ Play</span>
      </div>
    </a>
  `;
}

function renderSeriesCardHtml(s) {
  const imgUrl = s.imageURL || 'https://cdnyutorah.cachefly.net/_images/series/riets.gif';
  const name = s.name || 'Featured Series';
  const desc = s.description || '';
  const count = s.numShiurim || 0;
  const seriesId = s.seriesID || '';

  return `
    <div class="series-card" onclick="filterBySeries('${seriesId}', '${escapeHtml(name).replace(/'/g, "\\'")}')" title="Explore ${escapeHtml(name)}">
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
