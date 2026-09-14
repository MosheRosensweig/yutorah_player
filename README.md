# 🎧 YUTorah Player — Cloudflare Worker Reverse Proxy & PWA
**Major Production Checkpoint (v1.0.0-perfect-checkpoint)**

A zero-friction, ultra-fast progressive web app (PWA) and edge proxy around YUTorah hosted as a **Cloudflare Worker**.

It serves the live YUTorah site under your own URL with zero frame or CORS restrictions, offering full offline caching, edge-accelerated Solr search, cloud sync with Google OAuth, rich playlist management, and an **Enhanced Audio & Article Player**.

---

## Key Features

- **Progressive Web App (PWA):** Installs seamlessly on iOS and Android with authentic Yeshiva University shield icons, maskable launcher compliance (zero Chrome badge overlays), and background offline shell caching.
- **Enhanced Audio Transport:** Skip ±10s/±30s buttons flanking Play/Pause, direct speed menu (0.5x–3.0x), continuous playback queue, lock-screen `MediaSession` integration with speaker artwork, and audio timestamp sharing (`?t=120`).
- **Comprehensive Playlists Suite:**
  - Pinned system lists: `History`, `Save for Later`, `Favorites`, `Play Queue`, and `+ New Playlist`.
  - Staged `Add to Playlist` multi-select popup with live counter ticks (`+1` / `-1`) and explicit commit.
  - Multi-criteria playlist sorting (`Date Added`, `Shiur Date Newest/Oldest`, `Last Listened`, and `Manual / Drag-and-Drop`).
  - Public playlist sharing, taxonomy filtering, preview modal with duration and upload date, and live-sync subscription vs editable copy choices.
- **User Accounts & Cloud Sync:** Native Google OAuth 2.0 with PKCE and Cloudflare D1 (Serverless SQLite) storage for cross-device listening history, saved positions, and custom playlists.
- **Phonetic & Hebrew-English Search:** Algorithmic reverse transliteration (Ashkenazic & Sephardic spelling normalization, honorific stripping, synset expansion) and fuzzy suggest typeahead.
- **Adaptive Theming:** Default dark mode for new users with seamless light/dark toggle, zero-flash pre-paint script, and responsive header overflow protection.
- **Article Reader & Liquid Mode:** Interactive document reader with streaming PDF proxy, multi-column reconstruction, and font scaling.

---

## Quick Start & Local Testing


1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run locally:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:8787` in your browser. You will see the live YUTorah homepage! Click any shiur to see the enhanced player tab in action.

---

## Deploying to Cloudflare (Free)

### Method A: Via Command Line (Recommended)

1. Log in to your Cloudflare account from the terminal:
   ```bash
   npx wrangler login
   ```
2. Deploy:
   ```bash
   npm run deploy
   ```
3. Cloudflare will output your live URL (e.g. `https://yutorah-player.<your-subdomain>.workers.dev`). Open it on your phone or laptop!

---

### Method B: Via Cloudflare Web Dashboard (No CLI needed)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and log in (free account).
2. Click **Compute (Workers & Pages)** → **Create** → **Create Worker**.
3. Name it `yutorah-player` and click **Deploy**.
4. Click **Edit code**.
5. Replace everything in the editor with the contents of [`src/worker.js`](src/worker.js).
6. Click **Deploy**!
7. Your live URL will be ready immediately.

---

## 🗺️ Product Roadmap

Check out [`ROADMAP.md`](ROADMAP.md) for planned features and architecture, including:
- **User Accounts & Persistent Login**: Stay logged in for as long as possible with persistent sessions.
- **Listening History & Progress Tracking**: Automatically record listened shiurim, timestamp progress ("where you are up to"), and organize by date.

