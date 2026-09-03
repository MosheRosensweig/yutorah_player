/**
 * YUTorah Player — Cloudflare Worker Web Application
 *
 * A standalone, zero-friction web portal and enhanced audio player.
 * No extensions, no bookmarklets, no installation required.
 * Just visit the website on any phone or laptop and it works instantly!
 */

const TARGET_API_ORIGIN = 'https://www.yutorah.org';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. API proxy for lecture data (CORS-friendly, bypasses any browser restrictions)
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
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
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

    // 2. Extract Shiur ID from URL paths like:
    // /1187082
    // /lectures/1187082
    // /lectures/details?shiurID=1187082
    // ?shiurId=1187082
    let shiurId = url.searchParams.get('shiurId') || url.searchParams.get('shiurID') || url.searchParams.get('id');
    const pathMatch = url.pathname.match(/^\/(?:lectures\/)?(\d+)/);
    if (!shiurId && pathMatch) {
      shiurId = pathMatch[1];
    }

    // If audioUrl is provided directly
    const directAudio = url.searchParams.get('audioUrl') || url.searchParams.get('url');

    // 3. Render HTML Web App
    return new Response(renderAppHtml({ shiurId, directAudio, timestamp: url.searchParams.get('t') }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      }
    });
  }
};

function renderAppHtml({ shiurId, directAudio, timestamp }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>YUTorah Enhanced Player</title>
  <style>
    :root {
      --primary: #2b4c7e;
      --primary-dark: #1b3356;
      --accent: #d4a373;
      --bg: #f4f6f9;
      --card: #ffffff;
      --text: #22252a;
      --text-muted: #656d78;
      --border: #e1e6ed;
      --shadow: 0 4px 20px rgba(0, 0, 0, 0.07);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
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
      background: var(--primary);
      color: #fff;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: #fff;
      font-weight: 700;
      font-size: 18px;
    }
    .brand span {
      background: rgba(255,255,255,0.2);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }

    /* Main Container */
    main {
      flex: 1;
      max-width: 820px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 16px 40px;
    }

    /* Search & Launcher Card */
    .launcher-card {
      background: var(--card);
      border-radius: 12px;
      padding: 18px 20px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .input-row {
      display: flex;
      gap: 10px;
    }
    .shiur-input {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid var(--border);
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .shiur-input:focus {
      border-color: var(--primary);
    }
    .play-btn {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 24px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .play-btn:hover {
      background: var(--primary-dark);
    }

    /* Player Card */
    .player-card {
      background: var(--card);
      border-radius: 14px;
      padding: 24px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      display: none;
      animation: fadeIn 0.25s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* Shiur Info Header */
    .shiur-header {
      display: flex;
      gap: 18px;
      align-items: center;
      margin-bottom: 20px;
    }
    .speaker-photo {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      object-fit: cover;
      background: #e2e6ec;
      border: 2px solid var(--border);
      flex-shrink: 0;
    }
    .shiur-details {
      flex: 1;
      min-width: 0;
    }
    .shiur-title {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 6px;
      color: var(--text);
    }
    .shiur-speaker {
      font-size: 15px;
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
    }
    .scrubber-bar {
      width: 100%;
      height: 8px;
      background: #e4e8ef;
      border-radius: 4px;
      cursor: pointer;
      position: relative;
      touch-action: none;
    }
    .scrubber-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 4px;
      width: 0%;
      position: relative;
    }
    .scrubber-handle {
      position: absolute;
      right: -7px;
      top: 50%;
      transform: translateY(-50%);
      width: 16px;
      height: 16px;
      background: var(--primary);
      border: 2px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
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
      gap: 12px;
      margin-bottom: 20px;
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
      transition: all 0.15s ease;
      touch-action: manipulation;
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
      width: 48px;
      height: 48px;
      font-size: 14px;
    }
    .ctrl-btn.play {
      width: 64px;
      height: 64px;
      font-size: 26px;
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
    }

    /* Featured Shiurim Section */
    .section-title {
      font-size: 18px;
      font-weight: 700;
      margin: 28px 0 14px;
      color: var(--text);
    }
    .shiur-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
    }
    .quick-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .quick-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
      border-color: var(--primary);
    }
    .quick-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 6px;
      color: var(--text);
    }
    .quick-speaker {
      font-size: 13px;
      color: var(--primary);
      font-weight: 600;
    }
    .quick-duration {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Loading Spinner */
    .spinner {
      display: none;
      text-align: center;
      padding: 30px;
      font-size: 15px;
      font-weight: 600;
      color: var(--primary);
    }
  </style>
</head>
<body>

<header>
  <a href="/" class="brand">
    🎧 YUTorah Enhanced <span>PLAYER</span>
  </a>
</header>

<main>
  <!-- Launcher Input -->
  <div class="launcher-card">
    <div class="input-row">
      <input type="text" id="shiurInput" class="shiur-input" placeholder="Paste any YUTorah URL or Shiur ID (e.g. 1187082)">
      <button class="play-btn" onclick="handleLaunch()">▶ Play</button>
    </div>
  </div>

  <div class="spinner" id="loadingSpinner">⏳ Loading shiur...</div>

  <!-- Audio Player -->
  <div class="player-card" id="playerCard">
    <div class="shiur-header">
      <img id="speakerImg" class="speaker-photo" src="" alt="">
      <div class="shiur-details">
        <h1 id="shiurTitle" class="shiur-title"></h1>
        <div id="shiurSpeaker" class="shiur-speaker"></div>
        <div id="shiurMeta" class="shiur-meta"></div>
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
        <span id="totalTime">0:00</span>
      </div>
    </div>

    <!-- Transport -->
    <div class="transport-row">
      <button class="ctrl-btn skip" onclick="skip(-30)" title="Back 30s">-30</button>
      <button class="ctrl-btn skip" onclick="skip(-10)" title="Back 10s">-10</button>
      <button class="ctrl-btn play" id="playBtn" onclick="togglePlay()">▶</button>
      <button class="ctrl-btn skip" onclick="skip(10)" title="Forward 10s">+10</button>
      <button class="ctrl-btn skip" onclick="skip(30)" title="Forward 30s">+30</button>
    </div>

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
        <a class="action-btn" id="dlBtn" href="#" target="_blank">
          ⬇️ Download MP3
        </a>
      </div>
    </div>

    <div class="shiur-desc" id="shiurDesc" style="display:none;"></div>
  </div>

  <!-- Featured / Quick Suggestions -->
  <div id="featuredSection">
    <h2 class="section-title">🔥 Featured & Recent Shiurim</h2>
    <div class="shiur-cards">
      <div class="quick-card" onclick="loadShiur('1187082')">
        <div class="quick-title">The Power of לדוד</div>
        <div class="quick-speaker">Rabbi Noach Goldstein</div>
        <div class="quick-duration">⏱ 46 min · Elul / Machshava</div>
      </div>
      <div class="quick-card" onclick="loadShiur('1187083')">
        <div class="quick-title">13 Middot Explainer: Understanding Each Middah</div>
        <div class="quick-speaker">Rabbi Moshe Taragin</div>
        <div class="quick-duration">⏱ 1 hr 48 min · Yeshivat Har Etzion</div>
      </div>
      <div class="quick-card" onclick="loadShiur('1187202')">
        <div class="quick-title">Chassidus on Teshuva - Kedushas Levi</div>
        <div class="quick-speaker">Mrs. Emma Katz</div>
        <div class="quick-duration">⏱ 10 min · Chicago Kollel</div>
      </div>
      <div class="quick-card" onclick="loadShiur('1187183')">
        <div class="quick-title">Tehilim 81: Shir shel Yom of Rosh ha'Shanah</div>
        <div class="quick-speaker">Rabbi Matt Schneeweiss</div>
        <div class="quick-duration">⏱ 1 hr 3 min · Nach</div>
      </div>
    </div>
  </div>
</main>

<audio id="audioElement" preload="metadata"></audio>

<script>
  const audio = document.getElementById('audioElement');
  let currentShiur = null;
  const initialShiurId = ${JSON.stringify(shiurId || '')};
  const initialDirectAudio = ${JSON.stringify(directAudio || '')};
  const initialTimestamp = ${JSON.stringify(timestamp || '')};

  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
    return m + ':' + seconds.toString().padStart(2, '0');
  }

  function handleLaunch() {
    const val = document.getElementById('shiurInput').value.trim();
    if (!val) return;
    const m = val.match(/(?:lectures\/)?(\d+)/);
    if (m) {
      loadShiur(m[1]);
    } else if (val.match(/\\.(mp3|m4a|wav)(\\?|$)/i)) {
      playDirectUrl(val);
    }
  }

  document.getElementById('shiurInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLaunch();
  });

  async function loadShiur(id) {
    document.getElementById('loadingSpinner').style.display = 'block';
    document.getElementById('playerCard').style.display = 'none';

    try {
      const resp = await fetch('/sidebar/lecturedata?shiurID=' + encodeURIComponent(id));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      currentShiur = data;

      // Update UI
      document.getElementById('shiurTitle').textContent = data.shiurTitle || 'Untitled Shiur';
      document.getElementById('shiurSpeaker').textContent = data.shiurTeacherFullName || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherFullName : '');
      document.getElementById('shiurMeta').textContent = (data.shiurDuration || '') + (data.shiurDateFormatted ? ' · ' + data.shiurDateFormatted : '');

      const photo = data.teacherPhotoURL_lp || data.teacherPhotoURL || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherPhotoURL : '');
      const imgEl = document.getElementById('speakerImg');
      if (photo) {
        imgEl.src = photo;
        imgEl.style.display = 'block';
      } else {
        imgEl.style.display = 'none';
      }

      const descEl = document.getElementById('shiurDesc');
      if (data.shiurDescription) {
        descEl.textContent = data.shiurDescription;
        descEl.style.display = 'block';
      } else {
        descEl.style.display = 'none';
      }

      // Download link
      const dl = data.downloadURL || data.playerDownloadURL;
      const dlBtn = document.getElementById('dlBtn');
      if (dl) {
        dlBtn.href = dl;
        dlBtn.style.display = 'inline-flex';
      } else {
        dlBtn.style.display = 'none';
      }

      // Audio Source
      const audioUrl = data.playerDownloadURL || (data.shiurURL ? 'https://shiurim.yutorah.net' + data.shiurURL : null) || dl;
      if (!audioUrl) throw new Error('No audio file available');

      audio.src = audioUrl;
      audio.load();

      // Mobile Lock Screen Metadata
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: data.shiurTitle || 'Shiur',
          artist: document.getElementById('shiurSpeaker').textContent || 'YUTorah',
          album: 'YUTorah Online',
          artwork: photo ? [{ src: photo, sizes: '300x300', type: 'image/jpeg' }] : []
        });
      }

      // Update URL without reload
      const newUrl = new URL(window.location.href);
      newUrl.pathname = '/' + id;
      newUrl.search = '';
      window.history.pushState({ id }, '', newUrl.toString());

      document.getElementById('loadingSpinner').style.display = 'none';
      document.getElementById('playerCard').style.display = 'block';

      // Auto-start play
      audio.play().catch(() => {});

    } catch (err) {
      document.getElementById('loadingSpinner').textContent = '⚠️ Error loading shiur: ' + err.message;
    }
  }

  function playDirectUrl(url) {
    audio.src = url;
    document.getElementById('shiurTitle').textContent = 'Audio Stream';
    document.getElementById('shiurSpeaker').textContent = url;
    document.getElementById('speakerImg').style.display = 'none';
    document.getElementById('shiurDesc').style.display = 'none';
    document.getElementById('playerCard').style.display = 'block';
    audio.play().catch(() => {});
  }

  // Audio Controls
  function togglePlay() {
    if (audio.paused) audio.play();
    else audio.pause();
  }

  function skip(sec) {
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + sec));
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

  // Scrubber click
  document.getElementById('scrubberBar').addEventListener('click', (e) => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  });

  // Audio Events
  audio.addEventListener('play', () => document.getElementById('playBtn').textContent = '⏸');
  audio.addEventListener('pause', () => document.getElementById('playBtn').textContent = '▶');
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    document.getElementById('scrubberFill').style.width = pct + '%';
    document.getElementById('curTime').textContent = formatTime(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', () => {
    document.getElementById('totalTime').textContent = formatTime(audio.duration);
    if (initialTimestamp) {
      const sec = parseFloat(initialTimestamp);
      if (!isNaN(sec)) audio.currentTime = sec;
    }
  });

  // MediaSession Action Handlers
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('seekbackward', (details) => skip(-(details.seekOffset || 10)));
      navigator.mediaSession.setActionHandler('seekforward', (details) => skip(details.seekOffset || 10));
    } catch(e) {}
  }

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(e.shiftKey ? -30 : -10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); skip(e.shiftKey ? 30 : 10); }
    else if (e.key === 'm' || e.key === 'M') { audio.muted = !audio.muted; }
  });

  // Initial load
  if (initialShiurId) {
    loadShiur(initialShiurId);
  } else if (initialDirectAudio) {
    playDirectUrl(initialDirectAudio);
  }
</script>

</body>
</html>
`;
}
