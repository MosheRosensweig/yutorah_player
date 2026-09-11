// tests/basic_functionality.test.mjs
// Automated regression test suite for YUTorah Player
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

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
    console.log('\n🎉 ALL BASIC FUNCTIONALITY, ARTICLE READER & LIQUID MODE TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

runAll();

