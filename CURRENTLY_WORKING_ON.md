# Currently Working On — Living Status & Activity Log

Living status doc & audit log — updated on every milestone and user request.  
Last updated: **2026-09-16, 09:15 ET**  
Current branch: `feat/player-followups` (Player Follow-ups F1–F4; based on `feat/player-ux-batch` @ `6c66a1d`)  
Dev deployment: [https://yutorah-player-dev.mrosensweig.workers.dev](https://yutorah-player-dev.mrosensweig.workers.dev) (`72685143`)  
Production deployment: [https://yutorah-player.mrosensweig.workers.dev](https://yutorah-player.mrosensweig.workers.dev) (`3adad62b`)  
Tests: **5/5 test suites passing (100% green, 31/31 basic functionality checks)**
Production status: **DEPLOYED & VERIFIED (HTTP 200 on both Dev & Prod)** — prod now serves Player UX Batch A–E + Follow-ups F1–F4 (main @ `1ed56f2`); no schema migration needed (clearHistory uses existing table)

## 🎯 In Progress: Player Follow-ups (badge toggle → resume → card-expand → fresh-card state)
Per-user instruction: branch `feat/player-followups`, one at a time — review + Dev deploy + notes each — final dual review at the end. Prod untouched.
- [x] **F1: Badge toggles play/pause** — clicking a green `Playing` badge pauses (label flips to `Paused`); clicking again resumes. Cycle via the same-track path. Review: PASS (LOWs only). *Status: ✅ dev-deployed (`c9e7fbd8`, HTTP 200).*
- [x] **F2 (BIG): Always resume saved progress** — root cause: per-track `yutorah_progress_<id>` keys never leave their device, while heartbeat progress syncs; cross-device/PWA↔browser clicks fell back to 0:00. Fix: `resolveResumeSec()` (`?t=` → heartbeat (skip completed) → local key) used by track loads + initial-time path; all entries (card/badge/history/queue/search/daf/direct) covered. Review: PASS (MED pull-timing race pre-existing, noted). *Status: ✅ dev-deployed (`5f28711d`, HTTP 200).*
- [x] **F3 (BIG): Card click returns to big player** — with mini up, clicking the playing track's card expands the big player (resuming if paused). Same-track branch rewritten (badge=cycle, card=expand); scroll/mini/card all land on `expandPlayer`. Shipped in commit `3b07fcc`, same review (`PASS`) + Dev deploy (`c9e7fbd8`) as F1 — one shared branch, two behaviors.
- [x] **F4 (BIG): Fresh renders show Playing state** — `cardPlayBadgeHtml()` paints current state at render (search + history sites; SSR untouched + boot pass); event updater keeps them live. Decision tables verified identical. Review: PASS (LOWs only; series-sub badges noted out of scope). *Status: ✅ dev-deployed (`72685143`, HTTP 200).*

## 🎯 In Progress: Player UX Batch (skip flash → card states → mini pop → desktop color → series scope)
Per-user instruction (2026-09-15): branch `feat/player-ux-batch`, implement one at a time — FEATURES.md + review + Dev deploy each — final dual review at the end. Prod untouched until approved.
- [x] **A: Skip flash indicator** — `skip(sec)` (single choke point for main ±10/±30, mini ±10, keyboard ←/→/Shift+←/→) shows a brief centered `+10`/`−10` flash. New `#skipFlash` overlay (650ms, own timer, `aria-hidden`, reduced-motion guard), no interference with `#secretToast`. Test #29. Review: PASS (2 LOW nits, motion one folded in). *Status: ✅ dev-deployed (`dc602e96`, HTTP 200, markers live).*
- [x] **B: Card play badge 3 states** — `.quick-play-badge`: default `▶ Play`/`▶ Resume` (restored verbatim); selected+playing → green `▶ Playing` (incl. loading); selected+paused → green `‖ Paused`. Central `updateCardPlayBadges()` via play/pause/ended/track-switch/close; articles (`📄 Read`) untouched. Tests #30. Review: PASS (LOWs only). *Status: ✅ dev-deployed (`7cbd3318`, HTTP 200, markers live).*
- [x] **C: Mini player pops immediately on card play** — root cause: `minimizePlayer()` early-returns on false `hasAudio`, but `playShiurById` set it *after* the minimize call; only scroll-auto-show rescued it later. Fix: assign track state before the stayMini/expand branch ( reorder verified safe). Same commit/deploy as B.
- [x] **Final dual review follow-ups (all folded in, dev `13e08c5a`)** — resync badges + mini chrome on resolved track type (no stuck Playing, no wrong mini mode on cross-type switches); fetch-failure selection rollback; docs header/date/branch/deploys/test-count corrected.
- [x] **D: Desktop color mismatch investigation** — root cause: cross-device theme contagion via copied links. Copy-link stamped `?theme=` whenever the copier had an explicit theme; opening it applied AND saved that theme (boot + popstate wrote localStorage+cookie), permanently flipping the desktop to dark. Fix: URL theme is render-only everywhere (boot main+daf, popstate); copy-link + public-search share strip stamped params; server still honors URL for SSR first-paint. Toggle handlers remain the only savers. Tests #28 updated + #31. Review: PASS (3 follow-ups folded in). *Status: ✅ dev-deployed (`ae80c78e`, HTTP 200, `?theme=dark` still SSRs dark once).*
- [x] **E (scope only): Series indicator while listening** — verdict: **yes, doable** — write-up below, no code yet.
  - **What already exists**: series identity (`series_title`/`cover_id`) flows through sync rows, queue entries (`kind:'series'`), and search grouping; search renders cover cards + expandable drawers (`toggleSeriesDrawer`, `renderSeriesGroup`) and caches expansions in `devSeriesCache[coverId] = {title, docs}`; sub-card markup (`renderSeriesSubCard`) is reusable.
  - **Gap 1 — player doesn't know its series**: `playShiurById` would need series identity for the current track (from the clicked card's dataset at click time, or a series field on the lecture API response if present).
  - **Gap 2 — sibling fetch**: no dedicated series endpoint; miss path needs one (options: query search grouped by series title, or new `cover_id`-keyed lookup). Hit path reuses `devSeriesCache`.
  - **Proposed build steps**: (1) plumb `seriesTitle`+`coverId` into now-playing state on `playShiurById` (+ direct-link hydrate); (2) sibling resolver: cache-hit render, cache-miss fetch; (3) bottom strip UI in `#playerCard` reusing drawer/sub-card markup with current-item highlight + click-to-switch + collapse, hidden for non-series/articles; (4) refresh on track switch + player close teardown; (5) test (grouped series plays → strip appears; switch → highlight moves) + FEATURES.md; (6) review + dev deploy.
  - **Estimate**: half the work is done (grouping + drawer + cache); remaining is plumbing + strip UI ≈ one focused session. Open question: preferred miss-path source (search-group query vs new endpoint).

## 🎯 In Progress: Dev-Only Trio (Source Sheets → Shiurim-Info → /daf Hub)
Per-user instruction: dev only (no prod), one feature at a time — quick review + FEATURES.md + dev deploy each — notes throughout, final dual review at the end.
- [x] **Feature 1: 📄 Source Sheet button on audio shiurim** — extraction (`shiurAdditionalMaterials` → title/type/URL, relative-URL + existence handling), player action button (count badge, audio-only, per-track reset, direct-link hydrate), keep-audio Liquid Mode path with ✕ Close, multi-sheet chooser, `cdn.yutorah.net` proxy allowlist. Test #26. *Status: ✅ dev-deployed (`2cb8d502`, HTTP 200, markers live).*
- [x] **Feature 2: Shiurim-therein ℹ️ info button** *(dev-deployed, HTTP 200, markers live)*
- [x] **Feature 3: /daf Daily Study Hub (OG-parity viewer with touch zoom/pan)** *(dev-deployed `0ca57320`, /daf 200, markers + params route live)*
  - Cycle math verified 3 ways (Sefaria + dafyomi.org + Gittin-May-2023 checkpoint): 36 masechtot, 2711 dafim, anchor 2019-12-28 (initial 2020-01-05 hypothesis was 8 days off — corrected).
  - OG-exact gestures (single-tap zoom at point, pan, pinch, buttons, dblclick), Sefaria bilingual text (CORS-open), image seam reserved.
  - Sefaria `?date=` ignored server-side → client-side math covers calendar nav. No scan-image source found (OG 403s, no Sefaria img API, e-daf/Commons unsystematic) — text-first, seam ready.
  - Quick-review catch fixed pre-deploy: init params now use `jsEmbed` (breakout-safe), not raw `JSON.stringify`.

### Review follow-up — Daf hub integration and viewer usability
- [x] Timely Study → Daf Yomi now opens the regular site’s `/daf` hub instead of a separate search destination.
- [x] Daf text viewport now scrolls normally on phones and desktop; zoomed content still supports finger pan and pinch.
- [x] Added an aligned Hebrew + English text mode, pairing Sefaria segments side by side.
- [x] Replaced the synthetic Daf page surface with the scanned page route used for Vilna daf images (`e-daf.com`); the page tab is now an actual scan viewer, while Text remains Sefaria-backed.
- [x] Dev deployment verified (`dba0c1c7-e4a3-41d1-b527-27c4669e1366`, HTTP 200 for `/daf`; live scan and bilingual markers present); production remains untouched.
- [x] Review correction completed: the Daf page tab now opens the actual scanned Vilna page route instead of a synthetic text reconstruction; Sefaria Text and aligned Hebrew + English modes remain available.
- [x] Regression fix: scan loading is now gated to the **Daf page** button only; Hebrew, English, aligned text, and Text mode no longer show the external scan site. Dev redeployed as `125f1bb9-5000-4f01-99c3-fba46d1fc717` and verified HTTP 200.
- [x] Aligned text refined to phrase pairs (Hebrew phrase, then its English translation, then the next phrase). Daf page source now requests the document/PDF form (`pdf=1`) rather than the E-Daf HTML page.
- [x] PDF-only guard added: the page tab accepts only `application/pdf`, renders a blob PDF, and never displays an HTML source page. Dev redeployed as `67dc7871-309c-457a-affa-822560d351a1` and verified HTTP 200.
- [x] Follow-up completed locally: renamed the tabs to **Daf text** and **Daf PDF**; language controls are hidden in the PDF tab, and Sefaria both-mode now visibly numbers each Hebrew→English phrase pair. The browser calls a local server-side resolver that prefers the direct Shas PDF API, falls back to E-Daf/PDF-link discovery, and rejects HTML.
- [x] Dev deployed as `59432696-029a-4dd5-9eb6-4dbef07eb4ee`: `/daf` returned HTTP 200, `/api/daf-pdf?m=Chullin&d=137` returned a valid `%PDF-1.6` response (`application/pdf`), and the full test suite passed. Production remains untouched.
- [x] Third follow-up completed: paired mode normalizes nested Sefaria arrays and renders explicit indexed Gemara→English blocks with labels, so every returned segment is visibly one pair.
- [x] Final dev deployment `b0a32737-6282-4c09-94f8-63e4ade5b152`: live `/daf` exposes both tabs and paired markers; live Chullin 137 PDF returned HTTP 200, `application/pdf`, `%PDF-`; full `npm test` passed. Production remains untouched.
- [x] New follow-up completed: text mode no longer handles tap/double-tap/pinch zoom; validated Daf PDFs render inline through PDF.js for Pixel compatibility, with עמוד א / עמוד ב / both-amud controls.
- [x] Dev deployment `bb71b238-1529-4f20-953c-20597386811b`: both live amud endpoints returned HTTP 200 `application/pdf` (`%PDF-`), inline PDF canvas markers are present, and the full test suite passed. Production remains untouched.
- [x] Regression recovery: removed the broken client-side PDF.js renderer and restored the previously stable same-origin PDF embeds while retaining text gesture isolation and עמוד א / עמוד ב / both-amud selection. Dev redeployed as `66b97072-8af9-411d-8354-1cb13fa7149b`; both amud endpoints return valid PDFs and the full test suite passes. Production remains untouched.
- [x] Current fix completed: kept the shared PDF/text toolbar mounted while scoping only the text controls, so the עמוד א / עמוד ב / both-amud selector is visible when Daf PDF is selected. Dev deployed as `e77a743c-edba-45ce-86b8-cd06983582c4`; live markup contains all three selectors and amud-B returns a valid PDF. Production remains untouched.
- [x] Using verified YUTorah raster source: `/api/daf-image` now passes through `cdnyutorah.cachefly.net/.../gifs_new/{daf}{amud}.gif`, replacing mobile PDF handoff while preserving no-storage behavior. Dev deployment `0f16b068-dcb1-412e-96ef-1e4853941376`; live amud A/B responses returned `image/gif` with `GIF89a` signatures after recheck. Full test suite passed.
- [x] Current Daf UX follow-up completed: paired Hebrew + English is now the default text mode; the עמוד ב / עמוד א / both selector is shared above the language controls in both tabs; and the button order is reversed. Full `npm test` passed and dev deployment `6012ee50-a340-4df5-a958-1d327451a26b` was verified live. Production remains untouched.
- [x] Current Daf UX follow-up completed: separated the amud selector into its own control section above the other controls in both tabs. Targeted Daf tests passed, live markup was verified, and dev deployment `0310a4f1-8a6e-4614-ad10-1ebf8556fc2e` is live. Production remains untouched.
- [x] Current Daf UX follow-up completed: removed “(paired)” from the visible Hebrew + English language button while retaining the phrase-by-phrase behavior. Targeted tests passed; cache-busted live dev verification shows `עברית + English`; deployment `7c985ad6-f2f4-43b2-8f25-88edb39b8e15` is active. Production remains untouched.
- [x] Current Daf UX follow-up completed: moved the Shiurim link from the Daf text toolbar to directly below Today’s Daf. Targeted tests passed, live placement was verified, and dev deployment `c3f40562-d332-4637-9fa4-64b87a1c62ea` is active. Production remains unchanged.
- [x] Current Daf UX follow-up completed: Daf Shiurim links preserve a return target, selected shiurim can reopen the exact Daf with a bottom mini-player, and identifiable Daf shiurim expose an Open Daf action from the audio player. Navigation now persists the current shiur/time in session storage and resumes it on `/daf`. Full `npm test` passed; live dev markers verified on deployment `d1fba019-8e32-485e-a925-57a483213984`. Production remains unchanged.
- [x] Current Daf UX follow-up completed: Daf Shiurim now stays in the same tab, mini-player state persists in both directions, and detected Daf Yomi recordings expose Open Daf in the full and minimized players. Full `npm test` passed; live dev markers verified on deployment `76d52ba2-97fa-4a31-9140-f35282cd34cf`. Production remains unchanged.
- [x] Dual review found the remaining root cause: `/daf` is a distinct full-document route, so same-tab navigation unloads the prior `<audio>` element; `sessionStorage` can resume but cannot keep playback literally uninterrupted. Added shared handoff state (`id`, Daf, time, playing intent, return URL), matching restore on both page types, explicit Return to Daf, and paused/autoplay-aware restoration. Full `npm test` passed and browser-tested on dev deployment `ce98ad14-575c-4349-9a5a-ec88c0abb0b2`: a real Chullin 137 shiur showed Open Daf, opened `/daf` in the same tab, and the Daf mini-player displayed the shiur with Open shiur. Production remains unchanged.
- [x] Clean/incognito-style review found and fixed two hidden Daf boot errors (`saved` scope and restore-before-state initialization) plus a result-selection bug where the originating Daf fallback was overwritten or not used for the Open Daf button. Full `npm test` passed; browser verification on dev confirmed a direct Chullin 137 player URL loads the real MP3 and exposes Open Daf. Latest dev deployment: `835b488d-a914-4507-96ce-43067570ac16`. Production remains unchanged.
- [x] Restored the Daf mini-player’s standard UX: removed the redundant Open shiur button, made the title/speaker area tap through to the full audio player, and added the standard closable ✕ control that pauses and hides the mini-player. Full `npm test` passed; live dev verification confirmed the mini-player has the tap handler, close button, and no Open shiur link. Dev deployment: `34ff2ccf-5c91-432f-8b68-710c3e7995cb`. Production remains unchanged.
- [x] Corrected the architecture: removed the custom Daf mini-player, its audio element, controls, CSS, and loader. Daf-linked audio now uses only the existing regular app player/mini-player; regular Open Daf actions no longer pass a `shiurId` that could recreate a second audio surface. Tests and feature documentation updated. Full `npm test` passed. Dev deployment `9fd6d107-3f3b-42b2-92a0-665de61ed382` is live and verified; production remains unchanged.
- [x] Reworked `/daf` into an in-app view: the route now renders the regular application shell and shared `#audioElement`/`#miniPlayer`; homepage Timely Study navigation and Daf Shiurim navigation use same-document view swaps and history state. Added `/api/daf-view` for loading the Daf fragment without a document reload, and made the Daf footer return link same-view too. Full `npm test` passed; dev deployment `dedaefad-ff73-41c7-a54d-6cbfe4686c52` is live and browser-verified with the shared IDs, same-view Shiurim navigation, and same-view return to Daf. Production remains unchanged.
- [x] Fixed shared mini-player expansion from Daf: the standard click handler now reveals the regular app view before expanding `#playerCard`, so clicking the mini-player info/title no longer only hides the bar behind the Daf view. Full `npm test` passed; browser regression verified the Daf view is hidden, regular view shown, mini-player hidden, and player card displayed. Dev deployment `f2b52d1f-85da-44f0-9465-99d86ae2138f` is live. Production remains unchanged.
- [x] Added a **📜 Daf** action to the main audio player's action row for shiurim with a detected tractate/folio. It uses the shared in-app Daf view and preserves audio. Full `npm test` passed; browser verification on Chullin 137 confirmed the action opens `/daf?m=Chullin&d=137` while `#audioElement` and `#miniPlayer` remain present. Dev deployment `6c2c481d-137b-4035-a730-7086f9729bac` is live. Production remains unchanged.
- [x] Renamed the main audio download action from **Download MP3** to **Download**; the article PDF download label remains unchanged. Targeted regression passed and dev deployment `4463fb45-e9a7-46da-acae-78bcaf59b461` is live and verified. Production remains unchanged.
- [x] Corrected Daf action scope: the main-player **📜 Daf** button is hidden by default and appears only when the loaded shiur has a detected Daf reference (or a valid Daf `return_to` handoff), without leaking the prior shiur's Daf context. Targeted tests passed; dev deployment `677808f6-f095-4536-9a24-6651c0e50267` is live and verified with an identifiable Daf shiur and a generic shiur. Production remains unchanged.
- [x] Fixed Daf action state across Daf-to-Daf track switches: each new shiur clears the previous reference, resets the button href, then recomputes from its own metadata or explicit Daf handoff. Tests passed; dev deployment `0153d379-7f45-47d5-bdba-7f11667402e0` is live. Production remains unchanged.
- [x] Fixed in-app Daf detection for the live title format `Daf Yomi: Chullin Daf 137`: the client parser now accepts the intervening “Daf” word just like the server parser, so clicking another Daf shiur can show its button without a reload. Full basic tests passed; dev deployment `bf0ff2d2-8592-4ff7-8ed2-affcd068176e` is live. Production remains unchanged.
- [x] Fixed the remaining reload-vs-click race: late metadata responses from an earlier clicked shiur can no longer overwrite the current shiur’s Daf button state. Full basic tests passed; dev deployment `c42c8162-7865-4538-b0c2-2bc284603648` is live. Production remains unchanged.
- [x] Follow-up browser reproduction found the click path still missed valid `Chullin 134` metadata despite reload detection. Added a deterministic client tractate/optional-Daf/folio parser; full `npm test` passed; dev deployment `6aedd4ae-56c6-4ccc-a35c-9f67bb464242` is live. Shared-browser verification loaded the app, clicked between the target Daf shiurim without reload, and confirmed the **📜 Daf** action remained present with the exact `/daf?m=Chullin&d=133/134` hrefs. Production remains unchanged.
- [x] Added `Baba Batra`/`Bava Batra` → canonical `Bava Basra` normalization so metadata such as `Daf Yomi - Baba Batra 156` resolves to Bava Basra 156; the media eligibility correction below includes this video-backed record in the app player flow. Production remains unchanged.
- [x] Corrected the media rule: this app treats YUTorah video-backed records as playable media, so `1116643` is eligible for the Daf action once its normalized `Bava Batra 156` reference is detected. Only true text/article/PDF records remain excluded. Dev deployment pending; production remains unchanged.
- [x] Completed constrained Daf name matching: known spelling variants normalize to canonical masechtot, while the broad reverse-transliteration engine is not used for button eligibility to avoid false positives. Full tests passed; dev deployment `f58563ab-6dd3-4d67-8107-598e017fe54c` is live, and `1116643` now exposes `/daf?m=Bava%20Basra&d=156`. Production remains unchanged.
- [x] Hardened the in-app Daf action lifecycle: both full and mini-player Daf links now clear synchronously on every track switch, share one validated updater, recognize `Tractate Daf Folio` during SSR and client loads, and cannot retain a prior track’s stale link while metadata is pending. Full `npm test` passed; dev deployment `bd72eb17-a87f-43a3-9bc5-a8578e8e5b99` is live and API/SSR verified for shiurim `1188088 → 1188414`. Production remains unchanged.

## 🔒 Standing Deployment & QA Invariants (Permanent Rule)
1. **Dev-First Deployment Rule (MANDATORY)**:
   - Every single feature, tweak, or bugfix **MUST ALWAYS be deployed to the Dev Worker** (`https://yutorah-player-dev.mrosensweig.workers.dev` via `npx wrangler deploy --env dev`) **FIRST**.
   - Dev deployment must be verified (HTTP 200, automated test suites 100% green, dual-review passed).
   - Only **AFTER** Dev is fully deployed, validated, and approved may the version be promoted to **Production** (`https://yutorah-player.mrosensweig.workers.dev` via `npx wrangler deploy`).
   - Dev and Prod must always remain strictly synchronized. Never push directly to Prod without the preceding Dev deployment.

## 🎯 Completed Task: Public Playlist Copy Tooltip Clipping & Subscribed/Copied Playlist Disappearance Fix
- **User Request**:
  1. **Tooltip Clipping**: When clicking the `ⓘ` info button on the `📋 Copy` button on public playlist cards, the pop-up explanation tooltip gets cut off on the right side of the screen. Ensure the pop-up never gets cut off and always shows up in a spot that is helpful to see the full window on all devices (mobile, tablet, desktop).
  2. **Playlist Disappearance Bug**: When subscribing or copying a playlist, it shows up in blue in the user's list for a few moments and then disappears. Fix this bug immediately so subscribed and copied playlists persist permanently.
- **Review Remediation (Blockers Fixed)**:
  - **BLOCKER 1.1 FIXED**: Tooltip arrow now defaults to `right: 5px` (right-aligned), centering over the 17px `ⓘ` button instead of pointing at the Subscribe label. Renamed CSS class from `align-right` → `align-left` as the fallback.
  - **BLOCKER 3.1 FIXED**: Added ARIA: `aria-expanded`/`aria-haspopup` on triggers, `role="tooltip"` on containers, `aria-label="Close"` on close buttons. JS toggles `aria-expanded` on open/close.
  - **Bonus**: Added `window.addEventListener('resize', closeAllPlInfoTips)` so tooltips close on viewport resize.
- **Status**: ✅ COMPLETED. Tests: 26/26 green. Dual review blockers remediated. Deployed to Dev (`1c494f2b`) and Prod (`148e6dcb`). Git commit `838e05b`, pushed to `feat/auth-d1`.

## 🎯 Completed Task: Public Playlist Publishing, Deletion, Privacy Toggle & Content Synchronization
- **User Request**:
  - Fix publishing and unpublishing lifecycle for public playlists:
    1. **Immediate deletion of orphaned public listing**: Playlist called "amazing 🔥" (or any deleted playlist) that no longer exists privately must be removed from the public listing immediately. Public listings must strictly reflect private listings; the owner can delete any playlist at any time.
    2. **Public / Private badge & indicator sync**: When a playlist is published, the user's private playlist tab and playlist card must display that it is Public (not remain tagged as Private). Toggling between public and private must update the tags/badges on the playlist card and inside the playlist detail view immediately.
    3. **Search availability sync**: When toggled to public, it should be immediately searchable and available in public listings. When toggled to private, it must be removed from public listings/search immediately.
    4. **Content edit sync**: When the owner modifies, adds, or deletes shiurim in a published playlist, the public search/listing and public playlist preview must reflect those changes immediately (including when all items are deleted, or items are removed).
    5. **Documentation**: Write in detail in the feature document (`FEATURES.md` and related docs) how this is supposed to work.
- **Dual Review Verdict**: **PASS** (Correctness QA: PASS, 0 Blockers; Style & Theme: PASS, 0 Blockers). Deployed to Dev (`459d642f`) and Prod (`b0cd625e`). All 5 test suites (25/25 checks) passing 100% green.

## 🎯 Completed Task: Settings Menu Icon & Calendar Date Vertical Alignment
- **User Request**: In the settings menu, all the icons are aligned one on top of the other on the left-hand side except for the calendar date which was not aligned. Make the calendar date come into alignment with all the icons and push to both Dev and Production.
- **Root Cause**:
  - The calendar date in the mobile dropdown was rendered using `<div class="settings-menu-label auth-cal-mobile">` which had `padding: 8px 10px 2px;` (10px left padding) and `font-size: 11px;`, causing the `📅` icon to sit 4px to the left of the button icons which have `padding: 10px 14px;`.
- **Implementation**:
  - Standardized `.menu-item-icon`, `.menu-theme-icon`, and `.menu-cal-icon` container with `display: inline-flex; align-items: center; justify-content: center; width: 20px; font-size: 15px;`.
  - Replaced label wrapper with `<div class="settings-menu-item auth-cal-mobile"><span class="menu-item-icon menu-cal-icon">📅</span> <span>...</span></div>` so it uses the exact same `padding: 10px 14px;`, font sizing, and flexbox alignment.
  - Wrapped all menu icons (`👤`, `📋`, `🎧`, `✏️`, `☀️`/`🌙`, `📅`, `🚪`, `🔑`) in `<span class="menu-item-icon">` containers so that all icons are centered within an identical 20px column and all text labels start at `42px` from the left edge.
  - Updated `.auth-cal-mobile` media query to `display: flex;` on screens $\le 640\text{px}$.
  - Added assertion in `tests/basic_functionality.test.mjs` Test #20. All 5 test suites pass 100% green.
- **Dual Review Verdict**: **PASS** (Correctness QA: PASS, 0 Blockers; Style & Theme: PASS, 0 Blockers). Deployed to Dev (`f5991dfa`) and Prod (`483533b5`).

## 🎯 Completed Task: Logged-Out Header Theme Toggle on Right-Hand Side & Cut-off Suppression
- **User Request**: On the non-logged-in (guest) version of the website, have the light/dark mode button be in the header on the right-hand side, BUT if it would get cut off or overflow on any screens, do NOT put it in the header since theme toggling already exists inside the settings dropdown even when not logged in.
- **Implementation**: Responsive CSS suppression on $\le 520\text{px}$, dynamic runtime overflow detection via `checkHeaderOverflow()`, right-hand placement, and dropdown menu safety net.
- **Dual Review Verdict**: **PASS** (Correctness QA: PASS, 0 Blockers; Style & Theme: PASS, 0 Blockers). Deployed to Dev (`6122bbf2`) and Prod (`f8b08d53`).

## 🚀 Active Batch 2: Shareable Playlist URLs + Dark Default + PROD Push
- [x] **Task 1: Playlist state in URL (reload-safe + shareable)** *(DEPLOYED 2026-09-11, `47ee536`, dev `b9f6af98`, test #18 green, 5/5 suites)*
- [x] **Task 2: Dark mode default for new users** *(DEPLOYED 2026-09-11, `b6e89bd`, dev `8e32b8bf`, 5/5 suites)*
- [x] **Task 3: Dual review remediation & validation** *(COMPLETED — All 5/5 suites green, 20/20 checks)*
- [x] **Task 4: Push to PRODUCTION** *(COMPLETED 2026-09-11 — Deployed version `df656c57` to `https://yutorah-player.mrosensweig.workers.dev`, 200 OK)*
- [x] **Task 5: Logged-out header theme toggle on right-hand side** *(READY FOR DEPLOYMENT)*
  - Pre-prod checks: `wrangler.toml` top-level config (name, D1 binding for prod), migrations applied to prod DB, secrets (`SESSION_SECRET`/`GOOGLE_*` per `docs/AUTH_SETUP.md`?). Deploy with `npx wrangler deploy` (no `--env`), verify prod URL.
- [x] **Fix 1: Double calendar icon in account dropdown date** *(DEPLOYED 2026-09-11, `35b6fd6`, dev `2b296199`)*
  - Header badge `textContent` already starts with 📅; dropdown prepended a second one → stripped leading emoji, single prefix kept (both auth states).
- [x] **Fix 2: Playlist → top-of-queue button** *(DEPLOYED 2026-09-11, `7c422f4`, dev `c0215d06`)*
  - New `devQueuePlaylistToTop()` prepends current playlist (in order, deduped incl. series members) to top of queue via `saveDevQueue` (cloud-synced); `⏫ Queue to Top` button next to Play All/Shuffle on all playlist rows.
- [x] **Fix 3: Shiurim-inside scope additive-only (no zeroing on tag click)** *(DEPLOYED 2026-09-11, `ac467c3`, dev `f61ae353`)*
  - Root cause: scope subquery referenced `i.series_title`, missing in `public_playlist_items` → whole query threw → catch returned zero rows whenever checked. Now uses `i.title + i.speaker + i.items_json` (covers series bundles) with fallback to title/desc baseline; verified additive (`muktzah` 0→1, `shabbos` 2→2).

---

## 🎯 Active Tasks: Playlists Enhancements Round 2 (Step-by-Step)
- [x] **Task 1: Rename "Later" to "Save for later" & Vertical Icon Centering** *(COMPLETED)*
  - Rename playlist pill and label from "Later" to "Save for later".
  - Ensure icon is centered height-wise with text across all playlist pills (`display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; line-height: 1.1;`).
- [x] **Task 2: Multi-Select Category Filter Cards in Playlist Search** *(COMPLETED)*
  - Support selecting multiple teachers, venues, and topics like Advanced Search.
  - Selected filters render as dismissible cards/chips with `✕` remove button and "Clear All" action.
- [x] **Task 3: Playlist Search Scope Checkboxes (Title & Tags, Description, Shiurim Therein)** *(COMPLETED)*
  - 3 checkboxes: "Title & Tags" (default checked), "Description" (default checked), and "Shiurim therein" (default unchecked).
  - When 3rd checkbox is checked, matches search queries against lectures inside playlists (`public_playlist_items`).
- [x] **Task 4: Playlist Reordering Experience Parity with Queue** *(COMPLETED)*
  - Provided direct, intuitive reordering of shiurim in playlists with grab handles (⠿) and ▲▼ move actions matching the queue.
  - Added disabled states on edge items, drag-over visuals, persisted via `saveDevStore`, handles queue parity review fixes (dual review 2026-09-11).
- [x] **Task 5: Shuffle Play Option for Playlists** *(COMPLETED)*
  - Add option to play playlist in sequential order (default) or randomized order via `🔀 Shuffle` button on playlists.
  - Fisher-Yates shuffle, non-mutating, uses queue system with cloud sync, disabled when <2 items, dual-reviewed 2026-09-11.
- [ ] **Task 6: Scope Checkbox Relabel** *(IN PROGRESS)*
  - Relabel scope checkboxes with prefix: "Playlist title and tags", "Playlist description", "The shiurim inside the playlists metadata".
- [ ] **Task 7: Typable Teacher/Topic/Venue Filters with Dropdown** *(PENDING)*
  - Make Teacher, Topic, Venue filters typable inputs with dropdown suggestions (no freeform beyond controlled vocab).
- [ ] **Task 8: Header Overflow — Settings in Dropdown vs Header** *(PENDING)*
  - If light/dark and calendar don't fit, move them into the settings dropdown (where light/dark already lives); show in header only when space allows.
- [x] **Task 6: Scope Checkbox Relabel** *(COMPLETED 2026-09-11)*
  - Relabeled scope checkboxes with prefix: "Playlist title and tags", "Playlist description", "Shiurim inside the playlists".
- [x] **Task 7: Typable Teacher/Topic/Venue Filters with Dropdown** *(COMPLETED 2026-09-11)*
  - Made Teacher, Topic, Venue filters typable inputs with datalist dropdowns (controlled vocab, no freeform).
- [x] **Task 8: Header Overflow — Settings in Dropdown vs Header** *(COMPLETED 2026-09-11)*
  - Header hides light/dark + calendar on mobile (≤640px) and shows them in the account dropdown; desktop shows them in header when space allows.
- [x] **Task 9: Polish & Dual Review Follow-ups** *(COMPLETED 2026-09-11)*
  - Fixed freeform tag bypass, all-unchecked scope guard, typable filter validation, and doc drift; 5/5 suites green.

---

## 📦 Previous Task: Complete Playlists Suite (Phases 1–5) — COMPLETED
- [x] Phase 1: Play Queue UX & Idempotent Modal Controls
- [x] Phase 2: Playlists Tab Restructuring & Sticky Controls
- [x] Phase 3: Playlist Sorting & Ordering Controls
- [x] Phase 4: Enhanced Playlist Creation Modal
- [x] Phase 5: Add-to-Playlist Multi-Select Popup Enhancements & Dual Review Hardening

---

## 🕒 Chronological Activity Log

### [2026-09-14 ET] — Public Playlist Publishing, Live-Sync, Deletion Cascade & Privacy Lifecycle
- `[DONE]` **Immediate Deletion of Orphaned Listing**: Purged orphaned record for deleted playlist "Amazing" (`LmSKGxr0liD02-f1`) directly from remote Cloudflare D1 (`yutorah-db`).
- `[DONE]` **Private Deletion Cascades to Public DB**: Updated `devDeletePlaylist()` so that if `pl.publicId` is present, it captures `pubId`, deletes local and tombstone references, and immediately issues a POST to `/api/playlists/unpublish` to permanently drop the entry from `public_playlists`, `public_playlist_items`, and `playlist_saves`. Invalidates `plPreviewCache` and `plMineCache`.
- `[DONE]` **Real-Time Content & Preview Synchronization**: Implemented `plSyncIfPublic(pl)` and integrated it into `devDoRemove()`, `devSetMembership()`, and `devReorderPlaylistItem()`. Any changes made by the owner immediately push the snapshot to `/api/playlists/publish` and invalidate preview caches.
- `[DONE]` **Zero-Item Snapshot Support**: Modified backend `/api/playlists/publish` to allow 0 items when updating an existing playlist (`pid` present), clearing the lecture list and setting `itemCount: 0`.
- `[DONE]` **Public Badge on Custom Pills & Detail Views**: Added `.playlist-pill.public-pill` and `🌍` indicator on pills in "My Playlists & Subscriptions", with active `🌍 Public` / `🔒 Private` tags in playlist detail view.
- `[DONE]` **Zero-Staleness Search Indexing**: Updated `/api/playlists/public` to `Cache-Control: no-cache, no-store, must-revalidate` so updates and unpublishing are reflected in public search without delay.
- `[DONE]` **Cloud Sync Merge State Integrity**: Updated `adoptCloudState()` to spread and preserve `existing` properties (`publicId`, `isPublic`, `tags`, `description`, `icon`) on cloud sync merges. Wired `plFetchMine()` / `plReconcileMineState()` into `bootAuth()` to restore public state automatically.
- `[DONE]` **Feature Documentation**: Documented §14 in `FEATURES.md` detailing the entire public playlist publishing, live-sync, deletion cascading, and privacy lifecycle.
- `[DONE]` **Automated Testing**: Added Test #25 to `tests/basic_functionality.test.mjs`. All 5 test suites (25/25 basic functionality tests) pass 100% green.

### [2026-09-14 ET] — Mobile Docking Clearance & Public Playlist Subscribe vs Copy Buttons
- `[DONE]` **Public Playlist Direct Actions**: Replaced the single save button with direct `📡 Subscribe` and `📋 Copy` buttons on public playlist cards.
- `[DONE]` **Interactive Info Circle Tooltips**: Added `ⓘ` button next to each action with floating explanation popovers:
  - Subscribe: *"Subscribing means that you're following this playlist. As the owner makes updates, you'll see those updates."*
  - Copy: *"Copy means that you're copying the playlist to then modify and make your own."*
  - Supports click dismissal, outside-click closing, and Escape key dismissal.
- `[DONE]` **Mobile Docking Clearance & Safe-Area Padding (<=375px)**:
  - Added `padding-bottom: env(safe-area-inset-bottom, 0px)` and `box-sizing: border-box` to `#miniPlayer`.
  - Added dynamic `--player-height` sync in `syncPlayerBottomPadding()`, bound to resize and mini-player visibility changes.
  - Sized container bottom offsets to guarantee that the last card, "Load More" button, and pagination controls are never obscured on compact viewports.
  - Added specific compact scaling rules for max-width 480px and 375px.
- `[DONE]` **Automated Testing**: Added Test #24 to `tests/basic_functionality.test.mjs`. All 5 test suites (24/24 basic functionality tests) pass 100% green.

### [2026-09-14 ET] — Motif Tap Guard + 7-Tap Dev Toggle + Install App + Badge Buffer (dual-reviewed, dev `c4fa1f53`, prod `f8bff5c3`)
- `[DONE]` **Full-width motif taps never shrink**: popover CSS scoped to `.icon-only.expanded` + toggle early-return; duplicate floating title glitch gone. Pre-roll stays 3 taps on the apple (title copy fixed 7→3).
- `[DONE]` **7-tap dev-mode toggle**: Hebrew date badge (+ menu calendar rows) count dev taps on a separate counter — 7 to enable, 7 to disable, symmetric toasts, 2s reset. Typed `dev mode` flow unchanged.
- `[DONE]` **📲 Install App menu item**: settings dropdown offers it only when `isPwaInstalled()` is false (standalone/IOS check); deferred prompt or iOS-aware manual hint; consistent ordering in both auth branches.
- `[DONE]` **Calendar 6px buffer** between 📅 and date text (both themes, all sizes).
- `[DONE]` **Review follow-ups fixed**: install placement symmetry, stale-menu close on toggle, comment accuracy, wide-path expanded cleanup, iPadOS-desktop-UA detect, unscoped-rule test coverage.
- `[DONE]` **Dual review**: PASS/PASS. All 5 suites green. Deployed dev + prod (200 OK, markers verified; plain-`/` edge cache noted — verify with cache-buster).
- `[DONE]` **Docs**: FEATURES.md §13 + TALKING_POINTS.md entries for all four items.
- `[DONE]` **Changelog**: `src/changelog.json` newest-first entry dated `2026-09-14T00:35:00-04:00`.

### [2026-09-14 ET] — Header Single-Flow + Permanent Deletes (dual-reviewed, dev `e706f730`, prod `3b8df141`)
- `[DONE]` **Single left-to-right header flow**: brand → login → zman → theme → support → date badge packed left (`flex-start`, no gap); login guaranteed; measurement-based sacrifice (badge → support → theme → motif apple → motif hidden) + highest-first refill + brand-ellipsis last resort; theme only when room allows (menu fallback); keyboard-accessible date badge.
- `[DONE]` **Permanent deletes**: history removes sync as explicit bounded tombstones (`deletedHistory`) with revive-on-relisten, ack-clearing, unload `keepalive` flush, and boot re-dirty retry; full-list replace rejected (would wipe truncated rows). Non-history deletes already synced.
- `[DONE]` **Dual review**: initial FAIL (brand pill scoping, tombstone-vs-replace design, priority order) → all fixed → re-review PASS/PASS. All 5 test suites green (new header-order + delete-stickiness regression tests).
- `[DONE]` **Docs**: FEATURES.md §13 (Sept batch in detail) + new TALKING_POINTS.md (top 5/10, new-vs-OG, parity, full list); roadmap checkboxes updated (accounts, queue, PWA shipped).
- `[DONE]` **Changelog**: `src/changelog.json` newest-first entries dated `2026-09-14`.
- `[NOTE]` Concurrent-agent collision: branch picked up sibling commit `6d15940` mid-session; verified full change set intact across `6d15940`+`885851d` (299 insertions, all markers + tests green).

### [2026-09-11 14:45 ET] — Header Theme Toggle: Logged-Out Access on Right-Hand Side
- `[DONE]` **DOM Header Restructuring**:
  - Reordered `.header-right`: `support-yutorah-btn` -> `hebrewDateBadge` -> `authBtn` -> `authMenu` -> `themeToggleBtn`.
  - Added CSS `order: 10` to `.header-right #themeToggleBtn` to ensure it sits on the far right-hand side.
- `[DONE]` **Mobile Accessibility & Logged-Out Visibility**:
  - `body:not(.is-logged-in) #themeToggleBtn { display: inline-flex !important; }` guarantees the theme toggle remains visible in the header on screens ≤640px for guest / non-logged-in users.
  - `body.is-logged-in #themeToggleBtn, .auth-btn.logged-in ~ #themeToggleBtn { display: none !important; }` hides the header button on mobile for authenticated users who have the `⚙️` settings gear dropdown.
  - Added `min-width: 32px; min-height: 32px; padding: 2px 4px;` for comfortable touch target accessibility across mobile and touch devices.
- `[DONE]` **Client State Synchronization**:
  - `renderAuthBtn()` synchronizes `is-logged-in` class on `document.body`.
  - `initTheme()` and `toggleTheme()` dynamically update `aria-label` alongside `title`.
  - `checkCalendarOverflow()` returns early on screens ≤640px to prevent inline style overrides on mobile.
- `[DONE]` **Automated Testing & Dual Review**:
  - Test #20 (`testLoggedOutHeaderThemeToggle`) added to `tests/basic_functionality.test.mjs`. All 5 test suites pass 100% green (20/20 checks).
  - Dual Review completed: Correctness QA (**PASS**, 0 Blockers) and Style & Theme (**PASS**, 0 Blockers).

### [2026-09-11 14:30 ET] — PRODUCTION DEPLOYMENT (`df656c57`) & Dual Review Hardening
- `[DONE]` **Production Deployment**:
  - Deployed full feature suite to **PRODUCTION** (`https://yutorah-player.mrosensweig.workers.dev`, Version ID: `df656c57-572b-4175-bb1c-1adafe3a6f4c`).
  - Verified remote Cloudflare D1 migrations up-to-date (`yutorah-db`).
  - Smoke tests verified 100% green across homepage, playlists view, and individual shiur endpoints (all HTTP 200).
- `[DONE]` **Dual Review Hardening & Remediation**:
  - **WCAG 1.4.4 (Resize Text)**: Removed `maximum-scale=1.0, user-scalable=no` from `<meta name="viewport">` to allow fluid mobile pinch-to-zoom.
  - **WCAG 2.4.7 (Focus Visible)**: Eliminated blanket `outline: none !important;` on buttons and added explicit `:focus-visible` rings (`2px solid var(--primary-light)`) to media transport controls (`#playBtn`, `.ctrl-btn`, `.mini-play-btn`, `.mini-btn.skip-btn`, `.playlist-reorder-btn`, and `#scrubberBar`).
  - **WCAG 2.1.1 & 4.1.2 (Scrubber Slider)**: Added `role="slider"`, `tabindex="0"`, `aria-label="Seek time"`, dynamic `aria-valuenow`, `aria-valuetext`, and Arrow key seek handlers (`Left`/`Right` ±5s, `PageUp`/`PageDown` ±30s, `Home`/`End`).
  - **Theme FOUT Elimination**: Server defaults `themeMode = 'dark'` and renders `☀️` on `#themeToggleBtn` on initial HTML render so dark-mode first-time users experience zero theme or icon flash.
  - **Shared Public Playlist Deep-Linking**: Upgraded `/api/playlists/items` to return playlist metadata (`title`, `description`, `icon`, `tags`, `ownerName`) alongside `items`. Implemented `devLoadSharedPublicPlaylist(pid)` to dynamically fetch and render third-party public playlists on deep links.
  - **Share Actions**: Added `📋 Share` button on playlist headers and `📋 Share Search` button on the public playlist browser with clipboard copying and toast confirmations.
  - **Shuffle Parity**: Enforced `items.length < 2` disabled state on custom and subscribed playlists.
  - **Touch Targets**: Enlarged `.playlist-reorder-btn`, `.token-remove-btn`, and `.active-filter-pill button` touch dimensions, with 16px input font sizing on mobile to prevent iOS Safari auto-zoom.
- `[DONE]` **Automated Testing**: Added Test #19 (`testDualReviewAccessibilityAndSharingRemediation`) to `tests/basic_functionality.test.mjs`. All 5 test suites passed 100% green (19/19 basic functionality checks).
- `[DONE]` **Git Sync**: Both `feat/auth-d1` and `main` branches fast-forwarded and pushed to GitHub.

### [2026-09-11 13:45 ET] — Commit `feat/auth-d1` (Batch 2: Shareable Playlist URLs + Dark Default)
- `[DONE]` **Shareable Playlist URLs**: URL parameters (`tab=playlists`, `pl`, `plq`, `plteachers`, `plvenues`, `pltopics`, `plscope`, `plsort`), `replaceState` sync, boot hydration (`hydrateFromUrl`), `popstate` listener.
- `[DONE]` **Dark Mode Default**: Pre-paint head script defaults to dark when no user preference is stored.
- `[DONE]` **Dev Worker Deployment**: Deployed to `https://yutorah-player-dev.mrosensweig.workers.dev` (Version `b5a428ea`).
- `[DONE]` **Task 4 Parity Fixes**: Added disabled states on queue ▲▼, drag-over visuals, persisted parity; queue parity now matches playlist.
- `[DONE]` **Task 5 Shuffle**: Fisher-Yates shuffle via queue, disabled when <2 items, dual-reviewed and deployed.
- `[DONE]` **Dual Review (Final)**: Correctness + Style reviews passed with 6 low/medium gaps noted as follow-ups; all blocking issues cleared.

### [2026-09-11 10:46 ET] — Commit `feat/auth-d1` (Task 3: Playlist Search Scope Checkboxes)
- `[DONE]` **Tri-Checkbox Search Scope (Title & Tags, Description, Shiurim Therein)**:
  - Added checkboxes row: `Title & Tags` (checked by default), `Description` (checked by default), and `Shiurim therein` (unchecked by default).
  - Wired live change listeners persisting `plPublicScope` and immediately updating search results.
- `[DONE]` **Database Subquery Aggregation for Shiurim Therein**:
  - In `/api/playlists/public`, when `scopeShiurim=1`, SQL aggregates playlist lecture titles, speakers, and series titles via `GROUP_CONCAT`.
  - Filter logic includes `itemsText` in search text search when `scopeShiurim` is active.
- `[DONE]` **Automated Testing**: 100% green on all 5 test suites (17/17 basic functionality checks).

### [2026-09-11 10:44 ET] — Commit `feat/auth-d1` (Task 2: Multi-Select Category Filter Cards in Playlist Search)
- `[DONE]` **Multi-Select Filter Tags**:
  - Implemented `plPublicFilterTags` state tracking arrays for `teachers`, `venues`, and `topics`.
  - Added `plAddFilterTag(kind, tag)`, `plRemoveFilterTag(kind, idx)`, and `plClearAllFilterTags()`.
  - Updated `tagOpts(kind)` to exclude already-selected items and prompt `+ Add [Teacher/Venue/Topic]…`.
  - Selecting a filter immediately resets the dropdown and renders an active filter card chip.
- `[DONE]` **Active Filters Card Bar**:
  - Rendered `.active-filters-bar` displaying dismissible `.active-filter-pill` chips with category icons (`👤`, `📍`, `🏷️`), name, and `✕` removal button.
  - Added `Clear All` reset button.
- `[DONE]` **Backend Query Param Handling**:
  - `/api/playlists/public` accepts repeated or comma-separated `teachers`, `venues`, `topics`.
  - `matchTags()` filters playlists matching selected entities with category AND logic and multi-entity OR matching.
- `[DONE]` **Automated Testing**: 100% green on all 5 test suites (17/17 basic functionality checks).

### [2026-09-11 10:40 ET] — Commit `feat/auth-d1` (Task 1: Rename Later to Save for later & Center Icons)
- `[DONE]` **Rename Later to "Save for later"**:
  - Updated playlist system row pill label to `Save for later (N)` and empty state message to `tap 🕒 Save for later`.
- `[DONE]` **Vertical Icon Centering**:
  - Updated `.playlist-pill` with `display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; line-height: 1.1;`.
  - Added `.playlist-pill svg { vertical-align: middle; display: inline-block; flex-shrink: 0; }` and updated `devClockSvg` styles.
- `[DONE]` **Automated Testing**: 100% green on all 5 test suites.

### [2026-09-11 10:30 ET] — Commit `feat/auth-d1` (Dual Review Polish: Contrast, Focus, Drag-End & A11y)
- `[DONE]` **Contrast Compliance**:
  - Dark mode `.playlist-seg-btn.active` adjusted to `#1e2c40` with `#7ca5de` text for full WCAG AA compliance.
  - Light mode `.pl-tick-add` darkened to `#15803d` (4.56:1 contrast ratio, WCAG AA compliant).
  - Dark mode `.pl-save-changes-btn` styled with `#2563eb` and `#3b82f6` border.
  - Public subscribed badge given `.playlist-sub-badge` with theme-aware `#7dd3fc` color in dark mode.
- `[DONE]` **Drag & Drop Abort Safety**:
  - Implemented `devDragEnd(event)` and bound `ondragend` on `.playlist-item-wrap` to immediately reset opacity and clear `.dragging` / `.drag-over` if drag is cancelled mid-air.
- `[DONE]` **Accessibility & Keyboard Focus**:
  - Added `role="alert"` and `aria-live="polite"` to `#newPlError`.
  - Added `aria-label="Close dialog"` to `#newPlClose`.
  - Added `aria-label="Select [emoji] icon"` and `aria-pressed="true/false"` to the 16 emoji picker buttons.
  - Added `:focus-visible` outline rings to segmented buttons, playlist pills, and emoji options.
  - Checkbox toggle in Add-to-Playlist modal retains DOM focus on the toggled item across list redrawing.
  - Added duplicate name guard to the inline quick-create handler in the Add-to-Playlist modal.
- `[DONE]` **Mobile Header Alignment**:
  - Anchored `.playlist-system-row` to `top: 38px !important;` on screens <= 640px to eliminate the 14px gap beneath the compact mobile header.

### [2026-09-11 10:25 ET] — Commit `feat/auth-d1` (Phase 5: Staged Add-to-Playlist, Live Counter Ticks & Author Guard)
- `[DONE]` **Staged State Management & Explicit Save Changes**:
  - `openPlaylistModal(id)` now records `initialStates` and stages user checkbox adjustments cleanly in `stagedStates`.
  - Added dedicated footer with `Cancel` button (discards pending changes) and `💾 Save Changes (N)` commitment button (`.pl-save-changes-btn`) that applies mutations via `devSetMembership` in one cohesive atomic pass.
- `[DONE]` **Live Counter Tick (+1 / -1)**:
  - Dynamically recalculates live playlist item count in modal rows.
  - Renders vibrant green `(+1)` badge (`.pl-tick-add`) when checking an unincluded playlist and red `(-1)` badge (`.pl-tick-del`) when unchecking an included playlist.
- `[DONE]` **Self-Saving Author Guard on Public Playlists**:
  - Implemented `devIsAuthoredByCurrentUser(p)` and `devGetAuthoredCustomId(p)`.
  - In `renderPlPublicInto()`, playlists authored by the current user display a prominent `👤 Your Playlist` badge and `🎧 Open in My Playlists` action, while cleanly suppressing redundant "Save to my playlists" and "Remove save ♥" buttons.
- `[DONE]` **Automated Testing**: Updated `tests/basic_functionality.test.mjs` with Test #16. All 5 test suites passed 100% green.

### [2026-09-11 10:22 ET] — Commit `feat/auth-d1` (Phase 4: Enhanced Playlist Creation Modal with Emoji Picker, Tags & Duplicate Validation)
- `[DONE]` **Emoji / Icon Picker**:
  - Added interactive grid of 16 emojis (`📁`, `🎧`, `📚`, `🕯️`, `📜`, `⭐`, `💎`, `🕊️`, `🕍`, `📖`, `🎙️`, `🧠`, `✨`, `🔥`, `🎓`, `🏷️`) with `.selected` outline highlighting and dynamic live icon preview in modal header.
- `[DONE]` **Duplicate Name Prevention**:
  - Implemented `devIsDuplicatePlaylistName(name, excludeId)` checking case-insensitively against user's custom playlists and reserved system list names.
  - Inline error feedback renders in `#newPlError` and prevents form submission until a unique name is entered.
- `[DONE]` **Curated Taxonomy Tagging (Max 5)**:
  - Added live typeahead tag search across teachers, venues, and topics via `plTagOptions`.
  - Enforced strict 5-tag ceiling with dynamic badge counter and chip dismissal.
- `[DONE]` **Rich Metadata Storage**:
  - Upgraded `devCreatePlaylist(name, icon, desc, tags)` to store icon, multiline description, and taxonomy tags into `store.custom[id]`.
- `[DONE]` **Automated Testing**: Updated `tests/basic_functionality.test.mjs` with Phase 4 assertions. All 5 test suites passed 100% green.

### [2026-09-11 10:20 ET] — Commit `feat/auth-d1` (Phase 3: Playlist Sorting & Ordering Controls + Drag-and-Drop)
- `[DONE]` **Multi-Criteria Playlist Sorting**:
  - Implemented `devGetPlaylistSort`, `devSetPlaylistSort`, and `devItemDateTimestamp` supporting `listened`, `added`, `date_desc` (newest first), and `date_asc` (oldest first).
  - Preserved backward-compatible `setHistorySort` wrapper for legacy callers.
- `[DONE]` **Manual Reordering & Drag-and-Drop**:
  - Enabled `Manual / Drag-and-Drop` mode on custom user playlists.
  - Added desktop and touch-friendly `▲` (Move Up) and `▼` (Move Down) buttons next to remove action on each playlist item.
  - Implemented native HTML5 drag-and-drop (`devDragStart`, `devDragOver`, `devDragLeave`, `devDropItem`) with grab handles (`⠿`) and visual drop indicator styling (`.playlist-item-wrap.drag-over`, `.playlist-item-wrap.dragging`).
  - Reordering persists via `devReorderPlaylistItem` and automatically syncs to store and cloud.
- `[DONE]` **Automated Testing**: Updated `tests/basic_functionality.test.mjs` with Phase 3 assertions. All 5 test suites passed 100% green.

### [2026-09-11 10:18 ET] — Commit `feat/auth-d1` (Phase 2: Playlists Tab Restructuring & Sticky Controls)
- `[DONE]` **Segmented Top Control Bar**:
  - Implemented `.playlist-segmented-bar` with `🎧 My Playlists` and `🌍 Public Playlists` buttons switching between views via `devSwitchPlaylistSubView(sub)`.
  - Replaced legacy inline `📁 Mine` and `🌍 Public` pills with modern segmented control.
- `[DONE]` **Sticky Frozen Top Row for System Lists & Actions**:
  - Partitioned playlist navigation into `.playlist-system-row` (anchored with `position: sticky; top: 52px; z-index: 10; background: var(--bg);`) containing `🕒 History`, `Later`, `⭐ Favorites`, `📋 Queue`, and `➕ New Playlist`.
  - Dedicated `.playlist-custom-row` displays user custom playlists and live subscriptions with clear section caption.
- `[DONE]` **Subscribed / Read-Only Visual Highlighting**:
  - Implemented `devIsSubscribedToPublicId`, `devGetSubscribedCustomId`, and `devOpenSubscribedPlaylist`.
  - Public playlists that the user is subscribed to receive `.playlist-subscribed-card` with glowing sky-blue border, `📡 Subscribed` pill badge, and `🎧 Open in My Playlists` button.
  - Subscribed playlists in custom row display `.playlist-pill.subscription-pill` styling.
- `[DONE]` **Automated Testing**: Updated `tests/basic_functionality.test.mjs` with Phase 2 assertions. All 5 test suites passed 100% green.

### [2026-09-11 10:12 ET] — Commit `feat/auth-d1` (Play Queue UX: Idempotent Single-Click Close & Circular Icon Prompt)
- `[DONE]` **Idempotent Single-Click Close**:
  - Replaced ambiguous toggle with `closeQueuePopup()` and `openQueuePopup()`.
  - Close button `✕` on `#queuePopup` now directly invokes `closeQueuePopup(); event.stopPropagation();` which unconditionally hides `#queuePopup` on the very first click regardless of how many times "Open Play Queue" was clicked.
  - `devOpenQueueView()` idempotently calls `openQueuePopup()`.
  - Outside click listener closes `#queuePopup` when clicking anywhere outside without interfering with queue trigger buttons.
- `[DONE]` **Empty Queue Circular Icon Alignment**:
  - Replaced stale `⏭ Queue` prompt with the exact circular queue icon (`devQueueIconSvg()`) used across all shiur cards.
- `[DONE]` **Automated Testing**: Updated `testDropdownNavAndThemeAesthetics` in `tests/basic_functionality.test.mjs`. All 5 test suites passed 100% green.

### [2026-09-10 23:55 ET] — Commit `feat/auth-d1` (Public Playlist Save Choice: Subscribe Live Sync vs Editable Copy + D1 Backup Guide)
- `[DONE]` **Public Playlist Save Choice Modal**:
  - When clicking `💾 Save to my playlists` on any public playlist, users are presented with a clean choice modal:
    1. **📡 Subscribe / Follow (Live Sync)**: Adds the playlist to their collection as a read-only live subscription. It automatically stays in sync whenever the author adds, removes, or modifies shiurim. Item removal is locked to maintain author integrity. Includes dedicated `🔄 Check for Updates` and `📋 Make Editable Copy` buttons.
    2. **📋 Make an Editable Copy**: Creates an independent clone in "My Playlists" that the user owns and can freely edit, rename, and add or remove shiurim from.
- `[DONE]` **Live Sync & Subscription Management**:
  - Implemented `devSyncSubscribedPlaylist(pid, notify)` which pulls the latest items from `/api/playlists/items?id=${publicId}` and updates the playlist. Auto-sync triggers in the background when viewed (30s cache TTL).
  - Added `devCloneSubscriptionToCopy(pid)` to easily convert any followed playlist into an independent editable copy.
  - Added `devUnfollowPlaylist(pid)` to unfollow and remove the subscription cleanly with confirmation.
- `[DONE]` **D1 Database Backup & Disaster Recovery Documentation**:
  - Created [docs/BACKUP_AND_RESTORE.md](file:///Users/mosherosensweig/git/yutorah_player/docs/BACKUP_AND_RESTORE.md) detailing:
    - Overview of stored data (`users`, `listening_history`, `playlist_items`, `public_playlists`, `playlist_saves`).
    - Single-command manual export ("For Dummies" step-by-step).
    - Disaster recovery restoration instructions.
    - 100% free automated GitHub Actions cron workflow running weekly database exports with artifact retention.
- `[DONE]` **Automated Testing**: Added Test #12 (`testPublicPlaylistSubscriptionOptions`) to `tests/basic_functionality.test.mjs`. All 5 test suites passed 100% green.

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
2. **Dual Review**: Correctness QA and Style/Theme subagents must review and approve every release before deployment. See *How to do a dual review and deploy* below.
3. **Separate Commits**: Maintain atomic commits per feature branch.
4. **DEV ONLY**: Deploy strictly to `yutorah-player-dev.mrosensweig.workers.dev` via `npx wrangler deploy --env dev`. **NEVER** touch production without explicit user command.
5. **Changelog**: Update `src/changelog.json` on every push.

### How to do a dual review and deploy (robust, step-by-step)
1. **Finish one task at a time** — scope is a single feature or fix batch; no bundling of unrelated changes.
2. **Local verify**: `npm test` (must be 5/5 green) + `node --check src/worker.js`.
3. **Launch two subagents in parallel** via Task tool:
   - **Correctness reviewer**: prompt to check logic, edge cases, state, persistence, quota, XSS, bounds. Must cite `file:line`.
   - **Style/Theme reviewer**: prompt to check UX, light/dark, touch targets, focus rings, a11y, contrast. Must cite `file:line`.
4. **Triage**: BLOCKER/HIGH must be fixed before deploy; LOW/MEDIUM may be logged as follow-ups.
5. **Fix, re-test, re-review if needed** — iterate until both reviewers PASS or only LOWs remain.
6. **Commit & push**: `git add -A && git commit -m "... (muse spark)" && git push origin <branch>`.
7. **Deploy to dev only**: `npx wrangler deploy --env dev` → verify `Current Version ID` and `curl -s -o /dev/null -w "%{http_code}" https://yutorah-player-dev...` is 200.
8. **Update logs**: append to `CURRENTLY_WORKING_ON.md` activity log and `src/changelog.json` newest-first entry with ISO date.
9. **Final dual review**: after the last task in the batch, run one concluding dual review across the whole batch to catch integration gaps.
