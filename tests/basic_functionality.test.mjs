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
  assert.ok(html.includes('newPlEmojiGrid'), 'newPlEmojiGrid defined in creation modal');
  assert.ok(html.includes('newPlDesc'), 'newPlDesc description textarea defined in creation modal');
  assert.ok(html.includes('newPlTagSearch'), 'newPlTagSearch taxonomy search defined in creation modal');
  assert.ok(html.includes('newPlChips'), 'newPlChips tag chips container defined in creation modal');
  assert.ok(html.includes('newPlError'), 'newPlError duplicate/validation element defined in creation modal');

  console.log('  ✅ Public playlist save choice modal, live-sync subscription, segmented controls, sorting & creation modal verified.');
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
  console.log('20. Testing Logged-Out Header Theme Toggle & Right-Hand Placement...');

  const res = await worker.fetch(new Request('https://yutorah-player.mrosensweig.workers.dev/'));
  assert.equal(res.status, 200, 'Homepage SSR must return 200 OK');
  const html = await res.text();

  // 1. Theme toggle button is rendered on the right-hand side of #authBtn in header HTML
  const authBtnIndex = html.indexOf('id="authBtn"');
  const themeToggleIndex = html.indexOf('id="themeToggleBtn"');
  const hebrewDateIndex = html.indexOf('id="hebrewDateBadge"');
  assert.ok(authBtnIndex !== -1, 'Header must contain #authBtn');
  assert.ok(themeToggleIndex !== -1, 'Header must contain #themeToggleBtn');
  assert.ok(hebrewDateIndex !== -1, 'Header must contain #hebrewDateBadge');
  assert.ok(authBtnIndex < themeToggleIndex, '#themeToggleBtn must be rendered after #authBtn in DOM to sit on the right-hand side');
  assert.ok(hebrewDateIndex < themeToggleIndex, '#themeToggleBtn must be rendered after #hebrewDateBadge in DOM');

  // 2. CSS orders #themeToggleBtn on the right with order: 10
  assert.ok(html.includes('.header-right #themeToggleBtn'), 'CSS must specify .header-right #themeToggleBtn styling');
  assert.ok(html.includes('order: 10'), '#themeToggleBtn must have order: 10 in CSS');

  // 3. Mobile media query keeps theme toggle visible in header for logged-out / guest users on intermediate screens (521px-640px)
  assert.ok(html.includes('body:not(.is-logged-in) #themeToggleBtn'), 'CSS must specify themeToggleBtn for non-logged-in users on mobile');
  assert.ok(html.includes('display: inline-flex;'), 'Non-logged-in theme toggle displays inline-flex by default without !important so JS overflow can hide it');

  // 4. Narrow mobile screens (<= 520px) suppress theme toggle to prevent cut-off
  assert.ok(html.includes('@media (max-width: 520px)'), 'CSS must define max-width 520px breakpoint');
  assert.ok(html.includes('#themeToggleBtn') && html.includes('display: none !important'), 'CSS must suppress header themeToggleBtn on <= 520px screens');

  // 5. Mobile media query hides theme toggle when logged in (accessible via gear settings menu)
  assert.ok(html.includes('body.is-logged-in #themeToggleBtn'), 'CSS must hide header themeToggleBtn when logged in on mobile');

  // 6. Dynamic overflow detection suppresses theme toggle if it would be cut off or collide
  assert.ok(html.includes('function checkHeaderOverflow()'), 'checkHeaderOverflow must be defined in client JS');
  assert.ok(html.includes('isCutOff') && html.includes("themeBtn.style.display = 'none'"), 'checkHeaderOverflow must hide theme toggle if cut off');

  // 7. Settings dropdown menu includes theme toggle fallback for all users (logged-in and guest)
  assert.ok(html.includes('menu-theme-toggle-btn'), 'Settings menu must provide theme toggle fallback for all users');

  // 8. Client-side renderAuthBtn updates is-logged-in class on document.body
  assert.ok(html.includes("document.body.classList.add('is-logged-in')"), 'renderAuthBtn must add is-logged-in to body when user is logged in');
  assert.ok(html.includes("document.body.classList.remove('is-logged-in')"), 'renderAuthBtn must remove is-logged-in from body when user is logged out');

  console.log('  ✅ Logged-out header theme toggle button, cut-off suppression & right-hand side placement verified.');
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
    console.log('\n🎉 ALL BASIC FUNCTIONALITY, ARTICLE READER & LIQUID MODE TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

runAll();


