# 📋 Missing Features & Parity Gap Analysis Document
**YUTorah Enhanced Player**  
**Document Version:** 1.1.0  
**Date:** September 11, 2026  
**Status:** Active Prioritized Engineering Backlog & Feature Audit  

---

## Executive Summary

The **YUTorah Enhanced Player** has reached an advanced level of feature completeness and production maturity. It currently exceeds the legacy `yutorah.org` platform across multiple key technical areas:
- **Search & Discovery**: Sub-50ms Solr queries, an Ashkenazic/Sephardic phonetic and reverse-transliteration engine, synset expansions, typo-tolerant "Did You Mean" suggestions, and multi-criteria filters (Teachers, Venues, Topics, Durations, Dates, Media Types).
- **Audio Experience**: Mobile lock-screen controls (`MediaSession` API) with speaker artwork, ±10s/±30s skip, keyboard shortcuts, background audio persistence, and URL timestamp deep-linking (`?t=`).
- **Interactive Article & PDF Reader**: Liquid Mode 3.0 document reconstruction with dynamic column detection, drop-cap stitching, bidirectional Hebrew/English typesetting, and interactive footnote popovers.
- **Account & Playlists Cloud Engine**: Edge-native Google OAuth 2.0 PKCE, Cloudflare D1 serverless SQLite synchronization (History, Save for Later, Favorites, Play Queue), custom playlist creation with taxonomy tags and emoji pickers, and public playlist browsing with live-sync subscriptions.
- **Visual Design & Theming**: Automatic holiday motif themes, dark mode default for new users, high-contrast hero slideshow, and mobile header cutoff prevention.

Below is the structured feature roadmap, beginning with the **Primary Category** of explicitly prioritized user features, followed by comprehensive audits of upstream parity, modern media app standards, and strategic capabilities.

---

## 🌟 Primary Category: User-Prioritized Active Backlog

These 7 features have been designated as the top priorities to be implemented first, in sequence starting with the PWA:

### 1. Progressive Web App (PWA) Engine *(CURRENT SPRINT - IN PROGRESS)*
- **User Requirement**: Make the player PWA-capable **without modifying any of the visual appearances at all**.
- **Implementation Specifications**:
  - Web App Manifest (`/manifest.json` and `/manifest.webmanifest`) declaring standalone display, app icons, theme colors (`#0f141c` / `#2b4c7e`), and start URL.
  - Service Worker (`/sw.js`) providing network-first caching for application shell, static assets, and offline fallbacks, with automatic bypass for streaming audio byte ranges (`Range: bytes=`) to preserve seamless audio playback.
  - Mobile meta tags (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`).
  - Automated client registration on window load.
  - **Visual Guarantee**: 100% untouched UI — no intrusive install banners, zero layout shifts, zero styling changes.

### 2. Docking on Small Devices (Mobile Clearance & Player Padding)
- **User Requirement**: Ensure seamless bottom player docking on compact mobile viewports ($\le 375\text{px}$, e.g. iPhone SE, mini devices) so that content, playlist cards, and bottom controls are never obscured.
- **Implementation Specifications**:
  - Dynamically calculate and sync `--player-height` and safe-area insets (`env(safe-area-inset-bottom)`) with bottom container padding (`.results-container`, `.playlists-view`, `.collection-content`).
  - Guarantee that the last shiur card, "Load More" button, and pagination controls remain fully visible and scrollable above the fixed dock player.

### 3. Source Material Availability on Audio Shiurim
- **User Requirement**: Provide immediate access to attached source sheets, marei mekomos handouts, and reference materials directly from audio lectures.
- **Implementation Specifications**:
  - Extract secondary attached PDF/document links (`attachments`, `materials`, `shiurdownloadurl`) in `normalizeShiur()`.
  - Render an on-player `📄 Source Sheet` button on audio shiurim that open the attached handout directly in the Liquid Mode PDF viewer without interrupting the playing audio.

### 4. "Shiurim therein" Informational "ℹ️" Button / Tooltip
- **User Requirement**: Add an informational "i" button next to the "Shiurim therein" search scope checkbox on public playlists so users immediately know what it means.
- **Implementation Specifications**:
  - In the playlist search scope filters, add an interactive info icon `ℹ️` next to `Shiurim therein`.
  - Display an inline tooltip/popover clarifying: *"Searches inside playlists for matching lecture titles, speakers, and topics rather than only matching the playlist's title."*

### 5. Public Playlists Dual Action Buttons: "Make a Copy" & "Follow"
- **User Requirement**: Replace the modal and confusing "read-only copy" wording with two distinct, explicit buttons: one button to make a copy and one button to follow.
- **Implementation Specifications**:
  - On public playlist cards and views, present two clear, adjacent action buttons:
    1. `📡 Follow` (or `✓ Following`): Subscribes to live sync updates from the curator (read-only subscription).
    2. `📋 Make a Copy`: Immediately clones the playlist into the user's custom playlists as an independent, fully editable copy.
  - Eliminates the interim selection modal and avoids ambiguous terminology like "read-only copy".

### 6. Custom Typable Playback Speed Input
- **User Requirement**: Enable a "Custom" playback speed option that reveals an input field where the user can type in their exact desired speed.
- **Implementation Specifications**:
  - In the speed selector dropdown/menu, include a `Custom...` entry.
  - When selected, display an inline number input field allowing fine-grained entries (e.g., `1.15`, `1.30`, `1.45`, `1.75`) with instant validation and `audio.playbackRate` application.

### 7. Desktop On-Screen Volume Slider & Mute Toggle
- **User Requirement**: Add a visible desktop volume slider on the player bar for direct mouse control without relying on OS volume or keyboard shortcuts.
- **Implementation Specifications**:
  - Render a horizontal volume slider and mute toggle icon (`🔊` / `🔇`) on the desktop player bar adjacent to the progress scrubber.
  - Synchronize with the keyboard shortcut (`M`), persist volume level in `localStorage`, and hide cleanly on mobile viewports where physical hardware rockers are standard.

---

## 1. Upstream Parity Gaps (Original `yutorah.org` Features)

Features from the legacy `yutorah.org` portal prioritized for future milestones:

### 1.1 Dedicated Daf Yomi & Daily Study Hub (`/daf`)
- **Legacy Behavior**: `yutorah.org/daf` provides an interactive tracker for "Today's Daf", calendar navigation (yesterday/tomorrow/custom date), and a direct tractate/folio matrix. Lectures are organized specifically by Masechta and Daf rather than general search tokens.
- **Current Enhanced Player State**: The homepage and header display the daily study tracker strings (e.g. `Daf: Chullin 129`, `Mishna Yomi: Keilim 29:2-3`), but clicking them simply triggers a free-text search.
- **Implementation Approach**: Create a dedicated `/daf` view powered by `api.yutorah.org/homepage/timely` and Solr subcategory queries (`subCategoryId` for Masechtos) with a structured Talmud tractate and folio selector.

### 1.2 Speaker Profile & Bio Landing Pages (`/teachers/{Name}`)
- **Legacy Behavior**: Clicking a speaker opens a dedicated landing page (`yutorah.org/teachers/{Name}`) featuring their high-res portrait, rabbinic biography, institutional affiliation, series list, top lectures by view count, and a chronological catalog.
- **Current Enhanced Player State**: Speakers are selectable via search autocomplete and clickable on shiur cards (which initiates a search for `teacherId`), but there is no dedicated speaker biography or profile drawer.
- **Implementation Approach**: Consume `www.yutorah.org/teachers/sidebar/{id}` (which is CORS-enabled and bypasses Turnstile) to display an edge-cached speaker modal or dedicated route with their bio, photo, active series, and curated lectures.

### 1.3 Browse Taxonomy Tree (Categories & Masechtos Mega-Menu)
- **Legacy Behavior**: A multi-tiered browse navigation menu structured hierarchically:
  - **Gemara**: Bavli $\to$ Seder $\to$ Masechta $\to$ Perek
  - **Halacha**: Shulchan Aruch $\to$ Orach Chaim, Yoreh De'ah, Even HaEzer, Choshen Mishpat
  - **Tanach**: Torah (Parshiot), Nevi'im, Ketuvim
  - **Machshava & Jewish Thought**
- **Current Enhanced Player State**: Topics can be searched via typable combobox inputs in the Filters modal, but there is no top-down browsable hierarchical tree.
- **Implementation Approach**: Build a collapsible taxonomy browser using the 601 subcategory facets returned by `api.yutorah.org`.

### 1.4 Native Video Shiur Playback (`MP4` Lectures)
- **Legacy Behavior**: Thousands of YUTorah shiurim include video recordings (`mediaTypeCategory: video`), streamed as progressive MP4 files.
- **Current Enhanced Player State**: The Enhanced Player plays the audio stream of video shiurim through the HTML5 `<audio>` element or provides an external download link, but lacks an inline `<video>` viewport.
- **Implementation Approach**: Detect `mediatypecategory === 'video'` and provide an expandable picture-in-picture / docked `<video>` element with speed and seek controls matching the audio transport.

### 1.5 Per-Speaker & Per-Series Podcast / RSS Feeds
- **Legacy Behavior**: Every speaker and series exposes an RSS 2.0 XML podcast feed (`yutorah.org/rss/RssAudioOnly/speaker/{id}` and `yutorah.org/rss/RssAudioOnly/series/{id}`) allowing users to subscribe directly in Apple Podcasts, Overcast, or Pocket Casts.
- **Current Enhanced Player State**: The player offers shareable web links with timestamp preservation (`?t=`), but does not expose native RSS feed links or podcast subscription buttons.
- **Implementation Approach**: Add an `📡 RSS / Podcast` button on series cards and speaker views pointing to the native YUTorah RSS endpoints, with one-tap "Copy Podcast URL" functionality.

### 1.6 Community Comments & "Ask Speaker" Form
- **Legacy Behavior**: Lecture pages feature a discussion/comment thread and an "Ask Speaker" submission form.
- **Current Enhanced Player State**: Excluded due to spam/unmoderated content on the legacy platform.
- **Recommendation**: Low priority. If desired, a verified Cloudflare D1 comment system restricted to authenticated Google users could be introduced.

---

## 2. Modern Media & Podcast App Standards

Secondary features found in modern audio apps:

### 2.1 Playback Sleep Timer
- **Description**: A dedicated sleep timer button (🌙) on the player bar that automatically pauses playback after a specified interval:
  - **Presets**: 15 minutes, 30 minutes, 45 minutes, 60 minutes, or "End of Current Shiur".
  - **Audio Fade**: A gentle 5-second volume fade-out before pausing, preventing abrupt audio cutoffs.
- **User Impact**: Very high for bedtime listeners.

### 2.2 Continuous Series Autoplay
- **Description**: When Episode 3 of a series finishes playing, the player automatically queues and starts Episode 4.
- **Current State**: The Play Queue auto-advances if shiurim were added to the queue, but playing a standalone shiur from a series list does not automatically sequence subsequent episodes.

### 2.3 Keyboard Shortcuts Help Modal (`?`)
- **Description**: Pressing `?` or `Shift+/` displays a clean keyboard cheat-sheet dialog showing all supported hotkeys (`Space`, `←`/`→`, `[`/`]`, `M`, `Esc`).

---

## 3. Strategic & AI Roadmap Innovations

High-leverage strategic features:

### 3.1 On-Demand Speech-to-Text Transcription (Groq Whisper Large-v3)
- **Concept**: Integrate lazy, on-demand AI transcription powered by the Groq LPU Whisper Large-v3-Turbo API (~14 seconds per 45-minute lecture at ~$0.03 cost).
- **Yeshivish Lexicon Priming**: Seed the transcription prompt with rabbinic and Aramaic vocabulary (*gemara, d'oraisa, machshava, chazal, rishonim, rosh yeshiva*).
- **R2 Edge Cache**: Transcripts stored permanently as JSON and WebVTT in Cloudflare R2 object storage so each lecture is only transcribed once globally.
- **Karaoke Synced Player**: A synchronized transcript drawer where text highlights in real time as the speaker talks.

### 3.2 Full-Text Transcript Search & Timestamp Deep-Jumping
- **Concept**: Search across spoken audio content, allowing users to find the exact minute and second a topic or source was cited (e.g. *"Ramban on Pesachim 5b"* $\to$ jumps directly to `24:18`).

---

## 4. Prioritized Implementation Matrix

| Priority | Feature | Category | Effort | User Impact | Status |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **P1** | **Progressive Web App (PWA) Engine** | Primary Category | Med (~2h) | **High** | **In Progress (Milestone 1)** |
| **P2** | **Docking on Small Devices ($\le 375\text{px}$)** | Primary Category | Low (~1h) | **High** | **Queued (Next)** |
| **P3** | **Source Material Availability on Audio** | Primary Category | Low-Med (~2h) | **Very High** | **Queued** |
| **P4** | **"Shiurim therein" Informational "ℹ️" Button** | Primary Category | Very Low (~30m) | **Medium** | **Queued** |
| **P5** | **Public Playlists Dual Buttons (Follow / Copy)** | Primary Category | Low (~1h) | **High** | **Queued** |
| **P6** | **Custom Typable Playback Speed** | Primary Category | Low (~45m) | **Medium** | **Queued** |
| **P7** | **Desktop On-Screen Volume Slider** | Primary Category | Very Low (~30m) | **High** | **Queued** |
| **P8** | **Sleep Timer** (15m, 30m, End of Track + Fade) | Modern Audio Standard | Low (~1h) | **Very High** | Future Milestone |
| **P9** | **Continuous Series Autoplay** | Modern Audio Standard | Low (~1h) | **High** | Future Milestone |
| **P10** | **Keyboard Shortcuts Modal (`?`)** | Modern Audio Standard | Very Low (~30m) | **Medium** | Future Milestone |
| **P11** | **Daf Yomi & Daily Study Hub (`/daf`)** | Upstream Parity Gap | Med (1–2d) | **Very High** | Future Milestone |
| **P12** | **Speaker Bio & Profile Drawers** | Upstream Parity Gap | Med (1d) | **High** | Future Milestone |
| **P13** | **Native Video Playback (`MP4` Lectures)** | Upstream Parity Gap | Med (1–2d) | **Medium** | Future Milestone |
| **P14** | **Per-Speaker / Per-Series RSS Feeds** | Upstream Parity Gap | Low (~2h) | **Medium** | Future Milestone |
| **P15** | **AI Transcription & Synced Transcript Drawer** | Strategic / AI Roadmap | High (3–4d) | **Transformative** | Future Milestone |
