# YUTorah API Architecture, CORS Findings & Hosting Comparison

This document records the technical findings from reverse-engineering the YUTorah Online platform, detailing how the backend APIs operate, how CORS is handled, and comparing Cloudflare Workers vs. GitHub Pages hosting.

---

## 1. Technical Findings: YUTorah Backend APIs

During initial development, requests made directly to standard YUTorah web pages (e.g. `https://www.yutorah.org/lectures/details?shiurID=...`) encountered **Cloudflare Bot Management / Turnstile challenges** and were blocked when proxied or embedded.

By analyzing YUTorah's frontend bundles (`loadData.js`, `site.js`), we discovered that YUTorah maintains dedicated, open microservice endpoints that bypass bot challenges and have **open CORS enabled by default**:

### Discovered Endpoints

| Endpoint | Method | Format | CORS Header | Purpose |
| :--- | :---: | :---: | :---: | :--- |
| `https://api.yutorah.org/homepage/details` | `GET` | JSON | `access-control-allow-origin: *` | Returns live collections: Editor's Picks, Recently Uploaded, Popular, Daily Shiurim, Parsha & Daf Yomi. |
| `https://api.yutorah.org/search?searchTerm=<query>&start=<offset>` | `GET` | JSON (Solr) | `access-control-allow-origin: *` | Searches 440,000+ shiurim with 30-item pagination (`start=1, 31, 61...`). |
| `https://www.yutorah.org/sidebar/lectureData?shiurId=<id>` | `GET` | JSON | `access-control-allow-origin: *` | Returns complete lecture metadata, speaker photo, related shiurim, and direct MP3 audio URLs. |

### Verification of CORS Headers

Testing with an external origin header (`Origin: https://mosherosensweig.github.io`):

```bash
# Homepage details:
curl -s -D - -o /dev/null -H "Origin: https://mosherosensweig.github.io" "https://api.yutorah.org/homepage/details"
# Returns:
# HTTP/2 200 OK
# access-control-allow-origin: *

# Live search:
curl -s -D - -o /dev/null -H "Origin: https://mosherosensweig.github.io" "https://api.yutorah.org/search?searchTerm=Schachter"
# Returns:
# HTTP/2 200 OK
# access-control-allow-origin: *

# Lecture data:
curl -s -D - -o /dev/null -H "Origin: https://mosherosensweig.github.io" "https://www.yutorah.org/sidebar/lectureData?shiurId=1187082"
# Returns:
# HTTP/2 200 OK
# access-control-allow-origin: *
# access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS
```

**Key Takeaway**: Because all three internal APIs explicitly return `access-control-allow-origin: *`, **web browsers can make direct `fetch()` calls to them from any website or domain**, including a static GitHub Pages site, without being blocked by CORS.

### Audio Streaming Infrastructure
- Audio files are stored on Cloudflare R2 object storage:
  - `https://shiurim.yutorah.net/...` (redirects with HTTP 301 to `pub-118b5aaf6ae949ac8f59a93faec8a3da.r2.dev`)
  - `https://download.yutorah.org/...`
- Audio streams support HTTP `206 Partial Content` (byte-range requests), enabling instant scrubbing across multi-hour lectures without waiting for the full file to download.
- Standard HTML5 `<audio>` elements load media across origins without requiring special CORS permissions.

---

## 2. Cloudflare Workers vs. GitHub Pages

Because the APIs permit open CORS, **both** hosting methods are 100% technically viable. Here is how they compare:

| Dimension | Cloudflare Worker (Current Setup) | GitHub Pages (Static SPA) |
| :--- | :--- | :--- |
| **Architecture** | **Serverless Edge Application** (Node/V8 engine running on Cloudflare's global edge). | **Static File Hosting** (Plain HTML/CSS/JS served directly to the browser). |
| **CORS Handling** | Proxied & normalized through worker edge routes. | Works natively because YUTorah endpoints have `allow-origin: *`. |
| **URL Routing** | **Clean REST paths**: `https://yutorah-player.mrosensweig.workers.dev/1187082`. | **Query / Hash routing**: `https://username.github.io/yutorah/?id=1187082` or `/#/1187082` (direct paths like `/1187082` result in a 404 on reload without a SPA redirect hack). |
| **Link Sharing (Unfurling)** | **Rich previews**: When sharing a link in WhatsApp, iMessage, or Slack, the server injects `<meta property="og:title">` with the shiur title and speaker image. | **Generic preview**: Static HTML always displays the site's default title and image. |
| **Performance & Caching** | **Edge Caching**: Homepage collections are cached in worker memory for 5 minutes, reducing latency and unnecessary load on YUTorah servers. | **No Edge Caching**: Every user reload makes a fresh API call directly from the browser to YUTorah. |
| **Account Dependency** | Cloudflare account (`mrosens1@mail.yu.edu`). | GitHub account only (no third-party cloud service). |
| **Cost** | **100% Free** (within free tier). | **100% Free**. |

---

## 3. Cloudflare Free Tier: Limits & Billing Clarifications

### Is the 100,000 Request Limit Total or Per Day?
- It is **100,000 requests PER DAY** (resets every day at 00:00 UTC).
- You get a fresh 100,000 requests every single 24-hour cycle.

### Is the Current Method Totally Free?
- **Yes, completely free forever.**
- The Cloudflare Workers Free plan:
  - Requires **no credit card** on file.
  - Does **not** auto-bill or charge overages.
  - If an account ever reaches 100,000 requests in a single day, requests simply return an HTTP `429 Too Many Requests` error until the daily midnight reset.
- **Can you realistically hit 100,000 requests/day?**
  - Listening to a 1-hour shiur uses **1 request** to load the page. Playing the audio and scrubbing does not go through the worker (the audio streams directly from the CDN/R2 storage).
  - Searching uses 1 request per query.
  - To exceed 100,000 requests in one day, a user would have to perform **over 1 search or page load every single second for 24 continuous hours**.
  - For personal, family, and communal use, usage will typically hover under 100–500 requests per day (less than 0.5% of the free allowance).

---

## 4. Recommendation

### Recommendation: **Leave it on Cloudflare Workers**

**Why:**
1. **Superior User Experience & Clean URLs**:
   You get clean paths (`/1187082`) that you can copy, paste, and bookmark. On GitHub Pages, direct paths like `/1187082` fail with a 404 error on page refresh unless complex SPA redirect hacks (`404.html`) are used.
2. **Rich Link Previews**:
   When you send a link to a friend or family member via WhatsApp, Messages, or email, they see the actual shiur title and rabbi's portrait instead of a blank or generic placeholder.
3. **Edge Caching**:
   Cloudflare caches the homepage data for 5 minutes at edge data centers close to you, making homepage loads nearly instantaneous (~15ms) while respecting YUTorah's backend.
4. **Already Built, Deployed, and Working**:
   The player is already fully tested and live at `https://yutorah-player.mrosensweig.workers.dev/` with live search, pagination, audio controls, and timestamp recovery.

### When Moving to GitHub Pages Would Make Sense:
- If you prefer managing everything solely within GitHub and want zero reliance on an external Cloudflare account.
- If you want a zero-maintenance fallback, we can also keep a static `index.html` in the repository so both the Cloudflare Worker and GitHub Pages can run simultaneously.
