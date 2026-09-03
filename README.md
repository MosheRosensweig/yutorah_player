# 🎧 YUTorah Player — Cloudflare Worker Reverse Proxy

A zero-friction wrapper around YUTorah hosted as a **free Cloudflare Worker**.

It serves the live YUTorah site under your own URL, removes frame and CORS restrictions, and injects an **Enhanced Audio Player** with tabs:

- **[ 🎧 Enhanced Player ]** (Active by default) — Skip ±10s/±30s, direct speed dropdown (0.5x–3.0x), timestamp links (`?t=120`), scrubber, and mobile lock-screen controls.
- **[ 📻 Standard Player ]** — Switch back to YUTorah's original player at any time.

---

## Features

- **No Bookmarklets or Copy-Pasting Required:** Just visit your URL on your phone or computer.
- **Tabs on every shiur page:** Toggle between the Enhanced Player and the original Standard Player seamlessly.
- **Skip Back / Forward:** Dedicated buttons for **−30s**, **−10s**, **+10s**, **+30s**.
- **Direct Speed Menu:** Instantly choose 0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x, 3x without cycling through.
- **Timestamp Sharing:** Click "📋 Copy Link @ Time" to get a shareable URL that starts at that exact second (e.g., `https://your-worker.dev/lectures/1187082?t=245`).
- **Mobile Lock Screen & Background Play:** Full `MediaSession` integration with title, speaker, artwork, and lock-screen skip controls.
- **Keyboard Shortcuts:** `Space` (play/pause), `←`/`→` (±10s), `Shift`+`←`/`→` (±30s), `[`/`]` (speed), `M` (mute).

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
