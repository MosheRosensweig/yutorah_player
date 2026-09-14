# YUTorah Enhanced Player — Talking Points

**One-liner**: The entire YUTorah library of 440,000+ Torah lectures, rebuilt as a fast modern listening app — uninterrupted playback, smart search that understands how people actually type names, personal playlists that sync across devices, and one-tap sharing.
**Live**: [https://yutorah-player.mrosensweig.workers.dev/](https://yutorah-player.mrosensweig.workers.dev/) · Details: [FEATURES.md](FEATURES.md)

---

## ⭐ Top 5 Features

1. **Uninterrupted listening (mini-player)** — Audio keeps playing while you browse, search, and read; the player docks into a sticky bottom bar and follows you across the whole site, with lock-screen controls on phone.
2. **Search that understands names** — Phonetic + Hebrew/reverse-transliteration matching (`rosensweig` ↔ `רוזנצוויג`), acronym expansion (`yije`), typo-tolerant Did-You-Mean, and multi-facet filters (teacher, venue, topic, duration, date).
3. **Playlists + queue that sync everywhere** — History, Save-for-Later, Favorites, custom playlists, and a reorderable play queue backed by Google login and cloud sync; deletes actually stick.
4. **Shareable everything** — Every shiur link carries an exact timestamp (`?t=`), every playlist search carries its filters, and Copy-Link-@-Time makes passing a vort around a one-tap affair.
5. **Installable app experience** — PWA with offline-tolerant shell, dark mode by default, keyboard shortcuts, variable speed, and per-shiur progress that resumes where you left off.

---

## 🔟 Top 10 Features (6–10)

6. **Article & PDF reader (Liquid Mode)** — Attached source sheets and articles reflow into clean multi-column reading with drop caps, Hebrew/English typesetting, and footnote popovers, without stopping audio.
7. **Daily study hub** — Parsha, Daf Yomi, Mishna/Nach Yomi, and the Hebrew date up front, plus seasonal holiday themes (e.g. Rosh Hashanah 🍎) right in the header.
8. **Public playlists + live subscriptions** — Publish reading lists, browse the community's, and follow lists that stay in sync when the author updates them.
9. **Hero slideshow discovery** — Rotating spotlight of the catalog with dots, swipe, and deep links into shiurim and searches.
10. **Zero-friction + fast** — No login required to listen; SSR direct links with rich WhatsApp/iMessage previews; global edge hosting with audio failover between CDNs.

---

## 🆕 New vs. YUTorah.org (only in the Enhanced Player)

- Persistent mini-player with uninterrupted background playback across pages.
- Phone lock-screen / notification controls with rabbi artwork (MediaSession).
- Variable playback speed (0.5x–3.0x), synced in the URL; ±10s/±30s skip; 60fps scrubber.
- URL timestamp deep-linking (`?t=`) + Copy Link @ Time.
- Phonetic / reverse-transliteration / acronym search with Did-You-Mean.
- Advanced multi-facet filters (teachers, venues, topics, durations, minute-precision dates) with pills.
- Recent-results rail + Relevance/Newest/Oldest sorts + quick date chips.
- Personal library: History, Save-for-Later, Favorites, custom playlists, play queue — cloud-synced via Google login.
- Public playlist publishing, browsing with live filters, and live-sync subscriptions.
- Shareable playlist-search URLs (query + pills + scope + sort in the link).
- Progress tracking, completion states, and resume-everywhere.
- Dark mode (default for new users), keyboard shortcuts, Cards/Rows views.
- Installable PWA with offline-tolerant shell.
- Article Liquid Mode reader with footnotes; source-sheet viewing without stopping audio.
- Seasonal holiday themes + zman badge; adaptive header that packs icons by available space.
- In-app Install option (settings menu, hidden once installed) with deferred browser prompt.
- 7-tap dev-mode toggle on the date badge; full-width holiday taps never shrink the badge.
- Clickable metadata chips that filter without interrupting playback; collapsible speaker bios.
- Autoplay-next queue, Queue-to-Top for whole playlists, series expand/collapse.
- Sponsorship pre-roll audio with countdown + skip; bolded dedication banner.

---

## 🤝 Feature Parity (everything from YUTorah.org, preserved)

- The full 440,000+ lecture catalog, same content and metadata.
- Text search across the library (Solr-backed).
- Browsing by speaker/teacher, venue, topic/category, and series.
- Per-shiur pages: title, speaker, date, venue, description, duration.
- Streaming audio playback + direct MP3 download links.
- Daily learning content: Parsha, Daf Yomi, Mishna/Nach Yomi.
- Hebrew dates and holiday-season relevance (dedications, sponsorships).
- Lecture descriptions and speaker-assigned keyword tags.
- YUTorah sponsorship dedications (`l'ilui nishmas…`) and GiveCampus support links.

---

## 📋 Full Feature List

- **Zero-install web app** — Runs in any browser on desktop, tablet, and mobile; nothing to download.
- **SSR direct links** — Every shiur has a clean `…/⟨id⟩` URL that arrives pre-rendered with title, speaker, and metadata.
- **Rich link previews** — Shared links unfurl with shiur title + rabbi portrait on WhatsApp/iMessage/Slack.
- **Collection tabs** — Editor's Picks, Recently Uploaded, Most Popular, Daily Shiurim, Parsha, Trending, and more, no reload to switch.
- **Daily study banner** — Parsha, Daf Yomi, Mishna/Nach Yomi, and today's Hebrew date.
- **Live debounced search** — Results as you type (300ms), Enter/button to search, ID-or-URL paste to play instantly.
- **Quick date chips** — All Dates / Today / Yesterday / This Week / This Month, URL-persisted.
- **Sort chips** — Relevance / Newest / Oldest with true server ordering.
- **Advanced filters modal** — Teachers, venues, topics, durations, minute-precision date ranges.
- **Phonetic name search** — Matches Ashkenazic/Sephardic variants, honorifics stripped.
- **Reverse transliteration** — English ↔ Hebrew name matching both directions.
- **Acronym expansion** — e.g. `yije` → Young Israel of Jamaica Estates.
- **Did-You-Mean** — Typo-tolerant suggestion strip on thin result sets.
- **Recent-results rail** — 3 freshest matches above the 30-result relevance list.
- **Clickable metadata chips** — Speaker/venue/topic chips filter instantly without stopping audio.
- **Speaker bios + venue blurbs** — Collapsible Read More/Show Less descriptions.
- **Speaker pages** — Most Recent 6, Top Lectures 10, then full archive, frozen across Load-More.
- **Mini-player** — Sticky bottom bar (seekline, artwork, time, ±10s, play/pause, expand, close) that never stops your audio.
- **Full player card** — 68px play control, speed menu, scrubber, download, description, share.
- **Playback speeds** — 9 presets 0.5x–3.0x, persisted and URL-synced.
- **Snappy scrubber** — 60fps drag with enlarged hit zone, no scroll interference.
- **Stream failover** — Auto-switches CDNs on network hiccups.
- **MP3 download** — One-tap full-file download per shiur.
- **Timestamp URLs** — `?t=` updates live (throttled), restores position on reopen, backed by localStorage.
- **Copy Link @ Time** — Timestamped share link with animated confirmation.
- **MediaSession lock-screen** — OS controls + artwork on iOS/Android/desktop.
- **Keyboard shortcuts** — Space, arrows (±10s), Shift+arrows (±30s), brackets (speed), M (mute).
- **Dark mode** — Default for new users, zero-flash load, persisted choice, URL override.
- **Holiday themes** — Auto Hebrew-calendar themes with header zman badge + tagline bar.
- **Adaptive header** — Brand → login → zman → theme → support → date packed left by measured space; login always guaranteed.
- **Hero slideshow** — Autoplay spotlight with dots/arrows/swipe/keyboard and deep links.
- **Cards/Rows toggle** — Desktop rows, mobile cards, persisted.
- **Series expanders** — "View N more" drawers that collapse back.
- **Recommendations** — More-from-speaker and more-in-category strips.
- **Sponsorship banner + pre-roll** — Daily dedication with synced sponsor audio, countdown, and skip.
- **Google login + cloud sync** — PKCE OAuth with return-to-URL; history, playlists, queue sync oldest-first-safe.
- **History** — Auto-logged listens, Last-Listened/Shiur-Date sorts, tombstone deletes that stick.
- **Save-for-Later + Favorites** — One-tap card pills with icon picker, synced everywhere.
- **Custom playlists** — Emoji icons, descriptions, taxonomy tags, duplicate-name guard, JSON export, Play All/Shuffle.
- **Play queue** — Queue singles or whole series, drag/▲▼ reorder, autoplay-next, clear-with-confirm, Queue-to-Top.
- **Public playlists** — Publish, browse with live Teacher/Venue/Topic dropdowns + scope checkboxes, preview with durations, save or live-subscribe.
- **Shareable playlist links** — Filters, query, scope, sort, and active list encoded in the URL.
- **Daf Yomi hub (/daf)** — Tractate/folio picker, calendar nav over the exact 2,711-day cycle, tap-to-zoom daf viewer, bilingual text, shiurim links.
- **Source sheets on audio** — Attached handouts open in Liquid Mode without pausing; multi-sheet chooser.
- **Install App menu item** — Settings offers install only when not installed.
- **Progress + completion** — Per-shiur position heartbeat, resume prompts, completion states.
- **PWA install** — Manifest + Service Worker (offline shell; audio/API bypass cache), authentic centered shield icons.
- **Install App menu item** — Settings dropdown offers install only when not installed; deferred prompt or manual hint.
- **Secret gestures** — 7 taps on the date badge toggles Dev Mode; 10 taps on the holiday apple toggles pre-roll; full-width taps never shrink.
- **Article reader** — Liquid Mode reflow, drop caps, footnotes, source sheets without pausing audio.
- **Change Log** — In-app newest-first list of every shipped change.
- **Edge performance** — Cloudflare Workers global edge, 5-min collection cache, CORS-safe APIs.
