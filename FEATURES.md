# YUTorah Enhanced Player — Feature Documentation

A standalone, zero-friction web portal and enhanced audio player for the [YUTorah Online](https://www.yutorah.org) library of 440,000+ Torah lectures.

**Live Application**: [https://yutorah-player.mrosensweig.workers.dev/](https://yutorah-player.mrosensweig.workers.dev/)  
**GitHub Repository**: [https://github.com/MosheRosensweig/yutorah_player](https://github.com/MosheRosensweig/yutorah_player)

---

## Table of Contents
1. [Zero-Friction Access & Standalone Web App](#1-zero-friction-access--standalone-web-app)
2. [Multi-Collection Hub & Daily Study](#2-multi-collection-hub--daily-study)
3. [Universal Live Search Engine](#3-universal-live-search-engine)
4. [Rich Metadata Filtering & Clickable Chips](#4-rich-metadata-filtering--clickable-chips)
5. [Persistent Floating Mini-Player (Uninterrupted Playback)](#5-persistent-floating-mini-player-uninterrupted-playback)
6. [Audio Player & Transport Controls](#6-audio-player--transport-controls)
7. [Automatic URL Timestamping & Session Recovery](#7-automatic-url-timestamping--session-recovery)
8. [Mobile Responsiveness, Dark Theme & Keyboard Shortcuts](#8-mobile-responsiveness-dark-theme--keyboard-shortcuts)
9. [Smart Recommendations](#9-smart-recommendations)
10. [Edge Infrastructure & Performance](#10-edge-infrastructure--performance)
11. [Product Roadmap](#11-product-roadmap)

---

## 1. Zero-Friction Access & Standalone Web App
- **No Installations Required**: Runs directly in any web browser on desktop, tablet, and mobile. No browser extensions, mobile apps, or local software needed.
- **Clean REST URLs**: Direct shareable routes for every shiur:
  - `https://yutorah-player.mrosensweig.workers.dev/<shiurId>` (e.g. `/1187082`).
- **Server-Side Rendered (SSR)**: Direct links immediately arrive with complete title, speaker name, duration, and metadata already in the HTML.
- **Rich Social Sharing**: Generates dynamic OpenGraph metadata so links shared via WhatsApp, iMessage, Slack, or email display the shiur title and rabbi portrait preview.

---

## 2. Multi-Collection Hub & Daily Study
- **Interactive Collection Tabs**: Switch instantly between the top YUTorah collections without reloading:
  - **⭐ Editor's Picks**: Hand-curated featured lectures.
  - **⏱️ Recently Uploaded**: Real-time stream of the newest shiurim uploaded to YUTorah.
  - **🔥 Most Popular / Trending**: The most listened-to and viewed lectures across the platform.
  - **📖 Daily Shiurim**: Curated daily learning series (Daf Yomi, Mishna Yomi, Halacha Yomi).
- **Daily Study & Calendar Banner**:
  - Displays today's **Parsha**, **Daf Yomi**, **Mishna Yomi**, **Nach Yomi**, and the current **Hebrew Date** (e.g. *20 Elul 5786*).
- **Responsive Shiur Cards**:
  - High-resolution speaker avatar photo (with graceful default fallback).
  - Multi-line shiur title and speaker name.
  - Category tags, recorded date, and formatted duration (`⏱ 46 min`, `⏱ 1h 12m`).
  - Prominent `▶ Play` badge with hover micro-animations.

---

## 3. Universal Live Search Engine
- **Search Across 440,000+ Shiurim**: Queries YUTorah's Apache Solr search cluster in real time.
- **Search-As-You-Type (Debounced 300ms)**:
  - As you type in the search bar (2+ characters), results update automatically after a 300ms pause—no need to even click Search.
  - Clearing the search input immediately restores the homepage collection tabs.
- **Explicit Search Button & Enter Key**:
  - Dedicated **Search** button and Enter-key listener with native form-action bypass to prevent accidental reloads on all devices.
- **Smart ID & URL Detection**:
  - Pasting a full YUTorah link (e.g. `https://www.yutorah.org/lectures/details?shiurID=1187082`) or entering a numeric ID immediately launches playback.
- **Quick-Filter Chips**:
  - One-click topic & speaker chips for instant browsing:
    `🏷️ Elul & Teshuvah` · `🏷️ Rosh Hashanah` · `👤 R' Schachter` · `👤 R' Rosensweig` · `👤 R' Twersky` · `👤 R' Lebowitz` · `👤 R' Neuburger` · `👤 R' Taragin` · `📜 Daf Yomi`.
- **"🔽 Load More Results" Pagination**:
  - Renders the first 30 matches with total match count (*"Showing 30 of 10,169 results for 'Schachter'"*).
  - Clicking **🔽 Load More Results** dynamically appends items 31–60, 61–90, etc., without page jumping.
  - Displays live progress count and shows *"All X shiurim loaded!"* upon reaching the end.
- **Shareable Search URLs**:
  - Searches update the browser URL (e.g. `/?search=Netzavim`) so search results can be bookmarked or shared directly.

---

## 4. Rich Metadata Filtering, Biographies & Clickable Chips
- **Comprehensive Metadata Display**:
  - Every shiur card and player view displays structured metadata directly extracted from YUTorah:
    - **👤 Speaker**: Primary speaker/magid shiur with speaker ID.
    - **📅 Date**: Formatted recording date (e.g. *Sep 01, 2026*).
    - **📍 Venue / Synagogue**: Location where the shiur was recorded (e.g. *Cong. KINS (Chicago, IL)*, *Yeshiva University*, *BMT*).
    - **📂 Grouped Topic Hierarchy**: Categories grouped by parent domain:
      - **Machshava**: `[Teshuva]`, `[Bitachon]`
      - **Nach**: `[Tehillim]`
      - **Parsha**: `[Nitzavim]`
      - **Halacha**: `[Shabbat]`, `[Kashrut]`
    - **🏷️ Keyword Tags**: Speaker-assigned topical tags (e.g. `[#לדוד]`, `[#אורי]`).
- **Collapsible Speaker Biographies & Venue Descriptions**:
  - When viewing or filtering by a speaker (e.g. *Rabbi Michael Rosensweig*) or venue (e.g. *Cong. KINS*), the full description/biography is displayed above the shiur list.
  - Starts in an unobtrusive collapsed preview with a **Read More ▼ / Show Less ▲** toggle.
- **Interactive Clickable Filter Chips**:
  - Clicking any chip immediately runs a filtered search for that speaker, venue, or subcategory.
  - **Zero Audio Interruption**: If a shiur is playing when you click a metadata chip, the audio continues playing seamlessly in the floating mini-player while the search results populate!
  - Fully integrated with the pagination engine: clicking "🔽 Load More Results" loads successive pages for that specific speaker, venue, or category filter.

---

## 5. Persistent Floating Mini-Player (Uninterrupted Playback)
- **Site-Wide Uninterrupted Listening**:
  - You can browse collections, perform searches, click metadata chips, or read other shiur details without audio pausing, resetting, or buffering.
- **Zero-Interruption Home Navigation (`goHome`)**:
  - Clicking the brand/home logo (`🎧 YUTorah Enhanced PLAYER`) navigates back to the homepage library without reloading the page—the current shiur automatically docks into the mini-player and keeps playing.
- **Automatic Docking & Minimizing**:
  - Clicking **"← Browse Library While Listening"** or the **"🗕 Minimize"** button collapses the full player card into a sleek, sticky bottom mini-player bar.
  - Searching or clicking any category/venue/speaker chip automatically docks the player so you can explore the results while listening.
- **Mini-Player Bar Controls**:
  - **Interactive Seekline**: Top mini progress bar showing playback progress with click-to-seek functionality.
  - **Speaker Thumbnail & Info**: Small avatar thumbnail, truncated title, and speaker name.
  - **Playback Time**: Live `14:20 / 46:19` counter.
  - **Triangular Skip Buttons (`-10` & `+10`)**: Dedicated directional SVG triangles pointing left and right with embedded bold numerical labels and generous padding to prevent accidental clicks.
  - **Play/Pause Toggle**: Center circular play/pause button using crisp SVG icons (white triangle when stopped, two clean white vertical bars when playing) with zero colored or orange emoji background on any device (Android, iOS, Samsung, Windows, macOS).
  - **"⤢ Expand" Button**: One-click restore that expands the full player card and smoothly scrolls it into view.
  - **"✕ Close" Button**: Stops playback and dismisses the mini-player.
  - Clicking anywhere on the mini-player (outside of buttons) smoothly expands the full player.

---

## 6. Audio Player & Transport Controls
- **Instant In-Page Playback (`playShiurById`)**:
  - Clicking `▶ Play` on any shiur card immediately expands the player and begins audio streaming in 0 milliseconds without a page reload.
- **Pure Vector Play / Pause Controls**:
  - Play button switches seamlessly between a white directional play triangle and two crisp rounded white pause bars (`||`).
  - Rendered entirely via inline SVG vectors instead of Unicode emojis, eliminating platform-specific emoji artifacts (such as Google and Samsung's default bright orange squircle background on `⏸️`).
- **Dedicated Skip Buttons**:
  - **-30s** and **-10s**: Jump backward by 30 or 10 seconds.
  - **+10s** and **+30s**: Jump forward by 10 or 30 seconds.
- **Variable Playback Speed Selector**:
  - Native speed menu with 9 speed presets: **0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 1.75x, 2.0x, 2.5x, 3.0x**.
- **High-Performance Snappy Scrubber Bar**:
  - Single streamlined primary seekbar with dynamic visual fill and enlarged hit zone (`::before` zone) for instant click and drag responses.
  - Zero lag: Updates visual percentage and live elapsed time counter at a full 60fps/120fps during touch and mouse dragging, setting the audio playback position cleanly upon release.
  - Prevents vertical page bouncing or scroll interference while dragging via active touch event cancellation (`passive: false`).
  - Removed redundant secondary native browser player bar to ensure a single, distraction-free progress slider.
- **Automatic Stream Failover**:
  - Automatically fails over between `shiurim.yutorah.net` (Cloudflare R2) and `download.yutorah.org` if any network interruption occurs.
- **Direct MP3 Download**:
  - Dedicated **⬇️ Download MP3** button linking directly to the full audio file for offline listening.
- **Lecture Description**:
  - Displays the speaker's written lecture summary and overview below the player controls.

---

## 7. Automatic URL Timestamping & Session Recovery
- **Real-Time URL Sync**:
  - As the shiur plays, the browser address bar dynamically updates with the current playback timestamp (e.g. `.../1187082?t=185` for 3m 05s).
  - **Throttled for Performance**: Uses `history.replaceState` throttled to at most once every 5 seconds. Has zero impact on browser performance and stays well below browser History API rate limits.
  - **Clean Browser History**: Uses `replaceState` so your browser's "Back" button is not cluttered with playback entries.
- **Immediate Event Sync**:
  - Forces an instant sync on **pause**, **scrubber seek**, **±10s/±30s skip**, **tab switch / minimize** (`visibilitychange`), and **window/tab close** (`beforeunload`, `pagehide`).
- **Seamless Session Recovery**:
  - If you close your browser or tab and reopen/restore it, the URL retains the exact `?t=...` parameter and immediately seeks to that exact position.
- **LocalStorage Secondary Backup**:
  - Automatically saves progress to `localStorage` under `yutorah_progress_<id>` so that even reopening `/<shiurId>` without `?t=` restores where you left off.
  - Automatically clears saved progress when the shiur reaches the end (`ended` event).
- **"📋 Copy Link @ Time"**:
  - Copies a timestamped link directly to the clipboard with animated confirmation badge (*"✅ Copied (14:20)!"*).

---

## 8. Mobile Responsiveness, Dark Theme & Keyboard Shortcuts
- **Dark Mode / Light Mode Switcher**:
  - Compact circular sun/moon emoji toggle (`🌙` / `☀️`) positioned directly to the left of the Hebrew date in the top navigation header.
  - Text-free emoji presentation with zero horizontal overflow on mobile screens.
  - Tailored high-contrast dark theme (`#0f141c` canvas, `#182232` cards, `#e7edf7` text, and accessible slate blue accents) with the top daily study box (Parsha, Daf Yomi, Mishna, Nach), collection tabs (Editor's Picks, Recently Uploaded, Most Popular, Daily Shiurim), and quick play badges fully adapted for dark mode.
  - Instant zero-flash rendering on load via `<head>` script that reads `localStorage.getItem('yutorah_theme')`.
  - Automatically syncs with system OS preferences (`prefers-color-scheme: dark`) when no manual override is set.
- **Mobile-Adaptive Keyboard Hints**:
  - On phones and touch screens (`@media (max-width: 768px), (pointer: coarse)`), the keyboard shortcut hints bar is automatically hidden to conserve precious vertical screen space.
- **Lock-Screen & Background Playback (`navigator.mediaSession`)**:
  - Full integration with system media controllers on iOS, Android, macOS, Windows, and smartwatches.
  - Displays lecture title, speaker name, "YUTorah Online" album title, and high-res rabbi portrait.
  - Lock-screen Play, Pause, Seek Forward, and Seek Backward controls are fully wired.
- **Desktop Keyboard Shortcuts**:
  - <kbd>Space</kbd>: Play / Pause
  - <kbd>←</kbd> / <kbd>→</kbd>: Skip backward / forward 10 seconds
  - <kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd>: Skip backward / forward 30 seconds
  - <kbd>[</kbd> / <kbd>]</kbd>: Decrease / increase playback speed
  - <kbd>M</kbd>: Mute / unmute audio

---

## 9. Smart Recommendations
- **🎙️ More from this Speaker**:
  - Automatically queries and renders up to 6 other lectures given by the same speaker.
- **📚 More in this Category**:
  - Automatically queries and renders up to 6 other lectures in the same topic or subcategory.

---

## 10. Edge Infrastructure & Performance
- **Cloudflare Workers Architecture**:
  - Runs on Cloudflare's global edge network across 300+ cities worldwide for sub-20ms latency.
- **In-Memory Edge Caching**:
  - Caches homepage collections for 5 minutes, ensuring ultra-fast initial page loads while respecting YUTorah's backend servers.
- **Zero CORS Obstacles**:
  - Proxies and standardizes API communication, returning `Access-Control-Allow-Origin: *`.
- **Bot Challenge Bypass**:
  - Communicates directly with unblocked REST microservices, completely avoiding Cloudflare Turnstile bot blocks.
- **100% Free & Scalable**:
  - Operates comfortably within Cloudflare's free allowance of 100,000 requests per day with no ongoing cost or credit card required.

---

## 11. Product Roadmap
- [x] Clickable metadata filter chips (Speaker, Venue, Categories, Keywords).
- [x] Persistent sticky bottom mini-player with uninterrupted playback across the site.
- [x] Collapsible speaker biographies and venue descriptions with Read More / Show Less.
- [x] Directional triangular -10 and +10 mini-player controls with touch spacing.
- [x] Dark Mode / Light Mode toggle with zero-flicker load and localStorage persistence.
- [x] Mobile-adaptive display (hiding keyboard shortcuts on touch devices).
- [ ] Multi-shiur playback queue ("Play Next" / Playlist mode).
- [ ] User favorites / bookmarking via browser localStorage.
- [ ] Offline caching via Service Worker (PWA installable app).
- [ ] Optional GitHub Pages static deployment fallback.
