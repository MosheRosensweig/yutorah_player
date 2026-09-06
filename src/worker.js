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

// In-memory cache for live daily sponsorship (10 minutes)
let sponsorshipCache = null;
let sponsorshipCacheTime = 0;

async function getDailySponsorship() {
  const now = Date.now();
  if (sponsorshipCache && (now - sponsorshipCacheTime < 600000)) {
    return sponsorshipCache;
  }
  let result = {
    text: '',
    plainText: '',
    audioUrl: ''
  };

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
        const sponsorName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        const fullText = match[0].replace(/<\/p>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        result.plainText = fullText;
        let formatted = escapeHtml(fullText);
        if (sponsorName && fullText.includes(sponsorName)) {
          const parts = fullText.split(sponsorName);
          formatted = escapeHtml(parts[0]) + '<strong>' + escapeHtml(sponsorName) + '</strong>' + escapeHtml(parts.slice(1).join(sponsorName));
        }
        result.text = formatted;
      }

      // Check if HTML has a non-placeholder audio URL
      const audioMatch = html.match(/_sponsorshipAudioURL\s*=\s*['"]([^'"]+)['"]/i);
      if (audioMatch && audioMatch[1] && audioMatch[1].trim()) {
        let rawUrl = audioMatch[1].trim();
        rawUrl = rawUrl.replace('https://www.yutorah.org/_cdn/', 'https://cdn.yutorah.net/');
        rawUrl = rawUrl.replace('http://www.yutorah.org/_cdn/', 'https://cdn.yutorah.net/');
        if (!rawUrl.includes('112521.mp3')) {
          result.audioUrl = rawUrl;
        }
      }
    }
  } catch (e) {
    console.error('Error fetching live sponsorship:', e);
  }

  // YUTorah uploads daily pre-rolls as MMDDYY.mp3 based on America/New_York calendar date
  try {
    const nyFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = nyFormatter.formatToParts(new Date());
    const mm = parts.find(p => p.type === 'month')?.value;
    const dd = parts.find(p => p.type === 'day')?.value;
    const yy = parts.find(p => p.type === 'year')?.value;

    if (mm && dd && yy) {
      const todayAudio = `https://cdn.yutorah.net/_media/sponsorshipAudio/${mm}${dd}${yy}.mp3`;
      const headCheck = await fetch(todayAudio, { method: 'HEAD', redirect: 'follow' });
      if (headCheck.ok) {
        result.audioUrl = todayAudio;
      }
    }

    // Fallback to yesterday's audio if today's isn't uploaded yet
    if (!result.audioUrl) {
      const yesterday = new Date(Date.now() - 86400000);
      const yParts = nyFormatter.formatToParts(yesterday);
      const ymm = yParts.find(p => p.type === 'month')?.value;
      const ydd = yParts.find(p => p.type === 'day')?.value;
      const yyy = yParts.find(p => p.type === 'year')?.value;
      if (ymm && ydd && yyy) {
        const yAudio = `https://cdn.yutorah.net/_media/sponsorshipAudio/${ymm}${ydd}${yyy}.mp3`;
        const yHead = await fetch(yAudio, { method: 'HEAD', redirect: 'follow' });
        if (yHead.ok) {
          result.audioUrl = yAudio;
        }
      }
    }
  } catch (err) {
    console.error('Error determining daily sponsorship audio URL:', err);
  }

  // Safe fallback if no audio URL could be verified
  if (!result.audioUrl) {
    result.audioUrl = 'https://cdn.yutorah.net/_media/sponsorshipAudio/090626.mp3';
  }

  // Fallback if live fetch fails or no current sponsor
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

    // Pre-fetch homepage collections and live daily sponsorship in parallel
    let sponsorship = { text: '', plainText: '', audioUrl: '' };
    [homepageData, sponsorship] = await Promise.all([
      getHomepageData(),
      getDailySponsorship()
    ]);

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

function renderAppHtml({ shiurData, shiurId, directAudio, timestamp, playbackSpeed = '', themeMode = '', homepageData, sponsorshipText = '', sponsorshipPlainText = '', sponsorshipAudioUrl = '', searchQuery, initialSearchResults, initialNumFound = 0 }) {
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

        // [DEAD CODE / INACTIVE] Simple View mode switcher
        // var savedMode = localStorage.getItem('yutorah_view_mode');
        // if (savedMode === 'simple') document.documentElement.setAttribute('data-view', 'simple');
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
      padding-bottom: var(--sponsor-banner-height, 42px);
    }

    /* Frozen Top Header (Always Fixed to Top of Viewport) */
    header {
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

    /* Sponsorship Banner - Locked to Bottom */
    :root {
      --sponsor-banner-height: 42px;
    }
    @media (max-width: 600px) {
      :root {
        --sponsor-banner-height: 56px;
      }
    }
    .sponsorship-banner {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: linear-gradient(90deg, #fdf8eb 0%, #fffdf7 50%, #fdf8eb 100%);
      border-top: 1px solid #e7d8b5;
      border-bottom: none;
      color: #634d17;
      font-size: 12.5px;
      padding: 7px 16px;
      text-align: center;
      line-height: 1.4;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.08);
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
      border-top: 1px solid #29384e;
      border-bottom: none;
      color: #e8ce8f;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.3);
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
    }
    .sponsor-preroll-progress-wrap {
      margin: 10px 0 8px;
    }
    .sponsor-preroll-progress-track {
      width: 100%;
      height: 6px;
      background: rgba(43, 76, 126, 0.12);
      border-radius: 6px;
      position: relative;
      overflow: visible;
    }
    [data-theme="dark"] .sponsor-preroll-progress-track {
      background: rgba(255, 255, 255, 0.15);
    }
    .sponsor-preroll-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #b8860b 0%, #d4a373 100%);
      border-radius: 6px;
      width: 0%;
      position: relative;
      transition: width 0.15s linear;
    }
    .sponsor-preroll-circle {
      position: absolute;
      right: -7px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      background: #d4a373;
      border: 2px solid #ffffff;
      border-radius: 50%;
      box-shadow: 0 0 8px rgba(212, 163, 115, 0.75), 0 2px 5px rgba(0,0,0,0.25);
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
    [data-theme="dark"] .holiday-motif-wrap,
    [data-theme="dark"] .holiday-tagline-bar {
      display: none !important;
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
      header {
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
    }
    .scrubber-bar.is-sponsor-preroll .scrubber-handle {
      background: #d4a373;
      border-color: #ffffff;
      box-shadow: 0 0 12px rgba(212, 163, 115, 0.85), 0 2px 6px rgba(0,0,0,0.3);
      transform: translateY(-50%) scale(1.2);
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
      bottom: var(--sponsor-banner-height, 42px);
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
      padding-bottom: calc(var(--sponsor-banner-height, 42px) + 64px);
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

<header id="mainHeader">
  <div class="header-inner">
    <a href="/" class="brand" onclick="goHome(event)">
      🎧 YUTorah Enhanced <span>PLAYER</span>
    </a>
    <div class="header-right">
      <div id="holidayMotifWrap" class="holiday-motif-wrap" style="display: none;">
        <span id="holidayMotifIcon" class="holiday-motif-icon"></span>
        <span id="holidayMotifTitle" class="holiday-motif-title"></span>
      </div>
      <!-- [DEAD CODE / TEMPORARILY HIDDEN] Settings button, Simple View switch, and Holiday Theme preview picker -->
      <div class="settings-wrapper" style="display: none !important;" aria-hidden="true">
        <button type="button" id="settingsBtn" class="theme-toggle-btn settings-btn" onclick="toggleSettingsMenu(event)" title="Settings" style="display: none !important;">⚙️</button>
        <div id="settingsMenu" class="settings-menu" style="display: none !important;">
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

<div id="holidayTaglineBar" class="holiday-tagline-bar" style="display: none;"></div>

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
      <button type="button" class="mini-btn-pill" onclick="minimizePlayer()" title="Minimize to mini-player" style="background: #eef2f7; border: 1px solid #dbe2ed; color: var(--primary); font-size: 13px; font-weight: 700; padding: 5px 12px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;"><path d="M7 10l5 5 5-5z"/></svg> Minimize</button>
    </div>

    <!-- Main Shiur Header (Always preserved on top) -->
    <div class="shiur-header">
      <img id="speakerImg" class="speaker-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(speaker)}">
      <div class="shiur-details">
        <h1 id="shiurTitle" class="shiur-title">${escapeHtml(title)}</h1>
        <div id="shiurSpeaker" class="shiur-speaker">${escapeHtml(speaker)}</div>
        <div id="shiurMeta" class="shiur-meta">${escapeHtml(meta)}</div>
      </div>
    </div>

    <!-- Pre-roll Sponsor Overlayment Banner (under title, visible when sponsor audio is playing) -->
    <div id="sponsorPreRollBanner" class="sponsor-preroll-banner" style="display: none;">
      <div class="sponsor-preroll-header">
        <span class="sponsor-preroll-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg> TODAY'S SPONSOR DEDICATION</span>
        <span class="sponsor-preroll-status">🎙️ Audio Dedication Playing</span>
      </div>
      <div class="sponsor-preroll-body" id="sponsorPreRollText">${sponsorshipText || ''}</div>
      <div class="sponsor-preroll-progress-wrap">
        <div class="sponsor-preroll-progress-track">
          <div class="sponsor-preroll-progress-fill" id="sponsorProgressFill">
            <div class="sponsor-preroll-circle"></div>
          </div>
        </div>
      </div>
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
  <p>YUTorah Enhanced Player · Standalone zero-friction audio player for <a href="https://www.yutorah.org" target="_blank" rel="noopener noreferrer">YUTorah.org</a> · <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" style="font-weight: 600;">❤️ Support YUTorah</a></p>
</footer>

<!-- Bottom Locked Sponsorship Dedication Banner -->
<div class="sponsorship-banner">
  <div class="sponsorship-content">
    <span class="sponsorship-text">${sponsorshipText || 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by <strong>The Ohayon family in Hamilton, ON</strong> to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra'}</span>
    <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" class="sponsorship-support-pill" title="Support YUTorah (Opens in new window)">Support YUTorah ↗</a>
  </div>
</div>

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
  let initialPlaybackSpeed = ${JSON.stringify(playbackSpeed || '')};
  let hasAudio = ${JSON.stringify(Boolean(audioUrl))};
  let currentShiurId = ${JSON.stringify(shiurId || '')};
  let initialTimeApplied = false;
  let lastUrlUpdateSec = -1;
  let lastUrlUpdateTime = 0;

  const DAILY_SPONSOR_AUDIO = ${JSON.stringify(sponsorshipAudioUrl || '')};
  const DAILY_SPONSOR_TEXT = ${JSON.stringify(sponsorshipText || '')};
  const DAILY_SPONSOR_PLAIN = ${JSON.stringify(sponsorshipPlainText || '')};

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

  // Secret Triple-Click on Calendar Icon to Toggle Pre-roll
  let calendarClickCount = 0;
  let calendarClickTimer = null;
  let toastTimer = null;

  function handleCalendarSecretClick(e) {
    if (e) {
      e.stopPropagation();
    }
    calendarClickCount++;
    clearTimeout(calendarClickTimer);

    if (calendarClickCount >= 3) {
      calendarClickCount = 0;
      togglePreRollSetting();
    } else {
      // 1 or 2 clicks have zero visual effect; reset counter after 1.5s
      calendarClickTimer = setTimeout(() => {
        calendarClickCount = 0;
      }, 1500);
    }
  }

  function togglePreRollSetting() {
    const currentlyDisabled = isPreRollDisabled();
    const newDisabled = !currentlyDisabled;

    try {
      if (newDisabled) {
        localStorage.setItem('yutorah_preroll_disabled', '1');
      } else {
        localStorage.removeItem('yutorah_preroll_disabled');
      }
    } catch(e) {}

    // If currently playing sponsor audio and user disabled it, immediately skip to shiur!
    if (newDisabled && isSponsorPlaying && pendingShiur) {
      skipSponsorAudio();
    }

    flashToast(newDisabled ? '🚫 Pre-roll Disabled' : '✅ Pre-roll Enabled', newDisabled);
  }

  function flashToast(msg, isDisabled) {
    const toast = document.getElementById('secretToast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = 'secret-toast ' + (isDisabled ? 'toast-disabled' : 'toast-enabled');
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
    }, 1500);
  }

  let isSponsorPlaying = false;
  let sponsorPlayedForThisShiur = false;
  let pendingShiur = null;

  if (hasAudio && currentShiurId) {
    pendingShiur = {
      id: currentShiurId,
      title: ${JSON.stringify(title || '')},
      speaker: ${JSON.stringify(speaker || '')},
      photo: ${JSON.stringify(photo || '')},
      duration: ${JSON.stringify(duration || '')},
      meta: ${JSON.stringify(meta || '')},
      desc: ${JSON.stringify(description || '')},
      audioSrc: ${JSON.stringify(audioUrl || '')},
      dlSrc: ${JSON.stringify(audioUrl || '')},
      resumeSec: parseFloat(initialTimestamp) || 0
    };
  }

  function playSponsorPreRoll(shiurObj) {
    if (isPreRollDisabled() || !currentSponsorAudio) {
      startShiurPlayback(shiurObj);
      return;
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

    const curTimeEl = document.getElementById('curTime');
    if (curTimeEl) curTimeEl.textContent = '0:00';
    const totalTimeEl = document.getElementById('totalTime');
    if (totalTimeEl) totalTimeEl.textContent = '0:12';
    const scrubberBar = document.getElementById('scrubberBar');
    if (scrubberBar) scrubberBar.classList.add('is-sponsor-preroll');
    const scrubberFill = document.getElementById('scrubberFill');
    if (scrubberFill) scrubberFill.style.width = '0%';
    const sponsorProgressFill = document.getElementById('sponsorProgressFill');
    if (sponsorProgressFill) sponsorProgressFill.style.width = '0%';

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
    if (miniTime) miniTime.textContent = '0:00 / 0:12';

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

    const p = audio.play();
    if (p !== undefined) {
      p.catch(err => {
        console.log('Autoplay sponsor prevented or error:', err);
      });
    }
  }

  function skipSponsorAudio() {
    if (!isSponsorPlaying || !pendingShiur) return;
    startShiurPlayback(pendingShiur);
  }

  function startShiurPlayback(shiurObj) {
    isSponsorPlaying = false;
    sponsorPlayedForThisShiur = true;

    const banner = document.getElementById('sponsorPreRollBanner');
    if (banner) banner.style.display = 'none';

    const scrubberBar = document.getElementById('scrubberBar');
    if (scrubberBar) scrubberBar.classList.remove('is-sponsor-preroll');

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

      const shiurObj = {
        id: id,
        title: title,
        speaker: speaker,
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

      // Render rich metadata immediately
      renderMetadataBox(data);

      if (currentSponsorAudio && !isPreRollDisabled()) {
        playSponsorPreRoll(shiurObj);
      } else {
        startShiurPlayback(shiurObj);
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

  // Switch Collection Tabs
  const collections = ['editors', 'series', 'recent', 'popular', 'viewed', 'parsha', 'daily', 'trending'];
  const collectionTitles = {
    editors: "⭐ Editor's Picks",
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
  const clientThemes = ${JSON.stringify(THEMES)};

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

    if (isDark) {
      if (motifWrap) motifWrap.style.display = 'none';
      if (taglineBar) taglineBar.style.display = 'none';
      return;
    }

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

    // Apply CSS Variables to root
    if (variantData.primary) document.documentElement.style.setProperty('--primary', variantData.primary);
    if (variantData.accent) document.documentElement.style.setProperty('--accent', variantData.accent);
    if (variantData.bannerBg) document.documentElement.style.setProperty('--banner-bg', variantData.bannerBg);

    // Render Motif Badge in Header
    if (motifWrap && motifIcon && motifTitle) {
      motifWrap.style.display = 'inline-flex';
      motifIcon.innerHTML = '<img src="/assets/themes/' + variantData.icon + '" alt="icon" style="width:100%; height:100%; display:block;" onerror="this.style.display=&quot;none&quot;">';
      motifTitle.textContent = themeDef.badge || themeDef.name;
      motifWrap.title = variantData.title;
    }

    // Render Tagline Bar below sponsorship banner
    if (taglineBar && variantData.tagline) {
      taglineBar.style.display = 'block';
      taglineBar.textContent = variantData.tagline;
    } else if (taglineBar) {
      taglineBar.style.display = 'none';
    }

    // Inject custom CSS for theme variant
    if (variantData.css) {
      themeStyleEl = document.createElement('style');
      themeStyleEl.id = 'holidayThemeDynamicStyles';
      themeStyleEl.textContent = variantData.css;
      document.head.appendChild(themeStyleEl);
    }

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
    if (isSponsorPlaying) return;
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
    if (isSponsorPlaying) {
      if (audio.duration && !isNaN(audio.duration)) {
        const rem = Math.max(0, Math.ceil(audio.duration - audio.currentTime));
        const countdownEl = document.getElementById('sponsorCountdown');
        if (countdownEl) countdownEl.textContent = rem;
        const pct = (audio.currentTime / audio.duration) * 100;
        if (scrubberFill) scrubberFill.style.width = pct + '%';
        curTimeEl.textContent = formatTime(audio.currentTime);
        document.getElementById('totalTime').textContent = formatTime(audio.duration);
        const sponsorFill = document.getElementById('sponsorProgressFill');
        if (sponsorFill) sponsorFill.style.width = pct + '%';
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
  });
  audio.addEventListener('loadedmetadata', () => {
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    document.getElementById('totalTime').textContent = formatTime(audio.duration);
    const miniTime = document.getElementById('miniTime');
    if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
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

  function syncSponsorshipHeight() {
    var b = document.querySelector('.sponsorship-banner');
    if (b) {
      var h = b.offsetHeight;
      if (h > 0) {
        document.documentElement.style.setProperty('--sponsor-banner-height', h + 'px');
      }
    }
  }
  syncSponsorshipHeight();
  window.addEventListener('resize', syncSponsorshipHeight);

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
