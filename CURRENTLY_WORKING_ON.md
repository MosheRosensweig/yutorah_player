# Currently Working On — Living Status & Activity Log

Living status doc & audit log — updated on every milestone and user request.  
Last updated: **2026-09-10, 23:35 ET**  
Current branch: `feat/auth-d1`  
Dev deployment: [https://yutorah-player-dev.mrosensweig.workers.dev](https://yutorah-player-dev.mrosensweig.workers.dev)  
Tests: **5/5 test suites passing (100% green, 11/11 basic functionality checks)**  
Production status: **Untouched** (strictly protected by standing rules)

---

## 🕒 Chronological Activity Log

### [2026-09-10 23:35 ET] — Commit `feat/auth-d1` (Plain Gear Avatar Default + Dropdown Navigation Fixes + Light Mode Playlists Contrast + Theme-Adaptive Hero Scrim)
- `[DONE]` **Plain Gear Replacement for Login Icon**:
  - Set `plain-gear` (`⚙️`) as the default avatar variant in `AVATAR_VARIANTS` and `getAvatarStyle()`.
  - When logged out: shows `👤 Sign in` (compact `👤` on mobile); when logged in: shows `⚙️` spinning 180° on hover. Users can still choose other styles in Dev Mode avatar picker.
- `[DONE]` **Dropdown "My Playlists" Navigation**:
  - `devScrollToPlaylists()` now explicitly invokes `switchCollection('playlists')`, activates `'history'`, renders the grid, and smoothly scrolls to `#collectionsSection`.
- `[DONE]` **Dropdown "Open Queue" Navigation & Popup**:
  - `devOpenQueueView()` opens `#queuePopup` with `display: flex`, calls `renderQueuePopup()`, and switches collection to `playlists` with `activeDevPlaylistId = 'queue'`.
  - Changed `renderQueuePopup()` guard from `if (!isDevMode)` to `if (!playlistsEnabled())`, unlocking queue popup for all logged-in users in non-dev mode.
- `[DONE]` **Light Mode Playlists Readability & Outline Boxes**:
  - Upgraded theme variables: `--border: #cbd5e1;` and `--border-light: #e2e8f0;` for crisp card boundaries.
  - Added dedicated CSS classes: `.playlist-public-card`, `.playlist-card-title`, `.playlist-card-meta`, `.playlist-card-desc`, `.playlist-card-tags`, `.playlist-tag-chip` with `1.5px solid var(--border)` and subtle shadow.
  - Upgraded public search bar inputs/selects, preview rows, `.playlist-pill`, and `.card-mini-btn` with `1.5px solid var(--border)`.
- `[DONE]` **Hero Slideshow Text Contrast in Both Modes**:
  - Replaced single hardcoded scrim with theme-adaptive scrim:
    - **Light Mode**: `linear-gradient(to left, rgba(255, 255, 255, 0.96) 55%, rgba(255, 255, 255, 0.84) 80%, rgba(255, 255, 255, 0) 100%)` with dark slate text (`#0f172a` title, `#334155` desc) and primary button (`#2b4c7e`).
    - **Dark Mode**: `linear-gradient(to left, rgba(15, 20, 28, 0.95) 55%, rgba(15, 20, 28, 0.82) 80%, rgba(15, 20, 28, 0) 100%)` with crisp white text (`#ffffff` title, `#cbd5e1` desc) and bright button (`#5c8ecc`).
    - **Mobile**: Uses `--card`, `--text`, `--text-muted`, and `--primary` seamlessly in both modes.
- `[DONE]` **Dual Review Adversarial Hardening**:
  - Fixed plain-gear hover spin by wrapping in `<span class="auth-avatar plain-gear">` and explicitly targeting `.auth-gear` in CSS.
  - Resolved public playlist search focus drop by capturing and restoring input focus/caret across debounced queries.
  - Eliminated navigation double-renders by setting `activeDevPlaylistId` before switching collections.
  - Upgraded `.card-mini-btn.active-save` to `#b45309` (Amber 700) for WCAG AA compliance (4.67:1 ratio).
  - Added `:focus-visible` to `.settings-menu-item` for keyboard accessibility.
- `[DONE]` **Automated Testing**: Added Test #11 (`testDropdownNavAndThemeAesthetics`) to `tests/basic_functionality.test.mjs`. All 5 test suites passed 100% green.

### [2026-09-10 23:15 ET] — Commit `feat/auth-d1` (Dual Review Approved + Dev Playlists + SVGs + Hero Contrast)
- `[DONE]` **Spinning Gear & Account Button**:
  - Replaced account button with dynamic states: when logged out, displays `👤 Sign in` (compact `👤` on mobile); when logged in, displays gear icon with embedded user initial that spins 180° on hover with spring physics (`0.6s cubic-bezier(0.34, 1.56, 0.64, 1)`).
  - Resolved compound rotation bug on `gear-letter` avatar by scoping rotation to `.auth-avatar` and `.auth-svg-gear`.
- `[DONE]` **Non-Dev Menu Scoping**:
  - In standard non-dev mode, the dropdown menu ONLY displays non-dev user items: Name/Email, `📋 Open Play Queue`, `🎧 My Playlists`, `✏️ Display name`, `🚪 Sign out`.
  - The avatar picker, save-clock picker, and change log are strictly hidden unless `isDevMode` is active.
- `[DONE]` **5 Additional Custom Vector SVGs (Total 10 Avatar Options)**:
  - Added 5 precision vector SVGs: `svg-gear-12tooth` (industrial 12-cog), `svg-gear-sun` (solar crown), `svg-gear-steampunk` (6-cog horological cutout), `svg-gear-shield` (hexagonal star badge), and `svg-gear-smooth` (curved scallop).
  - Center-embeds the user's uppercase initial into the gear.
- `[DONE]` **Mobile Lock Screen ±10s Controls Fix**:
  - Resolved issue where iOS Control Center / Android notifications showed track skip arrows instead of seek buttons. Explicitly unbound `previoustrack` and `nexttrack` (`setActionHandler(..., null)`), forcing mobile OS lock screens to display the circular `-10` and `+10` skip buttons.
- `[DONE]` **10 Dev Public Playlists with Non-Google Ownership & In-App Editing**:
  - Seeded 10 curated public playlists under owner "Dev" (`owner_id: 'dev'`) with rich tags and lecture items directly into remote Cloudflare D1 (`yutorah-db`).
  - Added `DEV_PUBLIC_SEEDS` to client store. In Dev Mode without Google auth, user owns these playlists and can edit their details (`✏️ Edit (Dev)` button), publish, and unpublish via `X-Dev-Mode: 1` header.
- `[DONE]` **Light Mode Hero Slideshow Contrast Polish**:
  - Completely fixed washed-out caption text on light mode slides by adding a 55%-width dark slate gradient scrim (`rgba(15, 23, 42, 0.94)`), backdrop blur (`4px`), crisp white typography (`#ffffff`), and white CTA button.
  - Mobile layout transitions caption to static card beneath image with dark text and solid primary button.
- `[DONE]` **OAuth `return_to` Timestamp & Destination Preservation**:
  - OAuth flow securely signs and verifies `return_to` path, returning users to their exact shiur URL and audio playback timestamp.
  - Fixed duplicate `t` parameter edge case using WHATWG URL API.
- `[DONE]` **Dual Adversarial Review Approved**:
  - Correctness QA Reviewer and Style/Theme Reviewer completed independent reviews. Restored `positionAuthMenu()`, resolved nested rotation, fixed `return_to` query parsing, added ARIA modal attributes to `#advancedSearchModal` and `#newPlaylistModal`.
- `[DONE]` **Automated Testing**: Added Test #10 (`testDevModeAndAvatarVariants`) to `tests/basic_functionality.test.mjs`. All 5 test suites passed 100% green.

### [2026-09-10 22:36 ET] — Commit `3fae04a` (Dual Review + Dev Deploy)
- `[DONE]` **Dual Adversarial Review**: Correctness QA Reviewer and Style/Theme Reviewer completed reviews. All findings addressed:
  - Resolved `[data-theme="dark"] textarea` styling so dark mode modal textareas do not show white backgrounds.
  - Decoupled speaker name and photo resolution in `normalizeShiur` so `shiurTeachers[0]` photo is never skipped when `teacherfullname` is present.
  - Prioritized `teacherPhotoURL_lp || teacherPhotoURL_o || teacherPhotoURL` in `renderShiurCardHtml`.
  - Fixed series saving in `/api/playlists/save` (`it.seriesTitle = it.title`).
  - Fixed series preview in `plPublicRenderItems` (`s.kind === 'series'` renders `📚 ${seriesTitle}` and lecture count instead of `<a href="/">Untitled</a>`).
  - Added global window Escape keydown listener closing `#newPlaylistModal`, `#playlistDetailsModal`, and `#displayNameModal`.
  - Fixed playlist pill escaping bugs in inline script template literals by introducing `devSelectPlaylist(...)` helper and entity-encoded quotes (`&quot;`).
- `[DONE]` **Automated Testing**: Added Test #9 (`testMediaSessionIntegration`) to `tests/basic_functionality.test.mjs`. All 5 test suites (`phonetic_engine`, `basic_functionality`, `fuzzy_suggest`, `auth_sync`, `sync_merge`) passed cleanly.
- `[DONE]` **Git Push & Staging Deployment**: Pushed commit `3fae04a` to remote branch `feat/auth-d1` and deployed to DEV worker (`https://yutorah-player-dev.mrosensweig.workers.dev`, Version `54d37053-938a-4e5f-b747-2a4274267437`).
- `[DONE]` **Changelog**: Updated `src/changelog.json` with entry dated `2026-09-10T22:30:00-04:00`.

---

## 📊 Feature Inventory & Status Matrix

### 1. Mobile Lock Screen & Media Controls
- `[DONE]` **±10s Skip Buttons (iOS & Android)**: Unregistered `previoustrack` and `nexttrack` (`null`) and bound `seekbackward` / `seekforward` MediaSession handlers with 10s default offset universally on playback start. Mobile iOS Control Center / Lock Screen and Android compact notification shade now consistently display circular `-10` and `+10` skip buttons flanking Play/Pause instead of track skip arrows.
- `[DONE]` **High-Resolution Speaker Artwork**: Multi-size W3C artwork array (`96x96`, `128x128`, `192x192`, `256x256`, `384x384`, `512x512`) pulling the speaker's portrait from `teacherPhotoURL_lp`, `teacherPhotoURL_o`, `teacherPhotoURL`, or `PHOTO` across dynamic shiur loading, SSR, and cards. Notification cards and lock screen backdrops render the speaker's photo with clean fallback to `_default.jpg`.
- `[DONE]` **Lock Screen Scrubbing**: Added `seekto` action handler for native OS timeline scrubbing with duration boundary checks.
- `[DONE]` **Playback State & Clamped Position Sync**: Synchronized `playbackState` ('playing'/'paused') and throttled (1000ms) `setPositionState` on audio events.
- `[DONE]` **Entity Sanitization**: Decoded HTML entities (`&amp;`, `&#39;`, `&quot;`) in media notification titles and speaker strings via `cleanMediaText(s)`.

### 2. Account Playlists, Public Discovery & Dev Ownership
- `[DONE]` **Account / Settings Button & Spinning Gear**: When logged out, displays `👤 Sign in` (icon-only on mobile); when logged in, displays gear icon with embedded user initial that smoothly spins 180° on hover (`0.6s cubic-bezier`).
- `[DONE]` **Non-Dev Menu Scoping**: When in non-dev mode, dropdown menu strictly shows user identity, `📋 Open Play Queue`, `🎧 My Playlists`, `✏️ Display name`, and `🚪 Sign out`. All developer pickers, changelog, and settings are hidden.
- `[DONE]` **10 Avatar Variants (5 CSS + 5 Vector SVGs)**: 5 CSS variations + 5 custom vector SVGs (`svg-gear-12tooth`, `svg-gear-sun`, `svg-gear-steampunk`, `svg-gear-shield`, `svg-gear-smooth`) with initial centered inside the gear geometry.
- `[DONE]` **10 Dev Public Playlists**: Curated 10 foundational public playlists owned by "Dev" (`owner_id: 'dev'`) with rich tags, description, and shiurim seeded directly in remote D1 and client store.
- `[DONE]` **Dev Mode In-App Editing Without Google Auth**: When entering Dev Mode without logging in, user owns these 10 public playlists, can edit their details (`✏️ Edit (Dev)` button), publish, and unpublish via `X-Dev-Mode: 1`.
- `[DONE]` **Universal Playlists Tab**: Tab is always visible to all users (logged-in or guest); guests see the public playlist browser with an unobtrusive sign-in banner rather than a blank login wall.
- `[DONE]` **Preview & Save Actions**: Expandable preview of public playlist contents (`Preview shiurim ▼`) and one-click saving to personal collection (`💾 Save to my playlists`) with unsave toggle.
- `[DONE]` **Series Preservation**: Series items saved to playlists preserve series title, lecture count, and proper card links.
- `[DONE]` **Remote D1 Database Migrations**: Migrations `0001_init.sql`, `0002_syncfix.sql`, `0003_public.sql`, and `0004_public_kinds.sql` fully applied to remote Cloudflare D1 `yutorah-db`.
- `[DONE]` **OAuth Return-To Preservation**: Google OAuth flow signs, verifies, and returns to exact shiur URL and audio playback timestamp via WHATWG URL parsing.

### 3. Recent Search UX & Search Capabilities
- `[DONE]` **Recent-3 Rail**: Top 3 most recent matches displayed directly above relevance results under dedicated subtitle, followed by the remaining results under an improved subtitle.
- `[DONE]` **Independent Load More**: Separate load-more handling for recent and relevance sections.
- `[DONE]` **Quick Filters & Sort**: Today / Yesterday / This Week / This Month chips + Relevance / Newest / Oldest sorting (URL-persisted and reload-safe).
- `[DONE]` **Advanced Search Modal**: Compound multi-criteria filtering across speakers, topics, venues, duration, and minute-precision date ranges.
- `[DONE]` **Phonetic & Transliteration Search**: 181 synset buckets, Ashkenazic/Sephardic equivalence, speaker honorific stripping, and fuzzy "Did-You-Mean" suggestions.

### 4. Player, Discovery & UX
- `[DONE]` **Homepage Spotlight Slideshow & Light Mode Contrast**: Rotating hero slides with keyboard, touch swipe, dots, and deep links. Light mode contrast perfected with 55% dark slate gradient scrim (`rgba(15, 23, 42, 0.94)`), backdrop blur (`4px`), crisp white typography (`#ffffff`), and white CTA button.
- `[DONE]` **View Toggle (Cards vs. Rows)**: Desktop rows default, mobile cards default; persists across reloads and tabs.
- `[DONE]` **Player Metadata**: Direct upload date display alongside given date; clickable topic chips.
- `[DONE]` **Card Action Split**: Play badge starts mini-player; card body opens full player.
- `[DONE]` **Article Reader & Liquid Mode 3.0**: Embedded PDF viewer with multi-column reconstruction, drop-cap stitching, and interactive footnote popovers.
- `[DONE]` **Daily Audio Sponsorship**: Dynamic sponsorship banner with synchronized pre-roll audio playback and smooth progress bar.

---

## ⏳ Items In Queue: Requested & Not Done / Parked

| Item | Status | Description | Notes |
| :--- | :---: | :--- | :--- |
| **Live Google OAuth Credentials** | `[REQUESTED / NOT DONE]` | Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` via `wrangler secret put` | Waiting on credentials from owner to live-test Google login on dev. |
| **Clock Icon Selection** | `[PARKED]` | Choose preferred clock hand design among 5 options in Settings | User to select preferred SVG clock hand style. |
| **Production Deployment** | `[PARKED]` | Promote `feat/auth-d1` branch & D1 binding to production | STRICT RULE: Awaiting explicit approval from user before touching production. |
| **Audio Transcription (Groq Whisper)** | `[REQUESTED / NOT DONE]` | Roadmap §4: On-demand speech-to-text with Yeshivish transliteration | Documented in roadmap; implementation scheduled after auth rollout. |
| **Admin Quota Dashboard** | `[REQUESTED / NOT DONE]` | Roadmap §5: Lightweight `/admin` telemetry for Cloudflare D1/R2/KV quotas | Documented in roadmap; implementation scheduled after auth rollout. |
| **Public Playlist Moderation** | `[PARKED]` | Phase 3 ops: reporting/flagging inappropriate public playlist titles | Scheduled for future ops hardening. |

---

## 🛡️ Standing Development Guidelines
1. **Log Updates**: Update this document (`CURRENTLY_WORKING_ON.md`) on every milestone, logging completed work (`[DONE]`), in-progress work (`[IN PROGRESS]`), and queued items (`[REQUESTED / NOT DONE]`).
2. **Dual Review**: Correctness QA and Style/Theme subagents must review and approve every release before deployment.
3. **Separate Commits**: Maintain atomic commits per feature branch.
4. **DEV ONLY**: Deploy strictly to `yutorah-player-dev.mrosensweig.workers.dev` via `npx wrangler deploy --env dev`. **NEVER** touch production without explicit user command.
5. **Changelog**: Update `src/changelog.json` on every push.
