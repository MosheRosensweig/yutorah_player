# Security Plan: Data & API Protection

**Scope: this webapp only. Status: §1–§2 are LIVE today; §3–§7 ship with login (Phase 2) or as noted. No database exists yet — see `docs/USER_DATA_STRATEGY.md`.**

---

## 1. Current posture (no accounts, no database)

- **No secrets in the repo.** The Worker makes only unauthenticated GETs to public YUTorah endpoints (`api.yutorah.org`, `www.yutorah.org` sidebar/lecture data, CDNs). There are no API keys to leak; `wrangler.toml` contains no bindings or secrets.
- **No user data server-side.** History, playlists, queue, progress, and prefs live in the visitor's own `localStorage`. The edge never sees them, so there is nothing to breach, subpoena, or leak from our side.
- **XSS hardening (shipped, tested):**
  - All upstream text is HTML-escaped (`escapeHtml`) before render; attribute contexts use entity + quote escaping.
  - All server-to-client JSON embeds use `jsEmbed()` (`<` → `\u003c`), closing the `</script>` breakout class; verified by automated served-output tests.
  - Dynamic DOM writes for user-influenced strings use `textContent`, never `innerHTML` (playlist/modal titles are the audited exceptions, escaped at build).
  - Upstream slideshow `targetURL`s are allowlisted (`/lectures/<id>` → in-app, `http(s)` → new-tab with `rel="noopener"`, everything else → `#`); `javascript:`/`data:` schemes cannot execute.
- **Dependency surface:** zero npm runtime dependencies in the Worker bundle (only `wrangler` + `pdfjs-dist` dev). No supply-chain code ships to users beyond pdf.js from cdnjs (pinned version, SRI recommended before production — TODO).
- **Transport:** HTTPS-only (Cloudflare edge); `fetch` to upstreams is server-side, so visitor IPs are never exposed to YUTorah.

## 2. What we deliberately do NOT do today

- No login forms, no passwords, no cookies, no tracking pixels, no third-party analytics. Nothing to steal.
- No `eval()`/`new Function()` on remote content (tests use `new Function` only on our own served scripts as a syntax check).
- No open redirects: internal `/lectures/<id>` mapping is regex-anchored; external targets open `noopener`.

## 3. Login phase (Phase 2): Google OAuth threat model

- **Flow:** Authorization Code + PKCE, `state` nonce, `redirect_uri` locked to our origins. ID tokens verified against Google JWKS (cached); never trust the `email` claim without signature verification.
- **Sessions:** stateless signed JWT in `HttpOnly` + `Secure` + `SameSite=Lax` cookie, 1-year sliding expiry (`SESSION_SECRET` in `wrangler secret`, rotated by versioned `kid`). No session table = nothing to hijack server-side; theft requires cookie theft, mitigated by `HttpOnly` + TLS everywhere.
- **CSRF:** `SameSite=Lax` + state-nonce check on the OAuth callback; mutations additionally require the session cookie (no bearer-in-URL patterns).
- **What we never store:** passwords (none exist), Google access tokens (drop after use; request only `openid email profile` scopes), full message bodies, payment data.
- **Rate limiting (new):** Cloudflare Rate Limiting rules on `/api/*` (e.g. 100 req/min/IP for search, 10/min for auth endpoints) to blunt credential-stuffing (irrelevant — no passwords) and scraping/enumeration (`/api/search?q=<id>` is abusable for bulk harvest; throttle + require session for high-volume patterns).
- **Enumeration guards:** user lookup by email returns generic responses; public playlist IDs are unguessable (`crypto.randomUUID`); no user directory endpoint.

## 4. API & data protection (with D1)

- **Authorization on every row:** all queries carry `WHERE user_id = :jwt_sub`; service-role key never ships to the client. Public playlist reads allowlist `is_public = 1` only.
- **Input validation:** `zod`-style schemas at each endpoint (length caps: titles ≤200 chars, playlist names ≤60, pagination `rows ≤ 30` existing); IDs are numeric-or-UUID validated; Solr query terms length-capped to prevent ReDoS/expensive fanout (fanout already bounded: ≤4 pages × entities).
- **Least-privilege writes:** heartbeat endpoint accepts only `{shiur_id, progress_sec, duration_sec}`; playlist endpoints accept only whitelisted fields — never raw SQL, always parameterized D1 prepared statements.
- **Quota/abuse:** per-user write caps (heartbeats debounced 30–60s client-side AND server-throttled); publish rate limits (e.g. 10 public playlists/day); report button → `reports` table → admin review before takedown.
- **Backups & recovery:** D1 point-in-time snapshots (automatic); export script for account portability.

## 5. Privacy & compliance (GDPR/CCPA-ready design)

- **Data minimization:** store IDs + snapshots needed for rendering, not full bios/histories; avatar URLs, not bytes.
- **User rights (build with login):** Settings → *Export my data* (JSON dump of all rows) and *Delete my account* (cascading deletes; `ON DELETE CASCADE` in schema). Document retention: deleted means deleted (no soft-delete table).
- **No sale/sharing of personal data**, no ad tech, no fingerprinting. Privacy policy page before login ships.

## 6. Headers & transport hardening (ship with login)

```
Content-Security-Policy: default-src 'self'; script-src 'self' cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https:; connect-src 'self' https://api.yutorah.org; frame-ancestors 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

(CSP `unsafe-inline` is required today by the single-file SSR design; a production pass should extract inline scripts to hashed files and drop it.)

## 7. Operations & incident readiness

- **Secrets:** only via `wrangler secret put` (never in repo/env files); separate `SESSION_SECRET` per environment (dev vs production workers already split).
- **Observability:** Worker's `observability` enabled; add structured auth-failure logs + alerting on spikes (brute-force, fanout abuse, quota burn).
- **Dependency hygiene:** `npm audit` in CI, pin + SRI production CDN assets, monthly review; keep runtime deps at zero.
- **Incident playbook:** rotate `SESSION_SECRET` (versioned `kid` keeps old sessions draining), revoke OAuth client if Google flags abuse, restore D1 from snapshot, post-mortem in `docs/`.
- **Pre-launch checklist:** rate limits on, CSP live, export/delete flows tested, secrets rotated from dev values, `robots.txt`/security.txt published, backup restore dry-run done.
