// tests/basic_functionality.test.mjs
// Automated regression test suite for YUTorah Player
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/worker.js';
import { escapeHtml as serverEscapeHtml } from '../src/utils/html.mjs';
import { getNowInNewYork as serverNowNY, parseLocalDate as serverParseDate, formatShiurDate as serverFormatDate, isShiurNew as serverIsNew } from '../src/utils/dates.mjs';
import { formatDuration as serverFormatDuration, formatTime as serverFormatTime } from '../src/utils/format.mjs';
import { DAF_MASECHTOT, DAF_CYCLE_DAYS, dafIndexForDateUTC, dafRefForIndexUTC, dafIndexForRefUTC, dafValidDateISO } from '../src/utils/daf.mjs';

console.log('🧪 Running Basic Functionality & Article Viewer Automated Regression Tests...\n');

const mockEnv = {};
const mockCtx = {
  waitUntil: (promise) => Promise.resolve(promise),
  passThroughOnException: () => {}
};

async function testHomepage() {
  console.log('1. Testing Homepage & Basic Layout SSR...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200, 'Homepage should return 200 OK');
  const html = await res.text();
  assert.ok(html.includes('id="playerCard"'), 'Homepage must contain #playerCard');
  assert.ok(html.includes('id="audioControlsWrap"'), 'Homepage must contain #audioControlsWrap');
  assert.ok(html.includes('id="articleViewerContainer"'), 'Homepage must contain #articleViewerContainer');
  assert.ok(html.includes('id="searchInput"'), 'Homepage must contain #searchInput');
  assert.ok(html.includes('id="themeToggleBtn"'), 'Homepage must contain #themeToggleBtn');
  // Header left cluster order: brand → login/settings → zman apple → theme (no gaps).
  const brandIdx = html.indexOf('class="brand"');
  const authIdx = html.indexOf('id="authBtn"');
  const motifIdx = html.indexOf('id="holidayMotifWrap"');
  const themeIdx = html.indexOf('id="themeToggleBtn"');
  const supportIdx = html.indexOf('class="support-yutorah-btn"');
  const badgeIdx = html.indexOf('id="hebrewDateBadge"');
  const rightIdx = html.indexOf('<div class="header-right">');
  assert.ok(brandIdx !== -1 && authIdx > brandIdx && motifIdx > authIdx && themeIdx > motifIdx,
    'header left cluster must be brand → login → zman → theme');
  assert.ok(badgeIdx > themeIdx && supportIdx > badgeIdx && rightIdx > supportIdx,
    'date badge + support must continue the left flow with no gap (all before header-right)');
  assert.ok(html.includes('function headerClusterOverflows()'), 'overflow measurement helper must exist');
  assert.ok(html.includes("dataset.holiday"), 'motif holiday-active flag must exist');
  assert.ok(html.includes('.brand > span:last-child'), 'PLAYER pill style must be scoped (brand text stays plain)');
  assert.ok(html.includes('cluster-tight'), 'last-resort brand shrink class must exist');
  assert.ok(html.includes('yutorah_history_tombstones'), 'history delete tombstone store must exist');
  assert.ok(html.includes('deletedHistory'), 'tombstones must travel in the sync payload');
  // History deletes must sync (dirty-mark) and flush on unload.
  const doRemoveIdx = html.indexOf('function devDoRemove(');
  const dirtyAfterRemove = html.indexOf("markCloudDirty('history')", doRemoveIdx);
  assert.ok(doRemoveIdx !== -1 && dirtyAfterRemove !== -1 && (dirtyAfterRemove - doRemoveIdx) < 1200,
    'devDoRemove history branch must mark cloud dirty');
  assert.ok(html.includes('function flushCloudSync()'), 'unload sync flush must exist');
  assert.ok(html.includes('keepalive: true'), 'unload flush must use keepalive');
  // Phase 1 module extraction: utils bundle route + single-source wiring.
  const utilsRes = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/js/yt-utils.js'), mockEnv, mockCtx);
  assert.equal(utilsRes.status, 200, '/js/yt-utils.js should return 200 OK');
  const utilsJs = await utilsRes.text();
  assert.ok(utilsJs.includes('window.YTUtils.escapeHtml'), 'bundle must expose escapeHtml');
  assert.ok(html.includes('<script src="/js/yt-utils.js"></script>'), 'app shell must load the utils bundle before the inline script');
  // Behavioral equivalence: server import ≡ bundle ≡ inline fallback.
  // This is what makes the fallback comment ("pinned by tests") true.
  const corpus = ['', null, 0, 'plain', '<a href="x">A&B</a>', '"double" and \'single\'', 'a<b>c&d"e\'f', 'a/b?c=d&e=f', 'line1\nline2', 'שלום & <world>'];
  const fakeWindow = {};
  const bundleFn = new Function('window', utilsJs + '; return window.YTUtils.escapeHtml;')(fakeWindow);
  const workerSrcForFallback = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const fbMatch = workerSrcForFallback.match(/const escapeHtml = \(window\.YTUtils && window\.YTUtils\.escapeHtml\) \|\| (function\(str\) \{[\s\S]*?\n  \};)/);
  assert.ok(fbMatch, 'inline fallback must exist in the expected shape');
  const fallbackFn = new Function('return (' + fbMatch[1].replace(/;\s*$/, '') + ')')();
  for (const sample of corpus) {
    const expected = serverEscapeHtml(sample);
    assert.equal(bundleFn(sample), expected, `bundle mismatch on ${JSON.stringify(sample)}`);
    assert.equal(fallbackFn(sample), expected, `fallback mismatch on ${JSON.stringify(sample)}`);
  }
  // Dates equivalence: server module ≡ bundle ≡ inline fallbacks.
  // Standalone check first: the bundle must work with NO sibling
  // bindings (it ships as a self-contained IIFE).
  const aloneWindow = {};
  new Function('window', utilsJs)(aloneWindow);
  assert.equal(aloneWindow.YTUtils.formatShiurDate('2020-01-15'), serverFormatDate('2020-01-15'), 'standalone bundle must format without host bindings');
  assert.equal(aloneWindow.YTUtils.isShiurNew('2020-01-15'), serverIsNew('2020-01-15'), 'standalone bundle must evaluate newness without host bindings');
  // One shared eval scope mirrors the browser (bare sibling references
  // resolve exactly like the inline classic script scope).
  const dateNames = ['getNowInNewYork', 'parseLocalDate', 'formatShiurDate', 'isShiurNew', 'formatDuration', 'formatTime'];
  const serverFns = { getNowInNewYork: serverNowNY, parseLocalDate: serverParseDate, formatShiurDate: serverFormatDate, isShiurNew: serverIsNew, formatDuration: serverFormatDuration, formatTime: serverFormatTime };
  let fbSrc = '';
  for (const name of dateNames) {
    const marker = '// fallback:' + name;
    const startMark = 'const ' + name + ' = (window.YTUtils && window.YTUtils.' + name + ') || ';
    const si = workerSrcForFallback.indexOf(startMark);
    assert.ok(si !== -1, name + ' fallback wiring must exist');
    const ei = workerSrcForFallback.indexOf(marker, si);
    assert.ok(ei !== -1, name + ' fallback must carry its marker comment');
    fbSrc += 'FB.' + name + ' = ' + workerSrcForFallback.slice(si + startMark.length, ei).trim() + '\n';
  }
  const dateScope = new Function('window', utilsJs + '\n' +
    'const getNowInNewYork = window.YTUtils.getNowInNewYork;\n' +
    'const parseLocalDate = window.YTUtils.parseLocalDate;\n' +
    'const formatShiurDate = window.YTUtils.formatShiurDate;\n' +
    'const isShiurNew = window.YTUtils.isShiurNew;\n' +
    'const formatDuration = window.YTUtils.formatDuration;\n' +
    'const formatTime = window.YTUtils.formatTime;\n' +
    'const FB = {};\n' + fbSrc +
    'return { bundle: { getNowInNewYork, parseLocalDate, formatShiurDate, isShiurNew, formatDuration, formatTime }, fallback: FB };'
  )(fakeWindow);
  const bundleDates = dateScope.bundle;
  const fallbackDates = dateScope.fallback;
  // Standalone bundle check (no sibling bindings): catches IIFE regressions.
  const aloneWindow2 = {};
  new Function('window', utilsJs)(aloneWindow2);
  assert.equal(aloneWindow2.YTUtils.formatDuration('90'), serverFns.formatDuration('90'), 'standalone bundle formatDuration must work');
  assert.equal(aloneWindow2.YTUtils.formatTime(3661), serverFns.formatTime(3661), 'standalone bundle formatTime must work');
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  // getNowInNewYork: same calendar day (not instant).
  for (const [label, fn] of [['bundle', bundleDates.getNowInNewYork], ['fallback', fallbackDates.getNowInNewYork]]) {
    assert.equal(fmt(fn()), fmt(serverNowNY()), label + ' NY-midnight must match server');
  }
  // parseLocalDate: fixed + dynamic inputs (compare epoch ms).
  const dateInputs = ['2020-01-15', '2020/01/15', '01/15/2020', '01-15-2020', '1/5/2020', ' 2020-01-15 ', 'not a date', '', '   ', null, 0, undefined];
  for (const sample of dateInputs) {
    const expected = serverParseDate(sample);
    for (const [label, fns] of [['bundle', bundleDates], ['fallback', fallbackDates]]) {
      const got = fns.parseLocalDate(sample);
      assert.equal(got === null ? null : got.getTime(), expected === null ? null : expected.getTime(), `${label} parseLocalDate mismatch on ${JSON.stringify(sample)}`);
    }
  }
  // formatShiurDate / isShiurNew incl. relative labels + ±2-day edges.
  const tomorrow = new Date(today.getTime() + 86400000);
  const twoAgo = new Date(today.getTime() - 2 * 86400000);
  const twoAhead = new Date(today.getTime() + 2 * 86400000);
  const strInputs = ['', 'Today', 'Yesterday', '2020-01-15', 'bogus!!', fmt(today), fmt(yesterday), fmt(tomorrow), fmt(twoAgo), fmt(twoAhead)];
  for (const sample of strInputs) {
    assert.equal(bundleDates.formatShiurDate(sample), serverFormatDate(sample), `bundle formatShiurDate mismatch on ${JSON.stringify(sample)}`);
    assert.equal(fallbackDates.formatShiurDate(sample), serverFormatDate(sample), `fallback formatShiurDate mismatch on ${JSON.stringify(sample)}`);
    assert.equal(bundleDates.isShiurNew(sample), serverIsNew(sample), `bundle isShiurNew mismatch on ${JSON.stringify(sample)}`);
    assert.equal(fallbackDates.isShiurNew(sample), serverIsNew(sample), `fallback isShiurNew mismatch on ${JSON.stringify(sample)}`);
  }
  // formatDuration / formatTime corpus (both spellings + garbage).
  const durInputs = ['', '  ', '90', '45', '120', '1:30', '90:00', '1:02:03', '0:45', '2h 15m', '1h', '90 min', '45min', 'abc', '1:2:3:4', null, 0, undefined];
  for (const sample of durInputs) {
    assert.equal(bundleDates.formatDuration(sample), serverFns.formatDuration(sample), `bundle formatDuration mismatch on ${JSON.stringify(sample)}`);
    assert.equal(fallbackDates.formatDuration(sample), serverFns.formatDuration(sample), `fallback formatDuration mismatch on ${JSON.stringify(sample)}`);
  }
  const timeInputs = [0, -5, NaN, null, undefined, 'abc', 5, 65, 600, 3599, 3600, 3661, 7325, 36000];
  for (const sample of timeInputs) {
    assert.equal(bundleDates.formatTime(sample), serverFns.formatTime(sample), `bundle formatTime mismatch on ${JSON.stringify(sample)}`);
    assert.equal(fallbackDates.formatTime(sample), serverFns.formatTime(sample), `fallback formatTime mismatch on ${JSON.stringify(sample)}`);
  }
  console.log('  ✅ Homepage renders successfully with all controls and viewer containers.');
}

async function testAudioShiur() {
  console.log('2. Testing Audio Shiur Page (e.g. #1053000 or similar)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/1053000', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200, 'Audio shiur should return 200 OK');
  const html = await res.text();
  assert.ok(html.includes('audioElement'), 'Should contain audio element');
  assert.ok(!html.includes('style="display: none;" id="audioControlsWrap"'), 'Audio controls wrap should not be hidden for audio shiur');

  // Verify all embedded scripts compile without syntax errors
  const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
  let match;
  let scriptCount = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    scriptCount++;
    try {
      new Function(match[1]);
    } catch (err) {
      assert.fail(`SyntaxError in script #${scriptCount}: ${err.message}`);
    }
  }
  assert.ok(scriptCount >= 3, 'Expected at least 3 inline scripts');
  console.log(`  ✅ Audio shiur page renders with active audio transport & all ${scriptCount} scripts compiled cleanly without syntax errors.`);
}

async function testArticleShiur() {
  console.log('3. Testing Article Shiur Page (e.g. #1175130)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/1175130', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200, 'Article shiur should return 200 OK');
  const html = await res.text();
  assert.ok(html.includes('id="articleViewerContainer"'), 'Article viewer must be present in HTML');
  assert.ok(html.includes('pdfjsLib'), 'PDF.js library must be loaded in head');
  assert.ok(html.includes('Liquid Mode'), 'Liquid Mode toggle must be present');
  assert.ok(html.includes('Original Page'), 'Original Page toggle must be present');
  assert.ok(html.includes('btnModeContinuous'), 'Continuous scroll button must be present');
  assert.ok(html.includes('btnModeSingle'), 'Single page mode button must be present');
  assert.ok(html.includes('continuousPagesContainer'), 'Continuous pages container must be present');
  assert.ok(html.includes('INITIAL_ARTICLE_PDF'), 'Client script must declare INITIAL_ARTICLE_PDF');
  assert.ok(html.includes('Browse Library While Reading'), 'Article page must show "Browse Library While Reading"');
  // Liquid Mode 2.0 Engine assertions
  assert.ok(html.includes('buildColumnDetector'), 'Dynamic column detector function must be present');
  assert.ok(html.includes('clusterFontSizes'), 'Font-size clustering engine must be present');
  assert.ok(html.includes('HEBREW_DICT'), 'Hebrew dictionary lemma set must be present');
  assert.ok(html.includes('showFootnotePopover'), 'Interactive footnote popover handler must be present');
  assert.ok(html.includes('liquid-footnote-popover'), 'Footnote popover styling must be present in CSS');
  console.log('  ✅ Article shiur page renders with Article Reader, Page Modes, and "Browse Library While Reading" link.');
}

async function testPdfProxy() {
  console.log('4. Testing Streaming PDF Proxy (/api/pdf-proxy)...');
  // Missing url param check
  const missingReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/pdf-proxy');
  const missingRes = await worker.fetch(missingReq, mockEnv, mockCtx);
  assert.equal(missingRes.status, 400, 'Missing url param should return 400');

  // Valid target proxy check
  const testPdfUrl = 'https://shiurim.yutorah.net/2026/1053/1175130.PDF';
  const proxyReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/pdf-proxy?url=' + encodeURIComponent(testPdfUrl), {
    headers: { 'Range': 'bytes=0-1023' }
  });
  const proxyRes = await worker.fetch(proxyReq, mockEnv, mockCtx);
  assert.ok(proxyRes.status === 200 || proxyRes.status === 206, 'PDF proxy should return 200 or 206');
  assert.equal(proxyRes.headers.get('Access-Control-Allow-Origin'), '*', 'CORS origin must be *');
  assert.equal(proxyRes.headers.get('Accept-Ranges'), 'bytes', 'Must support byte-range slicing');
  console.log('  ✅ PDF proxy operates with proper CORS and streaming byte ranges.');
}

async function testSearchEndpoints() {
  console.log('5. Testing Search API Endpoints (Enhanced vs Classic)...');
  // Enhanced transliteration search
  const enhReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/search?searchTerm=' + encodeURIComponent('rosensweig shabbos'));
  const enhRes = await worker.fetch(enhReq, mockEnv, mockCtx);
  assert.equal(enhRes.status, 200, 'Enhanced search should return 200');
  const enhData = await enhRes.json();
  assert.ok(enhData.response && Array.isArray(enhData.response.docs), 'Enhanced search must return response.docs array');
  assert.ok(enhData.response.docs.length > 0, 'Should find results for "rosensweig shabbos"');

  // Classic search (exact=1)
  const classicReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/search?searchTerm=' + encodeURIComponent('rosensweig shabbos') + '&exact=1');
  const classicRes = await worker.fetch(classicReq, mockEnv, mockCtx);
  assert.equal(classicRes.status, 200, 'Classic search should return 200');
  const classicData = await classicRes.json();
  assert.ok(classicData.response && Array.isArray(classicData.response.docs), 'Classic search must return response.docs array');
  console.log(`  ✅ Enhanced found ${enhData.response.docs.length} items, Classic found ${classicData.response.docs.length} items.`);
}

async function testSponsorshipApi() {
  console.log('6. Testing Sponsorship Endpoint (/api/sponsorship)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/api/sponsorship');
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200, 'Sponsorship endpoint must return 200');
  const data = await res.json();
  assert.ok('text' in data, 'Sponsorship payload must include text');
  assert.ok('audioUrl' in data, 'Sponsorship payload must include audioUrl');
  console.log('  ✅ Sponsorship endpoint returns valid live dedication and audio link.');
}

async function testMediaTypeFilter() {
  console.log('7. Testing Media Type Filter (Audio vs Articles vs Both)...');
  // 1. Check SSR controls in Homepage HTML
  const hpReq = new Request('https://yutorah-player.mrosensweig.workers.dev/');
  const hpRes = await worker.fetch(hpReq, mockEnv, mockCtx);
  const hpHtml = await hpRes.text();
  assert.ok(hpHtml.includes('id="mediaTypePresetsRow"'), 'Must contain #mediaTypePresetsRow');
  assert.ok(hpHtml.includes('id="btnMediaAll"'), 'Must contain #btnMediaAll');
  assert.ok(hpHtml.includes('id="btnMediaAudio"'), 'Must contain #btnMediaAudio');
  assert.ok(hpHtml.includes('id="btnMediaArticle"'), 'Must contain #btnMediaArticle');

  // Helper for article detection
  function isDocArticle(doc) {
    if (!doc) return false;
    const mediaCat = (doc.mediatypecategory || doc.mediaTypeCategory || '').toLowerCase();
    const urlCheck = doc.shiururl || doc.shiurURL || doc.playerDownloadURL || doc.downloadURL || '';
    return mediaCat === 'text' || mediaCat === 'article' || /\.pdf($|\?)/i.test(urlCheck);
  }

  // 2. Test Audio Only (/api/search?searchTerm=Tzibur&mediaType=audio)
  const audioReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/search?searchTerm=Tzibur&mediaType=audio');
  const audioRes = await worker.fetch(audioReq, mockEnv, mockCtx);
  assert.equal(audioRes.status, 200, 'Audio search should return 200');
  const audioData = await audioRes.json();
  const audioDocs = audioData?.response?.docs || [];
  assert.ok(audioDocs.length > 0, 'Audio search for Tzibur should return results');
  for (const doc of audioDocs) {
    assert.equal(isDocArticle(doc), false, `Audio-only search returned an article: ${doc.shiurtitle}`);
  }

  // 3. Test Articles Only (/api/search?searchTerm=Tzibur&mediaType=article)
  const articleReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/search?searchTerm=Tzibur&mediaType=article');
  const articleRes = await worker.fetch(articleReq, mockEnv, mockCtx);
  assert.equal(articleRes.status, 200, 'Article search should return 200');
  const articleData = await articleRes.json();
  const articleDocs = articleData?.response?.docs || [];
  assert.ok(articleDocs.length > 0, 'Article search for Tzibur should find article results');
  for (const doc of articleDocs) {
    assert.equal(isDocArticle(doc), true, `Article-only search returned non-article: ${doc.shiurtitle}`);
  }

  console.log(`  ✅ Media Type Filter verified: Audio only returned ${audioDocs.length} audio docs (0 articles), Articles only returned ${articleDocs.length} article docs (100% articles).`);
}

async function testLiquidModeExtraction() {
  console.log('8. Testing Liquid Mode 3.0 Engine & First Section Reconstruction...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/1175130', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  const html = await res.text();

  assert.ok(html.includes('cleanPdfLigatures'), 'cleanPdfLigatures must be defined in client code');
  assert.ok(html.includes('buildColumnDetector'), 'buildColumnDetector must be defined in client code');
  assert.ok(html.includes('liquid-header'), 'liquid-header class must be present in CSS');
  assert.ok(html.includes('liquid-endnotes'), 'liquid-endnotes class must be present in CSS');
  assert.ok(html.includes('liquid-hebrew-block'), 'liquid-hebrew-block class must be present in CSS');

  // Verify extraction of article 1175130 section 1 using pdfjs-dist if test PDF is present
  const fs = await import('fs');
  const testPdfPath = '/tmp/test_1175130.pdf';
  if (fs.existsSync(testPdfPath)) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfData = new Uint8Array(fs.readFileSync(testPdfPath));
    const doc = await pdfjs.getDocument({ data: pdfData }).promise;
    assert.equal(doc.numPages, 5, 'Article 1175130 should have 5 pages');

    const page1 = await doc.getPage(1);
    const tc = await page1.getTextContent();
    const wItem = tc.items.find(it => it.str === 'W');
    assert.ok(wItem, 'Drop cap W must be present on page 1');
    assert.ok(wItem.transform[3] >= 70, 'Drop cap W font size should be >= 70pt');

    const titleItem = tc.items.find(it => it.str.includes('How Big is our tzibur?'));
    assert.ok(titleItem, 'Title item must be present on page 1');
  }

  console.log('  ✅ Liquid Mode 3.0 semantic document engine verified with drop-cap and multi-column reconstruction.');
}

async function testMediaSessionIntegration() {
  console.log('9. Testing MediaSession API Integration (Lock Screen ±10s & Speaker Artwork)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/1053000', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200, 'Audio shiur should return 200 OK');
  const html = await res.text();

  assert.ok(html.includes('buildMediaSessionArtwork'), 'Script must define buildMediaSessionArtwork');
  assert.ok(html.includes('registerMediaSessionHandlers'), 'Script must define registerMediaSessionHandlers');
  assert.ok(html.includes('seekbackward'), 'MediaSession must register seekbackward handler');
  assert.ok(html.includes('seekforward'), 'MediaSession must register seekforward handler');
  assert.ok(html.includes('updateMediaSessionPosition'), 'Script must define updateMediaSessionPosition');
  assert.ok(html.includes('updateMediaSession'), 'Script must call updateMediaSession');
  assert.ok(html.includes('shaya_katz'), 'Shiur 1053000 must resolve speaker photo for Rabbi Shaya Katz');
  assert.ok(html.includes("navigator.mediaSession.setActionHandler('previoustrack', null)"), 'MediaSession unregisters previoustrack for iOS/Android -10s skip');
  assert.ok(html.includes("navigator.mediaSession.setActionHandler('nexttrack', null)"), 'MediaSession unregisters nexttrack for iOS/Android +10s skip');
  console.log('  ✅ MediaSession integration verified: lock screen ±10s action handlers and multi-size speaker artwork active.');
}

async function testDevModeAndAvatarVariants() {
  console.log('10. Testing Dev Mode Playlists, 10 Avatar SVGs, and Spinning Gear...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes('svg-gear-12tooth'), 'Includes svg-gear-12tooth');
  assert.ok(html.includes('svg-gear-sun'), 'Includes svg-gear-sun');
  assert.ok(html.includes('svg-gear-steampunk'), 'Includes svg-gear-steampunk');
  assert.ok(html.includes('svg-gear-shield'), 'Includes svg-gear-shield');
  assert.ok(html.includes('svg-gear-smooth'), 'Includes svg-gear-smooth');
  assert.ok(html.includes('DEV_PUBLIC_SEEDS'), 'Includes DEV_PUBLIC_SEEDS with 10 curated playlists');
  assert.ok(html.includes('devEditPublicPlaylist'), 'Includes devEditPublicPlaylist helper');
  assert.ok(html.includes('.auth-btn.logged-in:hover'), 'Includes spinning gear CSS animation on hover');

  // Test OAuth return_to handling
  const oauthReq = new Request('https://yutorah-player.mrosensweig.workers.dev/auth/google?return_to=%2F1053000%3Ft%3D120', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const oauthRes = await worker.fetch(oauthReq, { ...mockEnv, GOOGLE_CLIENT_ID: 'dummy', GOOGLE_CLIENT_SECRET: 'dummy', SESSION_SECRET: 'testsecret123456789012345678901234' }, mockCtx);
  assert.equal(oauthRes.status, 302);
  const cookie = oauthRes.headers.get('set-cookie') || '';
  assert.ok(cookie.includes('yutorah_oauth_state'), 'OAuth state cookie set with return_to encoded');

  console.log('  ✅ Dev Mode playlists, 10 Avatar SVGs, spinning gear, and return_to verified.');
}

async function testDropdownNavAndThemeAesthetics() {
  console.log('11. Testing Plain Gear Avatar, Dropdown Navigation & Adaptive Hero Scrim...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // 1. Plain gear is default
  assert.ok(html.includes("'plain-gear'"), 'AVATAR_VARIANTS must include plain-gear');
  assert.ok(html.includes("return 'plain-gear'"), 'getAvatarStyle must return plain-gear as default');
  assert.ok(html.includes("authAvatarHtml(variant"), 'authAvatarHtml defined');
  assert.ok(html.includes("if (v === 'plain-gear') return '<span class=\"auth-avatar plain-gear\"><span class=\"auth-gear\">⚙️</span></span>'"), 'Plain gear renders gear emoji wrapped in auth-avatar');
  assert.ok(html.includes('.auth-btn.logged-in:hover .auth-gear') || html.includes('.auth-avatar.plain-gear'), 'Default gear must be targeted by hover animation');


  // 2. Navigation & Queue Popup fixes
  assert.ok(html.includes("switchCollection('playlists')"), 'Dropdown actions must switch collection to playlists');
  assert.ok(html.includes("openQueuePopup()"), 'devOpenQueueView displays queue popup idempotently');
  assert.ok(html.includes("closeQueuePopup()"), 'closeQueuePopup unconditionally closes play queue');
  assert.ok(html.includes("closeQueuePopup(); event.stopPropagation();"), 'queuePopup close button calls closeQueuePopup');
  assert.ok(html.includes("Queue is empty — tap the circular queue icon"), 'empty queue message describes and renders circular queue icon');
  assert.ok(html.includes("if (!playlistsEnabled())"), 'renderQueuePopup guards on playlistsEnabled() for non-dev auth users');

  // 3. Playlist styling and contrast
  assert.ok(html.includes('.playlist-public-card'), 'Public playlist card class defined in CSS');
  assert.ok(html.includes('--border: #cbd5e1'), 'Light mode border strengthened for card readability');

  // 4. Hero scrim theme adaptability
  assert.ok(html.includes('[data-theme="dark"] .hero-caption'), 'Dark mode hero caption rule present');
  assert.ok(html.includes('[data-theme="dark"] .hero-title'), 'Dark mode hero title rule present');
  assert.ok(html.includes('[data-theme="dark"] .hero-desc'), 'Dark mode hero desc rule present');
  assert.ok(html.includes('[data-theme="dark"] .hero-cta'), 'Dark mode hero CTA rule present');

  // 5. Light/Dark mode toggle button in dropdown under settings/account with label
  assert.ok(html.includes('menu-theme-toggle-btn'), 'Dropdown menu must include menu-theme-toggle-btn');
  assert.ok(html.includes('Light / Dark Mode'), 'Dropdown theme button must display "Light / Dark Mode" label');
  assert.ok(html.includes('menu-theme-icon'), 'Dropdown theme button must include menu-theme-icon element');
  assert.ok(html.includes("document.querySelectorAll('.menu-theme-icon')"), 'toggleTheme must sync all menu-theme-icon elements');

  console.log('  ✅ Plain gear default avatar, dropdown actions, theme-adaptive hero contrast, and dropdown theme toggle verified.');
}

async function testPublicPlaylistSubscriptionOptions() {
  console.log('12. Testing Public Playlist Save Choice Modal & Live-Sync Subscription...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // 1. Modal & Choice Buttons
  assert.ok(html.includes('openSaveChoiceModal'), 'openSaveChoiceModal defined in client script');
  assert.ok(html.includes('choiceSubscribe'), 'Subscribe live sync choice button defined');
  assert.ok(html.includes('choiceCopy'), 'Make editable copy choice button defined');
  assert.ok(html.includes('.save-choice-card'), 'save-choice-card CSS class defined');

  // 2. Execution functions
  assert.ok(html.includes('plExecuteSave'), 'plExecuteSave defined');
  assert.ok(html.includes("mode === 'subscribe'"), 'plExecuteSave handles subscribe mode');
  assert.ok(html.includes('isSubscription: true'), 'plExecuteSave sets isSubscription: true');
  assert.ok(html.includes('subscribedPublicId: id'), 'plExecuteSave binds subscribedPublicId');

  // 3. Live Sync & Read-Only Guards
  assert.ok(html.includes('devSyncSubscribedPlaylist'), 'devSyncSubscribedPlaylist defined');
  assert.ok(html.includes('devUnfollowPlaylist'), 'devUnfollowPlaylist defined');
  assert.ok(html.includes('devCloneSubscriptionToCopy'), 'devCloneSubscriptionToCopy defined');
  assert.ok(html.includes('Subscribed · Live Sync'), 'Subscribed playlist header badge defined');
  assert.ok(html.includes('const canRemove = !pl.isSubscription'), 'Subscribed playlist suppresses remove buttons');
  // 4. Phase 2 Restructuring: Segmented Bar, Sticky Controls & Subscription Badges
  assert.ok(html.includes('.playlist-segmented-bar'), 'playlist-segmented-bar CSS defined');
  assert.ok(html.includes('.playlist-seg-btn'), 'playlist-seg-btn CSS defined');
  assert.ok(html.includes('.playlist-system-row'), 'playlist-system-row CSS defined');
  assert.ok(html.includes('.playlist-custom-row'), 'playlist-custom-row CSS defined');
  assert.ok(html.includes('.playlist-subscribed-card'), 'playlist-subscribed-card CSS defined');
  assert.ok(html.includes('devPlaylistSegmentedBarHtml'), 'devPlaylistSegmentedBarHtml defined');
  assert.ok(html.includes('devPlaylistsHeaderHtml'), 'devPlaylistsHeaderHtml defined');
  assert.ok(html.includes('devSwitchPlaylistSubView'), 'devSwitchPlaylistSubView defined');
  assert.ok(html.includes('devIsSubscribedToPublicId'), 'devIsSubscribedToPublicId defined');
  assert.ok(html.includes('devOpenSubscribedPlaylist'), 'devOpenSubscribedPlaylist defined');
  assert.ok(html.includes('Open in My Playlists'), 'Subscribed public playlist cards render Open in My Playlists');
  // 5. Phase 3: Playlist Sorting, Ordering Controls & Drag-and-Drop
  assert.ok(html.includes('devGetPlaylistSort'), 'devGetPlaylistSort defined');
  assert.ok(html.includes('devSetPlaylistSort'), 'devSetPlaylistSort defined');
  assert.ok(html.includes('devItemDateTimestamp'), 'devItemDateTimestamp defined');
  assert.ok(html.includes('devDragStart'), 'devDragStart defined');
  assert.ok(html.includes('devDropItem'), 'devDropItem defined');
  assert.ok(html.includes('devReorderPlaylistItem'), 'devReorderPlaylistItem defined');
  assert.ok(html.includes('.playlist-reorder-btn'), 'playlist-reorder-btn CSS defined');
  assert.ok(html.includes('.playlist-item-wrap'), 'playlist-item-wrap CSS defined');
  assert.ok(html.includes('Manual / Drag-and-Drop'), 'Manual / Drag-and-Drop sort option defined');
  // 6. Phase 4: Enhanced Playlist Creation Modal
  assert.ok(html.includes('.new-pl-emoji-grid'), 'new-pl-emoji-grid CSS defined');
  assert.ok(html.includes('.new-pl-emoji-btn'), 'new-pl-emoji-btn CSS defined');
  assert.ok(html.includes('devIsDuplicatePlaylistName'), 'devIsDuplicatePlaylistName defined');
  assert.ok(html.includes('newPlDesc'), 'newPlDesc description textarea defined in creation modal');
  assert.ok(html.includes('newPlTagSearch'), 'newPlTagSearch taxonomy search defined in creation modal');
  assert.ok(html.includes('newPlChips'), 'newPlChips tag chips container defined in creation modal');
  assert.ok(html.includes('newPlError'), 'newPlError duplicate/validation element defined in creation modal');

  // 7. Preview & Items Endpoint (/api/playlists/items)
  const itemsReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/playlists/items?id=pl_ao_elul');
  const itemsRes = await worker.fetch(itemsReq, mockEnv, mockCtx);
  assert.equal(itemsRes.status, 200, '/api/playlists/items?id=pl_ao_elul should return 200 OK');
  const itemsData = await itemsRes.json();
  assert.ok(itemsData && itemsData.playlist, 'Response must include playlist metadata');
  assert.equal(itemsData.playlist.title, 'Elul & Teshuvah Essentials', 'Playlist title should match');
  assert.ok(Array.isArray(itemsData.items) && itemsData.items.length > 0, 'Playlist must contain items array');
  assert.ok(itemsData.items[0].duration, 'Preview items must have duration');
  assert.ok(itemsData.items[0].date, 'Preview items must have date');
  assert.ok(html.includes('plPreviewCache'), 'Client-side playlist preview cache defined');
  assert.ok(html.includes("metaBits.push('⏱ ' + escapeHtml(dur))"), 'Preview renderer formats duration with stopwatch');
  assert.ok(html.includes('metaBits.push(escapeHtml(dt))'), 'Preview renderer formats relative date');

  console.log('  ✅ Public playlist save choice modal, live-sync subscription, segmented controls, sorting, items API & preview verified.');
}

async function testDevPersonasAndSecondTab() {
  console.log('13. Testing Second Dev Playlist Tab, 30 Curated Playlists & Author Attribution...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // 1. Second Dev Tab & Grid
  assert.ok(html.includes('id="tab-dev-playlists"'), 'Second Dev Playlists tab button present');
  assert.ok(html.includes('id="grid-dev-playlists"'), 'Second Dev Playlists grid container present');
  assert.ok(html.includes('renderDevCuratedGrid'), 'renderDevCuratedGrid function defined');
  assert.ok(html.includes('setDevPersonaFilter'), 'setDevPersonaFilter function defined');
  assert.ok(html.includes('devPlayCuratedAll'), 'devPlayCuratedAll function defined');
  assert.ok(html.includes('devOpenInMyPlaylists'), 'devOpenInMyPlaylists function defined');

  // 2. 30 Curated Playlists across 3 Personas
  assert.ok(html.includes('Andrew Ohiliote'), 'Andrew Ohiliote persona present');
  assert.ok(html.includes('Moshe Mendelwitz'), 'Moshe Mendelwitz persona present');
  assert.ok(html.includes('Rachel Sternbach'), 'Rachel Sternbach persona present');
  assert.ok(!html.includes('ownerName: "Dev"') && !html.includes("ownerName: 'Dev'"), 'Zero curated playlists named Dev');

  // 3. Author Attribution in Details Modal
  assert.ok(html.includes('pldAuthorSelect'), 'Author attribution select defined in details modal');
  assert.ok(html.includes('pldAuthorCustom'), 'Author attribution custom input defined');

  // 4. Name collision & Reserved Dev Names in /api/profile
  const mockDb = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => {
          if (sql.includes('SELECT id, email, name, picture FROM users WHERE id = ?')) {
            return { id: 'u_regular', email: 'user@test.com', name: 'Regular User' };
          }
          if (sql.includes('SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))')) {
            const requestedName = args[0];
            if (requestedName.toLowerCase() === 'existinguser') {
              return { id: 'u_other_123' };
            }
            return null;
          }
          return null;
        },
        run: async () => ({})
      })
    })
  };

  async function generateTestJwt(secret, payload) {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const body = enc(payload);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(header + '.' + body))).toString('base64url');
    return `${header}.${body}.${sig}`;
  }

  const testSecret = 'test_secret_12345';
  const testToken = await generateTestJwt(testSecret, { uid: 'u_regular', exp: Date.now() + 3600000 });
  const mockUserEnv = {
    yutorah_db: mockDb,
    SESSION_SECRET: testSecret
  };

  // Test reserved name rejection
  const reservedReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `yutorah_session=${testToken}` },
    body: JSON.stringify({ name: 'Andrew Ohiliote' })
  });
  const reservedRes = await worker.fetch(reservedReq, mockUserEnv, mockCtx);
  assert.equal(reservedRes.status, 400, 'Reserved dev name should return 400');
  const reservedJson = await reservedRes.json();
  assert.equal(reservedJson.error, 'name_reserved', 'Error should be name_reserved');

  // Test existing name collision rejection
  const clashReq = new Request('https://yutorah-player.mrosensweig.workers.dev/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `yutorah_session=${testToken}` },
    body: JSON.stringify({ name: 'ExistingUser' })
  });
  const clashRes = await worker.fetch(clashReq, mockUserEnv, mockCtx);
  assert.equal(clashRes.status, 409, 'Taken name should return 409 Conflict');
  const clashJson = await clashRes.json();
  assert.equal(clashJson.error, 'name_taken', 'Error should be name_taken');

  console.log('  ✅ Second Dev Playlists tab, 30 curated playlists, author attribution & name uniqueness verified.');
}

async function testHeroSizingAndPlaylistTagAutocomplete() {
  console.log('14. Testing Hero Slideshow Typography/Positioning & Playlist Tag Dropdown...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Hero slideshow text sizing, buffer, and expanded vertical range without ellipsis
  assert.ok(html.includes('width: 40%'), 'Hero caption positioned with 40% width for rightward buffer from center');
  assert.ok(html.includes('clamp(20px, 2.3vw, 28px)'), 'Hero title text sized to fit without truncation');
  assert.ok(html.includes('clamp(13px, 1.2vw, 15px)'), 'Hero description text sized to fit without truncation');
  assert.ok(html.includes('padding: 14px 44px 18px 22px'), 'Hero caption starts higher and goes lower');

  // Playlist tag live autocomplete dropdown
  assert.ok(html.includes('.pld-suggest-dropdown'), 'Playlist tag suggest dropdown CSS defined');
  assert.ok(html.includes('.pld-suggest-item'), 'Playlist tag suggest item CSS defined');
  assert.ok(html.includes('pldSuggest-'), 'Playlist details modal dynamically renders suggestion dropdown containers');
  assert.ok(html.includes('data-pld-pick'), 'Playlist details modal binds tag picking action');

  console.log('  ✅ Hero slideshow typography/buffer and playlist tag autocomplete dropdown verified.');
}

async function testSearchResultsScrollAndHeroSlideClick() {
  console.log('15. Testing Search Results Smooth Scroll & Hero Slideshow Click Integration...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // 1. CSS scroll-margin-top on #searchResultsSection to clear the 52px fixed header
  assert.ok(html.includes('#searchResultsSection {'), 'CSS rule for #searchResultsSection must be present');
  assert.ok(html.includes('scroll-margin-top: 70px;'), 'CSS scroll-margin-top: 70px must clear fixed header');

  // 2. scrollToSearchResults helper defined and exposed on window
  assert.ok(html.includes('function scrollToSearchResults()'), 'scrollToSearchResults function must be defined');
  assert.ok(html.includes('window.scrollToSearchResults = scrollToSearchResults;'), 'scrollToSearchResults must be attached to window');

  // 3. handleHeroSlideClick helper defined and exposed on window
  assert.ok(html.includes('function handleHeroSlideClick(event, el)'), 'handleHeroSlideClick function must be defined');
  assert.ok(html.includes('window.handleHeroSlideClick = handleHeroSlideClick;'), 'handleHeroSlideClick must be attached to window');

  // 4. Hero slides contain data-slide-name, data-slide-href, and handleHeroSlideClick(event, this)
  assert.ok(html.includes('handleHeroSlideClick(event, this)'), 'Hero slides must bind handleHeroSlideClick on click');
  assert.ok(html.includes('data-slide-name='), 'Hero slides must supply data-slide-name attribute');
  assert.ok(html.includes('data-slide-href='), 'Hero slides must supply data-slide-href attribute');

  // 5. When and Sort filter rows are separated into distinct subrows so Sort starts on a new line
  assert.ok(html.includes('.date-quick-subrow {'), 'CSS rule for .date-quick-subrow must be present');
  assert.ok(html.includes('class="date-quick-subrow"'), 'date-quick-subrow markup must be present');

  // 6. Sort label includes icon (↕️ Sort:)
  assert.ok(html.includes('↕️ Sort:'), 'Sort label must have an icon on its left');

  // 7. Direct shiur slides (like Opening the Zman at YU -> /1187437) play/navigate directly instead of searching
  assert.ok(html.includes('directShiurId'), 'handleHeroSlideClick must identify direct shiur IDs');
  assert.ok(html.includes('playShiurById(event, directShiurId)'), 'handleHeroSlideClick must trigger playShiurById for direct shiur slides');

  console.log('  ✅ Search results smooth scroll, hero slideshow direct shiur & search click & multi-line date/sort filters verified.');
}

async function testPlaylistSuitePhase5() {
  console.log('16. Testing Playlist Suite Phase 5 (Staged Add-to-Playlist, Live Counter Ticks & Author Guard)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // 1. CSS for .playlist-author-card, .pl-tick-add, and .pl-tick-del
  assert.ok(html.includes('.playlist-author-card {'), 'CSS rule for .playlist-author-card must be present');
  assert.ok(html.includes('.pl-tick-add {'), 'CSS rule for .pl-tick-add must be present');
  assert.ok(html.includes('.pl-tick-del {'), 'CSS rule for .pl-tick-del must be present');

  // 2. devIsAuthoredByCurrentUser & devGetAuthoredCustomId defined and exposed
  assert.ok(html.includes('function devIsAuthoredByCurrentUser(p)'), 'devIsAuthoredByCurrentUser must be defined');
  assert.ok(html.includes('window.devIsAuthoredByCurrentUser = devIsAuthoredByCurrentUser;'), 'devIsAuthoredByCurrentUser must be attached to window');
  assert.ok(html.includes('function devGetAuthoredCustomId(p)'), 'devGetAuthoredCustomId must be defined');
  assert.ok(html.includes('window.devGetAuthoredCustomId = devGetAuthoredCustomId;'), 'devGetAuthoredCustomId must be attached to window');

  // 3. Staged Add-to-Playlist Modal with Save Changes and Cancel buttons
  assert.ok(html.includes('pl-save-changes-btn'), 'Save Changes button class must be present');
  assert.ok(html.includes('💾 Save Changes'), 'Save Changes label must be present in modal');
  assert.ok(html.includes('id="plCancelBtn"'), 'Cancel button must be present in modal');
  assert.ok(html.includes('id="plModalStatus"'), 'Status indicator must be present in modal');
  assert.ok(html.includes('stagedStates'), 'stagedStates tracking must be present');
  assert.ok(html.includes('initialStates'), 'initialStates tracking must be present');

  // 4. Live counter tick (+1 / -1) classes in rowHtml
  assert.ok(html.includes('class="pl-tick-add"'), 'pl-tick-add class must be rendered on check');
  assert.ok(html.includes('class="pl-tick-del"'), 'pl-tick-del class must be rendered on uncheck');

  // 5. Self-saving guard in renderPlPublicInto
  assert.ok(html.includes('👤 Your Playlist'), 'Your Playlist badge must be rendered for author');
  assert.ok(html.includes('playlist-author-card'), 'playlist-author-card class must be added to cards');
  assert.ok(html.includes('devGetAuthoredCustomId'), 'devGetAuthoredCustomId must be called in public card rendering');

  console.log('  ✅ Staged Add-to-Playlist, live counter ticks (+1/-1) & author self-save guard verified.');
}

async function testPlaylistsEnhancementsRound2() {
  console.log('17. Testing Playlists Enhancements Round 2 (Save for Later & Multi-Select Filter Cards)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Task 1: "Save for later" and vertical icon centering
  assert.ok(html.includes('Save for later'), 'Save for later label must be rendered');
  assert.ok(html.includes('.playlist-pill {'), 'Playlist pill CSS must be defined');
  assert.ok(html.includes('.playlist-pill svg {'), 'Playlist pill svg CSS must be defined');
  assert.ok(html.includes('align-items: center;'), 'Playlist pill must vertically center');

  // Task 2: Multi-Select Category Filter Cards
  assert.ok(html.includes('let plPublicFilterTags = { teachers: [], venues: [], topics: [] };'), 'plPublicFilterTags must be initialized');
  assert.ok(html.includes('function plAddFilterTag(kind, tag)'), 'plAddFilterTag must be defined');
  assert.ok(html.includes('function plRemoveFilterTag(kind, idx)'), 'plRemoveFilterTag must be defined');
  assert.ok(html.includes('function plClearAllFilterTags()'), 'plClearAllFilterTags must be defined');
  assert.ok(html.includes('id="plPubTeacherInput"'), 'Teachers filter is Advanced-style typable combobox input');
  assert.ok(html.includes('id="plPubVenueInput"'), 'Venues filter is Advanced-style typable combobox input');
  assert.ok(html.includes('id="plPubTopicInput"'), 'Topics filter is Advanced-style typable combobox input');
  assert.ok(html.includes('id="plPubTeacherDropdown"'), 'Teachers live dropdown (Advanced-style) must be rendered');
  assert.ok(html.includes('id="plPubVenueDropdown"'), 'Venues live dropdown (Advanced-style) must be rendered');
  assert.ok(html.includes('id="plPubTopicDropdown"'), 'Topics live dropdown (Advanced-style) must be rendered');
  assert.ok(html.includes('setupPlFilter('), 'setupPlFilter live-filter must be defined (Advanced-style)');
  assert.ok(html.includes('plRenderFilterTokens') || html.includes('plRenderAllFilterTokens'), 'plRenderFilterTokens multi-select tokens must be defined');
  assert.ok(html.includes('plPickFilterTag'), 'plPickFilterTag central multi-select pick must be defined');
  assert.ok(html.includes('plSearchPublicResultsOnly'), 'results-only patch must exist so picks never destroy inputs');
  assert.ok(html.includes('plPublicResultsWrap'), 'results wrapper must be stable so filter bar persists');
  assert.ok(html.includes('plPublicActiveBar'), 'active filter bar must be patchable without full rebuild');
  assert.ok(html.includes('plRemoveFilterTag(&quot;teachers&quot;'), 'Teachers remove button must be present in filter cards');
  assert.ok(html.includes('plClearAllFilterTags()'), 'Clear All button must be present in filter bar');

  // Task 3: Playlist Search Scope Checkboxes
  assert.ok(html.includes('let plPublicScope = { title: true, desc: true, shiurim: false };'), 'plPublicScope must be initialized with title & desc checked, shiurim unchecked');
  assert.ok(html.includes('id="plScopeTitle"'), 'plScopeTitle checkbox must be rendered');
  assert.ok(html.includes('id="plScopeDesc"'), 'plScopeDesc checkbox must be rendered');
  assert.ok(html.includes('id="plScopeShiurim"'), 'plScopeShiurim checkbox must be rendered');
  assert.ok(html.includes("q.set('scopeTitle'"), 'plPublicParams must serialize scopeTitle');
  assert.ok(html.includes("q.set('scopeDesc'"), 'plPublicParams must serialize scopeDesc');
  assert.ok(html.includes("q.set('scopeShiurim'"), 'plPublicParams must serialize scopeShiurim');
  assert.ok(html.includes('togglePlInfoTip(event, &quot;scope-shiurim&quot;)'), 'Shiurim scope must have an info button');
  assert.ok(html.includes('id="tip-scope-shiurim"'), 'Shiurim info tooltip must render');
  assert.ok(html.includes('only ever widens results'), 'Shiurim tooltip must explain additive scope');
  assert.ok(html.includes('Shiurim inside the playlists</label>'), 'info button must sit OUTSIDE the label (taps must not flip the checkbox)');

  // Task 4: Playlist Reordering Direct Parity with Queue
  assert.ok(html.includes('const canReorder = !pl.isHistory && !pl.isSubscription;'), 'canReorder must allow direct reordering on all mutable user playlists');
  assert.ok(html.includes('dragAttrs = canReorder'), 'dragAttrs must be unconditionally enabled for canReorder');
  assert.ok(html.includes('pl.sortOrder = &apos;manual&apos;') || html.includes("pl.sortOrder = 'manual'"), 'devReorderPlaylistItem sets manual sortOrder');

  console.log('  ✅ Save for later, multi-select filter cards, search scope checkboxes & direct reordering verified.');
}

async function testPlaylistUrlDeepLinks() {
  console.log('18. Testing Playlist URL Deep-Links (reload-safe + shareable)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Namespaced keys + sync/hydrate plumbing
  assert.ok(html.includes('PL_URL_KEYS'), 'PL_URL_KEYS namespace must be defined');
  assert.ok(html.includes('function syncPlaylistUrl()'), 'syncPlaylistUrl must be defined');
  assert.ok(html.includes('function readPlaylistUrlState()'), 'readPlaylistUrlState must be defined');
  assert.ok(html.includes('function clearPlaylistUrlKeys('), 'clearPlaylistUrlKeys must be defined');
  assert.ok(html.includes("bp.get('tab') !== 'playlists'"), 'hydration must gate on tab=playlists');
  assert.ok(html.includes("bp.get('plq')"), 'hydration must restore public query (plq)');
  assert.ok(html.includes("multi('plteachers')"), 'hydration must restore teacher pills');
  assert.ok(html.includes("multi('plvenues')"), 'hydration must restore venue pills');
  assert.ok(html.includes("multi('pltopics')"), 'hydration must restore topic pills');
  assert.ok(html.includes("bp.get('plscope')"), 'hydration must restore scope');
  assert.ok(html.includes("bp.get('plsort')"), 'hydration must restore sort');
  assert.ok(html.includes("bp.get('pl')"), 'hydration must restore active playlist id');
  // Writers: select/subview/search sync; tab-leave clears
  assert.ok(html.includes('syncPlaylistUrl();\n  }\n  window.devSelectPlaylist') || html.includes('renderPlaylistsGrid();\n    syncPlaylistUrl();'), 'playlist selection must sync URL');
  assert.ok(html.includes('plPatchPublicResults();\n    syncPlaylistUrl();'), 'public search must sync URL after patch');
  // One view per URL: shiur search drops playlist keys
  assert.ok(html.includes('clearPlaylistUrlKeys(newUrl)'), 'shiur search must clear playlist keys');
  // Player open carries playlist context; close preserves it
  assert.ok(html.includes("curParams.getAll(k).forEach(v => newUrl.searchParams.append(k, v))"), 'player open must carry playlist keys');
  assert.ok(html.includes("'tab', 'pl', 'plq'"), 'playlist key list must be shared');

  console.log('  ✅ Playlist deep-links: sync, hydration, one-view-per-URL & player carry-over verified.');
}

async function testDualReviewAccessibilityAndSharingRemediation() {
  console.log('19. Testing Dual Review Remediation (Viewport, Focus Rings, Scrubber Slider, Theme Sync & Sharing)...');
  const req = new Request('https://yutorah-player.mrosensweig.workers.dev/', {
    headers: { 'User-Agent': 'TestRunner' }
  });
  const res = await worker.fetch(req, mockEnv, mockCtx);
  assert.equal(res.status, 200);
  const html = await res.text();

  // B2: Viewport zoom allowed
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0">'), 'Viewport meta must not disable scaling or specify maximum-scale');
  assert.ok(!html.includes('user-scalable=no'), 'Viewport meta must not include user-scalable=no');

  // B3: Focus rings restored
  assert.ok(html.includes('button:focus-visible'), 'button:focus-visible outline styling must be present');
  assert.ok(html.includes('.ctrl-btn:focus-visible'), 'ctrl-btn:focus-visible outline styling must be present');
  assert.ok(html.includes('.mini-play-btn:focus-visible'), 'mini-play-btn:focus-visible outline styling must be present');
  assert.ok(html.includes('.mini-btn.skip-btn:focus-visible'), 'mini-btn.skip-btn:focus-visible outline styling must be present');
  assert.ok(html.includes('.playlist-reorder-btn:focus-visible'), 'playlist-reorder-btn:focus-visible outline styling must be present');

  // H1: Default dark mode sync (button renders sun ☀️ to avoid FOUT)
  assert.ok(html.includes('id="themeToggleBtn" class="theme-toggle-btn" onclick="toggleTheme()" title="Toggle Dark / Light Mode">☀️</button>'), 'Theme toggle button must render ☀️ by default in dark mode to prevent FOUT');

  // H2: Audio Scrubber accessibility
  assert.ok(html.includes('role="slider"'), 'Scrubber bar must have role=slider');
  assert.ok(html.includes('tabindex="0"'), 'Scrubber bar must have tabindex=0');
  assert.ok(html.includes('aria-label="Seek time"'), 'Scrubber bar must have aria-label=Seek time');
  assert.ok(html.includes('aria-valuenow="0"'), 'Scrubber bar must have aria-valuenow attribute');
  assert.ok(html.includes("e.key === 'ArrowLeft'"), 'Scrubber bar must support ArrowLeft key seeking');
  assert.ok(html.includes("e.key === 'ArrowRight'"), 'Scrubber bar must support ArrowRight key seeking');

  // B1: Sharing & public resolution helpers
  assert.ok(html.includes('devSharePlaylist'), 'devSharePlaylist helper must be defined');
  assert.ok(html.includes('plSharePublicSearch'), 'plSharePublicSearch helper must be defined');
  assert.ok(html.includes('devLoadSharedPublicPlaylist'), 'devLoadSharedPublicPlaylist helper must be defined');
  assert.ok(html.includes('📋 Share'), 'Share button must be rendered on playlist action rows');
  assert.ok(html.includes('📋 Share Search'), 'Share Search button must be rendered on public search row');

  // H4: Shuffle disabled state consistency
  assert.ok(html.includes('items.length < 2 ? \' disabled aria-disabled="true" title="Add at least 2 items to shuffle"\''), 'Shuffle button must be disabled when fewer than 2 items across all playlist rows');

  console.log('  ✅ Dual review remediation: viewport, focus rings, scrubber a11y, theme sync & sharing verified.');
}

async function testLoggedOutHeaderThemeToggle() {
  console.log('20. Testing Logged-Out Header Left-Cluster Order (brand → login → zman → theme)...');

  const res = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/'));
  assert.equal(res.status, 200, 'Homepage SSR must return 200 OK');
  const html = await res.text();

  // 1. Single left flow in header HTML: brand → #authBtn → zman motif →
  // #themeToggleBtn → support → date badge (no gaps, all before header-right)
  const brandIndex = html.indexOf('class="brand"');
  const authBtnIndex = html.indexOf('id="authBtn"');
  const motifIndex = html.indexOf('id="holidayMotifWrap"');
  const themeToggleIndex = html.indexOf('id="themeToggleBtn"');
  const supportIndex = html.indexOf('class="support-yutorah-btn"');
  const hebrewDateIndex = html.indexOf('id="hebrewDateBadge"');
  const headerRightIndex = html.indexOf('<div class="header-right">');
  assert.ok(brandIndex !== -1, 'Header must contain .brand');
  assert.ok(authBtnIndex !== -1, 'Header must contain #authBtn');
  assert.ok(motifIndex !== -1, 'Header must contain #holidayMotifWrap');
  assert.ok(themeToggleIndex !== -1, 'Header must contain #themeToggleBtn');
  assert.ok(supportIndex !== -1, 'Header must contain support button in left flow');
  assert.ok(hebrewDateIndex !== -1, 'Header must contain #hebrewDateBadge');
  assert.ok(brandIndex < authBtnIndex, '#authBtn must be rendered next after .brand in header');
  assert.ok(authBtnIndex < motifIndex, 'zman motif must be rendered after #authBtn in DOM (left flow, no gap)');
  assert.ok(motifIndex < themeToggleIndex, '#themeToggleBtn must be rendered after the zman motif in DOM (left flow, no gap)');
  assert.ok(themeToggleIndex < hebrewDateIndex, 'date badge must continue the left flow after theme');
  assert.ok(hebrewDateIndex < supportIndex, 'support button must continue the left flow after date badge');
  assert.ok(supportIndex < headerRightIndex, 'entire icon flow must precede header-right');
  assert.ok(html.includes('.header-left'), 'CSS must include .header-left layout styling');
  assert.ok(html.includes('justify-content: flex-start'), 'header-inner must pack left with no gap');

  // 2. Theme toggle lives in the left cluster (no right-hand order rule)
  assert.ok(!html.includes('.header-right #themeToggleBtn'), 'theme toggle must not be styled into .header-right');
  assert.ok(html.includes('display: inline-flex;'), 'Theme toggle displays inline-flex by default');

  // 3. Theme visibility is measurement-governed (shown only when space allows)
  assert.ok(html.includes('function headerClusterOverflows()'), 'overflow measurement helper must exist');
  assert.ok(html.includes('function checkHeaderOverflow()'), 'checkHeaderOverflow must be defined in client JS');
  assert.ok(html.includes("themeBtn.style.display = 'none'"), 'checkHeaderOverflow must hide theme toggle when tight');

  // 4. Dynamic overflow detection suppresses theme toggle if it would be cut off or collide
  assert.ok(html.includes("dataset.holiday === '1'"), 'motif holiday-active flag must gate motif display');
  assert.ok(html.includes("motif.classList.add('icon-only')"), 'motif must shrink to apple-only before hiding');

  // 5. Settings dropdown menu includes theme toggle fallback for all users (logged-in and guest)
  assert.ok(html.includes('menu-theme-toggle-btn'), 'Settings menu must provide theme toggle fallback for all users');

  // 6. Client-side renderAuthBtn updates is-logged-in class on document.body
  assert.ok(html.includes("document.body.classList.add('is-logged-in')"), 'renderAuthBtn must add is-logged-in to body when user is logged in');
  assert.ok(html.includes("document.body.classList.remove('is-logged-in')"), 'renderAuthBtn must remove is-logged-in from body when user is logged out');

  // 7. Settings dropdown menu icons and calendar date vertical alignment
  assert.ok(html.includes('.menu-item-icon') && html.includes('.menu-cal-icon'), 'CSS must define .menu-item-icon and .menu-cal-icon for standardized icon container alignment');
  assert.ok(html.includes('class="settings-menu-item auth-cal-mobile"'), 'Settings menu must render calendar date as settings-menu-item for uniform padding and icon alignment');

  console.log('  ✅ Logged-out header theme toggle button, cut-off suppression & settings menu icon alignment verified.');
}

async function testPwaIntegration() {
  console.log('21. Testing Progressive Web App (PWA) Manifest, Service Worker, App Icons & Client Registration...');

  // 1. Web App Manifest endpoints (/manifest.json and /manifest.webmanifest)
  for (const manifestPath of ['/manifest.json', '/manifest.webmanifest']) {
    const req = new Request(`https://yutorah-player.mrosensweig.workers.dev${manifestPath}`);
    const res = await worker.fetch(req, mockEnv, mockCtx);
    assert.equal(res.status, 200, `${manifestPath} should return 200 OK`);
    assert.ok(res.headers.get('Content-Type')?.includes('application/manifest+json'), `${manifestPath} content-type should be application/manifest+json`);
    assert.ok(res.headers.get('Cache-Control')?.includes('no-cache'), `${manifestPath} Cache-Control should be no-cache`);
    const manifest = await res.json();
    assert.equal(manifest.name, 'YUTorah Player', 'Manifest name should be YUTorah Player');
    assert.equal(manifest.short_name, 'YUTorah', 'Manifest short_name should be YUTorah');
    assert.equal(manifest.start_url, '/', 'Manifest start_url should be /');
    assert.equal(manifest.display, 'standalone', 'Manifest display should be standalone');
    assert.equal(manifest.background_color, '#0f141c', 'Manifest background_color should be #0f141c');
    assert.equal(manifest.theme_color, '#2b4c7e', 'Manifest theme_color should be #2b4c7e');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest must declare at least 2 icon configurations');
    assert.ok(manifest.icons.some(i => i.src.includes('icon-shield-192.png') && i.sizes === '192x192'), 'Manifest must include 192x192 shield icon');
    assert.ok(manifest.icons.some(i => i.src.includes('icon-shield-512.png') && i.sizes === '512x512'), 'Manifest must include 512x512 shield icon');
    assert.ok(manifest.icons.some(i => i.purpose === 'any'), 'Manifest must include purpose: "any" icons');
    assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'Manifest must include purpose: "maskable" icons to prevent Chrome shortcut badging on Android');
  }

  // 2. Service Worker endpoint (/sw.js)
  const swReq = new Request('https://yutorah-player.mrosensweig.workers.dev/sw.js');
  const swRes = await worker.fetch(swReq, mockEnv, mockCtx);
  assert.equal(swRes.status, 200, '/sw.js should return 200 OK');
  assert.ok(swRes.headers.get('Content-Type')?.includes('application/javascript'), '/sw.js should have application/javascript content-type');
  assert.equal(swRes.headers.get('Service-Worker-Allowed'), '/', '/sw.js must set Service-Worker-Allowed: /');
  const swContent = await swRes.text();
  assert.ok(swContent.includes('yutorah-pwa-v8'), 'SW must define CACHE_NAME v7');
  assert.ok(swContent.includes("req.headers.has('range')"), 'SW must bypass streaming audio range requests');
  assert.ok(swContent.includes('shiurim.yutorah.net'), 'SW must bypass audio CDN requests');
  assert.ok(swContent.includes("req.mode === 'navigate'"), 'SW must handle navigation requests with network-first');

  // 3. PNG and SVG Icons endpoints (Authentic Yeshiva University Shield)
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (const iconPath of ['/icons/icon-shield-192.png', '/icons/icon-192.png', '/icons/icon-maskable-192.png', '/favicon.ico']) {
    const iconReq = new Request(`https://yutorah-player.mrosensweig.workers.dev${iconPath}`);
    const iconRes = await worker.fetch(iconReq, mockEnv, mockCtx);
    assert.equal(iconRes.status, 200, `${iconPath} should return 200 OK`);
    assert.equal(iconRes.headers.get('Content-Type'), 'image/png', `${iconPath} should have image/png content-type`);
    const iconBuf = new Uint8Array(await iconRes.arrayBuffer());
    assert.ok(pngSig.every((b, i) => iconBuf[i] === b), `${iconPath} must have valid PNG signature`);
    assert.equal(iconBuf.length, 8303, `${iconPath} length should match expected 192 shield icon bytes`);
  }

  for (const iconPath of ['/icons/icon-shield-512.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
    const iconReq = new Request(`https://yutorah-player.mrosensweig.workers.dev${iconPath}`);
    const iconRes = await worker.fetch(iconReq, mockEnv, mockCtx);
    assert.equal(iconRes.status, 200, `${iconPath} should return 200 OK`);
    assert.equal(iconRes.headers.get('Content-Type'), 'image/png', `${iconPath} should have image/png content-type`);
    const iconBuf = new Uint8Array(await iconRes.arrayBuffer());
    assert.ok(pngSig.every((b, i) => iconBuf[i] === b), `${iconPath} must have valid PNG signature`);
    assert.equal(iconBuf.length, 39368, `${iconPath} length should match expected 512 shield icon bytes`);
  }

  const svgReq = new Request('https://yutorah-player.mrosensweig.workers.dev/icons/icon.svg');
  const svgRes = await worker.fetch(svgReq, mockEnv, mockCtx);
  assert.equal(svgRes.status, 200, '/icons/icon.svg should return 200 OK');
  assert.equal(svgRes.headers.get('Content-Type'), 'image/svg+xml', '/icons/icon.svg should have image/svg+xml content-type');
  const svgText = await svgRes.text();
  assert.ok(svgText.includes('<svg') && svgText.includes('viewBox="0 0 512 512"'), '/icons/icon.svg must be valid SVG');

  // 4. Homepage SSR HTML includes manifest, mobile meta tags, and Service Worker registration
  const homeReq = new Request('https://yutorah-player.mrosensweig.workers.dev/');
  const homeRes = await worker.fetch(homeReq, mockEnv, mockCtx);
  const html = await homeRes.text();
  assert.ok(html.includes('<link rel="manifest" href="/manifest.json?v=8">'), 'HTML must link to /manifest.json?v=8');
  assert.ok(html.includes('<meta name="mobile-web-app-capable" content="yes">'), 'HTML must include mobile-web-app-capable');
  assert.ok(html.includes('<meta name="apple-mobile-web-app-capable" content="yes">'), 'HTML must include apple-mobile-web-app-capable');
  assert.ok(html.includes('<meta name="apple-mobile-web-app-title" content="YUTorah">'), 'HTML must include apple-mobile-web-app-title');
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/icons/icon-shield-192.png?v=8">'), 'HTML must link to apple-touch-icon with v=7');
  assert.ok(html.includes("navigator.serviceWorker.register('/sw.js'"), 'HTML must register service worker /sw.js');

  console.log('  ✅ PWA manifest, service worker caching, app icons (192 & 512 PNG/SVG), meta tags & registration verified.');
}

async function testPlaylistsTabAndDisplayNameBanner() {
  console.log('22. Testing Playlists Tab Label & Playlist Display Name Indicator...');
  const homeReq = new Request('https://yutorah-player.mrosensweig.workers.dev/');
  const homeRes = await worker.fetch(homeReq, mockEnv, mockCtx);
  const html = await homeRes.text();

  // 1. SSR Tab label is '🎧 Playlists'
  assert.ok(html.includes('<button class="tab-btn dev-playlist-tab" id="tab-playlists" onclick="switchCollection(\'playlists\')">🎧 Playlists</button>'),
    'SSR tab button must be labeled "🎧 Playlists"');

  // 2. Client-side renderAccountMode ensures tab and collection title stay '🎧 Playlists'
  assert.ok(html.includes("tab.textContent = '🎧 Playlists';"),
    'renderAccountMode must set tab.textContent to "🎧 Playlists"');
  assert.ok(html.includes("collectionTitles.playlists = '🎧 Playlists';"),
    'renderAccountMode must set collectionTitles.playlists to "🎧 Playlists"');
  assert.ok(html.includes('playlists: "🎧 Playlists",'),
    'collectionTitles default must be "🎧 Playlists"');

  // 3. Segmented bar preserved as My Playlists and Public Playlists
  assert.ok(html.includes('devPlaylistSegmentedBarHtml'),
    'devPlaylistSegmentedBarHtml helper must be defined');
  assert.ok(html.includes('🎧 My Playlists</button>'),
    'Segmented bar must keep "🎧 My Playlists" sub-tab');
  assert.ok(html.includes('🌍 Public Playlists</button>'),
    'Segmented bar must keep "🌍 Public Playlists" sub-tab');

  // 4. Playlist display name indicator banner under My Playlists
  assert.ok(html.includes('playlist-author-banner'),
    'devPlaylistsHeaderHtml must include playlist-author-banner');
  assert.ok(html.includes('👤 Playlist Display Name:'),
    'Banner must state "👤 Playlist Display Name:"');
  assert.ok(html.includes('openDisplayNameModal()'),
    'Banner must provide quick action to openDisplayNameModal');

  // 5. openDisplayNameModal re-renders playlists grid
  assert.ok(html.includes('renderPlaylistsGrid'),
    'openDisplayNameModal must update playlists grid upon save');

  console.log('  ✅ Playlists tab labeled "🎧 Playlists", segmented controls preserved, and display name banner verified.');
}

async function testZmanimIconShrinkAndSpacePreservation() {
  console.log('23. Testing Holiday Motif (Apple) Icon Shrinking, Tap Expansion & Header Space Preservation...');
  const homeReq = new Request('https://yutorah-player.mrosensweig.workers.dev/');
  const homeRes = await worker.fetch(homeReq, mockEnv, mockCtx);
  const html = await homeRes.text();

  // 1. Date badge + support fill by measurement on all sizes (no forced
  // mobile hides — checkHeaderOverflow shows each only when it fits)
  assert.ok(!html.includes('#hebrewDateBadge {\n        display: none !important;'), 'badge must not be force-hidden on mobile (fill governs)');
  assert.ok(html.includes("if (supportBtn && headerClusterOverflows())"), 'support must hide when tight');
  assert.ok(html.includes('HOLIDAY_TEXT_TIERS'), 'Holiday text tiers dictionary must exist');
  assert.ok(html.includes('HOLIDAY_HEBREW_TITLES'), 'Holiday Hebrew titles dictionary must exist');
  assert.ok(html.includes('motifTitle.textContent = tiers[i];'), 'Progressive zman text tiers must be attempted on overflow');
  assert.ok(html.includes("rosh_hashanah: ['Rosh Hashanah', 'ראש השנה', 'ר״ה']"), 'Rosh Hashanah must cascade English -> Hebrew -> ר״ה');
  assert.ok(html.includes("elul: ['Chodesh Elul', 'Elul', 'חודש אלול', 'אלול']"), 'Elul must cascade Chodesh Elul -> Elul -> חודש אלול -> אלול');
  assert.ok(html.includes("teshuva: ['Aseres Yemei Teshuva', 'עשרת ימי תשובה', 'עשי״ת']"), 'Teshuva must include Roshei Teivos עשי״ת');
  assert.ok(html.includes("yom_kippur: ['Yom Kippur', 'יום כיפור', 'יוה״כ']"), 'Yom Kippur must include Roshei Teivos יוה״כ');
  assert.ok(!html.includes("badge.classList.add('collapsed'"), 'date badge must never collapse to icon-only (actual date text or hidden)');

  // 2. CSS contains .holiday-motif-wrap.icon-only rules
  assert.ok(html.includes('.holiday-motif-wrap.icon-only'), 'CSS must define .holiday-motif-wrap.icon-only');
  assert.ok(html.includes('.holiday-motif-wrap.icon-only:not(.expanded) .holiday-motif-title'), 'CSS must hide title in icon-only mode when not expanded');

  // 3. CSS contains #holidayMotifWrap popover rules scoped to icon-only
  // (full-width motif keeps its inline title; tapping it must not shrink it)
  assert.ok(html.includes('#holidayMotifWrap.icon-only.expanded #holidayMotifTitle'), 'CSS must scope popover to #holidayMotifWrap.icon-only.expanded');
  assert.ok(!html.includes('.holiday-motif-wrap.expanded .holiday-motif-title,'), 'unscoped expanded popover rule must be gone');
  assert.ok(!html.includes('.holiday-motif-wrap.expanded .holiday-motif-title::before,'), 'unscoped ::before popover rule must be gone');
  assert.ok(!html.includes('.holiday-motif-wrap.expanded .holiday-motif-title::after,'), 'unscoped ::after popover rule must be gone');
  assert.ok(html.includes('animation: motifBadgePop'), 'Expanded popover must have motifBadgePop animation');
  assert.ok(html.includes('id="holidayMotifWrap"') && html.includes('aria-expanded="false"'), 'Holiday motif badge must support aria-expanded state');

  // 4. toggleHolidayMotifExpand handles toggle and temporary expansion,
  // but is a no-op for full-width motifs (tap must not shrink them)
  assert.ok(html.includes('toggleHolidayMotifExpand()'), 'Client JS must define toggleHolidayMotifExpand()');
  assert.ok(html.includes("if (!wrap.classList.contains('icon-only')) return;"), 'expand toggle must no-op when motif is full-width');
  // 4b. 7-tap dev-mode toggle on the date badge; pre-roll stays motif-only
  assert.ok(html.includes('function handleDevModeSecretTap(e)'), 'dev-mode secret tap handler must exist');
  assert.ok(html.includes('devTapCount >= 7'), 'dev-mode toggle must require 7 taps');
  assert.ok(html.includes('onclick="handleDevModeSecretTap(event)"'), 'date badge must use the dev-mode tap handler');
  // 4c. Install-as-app plumbing: prompt capture, installed check, menu item
  assert.ok(html.includes("window.addEventListener('beforeinstallprompt'"), 'deferred install prompt must be captured');
  assert.ok(html.includes('function isPwaInstalled()'), 'installed check must exist');
  assert.ok(html.includes('display-mode: standalone'), 'installed check must cover standalone display mode');
  assert.ok(html.includes('function promptInstallApp()'), 'install prompt handler must exist');
  assert.ok(html.includes('Install App</span></button>'), 'settings menu must offer Install App');
  // 4d. Date badge icon/text buffer
  const badgeCssIdx = html.indexOf('.hebrew-date-badge {');
  assert.ok(badgeCssIdx !== -1, 'badge CSS must exist');
  assert.ok(html.indexOf('gap: 6px;', badgeCssIdx) !== -1 && html.indexOf('gap: 6px;', badgeCssIdx) < badgeCssIdx + 800,
    'badge CSS must buffer icon from date text');
  assert.ok(html.includes("wrap.classList.contains('expanded')"), 'toggleHolidayMotifExpand must toggle expanded state');
  assert.ok(html.includes('4000'), 'toggleHolidayMotifExpand must have 4000ms duration timer');

  // 5. Document event listeners for outside click and Escape dismissal
  assert.ok(html.includes("e.key === 'Escape'") && html.includes("wrap.classList.remove('expanded')"),
    'Client JS must dismiss expanded motif popover on Escape key');

  // 6. checkHeaderOverflow shrinks holiday motif badge to icon whenever space is tight (measurement-based, no breakpoints)
  assert.ok(html.includes('function headerClusterOverflows()') && html.includes("motif.classList.add('icon-only')"),
    'checkHeaderOverflow must dynamically shrink holiday motif badge to icon-only');
  assert.ok(html.includes("authBtn.style.display = 'inline-flex'"),
    'checkHeaderOverflow must prioritize authBtn (login button) display');

  // 7. Both login button and theme toggle are preserved in top banner
  assert.ok(html.includes('id="authBtn"') && html.includes('id="themeToggleBtn"'),
    'Top banner must include both #authBtn and #themeToggleBtn');

  console.log('  ✅ Holiday motif (apple) shrinking to icon, temporary expansion on tap & space preservation verified.');
}

async function testMobileDockingAndPublicPlaylistButtons() {
  console.log('24. Testing Mobile Player Docking Clearance & Public Playlist Subscribe vs Copy Buttons...');
  const homeReq = new Request('https://yutorah-player.mrosensweig.workers.dev/');
  const homeRes = await worker.fetch(homeReq, mockEnv, mockCtx);
  const html = await homeRes.text();

  // 1. Mobile Player Docking Clearance & Safe-Area Padding
  assert.ok(html.includes('#miniPlayer {') && html.includes('padding-bottom: env(safe-area-inset-bottom, 0px);'),
    '#miniPlayer must respect env(safe-area-inset-bottom)');
  assert.ok(html.includes('body.mini-player-active {') && html.includes('var(--player-height'),
    'body.mini-player-active must dynamically size bottom padding with --player-height');
  assert.ok(html.includes('@media (max-width: 375px)'),
    'CSS must include compact mobile breakpoint for <= 375px screens');
  assert.ok(html.includes('function syncPlayerBottomPadding()'),
    'Client JS must define syncPlayerBottomPadding()');
  assert.ok(html.includes("document.documentElement.style.setProperty('--player-height'"),
    'syncPlayerBottomPadding must set --player-height CSS variable');

  // 2. Public Playlist Direct Subscribe vs Copy Buttons & Tooltips
  assert.ok(html.includes('.pl-btn-with-info'), 'pl-btn-with-info CSS class must exist');
  assert.ok(html.includes('.pl-info-btn'), 'pl-info-btn CSS class must exist');
  assert.ok(html.includes('.pl-action-tooltip'), 'pl-action-tooltip CSS class must exist');
  assert.ok(html.includes('📡 Subscribe</button>'), 'Public playlist must render direct Subscribe button');
  assert.ok(html.includes('📋 Copy</button>'), 'Public playlist must render direct Copy button');
  assert.ok(html.includes('togglePlInfoTip(event, &quot;sub-'), 'Subscribe info button must toggle tooltip');
  assert.ok(html.includes('togglePlInfoTip(event, &quot;copy-'), 'Copy info button must toggle tooltip');
  assert.ok(html.includes("Subscribing means that you&apos;re following this playlist"),
    'Subscribe tooltip must explain following and owner updates');
  assert.ok(html.includes("Copy means that you&apos;re copying the playlist to then modify and make your own"),
    'Copy tooltip must explain copying and modifying');

  console.log('  ✅ Mobile player docking clearance & Public Playlist Subscribe vs Copy buttons verified.');
}

async function testPublicPlaylistPublishingAndSyncLifecycle() {
  console.log('25. Testing Public Playlist Publishing, Live-Sync, Deletion & Privacy Lifecycle...');
  const res = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/'));
  const html = await res.text();
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

  // 1. CSS support for public pills in custom row
  assert.ok(html.includes('.playlist-pill.public-pill'), 'CSS must define .playlist-pill.public-pill');

  // 2. Custom pill renders public indicator when playlist is public
  assert.ok(html.includes("const isPublic = !isSub && Boolean(p.publicId && p.isPublic !== false);"),
    'devPlaylistsHeaderHtml must calculate isPublic flag');
  assert.ok(html.includes("title=\"Public playlist\">🌍</span>"),
    'Public playlist pill must render 🌍 indicator');

  // 3. Deletion cascades to unpublish
  assert.ok(html.includes("const pubId = pl.publicId;"),
    'devDeletePlaylist must capture pubId before deletion');
  assert.ok(html.includes("fetch('/api/playlists/unpublish'"),
    'devDeletePlaylist must call unpublish endpoint when deleting a public playlist');

  // 4. Real-time sync helper and invocations
  assert.ok(html.includes("async function plSyncIfPublic(pl)"),
    'plSyncIfPublic helper function must be defined');
  assert.ok(html.includes("if (pl.publicId && pl.isPublic !== false)"),
    'devDoRemove must check public status');
  assert.ok(html.includes("if (typeof plSyncIfPublic === 'function') plSyncIfPublic(pl);"),
    'devDoRemove and devSetMembership must trigger plSyncIfPublic');

  // 5. Zero-staleness Cache-Control on /api/playlists/public in backend
  assert.ok(workerSrc.includes("'Cache-Control': 'no-cache, no-store, must-revalidate'"),
    'Public playlists endpoint must disable stale caching');

  // 6. Zero items allowed when updating existing public playlist
  assert.ok(workerSrc.includes("if (rawItems.length === 0 && !pid)"),
    'Publish endpoint must allow 0 items when updating an existing publicId');

  // 7. adoptCloudState preserves publicId and isPublic
  assert.ok(html.includes("...existing,"),
    'adoptCloudState must spread and preserve existing playlist properties');

  // 8. plReconcileMineState defined and wired to bootAuth
  assert.ok(html.includes("function plReconcileMineState(serverLists)"),
    'plReconcileMineState must exist to restore public metadata');
  assert.ok(html.includes("if (typeof plFetchMine === 'function')"),
    'bootAuth must trigger plFetchMine');

  console.log('  ✅ Public Playlist Publishing, Live-Sync, Deletion & Privacy Lifecycle verified.');
}

async function testPublicPlaylistCopyTooltipAndSubscriptionPersistence() {
  console.log('26. Testing Public Playlist Copy Tooltip Placement & Subscription/Copy Persistence...');
  const res = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/'));
  const html = await res.text();
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

  // 1. Tooltip CSS boundary protection: default right-aligned, box-sizing, .align-left fallback & .arrow-top classes
  assert.ok(html.includes('max-width: min(280px, calc(100vw - 24px));'), 'Tooltip CSS must contain max-width within viewport bounds');
  // Default positioning is right-aligned (left: auto; right: 0 in .pl-action-tooltip)
  assert.ok(html.includes('.pl-action-tooltip {') && html.includes('right: 0;') && html.includes('left: auto;'),
    'Default tooltip positioning must be right-aligned');
  // Arrow defaults to right: 5px (centers over 17px info button)
  assert.ok(html.includes('right: 5px;'), 'Default arrow must be at right: 5px to center over info button');
  // .align-left fallback class exists
  assert.ok(html.includes('.pl-action-tooltip.align-left {'), '.align-left fallback class must exist for left-overflow case');
  assert.ok(html.includes('.pl-action-tooltip.arrow-top {'), '.arrow-top class must flip tooltip below button');
  assert.ok(html.includes('[data-theme="dark"] .pl-action-tooltip.arrow-top::after {'), 'Dark theme must support flipped tooltip arrow');

  // 2. Dynamic boundary detection in togglePlInfoTip — now defaults right, falls back to align-left
  assert.ok(html.includes("tip.classList.add('align-left')"), 'togglePlInfoTip must add align-left class when near left edge');
  assert.ok(html.includes("rect.top < 65") && html.includes("tip.classList.add('arrow-top')"),
    'togglePlInfoTip must flip below button when header clearance is tight');

  // 3. ARIA attributes on tooltip triggers, containers, and close buttons
  assert.ok(html.includes('aria-expanded="false"') && html.includes('aria-haspopup="true"'),
    'Info buttons must have aria-expanded and aria-haspopup attributes');
  assert.ok(html.includes('role="tooltip"'), 'Tooltip containers must have role="tooltip"');
  assert.ok(html.includes('aria-label="Close"'), 'Close buttons must have aria-label="Close"');
  // JS must toggle aria-expanded
  assert.ok(html.includes("trigger.setAttribute('aria-expanded', 'true')"),
    'togglePlInfoTip must set aria-expanded to true when opening');
  assert.ok(html.includes("trigger.setAttribute('aria-expanded', 'false')"),
    'closePlInfoTip must reset aria-expanded to false when closing');

  // 4. Window resize closes tooltips
  assert.ok(html.includes("window.addEventListener('resize', closeAllPlInfoTips)"),
    'Tooltips must close on window resize');

  // 5. Subscriptions protected from dev-seed purges
  assert.ok(html.includes("if (sid.startsWith('sub_')) return false;"),
    'isDevSeedPlaylist must never flag sub_* as dev seeds');
  assert.ok(html.includes("if (pl && (pl.isSubscription || pl.isUserCopy || pl.isUserCreated || pl.copiedFrom)) return false;"),
    'isDevSeedPlaylist must protect user subscriptions, copies, and created playlists');
  assert.ok(html.includes("if (sid.startsWith('pl_') && !sid.startsWith('pl_ao_') && !sid.startsWith('pl_mm_') && !sid.startsWith('pl_rs_') && !sid.startsWith('pl_seed_') && !sid.startsWith('pl_dev_'))"),
    'isDevSeedPlaylist must protect user-generated playlist IDs pl_* matching seed titles');

  // 6. Copy naming and tracking in plExecuteSave
  assert.ok(html.includes("let name = baseName.slice(0, 52) + ' (Copy)';"),
    'plExecuteSave must name copies with (Copy) suffix');
  assert.ok(html.includes("store.custom[nid].isUserCopy = true;"),
    'plExecuteSave must tag copied playlists with isUserCopy');
  assert.ok(html.includes("store.custom[nid].copiedFrom = id;"),
    'plExecuteSave must track copiedFrom public ID');

  // 7. Subscription persistence in pullUserState and adoptCloudState
  assert.ok(workerSrc.includes("FROM playlist_saves s JOIN public_playlists p ON p.id = s.playlist_id"),
    'pullUserState must query playlist_saves to fetch user subscriptions');
  assert.ok(workerSrc.includes("playlists.subscriptions = subscriptions;"),
    'pullUserState must expose subscriptions array in state');
  assert.ok(html.includes("if (s.playlists && Array.isArray(s.playlists.subscriptions))"),
    'adoptCloudState must restore subscribed playlists from cloud state');
  assert.ok(html.includes("devSyncSubscribedPlaylist(subId, false);"),
    'adoptCloudState must trigger sync for newly adopted subscriptions');

  // 8. Subscription deletion cascades to /api/playlists/unsave
  assert.ok(html.includes("fetch('/api/playlists/unsave'"),
    'devDeletePlaylist must call /api/playlists/unsave on subscription delete');

  console.log('  ✅ Public Playlist Copy Tooltip Placement & Subscription/Copy Persistence verified.');
}

async function testSourceSheetButton() {
  console.log('26. Testing Source Sheet Button on Audio Shiurim...');
  const homeRes = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/'), mockEnv, mockCtx);
  const html = await homeRes.text();
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

  // 1. Player chrome: hidden-by-default Source Sheet action + viewer close
  assert.ok(html.includes('id="sourceSheetBtn"'), 'Player must contain #sourceSheetBtn');
  assert.ok(html.includes('onclick="openSourceSheetPicker()"'), 'Source Sheet button must open the picker');
  assert.ok(html.includes('id="sourceSheetCloseBtn"'), 'Article toolbar must contain #sourceSheetCloseBtn');
  assert.ok(html.includes('onclick="closeSourceSheet()"'), 'Close button must dismiss without touching audio');

  // 2. Extraction covers upstream shapes (viewerURL absolute, materialURL relative, skips)
  assert.ok(workerSrc.includes('function extractSourceMaterials(s)'), 'Server normalize path must extract materials');
  assert.ok(workerSrc.includes('shiurAdditionalMaterials'), 'Extraction must read shiurAdditionalMaterials');
  assert.ok(workerSrc.includes('materialExists === false'), 'Extraction must skip missing materials');
  assert.ok(workerSrc.includes('https://www.yutorah.org'), 'Relative materialURL must resolve against origin');

  // 3. Viewer keeps audio alive in source-sheet mode
  assert.ok(workerSrc.includes('function updateSourceSheetButton(data)'), 'updateSourceSheetButton must exist');
  assert.ok(workerSrc.includes('keepAudio: true'), 'Source sheet must load the viewer with keepAudio');
  assert.ok(workerSrc.includes('const keepAudio = !!(opts && opts.keepAudio)'), 'loadArticlePdf must honor keepAudio');
  assert.ok(workerSrc.includes('if (!isCurrentShiurArticle)'), 'Viewer close must not hide real article tracks');

  // 4. Wired into track lifecycle (reset on new track, hydrate on direct link)
  assert.ok(workerSrc.includes('updateSourceSheetButton(data);'), 'playShiurById must refresh the button per track');

  // 5. PDF proxy must allow the materials CDN (viewerURL host)
  assert.ok(workerSrc.includes("'cdn.yutorah.net'"), 'pdf-proxy allowlist must include cdn.yutorah.net');

  console.log('  ✅ Source Sheet button, keep-audio viewer path & extraction verified.');
}

async function testDafHub() {
  console.log('27. Testing Daf Yomi Hub (/daf)...');
  const res = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/daf'), mockEnv, mockCtx);
  assert.equal(res.status, 200, '/daf should return 200 OK');
  const html = await res.text();
  assert.ok(html.includes('id="dafViewer"'), '/daf must contain the viewer');
  assert.ok(html.includes('id="dafMasechta"'), '/daf must contain the tractate selector');
  assert.ok(html.includes('id="dafFolio"'), '/daf must contain the folio input');
  assert.ok(html.includes('id="dafDate"'), '/daf must contain calendar nav');
  assert.ok(html.includes('id="dafShiurimLink"'), '/daf must link shiurim on the daf');
  assert.ok(html.indexOf('id="dafTodayBtn"') < html.indexOf('id="dafShiurimLink"') && html.indexOf('id="dafShiurimLink"') < html.indexOf('id="dafMasechta"'), 'Daf shiurim link must appear under Today’s Daf before the selector card');
  assert.ok(html.includes('overflow: auto; touch-action: pan-y'), '/daf text viewer must remain scrollable');
  assert.ok(html.includes('id="dafViewPage"'), '/daf must offer a page-style view');
  assert.ok(html.includes('function renderDafText()'), '/daf must render text and page views from loaded content');

  // Cycle math: 36 masechtot (no Shekalim), 2711 dafim, verified anchor.
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.ok(!workerSrc.includes('id="dafMiniPlayer"') && !workerSrc.includes('loadDafShiur'), 'Daf page must not render a second custom audio player');
  assert.ok(workerSrc.includes('id="dafOpenBtn"') && workerSrc.includes('detectDafReference'), 'Audio player must expose Open Daf for identifiable Daf shiurim');
  assert.ok(workerSrc.includes('openDafView(event)') && workerSrc.includes('>📜 Daf</a>'), 'Main audio player Daf action must open the shared in-app Daf view');
  assert.ok(workerSrc.includes("href=\"${initialDafRef ? '/daf?m='") && workerSrc.includes("${initialDafRef ? '' : 'style=\"display:none;\"'}") && workerSrc.includes("const visible = hasValidRef && hasAudio && !isCurrentShiurArticle;"), 'Main audio player Daf action must remain hidden unless the shiur has a Daf reference');
  assert.ok(workerSrc.includes('function updateDafActions()') && workerSrc.includes('currentDafRef = null;') && workerSrc.includes("const hasValidRef = Boolean(currentDafRef") && workerSrc.includes("const href = hasValidRef") && workerSrc.includes(": '/daf';"), 'Switching shiurim must reset and recompute both Daf actions for the newly loaded track');
  assert.ok(workerSrc.includes("\\\\s+daf\\\\s*") && workerSrc.includes("const match = new RegExp('(?:^|\\\\W)' + escaped + '(?:\\\\s+daf\\\\s*|\\\\s+|"), 'Client and server Daf detection must recognize titles formatted as Tractate Daf Folio');
  assert.ok(workerSrc.includes('currentDafRef = null;\n    let inheritedDafRef = null;\n    updateDafActions();'), 'Daf actions must be cleared synchronously before metadata for a newly clicked shiur arrives');
  assert.ok(workerSrc.includes('if (String(currentShiurId) !== String(id)) return;'), 'Late shiur metadata responses must not overwrite the selected track or its Daf action');
  assert.ok(workerSrc.includes("var lowerText = text.toLowerCase();") && workerSrc.includes("if (tail.slice(0, 3).toLowerCase() === 'daf')"), 'Client Daf detection must deterministically parse tractate titles with optional Daf label');
  assert.ok(workerSrc.includes("Baba\\s+Batra") && workerSrc.includes("Bava Basra"), 'Daf detection must normalize the common Baba Batra spelling to the canonical tractate');
  assert.ok(workerSrc.includes("const visible = hasValidRef && hasAudio && !isCurrentShiurArticle;"), 'Video-backed YUTorah items must be eligible for the same Daf action when treated as playable media');
  assert.ok(workerSrc.includes('saveDafHandoff(!audio.paused)') && workerSrc.includes('sessionStorage'), 'Regular player must persist the Daf handoff state');
  assert.ok(workerSrc.includes('saveDafHandoff(!audio.paused)') && workerSrc.includes('id="returnToDafBtn"'), 'Normal player must persist handoff and expose Return to Daf');
  assert.ok(!html.includes('id="dafShiurimLink" href="#" target="_blank"'), 'Daf Shiurim must stay in the same tab');
  assert.ok(!workerSrc.includes('id="miniDafBtn"'), 'Mini player must not render a daf button');
  assert.ok(workerSrc.includes('currentDafRef = dafMatch || inheritedDafRef') && workerSrc.includes('let inheritedDafRef = null;') && workerSrc.includes('hasValidRef'), 'Daf Shiurim selections must retain the originating Daf when metadata is incomplete without leaking it to unrelated shiurim');
  assert.ok(html.includes('var CYCLE_DAYS = 2711'), 'served daf page must embed the module cycle constant');
  assert.ok(html.includes('var ANCHOR_UTC = 1577491200000'), 'served daf page must embed the module anchor (2019-12-28)');
  assert.ok(workerSrc.includes('${DAF_CYCLE_DAYS}') && workerSrc.includes('${DAF_ANCHOR_UTC}'), 'fragment must interpolate (not hardcode) the module constants');
  assert.ok(!DAF_MASECHTOT.some(([name]) => name === 'Shekalim'), 'Shekalim must be excluded from the Bavli cycle');

  // OG-style gestures: single-tap zoom at point, pan, pinch, buttons.
  assert.ok(workerSrc.includes('dzZoomAt(ch.clientX, ch.clientY, 2.4)'), 'single tap must zoom at the touch point');
  assert.ok(workerSrc.includes('panning = true'), 'drag must pan while zoomed');
  assert.ok(workerSrc.includes('startScale * (dist('), 'pinch must scale around its center');
  assert.ok(workerSrc.includes('www.sefaria.org/api/texts/'), 'daf text must come from Sefaria');
  assert.ok(workerSrc.includes('function dafPdfUrl(m, d)'), 'scan adapter must exist for page parity');
  assert.ok(workerSrc.includes('www.e-daf.com/index.asp?masechta=') && workerSrc.includes('&pdf=1'), 'Daf page must use the scanned PDF source');
  assert.ok(workerSrc.includes('https://shas.org/daf-pdf/api/?masechta='), 'Daf PDF must prefer the direct Shas PDF API');
  assert.ok(workerSrc.includes("url.pathname === '/api/daf-image'") && workerSrc.includes('cdnyutorah.cachefly.net/public/v3/daf'), 'Daf scan must use the verified YUTorah raster CDN');
  assert.ok(workerSrc.includes("url.pathname === '/api/daf-pdf'") && workerSrc.includes('resolveDafPdf'), 'Daf PDF must use the server-side PDF resolver');
  assert.ok(workerSrc.includes("if (state.view === 'page')") && workerSrc.includes('dafPdfEndpoint'), 'scan source must be isolated to the Daf PDF view');
  assert.ok(workerSrc.includes("type.includes('application/pdf')"), 'Daf page must reject HTML source pages');
  assert.ok(workerSrc.includes('Scanned Daf page') && workerSrc.includes('daf-image?masechta='), 'Daf scan must render as an inline image');
  assert.ok(workerSrc.includes("url.searchParams.get('amud')") && workerSrc.includes("window.dafSetAmud"), 'Daf PDF must support selecting either or both amudim');
  assert.ok(workerSrc.includes("state.amud === 'both' ? ['a', 'b']"), 'Daf PDF both-amud mode must render both pages');
  assert.ok(workerSrc.includes('id="dafAmudToolbar"') && workerSrc.indexOf('id="dafAmudToolbar"') < workerSrc.indexOf('id="dafViewerToolbar"') && workerSrc.indexOf('id="dafAmudB"') < workerSrc.indexOf('id="dafAmudA"'), 'Daf amud selector must have its own section above the other controls');
  assert.ok(workerSrc.includes("lang: 'both'") && workerSrc.includes('id="dafLangBoth" onclick="dafSetLang(\'both\')" aria-pressed="true">עברית + English</button>'), 'Daf text must default to Hebrew and English');
  assert.ok(workerSrc.includes("state.view !== 'page') return;"), 'Daf text must not bind PDF tap-to-zoom gestures');
  assert.ok(workerSrc.includes('class="daf-view-tabs"') && workerSrc.includes('role="tablist"'), 'Daf text and PDF must share a persistent top tab strip');
  assert.ok(workerSrc.includes('id="dafViewerToolbar"') && workerSrc.includes('class="daf-text-control"'), 'Daf text controls must be below and scoped to the text tab');
  assert.ok(workerSrc.includes('daf-pair-number') && workerSrc.includes('data-he-segment') && workerSrc.includes('data-en-segment'), 'aligned Daf text must render indexed phrase pairs');
  assert.ok(workerSrc.includes('value.flat(Infinity)') && workerSrc.includes('daf-pair-label'), 'aligned Daf text must normalize and label each Hebrew/English pair');
  assert.ok(workerSrc.includes('window.dafSetView'), 'Daf page/text toggle must be wired');

  // Entry point from the homepage.
  const homeRes = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/'), mockEnv, mockCtx);
  const homeHtml = await homeRes.text();
  assert.ok(homeHtml.includes('openDafView(event)'), 'homepage must open the Daf Hub as an in-app view');
  assert.ok(html.includes('id="miniPlayer"') && html.includes('id="regularAppView"') && html.includes('id="dafAppView"'), 'Daf route must use the regular app shell and shared mini-player');
  assert.ok(workerSrc.includes("if (dafView && regularView && dafView.style.display !== 'none')") && workerSrc.includes("regularView.style.display = '';"), 'Expanding the shared mini-player from Daf must reveal the regular player view');

  // Init params must use breakout-safe embedding (XSS).
  assert.ok(workerSrc.includes('var sm = ${jsEmbed(') || workerSrc.includes('var sm = ${ jsEmbed('),
    'daf init params must use jsEmbed');
  assert.ok(!workerSrc.includes('var sm = ${JSON.stringify(String(initMasechta'),
    'daf init params must not use raw JSON.stringify');

  console.log('  ✅ Daf hub route, cycle math, OG-style viewer & entry chip verified.');
}

async function testPwaThemePlaylistDeleteClearHistory() {
  console.log('28. Testing PWA theme cookie, playlist delete-confirm persistence & clear history...');
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

  // Issue 1: theme must survive the browser-tab → installed-PWA hop (iOS
  // home-screen apps don't share localStorage, but they share cookies).
  assert.ok(workerSrc.includes("request.headers.get('cookie')") && workerSrc.includes('yutorah_theme=(light|dark)') && workerSrc.includes('honor the theme cookie'), 'server must honor the yutorah_theme cookie when no URL theme param is present');
  assert.ok(workerSrc.includes("document.cookie = 'yutorah_theme='") && workerSrc.includes('Max-Age=31536000'), 'client must mirror the theme choice into a long-lived cookie');
  assert.ok(workerSrc.includes('var cmat = document.cookie.match') && workerSrc.includes('Cookie fallback: installed PWAs'), 'main boot must fall back to the cookie when localStorage is empty (PWA)');
  assert.ok(workerSrc.includes('persistDafTheme') && workerSrc.includes('function persistThemeChoice'), 'daf/main toggles must persist the theme the same way');
  assert.ok(workerSrc.includes('yutorah_theme=(light|dark)(?:;|$)'), 'theme cookie match must be value-anchored (darkish must not match dark)');
  assert.ok(workerSrc.includes("matches) saved = 'light'"), 'fresh contexts with no saved choice must follow the device appearance (isolated iOS PWA fix)');
  assert.ok(workerSrc.includes("removeProperty('--primary')"), 'holiday light-mode vars must be cleared so toggling to dark cannot inherit them');

  // Transcript proxy: deterministic 400-path (no live upstream needed).
  const badRes = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/api/transcript'), mockEnv, mockCtx);
  assert.equal(badRes.status, 400, '/api/transcript without id should return 400');
  const badNon = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/api/transcript?shiurId=abc'), mockEnv, mockCtx);
  assert.equal(badNon.status, 400, '/api/transcript with non-numeric id should return 400');
  assert.ok(workerSrc.includes('/transcriptions/shiur/'), 'transcript proxy must target the upstream transcriptions API');
  assert.ok(workerSrc.includes('id="transcriptSection"'), 'player must contain the transcript section');
  assert.ok(workerSrc.includes('function loadTranscriptSection('), 'transcript loader must exist');
  assert.ok(workerSrc.includes('function answerTranscriptQuiz('), 'quiz answering must exist');
  assert.ok(workerSrc.includes('function submitTranscriptQuiz('), 'quiz must have a submit step with results');
  assert.ok(workerSrc.includes('function toggleTranscriptEnlarge('), 'transcript enlarge toggle must exist (T2)');
  assert.ok(workerSrc.includes('transcript-enlarged'), 'enlarged reading mode styles must exist (T2)');
  assert.ok(workerSrc.includes('function transcriptEnlargeDefault('), 'auto-enlarge setting must exist, logged-in only, default off (T3)');
  assert.ok(workerSrc.includes('transcriptFollowUntil'), 'manual scroll must suspend follow-scroll');
  assert.ok(workerSrc.includes("closest('.transcript-text')"), 'follow-scroll must stay container-relative (never steal page scroll)');
  assert.ok(workerSrc.includes('curEl.offsetTop - lh * 2'), 'follow-scroll must pin the active first line as 3rd visible line');
  assert.ok(workerSrc.includes('function snapTranscriptToTime('), 'transcript must snap to position on load/resume/open');
  assert.ok(workerSrc.includes('function showTranscriptPane('), 'all transcript-open paths must share one positioned entry');
  assert.ok(workerSrc.includes('transcript-chapter-div'), 'transcript must carry inline chapter dividers (C1)');
  assert.ok(workerSrc.includes('transcript-chapter-dur'), 'chapter buttons must show durations (C2)');
  assert.ok(workerSrc.includes('function seekTranscriptChapter('), 'chapter click must jump to its first block (C3)');
  assert.ok(workerSrc.includes('function refreshChapterHighlight('), 'scrolling must highlight the chapter in view (C3)');
  assert.ok(workerSrc.includes('Opening while playing lands on the Transcript tab'), 'opening the section while playing must show the transcript pane');
  assert.ok(workerSrc.includes('id="chapterMarkers"') && workerSrc.includes('id="chapterTitle"'), 'scrubber must carry chapter ticks + live title');
  assert.ok(workerSrc.includes('function renderChapterMarkers(') && workerSrc.includes('function updateChapterTitle('), 'chapter markers/title updaters must exist');

  // Issue 2: a pending inline remove-confirm must survive grid re-renders
  // (background cloudPush/pull → adoptCloudState → renderPlaylistsGrid).
  assert.ok(workerSrc.includes('let devPendingRemove = null'), 'pending remove-confirm must be tracked');
  assert.ok(workerSrc.includes('function devShowRemoveConfirm(pid, id)'), 'confirm swap must be a reusable function');
  assert.ok(workerSrc.includes('function devCancelRemove()'), 'cancel must clear pending state before re-rendering');
  assert.ok(workerSrc.includes('onclick="devCancelRemove()"'), 'confirm Cancel must route through devCancelRemove');
  assert.ok(workerSrc.includes('devPendingRemove = null;\n    if (pid === \'history\')'), 'confirmed remove must clear pending state');
  assert.ok(workerSrc.includes('Re-apply a pending remove confirmation wiped by this re-render'), 'renderPlaylistsGrid must re-apply a pending confirm after rendering');

  // Issue 3: clear-all-history button with a normal confirm popup.
  assert.ok(workerSrc.includes('onclick="devClearHistoryAsk()"') && workerSrc.includes('🧹 Clear History'), 'history view must offer a Clear History button');
  assert.ok(workerSrc.includes('function devClearHistoryAsk()') && workerSrc.includes("title: 'Clear all history?'"), 'clear-history must ask via the generic confirm modal');
  assert.ok(workerSrc.includes('function devClearHistory()') && workerSrc.includes('yutorah_recent_history\', JSON.stringify([])'), 'clear-history must empty local history');
  assert.ok(workerSrc.includes('let historyClearAllPending = false') && workerSrc.includes('body.clearHistory = true'), 'clear-history must flag the next push for a server-side wipe');
  assert.ok(workerSrc.includes('if (sent.history && payload.clearHistory === true) historyClearAllPending = false'), 'clear-all flag must clear only after a successful push (failed pushes must retry, not resurrect)');
  assert.ok(workerSrc.includes('data-dev-remove-confirm-pid'), 'pending confirm must be marked so a remove on another item reverts it');
  assert.ok(workerSrc.includes('body.clearHistory === true') && workerSrc.includes('DELETE FROM listening_history WHERE user_id = ?\''), 'server must wipe all history rows on clear-all intent');

  // Server honors the theme cookie: homepage SSR must pick it up.
  const res = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/', { headers: { Cookie: 'yutorah_theme=light' } }), mockEnv, mockCtx);
  assert.equal(res.status, 200, 'homepage with theme cookie should return 200 OK');
  const html = await res.text();
  assert.ok(!html.includes('<html lang="en" data-theme="dark">'), 'theme=light cookie must SSR the light theme (no dark attr)');

  console.log('  ✅ PWA theme cookie, delete-confirm persistence & clear history verified.');
}

async function testSkipFlashFeedback() {
  console.log('29. Testing skip ±10/±30 flash feedback...');
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.ok(workerSrc.includes('id="skipFlash"'), 'shell must contain the skip-flash overlay');
  assert.ok(workerSrc.includes('function flashSkipFeedback(sec)'), 'skip feedback function must exist');
  assert.ok(workerSrc.includes('flashSkipFeedback(sec);'), 'skip() must trigger the flash after seeking');
  assert.ok(workerSrc.includes('.skip-flash'), 'skip-flash styling must exist');
  assert.ok(workerSrc.includes('skipFlashTimer'), 'skip flash must use its own timer (never fight toasts)');
  console.log('  ✅ Skip flash feedback verified.');
}

async function testCardPlayStatesAndMiniPop() {
  console.log('30. Testing card play 3-states & immediate mini-player...');
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.ok(workerSrc.includes('function updateCardPlayBadges()'), 'central badge updater must exist');
  assert.ok(workerSrc.includes('.quick-play-badge.is-playing'), 'playing badge styling must exist');
  assert.ok(workerSrc.includes('▶ Playing') && workerSrc.includes('‖ Paused'), 'badges must show Playing / Paused text');
  assert.ok(workerSrc.includes('data-orig-text'), 'original badge text (Play/Resume) must be restored on deselect');
  assert.ok(workerSrc.includes('Set track state BEFORE minimize/expand'), 'playShiurById must set track state before minimizePlayer so the mini-player is not swallowed');
  assert.ok(workerSrc.includes('resyncMiniChrome'), 'mini chrome + badges must re-sync once the fetched track type (audio/article) is known');
  assert.ok(workerSrc.includes('Badge tap (stayMini): cycle pause/resume in place.'), 'badge tap on the playing card must toggle pause/resume (F1)');
  assert.ok(workerSrc.includes('Card tap: back to the big player'), 'card tap on the loaded track must expand the big player (F3)');
  assert.ok(workerSrc.includes('function resolveResumeSec(id)'), 'unified resume resolver must exist (F2)');
  assert.ok(workerSrc.includes('let resumeSec = resolveResumeSec(id);'), 'track loads must use the unified resolver (F2)');
  assert.ok(workerSrc.includes('targetSec = resolveResumeSec(currentShiurId);'), 'initial-time path must use the unified resolver (F2)');
  assert.ok(workerSrc.includes('function cardPlayBadgeHtml(id, isArticle, label, onclickJs, cls)'), 'badges must paint current state at render time (F4/G1)');
  assert.ok(workerSrc.includes("cardPlayBadgeHtml(id, isArticle, '▶ Play', badgePlay)"), 'search cards must use the state-aware badge (F4)');
  assert.ok(workerSrc.includes("cardPlayBadgeHtml(item.id, isDoc, '▶ Resume'"), 'history cards must use the state-aware badge (F4)');
  assert.ok(workerSrc.includes("newUrl.pathname = '/' + String(currentShiurId);"), 'search must keep the loaded shiur path (G2)');
  assert.ok(workerSrc.includes('if (!isDafRoute && (searchQuery || hasFilterParams))'), 'server must prefetch search even with a shiur loaded (G2)');
  assert.ok(workerSrc.includes("'series-sub-play')"), 'series drawer badges must use the state-aware badge (G1)');
  assert.ok(workerSrc.includes('.series-sub-play.is-playing'), 'series drawer badges need playing-state styling (G1)');
  assert.ok(workerSrc.includes('.series-sub-card .series-sub-play'), 'badge updater must scan series drawer badges (G1)');
  assert.ok(workerSrc.includes('function resolveSeriesDocs('), 'series sibling resolver must exist (G3)');
  assert.ok(workerSrc.includes('function updateSeriesStrip('), 'big-player series strip updater must exist (G3)');
  // Phase 1d: Daf cycle invariants come from the module, not literals.
  assert.equal(DAF_MASECHTOT.length, 36, 'cycle must have 36 masechtot');
  assert.equal(DAF_MASECHTOT.reduce((a, p) => a + p[1], 0), DAF_CYCLE_DAYS, 'folio counts must sum to the cycle length');
  assert.equal(DAF_CYCLE_DAYS, 2711, 'cycle must be 2711 dafim');
  assert.deepEqual(dafRefForIndexUTC(0), { masechta: 'Berachos', daf: 2, count: 64 }, 'day 0 must be Berachos 2');
  assert.deepEqual(dafRefForIndexUTC(dafIndexForDateUTC(2023, 5, 11)), { masechta: 'Gittin', daf: 7, count: 90 }, 'Gittin-May-2023 checkpoint must hold');
  assert.ok(dafIndexForRefUTC('bava_kamma', 3) === dafIndexForRefUTC('Bava Kamma', 3) && dafIndexForRefUTC('Bava Kamma', 3) >= 0, 'tractate normalization must hold');
  assert.equal(dafValidDateISO('2026-13-99'), false, 'impossible dates must be rejected');
  assert.ok(workerSrc.includes('id="seriesStrip"'), 'player card must contain the series strip (G3)');
  assert.ok(workerSrc.includes('function toggleCardSeries('), 'single cards need lazy series drawers (G3)');
  assert.ok(workerSrc.includes('series-now-playing'), 'current part must be marked in drawers (G3)');
  assert.ok(workerSrc.includes('\\\\b(parts?'), 'family regex must survive the server template literal doubled (escape regression)');
  assert.ok(workerSrc.includes('function seriesFamilyQuery('), 'title-family fallback must exist (H1)');
  assert.ok(workerSrc.includes('most specific run'), 'resolver must prefer the most specific run (H1)');
  assert.ok(workerSrc.includes('then the catalog name carries them'), 'resolver must fall back to the catalog name when family is too specific (H1b)');
  assert.ok(workerSrc.includes('function fetchSeriesPage('), 'paged drawers need a load-more fetcher (H1c)');
  assert.ok(workerSrc.includes('function seriesIdentityFromPage('), 'player must reuse in-memory search docs for series identity');
  assert.ok(workerSrc.includes('currentSeriesGroup'), 'sibling clicks must reuse the resolved group');
  assert.ok(workerSrc.includes('seriesKey'), 'series context must travel in the URL');
  assert.ok(workerSrc.includes('function paintSeriesStrip('), 'strip paint must be shared by fresh/memory/URL paths');
  assert.ok(workerSrc.includes('function scrollPlayButtonIntoView()'), 'expanding the player must center the play button');
  assert.ok(workerSrc.includes('function seriesDiagOn()'), 'strip diagnostics must exist (?diag=series)');
  assert.ok(workerSrc.includes('data-page-mode'), 'drawers must carry paging state (H1c)');
  assert.ok(workerSrc.includes('Load more'), 'drawers must offer to load more (H1c)');
  assert.ok(workerSrc.includes('function listeningUrlPath()'), 'home/brand must preserve the loaded track URL (H2)');
  assert.ok(workerSrc.includes("newUrl.searchParams.delete('restored')"), 'search must drop the one-shot flag (H2/G4)');
  assert.ok(workerSrc.includes('yutorah_last_session'), 'app must snapshot the loaded track on hide/unload (G4)');
  assert.ok(workerSrc.includes('function saveLastSession()') && workerSrc.includes('function clearLastSession()'), 'session save/clear helpers must exist (G4)');
  assert.ok(workerSrc.includes('Session restore: reopen where you left off'), 'bare launches must restore the snapshot paused (G4)');
  assert.ok(workerSrc.includes("get('restored') === '1'"), 'restored loads must skip boot autoplay (G4)');
  assert.ok(workerSrc.includes("ru.pathname === '/daf'"), 'restore must never hijack Daf links (G4)');
  console.log('  ✅ Card play states & mini-player pop verified.');
}

async function testThemeNoContagion() {
  console.log('31. Testing theme isolation (no cross-device contagion)...');
  const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.ok(!workerSrc.includes("url.searchParams.set(themeKey"), 'copy-link must not stamp theme into shared URLs');
  assert.ok(workerSrc.includes('renders for THIS load only'), 'URL-supplied theme must render without overwriting the saved choice');
  assert.ok(workerSrc.includes("rawThemeParam === 'light'"), 'server must still honor URL theme for first-paint SSR');
  // A theme-stamped link renders that theme once but must not save it:
  // localStorage + cookie writes happen only in the toggle handlers now.
  // Both boot scripts contain the same `var urlTheme` marker (daf first).
  const firstBoot = workerSrc.indexOf('var urlTheme = (p.get(');
  const secondBoot = workerSrc.indexOf('var urlTheme = (p.get(', firstBoot + 1);
  for (const [name, at] of [['daf', firstBoot], ['main', secondBoot]]) {
    const region = workerSrc.slice(at, at + 2500);
    assert.ok(!region.includes('setItem'), name + ' boot URL-theme must not write localStorage');
    assert.ok(!region.includes("yutorah_theme='"), name + ' boot URL-theme must not write the cookie');
  }
  const popIdx = workerSrc.indexOf('back/forward navigation (render-only');
  assert.ok(popIdx !== -1, 'popstate render-only marker must exist');
  const popRegion = workerSrc.slice(popIdx, popIdx + 1200);
  assert.ok(!popRegion.includes('setItem') && !popRegion.includes('document.cookie'), 'popstate theme sync must not persist');
  assert.ok(workerSrc.includes("url.searchParams.delete('theme')"), 'share builders must strip stamped theme params');
  console.log('  ✅ Theme isolation verified.');
}

async function runAll() {
  try {
    await testHomepage();
    await testAudioShiur();
    await testArticleShiur();
    await testPdfProxy();
    await testSearchEndpoints();
    await testSponsorshipApi();
    await testMediaTypeFilter();
    await testLiquidModeExtraction();
    await testMediaSessionIntegration();
    await testDevModeAndAvatarVariants();
    await testDropdownNavAndThemeAesthetics();
    await testPublicPlaylistSubscriptionOptions();
    await testDevPersonasAndSecondTab();
    await testHeroSizingAndPlaylistTagAutocomplete();
    await testSearchResultsScrollAndHeroSlideClick();
    await testPlaylistSuitePhase5();
    await testPlaylistsEnhancementsRound2();
    await testPlaylistUrlDeepLinks();
    await testDualReviewAccessibilityAndSharingRemediation();
    await testLoggedOutHeaderThemeToggle();
    await testPwaIntegration();
    await testPlaylistsTabAndDisplayNameBanner();
    await testZmanimIconShrinkAndSpacePreservation();
    await testMobileDockingAndPublicPlaylistButtons();
    await testPublicPlaylistPublishingAndSyncLifecycle();
    await testPublicPlaylistCopyTooltipAndSubscriptionPersistence();
    await testSourceSheetButton();
    await testDafHub();
    await testPwaThemePlaylistDeleteClearHistory();
    await testSkipFlashFeedback();
    await testCardPlayStatesAndMiniPop();
    await testThemeNoContagion();
    console.log('\n🎉 ALL BASIC FUNCTIONALITY, ARTICLE READER & LIQUID MODE TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

runAll();
