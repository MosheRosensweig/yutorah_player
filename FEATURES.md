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
12. [Recent Features — Search, Discovery & Dev Mode](#12-recent-features--search-discovery--dev-mode)
13. [Recent Features — Header, Sync, Playlists & PWA (Sept 2026)](#13-recent-features--header-sync-playlists--pwa-sept-2026)
14. [Public Playlist Publishing, Live-Sync, Deletion & Privacy Lifecycle](#14-public-playlist-publishing-live-sync-deletion--privacy-lifecycle)

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
- **Card Play Badge 3 States (`updateCardPlayBadges`)**:
  - Default: blue `▶ Play` (history cards keep their `▶ Resume` label).
  - The card whose shiur is loaded in the player turns green: `▶ Playing` while audio runs (including while the new track loads), `‖ Paused` while paused. Article `📄 Read` badges are never touched.
  - States refresh on track switch, play/pause/ended, and player close (original label restored verbatim).
- **Mini-Player Pops Immediately**: card-badge play sets track state before minimizing (previously `minimizePlayer()` early-returned on the still-false `hasAudio` and the bar only appeared on the next scroll). The mini-player now shows `.visible` on the same tap.
- **Pure Vector Play / Pause Controls**:
  - Play button switches seamlessly between a white directional play triangle and two crisp rounded white pause bars (`||`).
  - Rendered entirely via inline SVG vectors instead of Unicode emojis, eliminating platform-specific emoji artifacts (such as Google and Samsung's default bright orange squircle background on `⏸️`).
- **Dedicated Skip Buttons**:
  - **-30s** and **-10s**: Jump backward by 30 or 10 seconds.
  - **+10s** and **+30s**: Jump forward by 10 or 30 seconds.
  - **Skip flash feedback**: every skip (main ±10/±30, mini-player ±10, keyboard ←/→/Shift+←/→) pops a brief centered `+10`/`−10`-style flash (`#skipFlash`, 650ms, own timer) confirming the press visually — no need to judge by ear.
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
  - Dedicated **⬇️ Download** button linking directly to the full audio file for offline listening.
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
  - Compact sun/moon emoji toggle (`🌙` / `☀️`) in the header's left button flow (after the holiday badge); shown only when space allows, otherwise one tap away in the login menu. See §13 for the full priority rules.
  - Text-free emoji presentation with zero horizontal overflow on mobile screens.
  - Tailored high-contrast dark theme (`#0f141c` canvas, `#182232` cards, `#e7edf7` text, and accessible slate blue accents) with the top daily study box (Parsha, Daf Yomi, Mishna, Nach), collection tabs (Editor's Picks, Recently Uploaded, Most Popular, Daily Shiurim), and quick play badges fully adapted for dark mode.
  - Instant zero-flash rendering on load via `<head>` script that reads `localStorage.getItem('yutorah_theme')`.
  - New users default to dark mode; an explicit saved choice (or `?theme=`/`?mode=` URL param) always wins. The OS-preference listener still applies only until the user picks explicitly.
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
- [x] Dark Mode / Light Mode toggle with zero-flicker load, URL parameter (`?mode=dark`), and localStorage persistence.
- [x] Mobile-adaptive display (hiding keyboard shortcuts on touch devices).
- [x] Playback speed URL parameter sync (`?speed=1.5`).
- [x] Live daily YUTorah sponsorship banner sync & GiveCampus support link.
- [x] Official pre-roll daily sponsorship audio clip with live countdown, skip button, and auto-sync.
- [x] **User Accounts & Persistent Login** *(Shipped Sept 2026 — Google OAuth PKCE, see [docs/AUTH_SETUP.md](docs/AUTH_SETUP.md))*:
  - Stay logged in via long-lived sessions (sliding refresh).
  - Synchronized listening history of all shiurim played (tombstone deletes stick).
  - Accurate progress tracking ("where you are up to in each shiur") with completion.
  - Organized chronologically; History sorts by Last Listened or Shiur Date.
- [x] Multi-shiur playback queue (queue singles/series, drag reorder, autoplay-next, Queue-to-Top).
- [x] Offline-tolerant PWA (installable manifest + Service Worker shell/offline fallback; audio/API bypass cache).
- [ ] Optional GitHub Pages static deployment fallback.

---

## 12. Recent Features — Search, Discovery & Dev Mode

> Shipped on the `feat/discovery-wave` line (dev link). Items marked **(dev-only)** require Dev Mode: type `dev mode` in the search box to unlock, `exit dev mode` to leave.

### Search results
- **🕒 Recent Results rail**: every search opens with the 3 freshest matches (global date query, all filters honored), followed by the full 30-result relevance list with its own Load More.
- **Quick date chips** (every search): All Dates / Today / Yesterday / This Week / This Month. Mutually exclusive with year/custom-range; persist in the URL; survive reload.
- **Sort chips**: Relevance (default) / Newest / Oldest. Chronological sorts render in true server order with no relevance re-ranking; the Recent rail hides under chrono sorts; Load-More paginates by item offset.
- **Advanced custom date-time range**: from/to `datetime-local` inputs in the Filters modal (minute precision server-side), with pill + reset/populate round-trip.
- **No speaker auto-narrowing**: `rosensweig` and `rosensweig shabbos` match every Rosensweig via text search. Narrowing happens only through explicit filter chips, suggestion clicks, or speaker pages.
- **Did-you-mean strip (on top)**: under-10-hit result sets and zero-literal typos show `🔍 Did you mean …?` above the results; clicking a chip runs the corrected search. Garbage input yields no suggestions.
- **"Showing results for…" disclaimer**: appears only when the query was rewritten, echoing both strings.
- **Reverse-transliteration row**: single clean row — circled `i` button toggles the explanation, On/Off switch beside the name (no more wall of text).
- **Acronym + Hebrew alias search**: `yije` expands to "Young Israel of Jamaica Estates" (+ variants); `rosensweig` ↔ `רוזנצווייג` match bidirectionally.

### Discovery
- **Hero slideshow**: rotating spotlight slides from the live catalog feed (6s autoplay, dots/arrows/swipe, pause on hover/focus, `prefers-reduced-motion` respected, hidden slides inert). Caption overlays the image's blank right half like yutorah.org; stacks below on mobile with centered image + programmatic left fade.
- **Cards/Rows view**: 🃏/📋 toggle on search + collections. Desktop defaults to rows (one full-width row per shiur); mobile is cards-only. Persisted, no reload flash.
- **Series buttons**: `View 15 more in 'Series Name' Series` (collapse returns to a compact Minimize control).
- **Sponsorship banner**: dedication text (from `l'ilui nishmas` onward) bolded like yutorah.org, entities decoded, both themes.
- **Speaker pages**: teacher-filtered view renders 🆕 Most Recent 6 (newest first), 🏆 Top Lectures 10 (by views + downloads), then 📚 All Shiurim; frozen across Load-More.
- **Player metadata**: given date plus a separate `📤 Uploaded …` row (between Date and Venue/Topics) whenever the upload date differs; hydrates on direct-link loads too. Topic chips search.

### Cards & playback
- **Play badge vs card**: only the ▶/Resume badge mini-plays in place; clicking anywhere else opens the full player. Tapping play on the already-playing shiur resumes/minimizes instead of restarting.
- **Change Log** (dev-only): ⚙️ → Change Log lists every shipped change newest-first (backed by `src/changelog.json`, updated on every push).

### Dev Mode playlists, queue & history
- **🎧 Dev's Playlists tab** (second position): History, Save-for-Later, Favorites, custom playlists (create via modal, delete via custom confirm, export JSON, Play All).
- **Card buttons**: 🕒 Later / ☆ Fav icon buttons (pick from 5 clocks in ⚙️ settings: emoji + 4 bolder-hand SVGs), Spotify-style circular queue button (single or whole-series from covers), ➕ Playlist modal with filter/create/checkboxes. Silent toggles (recolor only), progress bars + last-listened meta fundamental on every card.
- **Player header**: Later / Fav / Queue / Playlist actions synced per track.
- **Play queue**: card/cover/player queueing (series expand on play), mini-player ☰ popup + playlists-tab view, drag handles + ▲▼ + remove, Clear with confirm, autoplay-next with toast, `Escape` closes all dialogs.
- **History**: sort by 🕒 Last Listened vs 📅 Shiur Date; per-track progress/heartbeat/completion tracking in `localStorage`.
- **Isolation**: all dev UI hidden + inert without Dev Mode (CSS kill-switch, `aria-hidden`, JS guards); `exit dev mode` fully reverses unlock including settings gear.


---

## 13. Recent Features — Header, Sync, Playlists & PWA (Sept 2026)

> Shipped to production September 2026 (`feat/auth-d1` line, dual-reviewed). Live on both [production](https://yutorah-player.mrosensweig.workers.dev/) and [dev](https://yutorah-player-dev.mrosensweig.workers.dev/).

### Header: single left-to-right button flow (no gaps)
- **One packed row, left to right**: home (`🎧 YUTorah Enhanced PLAYER`) → login/settings (`👤 Sign in` / gear) → holiday/zman badge (e.g. Rosh Hashanah 🍎) → light/dark toggle (`🌙`/`☀️`) → `❤️ Support YUTorah` → Hebrew date badge (`📅`). Every icon starts immediately right of the last one — no awkward gap between groups.
- **Login button guaranteed**: it sits directly after the brand in a non-shrinking cluster and the overflow logic forces it visible on every check, so it can never be pushed out of view. On ultra-narrow screens the brand text truncates with an ellipsis instead.
- **Space-based priority (measured, no screen-size breakpoints)**: sacrifices happen lowest-priority-first — date badge, then support, then theme (core chrome outranks the donate CTA), then the zman badge shrinks to apple-only, then hides — with brand ellipsis as the absolute last resort. A refill pass re-shows anything that fits in freed space (e.g. the theme toggle reappears once the zman collapses to an apple), so mobile screens stay filled with every icon that fits.
- **Theme toggle only when room allows**: on tight screens it hides (one tap away in the login menu under Light/Dark Mode, for guests and logged-in users alike) and reappears automatically when widened.
- **Zman apple popover**: tapping the apple-only badge pops the full holiday title for ~4 seconds (auto re-shrink), dismissible via outside-click or `Escape`, with `aria-expanded` state. The wide version is never force-shrunk when it fits.
- **Full-width taps never shrink**: the popover CSS is scoped to apple-only mode and the expand toggle no-ops on the wide badge, so tapping a full holiday title does nothing (previously it yanked the title into a floating popover, visually collapsing the badge).
- **7-tap dev-mode toggle**: tapping the Hebrew date badge (or the calendar row in the login menu) 7 times toggles Dev Mode on/off symmetrically (2s idle reset; same toasts as typed flow). Typing `dev mode` / `exit dev mode` still works. The 10-tap pre-roll toggle stays exclusive to the holiday apple (its title now reads "Tap 10 times"), so the two gestures share no counter and never collide.
- **📲 Install App menu item**: the login/settings dropdown offers Install App only when the app is known-not-installed (hidden in `standalone` display mode and iOS standalone). Uses the deferred browser install prompt when available, else an iOS-aware manual hint (Share → Add to Home Screen); the option disappears after `appinstalled`.
- **Calendar icon/text buffer**: the header date badge uses a 6px flex gap between 📅 and the date text (matching the dropdown calendar row feel).
- **Keyboard access**: date badge is `tabindex`/`role=button` with Enter/Space activation, matching the zman badge; DOM order equals visual order for a logical tab sequence.

### History deletes that stick (tombstone sync)
- **Removes survive reload/pull**: deleting from History (or any playlist) is permanent. Deletes travel to the cloud as explicit bounded tombstones (`deletedHistory`, max 200) rather than full-list replace — important because local history is an LRU window, so a replace would wipe older rows the device never saw.
- **Delete lifecycle**: remove records the tombstone + clears the stale progress record + marks history dirty; re-listening revives the item (clears its tombstone); the tombstone clears only after the server acknowledges it (retained across failures for retry).
- **Unload flush + boot retry**: pending syncs flush via `keepalive` POST on tab close/reload (covers the 2.5s debounce window); any leftover tombstones re-dirty on next boot and push within seconds.
- **Why it was needed**: previously deletes touched only local storage while the server kept the rows, so every reload re-merged ("resurrected") them via union sync.

### Playlists: queue-to-top, previews & sharing
- **⏫ Queue to Top**: every playlist row (subscriptions, custom, system lists) has a Queue-to-Top button that prepends the whole playlist — in order, skipping already-queued items — to the top of the play queue. Series bundles are preserved as expandable queue entries; counts lectures added.
- **Preview items with duration + upload date**: expanding a public playlist preview shows each shiur's duration and upload date; the preview endpoint was fixed (SQL columns) with instant client-side caching.
- **Shareable playlist URLs**: the active playlist, public-search query, Teacher/Venue/Topic pills, scope checkboxes, and sort all live in namespaced URL params (`tab/pl/plq/plteachers/…`), so reload keeps your place and links share exact state. Player open/close carries the context; shiur search uses one-view-per-URL.
- **Public search scope that only adds**: the "Shiurim inside the playlists" checkbox matches lecture titles/speakers/series contents (including series bundles via `items_json`) and can only ever widen results, never zero them (fixed a missing-column query + fallback).
- **ℹ️ Shiurim-therein explainer**: an info button beside the scope checkbox opens the standard tooltip (`togglePlInfoTip`, edge-flip positioning, `role="tooltip"`, outside-click/`Escape`/resize dismiss) explaining that the scope matches lectures inside playlists and only widens results. Tapping it never flips the checkbox.
- **Playlists tab + display-name banner**: the collection tab is labeled `🎧 Playlists` with a `👤 Playlist Display Name:` banner linking to the rename modal.

### PWA: installable app, authentic icons
- **Installable PWA**: Web App Manifest (`/manifest.json`, standalone display, `any` + `maskable` icons) and Service Worker (`/sw.js`, network-first app shell with offline fallback; audio byte-ranges and `/api/*` always bypass cache). No install banners, no layout shifts.
- **Centered authentic shield**: YU shield icons optically centered in the circular mask with safe-zone margins (no zoom/clipping on Android, no Chrome shortcut badge), white lettering and scroll colors restored.

### Small fixes in the same batch
- **No double calendar emoji**: the account-menu date stripped the header badge's leading 📅 before adding its own (both auth states, incl. variant-selector form).
- **Settings/login menu date**: single 📅 prefix; menu calendar entry uses uniform item padding with icon containers.

### 📜 Daf Yomi Hub (/daf)
- **Tractate/folio selector + calendar nav**: 36 masechtot with daf counts, folio input with per-tractate bounds, prev/today/next day stepping plus a date picker. Calendar dates resolve through exact client-side cycle math (2,711 dafim, no Shekalim, anchor 2019-12-28 = Berachos 2 — verified against Sefaria and dafyomi.org live); manual folio jumps forward to the next occurrence. State lives in shareable `?m=&d=&date=` params.
- **OG-style daf viewer**: single tap zooms to 2.4x anchored exactly where the finger pressed, finger-drag pans while zoomed, pinch zooms 1–4x around its center, plus −/+/reset buttons, live % label, and double-click support on desktop. Same anchor math as the article canvas viewer, standalone state.
- **Daf content**: bilingual Gemara text from Sefaria (CORS-open API; Hebrew default with English toggle, numbered segments, `heRef` header), loading/error/retry states. Text mode is vertically scrollable instead of clipping at the bottom.
- **Daf scan view**: the separate **Daf PDF** tab now displays YUTorah’s verified raster GIF scans from `cdnyutorah.cachefly.net` through a same-origin `/api/daf-image` passthrough. It validates `image/gif`, stores nothing, and avoids Android’s PDF handoff. The view supports עמוד ב, עמוד א, or both amudim; the same selector is also available above the text-language controls in the Daf text tab, while Daf text remains isolated from scan tap-to-zoom gestures.
- **Aligned bilingual text**: the `עברית + English` mode normalizes Sefaria’s segment arrays and renders every indexed segment as a numbered pair — labeled Hebrew Gemara immediately followed by its matching English phrase — then continues to the next pair (for example, all 22 pairs on a 22-segment daf).
- **Daf text default**: the text tab opens in `עברית + English` mode by default. The amud selector has its own section above the separate zoom/language controls and remains available in both Daf tabs.
- **Homepage integration**: selecting the Daf Yomi card from the Timely Study menu opens `/daf`, keeping the hub within the regular YUTorah Enhanced site navigation.
- **Shiurim on this daf**: the 🎧 Shiurim button sits directly under **Today’s Daf** and opens a `?search=Masechta+Daf` results tab for related lectures. Entry via the 📖 Daf Hub quick chip; `themeMode` SSR + client toggle included; breakout-safe param embedding (`jsEmbed`).
- **Daf-linked audio flow (dev)**: Daf is an in-app view inside the regular application shell, not a second HTML document. Daf search links stay in the same view and use the existing regular application's audio player and mini-player. Identifiable Daf shiurim expose an **📜 Open Daf** action in both the full and minimized regular players; that action swaps the view without creating a second audio element or Daf-specific mini-player. Detection uses explicit tractate/folio fields plus patterns in lecture title, description, series, keywords, and posted categories.
- **Main player Daf action (dev)**: The main player action row shows a **📜 Daf** button only when the loaded playable shiur resolves to a tractate and folio (or is opened through a valid Daf handoff). YUTorah video-backed items are treated as playable media in this app and are eligible too; only true text/article/PDF items are excluded. The action stays hidden by default for ordinary shiurim, clears synchronously before each in-app track switch, deterministically parses tractate titles with or without the word “Daf” and normalizes `Baba Batra`/`Bava Batra` to canonical `Bava Basra`, recomputes independently on the new track, and opens the shared Daf view without interrupting playback.
- **ℹ️ Shiurim-therein explainer** (companion, public playlists): info button beside the scope checkbox using the standard tooltip system; copy states the scope only widens results.

### 📄 Source Sheet button on audio shiurim
- **Attached handouts, one tap away**: audio lectures with attached source sheets, packets, or marei-mekomos handouts (`shiurAdditionalMaterials`: title, type, `viewerURL`/`materialURL`, existence-checked) show a **📄 Source Sheet** action button in the player controls (with a `(N)` count when several are attached).
- **Liquid Mode viewer without interrupting audio**: opening a sheet loads it through the existing Liquid Mode / Original Page pipeline (same PDF proxy, same toolbar, fullscreen, zoom) but explicitly skips the audio takeover — controls stay visible, playback never pauses or resets. A dedicated **✕ Close** toolbar button dismisses the sheet (never hiding a real article track).
- **Multi-sheet chooser**: when several handouts are attached, a dialog lists them with type labels (focus moves in, returns on close); `Escape`/outside-click dismisses. Opening a new track resets sheet state; direct-link loads hydrate the button too.
- **Trust boundary**: sheet PDFs flow through `/api/pdf-proxy`, whose host allowlist now includes the materials CDN (`cdn.yutorah.net`).

---

## 14. Public Playlist Publishing, Live-Sync, Deletion & Privacy Lifecycle

> Shipped September 2026 (`feat/auth-d1`). Governs public discovery, owner rights, privacy state changes, deletion cascading, and real-time synchronization.

### Strict Lifecycle Rules & Guarantees
1. **Private Owners Retain Full Sovereignty**:
   - The private owner can modify, rename, add, reorder, or delete any playlist at any time.
   - Public listings are strictly a projection of the owner's playlist. If an owner deletes a playlist in their personal collection, its public counterpart is immediately and irrevocably deleted from the Cloudflare D1 public registry (`public_playlists`, `public_playlist_items`, and `playlist_saves`). No orphaned public listings can remain.

2. **Immediate Visibility & Privacy Toggling**:
   - **Publishing (`🌍 Publish`)**: Snapshots the playlist, generates or links its `publicId`, tags it as public (`isPublic = true`), marks it with a `🌍 Public` badge on cards and pills, and makes it discoverable in public search immediately.
   - **Unpublishing (`Unpublish`)**: Instantly removes the listing from the public database and public search, revokes public access, purges memory caches (`plPreviewCache`), and flips the owner's personal status tag back to `🔒 Private`. The owner's local copy remains untouched in their collection.
   - **Visual Badging in "My Playlists"**:
     - Custom playlist pills in the "My Playlists & Subscriptions" row display an unmistakable `🌍` indicator when public.
     - The playlist detail view displays a distinct `🌍 Public` or `🔒 Private` active pill tag, together with a single-click action to toggle between `🌍 Publish` and `Unpublish`.

3. **Real-Time Content Synchronization (`plSyncIfPublic`)**:
   - When a playlist is public, any modification made by the owner—whether adding a shiur via the card menu (`devSetMembership`), removing a shiur (`devDoRemove`), reordering via drag-and-drop or ▲/▼ controls (`devReorderPlaylistItem`), or editing title, description, and taxonomy tags (`openPlaylistDetailsModal`)—automatically triggers a background snapshot push to `/api/playlists/publish`.
   - In-memory preview caches (`plPreviewCache`) are invalidated immediately so that public browsers and search results show the fresh content on their next query.
   - **Zero-Item Snapshot Support**: If an owner removes all shiurim from a published playlist, the backend allows the update (clearing `public_playlist_items` and setting `itemCount = 0`), accurately reflecting the empty playlist rather than rejecting the update or leaving old shiurim stuck in the public index.

4. **Zero-Staleness Search Indexing**:
   - Public search (`/api/playlists/public`) returns `Cache-Control: no-cache, no-store, must-revalidate`.
   - When an owner publishes, unpublishes, or modifies a playlist, search queries immediately return the up-to-date state without 60-second edge-cache delays.

5. **Cloud Sync Merge State Integrity**:
   - `adoptCloudState()` spreads and preserves local metadata (`publicId`, `isPublic`, `tags`, `description`, `icon`) across cloud pull cycles and page reloads. A cloud sync merge will never strip `publicId` or erroneously re-tag a public playlist as private.
   - On account boot (`bootAuth()`), `plFetchMine()` automatically reconciles local playlists with `/api/playlists/mine`, restoring any public identifiers if a browser cache was cleared.
