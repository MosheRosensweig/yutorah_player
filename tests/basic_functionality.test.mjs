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
  console.log('  ✅ Article shiur page renders with Article Reader, Page Modes, and PDF.js integration.');
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

async function runAll() {
  try {
    await testHomepage();
    await testAudioShiur();
    await testArticleShiur();
    await testPdfProxy();
    await testSearchEndpoints();
    await testSponsorshipApi();
    console.log('\n🎉 ALL BASIC FUNCTIONALITY & ARTICLE READER TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

runAll();
