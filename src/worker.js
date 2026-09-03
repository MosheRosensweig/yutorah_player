/**
 * YUTorah Player — Cloudflare Worker Web Application
 *
 * Standalone, zero-friction web portal and enhanced audio player.
 * Server-renders shiur metadata directly into HTML for instant playback.
 * Works seamlessly on iOS Safari, Android Chrome, Mac, and Windows.
 */

const TARGET_API_ORIGIN = 'https://www.yutorah.org';

// Curated list of popular / featured shiurim for the homepage
const FEATURED_SHIURIM = [
  {
    id: '1187082',
    title: 'The Power of לדוד',
    speaker: 'Rabbi Noach Goldstein',
    speakerPhoto: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/noach_goldstein.jpg',
    duration: '46 min',
    category: 'Elul / Machshava'
  },
  {
    id: '1187083',
    title: '13 Middot Explainer: Understanding Each Middah',
    speaker: 'Rabbi Moshe Taragin',
    speakerPhoto: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/mtaragin.jpg',
    duration: '1 hr 48 min',
    category: 'Yeshivat Har Etzion'
  },
  {
    id: '1187202',
    title: 'Chassidus on Teshuva - Kedushas Levi',
    speaker: 'Mrs. Emma Katz',
    speakerPhoto: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/emma_katz.jpg',
    duration: '10 min',
    category: 'Chicago Kollel'
  },
  {
    id: '1187183',
    title: "Tehilim 81: Shir shel Yom of Rosh ha'Shanah",
    speaker: 'Rabbi Matt Schneeweiss',
    speakerPhoto: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/matt_schneeweiss.jpg',
    duration: '1 hr 3 min',
    category: 'Nach'
  },
  {
    id: '988711',
    title: 'Shemot 5781',
    speaker: 'Rabbi Hershel Schachter',
    speakerPhoto: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/hershel_schachter.jpg',
    duration: '1 hr 17 min',
    category: 'Parsha / Halacha'
  },
  {
    id: '987056',
    title: 'Josh Gelernter Mikraos Gedolos Parsha Chabura',
    speaker: 'Rabbi Yaakov B. Neuburger',
    speakerPhoto: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/yaacov_b._neuberger.jpg',
    duration: '31 min',
    category: 'Parsha / Machshava'
  }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. API proxy for lecture data (for live searches / dynamic lookups)
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

    // 2. Extract Shiur ID from paths like /1187082, /lectures/1187082, or ?shiurId=1187082
    let shiurId = url.searchParams.get('shiurId') || url.searchParams.get('shiurID') || url.searchParams.get('id');
    const pathMatch = url.pathname.match(/^\/(?:lectures\/)?(\d+)/);
    if (!shiurId && pathMatch) {
      shiurId = pathMatch[1];
    }

    const directAudio = url.searchParams.get('audioUrl') || url.searchParams.get('url');
    const timestamp = url.searchParams.get('t') || '';

    // 3. If a shiurId is requested, pre-fetch metadata so the page arrives fully loaded!
    let shiurData = null;
    if (shiurId) {
      try {
        const resp = await fetch(`${TARGET_API_ORIGIN}/sidebar/lectureData?shiurId=${encodeURIComponent(shiurId)}`, {
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
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

    // 4. Render and return the HTML app
    return new Response(renderAppHtml({ shiurData, shiurId, directAudio, timestamp }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      }
    });
  }
};

function renderAppHtml({ shiurData, shiurId, directAudio, timestamp }) {
  const isPlaying = Boolean(shiurData || directAudio);

  let title = 'YUTorah Enhanced Player';
  let speaker = '';
  let photo = '';
  let duration = '';
  let meta = '';
  let description = '';
  let audioUrl = '';
  let downloadUrl = '';

  if (shiurData) {
    title = shiurData.shiurTitle || 'Untitled Shiur';
    speaker = shiurData.shiurTeacherFullName || (shiurData.shiurTeachers && shiurData.shiurTeachers[0] ? shiurData.shiurTeachers[0].teacherFullName : 'YUTorah');
    photo = shiurData.teacherPhotoURL_lp || shiurData.teacherPhotoURL || (shiurData.shiurTeachers && shiurData.shiurTeachers[0] ? shiurData.shiurTeachers[0].teacherPhotoURL : '');
    duration = shiurData.shiurDuration || '';
    meta = duration + (shiurData.shiurDateFormatted ? ' · ' + shiurData.shiurDateFormatted : '');
    description = shiurData.shiurDescription || '';
    downloadUrl = shiurData.downloadURL || shiurData.playerDownloadURL || '';
    audioUrl = shiurData.playerDownloadURL || (shiurData.shiurURL ? 'https://shiurim.yutorah.net' + shiurData.shiurURL : '') || downloadUrl;
  } else if (directAudio) {
    title = 'Audio Stream';
    speaker = directAudio;
    audioUrl = directAudio;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(title)} — YUTorah Enhanced</title>
  <style>
    :root {
      --primary: #2b4c7e;
      --primary-dark: #1b3356;
      --accent: #d4a373;
      --bg: #f4f6f9;
      --card: #ffffff;
      --text: #22252a;
      --text-muted: #656d78;
      --border: #dde2ea;
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
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
    }
    .header-inner {
      max-width: 860px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      max-width: 860px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 16px 50px;
    }

    /* Search & Launcher Card */
    .launcher-card {
      background: var(--card);
      border-radius: 12px;
      padding: 16px 18px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      margin-bottom: 22px;
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
      margin-bottom: 28px;
      ${isPlaying ? '' : 'display: none;'}
    }

    /* Shiur Info Header */
    .shiur-header {
      display: flex;
      gap: 18px;
      align-items: center;
      margin-bottom: 20px;
    }
    .speaker-photo {
      width: 74px;
      height: 74px;
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
      height: 10px;
      background: #e4e8ef;
      border-radius: 5px;
      cursor: pointer;
      position: relative;
      touch-action: none;
    }
    .scrubber-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 5px;
      width: 0%;
      position: relative;
    }
    .scrubber-handle {
      position: absolute;
      right: -8px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
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
      width: 50px;
      height: 50px;
      font-size: 14px;
    }
    .ctrl-btn.play {
      width: 66px;
      height: 66px;
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
      ${description ? '' : 'display: none;'}
    }

    /* Section Title */
    .section-title {
      font-size: 19px;
      font-weight: 700;
      margin: 10px 0 16px;
      color: var(--text);
    }

    /* Featured Shiur Cards */
    .shiur-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
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
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .quick-card-link:hover {
      transform: translateY(-3px);
      box-shadow: 0 6px 18px rgba(0,0,0,0.08);
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
      width: 46px;
      height: 46px;
      border-radius: 50%;
      object-fit: cover;
      background: #e2e6ec;
      flex-shrink: 0;
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
    }
    .quick-card-speaker {
      font-size: 13px;
      color: var(--primary);
      font-weight: 600;
    }
    .quick-card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid #edf0f5;
      padding-top: 10px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .quick-play-badge {
      background: #eef2f7;
      color: var(--primary);
      font-weight: 700;
      padding: 4px 10px;
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
  </style>
</head>
<body>

<header>
  <div class="header-inner">
    <a href="/" class="brand">
      🎧 YUTorah Enhanced <span>PLAYER</span>
    </a>
  </div>
</header>

<main>
  <!-- Launcher Input -->
  <div class="launcher-card">
    <div class="input-row">
      <input type="text" id="shiurInput" class="shiur-input" placeholder="Paste any YUTorah lecture URL or ID (e.g. 1187082)">
      <button class="play-btn" onclick="handleLaunch()">▶ Play</button>
    </div>
  </div>

  <!-- Audio Player Card -->
  <div class="player-card" id="playerCard">
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
      <button class="ctrl-btn play" id="playBtn" onclick="togglePlay()" title="Play / Pause (Space)">▶</button>
      <button class="ctrl-btn skip" onclick="skip(10)" title="Forward 10s (→)">+10</button>
      <button class="ctrl-btn skip" onclick="skip(30)" title="Forward 30s (Shift+→)">+30</button>
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
        <a class="action-btn" id="dlBtn" href="${escapeHtml(downloadUrl || audioUrl)}" target="_blank" ${downloadUrl || audioUrl ? '' : 'style="display:none;"'}>
          ⬇️ Download MP3
        </a>
      </div>
    </div>

    <div class="shortcuts-hint">
      Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> ±10s · <kbd>Shift+←/→</kbd> ±30s · <kbd>[</kbd>/<kbd>]</kbd> speed
    </div>

    <div class="shiur-desc" id="shiurDesc">${escapeHtml(description)}</div>
  </div>

  <!-- Featured Shiurim Section (Real Clickable Links) -->
  <div>
    <h2 class="section-title">🔥 Featured Shiurim</h2>
    <div class="shiur-cards-grid">
      ${FEATURED_SHIURIM.map(s => `
        <a href="/${s.id}" class="quick-card-link">
          <div class="quick-card-top">
            <img class="quick-card-avatar" src="${escapeHtml(s.speakerPhoto)}" alt="${escapeHtml(s.speaker)}" loading="lazy">
            <div class="quick-card-info">
              <div class="quick-card-title">${escapeHtml(s.title)}</div>
              <div class="quick-card-speaker">${escapeHtml(s.speaker)}</div>
            </div>
          </div>
          <div class="quick-card-bottom">
            <span>⏱ ${escapeHtml(s.duration)}</span>
            <span class="quick-play-badge">▶ Play</span>
          </div>
        </a>
      `).join('')}
    </div>
  </div>
</main>

<audio id="audioElement" src="${escapeHtml(audioUrl)}" preload="metadata"></audio>

<script>
  const audio = document.getElementById('audioElement');
  const initialTimestamp = ${JSON.stringify(timestamp)};
  const hasAudio = ${JSON.stringify(Boolean(audioUrl))};

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
      window.location.href = '/' + m[1];
    } else if (val.match(/\\.(mp3|m4a|wav)(\\?|$)/i)) {
      window.location.href = '/?audioUrl=' + encodeURIComponent(val);
    } else {
      window.location.href = '/' + encodeURIComponent(val);
    }
  }

  document.getElementById('shiurInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLaunch();
  });

  // Audio Controls
  function togglePlay() {
    if (!audio.src) return;
    if (audio.paused) {
      audio.play().catch(e => console.log('Play blocked:', e));
    } else {
      audio.pause();
    }
  }

  function skip(sec) {
    if (!audio.src) return;
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

  // If page loaded with audio, try to autoplay or wait for first touch
  if (hasAudio) {
    audio.play().catch(() => {
      // Browser blocked autoplay; waiting for user to click play button
      console.log('Autoplay deferred for user tap');
    });
  }
</script>

</body>
</html>
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
