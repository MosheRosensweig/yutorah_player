# Google Login Setup (5 minutes, one time)

The code is fully implemented on `feat/auth-d1`. The only missing pieces are
your own Google OAuth credentials (I cannot create these — they live in
your Google account).

## 1. Create the OAuth client

1. Go to Google Cloud Console → APIs & Services → Credentials.
2. Create Credentials → OAuth client ID → type **Web application**.
3. Under **Authorized redirect URIs**, add (one per environment you use):
   - `http://localhost:8787/auth/callback` (local dev)
   - `https://yutorah-player-dev.mrosensweig.workers.dev/auth/callback` (dev link)
   - Production URL + `/auth/callback` (only when you promote to main).
4. Copy the **Client ID** and **Client secret**.

## 2. Store secrets (never in git)

```bash
# Dev worker (do this now to test login on the dev link)
npx wrangler secret put GOOGLE_CLIENT_ID --env dev
npx wrangler secret put GOOGLE_CLIENT_SECRET --env dev
npx wrangler secret put SESSION_SECRET --env dev   # paste 64 random hex chars

# Production worker (only when you approve main-site login)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

Generate the session secret with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 3. Database (already done for dev)

- `yutorah-db` D1 created; migrations applied to local + remote, in order:
  - `migrations/0001_init.sql` — users, listening_history, playlist_items
  - `migrations/0002_syncfix.sql` — cover_id/date_display/category/is_article columns (required by sync code; do not skip)
- Bound under `[env.dev]` only. To enable on production later, copy the
  `[[env.dev.d1_databases]]` block to top level (or `[env.production]`)
  and run both migrations with `--remote`. Re-apply with:
  `npx wrangler d1 execute yutorah-db --remote --file=migrations/0002_syncfix.sql`

## 4. What happens for users

1. Header **👤 Sign in** → Google account chooser → back to `/`.
2. First login pushes their browser library to D1 (merge by timestamp); later
   logins pull. Edits sync ~2.5s debounced. Works offline (local first).
3. Clicking the avatar (now showing their Google photo) → Sign out confirm.
4. Sessions last 1 year sliding; no passwords anywhere.

## 5. Verify

- `GET /api/me` → `{"user":null}` logged out, profile when logged in.
- After login with existing local playlists: reload on another browser →
  same playlists appear (proves cloud round-trip).
