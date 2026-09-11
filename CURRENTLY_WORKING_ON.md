# Currently Working On — Living Status & Activity Log

Living status doc & audit log — updated on every milestone and user request.  
Last updated: **2026-09-10, 22:38 ET**  
Current branch: `feat/auth-d1`  
Dev deployment: [https://yutorah-player-dev.mrosensweig.workers.dev](https://yutorah-player-dev.mrosensweig.workers.dev)  
Tests: **5/5 test suites passing (100% green)**  
Production status: **Untouched** (strictly protected by standing rules)

---

## 🕒 Chronological Activity Log

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
- `[DONE]` **±10s Skip Buttons**: Bound `seekbackward` and `seekforward` MediaSession handlers with 10s default offset universally on playback start. Mobile iOS Control Center / Lock Screen and Android notification shade now display `-10` and `+10` skip buttons flanking Play/Pause.
- `[DONE]` **High-Resolution Speaker Artwork**: Multi-size W3C artwork array (`96x96`, `128x128`, `192x192`, `256x256`, `384x384`, `512x512`) pulling the speaker's portrait from `teacherPhotoURL_lp`, `teacherPhotoURL_o`, `teacherPhotoURL`, or `PHOTO` across dynamic shiur loading, SSR, and cards. Notification cards and lock screen backdrops render the speaker's photo with clean fallback to `_default.jpg`.
- `[DONE]` **Lock Screen Scrubbing & Queue Advance**: Added `seekto` action handler for OS timeline scrubbing, `previoustrack` (`skip(-10)`), and `nexttrack` (`devPlayNextFromQueue() || skip(10)`).
- `[DONE]` **Playback State & Clamped Position Sync**: Synchronized `playbackState` ('playing'/'paused') and throttled (1000ms) `setPositionState` on audio events.
- `[DONE]` **Entity Sanitization**: Decoded HTML entities (`&amp;`, `&#39;`, `&quot;`) in media notification titles and speaker strings via `cleanMediaText(s)`.

### 2. Account Playlists & Public Playlists Rollout
- `[DONE]` **Universal Playlists Tab**: Tab is always visible to all users (logged-in or guest); guests see the public playlist browser with an unobtrusive sign-in banner rather than a blank login wall.
- `[DONE]` **Personal Playlists**: Custom playlist creation, rename, add/remove items, totals, duration sums, and export.
- `[DONE]` **Public Playlist Discovery**: Search public playlists by keywords, filter by teachers, venues, and topics, sort by recent or most saves.
- `[DONE]` **Preview & Save Actions**: Expandable preview of public playlist contents (`Preview shiurim ▼`) and one-click saving to personal collection (`💾 Save to my playlists`) with unsave toggle.
- `[DONE]` **Series Preservation**: Series items saved to playlists preserve series title, lecture count, and proper card links.
- `[DONE]` **Modal UX**: Escape key closes all dialogs; dark mode styling for textareas; display name customization.
- `[DONE]` **D1 Database & Migrations**: Migrations `0001_init.sql`, `0002_syncfix.sql`, `0003_public.sql`, and `0004_public_kinds.sql` created for Cloudflare D1.

### 3. Recent Search UX & Search Capabilities
- `[DONE]` **Recent-3 Rail**: Top 3 most recent matches displayed directly above relevance results under dedicated subtitle, followed by the remaining results under an improved subtitle.
- `[DONE]` **Independent Load More**: Separate load-more handling for recent and relevance sections.
- `[DONE]` **Quick Filters & Sort**: Today / Yesterday / This Week / This Month chips + Relevance / Newest / Oldest sorting (URL-persisted and reload-safe).
- `[DONE]` **Advanced Search Modal**: Compound multi-criteria filtering across speakers, topics, venues, duration, and minute-precision date ranges.
- `[DONE]` **Phonetic & Transliteration Search**: 181 synset buckets, Ashkenazic/Sephardic equivalence, speaker honorific stripping, and fuzzy "Did-You-Mean" suggestions.

### 4. Player, Discovery & UX
- `[DONE]` **Homepage Spotlight Slideshow**: Rotating hero slides with keyboard, touch swipe, dots, and deep links.
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
