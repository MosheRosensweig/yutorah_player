# Currently Working On

Living status doc — rewritten whenever the user says "write down where you're up to".
Last updated: 2026-09-10, 22:30 ET (branch `feat/auth-d1`, all 5 test suites green).

## Right now (ready for dual review & dev deploy)
- **Account-playlists rollout review fixes**: logged-out tab ALWAYS visible (prompt + public browser, no login wall); Esc closes display-name/details/new-playlist modals; SSR tab label "🎧 My Playlists" (no Dev leak); dashed dev-tab style scoped to dev only; public/private publish choice + server-truth visibility tag; public Load More + true totals; textarea dark theme; prompt login preserves return URL; empty-name feedback; tag selects loading state; public API fixes (unsave route, XSS id validation, pagination, caps, idempotent re-publish, res.ok checks, series kind persistence).
- **Mobile Lock Screen & Notification Center MediaSession (Swipe-Down Controls)**:
  - **±10s Skip Buttons**: Registered `seekbackward` and `seekforward` action handlers with 10s default offset universally on playback start so mobile iOS Control Center / Lock Screen and Android notification shade display `-10` and `+10` skip buttons flanking Play/Pause.
  - **High-Res Speaker Artwork**: Multi-size artwork array (`96x96`, `128x128`, `192x192`, `256x256`, `384x384`, `512x512`) pulling the speaker's portrait from `teacherPhotoURL_lp`, `teacherPhotoURL_o`, `teacherPhotoURL`, or `PHOTO` across dynamic shiur loading, SSR, and cards, so the mobile notification card/backdrop renders the speaker's photo instead of falling back to the generic icon.
  - **Lock Screen Scrubbing & State Sync**: Added `seekto` handler for OS timeline scrubbing, `nexttrack` for queue advancement, and synced `playbackState` ('playing'/'paused') and `setPositionState` on audio events.
  - **Automated Regression Coverage**: Added MediaSession integration test to `tests/basic_functionality.test.mjs`.

## Active threads and their state

### 1. Recent search UX (DONE, on dev)
- Recent-3 rail + full-30 relevance + single Load More; no carve-out.
- Quick chips Today/Yesterday/Week/Month + Relevance/Newest/Oldest sort, all URL-persisted, reload-safe.
- Advanced datetime range (minute precision); modal reset/populate round-trips.
- No speaker auto-narrowing (single AND multi-word); typo strips on top when <10 hits or zero-literal + distance-1; strips never echo the query itself.

### 2. Discovery (DONE, on dev)
- Hero slideshow (rotating, dots/arrows/swipe/keyboard/inert/reduced-motion); caption overlays image's blank right half; mobile stacked + fade + blur-fill centering; yutorah `/search/` dests translated to our routes; `/togo/` + unknown stay external.
- Cards/Rows toggle (desktop rows default, mobile cards-only); works in every grid incl. series; survives reload/tab-switch (inline-display fix).
- Series buttons named (`View N more in 'X' Series`).
- Sponsorship dedication bolded from `l'ilui nishmas`, entities decoded once.
- Speaker pages: Recent-6 + Top-10 (visits+downloads) + All, frozen across Load-More.
- Transliteration essay behind circle-`i` + On/Off switch, single row.

### 3. Player & cards (DONE, on dev)
- Player meta: `📤 Uploaded` row in metadata box (direct links too); topic chips search.
- Card click split: ▶ badge mini-plays, body opens full player; same-track tap resumes.
- Icon-only Later/Fav (5 pickable clocks: emoji + 4 bolder SVG hands), circular queue button, centered 28px heights.
- Rows NEW badge clear of date; mobile mini-player has no expand arrow.
- Mobile lock screen & swipe-down notification card: ±10s buttons via MediaSession (`seekbackward`/`seekforward`), high-res speaker portrait background (`96x96`–`512x512`), lock screen scrubber support (`seekto`), and queue integration (`nexttrack`).

### 4. Dev playlists + queue (DONE, on dev; now going public)
- Playlists tab, custom playlists (modal create, custom confirm delete, export, Play All, totals), save/fav/queue/playlist card buttons + player header buttons, silent toggles.
- Queue: card/cover/player queueing, series expand-on-play, ☰ popup + tab view, drag/▲▼/✕, clear-confirm, autoplay toast, skip-current.
- History sort (Last Listened / Shiur Date), progress bars everywhere, `exit dev mode`.
- Change Log viewer (`src/changelog.json`, update on every push).

### 5. Auth + SQL backend (IN PROGRESS on `feat/auth-d1`)
- DONE: `yutorah-db` D1 (dev-bound), migrations 0001+0002+0003, Google OAuth+PKCE, sessions (JWT, sliding, Secure-aware), `/api/me|profile|sync`, public playlist APIs, login button top + mobile dropdown, display-name dialog, 5 avatar styles, return-URL login, dirty-flag sync, LWW merges, no-wipe guarantees, series round-trip, docs (`AUTH_SETUP.md`, `USER_DATA_STRATEGY.md`, `SECURITY.md`).
- DONE NOW: account playlists rollout — playlists/queue/progress work logged-in (not dev-gated); logged-out sees login prompt; tab renamed to "<name>'s Playlists"; public playlists (publish w/ description + controlled tags + private/public tag, browse with text+tag search, preview, save/unsave to collection); display-name setting.
- TODO: dual review → push → deploy dev. Google credentials still needed from owner to live-test login on dev.

### 6. Open questions / parked
- Clock winner among 5 options (user picking).
- Mobile hero: contain-full-image currently; face-crop alternative offered, declined so far.
- Public-playlist moderation/reporting (Phase 3 ops).
- Main-site promotion (production D1 binding + secrets + deploy) — awaiting approval.
- PWA/Android: documented options only, no build started.

## How we work (standing rules from user)
- Dual review (correctness + style/theme agents) gates every commit.
- Separate commits per feature; push + deploy to DEV only (`yutorah-player-dev…`).
- NEVER touch production/main site without explicit approval.
- Changelog (`src/changelog.json`) updated on every push.
- Reprint test-lists + storage math on request.
