/**
 * YUTorah Enhanced Player — Cloudflare Worker Reverse Proxy
 *
 * Proxies yutorah.org, strips frame/CORS restrictions, and injects
 * an enhanced audio player with tabs ([Enhanced Player] | [Standard Player]),
 * skip ±10s/±30s buttons, direct speed menu, timestamp links, and lock-screen controls.
 */

const TARGET_HOST = 'www.yutorah.org';
const TARGET_ORIGIN = `https://${TARGET_HOST}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerOrigin = url.origin;

    // Build the upstream URL
    const upstreamUrl = new URL(url.pathname + url.search, TARGET_ORIGIN);

    // Prepare headers for upstream
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Host', TARGET_HOST);
    newHeaders.set('Referer', TARGET_ORIGIN + '/');

    // Fetch from YUTorah
    let response;
    try {
      response = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'manual',
      });
    } catch (err) {
      return new Response(`Upstream fetch error: ${err.message}`, { status: 502 });
    }

    // Handle redirects: rewrite Location header so user stays on proxy
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        const respHeaders = new Headers(response.headers);
        const rewrittenLocation = location
          .replace(`https://${TARGET_HOST}`, workerOrigin)
          .replace(`http://${TARGET_HOST}`, workerOrigin)
          .replace('https://yutorah.org', workerOrigin)
          .replace('http://yutorah.org', workerOrigin);
        respHeaders.set('Location', rewrittenLocation);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
        });
      }
    }

    const contentType = response.headers.get('content-type') || '';

    // If not HTML, pass through
    if (!contentType.includes('text/html')) {
      return response;
    }

    // If it's a Cloudflare challenge, pass through untouched so Turnstile verification succeeds cleanly
    if (response.headers.get('cf-mitigated') === 'challenge' || response.status === 403 || response.status === 503) {
      const respHeaders = new Headers(response.headers);
      respHeaders.delete('x-frame-options');
      respHeaders.delete('content-security-policy');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    }

    // Prepare response headers for HTML
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('x-frame-options');
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // Rewrite HTML using HTMLRewriter
    const rewriter = new HTMLRewriter()
      // Rewrite internal links so user stays on our proxy
      .on('a[href]', {
        element(el) {
          const href = el.getAttribute('href');
          if (href && (href.startsWith(`https://${TARGET_HOST}`) || href.startsWith('https://yutorah.org'))) {
            el.setAttribute('href', href.replace(`https://${TARGET_HOST}`, workerOrigin).replace('https://yutorah.org', workerOrigin));
          }
        },
      })
      // Inject Enhanced Player Styles & Scripts into head/body
      .on('head', {
        element(el) {
          el.append(ENHANCED_PLAYER_CSS, { html: true });
        },
      })
      .on('body', {
        element(el) {
          el.append(ENHANCED_PLAYER_SCRIPT, { html: true });
        },
      });

    return new Response(rewriter.transform(response).body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};

// ============================================================
// INJECTED CSS
// ============================================================
const ENHANCED_PLAYER_CSS = `
<style id="yutorah-enhanced-styles">
  /* Enhanced Player Tab Container */
  .yt-enh-tab-bar {
    display: flex;
    gap: 4px;
    margin: 12px 0 8px;
    border-bottom: 2px solid #576a88;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .yt-enh-tab {
    padding: 8px 18px;
    background: #e8ecf2;
    color: #4a5d78;
    border: none;
    border-radius: 8px 8px 0 0;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .yt-enh-tab:hover {
    background: #d8e0ec;
    color: #2c3e50;
  }
  .yt-enh-tab.active {
    background: #576a88;
    color: #ffffff;
  }

  /* Enhanced Player Card */
  .yt-enh-card {
    background: #ffffff;
    border: 1px solid #dde1e7;
    border-radius: 0 0 10px 10px;
    padding: 18px 20px;
    box-shadow: 0 3px 12px rgba(0,0,0,0.06);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #2c3e50;
    margin-bottom: 16px;
  }

  /* Scrubber / Progress */
  .yt-enh-progress-wrap {
    margin-bottom: 14px;
  }
  .yt-enh-progress-bar {
    width: 100%;
    height: 8px;
    background: #e2e6ec;
    border-radius: 4px;
    cursor: pointer;
    position: relative;
    transition: height 0.15s ease;
  }
  .yt-enh-progress-bar:hover {
    height: 12px;
  }
  .yt-enh-progress-fill {
    height: 100%;
    background: #576a88;
    border-radius: 4px;
    width: 0%;
    position: relative;
  }
  .yt-enh-progress-fill::after {
    content: '';
    position: absolute;
    right: -6px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    background: #3d4f6a;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0,0,0,0.25);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .yt-enh-progress-bar:hover .yt-enh-progress-fill::after {
    opacity: 1;
  }
  .yt-enh-times {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: #6c7a89;
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }

  /* Controls Row */
  .yt-enh-transport {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-bottom: 14px;
  }
  .yt-enh-btn {
    border: 2px solid #dde1e7;
    background: #ffffff;
    color: #2c3e50;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    user-select: none;
  }
  .yt-enh-btn:hover {
    border-color: #576a88;
    color: #576a88;
    background: #f5f7fa;
  }
  .yt-enh-btn:active {
    transform: scale(0.95);
  }
  .yt-enh-btn.skip {
    width: 44px;
    height: 44px;
    font-size: 13px;
    font-weight: 700;
  }
  .yt-enh-btn.play {
    width: 58px;
    height: 58px;
    font-size: 24px;
    border-color: #576a88;
    color: #576a88;
  }
  .yt-enh-btn.play:hover {
    background: #576a88;
    color: #ffffff;
  }

  /* Secondary Row */
  .yt-enh-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    padding-top: 8px;
    border-top: 1px solid #edf0f5;
  }
  .yt-enh-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .yt-enh-label {
    font-size: 12px;
    font-weight: 700;
    color: #6c7a89;
    text-transform: uppercase;
  }
  .yt-enh-select {
    padding: 6px 10px;
    border: 2px solid #dde1e7;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    background: #ffffff;
    cursor: pointer;
    outline: none;
  }
  .yt-enh-select:hover, .yt-enh-select:focus {
    border-color: #576a88;
  }

  .yt-enh-action-btn {
    padding: 6px 12px;
    border: 2px solid #dde1e7;
    background: #ffffff;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    color: #2c3e50;
    cursor: pointer;
    transition: all 0.15s ease;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .yt-enh-action-btn:hover {
    border-color: #576a88;
    color: #576a88;
    background: #f5f7fa;
  }
  .yt-enh-action-btn.copied {
    border-color: #27ae60;
    color: #27ae60;
  }

  /* Shortcuts Helper */
  .yt-enh-shortcuts-hint {
    font-size: 12px;
    color: #8a96a3;
    text-align: center;
    margin-top: 8px;
  }
  kbd {
    background: #f0f2f5;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 11px;
    font-family: inherit;
  }

  /* Sidebar Enhanced Mini-Buttons */
  .yt-sidebar-enh-btns {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-top: 6px;
  }
  .yt-sidebar-skip {
    background: #576a88;
    color: #ffffff;
    border: none;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
  }
  .yt-sidebar-skip:hover {
    background: #3d4f6a;
  }
</style>
`;

// ============================================================
// INJECTED CLIENT SCRIPT
// ============================================================
const ENHANCED_PLAYER_SCRIPT = `
<script id="yutorah-enhanced-script">
(function () {
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let activeAudio = null;

  // Find the active audio element
  function getAudio() {
    if (activeAudio && document.body.contains(activeAudio)) return activeAudio;
    const audios = document.querySelectorAll('audio');
    if (audios.length > 0) {
      activeAudio = audios[0];
      return activeAudio;
    }
    return null;
  }

  // Format seconds -> M:SS or H:MM:SS
  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (h > 0) {
      return h + ':' + m.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
    }
    return m + ':' + seconds.toString().padStart(2, '0');
  }

  // Mount Enhanced Player on Lecture Pages
  function mountLecturePlayer() {
    const playerSection = document.querySelector('.lecture-player-section') || document.querySelector('.lecture-audio');
    if (!playerSection || document.getElementById('ytEnhTabBar')) return;

    const standardPlayer = document.getElementById('jp_container_lecture') || playerSection.querySelector('.jp-audio');

    // Create Tab Bar
    const tabBar = document.createElement('div');
    tabBar.id = 'ytEnhTabBar';
    tabBar.className = 'yt-enh-tab-bar';
    tabBar.innerHTML = \`
      <button class="yt-enh-tab active" id="ytTabEnh">🎧 Enhanced Player</button>
      <button class="yt-enh-tab" id="ytTabStd">📻 Standard Player</button>
    \`;

    // Create Enhanced Card
    const card = document.createElement('div');
    card.id = 'ytEnhCard';
    card.className = 'yt-enh-card';
    card.innerHTML = \`
      <!-- Progress -->
      <div class="yt-enh-progress-wrap">
        <div class="yt-enh-progress-bar" id="ytProgressBar">
          <div class="yt-enh-progress-fill" id="ytProgressFill"></div>
        </div>
        <div class="yt-enh-times">
          <span id="ytCurTime">0:00</span>
          <span id="ytTotalTime">0:00</span>
        </div>
      </div>

      <!-- Transport -->
      <div class="yt-enh-transport">
        <button class="yt-enh-btn skip" id="ytSkipBack30" title="Back 30s (Shift+←)">-30</button>
        <button class="yt-enh-btn skip" id="ytSkipBack10" title="Back 10s (←)">-10</button>
        <button class="yt-enh-btn play" id="ytPlayBtn" title="Play/Pause (Space)">▶</button>
        <button class="yt-enh-btn skip" id="ytSkipFwd10" title="Forward 10s (→)">+10</button>
        <button class="yt-enh-btn skip" id="ytSkipFwd30" title="Forward 30s (Shift+→)">+30</button>
      </div>

      <!-- Controls Row -->
      <div class="yt-enh-row">
        <div class="yt-enh-group">
          <span class="yt-enh-label">Speed</span>
          <select class="yt-enh-select" id="ytSpeedSelect">
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

        <div class="yt-enh-group">
          <button class="yt-enh-action-btn" id="ytCopyLinkBtn" title="Copy link starting at current time">
            📋 Copy Link @ Time
          </button>
          <a class="yt-enh-action-btn" id="ytDownloadBtn" href="#" target="_blank" style="display:none;">
            ⬇️ Download MP3
          </a>
        </div>
      </div>

      <div class="yt-enh-shortcuts-hint">
        Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> ±10s · <kbd>Shift+←/→</kbd> ±30s · <kbd>[</kbd>/<kbd>]</kbd> speed
      </div>
    \`;

    // Insert Tab Bar and Card before player
    playerSection.insertBefore(tabBar, playerSection.firstChild);
    playerSection.insertBefore(card, tabBar.nextSibling);

    // Default to Enhanced view: hide standard
    if (standardPlayer) standardPlayer.style.display = 'none';

    // Tab Switching
    document.getElementById('ytTabEnh').onclick = () => {
      document.getElementById('ytTabEnh').classList.add('active');
      document.getElementById('ytTabStd').classList.remove('active');
      card.style.display = 'block';
      if (standardPlayer) standardPlayer.style.display = 'none';
    };

    document.getElementById('ytTabStd').onclick = () => {
      document.getElementById('ytTabStd').classList.add('active');
      document.getElementById('ytTabEnh').classList.remove('active');
      card.style.display = 'none';
      if (standardPlayer) standardPlayer.style.display = 'block';
    };

    // Wire Up Controls
    function skip(sec) {
      const a = getAudio();
      if (!a) return;
      a.currentTime = Math.max(0, Math.min(a.duration || Infinity, a.currentTime + sec));
    }

    function togglePlay() {
      const a = getAudio();
      if (!a) {
        // Trigger standard jPlayer play if audio element not yet instantiated
        const stdPlay = document.querySelector('.jp-play');
        if (stdPlay) stdPlay.click();
        return;
      }
      if (a.paused) a.play();
      else a.pause();
    }

    document.getElementById('ytPlayBtn').onclick = togglePlay;
    document.getElementById('ytSkipBack30').onclick = () => skip(-30);
    document.getElementById('ytSkipBack10').onclick = () => skip(-10);
    document.getElementById('ytSkipFwd10').onclick = () => skip(10);
    document.getElementById('ytSkipFwd30').onclick = () => skip(30);

    document.getElementById('ytSpeedSelect').onchange = (e) => {
      const a = getAudio();
      if (a) a.playbackRate = parseFloat(e.target.value);
    };

    // Scrubber click
    document.getElementById('ytProgressBar').onclick = (e) => {
      const a = getAudio();
      if (!a || !a.duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      a.currentTime = pct * a.duration;
    };

    // Copy link at timestamp
    document.getElementById('ytCopyLinkBtn').onclick = () => {
      const a = getAudio();
      const currentSec = Math.floor(a ? a.currentTime : 0);
      const url = new URL(window.location.href);
      url.searchParams.set('t', currentSec);
      navigator.clipboard.writeText(url.toString()).then(() => {
        const btn = document.getElementById('ytCopyLinkBtn');
        btn.textContent = '✅ Copied (' + formatTime(currentSec) + ')!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '📋 Copy Link @ Time';
          btn.classList.remove('copied');
        }, 2200);
      });
    };

    // Setup Download Link if available
    if (typeof lecturePlayerData !== 'undefined' && lecturePlayerData) {
      const dlUrl = lecturePlayerData.downloadURL || lecturePlayerData.playerDownloadURL;
      if (dlUrl) {
        const dl = document.getElementById('ytDownloadBtn');
        dl.href = dlUrl;
        dl.style.display = 'inline-flex';
      }
    }

    // Bind Audio Events
    function bindAudioEvents(a) {
      if (a.dataset.ytEnhBound) return;
      a.dataset.ytEnhBound = 'true';

      a.addEventListener('play', () => {
        document.getElementById('ytPlayBtn').textContent = '⏸';
      });
      a.addEventListener('pause', () => {
        document.getElementById('ytPlayBtn').textContent = '▶';
      });
      a.addEventListener('timeupdate', () => {
        if (!a.duration) return;
        const pct = (a.currentTime / a.duration) * 100;
        document.getElementById('ytProgressFill').style.width = pct + '%';
        document.getElementById('ytCurTime').textContent = formatTime(a.currentTime);
      });
      a.addEventListener('loadedmetadata', () => {
        document.getElementById('ytTotalTime').textContent = formatTime(a.duration);
        handleInitialTimestamp(a);
      });
      a.addEventListener('durationchange', () => {
        document.getElementById('ytTotalTime').textContent = formatTime(a.duration);
      });

      // Mobile Lock-Screen mediaSession
      if ('mediaSession' in navigator && typeof lecturePlayerData !== 'undefined' && lecturePlayerData) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: lecturePlayerData.shiurTitle || document.title,
          artist: lecturePlayerData.shiurTeacherFullName || 'YUTorah',
          album: 'YUTorah Online',
        });
        try {
          navigator.mediaSession.setActionHandler('play', () => a.play());
          navigator.mediaSession.setActionHandler('pause', () => a.pause());
          navigator.mediaSession.setActionHandler('seekbackward', (details) => skip(-(details.seekOffset || 10)));
          navigator.mediaSession.setActionHandler('seekforward', (details) => skip(details.seekOffset || 10));
        } catch (err) {}
      }

      handleInitialTimestamp(a);
    }

    // Auto-seek if ?t=... in URL
    function handleInitialTimestamp(a) {
      const params = new URLSearchParams(window.location.search);
      const t = params.get('t');
      if (t) {
        const sec = parseFloat(t);
        if (!isNaN(sec) && sec > 0) {
          a.currentTime = sec;
        }
      }
    }

    // Monitor for audio element insertion (jPlayer instantiates asynchronously)
    const checkInterval = setInterval(() => {
      const a = getAudio();
      if (a) {
        bindAudioEvents(a);
        clearInterval(checkInterval);
      }
    }, 300);
  }

  // Enhance Sidebar Player (on Homepage & Browse pages)
  function enhanceSidebarPlayer() {
    const sb = document.getElementById('jp_container_sidebar');
    if (!sb || sb.dataset.ytEnhBound) return;
    sb.dataset.ytEnhBound = 'true';

    // Insert skip buttons into sidebar interface
    const controls = sb.querySelector('.jp-controls');
    if (controls) {
      const wrap = document.createElement('div');
      wrap.className = 'yt-sidebar-enh-btns';
      wrap.innerHTML = \`
        <button class="yt-sidebar-skip" id="ytSbSkipBack" title="Back 10s">-10s</button>
        <button class="yt-sidebar-skip" id="ytSbSkipFwd" title="Forward 10s">+10s</button>
      \`;
      controls.parentNode.insertBefore(wrap, controls.nextSibling);

      wrap.querySelector('#ytSbSkipBack').onclick = (e) => {
        e.preventDefault();
        const a = getAudio();
        if (a) a.currentTime = Math.max(0, a.currentTime - 10);
      };
      wrap.querySelector('#ytSbSkipFwd').onclick = (e) => {
        e.preventDefault();
        const a = getAudio();
        if (a) a.currentTime = Math.min(a.duration || Infinity, a.currentTime + 10);
      };
    }
  }

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const a = getAudio();
    if (!a) return;

    if (e.key === ' ') {
      e.preventDefault();
      if (a.paused) a.play(); else a.pause();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      a.currentTime = Math.max(0, a.currentTime - (e.shiftKey ? 30 : 10));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      a.currentTime = Math.min(a.duration || Infinity, a.currentTime + (e.shiftKey ? 30 : 10));
    } else if (e.key === '[') {
      const idx = SPEEDS.indexOf(a.playbackRate);
      if (idx > 0) {
        a.playbackRate = SPEEDS[idx - 1];
        const sel = document.getElementById('ytSpeedSelect');
        if (sel) sel.value = a.playbackRate;
      }
    } else if (e.key === ']') {
      const idx = SPEEDS.indexOf(a.playbackRate);
      if (idx < SPEEDS.length - 1 && idx !== -1) {
        a.playbackRate = SPEEDS[idx + 1];
        const sel = document.getElementById('ytSpeedSelect');
        if (sel) sel.value = a.playbackRate;
      }
    } else if (e.key === 'm' || e.key === 'M') {
      a.muted = !a.muted;
    }
  });

  // Run on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mountLecturePlayer();
      enhanceSidebarPlayer();
    });
  } else {
    mountLecturePlayer();
    enhanceSidebarPlayer();
  }
})();
</script>
`;
