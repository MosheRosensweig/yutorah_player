# User Data Strategy: Storage, Auth, Scale, Popularity & PWA

**Status: Phase 1 (local) is LIVE. Phase 2 (Google OAuth + D1 sync) is implemented on `feat/auth-d1`, bound under `[env.dev]` only — production `wrangler.toml` still has zero DB bindings. Phases 3–4 remain future plans.**

---

## 1. What we store today (Phase 1 — LIVE, browser `localStorage` only)

All user-specific state lives in 13 namespaced `localStorage` keys. Nothing leaves the device. Approximate live sizes:

| Key | Contents | Typical size |
|---|---|---|
| `yutorah_recent_history` | Last 24 played (id, title, speaker, photo, duration, display date, ISO date, listened-at timestamp) | ~8 KB |
| `yutorah_playback_progress` | Per-shiur `{progressSec, durationSec, lastListened, completed}` map | ~6 KB @ ~100 shiurim |
| `yutorah_dev_playlists` | Save-for-Later, Favorites + custom playlists (snapshots) | ~8 KB @ ~40 items |
| `yutorah_dev_queue` | Ordered queue incl. collapsed series entries | ~4 KB @ ~20 items |
| `yutorah_progress_<id>` (legacy) | Old per-track resume seconds, one key per shiur | ~30 B each |
| `yutorah_theme`, `yutorah_view_mode`, `yutorah_card_view`, `yutorah_history_sort`, `yutorah_save_icon` | UI prefs | ~0.1 KB total |
| `yutorah_dev_mode` | Dev unlock flag | ~4 B |
| `yutorah_preroll_disabled` | Sponsorship pre-roll toggle | ~1 B |

**Total per heavy local user: ~30 KB.** Limits of this phase: single device/browser, wiped by cache clears, no sharing, no cross-device resume, no popularity signal.

---

## 2. Cloud plan (Phase 2 — IMPLEMENTED on `feat/auth-d1`, dev binding only): Google OAuth + Cloudflare D1

### 2.1 Auth choice: Google OAuth 2.0 (Authorization Code + PKCE), no passwords

- **Why not our own email/password:** password hashes, reset-token email pipeline (needs Resend/Postmark), breach liability, and strictly worse UX — for ~0.2 KB/user *more* storage. There is no upside.
- **Why not Apple-only / Facebook / magic links (v1):** Google covers Android + desktop + iOS-web; Apple Sign-In becomes *mandatory* only if we ship a native iOS app alongside third-party login (App Store rule 4.8) — defer until then.
- **How it works on our stack:** Cloudflare Worker runs the OAuth code flow; Google returns an ID token; the Worker mints its own session JWT (`HttpOnly`, `Secure` on https, `SameSite=Lax` cookie, `Secure` omitted on `http://localhost` so local dev works). The JWT carries `{user_id, exp}` signed with `SESSION_SECRET`; each authenticated request re-validates the user with one indexed `users` lookup (needed to surface profile + fail closed on deleted accounts) and sliding-refreshes the 1-year expiry on every sync call. No password, no session table.

### 2.2 Relogin frequency (Google, webapp)

- **Google's side:** the user authenticates with Google once; Google issues our Worker a short-lived access token (~1h, which we don't even need to keep) — relogin to Google is rare (only if the user revokes access or Google flags the session).
- **Our side (what the user feels):** controlled entirely by our session JWT `exp`. Recommended: **1-year persistent session** (`max-age=31536000`, sliding refresh on each authenticated heartbeat) + **explicit Sign out**. So in practice the user logs in once and stays logged in across restarts; they only relog in if they sign out, clear cookies, or we rotate `SESSION_SECRET`.
- Shorter (30-day) sessions only make sense if we ever store sensitive data (payment, email-change flows) — we don't.

### 2.3 D1 schema (SQLite, serverless, free tier 5 GB)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- our uuid
  google_sub    TEXT UNIQUE NOT NULL,      -- stable Google identity
  email         TEXT NOT NULL,
  name          TEXT,
  picture       TEXT,                      -- avatar URL (not bytes)
  created_at    INTEGER DEFAULT (unixepoch()),
  last_seen_at  INTEGER
);
CREATE TABLE listening_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shiur_id TEXT NOT NULL,
  progress_seconds REAL DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  completed INTEGER DEFAULT 0,
  last_listened_at INTEGER,
  listen_count INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, shiur_id)
) WITHOUT ROWID;
CREATE TABLE playlist_items (           -- save_for_later, favorites, custom:<name>, queue
  user_id TEXT NOT NULL,
  playlist TEXT NOT NULL,               -- 'save_for_later' | 'favorites' | 'queue' | 'custom:<name>'
  shiur_id TEXT NOT NULL,
  position INTEGER DEFAULT 0,           -- queue order / custom order
  title TEXT, speaker TEXT, photo TEXT, duration TEXT, -- denormalized snapshot
  date_display TEXT DEFAULT '', category TEXT DEFAULT '', is_article INTEGER DEFAULT 0,
  series_title TEXT DEFAULT '', cover_id TEXT DEFAULT '',
  kind TEXT DEFAULT 'shiur',            -- 'shiur' | 'series' (queue wrappers expand to member rows)
  added_at INTEGER,
  PRIMARY KEY (user_id, playlist, shiur_id)
) WITHOUT ROWID;
-- NOTE: inline REFERENCES are parsed but unenforced by SQLite (no FK pragma);
-- cascades are handled in application code. All timestamps MILLISECONDS.
CREATE TABLE public_playlists (         -- Phase 3: shareable
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT, description TEXT,
  is_public INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE public_playlist_items (
  playlist_id TEXT NOT NULL REFERENCES public_playlists(id) ON DELETE CASCADE,
  shiur_id TEXT NOT NULL,
  position INTEGER,
  title TEXT, speaker TEXT, photo TEXT, duration TEXT,
  PRIMARY KEY (playlist_id, position)
) WITHOUT ROWID;
CREATE TABLE playlist_likes (           -- hearts on public playlists
  user_id TEXT NOT NULL, playlist_id TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (user_id, playlist_id)
) WITHOUT ROWID;
CREATE INDEX idx_hist_user_time ON listening_history(user_id, last_listened_at DESC);
CREATE INDEX idx_items_user_pl ON playlist_items(user_id, playlist, position);
CREATE INDEX idx_likes_pl ON playlist_likes(playlist_id);
```

### 2.4 Storage math (heavy user: 1–2 shiurim/day × 3 years + favs + playlists)

Per-row reality check (SQLite `WITHOUT ROWID`, TEXT ids ~8–12 B, TEXT snapshots as today):

| Store | Rows | Bytes/row | Total |
|---|---|---|---|
| `users` | 1 | ~200 | 0.2 KB |
| `listening_history` | ~1,650 | ~120 | ~200 KB |
| `playlist_items` (favs ~200 + later ~200 + customs) | ~500 | ~230 | ~115 KB |
| prefs (single row or KV) | 1 | ~200 | 0.2 KB |
| **Per heavy user + ~30% page overhead** | | | **~450 KB** |

**5 GB ÷ 450 KB ≈ ~11,500 heavy users** (conservative: **~8,000** with index overhead; light users at ~30 KB fit ~170,000). A mixed base lands in the **tens of thousands** — the earlier "5–10k heavy" estimate holds; this schema trims it by denormalizing snapshots instead of full metadata rows.

### 2.5 Does this change the storage calculation?

- **Today: dev only.** `yutorah_db` is bound under `[env.dev]` (production `wrangler.toml` still has no DB binding); current production usage is 0 GB. Sync protocol is dirty-flagged (`dirty: {playlists, queue, history}` — server touches only named collections), merges are per-item last-write-wins, sessions are JWT + one indexed `users` lookup per authenticated request with sliding 1-year refresh on sync.
- **After Phase 2:** D1 free tier is 5 GB storage **plus** 100k row-writes/day and 5M reads/day. At ~100 heartbeat/batch writes per active user per day, writes bind first (~1,000 daily actives). Mitigation: batch heartbeats (flush every 30–60s + on pause/seek/close, exactly like today's debounced local writes), which keeps ~1–3k daily actives inside free tier.
- **KV (optional, pennies):** session allowlist/rate-limit counters only — not user data. R2 (10 GB free) is for transcripts (Phase 4), unrelated to user prefs.

### 2.6 Migration path (no data loss)

1. Ship Google login button; on first login (`?auth=ok&new=1`), `POST /api/sync` uploads the browser's `localStorage` payload once (dirty flags force all three collections), server upserts with `ON CONFLICT DO UPDATE`. Returning logins pull only.
2. Sync is dirty-flagged, not dual-write: the client sends `dirty: {playlists, queue, history}` and the server touches **only** named collections (absent keys leave server rows alone, so an empty device can never wipe the cloud). Merges are per-item last-write-wins by timestamp on both push and pull; local remains the offline source of truth.

---

## 3. Popularity from favs (Phase 3 — FUTURE, cheap by design)

### 3.1 What we can compute from our own data

Per-shiur save counts are a free byproduct of `playlist_items`:

```sql
-- "Saved by N listeners" badge + popularity sort, single indexed query
SELECT shiur_id, COUNT(DISTINCT user_id) AS saves
FROM playlist_items
WHERE playlist IN ('favorites', 'later')
GROUP BY shiur_id ORDER BY saves DESC LIMIT 50;
```

Cost: one `COUNT` over an indexed table (~50 B/row: 1M saves ≈ 50 MB). Also derivable: completion rate (`completed / started` from `listening_history`), re-listen rate (`listen_count > 1`), velocity (saves in last 30 days for trending). Suggested product blend: `score = 0.5·completion + 0.3·saves + 0.2·recency`, precomputed nightly into a tiny `shiur_stats(shiur_id, score, saves, updated_at)` table (~440k rows × ~40 B ≈ **18 MB**) so reads never touch raw tables.

### 3.2 What YUTorah already exposes (usable TODAY, no login needed)

Yes — popularity data exists upstream and we already consume part of it:

- **Per-search Solr docs:** `shiurvisitsnum` (views) + `shiurdownloadsnum` (downloads) — powers today's speaker-page Top Lectures.
- **Per-lecture `lectureData`:** `shiurVisitsNumber`, `shiurDownloadsNumber`, `shiurCommentsNumber` (+ comment bodies).
- **Not exposed:** their internal favorites/likes/hearts (account-gated, no public API). We cannot borrow those — our own fav counts (above) are the replacement once login ships.

Recommendation: keep views+downloads as the popularity signal now; layer our fav/save counts on top after Phase 2 (they measure *intent*, which predicts better than views).

---

## 4. Public playlists (Phase 3 — FUTURE, shared storage)

- Authoring reuses the Phase-2 editor; toggling `is_public` publishes a snapshot into `public_playlist_items` (denormalized so owner edits/deletes never break shared copies; "based on" attribution optional).
- Sharing = link `/playlists/<id>` (SSR from D1, OG unfurls); likes = one `playlist_likes` row each (~30 B).
- Scale: 10,000 public lists × 50 items × ~230 B ≈ **115 MB** + 1M likes ≈ **30 MB** — roughly 3% of 5 GB. Per-user cost barely moves (+follows ≈ 2 KB). Heavy-user capacity with a lively public catalog: **~7,000–10,000**.
- Abuse controls for later: rate-limit publishes, report button, owner block.

---

## 5. Is this a PWA? How hard to become one?

**Not a PWA today.** Checklist status:

| Requirement | Status |
|---|---|
| Served over HTTPS | ✅ (Workers) |
| Web app manifest (`manifest.json` + `<link>`) | ❌ missing |
| Service worker (offline shell, installability) | ❌ missing |
| Icons 192/512 (maskable) | ❌ missing |
| `theme-color` meta | ❌ check |
| Offline fallback route | ❌ missing |

**Difficulty: easy (~1–2 days).** Concrete steps: (1) add `manifest.json` (name, short_name, start_url `/`, display `standalone`, background/theme colors, icons) + serve with `Content-Type: application/manifest+json`; (2) add a minimal service worker (cache-first app shell + audio streams via Range-aware cache, network-first for `/api/*`); (3) generate maskable PNGs from the existing logo; (4) add `<meta name="theme-color">` + iOS `apple-touch-icon`. Caveats specific to us: audio files are large — cache only explicitly downloaded shiurim (never auto-cache streams) or you will blow device quotas; and our query-param URLs (`/?search=`) need a navigation-fallback route in the worker. Install prompt then works on Android/desktop; iOS supports Add-to-Home-Screen but no push — fine, we don't need push.
