/**
 * YUTorah Player — Cloudflare Worker Web Application
 *
 * Standalone, zero-friction web portal and enhanced audio player.
 * Server-renders collections (Editor's Picks, Recently Uploaded, Popular, Daily Shiurim)
 * and proxies real-time searches across 440,000+ YUTorah shiurim without Cloudflare blocking.
 */

import { getHebrewDateInfo, getActiveHolidayTheme } from './hebrew_calendar.js';
import { THEMES } from './theme_definitions.js';
import { THEME_ASSETS } from './theme_assets.js';
import { 
  expandQueryWithPhonetics, 
  COMMUNITY_ACRONYM_PHRASES,
  highlightMatches,
  extractSnippet,
  buildMatchReasons,
  computeRelevanceScore,
  groupAndRankDocs,
  damerauLevenshtein,
  suggestDidYouMean
} from './phonetic_engine.js';
import AUTOCOMPLETE_META from './autocomplete_data.json' with { type: 'json' };
import CHANGELOG from './changelog.json' with { type: 'json' };

// Safe JSON embed for <script> contexts: neutralizes </script> breakouts.
function jsEmbed(val) {
  return JSON.stringify(val === undefined ? null : val).replace(/</g, '\\u003c');
}

// =========================================================================
// Auth + cloud sync (Google OAuth 2.0 code flow + D1). Phase 2.
// Setup: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (wrangler secret), and an
// authorized redirect of https://<host>/auth/callback in Google Console.
// Without credentials, /auth/google explains setup; all sync routes 503.
// =========================================================================
function b64urlEncode(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

async function makeSessionJWT(secret, payload) {
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, header + '.' + body);
  return header + '.' + body + '.' + sig;
}

function timingSafeEqualStr(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

async function verifySessionJWT(secret, token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expect = await hmacSign(secret, parts[0] + '.' + parts[1]);
    if (!timingSafeEqualStr(expect, parts[2])) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!payload || !payload.uid) return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(request) {
  const out = {};
  try {
    const h = request.headers.get('cookie') || '';
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  } catch (e) {}
  return out;
}

function isHttpsRequest(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch (e) {
    return true;
  }
}

function sessionCookieHeader(token, maxAge, secure) {
  return 'yutorah_session=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly;' + (secure === false ? '' : ' Secure;') + ' SameSite=Lax; Max-Age=' + maxAge;
}

function clearSessionCookieHeader(secure) {
  return 'yutorah_session=; Path=/; HttpOnly;' + (secure === false ? '' : ' Secure;') + ' SameSite=Lax; Max-Age=0';
}

function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function getSessionUser(request, env) {
  if (!env || !env.yutorah_db || !env.SESSION_SECRET) return null;
  const cookies = parseCookies(request);
  if (!cookies.yutorah_session) return null;
  const payload = await verifySessionJWT(env.SESSION_SECRET, cookies.yutorah_session);
  if (!payload) return null;
  try {
    const row = await env.yutorah_db.prepare('SELECT id, email, name, picture FROM users WHERE id = ?')
      .bind(payload.uid).first();
    if (!row) return null;
    return { id: row.id, email: row.email, name: row.name, picture: row.picture };
  } catch (e) {
    return null;
  }
}

function requireEnvJson(env) {
  if (!env || !env.yutorah_db) {
    return new Response(JSON.stringify({ error: 'sync unavailable: no database bound' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
  return null;
}

// GET /api/me, /auth/*, /api/sync live under the main fetch handler.
async function handleAuthRoutes(request, env, url) {
  const path = url.pathname;

  // ---- GET /api/me: session probe (never 503s on missing creds) ----
  if (path === '/api/me') {
    const user = await getSessionUser(request, env);
    return new Response(JSON.stringify({ user: user || null }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  }

  const secureCookies = isHttpsRequest(request);
  const allowedHosts = (env && (env.ALLOWED_HOSTS || '')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname.toLowerCase())) {
    return new Response(JSON.stringify({ error: 'unknown host' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // ---- POST /auth/logout (POST only: GET logout is CSRF-loggable) ----
  if (path === '/auth/logout') {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'use POST' }), {
        status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Set-Cookie': clearSessionCookieHeader(secureCookies)
      }
    });
  }

  const clientId = (env && (env.GOOGLE_CLIENT_ID || env.google_client_id)) || '';
  const clientSecret = (env && (env.GOOGLE_CLIENT_SECRET || env.google_client_secret)) || '';
  const origin = url.origin;

  // ---- GET /auth/google: start OAuth (all three secrets required) ----
  if (path === '/auth/google') {
    if (!clientId || !clientSecret || !(env && env.SESSION_SECRET)) {
      return new Response(
        '<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:60px auto;padding:0 20px;">' +
        '<h2>Login not configured yet</h2>' +
        '<p>Google OAuth credentials are missing. Owner setup:</p>' +
        '<ol><li>Create an OAuth client at Google Cloud Console (APIs &amp; Services → Credentials).</li>' +
        '<li>Add authorized redirect URI: <code>' + origin + '/auth/callback</code></li>' +
        '<li>Run <code>npx wrangler secret put GOOGLE_CLIENT_ID</code>, <code>npx wrangler secret put GOOGLE_CLIENT_SECRET</code> and <code>npx wrangler secret put SESSION_SECRET</code> (64 random hex chars).</li></ol>' +
        '<p><a href="/">← Back</a></p></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const returnTo = url.searchParams.get('return_to') || '/';
    const state = randomToken(24);
    const stateSig = await hmacSign(env.SESSION_SECRET, state);
    // PKCE S256: verifier stays in the signed state cookie, challenge goes out.
    const verifier = randomToken(48);
    const verifierDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = b64urlEncode(verifierDigest);
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: clientId,
      redirect_uri: origin + '/auth/callback',
      response_type: 'code',
      scope: 'openid email profile',
      state: state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString();
    const retEnc = b64urlEncode(new TextEncoder().encode(returnTo));
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': 'yutorah_oauth_state=' + encodeURIComponent(state + '.' + stateSig + '.' + verifier + '.' + retEnc) +
          '; Path=/auth/callback; HttpOnly;' + (secureCookies ? ' Secure;' : '') + ' SameSite=Lax; Max-Age=600'
      }
    });
  }

  // ---- GET /auth/callback: finish OAuth ----
  if (path === '/auth/callback') {
    if (!clientId || !clientSecret || !env.SESSION_SECRET || !env.yutorah_db) {
      return Response.redirect(origin + '/?auth=setup-needed', 302);
    }
    try {
      const code = url.searchParams.get('code') || '';
      const retState = url.searchParams.get('state') || '';
      const cookies = parseCookies(request);
      const saved = (cookies.yutorah_oauth_state || '').split('.');
      if (!code || saved.length < 3 || saved[0] !== retState) {
        return Response.redirect(origin + '/?auth=state-mismatch', 302);
      }
      const expectSig = await hmacSign(env.SESSION_SECRET, saved[0]);
      if (!timingSafeEqualStr(expectSig, saved[1]) || !saved[2]) {
        return Response.redirect(origin + '/?auth=state-mismatch', 302);
      }
      let returnTo = '/';
      if (saved[3]) {
        try {
          const dec = new TextDecoder().decode(b64urlDecode(saved[3]));
          if (dec.startsWith('/') && !dec.startsWith('//')) returnTo = dec;
        } catch (e) {}
      }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: origin + '/auth/callback', grant_type: 'authorization_code',
          code_verifier: saved[2]
        }).toString()
      });
      if (!tokenRes.ok) return Response.redirect(origin + '/?auth=token-failed', 302);
      const tokens = await tokenRes.json();
      const uiRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token }
      });
      if (!uiRes.ok) return Response.redirect(origin + '/?auth=userinfo-failed', 302);
      const ui = await uiRes.json();
      if (!ui.sub || !ui.email) return Response.redirect(origin + '/?auth=userinfo-failed', 302);

      const now = Date.now();
      let user = await env.yutorah_db.prepare('SELECT id FROM users WHERE google_sub = ?')
        .bind(String(ui.sub)).first();
      let uid;
      let isNew = false;
      const RESERVED_DEV_NAMES = ['andrew ohiliote', 'moshe mendelwitz', 'moshe medelwitz', 'rachel sternbach'];
      if (user) {
        uid = user.id;
        const currentName = user.name || String(ui.name || '');
        await env.yutorah_db.prepare(
          'UPDATE users SET email = ?, name = ?, picture = ?, last_seen_at = ? WHERE id = ?')
          .bind(String(ui.email), currentName, String(ui.picture || ''), now, uid).run();
      } else {
        uid = randomToken(12);
        isNew = true;
        let finalName = String(ui.name || '').trim();
        try {
          if (finalName) {
            let conflict = RESERVED_DEV_NAMES.includes(finalName.toLowerCase());
            if (!conflict) {
              const row = await env.yutorah_db.prepare(
                'SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))'
              ).bind(finalName).first();
              if (row) conflict = true;
            }
            if (conflict) {
              finalName = (finalName || 'User') + ' ' + Math.floor(100 + Math.random() * 900);
            }
          }
        } catch (e) {}
        await env.yutorah_db.prepare(
          'INSERT INTO users (id, google_sub, email, name, picture, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(uid, String(ui.sub), String(ui.email), finalName, String(ui.picture || ''), now, now).run();
      }
      const session = await makeSessionJWT(env.SESSION_SECRET, {
        uid, exp: now + 365 * 24 * 3600 * 1000, iat: now
      });
      const outHeaders = new Headers();
      const destUrl = new URL(returnTo, origin);
      destUrl.searchParams.set('auth', 'ok');
      if (isNew) destUrl.searchParams.set('new', '1');
      outHeaders.set('Location', destUrl.toString());
      outHeaders.append('Set-Cookie', sessionCookieHeader(session, 365 * 24 * 3600, secureCookies));
      outHeaders.append('Set-Cookie',
        'yutorah_oauth_state=; Path=/auth/callback; HttpOnly;' + (secureCookies ? ' Secure;' : '') + ' SameSite=Lax; Max-Age=0');
      return new Response(null, { status: 302, headers: outHeaders });
    } catch (e) {
      return Response.redirect(origin + '/?auth=error', 302);
    }
  }

  return null;
}

// ---- Sync helpers: DB rows <-> client localStorage shapes ----
// Only collections PRESENT in the request body are touched; absent keys
// mean "not dirty, leave server state alone" (prevents empty-device wipes).
function snapItemToRow(userId, playlist, it, position) {
  return {
    user_id: userId,
    playlist,
    shiur_id: String(it.id || ''),
    position: position || 0,
    title: String(it.title || 'Untitled'),
    speaker: String(it.speaker || 'YUTorah'),
    photo: String(it.photo || ''),
    duration: String(it.duration || ''),
    date_display: String(it.date || ''),
    category: String(it.category || ''),
    is_article: it.isArticle ? 1 : 0,
    series_title: String(it.seriesTitle || ''),
    cover_id: String(it.coverId || ''),
    kind: it.kind === 'series' ? 'series' : 'shiur',
    added_at: Number(it.addedAt || it.queuedAt || Date.now())
  };
}

// Expand client queue entries (incl. collapsed series wrappers) into flat
// member rows so series survive the round trip.
function queueEntriesToRows(userId, queue) {
  const rows = [];
  let pos = 0;
  for (const it of (queue || []).slice(0, 500)) {
    if (!it) continue;
    if (it.kind === 'series' && Array.isArray(it.items)) {
      for (const s of it.items) {
        if (!s || !s.id) continue;
        const r = snapItemToRow(userId, 'queue', s, pos++);
        r.kind = 'series';
        r.series_title = String(it.seriesTitle || r.series_title);
        r.cover_id = String(it.coverId || it.seriesTitle || '');
        rows.push(r);
      }
    } else if (it.id) {
      rows.push(snapItemToRow(userId, 'queue', it, pos++));
    }
  }
  return rows;
}

async function pullUserState(db, userId) {
  const hist = await db.prepare(
    'SELECT shiur_id AS id, title, speaker, photo, duration, date_iso AS dateISO, date_display AS dateDisplay, ' +
    'category, is_article AS isArticle, ' +
    'progress_seconds AS progressSec, duration_seconds AS durationSec, ' +
    'completed, last_listened_at AS lastListened, listen_count AS listenCount ' +
    'FROM listening_history WHERE user_id = ? ORDER BY last_listened_at DESC LIMIT 500')
    .bind(userId).all();
  const items = await db.prepare(
    'SELECT playlist, shiur_id AS id, position, title, speaker, photo, duration, date_display AS date, category, ' +
    'is_article AS isArticle, series_title AS seriesTitle, cover_id AS coverId, kind, added_at AS addedAt ' +
    'FROM playlist_items WHERE user_id = ? ORDER BY playlist, position, added_at LIMIT 2000')
    .bind(userId).all();
  const playlists = { save_for_later: [], favorites: [], custom: {} };
  const queueFlat = [];
  for (const r of (items.results || [])) {
    const snap = {
      id: r.id, title: r.title, speaker: r.speaker, photo: r.photo,
      duration: r.duration, date: r.date || '', category: r.category || '',
      isArticle: Boolean(r.isArticle), addedAt: r.addedAt, queuedAt: r.addedAt
    };
    if (r.seriesTitle) snap.seriesTitle = r.seriesTitle;
    if (r.coverId) snap.coverId = r.coverId;
    if (r.playlist === 'save_for_later') playlists.save_for_later.push(snap);
    else if (r.playlist === 'favorites') playlists.favorites.push(snap);
    else if (r.playlist === 'queue') queueFlat.push(snap);
    else if (String(r.playlist).startsWith('custom:')) {
      const name = String(r.playlist).slice(7);
      if (!playlists.custom[name]) playlists.custom[name] = [];
      playlists.custom[name].push(snap);
    }
  }
  // Regroup queue series members back into collapsed series wrappers.
  const queue = [];
  const seriesGroups = new Map();
  for (const s of queueFlat) {
    if (s.kind === 'series' || s.coverId) {
      const key = s.coverId || ('title:' + (s.seriesTitle || ''));
      if (!seriesGroups.has(key)) {
        const entry = { kind: 'series', coverId: s.coverId || '', seriesTitle: s.seriesTitle || 'Series', items: [], queuedAt: s.queuedAt };
        seriesGroups.set(key, entry);
        queue.push(entry);
      }
      seriesGroups.get(key).items.push({ ...s });
    } else {
      queue.push(s);
    }
  }
  // Re-attach kind:'series' to grouped wrappers (spread above drops it).
  for (const q of queue) {
    if (q.items && !q.id) q.kind = 'series';
  }
  const history = (hist.results || []).map(h => ({
    id: h.id, title: h.title, speaker: h.speaker, photo: h.photo,
    duration: h.duration, date: h.dateDisplay || '', dateISO: h.dateISO || '',
    category: h.category || '', isArticle: Boolean(h.isArticle),
    listenedAt: h.lastListened
  }));
  const progress = {};
  for (const h of (hist.results || [])) {
    if ((h.progressSec || 0) > 0 || h.completed) {
      progress[h.id] = {
        shiurId: h.id,
        progressSec: h.progressSec || 0, durationSec: h.durationSec || 0,
        lastListened: h.lastListened, completed: Boolean(h.completed)
      };
    }
  }
  return { history, playlists, queue, progress };
}

async function handleSyncRoutes(request, env, url) {
  // Profile + public-playlist routes live in this handler (after the guard).
  if (url.pathname !== '/api/sync' && url.pathname !== '/api/profile' &&
      !url.pathname.startsWith('/api/playlists/')) return null;
  const noDb = requireEnvJson(env);
  if (noDb) return noDb;
  // ---- Public playlists: publish / browse / save ----
  // Publishing snapshots items and stores the owner's DISPLAY NAME only.
  if (url.pathname === '/api/playlists/public') {
    if (request.method === 'GET') {
      if (!env || !env.yutorah_db) {
        return new Response(JSON.stringify({ playlists: [], total: 0 }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const fTeachers = url.searchParams.getAll('teacher')
        .concat(url.searchParams.getAll('teachers'))
        .concat((url.searchParams.get('teacher') || '').split(','))
        .concat((url.searchParams.get('teachers') || '').split(','))
        .map(s => s.trim().toLowerCase()).filter(Boolean);
      const fVenues = url.searchParams.getAll('venue')
        .concat(url.searchParams.getAll('venues'))
        .concat((url.searchParams.get('venue') || '').split(','))
        .concat((url.searchParams.get('venues') || '').split(','))
        .map(s => s.trim().toLowerCase()).filter(Boolean);
      const fTopics = url.searchParams.getAll('topic')
        .concat(url.searchParams.getAll('topics'))
        .concat((url.searchParams.get('topic') || '').split(','))
        .concat((url.searchParams.get('topics') || '').split(','))
        .map(s => s.trim().toLowerCase()).filter(Boolean);
      const sort = (url.searchParams.get('sort') || 'recent').toLowerCase();
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
      const scopeTitle = url.searchParams.get('scopeTitle') !== '0';
      const scopeDesc = url.searchParams.get('scopeDesc') !== '0';
      const scopeShiurim = url.searchParams.get('scopeShiurim') === '1';
      const orderBy = sort === 'saves' ? 'saves DESC, updated_at DESC' : 'updated_at DESC';
      let rows;
      try {
        // No SQL offset: tag/text filters run in JS, so paginate AFTER
        // filtering (total = full match count, slice = one true window).
        // NOTE: public_playlist_items has NO series_title column (see
        // 0003/0004 migrations); series titles live in i.title and bundled
        // lecture titles/speakers in i.items_json. Referencing a missing
        // column would throw and zero all results whenever scopeShiurim=1,
        // so the shiurim scope must stay strictly additive.
        const itemsSql = scopeShiurim
          ? ', (SELECT GROUP_CONCAT(COALESCE(i.title, "") || " " || COALESCE(i.speaker, "") || " " || COALESCE(i.items_json, ""), " ") FROM public_playlist_items i WHERE i.playlist_id = p.id) AS itemsText '
          : ' ';
        const baseSql =
          'SELECT p.id, p.owner_name AS ownerName, p.title, p.description, p.tags_json AS tagsJson, ' +
          'p.saves, p.created_at AS createdAt, p.updated_at AS updatedAt, ' +
          '(SELECT COUNT(*) FROM public_playlist_items i WHERE i.playlist_id = p.id) AS itemCount';
        const tailSql = 'FROM public_playlists p WHERE p.is_public = 1 ORDER BY ' + orderBy + ' LIMIT 1000';
        try {
          rows = await env.yutorah_db.prepare(baseSql + itemsSql + tailSql).bind().all();
        } catch (e) {
          // Additive-only guarantee: if the items subquery ever fails,
          // fall back to the title/desc baseline instead of zeroing results.
          rows = await env.yutorah_db.prepare(baseSql + ' ' + tailSql).bind().all();
        }
      } catch (e) {
        rows = { results: [] };
      }
      const matchTags = (tagsJson) => {
        let tags = null;
        try { tags = JSON.parse(tagsJson || '[]'); } catch (e) { tags = null; }
        const t = (tags && typeof tags === 'object' ? tags : {});
        const teachers = ((t.teachers || []).map(x => String(x.name || x).toLowerCase()));
        const venues = ((t.venues || []).map(x => String(x.name || x).toLowerCase()));
        const topics = ((t.topics || []).map(x => String(x.name || x).toLowerCase()));
        if (fTeachers.length > 0 && !fTeachers.some(ft => teachers.some(n => n.includes(ft)))) return null;
        if (fVenues.length > 0 && !fVenues.some(fv => venues.some(n => n.includes(fv)))) return null;
        if (fTopics.length > 0 && !fTopics.some(ft => topics.some(n => n.includes(ft)))) return null;
        return { teachers: t.teachers || [], venues: t.venues || [], topics: t.topics || [] };
      };
      let list = [];
      for (const r of (rows.results || [])) {
        const tags = matchTags(r.tagsJson);
        if (!tags) continue;
        const hayParts = [];
        if (scopeTitle) {
          hayParts.push(r.title || '');
          if (tags) {
            (tags.teachers || []).forEach(x => hayParts.push(x.name || x));
            (tags.venues || []).forEach(x => hayParts.push(x.name || x));
            (tags.topics || []).forEach(x => hayParts.push(x.name || x));
          }
        }
        if (scopeDesc) {
          hayParts.push(r.description || '');
        }
        if (scopeShiurim && r.itemsText) {
          hayParts.push(r.itemsText);
        }
        const hay = hayParts.join(' ').toLowerCase();
        if (q && !q.split(/\s+/).every(w => hay.includes(w))) continue;
        list.push({
          id: r.id, ownerName: r.ownerName, title: r.title, description: r.description,
          tags, saves: r.saves || 0, itemCount: r.itemCount || 0,
          createdAt: r.createdAt, updatedAt: r.updatedAt
        });
      }
      if (sort === 'saves') list.sort((a, b) => (b.saves - a.saves) || (b.updatedAt - a.updatedAt));
      return new Response(JSON.stringify({ playlists: list.slice(offset, offset + limit), total: list.length }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }
      });
    }
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (url.pathname === '/api/playlists/items') {
    if (!env || !env.yutorah_db) {
      return new Response(JSON.stringify({ items: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    const pid = url.searchParams.get('id') || '';
    let items = [];
    try {
      const r = await env.yutorah_db.prepare(
        'SELECT p.id, p.title, p.description, p.icon, p.tags, p.is_public AS isPublic, p.owner_id AS ownerId, u.display_name AS ownerName FROM public_playlists p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?')
        .bind(pid).first();
      if (!r || (!r.isPublic && (await getSessionUser(request, env) || {}).id !== r.ownerId)) {
        return new Response(JSON.stringify({ error: 'Playlist not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const rr = await env.yutorah_db.prepare(
        'SELECT shiur_id AS id, title, speaker, photo, duration, kind, items_json AS itemsJson FROM public_playlist_items WHERE playlist_id = ? ORDER BY position')
        .bind(pid).all();
      items = (rr.results || []).map(it => {
        if (it.kind === 'series') {
          let kids = [];
          try { kids = JSON.parse(it.itemsJson || '[]'); } catch (e) { kids = []; }
          return { kind: 'series', seriesTitle: it.title, items: Array.isArray(kids) ? kids : [] };
        }
        return it;
      });
      let tags = { teachers: [], venues: [], topics: [] };
      try { tags = typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || tags); } catch(e) {}
      const playlist = {
        id: r.id,
        title: r.title,
        description: r.description || '',
        icon: r.icon || '📁',
        tags: tags,
        ownerName: r.ownerName || 'Community',
        isPublic: !!r.isPublic
      };
      return new Response(JSON.stringify({ playlist, items }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Database error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
  const db = env.yutorah_db;
  // Sliding session: every authenticated sync extends the 1-year window.
  const refreshed = await makeSessionJWT(env.SESSION_SECRET, {
    uid: user.id, exp: Date.now() + 365 * 24 * 3600 * 1000, iat: Date.now()
  });
  const refreshCookie = sessionCookieHeader(refreshed, 365 * 24 * 3600, isHttpsRequest(request));

  // ---- GET /api/sync: pull everything ----
  if (request.method === 'GET') {
    const state = await pullUserState(db, user.id);
    return new Response(JSON.stringify({ user, ...state }), {
      headers: {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store', 'Set-Cookie': refreshCookie
      }
    });
  }

  // ---- GET|POST /api/profile: display name (shown on playlists, never email) ----
  if (url.pathname === '/api/profile') {
    const isDev = request.headers.get('x-dev-mode') === '1';
    const puser = (await getSessionUser(request, env)) || (isDev ? { id: 'dev', name: 'Dev', email: 'dev@local' } : null);
    if (!puser) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ user: puser }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    if (request.method === 'POST') {
      let pbody = {};
      try { pbody = await request.json(); } catch (e) { pbody = {}; }
      const nm = String((pbody && pbody.name) || '').trim().slice(0, 40);
      if (!nm) {
        return new Response(JSON.stringify({ error: 'name required', message: 'Name cannot be empty.' }), {
          status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const noDb = requireEnvJson(env);
      if (noDb) return noDb;

      const RESERVED_DEV_NAMES = ['andrew ohiliote', 'moshe mendelwitz', 'moshe medelwitz', 'rachel sternbach'];
      const isDev = (puser.id === 'dev' || request.headers.get('x-dev-mode') === '1');
      if (!isDev && RESERVED_DEV_NAMES.includes(nm.toLowerCase())) {
        return new Response(JSON.stringify({
          error: 'name_reserved',
          message: 'That display name is reserved. Please choose a different name.'
        }), {
          status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const conflict = await env.yutorah_db.prepare(
          'SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id != ?'
        ).bind(nm, puser.id).first();
        if (conflict) {
          return new Response(JSON.stringify({
            error: 'name_taken',
            message: 'That display name is already taken. Please choose a different name.'
          }), {
            status: 409, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch (e) {}

      await env.yutorah_db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(nm, puser.id).run();
      try {
        const fresh = await env.yutorah_db.prepare('SELECT id, email, name, picture FROM users WHERE id = ?')
          .bind(puser.id).first();
        if (fresh) puser.name = fresh.name;
      } catch (e) {}
      return new Response(JSON.stringify({ user: puser }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (url.pathname === '/api/playlists/publish' || url.pathname === '/api/playlists/unpublish' ||
      url.pathname === '/api/playlists/save' || url.pathname === '/api/playlists/unsave' ||
      url.pathname === '/api/playlists/mine') {
    const noDb = requireEnvJson(env);
    if (noDb) return noDb;
    let puser = await getSessionUser(request, env);
    if (!puser) {
      if (request.headers.get('x-dev-mode') === '1') {
        puser = { id: 'dev', name: 'Dev', email: 'dev@yutorah.org' };
      } else {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }
    const db = env.yutorah_db;
    const now = Date.now();

    // GET /api/playlists/mine: my published lists (public + private).
    if (url.pathname === '/api/playlists/mine' && request.method === 'GET') {
      const r = await db.prepare(
        'SELECT p.id, p.title, p.description, p.tags_json AS tagsJson, p.is_public AS isPublic, ' +
        'p.saves, p.updated_at AS updatedAt, ' +
        '(SELECT COUNT(*) FROM public_playlist_items i WHERE i.playlist_id = p.id) AS itemCount ' +
        'FROM public_playlists p WHERE p.owner_id = ? ORDER BY p.updated_at DESC LIMIT 100')
        .bind(puser.id).all();
      return new Response(JSON.stringify({ playlists: r.results || [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let pbody = {};
    try { pbody = await request.json(); } catch (e) { pbody = {}; }

    // POST /api/playlists/publish { playlist, title?, description?, tags?, public?, publicId? }
    // playlist: { name, items: [...] } snapshot from the client library.
    // Idempotent when publicId (owner-checked) is supplied: replaces items.
    // shiur_ids are charset-validated (XSS-safe hrefs downstream).
    const validShiurId = sid => /^[A-Za-z0-9_-]{1,32}$/.test(String(sid || ''));
    if (url.pathname === '/api/playlists/publish' && request.method === 'POST') {
      const pl = (pbody && pbody.playlist) || {};
      const rawItems = Array.isArray(pl.items) ? pl.items.filter(x => x && x.id) : [];
      if (rawItems.length === 0) {
        return new Response(JSON.stringify({ error: 'empty playlist' }), {
          status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      if (rawItems.length > 500) {
        return new Response(JSON.stringify({ error: 'too many items (max 500)' }), {
          status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const cleanTags = { teachers: [], venues: [], topics: [] };
      const tg = (pbody && pbody.tags) || {};
      let tagTotal = 0;
      for (const k of ['teachers', 'venues', 'topics']) {
        if (Array.isArray(tg[k])) {
          for (const t of tg[k]) {
            if (tagTotal >= 20) break;
            const nm = String((t && t.name) || '').slice(0, 80);
            if (!nm) continue;
            cleanTags[k].push({ id: String((t && t.id) || ''), name: nm });
            tagTotal++;
          }
        }
      }
      const title = String(pbody.title || pl.name || 'Untitled').slice(0, 60);
      const description = String(pbody.description || '').slice(0, 500);
      const isPublic = pbody.public !== false;
      const isDev = (puser.id === 'dev' || request.headers.get('x-dev-mode') === '1');
      const authorPseudonym = (isDev && pbody.author) ? String(pbody.author).trim().slice(0, 40) : null;
      const ownerName = authorPseudonym || String(puser.name || 'Anonymous').slice(0, 40);
      let pid = String((pbody && pbody.publicId) || '');
      if (pid) {
        const owned = await db.prepare('SELECT owner_id FROM public_playlists WHERE id = ?').bind(pid).first();
        if (!owned || (owned.owner_id !== puser.id && !isDev)) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (isDev && authorPseudonym) {
          await db.prepare(
            'UPDATE public_playlists SET title = ?, description = ?, tags_json = ?, is_public = ?, owner_name = ?, updated_at = ? WHERE id = ?')
            .bind(title, description, JSON.stringify(cleanTags), isPublic ? 1 : 0, authorPseudonym, now, pid).run();
        } else {
          await db.prepare(
            'UPDATE public_playlists SET title = ?, description = ?, tags_json = ?, is_public = ?, updated_at = ? WHERE id = ?')
            .bind(title, description, JSON.stringify(cleanTags), isPublic ? 1 : 0, now, pid).run();
        }
        await db.prepare('DELETE FROM public_playlist_items WHERE playlist_id = ?').bind(pid).run();
      } else {
        pid = randomToken(12);
        await db.prepare(
          'INSERT INTO public_playlists (id, owner_id, owner_name, title, description, tags_json, is_public, saves, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
          .bind(pid, puser.id, ownerName,
            title, description, JSON.stringify(cleanTags), isPublic ? 1 : 0, now, now).run();
      }
      const batch = [];
      let pos = 0;
      for (const it of rawItems) {
        if (!validShiurId(it.id)) continue;
        const isSeries = it.kind === 'series' && Array.isArray(it.items) && it.items.length > 0;
        if (isSeries) {
          batch.push(db.prepare(
            'INSERT INTO public_playlist_items (playlist_id, shiur_id, position, title, speaker, photo, duration, kind, items_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(pid, 'series:' + pid + ':' + pos, pos++,
              String(it.seriesTitle || it.title || 'Series').slice(0, 200),
              String(it.speaker || '').slice(0, 120), '', '',
              'series', JSON.stringify(it.items.filter(s => s && validShiurId(s.id)).slice(0, 200).map(s => ({
                id: String(s.id), title: String(s.title || 'Untitled').slice(0, 200),
                speaker: String(s.speaker || 'YUTorah').slice(0, 120),
                photo: String(s.photo || '').slice(0, 300), duration: String(s.duration || '').slice(0, 40)
              })))));
        } else {
          batch.push(db.prepare(
            'INSERT INTO public_playlist_items (playlist_id, shiur_id, position, title, speaker, photo, duration, kind, items_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(pid, String(it.id), pos++,
              String(it.title || 'Untitled').slice(0, 200), String(it.speaker || 'YUTorah').slice(0, 120),
              String(it.photo || '').slice(0, 300), String(it.duration || '').slice(0, 40),
              'shiur', '[]'));
        }
      }
      await db.batch(batch);
      return new Response(JSON.stringify({ id: pid }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // POST /api/playlists/unpublish { id } (owner only; also drops saves).
    if (url.pathname === '/api/playlists/unpublish' && request.method === 'POST') {
      const pid = String((pbody && pbody.id) || '');
      const row = await db.prepare('SELECT owner_id FROM public_playlists WHERE id = ?').bind(pid).first();
      if (!row || row.owner_id !== puser.id) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      await db.prepare('DELETE FROM playlist_saves WHERE playlist_id = ?').bind(pid).run();
      await db.prepare('DELETE FROM public_playlist_items WHERE playlist_id = ?').bind(pid).run();
      await db.prepare('DELETE FROM public_playlists WHERE id = ?').bind(pid).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // POST /api/playlists/save { id } → returns snapshot for local import;
    // POST /api/playlists/unsave { id } removes the save mark.
    if ((url.pathname === '/api/playlists/save' || url.pathname === '/api/playlists/unsave') && request.method === 'POST') {
      const pid = String((pbody && pbody.id) || '');
      const row = await db.prepare(
        'SELECT id, title, description, owner_name AS ownerName FROM public_playlists WHERE id = ? AND is_public = 1').bind(pid).first();
      if (!row) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      if (url.pathname === '/api/playlists/save') {
        await db.prepare('INSERT INTO playlist_saves (user_id, playlist_id, created_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(user_id, playlist_id) DO NOTHING').bind(puser.id, pid, now).run();
        await db.prepare('UPDATE public_playlists SET saves = (SELECT COUNT(*) FROM playlist_saves WHERE playlist_id = ?) WHERE id = ?')
          .bind(pid, pid).run();
        const items = await db.prepare(
          'SELECT shiur_id AS id, title, speaker, photo, duration, kind, items_json AS itemsJson FROM public_playlist_items WHERE playlist_id = ? ORDER BY position')
          .bind(pid).all();
        for (const it of (items.results || [])) {
          if (it.kind === 'series') {
            try { it.items = JSON.parse(it.itemsJson || '[]'); } catch (e) { it.items = []; }
            it.seriesTitle = it.title || 'Series';
            delete it.itemsJson;
          }
        }
        return new Response(JSON.stringify({
          playlist: { name: row.title, description: row.description, ownerName: row.ownerName || '', items: items.results || [] }
        }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      await db.prepare('DELETE FROM playlist_saves WHERE user_id = ? AND playlist_id = ?').bind(puser.id, pid).run();
      await db.prepare('UPDATE public_playlists SET saves = (SELECT COUNT(*) FROM playlist_saves WHERE playlist_id = ?) WHERE id = ?')
        .bind(pid, pid).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // ---- POST /api/sync: merge client state (last-write-wins per item) ----
  if (request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'bad json' }), {
        status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    const now = Date.now();
    const prog = body.progress && typeof body.progress === 'object' ? body.progress : {};

    // History (+ progress folded in). listen_count increments on INSERT
    // only — metadata re-pushes must not inflate it. History syncs only
    // when the client marks it dirty (see body.dirty).
    const dirty = (body.dirty && typeof body.dirty === 'object') ? body.dirty : null;
    const dirtyHistory = dirty ? dirty.history === true : Array.isArray(body.history);
    if (dirtyHistory && Array.isArray(body.history)) {
      for (const h of body.history.slice(0, 500)) {
        if (!h || !h.id) continue;
        const sid = String(h.id);
        const pr = prog[sid] || {};
        const lastListened = Number(h.listenedAt || pr.lastListened || now);
        const existing = await db.prepare(
          'SELECT last_listened_at, progress_seconds, duration_seconds, completed ' +
          'FROM listening_history WHERE user_id = ? AND shiur_id = ?')
          .bind(user.id, sid).first();
        if (existing && Number(existing.last_listened_at || 0) >= lastListened) continue;
        // Never clobber stored progress with an empty record: a newer listen
        // without progress data keeps the saved position/completion.
        const incomingHasProgress = Number(pr.progressSec || 0) > 0 || pr.completed;
        const keepProgress = existing && !incomingHasProgress &&
          (Number(existing.progress_seconds || 0) > 0 || existing.completed);
        const finalProgSec = keepProgress ? Number(existing.progress_seconds || 0) : Number(pr.progressSec || 0);
        const finalDurSec = keepProgress ? Number(existing.duration_seconds || 0) : Number(pr.durationSec || 0);
        const finalCompleted = keepProgress ? (existing.completed ? 1 : 0) : (pr.completed ? 1 : 0);
        await db.prepare(
          'INSERT INTO listening_history (user_id, shiur_id, title, speaker, photo, duration, date_iso, date_display, ' +
          'category, is_article, progress_seconds, duration_seconds, completed, last_listened_at, listen_count) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ' +
          'ON CONFLICT(user_id, shiur_id) DO UPDATE SET title=excluded.title, speaker=excluded.speaker, ' +
          'photo=excluded.photo, duration=excluded.duration, date_iso=excluded.date_iso, date_display=excluded.date_display, ' +
          'category=excluded.category, is_article=excluded.is_article, ' +
          'progress_seconds=excluded.progress_seconds, duration_seconds=excluded.duration_seconds, ' +
          'completed=excluded.completed, last_listened_at=excluded.last_listened_at')
          .bind(user.id, sid, String(h.title || 'Untitled'), String(h.speaker || 'YUTorah'),
            String(h.photo || ''), String(h.duration || ''), String(h.dateISO || h.date || ''),
            String(h.date || ''), String(h.category || ''), h.isArticle ? 1 : 0,
            finalProgSec, finalDurSec, finalCompleted,
            lastListened).run();
      }
    }

    // Playlists + queue: ONLY collections named in body.dirty are touched.
    // A dirty key is authoritative for that list (delete-missing + upsert);
    // anything else leaves server rows alone. Without an explicit dirty
    // flag, an empty device would wipe the cloud — hence the requirement.
    // (Legacy clients without body.dirty fall back to presence semantics.)
    const hasPlaylists = dirty
      ? dirty.playlists === true
      : (body.playlists && typeof body.playlists === 'object' &&
        (Object.keys(body.playlists).length > 0));
    const hasQueue = dirty
      ? dirty.queue === true
      : (Array.isArray(body.queue) && body.queue.length > 0);
    if (hasPlaylists || hasQueue) {
      const pls = hasPlaylists ? body.playlists : {};
      const incoming = [];
      let customTotal = 0;
      const pushList = (key, arr, cap) => {
        if (!Array.isArray(arr)) return;
        arr.slice(0, cap || 500).forEach((it, i) => {
          if (it && (it.id || (it.kind === 'series' && Array.isArray(it.items)))) {
            incoming.push({ key, it, i });
          }
        });
      };
      if (hasPlaylists) {
        pushList('save_for_later', pls.save_for_later);
        pushList('favorites', pls.favorites);
        if (pls.custom && typeof pls.custom === 'object') {
          for (const [name, arr] of Object.entries(pls.custom)) {
            if (typeof name !== 'string' || !name) continue;
            if (customTotal + (Array.isArray(arr) ? arr.length : 0) > 2000) break;
            customTotal += Array.isArray(arr) ? arr.length : 0;
            pushList('custom:' + name.slice(0, 60), arr);
          }
        }
      }
      // Queue members (incl. expanded series rows) replace the queue wholesale.
      let queueRows = [];
      if (hasQueue) {
        queueRows = queueEntriesToRows(user.id, body.queue);
      }
      const touched = new Set();
      if (hasPlaylists) {
        touched.add('save_for_later');
        touched.add('favorites');
        for (const r of incoming) touched.add(r.key);
        const existingCustoms = await db.prepare(
          "SELECT DISTINCT playlist FROM playlist_items WHERE user_id = ? AND playlist LIKE 'custom:%'")
          .bind(user.id).all();
        for (const r of (existingCustoms.results || [])) touched.add(r.playlist);
      }
      if (hasQueue) touched.add('queue');
      const keep = new Set();
      const upserts = [];
      for (const { key, it, i } of incoming) {
        upserts.push(snapItemToRow(user.id, key, it, i));
        keep.add(key + '|' + String(it.id || ''));
      }
      for (const r of queueRows) {
        upserts.push(r);
        keep.add('queue|' + r.shiur_id);
      }
      const existing = await db.prepare(
        'SELECT playlist, shiur_id FROM playlist_items WHERE user_id = ?').bind(user.id).all();
      for (const r of (existing.results || [])) {
        if (touched.has(r.playlist) && !keep.has(r.playlist + '|' + r.shiur_id)) {
          await db.prepare('DELETE FROM playlist_items WHERE user_id = ? AND playlist = ? AND shiur_id = ?')
            .bind(user.id, r.playlist, r.shiur_id).run();
        }
      }
      for (const r of upserts) {
        await db.prepare(
          'INSERT INTO playlist_items (user_id, playlist, shiur_id, position, title, speaker, photo, duration, ' +
          'date_display, category, is_article, series_title, cover_id, kind, added_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, playlist, shiur_id) DO UPDATE SET position=excluded.position, title=excluded.title, ' +
          'speaker=excluded.speaker, photo=excluded.photo, duration=excluded.duration, date_display=excluded.date_display, ' +
          'category=excluded.category, is_article=excluded.is_article, series_title=excluded.series_title, ' +
          'cover_id=excluded.cover_id, kind=excluded.kind, added_at=MAX(playlist_items.added_at, excluded.added_at)')
          .bind(r.user_id, r.playlist, r.shiur_id, r.position, r.title, r.speaker, r.photo,
            r.duration, r.date_display || '', r.category || '', r.is_article ? 1 : 0,
            r.series_title, r.cover_id || '', r.kind, r.added_at).run();
      }
    }

    await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, user.id).run();
    const state = await pullUserState(db, user.id);
    return new Response(JSON.stringify({ user, ...state }), {
      headers: {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
        'Set-Cookie': refreshCookie
      }
    });
  }

  return new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

const TARGET_API_ORIGIN = 'https://www.yutorah.org';
const API_ORIGIN = 'https://api.yutorah.org';

// Decode HTML entities from scraped upstream text BEFORE our own escaping,
// or sequences like l&#x27;ilui double-escape into visible "l&#x27;ilui".
// &amp; decodes LAST so double-encoded input (&amp;lt;) survives correctly.
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#x27;|&#39;|&#x22;|&quot;|&lt;|&gt;/gi, m => {
      const k = m.toLowerCase();
      if (k === '&#x27;' || k === '&#39;') return "'";
      if (k === '&#x22;' || k === '&quot;') return '"';
      if (k === '&lt;') return '<';
      return '>';
    })
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi, '&');
}

// In-memory cache for homepage collections (5 minutes)
let homeDataCache = null;
let homeDataCacheTime = 0;
// Facet-count cache (signature -> { at, body }), 60s TTL, capped at 50.
const facetCache = new Map();

async function getHomepageData() {
  const now = Date.now();
  if (homeDataCache && (now - homeDataCacheTime < 300000)) {
    return homeDataCache;
  }
  try {
    const res = await fetch(`${API_ORIGIN}/homepage/details`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (res.ok) {
      homeDataCache = await res.json();
      homeDataCacheTime = now;
      return homeDataCache;
    }
  } catch (e) {
    console.error('Error fetching homepage data:', e);
  }
  return homeDataCache;
}

// In-memory cache for live daily sponsorship (5 minutes)
let sponsorshipCache = null;
let sponsorshipCacheTime = 0;

async function getDailySponsorship() {
  const now = Date.now();
  if (sponsorshipCache && (now - sponsorshipCacheTime < 300000)) {
    return sponsorshipCache;
  }
  let result = {
    text: '',
    plainText: '',
    audioUrl: ''
  };

  // 1. Fetch live daily text banner from YUTorah
  try {
    const res = await fetch('https://www.yutorah.org/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/Learning on the Marcos and Adina Katz YUTorah site is sponsored today[\s\S]*?<\/p>/i);
      if (match) {
        const nameMatch = match[0].match(/id="sponsorSpan_sponsorName">([\s\S]*?)<\/span>/i);
        const sponsorName = nameMatch ? decodeHtmlEntities(nameMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
        const fullText = decodeHtmlEntities(match[0].replace(/<\/p>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

        result.plainText = fullText;
        let formatted = escapeHtml(fullText);
        if (sponsorName && fullText.includes(sponsorName)) {
          const parts = fullText.split(sponsorName);
          formatted = escapeHtml(parts[0]) + '<strong>' + escapeHtml(sponsorName) + '</strong>' + escapeHtml(parts.slice(1).join(sponsorName));
        } else {
          // OG highlights the dedication itself (prefix + sponsor text spans)
          // even when no separate sponsorName span is present: bold everything
          // from the dedication prefix onward.
          const seg = match[0].match(/id="sponsorSpan_prefix">([\s\S]*?)<\/span>\s*<span[^>]*id="sponsorSpan_sponsorText">([\s\S]*?)<\/span>/i);
          if (seg) {
            const prefix = decodeHtmlEntities(seg[1].replace(/<[^>]+>/g, '').trim());
            const at = prefix ? fullText.indexOf(prefix) : -1;
            if (at >= 0) {
              formatted = escapeHtml(fullText.slice(0, at)) + '<strong>' + escapeHtml(fullText.slice(at)) + '</strong>';
            }
          }
        }
        result.text = formatted;
      }
    }
  } catch (e) {
    console.error('Error fetching live sponsorship HTML:', e);
  }

  // 2. Query official YUTorah Live Sponsorship Audio API
  // Exactly as YUTorah's frontend does: GET https://api.yutorah.org/browse/sponsorship/audio
  try {
    const audioApiRes = await fetch('https://api.yutorah.org/browse/sponsorship/audio', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
      }
    });
    if (audioApiRes.ok) {
      let liveUrl = (await audioApiRes.text()).trim();
      if (liveUrl && /^https?:\/\//i.test(liveUrl) && !liveUrl.includes('112521.mp3')) {
        liveUrl = liveUrl.replace('http://cdn.yutorah.net/', 'https://cdn.yutorah.net/');
        liveUrl = liveUrl.replace('http://www.yutorah.org/_cdn/', 'https://cdn.yutorah.net/');
        liveUrl = liveUrl.replace('https://www.yutorah.org/_cdn/', 'https://cdn.yutorah.net/');
        // Verify that the audio URL is active and accessible
        try {
          const headCheck = await fetch(liveUrl, { method: 'HEAD', redirect: 'follow' });
          if (headCheck.ok) {
            result.audioUrl = liveUrl;
          }
        } catch (hErr) {
          console.warn('Live API audio URL head check failed:', hErr);
        }
      }
    }
  } catch (apiErr) {
    console.error('Error fetching from https://api.yutorah.org/browse/sponsorship/audio:', apiErr);
  }

  // 3. Fallback: Check today's and recent days' MMDDYY.mp3 files on CDN
  if (!result.audioUrl) {
    try {
      const nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: '2-digit',
        month: '2-digit',
        day: '2-digit'
      });
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const targetDate = new Date(Date.now() - dayOffset * 86400000);
        const parts = nyFormatter.formatToParts(targetDate);
        const mm = parts.find(p => p.type === 'month')?.value;
        const dd = parts.find(p => p.type === 'day')?.value;
        const yy = parts.find(p => p.type === 'year')?.value;

        if (mm && dd && yy) {
          const checkUrl = `https://cdn.yutorah.net/_media/sponsorshipAudio/${mm}${dd}${yy}.mp3`;
          const head = await fetch(checkUrl, { method: 'HEAD', redirect: 'follow' });
          if (head.ok) {
            result.audioUrl = checkUrl;
            break;
          }
        }
      }
    } catch (dateErr) {
      console.error('Error checking date-based sponsorship audio:', dateErr);
    }
  }

  // 4. Safe verified fallback if no audio URL could be reached
  if (!result.audioUrl) {
    result.audioUrl = 'https://cdn.yutorah.net/_media/sponsorshipAudio/081726.mp3';
  }

  // Fallback if live HTML fetch fails or no current sponsor
  if (!result.text) {
    result.text = 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by <strong>The Ohayon family in Hamilton, ON</strong> to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra';
    result.plainText = 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by The Ohayon family in Hamilton, ON to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra';
  }

  sponsorshipCache = result;
  sponsorshipCacheTime = now;
  return sponsorshipCache;
}

// Fallback featured shiurim if API is unreachable
const FALLBACK_SHIURIM = [
  {
    id: '1187082',
    title: 'The Power of לדוד',
    speaker: 'Rabbi Noach Goldstein',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/noach_goldstein.jpg',
    duration: '46 min',
    category: 'Elul / Machshava'
  },
  {
    id: '1187083',
    title: '13 Middot Explainer: Understanding Each Middah',
    speaker: 'Rabbi Moshe Taragin',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/mtaragin.jpg',
    duration: '1h 48m',
    category: 'Yeshivat Har Etzion'
  },
  {
    id: '1187202',
    title: 'Chassidus on Teshuva - Kedushas Levi',
    speaker: 'Mrs. Emma Katz',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/emma_katz.jpg',
    duration: '10 min',
    category: 'Chicago Kollel'
  },
  {
    id: '1187183',
    title: "Tehilim 81: Shir shel Yom of Rosh ha'Shanah",
    speaker: 'Rabbi Matt Schneeweiss',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/matt_schneeweiss.jpg',
    duration: '1h 3m',
    category: 'Nach'
  },
  {
    id: '1186969',
    title: 'Selichos 5786',
    speaker: 'Rabbi Hershel Schachter',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/hershel_schachter.jpg',
    duration: '1h 12m',
    category: 'Yamim Noraim'
  },
  {
    id: '1186958',
    title: 'The Role of the Shofar in the Avodah of Rosh Hashanah',
    speaker: 'Rabbi Michael Rosensweig',
    photo: 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/michael_rosensweig.jpg',
    duration: '1h 22m',
    category: 'Rosh Hashanah'
  }
];

async function executeSearchInternal(searchParams) {
  const rawQ = searchParams.get('q') || searchParams.get('searchTerm') || searchParams.get('search') || '';

  // Parse single or multi-valued IDs (can be passed as repeated params e.g. teacherId=A&teacherId=B or comma-separated)
  function extractIdList(paramName, aliasName) {
    const vals = [];
    const directList = searchParams.getAll(paramName);
    for (const v of directList) {
      if (v) vals.push(...v.split(',').map(s => s.trim()).filter(Boolean));
    }
    if (aliasName) {
      const aliasList = searchParams.getAll(aliasName);
      for (const v of aliasList) {
        if (v) vals.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      }
    }
    return [...new Set(vals)];
  }

  let teacherIds = extractIdList('teacherId');
  const subCategoryIds = extractIdList('subCategoryId');
  const locationIds = extractIdList('locationId', 'venueId');
  const seriesIds = extractIdList('seriesId', 'series');
  let start = parseInt(searchParams.get('page') || searchParams.get('start') || '1', 10);
  // Raw item offset, captured BEFORE page normalization — the date branch
  // (sort=date) treats `start` as a 1-based item offset, not a page.
  const rawItemStart = Math.max(parseInt(searchParams.get('start') || '1', 10) || 1, 1);
  if (!searchParams.has('page') && start > 30) {
    start = Math.floor((start - 1) / 30) + 1;
  }
  const disablePhonetics = searchParams.get('exact') === '1' || searchParams.get('classic') === '1';

  // Advanced post-filters
  const minDuration = searchParams.get('minDuration') ? parseInt(searchParams.get('minDuration'), 10) : null;
  const maxDuration = searchParams.get('maxDuration') ? parseInt(searchParams.get('maxDuration'), 10) : null;
  const year = searchParams.get('year') || '';
  const fromDate = searchParams.get('fromDate') || '';
  const toDate = searchParams.get('toDate') || '';
  const mediaType = (searchParams.get('mediaType') || searchParams.get('media') || '').toLowerCase(); // 'all' | 'audio' | 'article' | 'text'

  // Recency sort (ROADMAP §7: Recent Results + §10 P4 sort control).
  // `sort=date|recent` or `sortIndex=1` returns date-descending windows.
  // `start` is then a 1-based ITEM offset (not a page) and `rows` the window size.
  const sortParamRaw = (searchParams.get('sort') || '').toLowerCase();
  const sortParam = (sortParamRaw === 'date' || sortParamRaw === 'recent' ||
    sortParamRaw === 'newest' || sortParamRaw === 'oldest' || sortParamRaw === 'relevance') ? sortParamRaw : '';
  const isRelevanceSort = !sortParam || sortParam === 'relevance';
  const sortOldest = sortParam === 'oldest';
  const wantsDateSort = sortParam === 'date' || sortParam === 'recent' || sortParam === 'newest' || sortParam === 'oldest' || searchParams.get('sortIndex') === '1';
  const rows = Math.min(Math.max(parseInt(searchParams.get('rows') || '30', 10) || 30, 1), 30);

  // Partition helper: on first-page relevance queries, lift the 3 freshest
  // docs into `recentDocs` and dedupe them out of the relevance list.
  function docDateStr(d) {
    return String(d.shiurdate || d.shiurdatesubmitted || d.shiurDate || d.shiurDateSubmitted || '');
  }
  function docIdStr(d) {
    return String(d.shiurID || d.shiurid || d.id || '');
  }
  function partitionRecent(docs, numFound) {
    if (start !== 1 || !isRelevanceSort || !docs || docs.length === 0) {
      return { docs: docs || [], recentDocs: [], recentNumFound: 0 };
    }
    // Top-3 freshest as an EXTRA rail; the relevance list keeps all 30.
    const byDate = [...docs].sort((a, b) => docDateStr(b).localeCompare(docDateStr(a)));
    return { docs, recentDocs: byDate.slice(0, 3), recentNumFound: numFound };
  }
  // Fuzzy fallback (ROADMAP §5.4): ranked teacher/topic/venue candidates for
  // the raw query — consumed by the "Did you mean …?" strip + /api/suggest.
  // Suggestions identical to the query itself are dropped (no pointless strip).
  function didYouMeanFor() {
    try {
      const ql = String(rawQ || '').trim().toLowerCase();
      return suggestDidYouMean(rawQ, {
        teacher: AUTOCOMPLETE_META.teachers || [],
        topic: AUTOCOMPLETE_META.categories || [],
        venue: AUTOCOMPLETE_META.venues || []
      }, { limit: 5 }).filter(s => String(s.text || '').trim().toLowerCase() !== ql);
    } catch (e) {
      return [];
    }
  }

  function isDocArticle(doc) {
    if (!doc) return false;
    const mediaCat = (doc.mediatypecategory || doc.mediaTypeCategory || '').toLowerCase();
    const urlCheck = doc.shiururl || doc.shiurURL || doc.playerDownloadURL || doc.downloadURL || '';
    return mediaCat === 'text' || mediaCat === 'article' || /[.]pdf($|[?])/i.test(urlCheck);
  }

  // NO speaker auto-resolution: every query is plain text unless the user
  // sets an explicit teacher filter (chips, suggestion click, bio page).
  // "rosensweig" and "rosensweig shabbos" both match every Rosensweig via
  // text search. The only rewrite is the typo auto-correct below, which
  // fires solely when nothing literally matches.
  let effectiveQuery = rawQ;
  let expandedInfo = null;
  // When the engine rewrites the user's text (typo auto-correct only), the
  // UI shows a "Showing results for X (you searched Y)" disclaimer.
  let resolvedDisplay = '';
  const rawWordCount = rawQ.trim() ? rawQ.trim().split(/\s+/).length : 0;

  if (year && /^\d{4}$/.test(year)) {
    effectiveQuery = effectiveQuery ? `${effectiveQuery} ${year}` : year;
  }

  if (effectiveQuery && !disablePhonetics) {
    expandedInfo = expandQueryWithPhonetics(effectiveQuery);
    effectiveQuery = expandedInfo.solrQuery;
  }

  const filterMedia = (mediaType === 'audio' || mediaType === 'article' || mediaType === 'text');
  const hasPostFilter = (minDuration !== null) || (maxDuration !== null) || year || fromDate || toDate || filterMedia;

  function matchesPostFilters(doc) {
    if (!doc) return false;
    if (mediaType === 'audio' && isDocArticle(doc)) return false;
    if ((mediaType === 'article' || mediaType === 'text') && !isDocArticle(doc)) return false;

    const dur = typeof doc.duration === 'number' ? doc.duration : 0;
    if (minDuration !== null && minDuration > 0 && dur < minDuration) return false;
    if (maxDuration !== null && maxDuration > 0 && dur > maxDuration) return false;

    const docDate = doc.shiurdate || doc.shiurdatesubmitted || '';
    if (year) {
      if (year === 'pre-2000') {
        const docYear = docDate ? parseInt(docDate.slice(0, 4), 10) : 0;
        if (docYear >= 2000) return false;
      } else if (year === 'pre-2010') {
        const docYear = docDate ? parseInt(docDate.slice(0, 4), 10) : 0;
        if (docYear >= 2010) return false;
      } else if (year === '2010-2019') {
        const docYear = docDate ? parseInt(docDate.slice(0, 4), 10) : 0;
        if (docYear < 2010 || docYear > 2019) return false;
      } else {
        if (!docDate.startsWith(year)) return false;
      }
    }

    // Date bounds compare at the bound's own precision: date-only bounds
    // compare YYYY-MM-DD; datetime bounds compare through minutes.
    // Unknown doc dates pass (same as before).
    if (fromDate && docDate) {
      const L = Math.min(fromDate.length, 16);
      if (docDate.slice(0, L) < fromDate.slice(0, L)) return false;
    }
    if (toDate && docDate) {
      const L = Math.min(toDate.length, 16);
      if (docDate.slice(0, L) > toDate.slice(0, L)) return false;
    }

    return true;
  }

  async function fetchSolrSingle(query, startOffset, tId, catId, locId, sId) {
    let targetUrl = `${API_ORIGIN}/search?searchTerm=${encodeURIComponent(query)}&start=${encodeURIComponent(startOffset)}`;
    if (tId) targetUrl += `&teacherId=${encodeURIComponent(tId)}`;
    if (catId) targetUrl += `&subCategoryId=${encodeURIComponent(catId)}`;
    if (locId) targetUrl += `&locationId=${encodeURIComponent(locId)}`;
    if (sId) targetUrl += `&seriesId=${encodeURIComponent(sId)}`;

    try {
      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        }
      });
      if (!upstream.ok) return { docs: [], numFound: 0 };
      const json = await upstream.json();
      return {
        docs: json?.response?.docs || [],
        numFound: json?.response?.numFound || 0
      };
    } catch (e) {
      // Per-page failure must never fail the whole search (fanout safety).
      return { docs: [], numFound: 0 };
    }
  }

  // Shared date-window fetcher: fans out over the first few upstream pages
  // with identical filters, merges + dedupes, applies post-filters, sorts by
  // date descending, and slices [itemOffset, itemOffset + rowCount).
  // Returns { windowDocs, totalFound }. Upstream Solr has no reliable
  // date-sort param, hence the merge-sort over relevance pages.
  async function fetchDateWindow(query, itemOffset, rowCount) {
    const tId = teacherIds[0] || '';
    const catId = subCategoryIds[0] || '';
    const locId = locationIds[0] || '';
    const sId = seriesIds[0] || '';
    const multiEntities = [];
    if (teacherIds.length > 1) teacherIds.forEach(id => multiEntities.push({ tId: id, catId, locId, sId }));
    else if (subCategoryIds.length > 1) subCategoryIds.forEach(id => multiEntities.push({ tId, catId: id, locId, sId }));
    else if (locationIds.length > 1) locationIds.forEach(id => multiEntities.push({ tId, catId, locId: id, sId }));
    else if (seriesIds.length > 1) seriesIds.forEach(id => multiEntities.push({ tId, catId, locId, sId: id }));
    const entities = multiEntities.length > 0 ? multiEntities : [{ tId, catId, locId, sId }];
    const pagesToCover = Math.min(4, Math.ceil((itemOffset + rowCount) / 30) + 1);
    const fanout = [];
    for (const ent of entities) {
      for (let p = 1; p <= pagesToCover; p++) {
        fanout.push(fetchSolrSingle(query, p, ent.tId, ent.catId, ent.locId, ent.sId));
      }
    }
    const settled = await Promise.all(fanout);
    const seen = new Set();
    let merged = [];
    // Total = sum of each entity's FIRST-page numFound. Every page of the
    // same entity reports the identical upstream total — summing all pages
    // would inflate the count up to 4x.
    let totalFound = 0;
    for (let e = 0; e < entities.length; e++) {
      const first = settled[e * pagesToCover];
      if (first) totalFound += first.numFound || 0;
    }
    for (const r of settled) {
      for (const doc of r.docs) {
        const docTeacherId = String(doc.teacherid || doc.teacherId || '');
        if ((teacherIds.length === 0 || teacherIds.includes(docTeacherId)) && matchesPostFilters(doc)) {
          const id = docIdStr(doc);
          if (id) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          merged.push(doc);
        }
      }
    }
    merged.sort((a, b) => sortOldest
      ? docDateStr(a).localeCompare(docDateStr(b))
      : docDateStr(b).localeCompare(docDateStr(a)));
    return { windowDocs: merged.slice(itemOffset - 1, itemOffset - 1 + rowCount), totalFound: totalFound || merged.length };
  }

  // Date-sorted window branch (powers the Recent Results rail).
  // `start` here is a 1-based ITEM offset (rawItemStart, pre-normalization).
  if (wantsDateSort) {
    const itemOffset = rawItemStart;
    const { windowDocs, totalFound } = await fetchDateWindow(effectiveQuery, itemOffset, rows);
    return {
      response: {
        docs: windowDocs,
        numFound: totalFound,
        start: itemOffset,
        sort: 'date'
      },
      phoneticExpansion: null,
      didYouMean: didYouMeanIfWeak(windowDocs.length),
      queryResolution: resolvedDisplay ? { original: rawQ, display: resolvedDisplay } : null
    };
  }

  const isMultiTeacher = teacherIds.length > 1;
  const isMultiLocation = locationIds.length > 1;
  const isMultiCategory = subCategoryIds.length > 1;
  const isMultiTarget = isMultiTeacher || isMultiLocation || isMultiCategory;

  // Weak-hit threshold: at or below this many UNIQUE total hits we also
  // return fuzzy candidates so the UI can render a "Did you mean …?" strip
  // (above the message when zero hits, below the list when 1+ weak hits).
  // Recent/relevance rails may overlap (no carve-out), so shared ids count once.
  function undupedHitCount(docs, recentDocs) {
    const ids = new Set();
    for (const d of (recentDocs || [])) {
      const id = docIdStr(d);
      if (id) ids.add(id);
    }
    let n = (recentDocs || []).length;
    for (const d of (docs || [])) {
      const id = docIdStr(d);
      if (!id || !ids.has(id)) n++;
    }
    return n;
  }
  // Fewer than 10 hits: show results AND a "Did you mean …?" strip on top.
  function didYouMeanIfWeak(totalHits) {
    try {
      return totalHits < 10 ? didYouMeanFor() : [];
    } catch (e) {
      return [];
    }
  }
  // Zero literal matches + a distance-1 correction: surface the notice
  // even when phonetic expansion filled the page (no rewrite — the strip
  // click runs the corrected search). This is the weiderblank case.
  function zeroLiteralNotice(docs, teacherIdsEmpty) {
    if (start !== 1 || rawWordCount !== 1 || disablePhonetics || !teacherIdsEmpty) return [];
    const ql = rawQ.toLowerCase();
    const docText = d => [
      d.shiurtitle, d.shiurTitle, d.title, d.teacherfullname,
      ((d.shiurTeachers || []).map(t => t.teacherFullName || '').join(' ')),
      d.shiurdescription, d.description, d.seriesname, d.seriesName,
      d.subcategoryname, d.categoryname,
      (Array.isArray(d.shiurkeywords) ? d.shiurkeywords.join(' ') : d.shiurkeywords)
    ].join(' ').toLowerCase();
    if ([...docs].some(d => docText(d).includes(ql))) return [];
    try {
      const sug = suggestDidYouMean(rawQ, {
        teacher: AUTOCOMPLETE_META.teachers || [],
        topic: AUTOCOMPLETE_META.categories || [],
        venue: AUTOCOMPLETE_META.venues || []
      }, { limit: 3 });
      return sug.filter(s => s.distance <= 1 && s.text.toLowerCase() !== ql);
    } catch (e) {
      return [];
    }
  }

  if (!isMultiTarget && !hasPostFilter) {
    const tId = teacherIds[0] || '';
    const catId = subCategoryIds[0] || '';
    const locId = locationIds[0] || '';
    const sId = seriesIds[0] || '';

    // Relevance page + global date window in parallel: the Recent rail
    // shows the 3 GLOBALLY freshest matches — relevance sort only (under
    // newest/oldest the list itself is chronological, so no rail).
    const mainPromise = fetchSolrSingle(effectiveQuery, start, tId, catId, locId, sId);
    const datePromise = (start === 1 && isRelevanceSort)
      ? fetchDateWindow(effectiveQuery, 1, 3)
      : Promise.resolve({ windowDocs: [], totalFound: 0 });
    const [{ docs, numFound }, { windowDocs: globalRecent, totalFound: recentTotal }] =
      await Promise.all([mainPromise, datePromise]);

    const filteredDocs = tId ? docs.filter(doc => {
      const docTeacherId = String(doc.teacherid || doc.teacherId || '');
      return docTeacherId === String(tId);
    }) : docs;

    const adjNumFound = tId ? Math.min(numFound, filteredDocs.length + (numFound - docs.length)) : numFound;
    // Relevance keeps its FULL page (30): the Recent-3 are an extra rail on
    // top, never carved out of the relevance list.
    // No auto-rewrites: every query shows its own matches. When hits are
    // thin (<10), didYouMeanIfWeak adds a "Did you mean …?" strip rendered
    // ON TOP, and clicking a suggestion runs that corrected search.
    const recentDocs = (start === 1 && isRelevanceSort) ? globalRecent : [];
    const totalHits = undupedHitCount(filteredDocs, recentDocs);
    let didYouMean = didYouMeanIfWeak(totalHits);
    if ((!didYouMean || didYouMean.length === 0) && teacherIds.length === 0) {
      const extra = zeroLiteralNotice([...filteredDocs, ...recentDocs], true);
      if (extra.length > 0) didYouMean = extra;
    }
    return {
      response: {
        docs: filteredDocs,
        recentDocs,
        recentNumFound: start === 1 ? (recentTotal || adjNumFound) : 0,
        numFound: adjNumFound,
        start
      },
      phoneticExpansion: (expandedInfo && expandedInfo.expandedTokens && expandedInfo.expandedTokens.length > 1) ? {
        original: rawQ,
        tokens: expandedInfo.expandedTokens,
        synset: expandedInfo.matchedSynset
      } : null,
      didYouMean,
      queryResolution: resolvedDisplay ? { original: rawQ, display: resolvedDisplay } : null
    };
  }

  // Multi-Target or Post-Filtering Path
  const targetPageSize = 30;
  let accumulatedDocs = [];
  let totalEstimatedFound = 0;

  if (isMultiTarget) {
    let branchingEntities = [];
    if (isMultiTeacher) {
      branchingEntities = teacherIds.map(id => ({ tId: id, catId: subCategoryIds[0] || '', locId: locationIds[0] || '', sId: seriesIds[0] || '' }));
    } else if (isMultiCategory) {
      branchingEntities = subCategoryIds.map(id => ({ tId: teacherIds[0] || '', catId: id, locId: locationIds[0] || '', sId: seriesIds[0] || '' }));
    } else if (isMultiLocation) {
      branchingEntities = locationIds.map(id => ({ tId: teacherIds[0] || '', catId: subCategoryIds[0] || '', locId: id, sId: seriesIds[0] || '' }));
    } else {
      branchingEntities = seriesIds.map(id => ({ tId: teacherIds[0] || '', catId: subCategoryIds[0] || '', locId: locationIds[0] || '', sId: id }));
    }

    const fetchPromises = branchingEntities.map(entity => {
      return fetchSolrSingle(effectiveQuery, start, entity.tId, entity.catId, entity.locId, entity.sId);
    });

    const results = await Promise.all(fetchPromises);
    const seenShiurIds = new Set();

    for (const res of results) {
      totalEstimatedFound += res.numFound;
      for (const doc of res.docs) {
        const docId = doc.shiurID || doc.shiurid || doc.id;
        if (docId && !seenShiurIds.has(docId)) {
          seenShiurIds.add(docId);
          const docTeacherId = String(doc.teacherid || doc.teacherId || '');
          const teacherMatches = teacherIds.length === 0 || teacherIds.includes(docTeacherId);
          if (teacherMatches && matchesPostFilters(doc)) {
            accumulatedDocs.push(doc);
          }
        }
      }
    }

    accumulatedDocs.sort((a, b) => {
      const dateA = a.shiurdate || a.shiurdatesubmitted || '';
      const dateB = b.shiurdate || b.shiurdatesubmitted || '';
      return dateB.localeCompare(dateA);
    });

    accumulatedDocs = accumulatedDocs.slice(0, targetPageSize);
  } else {
    const tId = teacherIds[0] || '';
    const catId = subCategoryIds[0] || '';
    const locId = locationIds[0] || '';
    const sId = seriesIds[0] || '';
    let curFetchStart = start;
    let iterations = 0;
    const maxIterations = (mediaType === 'article' || mediaType === 'text') ? 10 : 5;

    while (accumulatedDocs.length < targetPageSize && iterations < maxIterations) {
      iterations++;
      const { docs, numFound } = await fetchSolrSingle(effectiveQuery, curFetchStart, tId, catId, locId, sId);
      totalEstimatedFound = numFound;
      if (docs.length === 0) break;

      for (const doc of docs) {
        const docTeacherId = String(doc.teacherid || doc.teacherId || '');
        const teacherMatches = teacherIds.length === 0 || teacherIds.includes(docTeacherId);
        if (teacherMatches && matchesPostFilters(doc)) {
          accumulatedDocs.push(doc);
          if (accumulatedDocs.length >= targetPageSize) break;
        }
      }

      curFetchStart++;
      const totalPages = Math.ceil((numFound || 0) / 30);
      if (curFetchStart > totalPages || docs.length === 0) break;
    }
  }

  const partedFinal = partitionRecent(accumulatedDocs, totalEstimatedFound || accumulatedDocs.length);
  // Under post-filters the upstream total is unfiltered, so report the known
  // filtered pool size as the recent-match count instead of overstating it.
  const recentCountFinal = hasPostFilter
    ? (partedFinal.docs.length + partedFinal.recentDocs.length)
    : partedFinal.recentNumFound;
  const weakTotal = undupedHitCount(partedFinal.docs, partedFinal.recentDocs);
  let multiDidYouMean = didYouMeanIfWeak(weakTotal);
  if ((!multiDidYouMean || multiDidYouMean.length === 0) && teacherIds.length === 0) {
    const extraMulti = zeroLiteralNotice([...partedFinal.docs, ...partedFinal.recentDocs], true);
    if (extraMulti.length > 0) multiDidYouMean = extraMulti;
  }
  return {
    response: {
      docs: partedFinal.docs,
      recentDocs: partedFinal.recentDocs,
      recentNumFound: recentCountFinal,
      numFound: totalEstimatedFound || accumulatedDocs.length,
      filteredCount: partedFinal.docs.length,
      start
    },
    phoneticExpansion: expandedInfo ? {
      original: rawQ,
      tokens: expandedInfo.expandedTokens,
      synset: expandedInfo.matchedSynset
    } : null,
    didYouMean: multiDidYouMean,
    queryResolution: resolvedDisplay ? { original: rawQ, display: resolvedDisplay } : null
  };
}


// ============================================================================
// PROGRESSIVE WEB APP (PWA) MANIFEST, SERVICE WORKER & ASSETS
// ============================================================================

const PWA_MANIFEST = {
  id: "/",
  name: "YUTorah Player",
  short_name: "YUTorah",
  description: "Fast, high-performance Torah lecture player and search engine with offline caching and continuous audio streaming.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#0f141c",
  theme_color: "#2b4c7e",
  categories: ["education", "religion", "audio"],
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any"
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any"
    },
    {
      src: "/icons/icon-maskable-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable"
    },
    {
      src: "/icons/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable"
    },
    {
      src: "/icons/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable"
    }
  ]
};

const PWA_ICON_192_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAAXNSR0IB2cksfwAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABGdBTUEAALGPC/xhBQAAAwBQTFRFK0t+K0x+K0x/K01+LEx+LEx/LE1+LE1/LU1+LU1/LU5+LU5/LU6ALU+ALk1+Lk1/Lk5+Lk5/Lk9/L01/L05+L05/L06AL09+L09/L0+AL1B/ME5/ME9/ME+AMFB/MFCAMU9/MVB/MVCAMVF/MVGAMk+AMlB/MlCAMlF/MlGAMlGBMlKAM1B/M1CAM1F/M1GAM1GBM1J/M1KAM1OBNFGANFKANFKBNFOANVJ/NVKANVKBNVN/NVOANVOBNVSANlOANlOBNlSANlSBN1OAN1OBN1SAN1SBN1WAN1WBN1aBOFSAOFSBOFWAOFWBOFaBOFaCOVSAOVSBOVWAOVWBOVWCOVaAOVaBOVaCOlWBOlaAOlaBOlaCOleBOleCO1aBO1aCO1eBO1eCO1eDO1iCPFeBPFeCPFeDPFiBPFiCPFiDPVeCPViCPViDPVmCPVmDPliCPlmCPlmDPlqCPlqDP1mCP1mDP1qCP1qDQFqCQFqDQFuCQFuDQFuEQVqDQVqEQVuCQVuDQVuEQVyDQVyEQluCQluDQluEQlyDQlyEQ1uDQ1yDQ1yEQ12DQ12ERFyERF2DRF2ERF6ERVyDRV2ERV6DRV6ERV6FRV+ERl2DRl6DRl6ERl6FRl+ERl+FRmCER16ER1+DR1+ER1+FR2CESF6DSF6FSF+ESGCESGCFSGGFSV+FSWCESWCFSWCGSWGFSWGGSmCFSmCGSmGESmGFSmGGSmKFSmKGS2GFS2GGS2KFS2KGS2OFS2OGTGGFTGKFTGKGTGOFTGOGTWOFTWOGTWSGTWSHTmOGTmOHTmSFTmSGTmSHTmWGTmWHT2OGT2SFT2SGT2SHT2WGT2WHT2aHUGSGUGWGUGWHUGaGUGaHUWWGUWWHUWaGUWaHUWeHUmaGUmaHUmeHUmeIU2aGU2aHU2eGU2eHU2eIU2iHU2iIVGeHVGiGVGiHVGiIVGmHVGmIVWeGVWiHVWiIVWmHVWmIVmiHVmmHVmmIVmqHVmqIVmuIV2mHV2mIV2qHV2qIWGqIAP8AVYgwmAAAAQB0Uk5T////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////AFP3ByUAABAASURBVHic7Xx/VFNXvu/sk+M5iZn75HCbTuxEIBmXkudcM1Ij2oaB0AEZIX3vlhZ7oVRTS4sTtMGCkFKf0SmFIjR4Ie2D4tXIW4Aa0RqQknqJEEqNjqXYBnEIEC0pYJCmRDCiuevtE35TfioO667F9w9Z5pzs8/3s/f3x+e79PfkV+G8uv1poBR5XFgEstCwCWGhZBLDQsghgoWURwELLIoCFlkUACy2LABZaFgEstCwCWGhZBLDQsghgoWURwELLkwKAAEIoTqmyOvt+Lk+MXo8hT+g5TwAA/iv0aV7YXw0tNqdjwG4y2xwDzjvN2viA31PxJzBd8zokguCEV1iO5nKv856j33It7WX/5Uy/WJXJ2g9RdNac2L+BtRSZ38WYJwAIjgLM7c8HlA0PnM77D/sbcqVC2uhlVlSK6obT4XzovKfPTthEReZvLR5/IARBEZz9kji/ubvPed/xs74wXUDQhq8BHKCuKcfpbqEKzTXbwwEnvEf+ur87Pi8oHm8MBMHoHL5YdeWHAef9vk6jNkXgTR++iAOc4Hiysy/JWIDgsZeQ9zNWhytqTPceOh/aTDXpAWufxiiPaVGPDACqRyW4b35W1up0Ovrst8qSo9Zjw7hQhIIvYcXmFt24drjcpg9Eo4wlq0Y0XR70epah92en82G/oTQjzJOOUR59Hh/lm9DeqfQ/xO5XW51Qid6OcoWEg4/ggiaFCaQpyqojRR22boti9+mq0JW5jeUn8oLdhu+CZkUXvp9b13sXjuC4ptgrehrHHs2i5vglBMeWuPNeTNS12UgzaNXmi1d6YGOue/j/myQpOAkuS8/p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";
const PWA_ICON_512_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAABGNJQ1ABBAABk7gAvQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABGdBTUEAALGPC/xhBQAAAwBQTFRFKkt+K0x+K0x/LEx+LE1+LE1/LU1/Lk5/Lk5/L0+AME9/ME+AMVB/MVCAMlF/MlGAM1GANFKANVOANlSANlSBN1SBOFWAOVWBOlaBO1eCPFiCPVmCPVmDP1qCP1qDQFqDQVuCQluDQ1yERV2ERl6FRl+ER1+ESGCFSWGFSmGGSmKFTGKGTWOGTWSGTmOGT2SHT2WGUGWHUGaHUmaHUmeHVGeHVGiHVWiHVWmHVmiIVmmHVmqHVmqIVmqIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIV2qIAP8ASI3enwAAAQB0Uk5T////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////AFP3ByUAABAASURBVHic7F2JdpvYsrUlJJYwSAIsZg1wmAcxiElIy///Wa/qICfpjtNJO07f5Nn1+t77nHY0cPap2jXf3X/Iu5a7//UH+JD/rXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LBwDeuXwA4J3LewLAZHJ/zwiCpuu64ZDg1J6H8+UyXIamch3b0DVVZNnb770beQ8AmNzht2SY2WQ2Z4W1bpjmjnhh1Q7D0PcAgLbyiW2auiby3Hw+mbwnBPy/BsBsBmc5vWcWC54X1hJcfGtvO24QREmaFm3X9+e6boe+bfM0ScLAJ9vddqurG3ElcBw7n+NLzP5/w+H/NQCm0zu8zgtxJUobzfTDtCgKevGH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";

const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="pwaBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2b4c7e"/>
      <stop offset="100%" stop-color="#0f141c"/>
    </linearGradient>
    <linearGradient id="pwaGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="110" fill="url(#pwaBg)"/>
  <circle cx="256" cy="256" r="195" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
  <g transform="translate(106, 105)">
    <path d="M 90 60 L 120 98 L 150 48 L 180 98 L 210 60 L 220 115 L 80 115 Z" fill="url(#pwaGold)" stroke="#b45309" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="90" cy="54" r="7" fill="#fef08a"/>
    <circle cx="150" cy="42" r="8" fill="#fef08a"/>
    <circle cx="210" cy="54" r="7" fill="#fef08a"/>
    <path d="M 150 82 C 136 100, 134 114, 150 132 C 166 114, 164 100, 150 82 Z" fill="#fef08a"/>
    <path d="M 50 140 A 50 50 0 0 1 150 140 L 150 310 L 50 310 Z" fill="#ffffff" stroke="#2b4c7e" stroke-width="5"/>
    <path d="M 150 140 A 50 50 0 0 1 250 140 L 250 310 L 150 310 Z" fill="#ffffff" stroke="#2b4c7e" stroke-width="5"/>
    <line x1="150" y1="140" x2="150" y2="310" stroke="#cbd5e1" stroke-width="3"/>
    <line x1="75" y1="180" x2="125" y2="180" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="75" y1="210" x2="125" y2="210" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="75" y1="240" x2="125" y2="240" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="75" y1="270" x2="125" y2="270" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="175" y1="180" x2="225" y2="180" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="175" y1="210" x2="225" y2="210" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="175" y1="240" x2="225" y2="240" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
    <line x1="175" y1="270" x2="225" y2="270" stroke="#2b4c7e" stroke-width="6" stroke-linecap="round"/>
  </g>
</svg>`;

const SW_SCRIPT = `// YUTorah Player Service Worker v1.0.0
const CACHE_NAME = 'yutorah-pwa-v1';
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW] Precache skipped:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Audio streams, Range requests, and CDN audio must bypass cache completely
  const pathLower = url.pathname.toLowerCase();
  if (
    req.headers.has('range') ||
    pathLower.endsWith('.mp3') ||
    pathLower.endsWith('.m4a') ||
    pathLower.endsWith('.mp4') ||
    url.hostname.includes('shiurim.yutorah.net') ||
    (url.hostname.includes('cachefly.net') && (pathLower.includes('/audio/') || pathLower.includes('/shiurim/')))
  ) {
    return;
  }

  // API & Auth routes: Network-First with offline fallback
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.hostname === 'api.yutorah.org'
  ) {
    event.respondWith(
      fetch(req).catch(() => {
        return caches.match(req).then((cached) => {
          if (cached) return cached;
          return new Response(JSON.stringify({ offline: true, error: 'Network unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        });
      })
    );
    return;
  }

  // Navigation requests (HTML documents): Network-First, fallback to cached page or root shell
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => {
              if (url.pathname === '/' && (!url.search || url.search === '')) {
                cache.put('/', clone);
              } else {
                cache.put(req, clone);
              }
            }).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          return caches.match(req).then((cached) => cached || caches.match('/')).then((cached) => {
            if (cached) return cached;
            return new Response('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f141c;color:#fff;"><h2>Offline</h2><p>Please check your internet connection to access YUTorah Player.</p></body></html>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          });
        })
    );
    return;
  }

  // Static Assets (icons, manifest, web fonts): Stale-While-Revalidate
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/manifest.webmanifest' ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Unhandled requests fall through to browser's native networking
});
`;

let cachedIcon192Bytes = null;
let cachedIcon512Bytes = null;

function getIcon192Bytes() {
  if (!cachedIcon192Bytes) {
    cachedIcon192Bytes = Uint8Array.from(atob(PWA_ICON_192_BASE64), c => c.charCodeAt(0));
  }
  return cachedIcon192Bytes;
}

function getIcon512Bytes() {
  if (!cachedIcon512Bytes) {
    cachedIcon512Bytes = Uint8Array.from(atob(PWA_ICON_512_BASE64), c => c.charCodeAt(0));
  }
  return cachedIcon512Bytes;
}

function handlePwaRoutes(request, url) {
  if (url.pathname === '/manifest.json' || url.pathname === '/manifest.webmanifest') {
    return new Response(JSON.stringify(PWA_MANIFEST, null, 2), {
      headers: {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
      }
    });
  }

  if (url.pathname === '/sw.js') {
    return new Response(SW_SCRIPT, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  if (url.pathname === '/icons/icon-192.png' || url.pathname === '/icons/icon-maskable-192.png' || url.pathname === '/favicon.ico') {
    return new Response(getIcon192Bytes(), {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  if (url.pathname === '/icons/icon-512.png' || url.pathname === '/icons/icon-maskable-512.png') {
    return new Response(getIcon512Bytes(), {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  if (url.pathname === '/icons/icon.svg') {
    return new Response(PWA_ICON_SVG, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // PWA: Manifest, Service Worker & Icons
    const pwaRes = handlePwaRoutes(request, url);
    if (pwaRes) return pwaRes;

    // Auth + cloud sync (Google OAuth, /api/me, /api/profile, /api/sync,
    // public playlists).
    if (url.pathname === '/api/me' || url.pathname === '/api/sync' || url.pathname === '/api/profile' ||
        url.pathname === '/api/playlists/public' || url.pathname === '/api/playlists/items' ||
        url.pathname === '/api/playlists/publish' || url.pathname === '/api/playlists/unpublish' ||
        url.pathname === '/api/playlists/save' || url.pathname === '/api/playlists/unsave' ||
        url.pathname === '/api/playlists/mine' ||
        url.pathname === '/auth/google' || url.pathname === '/auth/callback' ||
        url.pathname === '/auth/logout') {
      const handled = await handleAuthRoutes(request, env, url) ||
        await handleSyncRoutes(request, env, url);
      if (handled) return handled;
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 0. Autocomplete Metadata API: /api/autocomplete-meta
    if (url.pathname === '/api/autocomplete-meta') {
      return new Response(JSON.stringify(AUTOCOMPLETE_META), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
        }
      });
    }
    // 0b. Fuzzy Suggest API: /api/suggest?q=... (ROADMAP §5.4)
    // Damerau-Levenshtein over teachers/topics/venues (+ synset variants).
    // Pure local data — no upstream calls, safe to hit on every keystroke pause.
    // Never suggests the query back to itself.
    if (url.pathname === '/api/suggest') {
      const q = url.searchParams.get('q') || '';
      const ql = q.trim().toLowerCase();
      let suggestions = [];
      try {
        suggestions = suggestDidYouMean(q, {
          teacher: AUTOCOMPLETE_META.teachers || [],
          topic: AUTOCOMPLETE_META.categories || [],
          venue: AUTOCOMPLETE_META.venues || []
        }, { limit: 8 }).filter(s => String(s.text || '').trim().toLowerCase() !== ql);
      } catch (e) {
        suggestions = [];
      }
      return new Response(JSON.stringify({ query: q, suggestions }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 0c. Change Log API: /api/changelog (dev settings "Change Log").
    if (url.pathname === '/api/changelog') {
      return new Response(JSON.stringify(CHANGELOG), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60'
        }
      });
    }

    // 0d. Dynamic facet counts: /api/facets (powers filter dropdown counts
    // that react to already-selected filters; upstream facet query, rows=0).
    if (url.pathname === '/api/facets') {
      try {
        const fUrl = new URL(API_ORIGIN + '/search');
        fUrl.searchParams.set('searchTerm', url.searchParams.get('q') || '');
        fUrl.searchParams.set('rows', '0');
        fUrl.searchParams.set('facet', 'true');
        for (const [ours, up] of [['teacherId', 'teacherId'], ['subCategoryId', 'subCategoryId'], ['locationId', 'locationId'], ['seriesId', 'seriesId']]) {
          for (const v of url.searchParams.getAll(ours)) {
            if (v) fUrl.searchParams.append(up, v);
          }
        }
        const cacheKey = 'facets:' + fUrl.searchParams.toString();
        const cached = facetCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 60000) {
          return new Response(JSON.stringify(cached.body), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }
          });
        }
        const upstream = await fetch(fUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' }
        });
        const norm = { teachers: [], categories: [], venues: [], series: [], total: 0 };
        if (upstream.ok) {
          const fj = await upstream.json();
          norm.total = fj?.response?.numFound || 0;
          const ff = fj?.facet_counts?.facet_fields || {};
          const pick = (arr, idK, nameK) => (Array.isArray(arr) ? arr : []).map(e => ({
            id: String(e[idK] ?? ''),
            name: String(e[nameK] ?? ''),
            count: Number(e.Match || 0)
          })).filter(e => e.id && e.name);
          norm.teachers = pick(ff.teachers, 'TeacherId', 'TeacherName');
          norm.categories = pick(ff.subcategories, 'SubcategoryId', 'Subcategoryname');
          norm.venues = pick(ff.locations, 'LocationId', 'LocationName');
          norm.series = pick(ff.series, 'SeriesId', 'SeriesName');
        }
        facetCache.set(cacheKey, { at: Date.now(), body: norm });
        if (facetCache.size > 50) {
          const first = facetCache.keys().next().value;
          facetCache.delete(first);
        }
        return new Response(JSON.stringify(norm), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ teachers: [], categories: [], venues: [], series: [], total: 0 }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 1. Live Search API Proxy: /api/search?q=...
    if (url.pathname === '/api/search') {
      try {
        const responsePayload = await executeSearchInternal(url.searchParams);
        return new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=120'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2. Homepage Details API Proxy: /api/homepage
    if (url.pathname === '/api/homepage') {
      const data = await getHomepageData();
      return new Response(JSON.stringify(data || {}), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 2b. Teacher Info Proxy: /api/teacher?id=...
    if (url.pathname === '/api/teacher') {
      const teacherId = url.searchParams.get('id') || url.searchParams.get('teacherId');
      if (!teacherId) {
        return new Response(JSON.stringify({ error: 'Missing teacher ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const upstream = await fetch(`${TARGET_API_ORIGIN}/teachers/sidebar/${encodeURIComponent(teacherId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
          }
        });
        const data = await upstream.text();
        return new Response(data, {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2c. Venue Info Proxy: /api/venue?id=...
    if (url.pathname === '/api/venue') {
      const venueId = url.searchParams.get('id') || url.searchParams.get('locationId');
      if (!venueId) {
        return new Response(JSON.stringify({ error: 'Missing venue ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const upstream = await fetch(`${TARGET_API_ORIGIN}/venues/sidebar/${encodeURIComponent(venueId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
          }
        });
        const data = await upstream.text();
        return new Response(data, {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2d. Live Daily Sponsorship API: /api/sponsorship
    if (url.pathname === '/api/sponsorship') {
      const data = await getDailySponsorship();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 3. Lecture Data API proxy
    if (url.pathname.startsWith('/sidebar/lecturedata') || url.pathname.startsWith('/sidebar/lectureData') || url.pathname === '/api/shiur') {
      const shiurId = url.searchParams.get('shiurID') || url.searchParams.get('shiurId') || url.searchParams.get('id');
      if (!shiurId) {
        return new Response(JSON.stringify({ error: 'Missing shiurID parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const upstream = await fetch(`${TARGET_API_ORIGIN}/sidebar/lectureData?shiurId=${encodeURIComponent(shiurId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Referer': `${TARGET_API_ORIGIN}/`,
          }
        });
        const data = await upstream.text();
        return new Response(data, {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 3b. Serve Theme SVG Assets: /assets/themes/:file
    if (url.pathname.startsWith('/assets/themes/')) {
      const filename = url.pathname.replace('/assets/themes/', '');
      const svgContent = THEME_ASSETS[filename];
      if (svgContent) {
        return new Response(svgContent, {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return new Response('Theme asset not found', { status: 404 });
    }

    // 3c. Streaming PDF Proxy for in-browser PDF.js & Liquid Mode reflow: /api/pdf-proxy?url=...
    if (url.pathname === '/api/pdf-proxy') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
      const pdfTargetUrl = url.searchParams.get('url');
      if (!pdfTargetUrl) {
        return new Response('Missing url parameter', { status: 400 });
      }
      try {
        let cleanTarget = pdfTargetUrl.trim();
        if (cleanTarget.startsWith('/')) {
          cleanTarget = 'https://shiurim.yutorah.net' + cleanTarget;
        }
        let parsedTarget;
        try {
          parsedTarget = new URL(cleanTarget);
        } catch(e) {
          return new Response('Invalid URL', { status: 400 });
        }
        const allowedHosts = [
          'shiurim.yutorah.net',
          'www.yutorah.org',
          'yutorah.org',
          'api.yutorah.org',
          'cdnyutorah.cachefly.net'
        ];
        const isAllowed = allowedHosts.includes(parsedTarget.hostname.toLowerCase()) ||
          parsedTarget.hostname.toLowerCase().endsWith('.r2.dev') ||
          parsedTarget.hostname.toLowerCase().endsWith('.yutorah.org');
        if (!isAllowed) {
          return new Response('Target host not allowed', { status: 403 });
        }
        const upstreamHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/pdf, */*'
        };
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
          upstreamHeaders['Range'] = rangeHeader;
        }
        const pdfResp = await fetch(cleanTarget, {
          headers: upstreamHeaders,
          redirect: 'follow'
        });
        const respHeaders = new Headers();
        respHeaders.set('Content-Type', pdfResp.headers.get('Content-Type') || 'application/pdf');
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Access-Control-Allow-Headers', 'Range, Content-Type');
        respHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        respHeaders.set('Accept-Ranges', 'bytes');
        respHeaders.set('Cache-Control', 'public, max-age=86400');
        if (pdfResp.headers.has('Content-Length')) {
          respHeaders.set('Content-Length', pdfResp.headers.get('Content-Length'));
        }
        if (pdfResp.headers.has('Content-Range')) {
          respHeaders.set('Content-Range', pdfResp.headers.get('Content-Range'));
        }
        return new Response(pdfResp.body, {
          status: pdfResp.status,
          headers: respHeaders
        });
      } catch (pdfErr) {
        return new Response('Error proxying PDF: ' + pdfErr.message, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 4. Extract Shiur ID or Search Query from URL
    let shiurId = url.searchParams.get('shiurId') || url.searchParams.get('shiurID') || url.searchParams.get('id');
    const pathMatch = url.pathname.match(/^\/(?:lectures\/)?([0-9]+)/);
    if (!shiurId && pathMatch) {
      shiurId = pathMatch[1];
    }

    const searchQuery = url.searchParams.get('search') || url.searchParams.get('q') || '';
    const directAudio = url.searchParams.get('audioUrl') || url.searchParams.get('url');
    const timestamp = url.searchParams.get('t') || '';
    const speedParam = url.searchParams.get('speed') || url.searchParams.get('rate') || '';
    const rawThemeParam = (url.searchParams.get('theme') || url.searchParams.get('mode') || '').toLowerCase();
    let themeMode = 'dark';
    if (rawThemeParam === 'light' || url.searchParams.get('dark') === '0' || url.searchParams.get('light') === '1') {
      themeMode = 'light';
    } else if (rawThemeParam === 'dark' || url.searchParams.get('dark') === '1' || (url.searchParams.has('dark') && url.searchParams.get('dark') !== '0')) {
      themeMode = 'dark';
    }

    // 5. If a shiurId is requested, pre-fetch metadata
    let shiurData = null;
    if (shiurId) {
      try {
        const resp = await fetch(`${TARGET_API_ORIGIN}/sidebar/lectureData?shiurId=${encodeURIComponent(shiurId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json',
            'Referer': `${TARGET_API_ORIGIN}/`,
          }
        });
        if (resp.ok) {
          shiurData = await resp.json();
        }
      } catch (err) {
        console.error('Failed to pre-fetch shiur:', err);
      }
    }

    // 6. Pre-fetch collections & search data if needed
    let homepageData = null;
    let initialSearchResults = null;
    let initialNumFound = 0;
    let initialPhoneticExpansion = null;
    let initialRecentDocs = [];
    let initialRecentNumFound = 0;
    let initialQueryResolution = null;
    let initialDidYouMean = [];

    // Prefetch whenever ANY search criteria are present (keywords OR bare
    // filter params like ?subCategoryId= from hero slides), not just ?search=.
    const hasFilterParams = ['teacherId', 'subCategoryId', 'locationId', 'seriesId', 'year', 'fromDate', 'toDate', 'minDuration', 'maxDuration', 'mediaType', 'sort']
      .some(k => url.searchParams.get(k));
    if (!shiurData && (searchQuery || hasFilterParams)) {
      try {
        const searchPayload = await executeSearchInternal(url.searchParams);
        initialSearchResults = searchPayload?.response?.docs || [];
        initialNumFound = searchPayload?.response?.numFound || initialSearchResults.length;
        initialPhoneticExpansion = searchPayload?.phoneticExpansion || null;
        initialRecentDocs = searchPayload?.response?.recentDocs || [];
        initialRecentNumFound = searchPayload?.response?.recentNumFound || 0;
        initialQueryResolution = searchPayload?.queryResolution || null;
        initialDidYouMean = searchPayload?.didYouMean || [];
      } catch (e) {
        console.error('Error pre-fetching search in SSR:', e);
      }
    }

    // Pre-fetch homepage collections and live daily sponsorship in parallel
    let sponsorship = { text: '', plainText: '', audioUrl: '' };
    [homepageData, sponsorship] = await Promise.all([
      getHomepageData(),
      getDailySponsorship()
    ]);

    const isClassicSearch = url.searchParams.get('exact') === '1' || url.searchParams.get('classic') === '1';

    // 7. Render and return the HTML app
    return new Response(renderAppHtml({
      shiurData,
      shiurId,
      directAudio,
      timestamp,
      playbackSpeed: speedParam,
      themeMode,
      homepageData,
      sponsorshipText: sponsorship.text,
      sponsorshipPlainText: sponsorship.plainText,
      sponsorshipAudioUrl: sponsorship.audioUrl,
      searchQuery,
      initialSearchResults,
      initialNumFound,
      initialPhoneticExpansion,
      initialRecentDocs,
      initialRecentNumFound,
      initialQueryResolution,
      initialDidYouMean,
      isClassicSearch
    }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      }
    });
  }
};

function formatDuration(lengthStr) {
  if (!lengthStr) return '';
  const parts = lengthStr.split(':');
  if (parts.length < 2) return lengthStr;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function getNowInNewYork() {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });
    const parts = formatter.formatToParts(new Date());
    const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026', 10);
    const month = parseInt(parts.find(p => p.type === 'month')?.value || '9', 10) - 1;
    const day = parseInt(parts.find(p => p.type === 'day')?.value || '6', 10);
    return new Date(year, month, day);
  } catch (e) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
}

function parseLocalDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  const ymd = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) {
    return new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
  }
  const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (mdy) {
    return new Date(parseInt(mdy[3], 10), parseInt(mdy[1], 10) - 1, parseInt(mdy[2], 10));
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  return null;
}

function formatShiurDate(rawDateStr) {
  if (!rawDateStr) return '';
  const trimmed = String(rawDateStr).trim();
  if (trimmed === 'Today' || trimmed === 'Yesterday') return trimmed;

  const d = parseLocalDate(trimmed);
  if (!d || isNaN(d.getTime())) return trimmed;

  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nyMidnight = getNowInNewYork().getTime();
  const diffDays = Math.round((nyMidnight - dMidnight) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return `${monthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function isShiurNew(rawDateStr) {
  if (!rawDateStr) return false;
  const trimmed = String(rawDateStr).trim();
  if (trimmed === 'Today' || trimmed === 'Yesterday') return true;
  const d = parseLocalDate(trimmed);
  if (!d || isNaN(d.getTime())) return false;
  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nyMidnight = getNowInNewYork().getTime();
  const diffDays = Math.round((nyMidnight - dMidnight) / 86400000);
  return diffDays <= 1 && diffDays >= -1;
}

function formatDate(dateStr) {
  return formatShiurDate(dateStr);
}

function normalizeShiur(s) {
  const id = s.shiurID || s.shiurid || s.id;
  const title = s.shiurTitle || s.shiurtitle || s.title || 'Untitled Shiur';

  let speaker = s.teacherfullname || (s.shiurTeachers && s.shiurTeachers[0] ? (s.shiurTeachers[0].teacherName || s.shiurTeachers[0].teacherFullName || '') : (s.speaker || ''));
  let photo = '';
  if (s.shiurTeachers && s.shiurTeachers[0]) {
    photo = s.shiurTeachers[0].teacherPhotoURL_lp || s.shiurTeachers[0].teacherPhotoURL_o || s.shiurTeachers[0].teacherPhotoURL || '';
  }
  if (!photo && s.speakerPhoto) photo = s.speakerPhoto;
  if (!photo && s.photo) photo = s.photo;
  if (!photo && s.teacherPhotoURL_lp) photo = s.teacherPhotoURL_lp;
  if (!photo && s.teacherPhotoURL_o) photo = s.teacherPhotoURL_o;
  if (!photo && s.teacherPhotoURL) photo = s.teacherPhotoURL;
  if (!photo && s.PHOTO) {
    photo = s.PHOTO.startsWith('http') ? s.PHOTO : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${s.PHOTO}`;
  }
  if (!photo) {
    photo = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
  }

  let duration = s.durationformatted || s.shiurDuration || '';
  if (!duration && s.shiurLength) {
    duration = formatDuration(s.shiurLength);
  } else if (!duration && s.duration) {
    duration = `${s.duration} min`;
  }

  const rawDate = s.shiurdateformatted || s.shiurDateFormatted || s.shiurDateSubmittedFormatted || s.shiurDate || s.shiurdate || '';
  const date = formatShiurDate(rawDate);
  const isNew = isShiurNew(s.shiurdatesubmitted || s.shiurDateSubmitted || rawDate);

  let category = '';
  if (Array.isArray(s.categoryname) && s.categoryname.length > 0) {
    category = s.categoryname[0];
  } else if (Array.isArray(s.subcategoryname) && s.subcategoryname.length > 0) {
    category = s.subcategoryname[0];
  } else if (s.category) {
    category = s.category;
  } else if (s.shiurGroupedSubcategoriesObj && s.shiurGroupedSubcategoriesObj[0]) {
    category = s.shiurGroupedSubcategoriesObj[0].categoryShortName || '';
  }

  const description = s.shiurdescription || s.description || '';
  const keywords = Array.isArray(s.shiurkeywords) ? s.shiurkeywords.join(', ') : (s.shiurkeywords || s.keywords || '');
  const series = Array.isArray(s.seriesname) ? s.seriesname.join(', ') : (s.seriesname || s.series || '');
  const location = Array.isArray(s.location) ? s.location.join(', ') : (s.location || '');

  return { id, title, speaker, photo, duration, date, category, isNew, description, keywords, series, location };
}

const DEV_PUBLIC_SEEDS = [
  {
    "id": "pl_ao_elul",
    "ownerName": "Andrew Ohiliote",
    "title": "Elul & Teshuvah Essentials",
    "description": "Foundational shiurim on teshuvah, Selichos, and preparing the heart for the Yamim Noraim.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Shaya Katz"
        },
        {
          "name": "Rabbi Hershel Schachter"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Elul & Teshuvah"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "The Power of Teshuvah in Elul",
        "speaker": "Rabbi Shaya Katz",
        "duration": "42:15"
      },
      {
        "id": "1052980",
        "title": "Hilchos Selichos and Viduy",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "38:40"
      },
      {
        "id": "979218",
        "title": "Preparing the Soul for Rosh Hashanah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "51:10"
      },
      {
        "id": "1052970",
        "title": "The Rambam’s Definition of Teshuvah Gemurah",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "46:25"
      },
      {
        "id": "1052960",
        "title": "Teshuvah MeAhavah vs. Teshuvah MeYirah",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "39:50"
      },
      {
        "id": "1052950",
        "title": "The Thirteen Middos HaRachamim in Selichos",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "44:30"
      }
    ]
  },
  {
    "id": "pl_ao_shabbos",
    "ownerName": "Andrew Ohiliote",
    "title": "Foundations of Shabbos & Muktzah",
    "description": "Deep halachic analysis of Hilchos Shabbos, Muktzah categories, and contemporary melacha applications.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Michael Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Shabbat"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Foundations of Muktzah: Kli SheMelachto L’Issur",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "55:20"
      },
      {
        "id": "979219",
        "title": "Gramada and Electricity on Shabbat",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "48:30"
      },
      {
        "id": "1052980",
        "title": "Borer in Modern Food Preparation",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "36:15"
      },
      {
        "id": "1052970",
        "title": "Bishul and Kli Rishon vs. Kli Sheni",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "43:50"
      },
      {
        "id": "1052960",
        "title": "Hot Water Dispensers and Urns on Shabbos",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "40:10"
      },
      {
        "id": "1052950",
        "title": "Amira L’Akum in Institutional Settings",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "47:15"
      },
      {
        "id": "1052940",
        "title": "Kavod and Oneg Shabbos: Halachic Parameters",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "52:00"
      },
      {
        "id": "1052930",
        "title": "Eruv Chatzeirot in Suburbia and Cities",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "49:45"
      }
    ]
  },
  {
    "id": "pl_ao_medical",
    "ownerName": "Andrew Ohiliote",
    "title": "Contemporary Halacha & Medical Ethics",
    "description": "End-of-life decision making, triage ethics, fertility halacha, and hospital Shabbos protocols.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Aryeh Lebowitz"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Medical Ethics"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Medical Triage and Resource Allocation in Halacha",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "50:15"
      },
      {
        "id": "1052990",
        "title": "Pikuach Nefesh on Shabbat in Hospitals",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "46:40"
      },
      {
        "id": "1053000",
        "title": "Halachic Issues in Organ Donation",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "54:10"
      },
      {
        "id": "1052970",
        "title": "End of Life Decision-Making and DNR Orders",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "48:25"
      },
      {
        "id": "1052960",
        "title": "Fertility Treatments and Halacha",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "42:30"
      }
    ]
  },
  {
    "id": "pl_ao_tefillah",
    "ownerName": "Andrew Ohiliote",
    "title": "Tefillah: Meaning, Structure & Kavana",
    "description": "A deep journey through Shacharis, Shemoneh Esrei, and the theology of Jewish prayer.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Yaakov Neuburger"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Tefillah"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Structure and Flow of the Shemoneh Esrei",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "39:50"
      },
      {
        "id": "1053000",
        "title": "Kavana in Birchot Krias Shema",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "43:15"
      },
      {
        "id": "979218",
        "title": "The Rav’s Philosophy of Prayer",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "49:25"
      },
      {
        "id": "1052970",
        "title": "Tefillah BeTzibbur: Obligation or Privilege?",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "45:10"
      },
      {
        "id": "1052960",
        "title": "Chazaras HaShatz and Birchas Kohanim",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "41:35"
      },
      {
        "id": "1052950",
        "title": "Pesukei D’Zimrah: Preparation for Encounter",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "38:45"
      },
      {
        "id": "1052940",
        "title": "Tefillas Tashlumin and Missed Prayers",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "36:20"
      }
    ]
  },
  {
    "id": "pl_ao_kashrus",
    "ownerName": "Andrew Ohiliote",
    "title": "Kashrus in the Modern Kitchen",
    "description": "Practical halachos of meat and milk, tevilas keilim, dishwasher kashering, and contemporary food production.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Hershel Schachter"
        },
        {
          "name": "Rabbi Aryeh Lebowitz"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Kashrus"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Modern Food Ingredients and Kashering Appliances",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "44:30"
      },
      {
        "id": "1052990",
        "title": "Bishul Akum and Commercial Food Preparation",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "37:50"
      },
      {
        "id": "1053000",
        "title": "Basar B’Chalav: Complex Modern Scenarios",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "52:15"
      },
      {
        "id": "1052970",
        "title": "Tevilas Keilim for Disposable and Electrical Appliances",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "41:10"
      }
    ]
  },
  {
    "id": "pl_ao_business",
    "ownerName": "Andrew Ohiliote",
    "title": "Business Ethics & Choshen Mishpat",
    "description": "Halachic principles of contracts, copyright, competition, dina d’malchuta, and fair workplace practices.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Michael Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Business Ethics"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Ona’ah and Price Disclosure in Contemporary Commerce",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "50:40"
      },
      {
        "id": "979219",
        "title": "Intellectual Property and Hasagas G’vul in Halacha",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "47:15"
      },
      {
        "id": "1053000",
        "title": "Dina D’Malchuta Dina and Corporate Ethics",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "41:20"
      },
      {
        "id": "1052980",
        "title": "Ribbis in Modern Banking and Heter Iska",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "45:30"
      },
      {
        "id": "1052970",
        "title": "Whistleblowing and Confidentiality Agreements",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "43:15"
      },
      {
        "id": "1052960",
        "title": "Severance Pay and Employment Contracts in Beis Din",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "48:50"
      },
      {
        "id": "1052950",
        "title": "Honesty in Negotiations and Genevas Daas",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "39:40"
      },
      {
        "id": "1052940",
        "title": "Returning Lost Objects in Digital Spaces",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "36:10"
      },
      {
        "id": "1052930",
        "title": "Stock Market Trading and Ethical Investments",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:05"
      }
    ]
  },
  {
    "id": "pl_ao_berachos",
    "ownerName": "Andrew Ohiliote",
    "title": "Hilchos Berachos & Daily Living",
    "description": "Comprehensive review of Birkas HaNehenin, Ikar v’Tafel, Shinui Makom, and Tefillas HaDerech.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Aryeh Lebowitz"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Berachot"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Birkas HaMazon: Chiyuv and Shiurim",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "38:15"
      },
      {
        "id": "1053000",
        "title": "Ikar v’Tafel in Granola and Breakfast Cereals",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "42:30"
      },
      {
        "id": "1052990",
        "title": "Birchos HaRe’ach and Special Occasions",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "35:45"
      }
    ]
  },
  {
    "id": "pl_ao_talmud",
    "ownerName": "Andrew Ohiliote",
    "title": "Talmudic Methodology: The Brisker Derech",
    "description": "Conceptual analysis of Chafetz vs Gavra, Pesak vs Limud, and the classic analytical frameworks of Reb Chaim.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Michael Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Talmud"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Brisker Methodology: Defining Cheftza vs Gavra",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "58:10"
      },
      {
        "id": "979219",
        "title": "Two Dinim in Sukkah and Mitzvos Aseh",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:40"
      },
      {
        "id": "1053000",
        "title": "Reb Chaim on Rambam: Hilchos Chometz U’Matzah",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "51:00"
      },
      {
        "id": "1052980",
        "title": "Rav Chaim on Pikuach Nefesh: Dichuyah vs. Hutrah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "56:15"
      },
      {
        "id": "1052970",
        "title": "The Brisker Conceptualization of Hazakah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "54:30"
      },
      {
        "id": "1052960",
        "title": "Pesak vs. Limud in the Brisker Tradition",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "49:20"
      },
      {
        "id": "1052950",
        "title": "Reb Velvel on Kodashim and Zevachim",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "57:45"
      },
      {
        "id": "1052940",
        "title": "Rav Soloveitchik on Mitzvos Shebalev",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "48:10"
      },
      {
        "id": "1052930",
        "title": "Two Dinim in Shechitah: Machshire vs. Mishtamesh",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "55:00"
      },
      {
        "id": "1052920",
        "title": "The Role of Sevara in Talmudic Jurisprudence",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:40"
      }
    ]
  },
  {
    "id": "pl_ao_devarim",
    "ownerName": "Andrew Ohiliote",
    "title": "Sefer Devarim: Covenant and Memory",
    "description": "Moshe Rabbeinu’s farewell address, the theology of Teshuva in the plains of Moav, and historical destiny.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Moshe Taragin"
        }
      ],
      "venues": [
        {
          "name": "Yeshivat Har Etzion"
        }
      ],
      "topics": [
        {
          "name": "Tanach"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Ha’azinu: The Song of History and Destiny",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "45:30"
      },
      {
        "id": "1052990",
        "title": "Nitzavim: Teshuvah and Free Will in Devarim",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "40:20"
      },
      {
        "id": "979218",
        "title": "Eikev: Tefillah and Eretz Yisrael in Devarim",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "48:15"
      },
      {
        "id": "1052980",
        "title": "Va’eschanan: Ten Commandments and Shema",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "43:50"
      },
      {
        "id": "1052970",
        "title": "Vezos HaBerachah: Moshe’s Farewell to the Tribes",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "39:10"
      }
    ]
  },
  {
    "id": "pl_ao_aveilus",
    "ownerName": "Andrew Ohiliote",
    "title": "Hilchos Aveilus & Consolation",
    "description": "The halachic progression of mourning from Aninus through Shloshim, Nichum Aveilim, and Kaddish.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Hershel Schachter"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Halacha"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "The Stages of Mourning: Aninus and Shiva",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "46:20"
      },
      {
        "id": "1052990",
        "title": "Nichum Aveilim: Meaning and Protocol",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "39:15"
      },
      {
        "id": "979218",
        "title": "Kaddish and Yahrtzeit: Spiritual Dimensions",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "44:50"
      },
      {
        "id": "1052970",
        "title": "Hesped: Obligation to the Deceased vs. the Living",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "42:00"
      }
    ]
  },
  {
    "id": "pl_mm_roshhashanah",
    "ownerName": "Moshe Mendelwitz",
    "title": "Rosh Hashanah Machzor Insights",
    "description": "Tefillos of Malchiyos, Zichronos, Shofros, and halachos of Shofar blowing.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Mayer Twersky"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Rosh Hashanah"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "The Philosophy of Malchiyos",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "44:00"
      },
      {
        "id": "1052990",
        "title": "Hearing the Shofar: Kavana and Halacha",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "41:10"
      },
      {
        "id": "979218",
        "title": "Zichronos and Shofros: Divine Remembrances",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "49:30"
      },
      {
        "id": "1052980",
        "title": "Tekios DeMeyushav vs. Tekios DeMeumad",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "45:20"
      },
      {
        "id": "1052970",
        "title": "Unetanneh Tokef: Authorship and Theological Depth",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "38:40"
      },
      {
        "id": "1052960",
        "title": "Tashlich and Simanim: Halacha and Custom",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "36:15"
      },
      {
        "id": "1052950",
        "title": "Rosh Hashanah as Yom HaDin and Yom Teruah",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "47:05"
      }
    ]
  },
  {
    "id": "pl_mm_dafyomi",
    "ownerName": "Moshe Mendelwitz",
    "title": "Daf Yomi: Sukkah & Pesachim In-Depth",
    "description": "Lomdus, machshava, and practical halachic takeaways from Maseches Sukkah and Pesachim.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Moshe Taragin"
        }
      ],
      "venues": [
        {
          "name": "Yeshivat Har Etzion"
        }
      ],
      "topics": [
        {
          "name": "Daf Yomi"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Shiur Klali: Sukkah Taaseh V’Lo Min Ha’Asui",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "47:25"
      },
      {
        "id": "979218",
        "title": "Lomdus of Bedikas Chametz and Bitul",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:10"
      },
      {
        "id": "1052980",
        "title": "Pesachim: Kol Sha’ah and Issur Hana’ah",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "45:15"
      },
      {
        "id": "1052970",
        "title": "Sukkah: Dofanos and Mechitzos in Halacha",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "50:40"
      },
      {
        "id": "1052960",
        "title": "Pesachim: Korban Pesach and Chaburah",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "48:30"
      },
      {
        "id": "1052950",
        "title": "Sukkah: Seudah on the First Night of Yom Tov",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "42:15"
      },
      {
        "id": "1052940",
        "title": "Pesachim: Erev Pesach That Falls on Shabbos",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "44:50"
      },
      {
        "id": "1052930",
        "title": "Sukkah: Chiyuv of Sukkah for Travelers",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "39:20"
      },
      {
        "id": "1052920",
        "title": "Pesachim: Arba Kosos and Heseibah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "51:30"
      },
      {
        "id": "1052910",
        "title": "Methodology in Daf Yomi: Depth vs. Breadth",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "46:00"
      }
    ]
  },
  {
    "id": "pl_mm_parsha",
    "ownerName": "Moshe Mendelwitz",
    "title": "Parshas Hashavua Masterclasses",
    "description": "Literary, Midrashic, and Halachic analyses of the weekly Torah portions across Sefer Bereishis and Devarim.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Moshe Taragin"
        }
      ],
      "venues": [
        {
          "name": "Yeshivat Har Etzion"
        }
      ],
      "topics": [
        {
          "name": "Parsha"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Bereishis: Creation and Human Consciousness",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "42:15"
      },
      {
        "id": "1052990",
        "title": "Noach: Covenant with Humanity and Earth",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "39:50"
      },
      {
        "id": "979218",
        "title": "Lech Lecha: The Call and Journey of Avraham",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:00"
      },
      {
        "id": "1052980",
        "title": "Vayeira: The Akeidah and Absolute Commitment",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "46:30"
      },
      {
        "id": "1052970",
        "title": "Chayei Sarah: Mourning and Legacy Building",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "41:10"
      },
      {
        "id": "1052960",
        "title": "Toldos: The Complex Identity of Yaakov and Eisav",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "49:45"
      },
      {
        "id": "1052950",
        "title": "Vayetzei: The Ladder Between Heaven and Earth",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "38:20"
      },
      {
        "id": "1052940",
        "title": "Vayishlach: Confrontation and Reconciliation",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "43:15"
      }
    ]
  },
  {
    "id": "pl_mm_ravsoloveitchik",
    "ownerName": "Moshe Mendelwitz",
    "title": "Meshel HaRav: Soloveitchik Legacy Shiurim",
    "description": "Analyzing the thought, theology, and Brisker halachic methodology of Rabbi Joseph B. Soloveitchik zt\"l.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Hershel Schachter"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Jewish Thought"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "The Rav’s Methodology in Hilchos Tefillah",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "58:00"
      },
      {
        "id": "979219",
        "title": "Halakhic Man and Lonely Man of Faith Compared",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:45"
      },
      {
        "id": "1052980",
        "title": "Kol Dodi Dofek and Historical Providence",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "46:30"
      },
      {
        "id": "1052970",
        "title": "The Rav on Teshuvah: Kapparah vs. Taharah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "55:10"
      },
      {
        "id": "1052960",
        "title": "Tradition and Modernity in the Thought of the Rav",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "44:20"
      },
      {
        "id": "1052950",
        "title": "The Rav’s Shiurim on Maseches Yoma",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "59:30"
      },
      {
        "id": "1052940",
        "title": "Kinnos Shiurim of the Rav: A Sacred Memory",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "47:15"
      },
      {
        "id": "1052930",
        "title": "The Rav on Zionism and Jewish Statehood",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "50:40"
      },
      {
        "id": "1052920",
        "title": "Catharsis in Halacha and Aggadah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:25"
      }
    ]
  },
  {
    "id": "pl_mm_moadim",
    "ownerName": "Moshe Mendelwitz",
    "title": "Moadim: Sukkos & Simchas Torah",
    "description": "The Arba Minim, Sukkah dimensions, Simchas Beis HaSho’evah, and the joy of Torah.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Mayer Twersky"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Sukkot"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Halachos of Daled Minim Selection and Care",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "48:15"
      },
      {
        "id": "1052990",
        "title": "The Nature of Simchah on Sukkos and Shemini Atzeres",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "41:30"
      },
      {
        "id": "979218",
        "title": "Hakafos and the Simchah of Siyum HaTorah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "45:10"
      },
      {
        "id": "1052980",
        "title": "Ushpizin: Welcoming the Ancestors into the Sukkah",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "37:45"
      },
      {
        "id": "1052970",
        "title": "Simchas Beis HaShoevah: Historical and Spiritual Heights",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "43:00"
      },
      {
        "id": "1052960",
        "title": "Hoshanah Rabbah: The Culmination of Judgement",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "44:20"
      }
    ]
  },
  {
    "id": "pl_mm_chanukah",
    "ownerName": "Moshe Mendelwitz",
    "title": "Chanukah: Light, Miracles & Sovereignty",
    "description": "Halachos of Ner Ish U’Beiso, Pirsumei Nisa, Hadlaka Oseh Mitzvah, and the hashkafa of Al HaNissim.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Michael Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Chanukah"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Mehadrin Min HaMehadrin: Lomdus of Lighting",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "51:20"
      },
      {
        "id": "1052980",
        "title": "Oil vs Wax Candles and Electric Menorahs",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "43:45"
      },
      {
        "id": "1053000",
        "title": "Hallel on Chanukah: Shiur and Nature",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "40:15"
      },
      {
        "id": "1052970",
        "title": "Al HaNissim and the Theology of Hidden Miracles",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "38:50"
      }
    ]
  },
  {
    "id": "pl_mm_purim",
    "ownerName": "Moshe Mendelwitz",
    "title": "Purim: Megillat Esther & Hidden Providence",
    "description": "In-depth study of the four Mitzvos of Purim, Seudas Purim, and the theology of Hester Panim.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Yaakov Neuburger"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Purim"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Mishloach Manot and Matanot LaEvyonim Halachot",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "38:50"
      },
      {
        "id": "1053000",
        "title": "Krias HaMegillah: Hearing and Reading Nuances",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "46:10"
      },
      {
        "id": "1052990",
        "title": "Ad D’Lo Yada: Hashkafic Perspectives",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "42:25"
      },
      {
        "id": "979218",
        "title": "Kabalas HaTorah on Purim: Kiymu v’Kiblu",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "50:15"
      },
      {
        "id": "1052970",
        "title": "Seudas Purim on Friday or Sunday",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "39:40"
      }
    ]
  },
  {
    "id": "pl_mm_pesach",
    "ownerName": "Moshe Mendelwitz",
    "title": "Pesach Seder: Halacha & Haggadah Insights",
    "description": "The Shiurim of Matzah, Arba Kosos, Maggid structure, and Bedikas Chametz lomdus.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Hershel Schachter"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Pesach"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "The Mitzvah of Sippur Yetzias Mitzrayim",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "56:30"
      },
      {
        "id": "979219",
        "title": "Shiur Kezayis and K’dei Achilas Pras for Matzah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "49:15"
      },
      {
        "id": "1052980",
        "title": "Kitniyos and Modern Derivatives",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "44:00"
      },
      {
        "id": "1052970",
        "title": "Kashering Ovens and Induction Cooktops for Pesach",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "42:10"
      },
      {
        "id": "1052960",
        "title": "Arba Kosos: Wine vs. Grape Juice and Shiur Kos",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "38:45"
      },
      {
        "id": "1052950",
        "title": "Afikoman: Dining After Midnight and Minhagim",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "41:20"
      },
      {
        "id": "1052940",
        "title": "The Four Sons: Educational Philosophy of the Haggadah",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "43:30"
      },
      {
        "id": "1052930",
        "title": "Mechiras Chametz: Legal Validity and Modern Commerce",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:00"
      }
    ]
  },
  {
    "id": "pl_mm_omer",
    "ownerName": "Moshe Mendelwitz",
    "title": "Sefiras HaOmer & Personal Growth",
    "description": "The halachic nature of Temimos, counting milestones, and spiritual self-refinement towards Shavuos.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Mayer Twersky"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Sefirat HaOmer"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Sefirah: One Long Mitzvah or 49 Independent Mitzvos?",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "45:20"
      },
      {
        "id": "1052990",
        "title": "Mourning the Talmidei Rabbi Akiva: Lessons in Kavod",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "39:40"
      },
      {
        "id": "979218",
        "title": "Spiritual Preparation for Receiving the Torah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "48:10"
      }
    ]
  },
  {
    "id": "pl_mm_shavuos",
    "ownerName": "Moshe Mendelwitz",
    "title": "Shavuos: Matan Torah & Revelation",
    "description": "The cosmic impact of Ma’amad Har Sinai, Torah Sheba’al Peh transmission, and Tikkun Leil Shavuos.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Michael Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Shavuot"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Kabalas HaTorah: B’Ones or B’Ratzon?",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "54:15"
      },
      {
        "id": "1052980",
        "title": "Akdamus and Minhagim of Shavuos",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "37:50"
      },
      {
        "id": "1053000",
        "title": "Ruth and Shavuos: The Power of Torah Loyalty",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "43:35"
      },
      {
        "id": "1052970",
        "title": "Tikkun Leil Shavuos: Toras Eretz Yisrael and Night Learning",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "41:10"
      },
      {
        "id": "1052960",
        "title": "Dairy Meals and Meat Meals on Shavuos",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "36:40"
      },
      {
        "id": "1052950",
        "title": "Revelation at Sinai as the Foundation of Emunah",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "45:20"
      }
    ]
  },
  {
    "id": "pl_rs_semichas",
    "ownerName": "Rachel Sternbach",
    "title": "Semichas Chaver Program Highlights",
    "description": "Practical halachos of Mezuzah, Kashrus, and Bishul Akum explained clearly for daily living.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Aryeh Lebowitz"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Halacha"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Semichas Chaver: Hilchos Mezuzah Practical Overview",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "49:10"
      },
      {
        "id": "1053000",
        "title": "Semichas Chaver: Bishul Akum and Microwaves",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "43:50"
      },
      {
        "id": "1052990",
        "title": "Semichas Chaver: Tevilas Keilim in Modern Times",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "41:20"
      },
      {
        "id": "1052970",
        "title": "Semichas Chaver: Melachas Borer on Shabbat",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "47:15"
      },
      {
        "id": "1052960",
        "title": "Semichas Chaver: Hilchos Tzitzis and Tallis",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "44:30"
      },
      {
        "id": "1052950",
        "title": "Semichas Chaver: Muktzah in the Modern Home",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "46:00"
      },
      {
        "id": "1052940",
        "title": "Semichas Chaver: Shehiyah and Chazarah on Friday Afternoon",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "48:25"
      }
    ]
  },
  {
    "id": "pl_rs_women",
    "ownerName": "Rachel Sternbach",
    "title": "Women in Jewish Law & Leadership",
    "description": "Halachic sources, historical evolution, and modern perspectives on women’s mitzvos, learning, and leadership.",
    "tags": {
      "teachers": [
        {
          "name": "Dr. Smadar Rosensweig"
        },
        {
          "name": "Rabbi Michael Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Jewish Law"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Torah Study for Women: Historical Perspectives",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:10"
      },
      {
        "id": "1053000",
        "title": "Women and Mitzvos Aseh SheHazman Grama",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "47:45"
      },
      {
        "id": "1052980",
        "title": "Women in Communal Leadership Roles",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "44:30"
      },
      {
        "id": "1052970",
        "title": "Megillah Reading for and by Women",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "51:00"
      },
      {
        "id": "1052960",
        "title": "Women and Kaddish: Halachic and Historical Sources",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "43:20"
      },
      {
        "id": "1052950",
        "title": "Tefillin and Tzitzis: Gender in Mitzvah Performance",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "46:15"
      },
      {
        "id": "1052940",
        "title": "Women Scholars throughout the Generations",
        "speaker": "Dr. Smadar Rosensweig",
        "duration": "49:30"
      },
      {
        "id": "1052930",
        "title": "Partnership in Torah and Family Building",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "41:40"
      }
    ]
  },
  {
    "id": "pl_rs_rambam",
    "ownerName": "Rachel Sternbach",
    "title": "Jewish Philosophy: Rambam’s Moreh Nevukhim",
    "description": "Classical Jewish rationalism, prophecy, divine providence, and the reasons for the commandments (Ta’amei HaMitzvos).",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Mayer Twersky"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Philosophy"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Rambam on Free Will and Divine Foreknowledge",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "48:30"
      },
      {
        "id": "979218",
        "title": "The Purpose of Creation in Moreh Nevukhim",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:15"
      },
      {
        "id": "979219",
        "title": "Ta’amei HaMitzvos: The Rationality of Commandments",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "49:40"
      },
      {
        "id": "1052980",
        "title": "Negative Theology and Divine Attributes in the Rambam",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "51:20"
      },
      {
        "id": "1052970",
        "title": "Prophecy in Moreh Nevukhim: Intellectual and Moral Perfection",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "54:45"
      },
      {
        "id": "1052960",
        "title": "Providence (Hashgachah) According to the Rambam",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "47:10"
      },
      {
        "id": "1052950",
        "title": "The Rambam’s View on Angels and Creation Ex Nihilo",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:00"
      },
      {
        "id": "1052940",
        "title": "Reasons for Korbanos in Moreh Nevukhim",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "45:30"
      },
      {
        "id": "1052930",
        "title": "The Messianic Era in Mishneh Torah vs. Moreh",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "46:15"
      },
      {
        "id": "1052920",
        "title": "Love and Awe of God as Culmination of Philosophy",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "50:00"
      }
    ]
  },
  {
    "id": "pl_rs_matriarchs",
    "ownerName": "Rachel Sternbach",
    "title": "Biblical Narrative: The Matriarchs of Genesis",
    "description": "Literary and theological analysis of Sarah, Rivka, Rachel, and Leah as moral anchors of the Jewish covenant.",
    "tags": {
      "teachers": [
        {
          "name": "Dr. Smadar Rosensweig"
        },
        {
          "name": "Rabbi Moshe Taragin"
        }
      ],
      "venues": [
        {
          "name": "Yeshivat Har Etzion"
        }
      ],
      "topics": [
        {
          "name": "Tanach"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Sarah Imeinu: The Crucible of Faith and Hospitality",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "42:00"
      },
      {
        "id": "1052990",
        "title": "Rivka and the Strategic Blessing",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "40:15"
      },
      {
        "id": "979218",
        "title": "Rachel and Leah: Two Paths in Building the House of Israel",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "50:30"
      },
      {
        "id": "1052980",
        "title": "Miriam HaNevi’ah: The Leadership of Hope and Song",
        "speaker": "Dr. Smadar Rosensweig",
        "duration": "44:20"
      },
      {
        "id": "1052970",
        "title": "Devorah HaNevi’ah: Judge and Mother in Israel",
        "speaker": "Dr. Smadar Rosensweig",
        "duration": "46:50"
      }
    ]
  },
  {
    "id": "pl_rs_ruth",
    "ownerName": "Rachel Sternbach",
    "title": "Megillat Ruth: Chesed and Kingship",
    "description": "The interplay of halachic conversion, gleaning laws, Levirate marriage, and the emergence of the Davidic dynasty.",
    "tags": {
      "teachers": [
        {
          "name": "Dr. Smadar Rosensweig"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Tanach"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Megillat Ruth: Hesed as the Foundation of Torah",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "46:40"
      },
      {
        "id": "1053000",
        "title": "Boaz and the Redemption of Naomi’s Heritage",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "41:15"
      },
      {
        "id": "979218",
        "title": "The Legal and Spiritual Dimensions of Ruth’s Conversion",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "48:50"
      },
      {
        "id": "1052970",
        "title": "From Moav to David HaMelech: The Royal Lineage",
        "speaker": "Dr. Smadar Rosensweig",
        "duration": "43:10"
      }
    ]
  },
  {
    "id": "pl_rs_tishabav",
    "ownerName": "Rachel Sternbach",
    "title": "Kinot of Tisha B’Av: History and Grief",
    "description": "The poetics of mourning, Eleh Ezkera, the destruction of the Batei Mikdash, and the yearning for Nechama.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Yaakov Neuburger"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Tisha B’Av"
        }
      ]
    },
    "items": [
      {
        "id": "979218",
        "title": "Understanding the Destruction: Kamtza and Bar Kamtza",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:45"
      },
      {
        "id": "1052980",
        "title": "Halachos of the Nine Days and Tisha B’Av",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "44:10"
      },
      {
        "id": "1053000",
        "title": "The Themes of Lamentations: From Churban to Hope",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "40:30"
      },
      {
        "id": "1052970",
        "title": "Eleh Ezkera: The Ten Martyrs and Jewish Sanctity",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "48:20"
      },
      {
        "id": "1052960",
        "title": "Arzei HaLevanon: Eulogizing the Torah Greats",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "42:15"
      },
      {
        "id": "1052950",
        "title": "Nechama and Comfort: The Seven Weeks of Consolation",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "41:50"
      }
    ]
  },
  {
    "id": "pl_rs_bioethics",
    "ownerName": "Rachel Sternbach",
    "title": "Jewish Bioethics: Genetics and Halacha",
    "description": "Genetic screening, CRISPR gene editing, stem cell research, and organ donation in contemporary halachic literature.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Aryeh Lebowitz"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Medical Ethics"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "CRISPR Gene Editing and Germline Modification in Halacha",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "47:30"
      },
      {
        "id": "1053000",
        "title": "Genetic Screening and Dor Yeshorim",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "44:15"
      },
      {
        "id": "979218",
        "title": "Stem Cell Research and Pre-Implantation Diagnosis",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "51:40"
      },
      {
        "id": "1052990",
        "title": "Brain Death and Organ Transplantation: The Halachic Debate",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "56:20"
      },
      {
        "id": "1052970",
        "title": "Artificial Insemination and Surrogacy",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "48:10"
      },
      {
        "id": "1052960",
        "title": "Informed Consent and Experimental Treatments",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "42:50"
      },
      {
        "id": "1052950",
        "title": "Halachic Directives for Healthcare Proxies",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "45:00"
      },
      {
        "id": "1052940",
        "title": "Artificial Intelligence in Medical Diagnoses and Pesak",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "43:15"
      },
      {
        "id": "1052930",
        "title": "Allocation of Scarce Medications in Emergencies",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "50:25"
      }
    ]
  },
  {
    "id": "pl_rs_chinuch",
    "ownerName": "Rachel Sternbach",
    "title": "Parenting & Chinuch in Contemporary Times",
    "description": "Guiding youth in faith, digital age boundaries, building emotional resilience, and transmitting the mesorah with love.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Yaakov Neuburger"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Education"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Parenting in the Digital Era: Boundaries and Empowerment",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "45:30"
      },
      {
        "id": "1053000",
        "title": "Chanoch LaNa’ar Al Pi Darko: Tailoring Torah to the Child",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "48:15"
      },
      {
        "id": "1052990",
        "title": "Emotional Resilience and Emunah in the Next Generation",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "41:40"
      },
      {
        "id": "1052970",
        "title": "Teaching Mitzvos with Joy and Love",
        "speaker": "Rabbi Aryeh Lebowitz",
        "duration": "39:25"
      },
      {
        "id": "1052960",
        "title": "Handling Religious Rebellion and Doubts in Teens",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "51:10"
      },
      {
        "id": "1052950",
        "title": "Tefillah Education in Schools and Homes",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "44:00"
      },
      {
        "id": "1052940",
        "title": "Transmitting the Mesorah: The Family Table as Beis Midrash",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "43:50"
      }
    ]
  },
  {
    "id": "pl_rs_mesillas",
    "ownerName": "Rachel Sternbach",
    "title": "Musar & Character Development: Mesillas Yesharim",
    "description": "Step-by-step ascent from Zehirus and Zerizus through Taharah and Chassidus as charted by the Ramchal.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Mayer Twersky"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Mussar"
        }
      ]
    },
    "items": [
      {
        "id": "1053000",
        "title": "Mesillas Yesharim: The Map of Spiritual Ascent",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "46:30"
      },
      {
        "id": "979218",
        "title": "Middas HaZehirus: Mindfulness in Halachic Living",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "53:00"
      },
      {
        "id": "1052980",
        "title": "Middas HaZerizus: Alacrity and Energy in Divine Service",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "48:15"
      },
      {
        "id": "1052970",
        "title": "Nekiyus: Purity from Subtle Transgressions",
        "speaker": "Rabbi Yaakov Neuburger",
        "duration": "42:40"
      },
      {
        "id": "1052960",
        "title": "Perishus: Sacred Moderation in a World of Excess",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "45:20"
      },
      {
        "id": "1052950",
        "title": "Taharah: Rectifying the Subconscious Intentions",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "47:50"
      },
      {
        "id": "1052940",
        "title": "Chassidus: Beyond the Letter of the Law",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "52:10"
      },
      {
        "id": "1052930",
        "title": "Yiras Cheit and Kedushah: Dwelling in the Divine Presence",
        "speaker": "Rabbi Mayer Twersky",
        "duration": "49:40"
      }
    ]
  },
  {
    "id": "pl_rs_israel",
    "ownerName": "Rachel Sternbach",
    "title": "The Land of Israel: Halachic and Historical Dimensions",
    "description": "Mitzvas Yishuv Eretz Yisrael, Terumos and Ma’asros, Shemittah observance, and the spiritual significance of the Land.",
    "tags": {
      "teachers": [
        {
          "name": "Rabbi Hershel Schachter"
        }
      ],
      "venues": [
        {
          "name": "Yeshiva University"
        }
      ],
      "topics": [
        {
          "name": "Israel"
        }
      ]
    },
    "items": [
      {
        "id": "1052980",
        "title": "Mitzvat Yishuv Eretz Yisrael in Contemporary Halacha",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "52:30"
      },
      {
        "id": "1053000",
        "title": "The Holiness of the Land and Shemittah Observance",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "44:40"
      },
      {
        "id": "979218",
        "title": "Eretz Hemdah: The Spiritual Connection to Zion",
        "speaker": "Rabbi Michael Rosensweig",
        "duration": "50:15"
      },
      {
        "id": "1052970",
        "title": "Terumos and Ma’asros in the Modern Supermarket",
        "speaker": "Rabbi Hershel Schachter",
        "duration": "43:10"
      },
      {
        "id": "1052960",
        "title": "Aliyah in Contemporary Times: Halachic Weight",
        "speaker": "Rabbi Moshe Taragin",
        "duration": "41:25"
      }
    ]
  }
];

function renderAppHtml({ shiurData, shiurId, directAudio, timestamp, playbackSpeed = '', themeMode = 'dark', homepageData, sponsorshipText = '', sponsorshipPlainText = '', sponsorshipAudioUrl = '', searchQuery, initialSearchResults, initialNumFound = 0, initialPhoneticExpansion = null, initialRecentDocs = [], initialRecentNumFound = 0, initialQueryResolution = null, initialDidYouMean = [], isClassicSearch = false }) {
  const isPlaying = Boolean(shiurData || directAudio);

  const initialSearchTerms = [];
  if (searchQuery) {
    const rawWords = searchQuery.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
    for (const w of rawWords) {
      initialSearchTerms.push(w);
      if (COMMUNITY_ACRONYM_PHRASES[w]) {
        for (const exp of COMMUNITY_ACRONYM_PHRASES[w]) {
          initialSearchTerms.push(exp.toLowerCase());
        }
      }
    }
    if (initialPhoneticExpansion && Array.isArray(initialPhoneticExpansion.tokens)) {
      for (const t of initialPhoneticExpansion.tokens) {
        if (t && t.length >= 2) initialSearchTerms.push(t.toLowerCase());
      }
    }
  }

  let initialGridHtml = '';
  if (initialSearchResults && initialSearchResults.length > 0) {
    const grouped = groupAndRankDocs(initialSearchResults, initialSearchTerms, searchQuery);
    initialGridHtml = grouped.map(item => renderGroupItemHtml(item, initialSearchTerms)).join('');
  }

  let title = 'YUTorah Enhanced Player';
  let speaker = '';
  let photo = '';
  let duration = '';
  let meta = '';
  let description = '';
  let audioUrl = '';
  let downloadUrl = '';
  let articlePdfUrl = '';
  let moreFromSpeakers = [];
  let moreFromCategories = [];
  let shiurTeachers = [];
  let shiurLocations = [];
  let shiurCategories = {};
  let shiurKeywords = [];
  let shiurDate = '';

  if (shiurData) {
    title = shiurData.shiurTitle || 'Untitled Shiur';
    speaker = shiurData.shiurTeacherFullName || (shiurData.shiurTeachers && shiurData.shiurTeachers[0] ? shiurData.shiurTeachers[0].teacherFullName : 'YUTorah');
    let teacherPhoto = '';
    if (Array.isArray(shiurData.shiurTeachers) && shiurData.shiurTeachers.length > 0) {
      const t = shiurData.shiurTeachers[0];
      teacherPhoto = t.teacherPhotoURL_lp || t.teacherPhotoURL_o || t.teacherPhotoURL || '';
    }
    if (!teacherPhoto) {
      teacherPhoto = shiurData.teacherPhotoURL_lp || shiurData.teacherPhotoURL_o || shiurData.teacherPhotoURL || '';
    }
    if (!teacherPhoto && shiurData.PHOTO) {
      teacherPhoto = shiurData.PHOTO.startsWith('http') ? shiurData.PHOTO : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${shiurData.PHOTO}`;
    }
    photo = teacherPhoto || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
    duration = shiurData.shiurDuration || '';
    const rawDate = shiurData.shiurDateFormatted || shiurData.shiurDate || '';
    shiurDate = formatShiurDate(rawDate);
    description = shiurData.shiurDescription || '';
    downloadUrl = shiurData.downloadURL || shiurData.playerDownloadURL || '';
    const rawShiurUrl = shiurData.playerDownloadURL || (shiurData.shiurURL ? 'https://shiurim.yutorah.net' + shiurData.shiurURL : '') || downloadUrl;
    
    // Detect if this shiur is an Article / Text document
    const mediaCategory = (shiurData.mediaTypeCategory || '').toLowerCase();
    const isDoc = mediaCategory === 'text' || mediaCategory === 'article' || /\.pdf($|\?)/i.test(rawShiurUrl) || /\.pdf($|\?)/i.test(downloadUrl);
    if (isDoc) {
      articlePdfUrl = rawShiurUrl;
      audioUrl = ''; // Do not treat as audio stream
      meta = '📄 Article' + (shiurDate ? ' · ' + shiurDate : '');
    } else {
      audioUrl = rawShiurUrl;
      meta = duration + (shiurDate ? ' · ' + shiurDate : '');
    }

    if (shiurData.moreFromSpeakers && Array.isArray(shiurData.moreFromSpeakers)) {
      moreFromSpeakers = shiurData.moreFromSpeakers.map(normalizeShiur);
    }
    if (shiurData.moreFromCategories && Array.isArray(shiurData.moreFromCategories)) {
      moreFromCategories = shiurData.moreFromCategories.map(normalizeShiur);
    }

    // Extract rich metadata
    if (Array.isArray(shiurData.shiurTeachers)) {
      shiurTeachers = shiurData.shiurTeachers.map(t => ({
        id: t.teacherID,
        name: t.teacherFullName || '',
        photo: t.teacherPhotoURL_lp || t.teacherPhotoURL || '',
      }));
    }
    if (Array.isArray(shiurData.postedInLocations)) {
      shiurLocations = shiurData.postedInLocations.map(loc => ({
        id: loc.locationID,
        name: loc.locationName || '',
      }));
    }
    if (shiurData.postedInCategories && typeof shiurData.postedInCategories === 'object') {
      for (const [groupId, group] of Object.entries(shiurData.postedInCategories)) {
        if (group.groupName && Array.isArray(group.categories)) {
          shiurCategories[group.groupName] = group.categories.map(c => ({
            name: c.categoryName || '',
            id: c.subcategoryID || '',
          }));
        }
      }
    }
    if (Array.isArray(shiurData.shiurKeywords)) {
      shiurKeywords = shiurData.shiurKeywords.map(k => ({
        title: k.keywordTitle || '',
      }));
    }
  } else if (directAudio) {
    title = 'Audio Stream';
    speaker = directAudio;
    audioUrl = directAudio;
  }

  let currentTeacherId = '';
  if (shiurData) {
    if (Array.isArray(shiurData.shiurTeachers) && shiurData.shiurTeachers[0]) {
      currentTeacherId = String(shiurData.shiurTeachers[0].teacherID || shiurData.shiurTeachers[0].id || '');
    }
    if (!currentTeacherId && shiurData.teacherID) {
      currentTeacherId = String(shiurData.teacherID);
    }
  }

  // Collections data
  let editorsPicks = [];
  let featuredSeries = [];
  let recentlyUploaded = [];
  let popularShiurim = [];
  let dailyShiurim = [];
  let heroSlides = [];

  // Map an upstream slideshow target to our player, generically: lecture
  // links stay in-app; yutorah search/filter URLs are translated into OUR
  // routes (search text, teacher, category, sort) so any present or future
  // slide deep-links into our library; externals open new-tab.
  // Unknown or dangerous schemes (javascript:, data:, …) fall back to '#'.
  function heroSlideLink(target) {
    const t = String(target || '').trim();
    const relLec = t.match(/^\/lectures\/(\d+)/);
    if (relLec) return { href: '/' + relLec[1], external: false };
    const abs = t.match(/^https?:\/\/([^\/]+)(\/.*)?$/i);
    let inner = null;
    let isYutorah = false;
    if (abs) {
      const host = abs[1].toLowerCase();
      if (host === 'yutorah.org' || host.endsWith('.yutorah.org')) {
        isYutorah = true;
        inner = abs[2] || '/';
      } else {
        return { href: t, external: true };
      }
    } else if (t.startsWith('/')) {
      isYutorah = true;
      inner = t;
    } else {
      return { href: '#', external: false };
    }
    const innerLec = inner.match(/^\/lectures\/(\d+)/);
    if (innerLec) return { href: '/' + innerLec[1], external: false };
    // Translate yutorah /search/?s=&teacher=&category=&collection=&sort=
    // and /togo/* landing shortcuts into our routes. Unmapped params drop.
    const qm = inner.match(/^\/search\/\?(.*)$/i);
    if (qm) {
      const qp = new URLSearchParams(qm[1]);
      const out = new URLSearchParams();
      const s = (qp.get('s') || '').trim();
      if (s) out.set('search', s);
      const teacher = (qp.get('teacher') || '').trim();
      if (/^\d+$/.test(teacher)) out.set('teacherId', teacher);
      else if (teacher) out.set('search', (s ? s + ' ' : '') + teacher);
      const cat = (qp.get('category') || '').trim();
      const catIds = cat.split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x) && x !== '0');
      if (catIds.length > 0) out.set('subCategoryId', catIds[0]);
      const series = (qp.get('series') || '').trim();
      if (/^\d+$/.test(series)) out.set('seriesId', series);
      if (qp.get('sort') === '1') out.set('sort', 'newest');
      const qs = out.toString();
      if (qs) return { href: '/?' + qs, external: false };
    }
    // To-Go issues link back to yutorah.org by default (article downloads
    // live there); search-style slides are translated above.
    const togo = inner.match(/^\/togo(\/.*)?$/i);
    if (togo) return { href: 'https://www.yutorah.org' + inner, external: true };
    const catPage = inner.match(/^\/categories\/(.+)$/i);
    if (catPage) {
      const slug = catPage[1].split('/').filter(Boolean).pop() || '';
      if (slug) return { href: '/?search=' + encodeURIComponent(slug.replace(/-/g, ' ')), external: false };
    }
    return { href: isYutorah ? ('https://www.yutorah.org' + inner) : t, external: true };
  }

  if (homepageData) {
    if (Array.isArray(homepageData.editorsPicks) && homepageData.editorsPicks.length > 0) {
      editorsPicks = homepageData.editorsPicks.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.featuredSeries) && homepageData.featuredSeries.length > 0) {
      featuredSeries = homepageData.featuredSeries;
    }
    if (Array.isArray(homepageData.recentlyUploaded) && homepageData.recentlyUploaded.length > 0) {
      recentlyUploaded = homepageData.recentlyUploaded.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.recentlyViewed) && homepageData.recentlyViewed.length > 0) {
      popularShiurim = homepageData.recentlyViewed.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.dailyShiurim) && homepageData.dailyShiurim.length > 0) {
      dailyShiurim = homepageData.dailyShiurim.map(normalizeShiur);
    }
    if (Array.isArray(homepageData.slideshow) && homepageData.slideshow.length > 0) {
      heroSlides = homepageData.slideshow.map(s => {
        const link = heroSlideLink(s.targetURL);
        return {
          name: s.name || '',
          description: s.description || '',
          imageURL: s.imageURL || '',
          urlTitle: s.urlTitle || 'Listen now',
          href: link.href,
          external: link.external
        };
      }).filter(s => s.imageURL);
    }
  }

  if (editorsPicks.length === 0) {
    editorsPicks = FALLBACK_SHIURIM;
  }

  const timely = homepageData?.timelyData || null;
  let parshaDisplayTitle = timely?.parshaStr || '';
  let parshaHolidayNote = '';
  let parshaCatId = '233995';

  if (!parshaDisplayTitle || parshaDisplayTitle.toLowerCase() === 'none') {
    // Current week has no regular weekly reading because Shabbat is a Yom Tov (e.g. Rosh Hashanah)
    // Display next parsha on the docket and mention the holiday in parentheses
    parshaDisplayTitle = "Ha'azinu";
    parshaHolidayNote = "This Shabbat is Rosh Hashanah";
    parshaCatId = '234515'; // Ha'azinu subcategory
  } else {
    const parshaCatMatch = timely?.parshaURL ? timely.parshaURL.match(/category=([0-9]+)/) : null;
    parshaCatId = parshaCatMatch ? parshaCatMatch[1] : '233995';
  }

  const baseSpeeds = [
    { val: '0.5', label: '0.5x' },
    { val: '0.75', label: '0.75x' },
    { val: '1', label: '1.0x' },
    { val: '1.25', label: '1.25x' },
    { val: '1.5', label: '1.5x' },
    { val: '1.75', label: '1.75x' },
    { val: '2', label: '2.0x' },
    { val: '2.5', label: '2.5x' },
    { val: '3', label: '3.0x' }
  ];
  const activeSpeedNum = (playbackSpeed && !isNaN(parseFloat(playbackSpeed)) && parseFloat(playbackSpeed) > 0) ? parseFloat(playbackSpeed) : 1;
  const activeSpeedStr = String(activeSpeedNum);
  const allSpeeds = [...baseSpeeds];
  if (!baseSpeeds.some(s => parseFloat(s.val) === activeSpeedNum) && activeSpeedNum <= 5) {
    allSpeeds.push({ val: activeSpeedStr, label: activeSpeedStr + 'x' });
    allSpeeds.sort((a, b) => parseFloat(a.val) - parseFloat(b.val));
  }
  const speedOptionsHtml = allSpeeds.map(s => {
    const isSelected = parseFloat(s.val) === activeSpeedNum;
    return `<option value="${s.val}" ${isSelected ? 'selected' : ''}>${s.label}</option>`;
  }).join('\n          ');

  const htmlThemeAttr = themeMode === 'dark' ? ' data-theme="dark"' : '';

  return `<!DOCTYPE html>
<html lang="en"${htmlThemeAttr}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — YUTorah Enhanced</title>
  <link rel="icon" type="image/png" href="https://cdnyutorah.cachefly.net/public/v3/images/logo-university-2x.png">
  <link rel="manifest" href="/manifest.json">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="YUTorah">
  <meta name="application-name" content="YUTorah">
  <meta name="theme-color" content="#2b4c7e" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f141c" media="(prefers-color-scheme: dark)">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-192.png">
  <link rel="apple-touch-icon" sizes="512x512" href="/icons/icon-512.png">
  <script>
    (function() {
      try {
        var p = new URLSearchParams(window.location.search);
        var urlTheme = (p.get('theme') || p.get('mode') || '').toLowerCase();
        var dark = false;
        if (urlTheme === 'dark' || p.get('dark') === '1' || (p.has('dark') && p.get('dark') !== '0')) {
          dark = true;
          try { localStorage.setItem('yutorah_theme', 'dark'); } catch(e) {}
        } else if (urlTheme === 'light' || p.get('dark') === '0' || p.get('light') === '1') {
          dark = false;
          try { localStorage.setItem('yutorah_theme', 'light'); } catch(e) {}
        } else {
          var saved = localStorage.getItem('yutorah_theme');
          // New users default to dark mode; an explicit saved choice always wins.
          dark = saved ? saved === 'dark' : true;
        }
        if (dark) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }

        // Pre-apply persisted cards/rows view to avoid a flash of cards.
        // Mobile is always cards; desktop defaults to rows.
        try {
          const sv = localStorage.getItem('yutorah_card_view');
          const mob = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
          const vv = (sv === 'rows' || sv === 'cards') ? (mob ? 'cards' : sv) : (mob ? 'cards' : 'rows');
          if (vv === 'rows') document.documentElement.classList.add('rows-view');
        } catch (e) {}

        // [DEAD CODE / INACTIVE] Simple View mode switcher
        // var savedMode = localStorage.getItem('yutorah_view_mode');
        // if (savedMode === 'simple') document.documentElement.setAttribute('data-view', 'simple');
      } catch(e) {}
    })();
  </script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  </script>
  <style>
    :root {
      --primary: #2b4c7e;
      --primary-dark: #1b3356;
      --primary-light: #436ea8;
      --accent: #d4a373;
      --bg: #f4f6f9;
      --card: #ffffff;
      --text: #1e2530;
      --text-muted: #5e6978;
      --border: #cbd5e1;
      --border-light: #e2e8f0;
      --shadow: 0 4px 18px rgba(0, 0, 0, 0.06);
      --shadow-hover: 0 8px 24px rgba(0, 0, 0, 0.1);
    }
    [data-theme="dark"] {
      --primary: #5c8ecc;
      --primary-dark: #121b2a;
      --primary-light: #7ca5de;
      --accent: #e5b98a;
      --bg: #0f141c;
      --card: #182232;
      --text: #e7edf7;
      --text-muted: #94a3b8;
      --border: #28364d;
      --border-light: #1e2a3c;
      --shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
      --shadow-hover: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
    [data-theme="dark"] input,
    [data-theme="dark"] select,
    [data-theme="dark"] textarea {
      background: #131c2a;
      color: #e7edf7;
      border-color: #28364d;
    }
    [data-theme="dark"] input[type="datetime-local"] {
      color-scheme: dark;
    }
    [data-theme="dark"] input:focus,
    [data-theme="dark"] select:focus,
    [data-theme="dark"] textarea:focus {
      background: #1a2638;
      color: #ffffff;
      border-color: #436ea8;
      box-shadow: 0 0 0 3px rgba(67, 110, 168, 0.25);
    }
    [data-theme="dark"] .chip {
      background: #141f2f;
      color: #cbd5e1;
      border-color: #28364d;
    }
    [data-theme="dark"] .tab-bar {
      background: #111a26;
      border: 1px solid #233147;
    }
    [data-theme="dark"] .tab-btn {
      background: transparent;
      color: #94a3b8;
      border: none;
    }
    [data-theme="dark"] .tab-btn:hover {
      color: #e7edf7;
    }
    [data-theme="dark"] .tab-btn.active {
      background: #1e2c40;
      color: #7ca5de;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    [data-theme="dark"] .quick-play-badge {
      background: #1c2738;
      color: #7ca5de;
    }
    [data-theme="dark"] .quick-card-link:hover .quick-play-badge {
      background: var(--primary);
      color: #fff;
    }
    [data-theme="dark"] .search-results-info {
      background: #141f2f;
      border: 1px solid #233147;
      color: #e7edf7;
    }
    [data-theme="dark"] .search-results-text {
      color: #93c5fd;
    }
    [data-theme="dark"] .match-explain-toggle {
      color: #94a3b8;
    }
    [data-theme="dark"] .match-explain-toggle:hover {
      color: #f1f5f9;
      background: rgba(255, 255, 255, 0.05);
    }
    [data-theme="dark"] .match-toggle-track {
      background-color: #475569;
    }
    [data-theme="dark"] .match-explain-toggle input:checked + .match-toggle-track {
      background-color: #3b82f6;
    }
    [data-theme="dark"] .explain-matches-active mark.match-mark {
      background-color: rgba(234, 179, 8, 0.35);
      color: #fef08a;
    }
    [data-theme="dark"] .explain-matches-active .quick-card-match-reason {
      background: rgba(20, 31, 47, 0.85);
      border-left-color: #60a5fa;
      color: #94a3b8;
    }
    [data-theme="dark"] .match-reason-badge {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.2);
    }
    [data-theme="dark"] .classic-info-btn {
      background: rgba(59, 130, 246, 0.2);
      color: #93c5fd;
    }
    [data-theme="dark"] .classic-info-btn:hover {
      background: #3b82f6;
      color: #ffffff;
    }
    [data-theme="dark"] .classic-search-tooltip {
      background: #1e293b;
      border-color: #334155;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
    }
    [data-theme="dark"] .classic-search-tooltip-header {
      border-bottom-color: #334155;
    }
    [data-theme="dark"] .classic-search-tooltip-title {
      color: #f1f5f9;
    }
    [data-theme="dark"] .classic-search-tooltip-close {
      color: #94a3b8;
    }
    [data-theme="dark"] .classic-search-tooltip-close:hover {
      color: #f8fafc;
      background: rgba(255, 255, 255, 0.1);
    }
    [data-theme="dark"] .classic-search-tooltip-body {
      color: #cbd5e1;
    }
    [data-theme="dark"] .classic-search-tooltip-body strong {
      color: #f1f5f9;
    }
    [data-theme="dark"] .classic-search-tooltip-body em {
      color: #60a5fa;
    }
    [data-theme="dark"] .match-reason-snippet {
      color: #e2e8f0;
    }
    [data-theme="dark"] .quick-card-avatar {
      background: #141f2f;
    }
    [data-theme="dark"] .quick-card-link.is-series-cover {
      border-color: #60a5fa;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
    }
    [data-theme="dark"] .series-cover-badge {
      background: rgba(96, 165, 250, 0.2);
      color: #93c5fd;
    }
    [data-theme="dark"] .series-expand-btn {
      background: rgba(96, 165, 250, 0.12);
      color: #93c5fd;
      border-color: rgba(96, 165, 250, 0.4);
    }
    [data-theme="dark"] .series-expand-btn:hover {
      background: #2563eb;
      color: #fff;
    }
    [data-theme="dark"] .series-drawer {
      background: rgba(15, 23, 42, 0.65);
      border-color: #24344d;
    }
    [data-theme="dark"] .series-sub-card {
      background: #182234;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .series-sub-card:hover {
      border-color: #60a5fa;
    }
    [data-theme="dark"] .ctrl-btn.skip {
      background: #1c2738;
      color: #e7edf7;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .action-btn {
      background: #1c2738;
      color: #cbd5e1;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .action-btn:hover {
      background: #25334a;
      color: #fff;
    }
    [data-theme="dark"] .mini-btn-pill {
      background: #1c2738 !important;
      border-color: #2e3e57 !important;
      color: var(--primary-light) !important;
    }
    [data-theme="dark"] .meta-chip {
      background: #141f2f;
      border-color: #2e3e57;
    }
    [data-theme="dark"] .meta-chip.speaker-chip { border-color: #3b70a8; color: #6ba6e8; }
    [data-theme="dark"] .meta-chip.venue-chip { border-color: #8c6a47; color: #d4a373; }
    [data-theme="dark"] .meta-chip.category-chip { border-color: #3d663d; color: #6fc26f; }
    [data-theme="dark"] .meta-chip.keyword-chip { border-color: #475569; color: #94a3b8; }
    [data-theme="dark"] .scrubber-bar { background: #25334a; }
    [data-theme="dark"] .timely-banner { background: var(--card); border-color: var(--border); box-shadow: var(--shadow); }
    [data-theme="dark"] .timely-label { color: var(--primary-light); }
    [data-theme="dark"] .timely-val { color: var(--text); }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
    }
    button, a, input, select, .ctrl-btn, .mini-btn, .theme-toggle-btn, .tab-btn, .chip, .quick-card-link, .timely-link {
      -webkit-tap-highlight-color: transparent !important;
      -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
      outline: none;
    }
    button:focus:not(:focus-visible),
    button:active,
    a:focus:not(:focus-visible),
    a:active {
      outline: none;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-tap-highlight-color: rgba(0,0,0,0) !important;
    }
    button:focus-visible,
    a:focus-visible {
      outline: 2px solid var(--primary-light) !important;
      outline-offset: 2px !important;
    }
    button svg, a svg {
      pointer-events: none;
    }
    html, body {
      overflow-x: hidden;
      max-width: 100vw;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Frozen Top Header (Always Fixed to Top of Viewport) */
    header#mainHeader {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      width: 100%;
      z-index: 1000;
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%);
      color: #fff;
      padding: 12px 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
    }
    .header-spacer {
      height: 52px;
      width: 100%;
      flex-shrink: 0;
    }
    .header-inner {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: #fff;
      font-weight: 700;
      font-size: 18px;
      flex-shrink: 0;
    }
    .brand span {
      background: rgba(255,255,255,0.22);
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .hebrew-date-badge {
      font-size: 13px;
      color: rgba(255,255,255,0.9);
      background: rgba(0,0,0,0.15);
      padding: 4px 12px;
      border-radius: 20px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      transition: background 0.15s ease;
    }
    .hebrew-date-badge:active {
      background: rgba(0,0,0,0.28);
    }

    /* Secret Pre-Roll Toggle Toast / Flash HUD */
    .secret-toast {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.85);
      background: rgba(18, 26, 38, 0.95);
      color: #ffffff;
      padding: 16px 28px;
      border-radius: 16px;
      font-size: 16px;
      font-weight: 700;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      border: 1.5px solid rgba(255, 255, 255, 0.2);
      z-index: 9999999;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: center;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .secret-toast.visible {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    .secret-toast.toast-disabled {
      border-color: rgba(239, 68, 68, 0.6);
      box-shadow: 0 12px 40px rgba(239, 68, 68, 0.3);
    }
    .secret-toast.toast-enabled {
      border-color: rgba(34, 197, 94, 0.6);
      box-shadow: 0 12px 40px rgba(34, 197, 94, 0.3);
    }
    .secret-toast.toast-dev {
      border-color: rgba(245, 158, 11, 0.9);
      box-shadow: 0 12px 40px rgba(245, 158, 11, 0.45);
      background: rgba(26, 20, 10, 0.96);
      color: #fef3c7;
    }

    /* Main Container */
    main {
      flex: 1;
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 16px 60px;
    }

    /* Collapsible Timely Widget */
    .timely-collapsible-wrap {
      position: relative;
      margin-bottom: 16px;
      z-index: 10;
    }
    .timely-collapsible-trigger {
      width: 100%;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0 14px;
      height: 38px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text);
      transition: all 0.15s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
      white-space: nowrap;
      overflow: hidden;
    }
    .timely-collapsible-trigger:hover {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.03);
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    [data-theme="dark"] .timely-collapsible-trigger:hover {
      background: rgba(92, 142, 204, 0.08);
      border-color: var(--primary-light);
    }
    .timely-trigger-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
      overflow: hidden;
      min-width: 0;
      flex: 1;
      white-space: nowrap;
    }
    .timely-icon {
      font-size: 15px;
      flex-shrink: 0;
    }
    .timely-title {
      font-weight: 700;
      color: var(--primary);
      letter-spacing: 0.2px;
      flex-shrink: 0;
    }
    [data-theme="dark"] .timely-title {
      color: var(--primary-light);
    }
    .timely-summary-badges {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: nowrap;
      overflow: hidden;
      min-width: 0;
    }
    .timely-badge {
      background: rgba(43, 76, 126, 0.07);
      color: var(--text);
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid rgba(43, 76, 126, 0.12);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      flex-shrink: 1;
    }
    [data-theme="dark"] .timely-badge {
      background: rgba(92, 142, 204, 0.12);
      border-color: rgba(92, 142, 204, 0.25);
    }
    @media (max-width: 640px) {
      .timely-badge:nth-child(n+3) {
        display: none;
      }
      .timely-badge {
        max-width: 130px;
      }
    }
    @media (max-width: 440px) {
      .timely-badge:nth-child(n+2) {
        display: none;
      }
      .timely-badge {
        max-width: 110px;
      }
      .timely-title {
        display: none;
      }
    }
    .timely-trigger-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .timely-dropdown-indicator {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      background: rgba(0,0,0,0.04);
      padding: 3px 8px;
      border-radius: 6px;
    }
    [data-theme="dark"] .timely-dropdown-indicator {
      background: rgba(255,255,255,0.06);
    }
    .timely-dropdown-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.12);
      z-index: 100;
      animation: timelyFadeIn 0.18s ease-out;
    }
    @keyframes timelyFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .timely-menu-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .timely-menu-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(43, 76, 126, 0.03);
      text-decoration: none;
      color: var(--text);
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .timely-menu-card:hover {
      background: rgba(43, 76, 126, 0.08);
      border-color: var(--primary);
      transform: translateY(-1px);
      box-shadow: 0 3px 8px rgba(0,0,0,0.05);
    }
    [data-theme="dark"] .timely-menu-card {
      background: rgba(92, 142, 204, 0.06);
    }
    [data-theme="dark"] .timely-menu-card:hover {
      background: rgba(92, 142, 204, 0.15);
      border-color: var(--primary-light);
    }
    .timely-card-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    .timely-card-body {
      flex: 1;
      min-width: 0;
    }
    .timely-card-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--primary);
      margin-bottom: 2px;
    }
    [data-theme="dark"] .timely-card-label {
      color: var(--primary-light);
    }
    .timely-card-val {
      font-size: 14px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .timely-card-note {
      font-size: 11px;
      color: #d97706;
      font-weight: 600;
      margin-top: 1px;
    }
    [data-theme="dark"] .timely-card-note {
      color: #f59e0b;
    }
    .timely-card-action {
      font-size: 12px;
      font-weight: 700;
      color: var(--primary);
      flex-shrink: 0;
      opacity: 0.8;
      transition: opacity 0.15s;
    }
    .timely-menu-card:hover .timely-card-action {
      opacity: 1;
      transform: translateX(2px);
    }
    [data-theme="dark"] .timely-card-action {
      color: var(--primary-light);
    }

    /* Shiur Card NEW Badge */
    .quick-card-new-badge {
      position: absolute;
      top: 9px;
      right: 10px;
      background: linear-gradient(135deg, #e67e22 0%, #d35400 100%);
      color: #ffffff;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.6px;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      box-shadow: 0 1px 4px rgba(230, 126, 34, 0.35);
      z-index: 2;
    }

    /* Sponsorship Banner */
    .sponsorship-banner {
      background: linear-gradient(90deg, #fdf8eb 0%, #fffdf7 50%, #fdf8eb 100%);
      border-bottom: 1px solid #e7d8b5;
      color: #634d17;
      font-size: 13px;
      padding: 8px 16px;
      text-align: center;
      line-height: 1.45;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .sponsorship-content {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .sponsorship-banner strong {
      color: #3b2c06;
      font-weight: 700;
    }
    .sponsorship-support-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 6px;
      padding: 2px 10px;
      font-size: 11px;
      font-weight: 700;
      color: #4a3600;
      background: rgba(184, 134, 11, 0.12);
      border: 1px solid rgba(184, 134, 11, 0.35);
      border-radius: 12px;
      text-decoration: none;
      transition: all 0.15s ease;
      white-space: nowrap;
      vertical-align: middle;
    }
    .sponsorship-support-pill:hover {
      background: rgba(184, 134, 11, 0.22);
      border-color: rgba(184, 134, 11, 0.55);
      transform: translateY(-1px);
      color: #2b1f00;
      text-decoration: none;
    }
    [data-theme="dark"] .sponsorship-banner {
      background: linear-gradient(90deg, #141a24 0%, #1a2230 50%, #141a24 100%);
      border-bottom: 1px solid #29384e;
      color: #e8ce8f;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    [data-theme="dark"] .sponsorship-banner strong {
      color: #fae4a5;
    }
    [data-theme="dark"] .sponsorship-support-pill {
      color: #fae4a5;
      background: rgba(250, 228, 165, 0.12);
      border-color: rgba(250, 228, 165, 0.3);
    }
    [data-theme="dark"] .sponsorship-support-pill:hover {
      background: rgba(250, 228, 165, 0.24);
      border-color: rgba(250, 228, 165, 0.55);
      color: #ffffff;
    }

    /* Sponsor Pre-Roll Overlayment Banner inside Player Card (Under Shiur Title) */
    .sponsor-preroll-banner {
      background: linear-gradient(135deg, rgba(212, 163, 115, 0.16) 0%, rgba(43, 76, 126, 0.08) 100%);
      border: 1.5px solid rgba(212, 163, 115, 0.55);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 18px;
      position: relative;
      box-shadow: 0 4px 14px rgba(212, 163, 115, 0.12);
      animation: fadeInSponsor 0.3s ease-out;
    }
    @keyframes fadeInSponsor {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    [data-theme="dark"] .sponsor-preroll-banner {
      background: linear-gradient(135deg, rgba(212, 163, 115, 0.22) 0%, rgba(27, 51, 86, 0.45) 100%);
      border-color: rgba(226, 180, 133, 0.5);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }
    .sponsor-preroll-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .sponsor-preroll-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #d4a373;
      color: #1a1a1a;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 10px;
      border-radius: 20px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.12);
    }
    .sponsor-preroll-status {
      font-size: 12px;
      font-weight: 700;
      color: var(--primary);
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    [data-theme="dark"] .sponsor-preroll-status {
      color: #fae4a5;
    }
    .sponsor-preroll-body {
      font-size: 13.5px;
      line-height: 1.45;
      color: var(--text-main);
      margin-bottom: 8px;
      font-weight: 500;
      margin-bottom: 12px;
    }
    .sponsor-preroll-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }
    .sponsor-preroll-countdown {
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .sponsor-preroll-countdown span {
      color: #d4a373;
      font-weight: 800;
    }
    [data-theme="dark"] .sponsor-preroll-countdown span {
      color: #e2b485;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .header-right #themeToggleBtn {
      order: 10;
    }
    @media (max-width: 640px) {
      #hebrewDateBadge {
        display: none !important;
      }
      /* When logged in on mobile, theme toggle is accessible via the settings gear dropdown */
      body.is-logged-in #themeToggleBtn,
      .auth-btn.logged-in ~ #themeToggleBtn {
        display: none !important;
      }
      /* On intermediate mobile screens (521px-640px) for non-logged-in users, display by default without !important so JS overflow check can hide it if cut off */
      body:not(.is-logged-in) #themeToggleBtn {
        display: inline-flex;
      }
    }
    /* On narrow mobile screens (<= 520px), suppress header theme toggle to prevent any clipping/overflow. */
    /* Theme toggling remains fully accessible via the settings/account dropdown (#authMenu) for all users! */
    @media (max-width: 520px) {
      #themeToggleBtn {
        display: none !important;
      }
    }
    .support-yutorah-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: #ffffff !important;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 14px;
      transition: all 0.2s ease;
      white-space: nowrap;
      line-height: 1.3;
      flex-shrink: 0;
    }
    .support-yutorah-btn:hover {
      background: rgba(255, 255, 255, 0.24);
      border-color: rgba(255, 255, 255, 0.45);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
      color: #ffffff !important;
      text-decoration: none;
    }
    [data-theme="dark"] .support-yutorah-btn {
      background: rgba(92, 142, 204, 0.15);
      border-color: rgba(92, 142, 204, 0.3);
      color: #e2eeff !important;
    }
    [data-theme="dark"] .support-yutorah-btn:hover {
      background: rgba(92, 142, 204, 0.28);
      border-color: rgba(92, 142, 204, 0.5);
      color: #ffffff !important;
    }
    .theme-toggle-btn {
      background: none !important;
      border: none !important;
      color: #fff;
      font-size: 20px;
      padding: 0 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.15s ease;
      flex-shrink: 0;
      line-height: 1;
      border-radius: 0;
      box-shadow: none !important;
      width: auto;
      height: auto;
      min-width: 32px;
      min-height: 32px;
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-user-select: none;
      user-select: none;
    }
    .theme-toggle-btn:focus,
    .theme-toggle-btn:active {
      outline: none;
      background: none !important;
      box-shadow: none !important;
    }
    .theme-toggle-btn:focus-visible {
      outline: 2px solid #ffffff !important;
      outline-offset: 2px;
      border-radius: 4px;
    }
    .theme-toggle-btn:hover {
      background: none !important;
      transform: scale(1.22);
    }
    @media (prefers-reduced-motion: reduce) {
      .auth-btn.logged-in .auth-gear,
      .theme-toggle-btn,
      .hero-cta {
        transition: none !important;
        transform: none !important;
      }
    }

    /* [DEAD CODE / INACTIVE] Settings Dropdown, Simple View & Theme Picker */
    .settings-wrapper {
      position: relative;
      display: none !important; /* Hidden as requested */
      align-items: center;
    }
    .settings-btn {
      font-size: 19px !important;
      padding: 0 3px;
      cursor: pointer;
      line-height: 1;
      transition: transform 0.25s ease;
    }
    .settings-btn:hover {
      transform: rotate(45deg);
    }
    .settings-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      min-width: 220px;
      padding: 6px;
      z-index: 1100;
      animation: menuFadeIn 0.15s ease-out;
    }
    @keyframes menuFadeIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .settings-menu-item {
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: background 0.15s ease, color 0.15s ease;
      white-space: nowrap;
      outline: none;
      -webkit-tap-highlight-color: transparent !important;
    }
    .settings-menu-item:hover {
      background: var(--border-light);
      color: var(--primary);
    }
    .settings-menu-item:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: -2px;
      background: var(--border-light);
    }
    .menu-item-icon,
    .menu-theme-icon,
    .menu-cal-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      line-height: 1;
      width: 20px;
      flex-shrink: 0;
      text-align: center;
    }
    [data-theme="dark"] .settings-menu {
      background: #182232;
      border-color: #28364d;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    [data-theme="dark"] .settings-menu-item:hover {
      background: #243247;
      color: #7ca5de;
    }
    [data-theme="dark"] .settings-menu-item:focus-visible {
      background: #243247;
      color: #7ca5de;
    }

    /* Settings Menu Section & Controls */
    .settings-menu-divider {
      height: 1px;
      background: var(--border);
      margin: 6px 0;
    }
    .settings-menu-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      padding: 6px 12px 2px;
    }
    .theme-select-wrap {
      padding: 4px 10px 8px;
    }
    .theme-select {
      width: 100%;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      outline: none;
    }
    .variant-toggle-wrap {
      display: flex;
      gap: 4px;
      padding: 4px 10px 8px;
    }
    .variant-btn {
      flex: 1;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text-muted);
      border-radius: 5px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .variant-btn.active {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
    }
    .chanukah-day-select-wrap {
      padding: 2px 10px 8px;
    }

    /* Holiday Theme Header Motif & Tagline Banner */
    .holiday-motif-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid var(--border);
      border-radius: 16px;
      font-size: 12px;
      font-weight: 700;
      color: var(--primary);
      margin-left: 6px;
      vertical-align: middle;
      transition: all 0.3s ease;
    }
    .holiday-motif-icon {
      width: 20px;
      height: 20px;
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
    .holiday-motif-title {
      white-space: nowrap;
    }
    .holiday-tagline-bar {
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--primary);
      padding: 3px 12px;
      background: rgba(255, 255, 255, 0.5);
      border-bottom: 1px solid rgba(0, 0, 0, 0.05);
      letter-spacing: 0.3px;
    }
    [data-theme="dark"] .holiday-tagline-bar {
      background: rgba(20, 27, 38, 0.85);
      color: #fae4a5;
      border-bottom: 1px solid rgba(212, 163, 115, 0.25);
    }
    [data-theme="dark"] .holiday-motif-wrap {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(212, 163, 115, 0.45);
      color: #fae4a5;
    }

    /* Mode Switch Overlay ("CSR" / "MGR") */
    .mode-switch-overlay {
      position: fixed;
      inset: 0;
      z-index: 999999;
      pointer-events: none;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(15, 20, 28, 0.45);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      animation: overlayFade 1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }
    .mode-switch-text {
      font-size: clamp(80px, 22vw, 170px);
      font-weight: 900;
      letter-spacing: 12px;
      color: #ffffff;
      text-shadow: 0 4px 25px rgba(0, 0, 0, 0.7), 0 0 60px rgba(67, 110, 168, 0.9), 0 0 120px rgba(43, 76, 126, 0.7);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      animation: growAndFade 1s cubic-bezier(0.15, 0.85, 0.35, 1) forwards;
    }
    @keyframes overlayFade {
      0% { opacity: 0; }
      20% { opacity: 1; }
      75% { opacity: 1; }
      100% { opacity: 0; }
    }
    @keyframes growAndFade {
      0% {
        opacity: 0;
        transform: scale(0.3);
        filter: blur(10px);
      }
      25% {
        opacity: 1;
        transform: scale(1.0);
        filter: blur(0);
      }
      75% {
        opacity: 1;
        transform: scale(1.35);
        filter: blur(0);
      }
      100% {
        opacity: 0;
        transform: scale(1.75);
        filter: blur(14px);
      }
    }

    /* Popular tab hidden by default in full mode, shown in simple mode */
    #tab-popular {
      display: none;
    }

    /* Simple View Mode Overrides (Classic Clean 4-Tab Look) */
    [data-view="simple"] #tab-series,
    [data-view="simple"] #tab-viewed,
    [data-view="simple"] #tab-parsha,
    [data-view="simple"] #tab-trending {
      display: none !important;
    }
    [data-view="simple"] #grid-series,
    [data-view="simple"] #grid-viewed,
    [data-view="simple"] #grid-parsha,
    [data-view="simple"] #grid-trending {
      display: none !important;
    }
    [data-view="simple"] #tab-popular {
      display: inline-flex !important;
    }
    [data-view="simple"] .bio-banner {
      display: none !important;
    }
    [data-view="simple"] .timely-link {
      background: none !important;
      border: none !important;
      padding: 0 !important;
      transform: none !important;
      box-shadow: none !important;
      cursor: default;
    }
    [data-view="simple"] .timely-link .timely-val {
      text-decoration: none !important;
    }

    @media (max-width: 640px) {
      header#mainHeader {
        padding: 8px 10px;
      }
      .header-spacer {
        height: 38px;
      }
      .brand {
        font-size: 14px;
        gap: 5px;
      }
      .brand span {
        display: inline-block;
        font-size: 9px;
        padding: 2px 5px;
        letter-spacing: 0.4px;
      }
      .header-right {
        gap: 5px;
      }
      .support-yutorah-btn {
        display: none !important;
      }
      /* Mobile: Hebrew date stays fully expanded; swipe the header to reach it. */
      .hebrew-date-badge .hebrew-date-text {
        display: inline;
      }
      .hebrew-date-badge:focus-visible {
        outline: 2px solid var(--primary) !important;
        outline-offset: 2px;
      }
      /* Dev-mode mobile: header-right scrolls sideways, settings last. */
      body.dev-mode-active .header-right {
        overflow-x: auto;
        max-width: 52vw;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
      }
      body.dev-mode-active .header-right::-webkit-scrollbar {
        display: none;
      }
      body.dev-mode-active .settings-wrapper {
        order: 99;
        flex-shrink: 0;
      }
      .theme-toggle-btn {
        font-size: 18px;
        padding: 2px 4px;
        min-width: 32px;
        min-height: 32px;
      }
      .hebrew-date-badge {
        font-size: 11px;
        padding: 2px 7px;
      }
      .sponsorship-banner {
        font-size: 11.5px;
        padding: 8px 12px;
      }
      .sponsorship-content {
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 6px;
      }
      .sponsorship-support-pill {
        margin-left: 0;
        margin-top: 4px;
        padding: 4px 14px;
        font-size: 11.5px;
      }
      .timely-banner {
        padding: 8px 10px;
        gap: 8px;
      }
      .timely-study-group {
        gap: 8px;
        row-gap: 6px;
      }
    }

    /* Search Bar Card */
    .search-card {
      background: var(--card);
      border-radius: 14px;
      padding: 16px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .search-form {
      display: flex;
      gap: 10px;
      position: relative;
    }
    .search-input-wrapper {
      position: relative;
      flex: 1;
      display: flex;
      align-items: center;
    }
    .search-icon {
      position: absolute;
      left: 14px;
      color: var(--text-muted);
      font-size: 16px;
      pointer-events: none;
    }
    .search-input {
      width: 100%;
      padding: 13px 40px 13px 40px;
      border: 2px solid var(--border);
      border-radius: 10px;
      font-size: 15px;
      outline: none;
      transition: all 0.2s;
      background: #fafbfc;
    }
    .search-input:focus {
      border-color: var(--primary);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(43, 76, 126, 0.12);
    }
    [data-theme="dark"] .search-input {
      background: #131c2a;
      color: #e7edf7;
      border-color: #28364d;
    }
    [data-theme="dark"] .search-input:focus {
      background: #1a2638 !important;
      color: #ffffff !important;
      border-color: #436ea8 !important;
      box-shadow: 0 0 0 3px rgba(67, 110, 168, 0.28) !important;
    }
    [data-theme="dark"] .search-input::placeholder {
      color: #7b8fa7;
    }
    [data-theme="dark"] .search-icon {
      color: #7b8fa7;
    }
    .clear-search-btn {
      position: absolute;
      right: 12px;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      display: none;
      padding: 4px 6px;
      line-height: 1;
    }
    .clear-search-btn:hover {
      color: var(--text);
    }
    .search-actions-row {
      display: flex;
      gap: 10px;
    }
    .search-submit-btn {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 0 22px;
      height: 48px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .search-submit-btn:hover {
      background: var(--primary-dark);
    }
    .advanced-search-btn {
      background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 0 18px;
      height: 48px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 2px 6px rgba(217, 119, 6, 0.25);
    }
    .advanced-search-btn:hover {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(217, 119, 6, 0.35);
    }
    .advanced-search-btn.active {
      background: #b45309;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.25);
    }
    [data-theme="dark"] .advanced-search-btn {
      background: linear-gradient(135deg, #b45309 0%, #78350f 100%);
    }

    /* Live Search Preview Dropdown */
    .search-preview-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.16);
      z-index: 1000;
      overflow: hidden;
      display: none;
      animation: previewFadeIn 0.15s ease-out;
    }
    @keyframes previewFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .preview-section-title {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      padding: 10px 14px 6px;
      background: rgba(0,0,0,0.02);
      border-bottom: 1px solid var(--border-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    [data-theme="dark"] .preview-section-title {
      background: rgba(255,255,255,0.02);
    }
    .preview-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 9px 14px;
      text-decoration: none;
      color: var(--text);
      border-bottom: 1px solid var(--border-light);
      cursor: pointer;
      transition: background 0.12s;
    }
    .preview-item:last-child {
      border-bottom: none;
    }
    .preview-item:hover, .preview-item.active {
      background: rgba(43, 76, 126, 0.08);
    }
    [data-theme="dark"] .preview-item:hover, [data-theme="dark"] .preview-item.active {
      background: rgba(92, 142, 204, 0.15);
    }
    .preview-item-icon {
      font-size: 18px;
      flex-shrink: 0;
      width: 24px;
      text-align: center;
    }
    .preview-item-body {
      flex: 1;
      min-width: 0;
    }
    .preview-item-title {
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
    }
    .preview-item-sub {
      font-size: 11.5px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }
    .preview-item-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(43, 76, 126, 0.08);
      color: var(--primary);
      flex-shrink: 0;
    }
    [data-theme="dark"] .preview-item-badge {
      background: rgba(92, 142, 204, 0.18);
      color: var(--primary-light);
    }
    .preview-footer-view-all {
      display: block;
      padding: 10px 14px;
      text-align: center;
      font-size: 12.5px;
      font-weight: 700;
      color: var(--primary);
      background: rgba(43, 76, 126, 0.04);
      cursor: pointer;
      text-decoration: none;
      border-top: 1px solid var(--border);
    }
    .preview-footer-view-all:hover {
      background: rgba(43, 76, 126, 0.1);
    }
    [data-theme="dark"] .preview-footer-view-all {
      color: var(--primary-light);
      background: rgba(92, 142, 204, 0.08);
    }

    [data-theme="dark"] .advanced-search-btn {
      border: 1px solid #d97706;
      color: #fef3c7;
    }
    [data-theme="dark"] .advanced-search-btn:hover {
      background: linear-gradient(135deg, #d97706 0%, #92400e 100%);
      color: #fff;
    }

    @media (max-width: 640px) {
      .search-form {
        flex-direction: column;
        gap: 10px;
      }
      .search-input-wrapper {
        width: 100%;
      }
      .search-actions-row {
        width: 100%;
        display: flex;
        gap: 8px;
      }
      .search-actions-row .search-submit-btn,
      .search-actions-row .advanced-search-btn {
        flex: 1;
        justify-content: center;
        height: 44px;
      }
    }

    /* Quick Filter Chips */
    .quick-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-light);
    }
    .chip {
      background: #eef2f7;
      color: var(--primary-dark);
      border: 1px solid #dbe2ed;
      border-radius: 16px;
      padding: 4px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      text-decoration: none;
      white-space: nowrap;
    }
    .chip:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      transform: translateY(-1px);
    }

    /* Audio Player Card */
    .player-card {
      background: var(--card);
      border-radius: 14px;
      padding: 24px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      margin-bottom: 28px;
      scroll-margin-top: 70px;
      ${isPlaying ? '' : 'display: none;'}
    }
    #searchResultsSection {
      scroll-margin-top: 70px;
      min-height: 80vh;
    }
    .player-nav-back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--primary);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      cursor: pointer;
    }
    .player-nav-back:hover {
      text-decoration: underline;
    }
    .shiur-header {
      display: flex;
      gap: 18px;
      align-items: center;
      margin-bottom: 20px;
    }
    .speaker-photo {
      width: 76px;
      height: 76px;
      border-radius: 50%;
      object-fit: cover;
      background: #e2e6ec;
      border: 2px solid var(--border);
      flex-shrink: 0;
      ${photo ? '' : 'display: none;'}
    }
    .shiur-details {
      flex: 1;
      min-width: 0;
    }
    .shiur-title {
      font-size: 21px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 6px;
      color: var(--text);
    }
    .shiur-speaker {
      font-size: 16px;
      font-weight: 600;
      color: var(--primary);
      margin-bottom: 4px;
      cursor: pointer;
      display: inline-block;
    }
    .shiur-upload-date {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .shiur-meta {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Scrubber */
    .scrubber-container {
      margin-bottom: 18px;
      user-select: none;
      -webkit-user-select: none;
    }
    .scrubber-bar {
      width: 100%;
      height: 10px;
      background: #e4e8ef;
      border-radius: 5px;
      cursor: pointer;
      position: relative;
      touch-action: none;
    }
    /* Expanded hit zone so tapping/clicking is effortless and snappy */
    .scrubber-bar::before {
      content: '';
      position: absolute;
      top: -14px;
      bottom: -14px;
      left: 0;
      right: 0;
      z-index: 1;
    }
    .scrubber-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 5px;
      width: 0%;
      position: relative;
      pointer-events: none;
      transition: width 0.15s linear;
    }
    .scrubber-bar.is-dragging .scrubber-fill {
      transition: none !important;
    }
    .scrubber-handle {
      position: absolute;
      right: -10px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      background: var(--primary);
      border: 2.5px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.28);
      transition: transform 0.1s ease, background-color 0.2s ease, box-shadow 0.2s ease;
      pointer-events: none;
      z-index: 2;
    }
    .scrubber-bar:hover .scrubber-handle,
    .scrubber-bar.is-dragging .scrubber-handle {
      transform: translateY(-50%) scale(1.25);
    }
    .scrubber-bar.is-sponsor-preroll {
      cursor: default;
    }
    .scrubber-bar.is-sponsor-preroll .scrubber-fill {
      background: linear-gradient(90deg, #b8860b 0%, #d4a373 100%);
      transition: none !important;
    }
    .scrubber-bar.is-sponsor-preroll .scrubber-handle {
      width: 26px;
      height: 26px;
      right: -13px;
      background-color: #ffffff;
      background-image: url('https://cdnyutorah.cachefly.net/public/v3/images/logo-university-2x.png');
      background-size: 80% 80%;
      background-position: center;
      background-repeat: no-repeat;
      border: 2px solid #b8860b;
      border-radius: 50%;
      box-shadow: 0 0 10px rgba(184, 134, 11, 0.75), 0 2px 6px rgba(0,0,0,0.25);
      transform: translateY(-50%);
    }
    .scrubber-bar.is-sponsor-preroll:hover .scrubber-handle {
      transform: translateY(-50%) scale(1.1);
    }
    .time-display {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
    }

    /* Transport Controls */
    .transport-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin-bottom: 16px;
    }
    .ctrl-btn {
      border: 2px solid var(--border);
      background: #ffffff;
      color: var(--text);
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      user-select: none;
      -webkit-user-select: none;
      transition: all 0.15s ease;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent !important;
    }
    .ctrl-btn:focus:not(:focus-visible),
    .ctrl-btn:active {
      outline: none;
      -webkit-tap-highlight-color: transparent !important;
    }
    .ctrl-btn:focus-visible {
      outline: 2px solid var(--primary-light) !important;
      outline-offset: 2px !important;
    }
    .ctrl-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      background: #f8fafc;
    }
    .ctrl-btn:active {
      transform: scale(0.92);
    }
    .ctrl-btn.skip {
      width: 50px;
      height: 50px;
      font-size: 14px;
    }
    .ctrl-btn.play {
      width: 68px;
      height: 68px;
      font-size: 28px;
      border-color: var(--primary);
      background: var(--primary);
      color: #fff;
    }
    .ctrl-btn.play:hover {
      background: var(--primary-dark);
      border-color: var(--primary-dark);
      color: #fff;
    }


    /* Secondary Controls */
    .controls-grid {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .ctrl-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ctrl-label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .speed-select {
      padding: 8px 12px;
      border: 2px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      background: #fff;
      cursor: pointer;
      outline: none;
    }
    .speed-select:focus {
      border-color: var(--primary);
    }
    .action-btn {
      padding: 8px 14px;
      border: 2px solid var(--border);
      background: #fff;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .action-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      background: #f8fafc;
    }
    .action-btn.copied {
      border-color: #27ae60;
      color: #27ae60;
    }

    /* Description */
    .shiur-desc {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 14px;
      line-height: 1.6;
      color: #4a5568;
      ${description ? '' : 'display: none;'}
    }

    /* Shortcuts Hint */
    .shortcuts-hint {
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
    }
    kbd {
      background: #eaedf2;
      border: 1px solid #cfd5de;
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 11px;
    }
    [data-theme="dark"] kbd {
      background: #202c3e;
      border-color: #364863;
      color: #cbd5e1;
    }
    @media (max-width: 768px), (pointer: coarse) {
      .shortcuts-hint {
        display: none !important;
      }
    }

    /* ==========================================================================
       Article & PDF Reader (Liquid Mode & High-Resolution Original View)
       ========================================================================== */
    .article-viewer-wrap {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 14px;
      background: var(--card);
      border-radius: 12px;
    }
    .article-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 10px 14px;
      background: rgba(43, 76, 126, 0.05);
      border: 1px solid var(--border);
      border-radius: 10px;
      user-select: none;
      -webkit-user-select: none;
    }
    [data-theme="dark"] .article-toolbar {
      background: rgba(92, 142, 204, 0.08);
      border-color: #2a3b52;
    }
    .article-toolbar-left,
    .article-toolbar-center,
    .article-toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .article-mode-pill {
      display: inline-flex;
      background: var(--border-light);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2px;
      gap: 2px;
    }
    .article-mode-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 700;
      padding: 5px 12px;
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .article-mode-btn.active {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.15);
    }
    [data-theme="dark"] .article-mode-btn.active {
      background: var(--primary);
      color: #fff;
    }
    .article-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .article-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      background: var(--border-light);
    }
    .article-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      border-color: var(--border);
    }
    .article-page-info {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      min-width: 80px;
      text-align: center;
    }
    .font-size-controls {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--border-light);
      padding: 2px 6px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .font-size-btn {
      background: transparent;
      border: none;
      color: var(--text);
      font-weight: 800;
      font-size: 12px;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .font-size-btn:hover {
      background: rgba(0,0,0,0.06);
      color: var(--primary);
    }
    [data-theme="dark"] .font-size-btn:hover {
      background: rgba(255,255,255,0.1);
    }

    /* Liquid Mode Typography View */
    .article-liquid-viewport {
      padding: 26px 32px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      min-height: 480px;
      line-height: 1.8;
      color: var(--text);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.02);
      max-height: 75vh;
      overflow-y: auto;
      scroll-behavior: smooth;
    }
    .article-liquid-viewport::-webkit-scrollbar {
      width: 8px;
    }
    .article-liquid-viewport::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }
    .liquid-content {
      max-width: 840px;
      margin: 0 auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .liquid-page-block {
      margin-bottom: 36px;
      padding-bottom: 28px;
      border-bottom: 1px dashed var(--border);
      position: relative;
    }
    .liquid-page-block:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .liquid-page-marker {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--primary);
      background: rgba(43, 76, 126, 0.08);
      padding: 3px 8px;
      border-radius: 6px;
      margin-bottom: 14px;
    }
    [data-theme="dark"] .liquid-page-marker {
      background: rgba(92, 142, 204, 0.15);
      color: var(--primary-light);
    }
    .liquid-wip-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 0.82em;
      font-weight: 500;
      color: var(--text-muted);
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid rgba(234, 179, 8, 0.25);
      border-radius: 8px;
      padding: 8px 14px;
      margin: 0 auto 20px auto;
      max-width: 540px;
      text-align: center;
    }
    [data-theme="dark"] .liquid-wip-banner {
      background: rgba(234, 179, 8, 0.08);
      border-color: rgba(234, 179, 8, 0.2);
      color: #fde047;
    }
    .liquid-header {
      text-align: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
      margin-bottom: 28px;
    }
    .liquid-kicker {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .liquid-title {
      font-size: 1.85em;
      font-weight: 800;
      line-height: 1.25;
      margin: 10px 0;
      color: var(--primary);
    }
    [data-theme="dark"] .liquid-title {
      color: var(--primary-light);
    }
    .liquid-byline {
      font-size: 1.05em;
      font-weight: 600;
      color: var(--text);
    }
    .liquid-role {
      font-size: 0.9em;
      color: var(--text-muted);
      margin-top: 3px;
    }
    .liquid-paragraph {
      margin-bottom: 18px;
      text-align: left;
      line-height: 1.75;
      hyphens: auto;
    }
    .liquid-paragraph[dir="rtl"] {
      text-align: right;
      font-family: "SBL Hebrew", "David", "Times New Roman", serif;
      font-size: 1.1em;
      line-height: 1.9;
    }
    .liquid-hebrew {
      direction: rtl;
      unicode-bidi: isolate;
      font-family: "SBL Hebrew", "David", "Taamey Frank CLM", "Times New Roman", serif;
      font-size: 1.12em;
      line-height: 1.8;
      display: inline-block;
      margin: 0 3px;
      color: #1a365d;
    }
    [data-theme="dark"] .liquid-hebrew {
      color: #93c5fd;
    }
    .liquid-hebrew-block {
      font-family: "Taamey Frank CLM", "David", "SBL Hebrew", "Times New Roman", serif;
      font-size: 1.18em;
      line-height: 1.9;
      background: rgba(43, 76, 126, 0.03);
      border-radius: 8px;
      padding: 18px 22px;
      margin: 1.4em 0;
      text-align: right;
      direction: rtl;
      unicode-bidi: isolate;
    }
    [data-theme="dark"] .liquid-hebrew-block {
      background: rgba(92, 142, 204, 0.08);
    }
    .liquid-translation {
      padding: 16px 20px;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 1.2em 0;
      font-size: 0.98em;
      line-height: 1.7;
      background: rgba(0,0,0,0.01);
    }
    .liquid-blockquote {
      margin: 1.3em 0;
      padding: 1em 1.25em;
      border-left: 4px solid var(--primary);
      background: rgba(43, 76, 126, 0.04);
      border-radius: 4px;
      font-size: 0.98em;
      font-style: italic;
    }
    [data-theme="dark"] .liquid-blockquote {
      border-left-color: var(--primary-light);
      background: rgba(92, 142, 204, 0.08);
    }
    .liquid-pull-quote {
      margin: 32px auto;
      max-width: 90%;
      padding: 24px 32px;
      border-top: 2px solid var(--primary);
      border-bottom: 2px solid var(--primary);
      background: linear-gradient(135deg, rgba(43, 76, 126, 0.04) 0%, rgba(43, 76, 126, 0.01) 100%);
      border-radius: 6px;
      text-align: center;
      position: relative;
    }
    .liquid-pull-quote blockquote {
      margin: 0;
      font-size: 1.25em;
      line-height: 1.6;
      font-weight: 600;
      color: var(--primary);
      font-style: italic;
      font-family: Georgia, serif;
    }
    .liquid-pull-quote-tag {
      display: inline-block;
      font-size: 0.72em;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-top: 10px;
    }
    [data-theme="dark"] .liquid-pull-quote {
      border-color: var(--primary-light);
      background: linear-gradient(135deg, rgba(92, 142, 204, 0.08) 0%, rgba(92, 142, 204, 0.02) 100%);
    }
    [data-theme="dark"] .liquid-pull-quote blockquote {
      color: var(--primary-light);
    }
    .liquid-heading {
      font-weight: 800;
      color: var(--primary);
      margin: 28px 0 14px 0;
      line-height: 1.35;
      font-size: 1.4em;
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
    }
    [data-theme="dark"] .liquid-heading {
      color: var(--primary-light);
    }
    .liquid-endnotes {
      border-top: 2px solid var(--primary);
      margin-top: 44px;
      padding-top: 20px;
    }
    [data-theme="dark"] .liquid-endnotes {
      border-top-color: var(--primary-light);
    }
    .liquid-endnotes-title {
      font-size: 1.3em;
      font-weight: 800;
      margin-bottom: 16px;
      color: var(--primary);
    }
    [data-theme="dark"] .liquid-endnotes-title {
      color: var(--primary-light);
    }
    .liquid-endnotes-list {
      padding-left: 24px;
      margin: 0;
    }
    .liquid-endnotes-item {
      font-size: 0.92em;
      line-height: 1.65;
      margin-bottom: 12px;
      color: var(--text);
    }
    .liquid-endnotes-item[dir="rtl"] {
      direction: rtl;
      text-align: right;
      font-family: "SBL Hebrew", "David", "Taamey Frank CLM", "Times New Roman", serif;
      font-size: 1.05em;
      line-height: 1.85;
    }
    .liquid-footnote-ref {
      font-size: 0.72em;
      line-height: 0;
      vertical-align: super;
      font-weight: 700;
      color: var(--primary);
      padding: 1px 3px;
      cursor: pointer;
      background: rgba(43, 76, 126, 0.08);
      border-radius: 4px;
      transition: background 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .liquid-footnote-ref:hover, .liquid-footnote-ref:active {
      background: rgba(43, 76, 126, 0.18);
    }
    [data-theme="dark"] .liquid-footnote-ref {
      color: var(--primary-light);
      background: rgba(92, 142, 204, 0.12);
    }
    [data-theme="dark"] .liquid-footnote-ref:hover, [data-theme="dark"] .liquid-footnote-ref:active {
      background: rgba(92, 142, 204, 0.25);
    }
    .liquid-footnote-popover {
      position: fixed;
      z-index: 9999;
      max-width: min(90vw, 420px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
      font-size: 0.92rem;
      line-height: 1.7;
      color: var(--text);
      animation: popoverFadeIn 0.18s ease;
      pointer-events: auto;
    }
    .liquid-footnote-popover.inverted {
      transform: translateY(-100%);
      animation: popoverFadeInInverted 0.18s ease;
    }
    @keyframes popoverFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes popoverFadeInInverted {
      from { opacity: 0; transform: translateY(calc(-100% - 6px)); }
      to { opacity: 1; transform: translateY(-100%); }
    }
    .liquid-footnote-popover .fn-popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border-light);
    }
    .liquid-footnote-popover .fn-popover-num {
      font-weight: 800;
      font-size: 0.82em;
      color: var(--primary);
      background: rgba(43, 76, 126, 0.08);
      padding: 2px 8px;
      border-radius: 6px;
    }
    [data-theme="dark"] .liquid-footnote-popover .fn-popover-num {
      background: rgba(92, 142, 204, 0.15);
      color: var(--primary-light);
    }
    .liquid-footnote-popover .fn-popover-close {
      background: none;
      border: none;
      font-size: 18px;
      cursor: pointer;
      color: var(--text-muted);
      padding: 0 4px;
      line-height: 1;
    }
    .liquid-footnote-popover .fn-popover-body {
      font-size: 0.88rem;
      line-height: 1.65;
    }
    .liquid-footnote-popover .fn-popover-body .liquid-hebrew {
      font-size: 1.05em;
    }
    [data-theme="dark"] .liquid-footnote-popover {
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.25);
    }
    .liquid-footnote-section {
      margin-top: 28px;
      padding-top: 16px;
      border-top: 2px solid var(--border);
    }
    .liquid-footnote-section-header {
      font-size: 0.82em;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .liquid-subheading {
      font-weight: 700;
      color: var(--text);
      font-size: 1.15em;
      margin: 18px 0 8px 0;
      line-height: 1.4;
    }
    .liquid-byline {
      font-style: italic;
      color: var(--text-muted);
      font-size: 0.95em;
      margin-bottom: 16px;
    }
    .liquid-blockquote {
      border-left: 3px solid var(--primary);
      margin: 14px 0 18px 16px;
      padding: 6px 14px;
      background: rgba(43, 76, 126, 0.04);
      border-radius: 0 8px 8px 0;
      font-size: 0.96em;
      line-height: 1.7;
    }
    .liquid-blockquote[dir="rtl"] {
      border-left: none;
      border-right: 3px solid var(--primary);
      margin: 14px 16px 18px 0;
      padding: 6px 14px;
      border-radius: 8px 0 0 8px;
      text-align: right;
    }
    [data-theme="dark"] .liquid-blockquote {
      border-color: var(--primary-light);
      background: rgba(92, 142, 204, 0.08);
    }
    .liquid-footnote-item {
      font-size: 0.88em;
      line-height: 1.6;
      margin-bottom: 8px;
      padding-left: 28px;
      position: relative;
      color: var(--text);
    }
    .liquid-footnote-item .fn-num {
      position: absolute;
      left: 0;
      top: 0;
      font-weight: 800;
      color: var(--primary);
      font-size: 0.85em;
      min-width: 22px;
    }
    [data-theme="dark"] .liquid-footnote-item .fn-num {
      color: var(--primary-light);
    }

    /* Page View Mode Switcher (Continuous Scroll vs Page by Page) */
    .page-mode-pill {
      display: inline-flex;
      background: var(--border-light);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2px;
      gap: 2px;
    }
    .page-mode-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 11.5px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .page-mode-btn.active {
      background: var(--card);
      color: var(--primary);
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    }
    [data-theme="dark"] .page-mode-btn.active {
      background: #253347;
      color: var(--primary-light);
    }

    /* Original Page Canvas Viewport (Desktop & High-Resolution) */
    .article-canvas-viewport {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: #525659;
      border-radius: 12px;
      padding: 20px;
      min-height: 540px;
      max-height: 85vh;
      overflow-y: auto;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      gap: 20px;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.3);
      position: relative;
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
    }
    [data-theme="dark"] .article-canvas-viewport {
      background: #181d24;
      border: 1px solid #283344;
    }
    .original-page-orientation-tip {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      max-width: 600px;
      padding: 7px 14px;
      margin-bottom: 6px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #f1f5f9;
      text-align: center;
      line-height: 1.4;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    [data-theme="dark"] .original-page-orientation-tip {
      background: rgba(30, 41, 59, 0.7);
      border-color: rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
    }
    .pdf-canvas-card {
      background: #fff;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      border-radius: 4px;
      overflow: visible;
      display: block;
      width: fit-content;
      max-width: none;
      margin: 0 auto;
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
      position: relative;
    }
    #continuousPagesContainer {
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
    }
    .liquid-content {
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
    }
    .pdf-canvas-card canvas {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .canvas-page-separator {
      margin-top: 18px;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
    }
    .canvas-page-tag {
      font-size: 11px;
      font-weight: 700;
      color: #e2e8f0;
      background: rgba(0,0,0,0.55);
      padding: 3px 10px;
      border-radius: 10px;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .article-viewer-wrap:fullscreen {
      background: var(--bg);
      padding: 24px;
      border-radius: 0;
      width: 100vw;
      height: 100vh;
      box-sizing: border-box;
      overflow-y: auto;
    }

    /* Reader Loading State */
    .article-loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
    }

    /* Orientation & Responsive Adaptations */
    @media (max-width: 768px) {
      .article-liquid-viewport {
        padding: 16px 14px;
        line-height: 1.7;
      }
      .article-toolbar {
        padding: 8px 10px;
      }
      .article-toolbar-center {
        order: 3;
        width: 100%;
        justify-content: center;
      }
      .article-canvas-viewport {
        padding: 10px;
      }
    }

    /* Landscape Mode optimization on mobile devices */
    @media (max-width: 900px) and (orientation: landscape) {
      .article-canvas-viewport {
        padding: 12px;
        max-height: 85vh;
      }
      .pdf-canvas-card {
        max-width: 96vw;
      }
    }

    /* Quick Card Article Indicator */
    .quick-article-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #10b981;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 12px;
      box-shadow: 0 1px 4px rgba(16, 185, 129, 0.3);
    }
    [data-theme="dark"] .quick-article-badge {
      background: #059669;
    }

    /* Collections & Tabs Section */
    .collections-section {
      margin-top: 24px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .section-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tab-bar {
      display: flex;
      gap: 6px;
      background: var(--border-light);
      padding: 4px;
      border-radius: 10px;
      overflow-x: auto;
      max-width: 100%;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .tab-bar::-webkit-scrollbar {
      display: none;
    }
    .tab-btn {
      padding: 8px 14px;
      border: none;
      background: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .tab-btn:hover {
      color: var(--primary);
    }
    .tab-btn.active {
      background: #ffffff;
      color: var(--primary);
      box-shadow: 0 2px 6px rgba(0,0,0,0.06);
    }
    [data-theme="dark"] .tab-btn.active {
      background: #243247;
      color: #fff;
    }

    /* Series Cards Grid */
    .series-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }
    .series-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .series-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-hover);
      border-color: var(--primary-light);
    }
    .series-card-img {
      height: 120px;
      background-size: cover;
      background-position: center;
      background-color: var(--border-light);
    }
    .series-card-body {
      padding: 14px;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .series-card-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 6px;
      line-height: 1.3;
    }
    .series-card-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
      margin-bottom: 10px;
      flex: 1;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .series-card-count {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--primary);
      margin-top: auto;
    }

    /* Trending Container */
    .trending-container {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
    }
    .trending-group-title {
      font-size: 13.5px;
      font-weight: 700;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .trending-chips-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 22px;
    }
    .trending-chips-wrap:last-child {
      margin-bottom: 0;
    }
    .trending-chip-btn {
      background: var(--border-light);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: 20px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .trending-chip-btn:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      transform: translateY(-1px);
    }
    [data-theme="dark"] .trending-chip-btn {
      background: #1e2a3c;
      border-color: #2e3e56;
      color: #dce5f2;
    }
    [data-theme="dark"] .trending-chip-btn:hover {
      background: var(--primary);
      color: #fff;
    }

    /* Search Results Header */
    .search-results-info {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
      padding: 12px 16px;
      background: #eef4fc;
      border-radius: 10px;
      border: 1px solid #d0e1f7;
    }
    .search-results-actions {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    .search-toggles-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .search-results-text {
      font-size: 14px;
      font-weight: 600;
      color: var(--primary-dark);
    }
    .close-results-btn {
      background: none;
      border: none;
      color: var(--primary);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .close-results-btn:hover {
      text-decoration: underline;
    }

    /* Match Explainability Toggle */
    .match-explain-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-muted);
      padding: 3px 6px;
      border-radius: 6px;
      transition: all 0.2s ease;
    }
    .match-explain-toggle:hover {
      color: var(--text);
      background: rgba(0, 0, 0, 0.04);
    }
    .match-explain-toggle input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
      pointer-events: none;
    }
    .match-toggle-track {
      width: 32px;
      height: 18px;
      background-color: var(--border, #cbd5e1);
      border-radius: 20px;
      position: relative;
      transition: background-color 0.2s ease;
      flex-shrink: 0;
    }
    .match-toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      background-color: #fff;
      border-radius: 50%;
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    }
    .match-explain-toggle input:checked + .match-toggle-track {
      background-color: #2563eb;
    }
    .match-explain-toggle input:checked + .match-toggle-track .match-toggle-thumb {
      transform: translateX(14px);
    }
    .match-explain-toggle input:focus-visible + .match-toggle-track {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }
    .match-toggle-label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .classic-info-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border-radius: 50%;
      background: rgba(37, 99, 235, 0.1);
      color: #2563eb;
      font-size: 11px;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      transition: all 0.15s ease;
      margin-left: 2px;
    }
    .classic-info-btn:hover {
      background: #2563eb;
      color: #fff;
      transform: scale(1.1);
    }
    .classic-search-tooltip {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 100;
      width: 320px;
      max-width: 90vw;
      background: #ffffff;
      border: 1px solid var(--border, #cbd5e1);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      border-radius: 12px;
      padding: 12px 14px;
      text-align: left;
      cursor: default;
      animation: tooltipPopIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes tooltipPopIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .classic-search-tooltip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border, #e2e8f0);
      padding-bottom: 6px;
      margin-bottom: 8px;
    }
    .classic-search-tooltip-title {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text, #1e293b);
    }
    .classic-search-tooltip-close {
      background: none;
      border: none;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      color: var(--text-muted, #64748b);
      padding: 0 4px;
      border-radius: 4px;
    }
    .classic-search-tooltip-close:hover {
      color: var(--text, #0f172a);
      background: rgba(0, 0, 0, 0.06);
    }
    .classic-search-tooltip-body {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text-muted, #475569);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .classic-search-tooltip-body p {
      margin: 0;
    }
    .classic-search-tooltip-body strong {
      color: var(--text, #0f172a);
    }
    .classic-search-tooltip-body em {
      font-style: normal;
      color: #2563eb;
      font-weight: 600;
    }

    /* Term Highlighting and Explainability Cards */
    mark.match-mark {
      background: transparent;
      color: inherit;
      font-weight: inherit;
      padding: 0;
      border-radius: 3px;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    .explain-matches-active mark.match-mark {
      background-color: #fef08a;
      color: #854d0e;
      font-weight: 700;
      padding: 1px 4px;
    }
    .quick-card-match-reason {
      display: none !important;
    }
    .explain-matches-active .quick-card-match-reason {
      display: flex !important;
      flex-direction: column;
      gap: 6px;
      margin: 10px 0 6px 0;
      padding: 8px 10px;
      background: #f8fafc;
      border-left: 3px solid #3b82f6;
      border-radius: 0 8px 8px 0;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text-muted);
      animation: fadeInReason 0.2s ease;
    }
    @keyframes fadeInReason {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .match-reason-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .match-reason-header {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .match-reason-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #1d4ed8;
      background: #eff6ff;
      padding: 1.5px 6px;
      border-radius: 4px;
      white-space: nowrap;
      width: fit-content;
    }
    .match-reason-snippet {
      font-size: 11.5px;
      line-height: 1.4;
      color: var(--text);
      word-break: break-word;
      padding-left: 2px;
    }
    @media (max-width: 600px) {
      .search-results-info {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }
      .search-results-actions {
        width: 100%;
        justify-content: space-between;
      }
    }

    /* Series and Collection Grouping Cards */
    .quick-card-series-group {
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .quick-card-link.is-series-cover {
      border: 2px solid var(--primary);
      box-shadow: 0 3px 12px rgba(0,0,0,0.06);
    }
    .series-cover-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(43, 76, 126, 0.1);
      color: var(--primary);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 6px;
      margin-bottom: 8px;
      width: fit-content;
      letter-spacing: 0.3px;
    }
    .series-expand-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      margin-top: 8px;
      padding: 8px 12px;
      background: rgba(43, 76, 126, 0.07);
      color: var(--primary);
      border: 1.5px dashed var(--primary);
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .series-expand-btn:hover {
      background: var(--primary);
      color: #fff;
      border-style: solid;
      transform: translateY(-1px);
    }
    .series-drawer {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      padding: 10px;
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 10px;
      animation: slideDownSeries 0.2s ease-out;
    }
    @keyframes slideDownSeries {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .series-sub-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      background: var(--card);
      border: 1px solid var(--border-light);
      border-radius: 8px;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .series-sub-card:hover {
      border-color: var(--primary);
      transform: translateX(3px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .series-sub-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .series-sub-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      line-height: 1.35;
      flex: 1;
    }
    .series-sub-play {
      font-size: 11px;
      font-weight: 700;
      color: var(--primary);
      background: #eef2f7;
      padding: 2px 8px;
      border-radius: 12px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .series-sub-card:hover .series-sub-play {
      background: var(--primary);
      color: #fff;
    }
    .series-sub-meta {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      gap: 8px;
    }

    /* Shiur Cards Grid */
    .shiur-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    .quick-card-link {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      text-decoration: none;
      color: inherit;
      box-shadow: 0 2px 8px rgba(0,0,0,0.03);
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .quick-card-link:hover {
      transform: translateY(-3px);
      box-shadow: var(--shadow-hover);
      border-color: var(--primary);
    }
    .quick-card-link:active {
      transform: scale(0.98);
    }
    .quick-card-top {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
    }
    .quick-card-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      background: #e2e6ec;
      flex-shrink: 0;
      border: 1px solid var(--border);
    }
    .quick-card-info {
      flex: 1;
      min-width: 0;
    }
    .quick-card-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.35;
      color: var(--text);
      margin-bottom: 4px;
      padding-right: 42px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .quick-card-speaker {
      font-size: 13px;
      color: var(--primary);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .quick-card-category {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .quick-card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid var(--border-light);
      padding-top: 10px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .quick-play-badge {
      background: #eef2f7;
      color: var(--primary);
      font-weight: 700;
      padding: 4px 11px;
      border-radius: 20px;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .quick-card-link:hover .quick-play-badge {
      background: var(--primary);
      color: #fff;
    }

    /* Loading Spinner */
    .spinner-box {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
      font-size: 15px;
      font-weight: 600;
      display: none;
    }
    .spinner {
      border: 3px solid #e4e8ef;
      border-top: 3px solid var(--primary);
      border-radius: 50%;
      width: 28px;
      height: 28px;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Search Results Sub-Sections (ROADMAP §7: Recent + Relevant) */
    .search-results-subheading {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 17px;
      font-weight: 800;
      margin: 18px 0 12px;
      grid-column: 1 / -1;
    }
    .search-results-subheading .sub-count {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    /* Quick Date Filters (every search) */
    .date-quick-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 10px 0 6px;
      scroll-margin-top: 60px;
    }
    .date-quick-subrow {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .date-quick-caption {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
    }
    .date-quick-sep {
      width: 1px;
      align-self: stretch;
      background: var(--border-light);
      margin: 2px 2px;
    }
    .date-quick-chip {
      cursor: pointer;
      border-radius: 20px;
      padding: 5px 13px;
      font-size: 12.5px;
      font-weight: 700;
      border: 1px solid var(--border-light);
      background: var(--card, #fff);
      color: var(--text);
    }
    .date-quick-chip.selected {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    .date-quick-chip:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    [data-theme="dark"] .date-quick-chip {
      background: #141f2f;
      border-color: #28364d;
      color: #cbd5e1;
    }
    [data-theme="dark"] .date-quick-chip.selected {
      background: #2b4c7e;
      border-color: #2b4c7e;
      color: #fff;
    }
    /* Cards / Rows view toggle */
    .view-toggle-wrap {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    .view-toggle-btn {
      cursor: pointer;
      border: 1px solid var(--border-light);
      background: var(--card, #fff);
      color: var(--text-muted);
      border-radius: 16px;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 11px;
    }
    .view-toggle-btn.selected {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    .view-toggle-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    [data-theme="dark"] .view-toggle-btn {
      background: #1f2937;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    [data-theme="dark"] .view-toggle-btn.selected {
      background: #2b4c7e;
      border-color: #2b4c7e;
      color: #fff;
    }
    /* Rows view: one shiur per full-width row (yutorah.org style) */
    .rows-view .shiur-cards-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rows-view .quick-card-link {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
    }
    .rows-view .quick-card-top {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .rows-view .quick-card-info {
      min-width: 0;
      flex: 1;
    }
    .rows-view .quick-card-avatar {
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }
    .rows-view .quick-card-match-reason {
      display: none;
    }
    .rows-view .quick-card-link .series-cover-badge {
      display: none;
    }
    .rows-view .quick-card-link {
      flex-wrap: wrap;
    }
    .rows-view .quick-card-link .card-mini-actions,
    .rows-view .quick-card-link .dev-progress-wrap {
      flex-basis: 100%;
    }
    .rows-view .quick-card-new-badge {
      top: 9px;
      bottom: auto;
    }
    .rows-view .quick-card-link {
      padding-right: 76px;
    }
    /* Rows view applies to EVERY card grid: featured series cards go
    full-width horizontal, one per line, like shiur cards. */
    .rows-view .series-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rows-view .series-card {
      flex-direction: row;
      align-items: center;
    }
    .rows-view .series-card-img {
      width: 120px;
      min-width: 120px;
      height: 84px;
    }
    .rows-view .series-card-body {
      padding: 10px 14px;
    }
    .rows-view .series-card-desc {
      -webkit-line-clamp: 1;
      margin-bottom: 4px;
    }
    .rows-view .quick-card-bottom {
      border-top: none;
      padding-top: 0;
      flex-shrink: 0;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }
    .rows-view .card-mini-actions {
      flex-shrink: 0;
    }
    @media (max-width: 640px) {
      .rows-view .quick-card-link {
        flex-wrap: wrap;
      }
      .rows-view .quick-card-bottom {
        flex-direction: row;
        align-items: center;
        width: 100%;
        justify-content: space-between;
      }
      /* Mobile: cards only (no rows toggle) + slimmer mini player. */
      .view-toggle-wrap {
        display: none;
      }
      #miniPlayer .expand-btn {
        display: none;
      }
    }
    /* Play Queue popup + list (Dev Mode) */
    .queue-popup {
      position: fixed;
      bottom: 84px;
      right: 12px;
      width: min(370px, 94vw);
      max-height: 52vh;
      display: flex;
      flex-direction: column;
      background: var(--card, #fff);
      color: var(--text);
      border: 1px solid var(--border-light);
      border-radius: 14px;
      box-shadow: var(--shadow-hover);
      z-index: 9000;
      overflow: hidden;
    }
    .queue-popup-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-light);
    }
    .queue-count {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .queue-popup-header .card-mini-btn {
      margin-left: auto;
    }
    .queue-list {
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .queue-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      border: 1px solid var(--border-light);
      border-radius: 10px;
      background: transparent;
    }
    .queue-row.dragging {
      opacity: 0.45;
    }
    .queue-pos {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-muted);
      min-width: 18px;
      text-align: center;
    }
    .queue-handle {
      cursor: grab;
      color: var(--text-muted);
      font-size: 14px;
      user-select: none;
    }
    .queue-main {
      flex: 1;
      min-width: 0;
    }
    .queue-title {
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .queue-sub {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .queue-row-btns {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .queue-row-btns .card-mini-btn {
      padding: 2px 7px;
      font-size: 11px;
    }
    .queue-popup-footer {
      padding: 8px 12px;
      border-top: 1px solid var(--border-light);
      display: flex;
      justify-content: flex-end;
    }
    .queue-empty {
      padding: 18px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    [data-theme="dark"] .queue-popup {
      background: #182232;
    }
    /* Hero slideshow (yutorah.org spotlight) */
    .hero-slideshow {
      position: relative;
      border-radius: 14px;
      overflow: hidden;
      margin: 0 auto 18px;
      max-width: 980px;
      background: var(--card, #fff);
      border: 1px solid var(--border);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
    }
    .hero-slides {
      position: relative;
      overflow: hidden;
    }
    .hero-slide {
      display: none;
      position: relative;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
    }
    .hero-slide.active {
      display: block;
      position: relative;
    }
    .hero-slide img {
      width: 100%;
      aspect-ratio: 16 / 9;
      max-height: 420px;
      object-fit: cover;
      object-position: center;
      display: block;
    }
    .hero-caption {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      left: auto;
      width: 40%;
      max-width: 430px;
      z-index: 10;
      padding: 14px 44px 18px 22px;
      background: linear-gradient(to left, rgba(0, 0, 0, 0.94) 0%, rgba(0, 0, 0, 0.86) 65%, rgba(0, 0, 0, 0.4) 90%, transparent 100%);
      color: #ffffff;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 8px;
      pointer-events: none;
    }
    .hero-caption > * {
      pointer-events: auto;
    }
    .hero-title {
      font-size: clamp(20px, 2.3vw, 28px);
      font-weight: 800;
      line-height: 1.2;
      letter-spacing: -0.01em;
      color: #ffffff !important;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.95);
      max-width: 100%;
      word-wrap: break-word;
    }
    .hero-desc {
      font-size: clamp(13px, 1.2vw, 15px);
      line-height: 1.4;
      color: rgba(255, 255, 255, 0.95) !important;
      text-shadow: 0 1px 5px rgba(0, 0, 0, 0.9);
      max-width: 100%;
      word-wrap: break-word;
    }
    .hero-cta {
      display: inline-block;
      align-self: flex-start;
      margin-top: 4px;
      font-size: 13.5px;
      font-weight: 700;
      background: var(--primary, #2b4c7e);
      color: #ffffff !important;
      border-radius: 20px;
      padding: 6px 18px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      transition: transform 0.15s ease, background-color 0.15s ease;
      text-shadow: none;
    }
    .hero-cta:hover {
      background: var(--primary-dark, #1b3356);
      transform: translateY(-1px);
    }
    [data-theme="dark"] .hero-slideshow {
      background: #182232;
      border-color: var(--border);
    }
    [data-theme="dark"] .hero-caption {
      background: linear-gradient(to left, rgba(10, 15, 24, 0.96) 0%, rgba(10, 15, 24, 0.9) 65%, rgba(10, 15, 24, 0.45) 90%, transparent 100%);
    }
    [data-theme="dark"] .hero-title {
      color: #ffffff !important;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.98);
    }
    [data-theme="dark"] .hero-desc {
      color: #e2e8f0 !important;
      text-shadow: 0 1px 5px rgba(0, 0, 0, 0.95);
    }
    [data-theme="dark"] .hero-cta {
      background: #5c8ecc;
      color: #0f172a !important;
      font-weight: 800;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
    }
    [data-theme="dark"] .hero-cta:hover {
      background: #7ca5de;
    }
    .hero-arrow {
      position: absolute;
      top: 40%;
      transform: translateY(-50%);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(0, 0, 0, 0.45);
      color: #ffffff;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      z-index: 15;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    .hero-arrow:hover {
      background: rgba(0, 0, 0, 0.75);
    }
    .hero-prev { left: 12px; }
    .hero-next { right: 12px; }
    .hero-dots {
      position: absolute;
      bottom: 12px;
      right: 16px;
      display: flex;
      gap: 6px;
      z-index: 15;
    }
    .hero-dot {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 0;
      position: relative;
    }
    .hero-dot::after {
      content: "";
      position: absolute;
      top: 6px;
      left: 6px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.45);
      transition: background 0.15s ease, transform 0.15s ease;
    }
    .hero-dot.active::after {
      background: #ffffff;
      transform: scale(1.2);
      box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
    }
    .hero-dot:focus-visible,
    .hero-arrow:focus-visible,
    .hero-cta:focus-visible,
    a.hero-slide:focus-visible .hero-cta {
      outline: 2px solid #fff !important;
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.55);
    }
    a.hero-slide:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: -2px;
    }
    @media (max-width: 640px) {
      .hero-slide img {
        aspect-ratio: 16 / 10;
        max-height: 280px;
        min-height: 220px;
      }
      .hero-caption {
        width: 54%;
        max-width: 300px;
        padding: 10px 24px 12px 12px;
        gap: 4px;
      }
      .hero-title {
        font-size: 15px;
        line-height: 1.2;
      }
      .hero-desc {
        font-size: 11.5px;
        line-height: 1.35;
        margin-top: 1px;
      }
      .hero-cta {
        font-size: 11px;
        padding: 4px 12px;
        margin-top: 2px;
      }
      .hero-arrow {
        width: 30px;
        height: 30px;
        font-size: 18px;
        top: 35%;
      }
      .hero-prev { left: 8px; }
      .hero-next { right: 8px; }
      .hero-dots {
        bottom: 8px;
        right: 10px;
      }
    }
    .pld-suggest-dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 2px);
      left: 0;
      right: 0;
      max-height: 180px;
      overflow-y: auto;
      background: var(--card, #fff);
      border: 1.5px solid var(--primary, #2b4c7e);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      z-index: 10005;
    }
    .pld-suggest-item {
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text, #111);
      border-bottom: 1px solid var(--border-light, #e2e8f0);
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background-color 0.1s ease;
      user-select: none;
    }
    .pld-suggest-item:last-child {
      border-bottom: none;
    }
    .pld-suggest-item:hover,
    .pld-suggest-item.active {
      background: rgba(43, 76, 126, 0.12);
    }
    [data-theme="dark"] .pld-suggest-dropdown {
      background: #1e293b;
      border-color: #5c8ecc;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    }
    [data-theme="dark"] .pld-suggest-item {
      color: #f1f5f9;
      border-bottom-color: rgba(255, 255, 255, 0.1);
    }
    [data-theme="dark"] .pld-suggest-item:hover,
    [data-theme="dark"] .pld-suggest-item.active {
      background: rgba(92, 142, 204, 0.25);
    }
    .card-mini-btn.icon-btn {
      padding: 3px 8px;
      font-size: 14px;
      line-height: 1.2;
    }
    .card-mini-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    .auth-btn {
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.94);
      color: #1e2530;
      border: 1px solid rgba(255, 255, 255, 0.9);
    }
    .auth-btn .auth-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 0 0 1.5px rgba(30, 37, 48, 0.55);
      font-size: 14px;
    }
    .auth-btn:hover {
      background: #fff;
    }
    .auth-btn.logged-in {
      padding: 4px 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
    }
    .auth-btn.logged-in .auth-avatar,
    .auth-btn.logged-in .auth-avatar.plain-gear {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      width: auto !important;
      height: auto !important;
      padding: 0 !important;
      border-radius: 0 !important;
    }
    .auth-btn.logged-in .auth-gear,
    .auth-avatar.plain-gear .auth-gear {
      font-size: 22px;
      line-height: 1;
      display: inline-block;
      transition: transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
      filter: none;
    }
    .auth-btn.logged-in:hover .auth-gear {
      transform: rotate(180deg);
    }
    .auth-btn.logged-in.active-open .auth-gear {
      transform: rotate(90deg);
    }
    .auth-letter {
      display: none !important;
    }
    @media (max-width: 640px) {
      #authBtn .auth-label {
        display: none;
      }
    }
    .auth-menu {
      position: fixed;
      top: 52px;
      right: 12px;
      min-width: 220px;
      background: var(--card, #fff);
      color: var(--text);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      box-shadow: var(--shadow-hover);
      z-index: 9500;
      padding: 8px;
    }
    .auth-menu .auth-menu-email {
      font-size: 12px;
      color: var(--text-muted);
      padding: 8px 14px;
      word-break: break-all;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .auth-menu .settings-menu-label {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-muted);
      padding: 8px 14px 2px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .auth-cal-mobile {
      display: none;
    }
    @media (max-width: 640px) {
      .auth-cal-mobile {
        display: flex;
      }
    }
    .auth-menu .auth-cal-mobile {
      cursor: pointer;
    }
    .auth-btn img {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: block;
    }
    /* Desktop text selection: content selectable, chrome is not. */
    .quick-card-title,
    .quick-card-speaker,
    .quick-card-category,
    .shiur-title,
    .shiur-speaker,
    .shiur-desc,
    .bio-text,
    .did-you-mean-strip,
    .hero-title,
    .hero-desc,
    .search-results-text,
    .meta-row,
    .queue-title,
    .queue-sub {
      user-select: text;
      -webkit-user-select: text;
    }
    .quick-play-badge:focus-visible,
    .series-sub-play:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    /* Circular queue-add button (Spotify-style: list + plus) */    .queue-circle-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1.5px solid var(--border);
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
      padding: 0;
    }
    .queue-circle-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    .queue-circle-btn.active-save {
      border-color: var(--primary);
      color: #fff;
      background: var(--primary);
    }
    .queue-circle-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    [data-theme="dark"] .queue-circle-btn {
      border-color: #4b5563;
      color: #94a3b8;
    }
    [data-theme="dark"] .queue-circle-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    [data-theme="dark"] .queue-circle-btn.active-save {
      border-color: var(--primary);
      background: var(--primary);
      color: #fff;
    }
    /* Did You Mean strip (ROADMAP §5.4) */
    .did-you-mean-strip {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      background: #fffbeb;
      border: 1px solid #fcd34d;
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 14px;
    }
    [data-theme="dark"] .did-you-mean-strip {
      background: #453b0a;
      border-color: #a16207;
    }
    .did-you-mean-strip.resolution-note {
      background: #eef4ff;
      border-color: #b9cdf3;
    }
    [data-theme="dark"] .did-you-mean-strip.resolution-note {
      background: #1b2f4d;
      border-color: #436ea8;
    }
    [data-theme="dark"] .card-mini-btn {
      background: #1f2937;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    [data-theme="dark"] .card-mini-btn.active-save {
      background: #b45309;
      border-color: #b45309;
      color: #fff;
    }
    [data-theme="dark"] .card-mini-btn.active-fav {
      background: #b45309;
      border-color: #fbbf24;
      color: #fff;
    }
    [data-theme="dark"] .playlist-pill {
      background: #1f2937;
      border-color: #4b5563;
      color: #e5e7eb;
    }
    [data-theme="dark"] .playlist-pill.active {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    [data-theme="dark"] .did-you-mean-chip {
      background: #1f2937;
      border-color: var(--primary-light);
      color: var(--primary-light);
    }
    [data-theme="dark"] .card-progress-track {
      background: #374151;
    }
    .did-you-mean-chip {
      cursor: pointer;
      border: 1px solid var(--primary);
      background: #fff;
      color: var(--primary);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 13px;
      font-weight: 700;
    }
    .did-you-mean-chip:hover {
      background: var(--primary);
      color: #fff;
    }
    .preview-focused {
      outline: 2px solid var(--primary);
      outline-offset: -2px;
      background: #eef2f7;
    }
    [data-theme="dark"] .preview-focused {
      background: #24344d;
    }
    /* Dev Playlists (ROADMAP §8) — hidden unless Dev Mode */
    body:not(.dev-mode-active) .dev-only {
      display: none !important;
    }
    /* Account features (playlists, queue, progress): visible in dev mode
    OR when logged in. Hidden otherwise, even with JS guards bypassed. */
    body:not(.dev-mode-active):not(.acct-on) .acct-only {
      display: none !important;
    }
    body.dev-mode-active .dev-playlist-tab {
      border-style: dashed;
    }
    .playlist-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 4px 0 14px;
      grid-column: 1 / -1;
    }
    .playlist-pill {
      cursor: pointer;
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 700;
      border: 1.5px solid var(--border);
      background: var(--card);
      color: var(--text);
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      vertical-align: middle;
      line-height: 1.1;
    }
    .playlist-pill svg {
      vertical-align: middle;
      display: inline-block;
      flex-shrink: 0;
    }
    .playlist-pill:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    .playlist-pill.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .playlist-segmented-bar {
      grid-column: 1 / -1;
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
      border-bottom: 1.5px solid var(--border);
      padding-bottom: 12px;
      align-items: center;
    }
    .playlist-seg-btn {
      cursor: pointer;
      border-radius: 10px;
      padding: 8px 18px;
      font-size: 13.5px;
      font-weight: 700;
      border: 1.5px solid var(--border);
      background: var(--card);
      color: var(--text);
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .playlist-seg-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    .playlist-seg-btn:focus-visible,
    .playlist-pill:focus-visible,
    .new-pl-emoji-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    .playlist-seg-btn.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      box-shadow: 0 2px 6px rgba(43, 76, 126, 0.25);
    }
    [data-theme="dark"] .playlist-seg-btn.active {
      background: #1e2c40;
      color: #7ca5de;
      border-color: #5c8ecc;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    }
    .playlist-system-row {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px dashed var(--border);
      align-items: center;
      position: sticky;
      top: 52px;
      z-index: 10;
      background: var(--bg);
      padding-top: 6px;
    }
    @media (max-width: 640px) {
      .playlist-system-row {
        top: 38px !important;
      }
      .combobox-input,
      #newPlInput,
      #pldTitle,
      #pldDesc,
      #newPlDesc {
        font-size: 16px !important;
      }
    }
    .scrubber-bar:focus-visible {
      outline: 2px solid var(--primary-light) !important;
      outline-offset: 3px !important;
    }
    .playlist-custom-row {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
      align-items: center;
    }
    .playlist-row-caption {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      width: 100%;
      margin: 2px 0 4px;
    }
    .playlist-pill.subscription-pill {
      border-color: #38bdf8;
      background: rgba(56, 189, 248, 0.08);
      color: #0369a1;
    }
    .playlist-pill.subscription-pill:hover {
      border-color: #0284c7;
      color: #0284c7;
    }
    .playlist-pill.subscription-pill.active {
      background: #0284c7;
      color: #fff;
      border-color: #0284c7;
    }
    [data-theme="dark"] .playlist-pill.subscription-pill {
      border-color: #0284c7;
      background: rgba(2, 132, 199, 0.18);
      color: #7dd3fc;
    }
    [data-theme="dark"] .playlist-pill.subscription-pill.active {
      background: #0284c7;
      color: #fff;
      border-color: #38bdf8;
    }
    .playlist-sub-badge {
      background: rgba(56, 189, 248, 0.15) !important;
      color: #0369a1 !important;
      border-color: #38bdf8 !important;
    }
    [data-theme="dark"] .playlist-sub-badge {
      background: rgba(2, 132, 199, 0.25) !important;
      color: #7dd3fc !important;
      border-color: #0284c7 !important;
    }
    .playlist-subscribed-card {
      border: 2px solid #38bdf8 !important;
      box-shadow: 0 0 0 1px #bae6fd, 0 4px 14px rgba(56, 189, 248, 0.15) !important;
    }
    [data-theme="dark"] .playlist-subscribed-card {
      border: 2px solid #0284c7 !important;
      box-shadow: 0 0 0 1px #0369a1, 0 4px 14px rgba(2, 132, 199, 0.3) !important;
    }
    .playlist-author-card {
      border: 2px solid var(--primary) !important;
      box-shadow: 0 0 0 1px rgba(43, 76, 126, 0.2), 0 4px 14px rgba(43, 76, 126, 0.12) !important;
    }
    [data-theme="dark"] .playlist-author-card {
      border: 2px solid #60a5fa !important;
      box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.3), 0 4px 14px rgba(96, 165, 250, 0.25) !important;
    }
    .pl-tick-add {
      color: #15803d !important;
      font-weight: 800;
      font-size: 12px;
    }
    [data-theme="dark"] .pl-tick-add {
      color: #4ade80 !important;
    }
    .pl-tick-del {
      color: #dc2626 !important;
      font-weight: 800;
      font-size: 12px;
    }
    [data-theme="dark"] .pl-tick-del {
      color: #f87171 !important;
    }
    .pl-save-changes-btn {
      background: var(--primary) !important;
      color: #fff !important;
      border-color: var(--primary) !important;
    }
    [data-theme="dark"] .pl-save-changes-btn {
      background: #2563eb !important;
      color: #fff !important;
      border-color: #3b82f6 !important;
    }
    .playlist-item-wrap {
      transition: all 0.15s ease;
    }
    .playlist-item-wrap.drag-over {
      outline: 2px dashed var(--primary);
      outline-offset: 4px;
      border-radius: 12px;
      transform: scale(0.99);
    }
    .playlist-item-wrap.dragging {
      opacity: 0.45;
    }
    .playlist-reorder-btn {
      min-width: 32px;
      min-height: 32px;
      padding: 4px 10px;
      font-size: 13px;
      font-weight: 700;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .playlist-reorder-btn:hover:not(:disabled) {
      border-color: var(--primary);
      color: var(--primary);
      background: var(--bg);
    }
    .playlist-reorder-btn:focus-visible {
      outline: 2px solid var(--primary-light) !important;
      outline-offset: 2px !important;
    }
    .playlist-reorder-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    .new-pl-emoji-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 6px 0 12px;
    }
    .new-pl-emoji-btn {
      font-size: 18px;
      padding: 6px 9px;
      border-radius: 8px;
      border: 1.5px solid var(--border);
      background: var(--card);
      cursor: pointer;
      transition: all 0.15s ease;
      line-height: 1;
    }
    .new-pl-emoji-btn:hover {
      border-color: var(--primary);
      transform: scale(1.12);
    }
    .new-pl-emoji-btn.selected {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.12);
      box-shadow: 0 0 0 1.5px var(--primary);
    }
    [data-theme="dark"] .new-pl-emoji-btn.selected {
      background: rgba(92, 142, 204, 0.25);
      box-shadow: 0 0 0 1.5px #7ca5de;
      border-color: #7ca5de;
    }
    .playlist-public-card {
      grid-column: 1 / -1;
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      margin-bottom: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .playlist-public-card:hover {
      border-color: var(--primary);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
    }
    [data-theme="dark"] .playlist-public-card {
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    }
    [data-theme="dark"] .playlist-public-card:hover {
      border-color: var(--primary-light, #7ca5de);
    }
    .playlist-card-title {
      font-weight: 800;
      font-size: 16.5px;
      color: var(--text);
      line-height: 1.3;
    }
    .playlist-card-meta {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--primary);
      margin-top: 4px;
    }
    [data-theme="dark"] .playlist-card-meta {
      color: var(--primary-light, #7ca5de);
    }
    .playlist-card-desc {
      font-size: 13.5px;
      line-height: 1.5;
      color: var(--text);
      margin-top: 8px;
    }
    .playlist-card-tags {
      font-size: 12px;
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .playlist-tag-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      font-size: 11.5px;
      font-weight: 500;
      color: var(--text);
    }
    .save-choice-card {
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      cursor: pointer;
      transition: all 0.15s ease;
      width: 100%;
      text-align: left;
    }
    .save-choice-card:hover {
      border-color: var(--primary);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    }
    .save-choice-card:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
    [data-theme="dark"] .save-choice-card {
      background: #182232;
      border-color: #28364d;
    }
    [data-theme="dark"] .save-choice-card:hover {
      border-color: #5c8ecc;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      background: #1f2b3e;
    }
    .card-progress-track {
      height: 4px;
      background: #e4e8ef;
      border-radius: 0 0 10px 10px;
      overflow: hidden;
      margin-top: 8px;
    }
    .card-progress-fill {
      height: 100%;
      background: var(--primary);
      border-radius: inherit;
    }
    .card-listen-meta {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .card-mini-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      align-items: center;
    }
    .card-mini-btn {
      cursor: pointer;
      border: 1.5px solid var(--border);
      background: var(--card);
      color: var(--text);
      border-radius: 16px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      line-height: 1.2;
      vertical-align: middle;
      transition: all 0.15s ease;
    }
    .card-mini-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    .card-mini-btn.active-save {
      background: #b45309;
      color: #fff;
      border-color: #b45309;
      opacity: 1;
    }
    .card-mini-btn.active-fav {
      background: #b45309;
      border-color: #b45309;
      color: #fff;
      opacity: 1;
    }

    /* Load More Button */
    .load-more-btn {
      background: var(--card);
      color: var(--primary);
      border: 2px solid var(--primary);
      border-radius: 10px;
      padding: 12px 28px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .load-more-btn:hover {
      background: var(--primary);
      color: #fff;
      transform: translateY(-2px);
      box-shadow: 0 4px 14px rgba(43, 76, 126, 0.2);
    }
    .load-more-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .spinner-small {
      border: 2px solid rgba(43, 76, 126, 0.3);
      border-top: 2px solid var(--primary);
      border-radius: 50%;
      width: 16px;
      height: 16px;
      animation: spin 0.8s linear infinite;
    }
    .load-more-btn:hover .spinner-small {
      border-color: rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
    }

    /* Shiur Metadata Box */
    .shiur-metadata-box {
      margin-top: 16px;
      padding: 14px 18px;
      background: var(--bg);
      border-radius: 12px;
      border: 1px solid var(--border-light);
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .meta-row:last-child { margin-bottom: 0; }
    .meta-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      min-width: 80px;
      flex-shrink: 0;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 20px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--primary);
      transition: all 0.15s ease;
      text-decoration: none;
      white-space: nowrap;
    }
    .meta-chip:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(43, 76, 126, 0.2);
    }
    .meta-chip.speaker-chip { border-color: #4a90d9; color: #2563a0; }
    .meta-chip.speaker-chip:hover { background: #2563a0; color: #fff; border-color: #2563a0; }
    .meta-chip.venue-chip { border-color: #d4a373; color: #a67c52; }
    .meta-chip.venue-chip:hover { background: #a67c52; color: #fff; border-color: #a67c52; }
    .meta-chip.category-chip { border-color: #65a765; color: #3d7a3d; }
    .meta-chip.category-chip:hover { background: #3d7a3d; color: #fff; border-color: #3d7a3d; }
    .meta-chip.keyword-chip { border-color: #b0b0b0; color: #666; font-size: 12px; padding: 3px 10px; }
    .meta-chip.keyword-chip:hover { background: #666; color: #fff; border-color: #666; }
    .meta-group-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-right: 2px;
    }

    /* Mini Player (persistent bottom bar) */
    #miniPlayer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1001;
      background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%);
      color: #fff;
      display: none;
      flex-direction: column;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    }
    #miniPlayer.visible { display: flex; }
    .mini-progress-track {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.25);
      cursor: pointer;
      position: relative;
      overflow: visible;
    }
    .mini-progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      position: relative;
      transition: width 0.15s linear;
    }
    .mini-progress-circle {
      position: absolute;
      right: -5px;
      top: 50%;
      transform: translateY(-50%);
      width: 10px;
      height: 10px;
      background: #ffffff;
      border-radius: 50%;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      pointer-events: none;
    }
    .mini-progress-bar.is-sponsor-preroll .mini-progress-fill {
      transition: none !important;
    }
    .mini-progress-bar.is-sponsor-preroll .mini-progress-circle {
      width: 15px;
      height: 15px;
      right: -7px;
      background-color: #ffffff;
      background-image: url('https://cdnyutorah.cachefly.net/public/v3/images/logo-university-2x.png');
      background-size: 85% 85%;
      background-position: center;
      background-repeat: no-repeat;
      border: 1.5px solid #b8860b;
      box-shadow: 0 0 6px rgba(184, 134, 11, 0.7);
    }
    .mini-content {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      gap: 10px;
    }
    .mini-thumb {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      border: 2px solid rgba(255,255,255,0.3);
    }
    .mini-info {
      flex: 1;
      min-width: 0;
      cursor: pointer;
    }
    .mini-title {
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-speaker {
      font-size: 11px;
      opacity: 0.8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-time {
      font-size: 11px;
      opacity: 0.7;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .mini-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .mini-btn {
      background: none;
      border: none;
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      padding: 6px 8px;
      border-radius: 50%;
      transition: all 0.15s ease;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .mini-btn:hover { background: rgba(255,255,255,0.15); }
    .mini-play-btn {
      background: rgba(255,255,255,0.22);
      border: 1.5px solid rgba(255,255,255,0.5);
      color: #fff;
      width: 36px;
      height: 36px;
      padding: 0;
      box-sizing: border-box;
      border-radius: 50%;
      font-size: 17px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      margin: 0 4px;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-user-select: none;
      user-select: none;
    }
    .mini-play-btn svg {
      display: block;
      margin: 0 auto;
    }
    .mini-play-btn:focus:not(:focus-visible),
    .mini-play-btn:active {
      outline: none;
    }
    .mini-play-btn:focus-visible {
      outline: 2px solid var(--primary-light) !important;
      outline-offset: 2px !important;
    }
    .mini-play-btn:hover {
      background: rgba(255,255,255,0.35);
      border-color: #fff;
      transform: scale(1.08);
    }
    .mini-btn.skip-btn {
      background: none !important;
      border: none !important;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      line-height: 1;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-user-select: none;
      user-select: none;
      box-shadow: none !important;
    }
    .mini-btn.skip-btn:focus:not(:focus-visible),
    .mini-btn.skip-btn:active {
      background: none !important;
      outline: none;
      box-shadow: none !important;
    }
    .mini-btn.skip-btn:focus-visible {
      outline: 2px solid var(--primary-light) !important;
      outline-offset: 2px !important;
    }
    .mini-btn.skip-btn:hover {
      transform: scale(1.08);
    }
    .mini-btn.skip-btn:active {
      transform: scale(0.96);
    }
    .mini-btn.skip-btn:hover polygon {
      fill: rgba(255,255,255,0.32);
      stroke: rgba(255,255,255,0.85);
    }
    .mini-btn.expand-btn { font-size: 16px; margin-left: 2px; }
    .mini-btn.close-btn { font-size: 16px; opacity: 0.7; }
    .mini-btn.close-btn:hover { opacity: 1; }

    body.mini-player-active {
      padding-bottom: 64px;
    }

    /* Purim Venahafoch Hu Shtick: Invert header to bottom */
    body.is-purim-theme header#mainHeader {
      top: auto;
      bottom: 0;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.15);
    }
    body.is-purim-theme .header-spacer {
      display: none;
    }
    body.is-purim-theme {
      padding-bottom: 54px;
    }
    body.is-purim-theme.mini-player-active {
      padding-bottom: 118px;
    }
    body.is-purim-theme #miniPlayer {
      bottom: 50px;
    }

    /* Speaker & Venue Bio / Description Banner */
    .bio-banner {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.04);
    }
    .bio-header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 12px;
    }
    .bio-avatar {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid var(--border);
      flex-shrink: 0;
      background: #e2e6ec;
    }
    .bio-meta {
      flex: 1;
      min-width: 0;
    }
    .bio-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 3px;
    }
    .bio-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .bio-text {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      transition: max-height 0.3s ease;
    }
    .bio-text.collapsed {
      max-height: 72px;
      overflow: hidden;
      position: relative;
      -webkit-mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
      mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
    }
    .bio-text p {
      margin-bottom: 8px;
    }
    .bio-text p:last-child {
      margin-bottom: 0;
    }
    .bio-toggle-btn {
      background: none;
      border: none;
      color: var(--primary);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 8px;
      padding: 4px 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .bio-toggle-btn:hover {
      text-decoration: underline;
    }

    @media (max-width: 600px) {
      .mini-time { display: none; }
      .mini-content { padding: 6px 8px; gap: 8px; }
      .mini-thumb { width: 34px; height: 34px; }
    }

    /* Advanced Search Modal & Filter Pills */
    .advanced-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(10, 25, 47, 0.6);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .advanced-modal-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .advanced-modal-card {
      background: var(--card);
      border-radius: 16px;
      width: 100%;
      max-width: 640px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 40px rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      overflow: hidden;
      transform: translateY(20px) scale(0.97);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .advanced-modal-backdrop.open .advanced-modal-card {
      transform: translateY(0) scale(1);
    }
    .modal-header {
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 800;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    [data-theme="dark"] .modal-title {
      color: #93c5fd;
    }
    .modal-close-btn {
      background: none;
      border: none;
      font-size: 24px;
      line-height: 1;
      cursor: pointer;
      color: var(--text-muted);
      padding: 4px;
      border-radius: 6px;
      transition: all 0.15s;
    }
    .transliteration-status-card {
      background: linear-gradient(135deg, rgba(43, 76, 126, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%);
      border: 1.5px solid rgba(43, 76, 126, 0.2);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    [data-theme="dark"] .transliteration-status-card {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.12) 0%, rgba(99, 102, 241, 0.12) 100%);
      border-color: rgba(96, 165, 250, 0.3);
    }
    .translit-badge-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    [data-theme="dark"] .translit-badge-title {
      color: #93c5fd;
    }
    .translit-info-btn {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      border-radius: 50%;
      border: 1.5px solid var(--primary);
      background: transparent;
      color: var(--primary);
      font-size: 13px;
      font-weight: 800;
      font-style: italic;
      font-family: Georgia, serif;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }
    .translit-info-btn:hover {
      background: var(--primary);
      color: #fff;
    }
    .translit-info-btn:focus-visible {
      outline: 2px solid var(--primary) !important;
      outline-offset: 2px;
    }
    .translit-switch {
      display: flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 800;
      color: var(--text);
    }
    .translit-switch input {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
      cursor: pointer;
      margin: 0;
    }
    .translit-badge-desc {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 2px;
      line-height: 1.35;
    }
    .filter-dimensions-hint {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 4px;
    }
    .dim-tag {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 12px;
      background: rgba(0,0,0,0.04);
      color: var(--text-muted);
      border: 1px solid var(--border-light);
    }
    [data-theme="dark"] .dim-tag {
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.1);
      color: #94a3b8;
    }
    .modal-close-btn:hover {
      color: var(--text);
      background: rgba(0,0,0,0.06);
    }
    .modal-body {
      padding: 20px 24px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .filter-label {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .filter-label-hint {
      font-size: 11px;
      font-weight: 400;
      color: var(--text-muted);
    }
    .filter-input, .filter-select {
      width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1.5px solid var(--border);
      background: #fafbfc;
      color: var(--text);
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    .filter-input:focus, .filter-select:focus {
      border-color: var(--primary);
      background: #fff;
    }
    [data-theme="dark"] .filter-input, [data-theme="dark"] .filter-select {
      background: #131c2a;
      border-color: #28364d;
      color: #e7edf7;
    }
    [data-theme="dark"] .filter-input:focus, [data-theme="dark"] .filter-select:focus {
      background: #1a2638;
      border-color: #436ea8;
    }

    /* Autocomplete Multi-Select Box */
    .autocomplete-combobox {
      position: relative;
      width: 100%;
    }
    .chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 42px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1.5px solid var(--border);
      background: #fafbfc;
      cursor: text;
      align-items: center;
      transition: border-color 0.15s;
    }
    .chips-container:focus-within {
      border-color: var(--primary);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(43, 76, 126, 0.12);
    }
    [data-theme="dark"] .chips-container {
      background: #131c2a;
      border-color: #28364d;
    }
    [data-theme="dark"] .chips-container:focus-within {
      background: #1a2638;
      border-color: #436ea8;
      box-shadow: 0 0 0 3px rgba(67, 110, 168, 0.28);
    }
    .combobox-token {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(43, 76, 126, 0.12);
      color: var(--primary);
      border: 1px solid rgba(43, 76, 126, 0.25);
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 12px;
      font-weight: 600;
      user-select: none;
      animation: tokenFadeIn 0.15s ease-out;
    }
    @keyframes tokenFadeIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
    [data-theme="dark"] .combobox-token {
      background: rgba(147, 197, 253, 0.15);
      color: #bfdbfe;
      border-color: rgba(147, 197, 253, 0.3);
    }
    .token-remove-btn {
      background: none;
      border: none;
      color: inherit;
      font-size: 14px;
      cursor: pointer;
      line-height: 1;
      padding: 4px 6px;
      min-width: 24px;
      min-height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      opacity: 0.75;
    }
    .token-remove-btn:hover {
      opacity: 1;
      background: rgba(0,0,0,0.1);
    }
    .combobox-input {
      border: none;
      outline: none;
      background: transparent;
      font-size: 13.5px;
      color: var(--text);
      flex: 1;
      min-width: 120px;
      padding: 3px 0;
    }
    .combobox-input::placeholder {
      color: var(--text-muted);
    }
    .autocomplete-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 220px;
      overflow-y: auto;
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.18);
      z-index: 2500;
      display: none;
    }
    .autocomplete-item {
      padding: 8px 12px;
      font-size: 13px;
      color: var(--text);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-light);
      transition: background 0.1s;
    }
    .autocomplete-item:last-child {
      border-bottom: none;
    }
    .autocomplete-item:hover, .autocomplete-item.focused {
      background: rgba(43, 76, 126, 0.08);
      color: var(--primary);
    }
    [data-theme="dark"] .autocomplete-item:hover, [data-theme="dark"] .autocomplete-item.focused {
      background: rgba(147, 197, 253, 0.12);
      color: #93c5fd;
    }
    .item-count-badge {
      font-size: 11px;
      color: var(--text-muted);
      background: rgba(0,0,0,0.05);
      padding: 1px 6px;
      border-radius: 10px;
    }
    [data-theme="dark"] .item-count-badge {
      background: rgba(255,255,255,0.08);
    }
    .duration-presets-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .duration-preset-btn {
      flex: 1;
      min-width: 90px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .duration-preset-btn:hover {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.05);
    }
    .duration-preset-btn.selected {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .media-presets-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .media-preset-btn {
      flex: 1;
      min-width: 90px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .media-preset-btn:hover {
      border-color: var(--primary);
      background: rgba(43, 76, 126, 0.05);
    }
    .media-preset-btn.selected {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .modal-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card);
    }
    .modal-reset-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 6px;
    }
    .modal-reset-btn:hover {
      color: #c0392b;
      text-decoration: underline;
    }
    .modal-action-btns {
      display: flex;
      gap: 10px;
    }
    .modal-cancel-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .modal-submit-btn {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 8px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(43, 76, 126, 0.3);
    }
    .modal-submit-btn:hover {
      background: var(--primary-dark);
    }

    /* Active Filter Pills Bar */
    .active-filters-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
      padding: 10px 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .active-filter-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(43, 76, 126, 0.08);
      color: var(--primary);
      border: 1px solid rgba(43, 76, 126, 0.2);
      font-size: 12.5px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 14px;
    }
    [data-theme="dark"] .active-filter-pill {
      background: rgba(147, 197, 253, 0.12);
      color: #93c5fd;
      border-color: rgba(147, 197, 253, 0.3);
    }
    .active-filter-pill button {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 4px 6px;
      min-width: 24px;
      min-height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      opacity: 0.7;
      border-radius: 4px;
    }
    .active-filter-pill button:hover {
      opacity: 1;
    }

    /* Phonetic Expansion Notice Banner */
    .phonetic-notice-banner {
      background: linear-gradient(135deg, rgba(217, 119, 6, 0.1) 0%, rgba(245, 158, 11, 0.05) 100%);
      border: 1px solid rgba(217, 119, 6, 0.3);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 13px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .phonetic-notice-tags {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 4px;
    }
    .phonetic-tag {
      background: rgba(217, 119, 6, 0.15);
      color: #b45309;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12px;
    }
    [data-theme="dark"] .phonetic-tag {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
      font-size: 13px;
      border-top: 1px solid var(--border);
      margin-top: auto;
    }
    footer a {
      color: var(--primary);
      text-decoration: none;
      font-weight: 600;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>

<header id="mainHeader">
  <div class="header-inner">
    <a href="/" class="brand" onclick="goHome(event)">
      🎧 YUTorah Enhanced <span>PLAYER</span>
    </a>
    <div class="header-right">
      <div id="holidayMotifWrap" class="holiday-motif-wrap" onclick="handleCalendarSecretClick(event)" style="display: none;" title="">
        <span id="holidayMotifIcon" class="holiday-motif-icon"></span>
        <span id="holidayMotifTitle" class="holiday-motif-title"></span>
      </div>
      <!-- [DEAD CODE / TEMPORARILY HIDDEN] Settings button, Simple View switch, and Holiday Theme preview picker -->
      <div class="settings-wrapper" style="display: none !important;" aria-hidden="true">
        <button type="button" id="settingsBtn" class="theme-toggle-btn settings-btn" onclick="toggleSettingsMenu(event)" title="Settings" style="display: none !important;">⚙️</button>
        <div id="settingsMenu" class="settings-menu" style="display: none !important;">
          <button type="button" class="settings-menu-item menu-theme-toggle-btn" onclick="toggleTheme();">
            <span class="menu-theme-icon">${themeMode === 'dark' ? '☀️' : '🌙'}</span> <span>Light / Dark Mode</span>
          </button>
          <button type="button" class="settings-menu-item dev-only" onclick="openChangelogModal()" title="Log of latest changes">
            <span>📋</span> <span>Change Log</span>
          </button>
          <div class="settings-menu-label dev-only" style="margin-top:6px;">Save button icon</div>
          <div id="saveIconPicker" class="dev-only" style="display:flex; gap:6px; padding:4px 10px 8px; flex-wrap:wrap;"></div>
          <!-- [DEAD CODE / INACTIVE] Switch to Simple View -->
          <button type="button" id="toggleViewModeBtn" class="settings-menu-item" onclick="toggleViewMode(event)" style="display: none !important;">
            <span id="viewModeIcon">✨</span> <span id="viewModeText">Switch to Simple View</span>
          </button>
          <div class="settings-menu-divider" style="display: none !important;"></div>
          <!-- [DEAD CODE / INACTIVE] Holiday Theme Preview Picker -->
          <div class="settings-menu-label" style="display: none !important;">🎨 Holiday Theme Preview</div>
          <div class="theme-select-wrap" style="display: none !important;">
            <select id="holidayThemeSelect" class="theme-select" onchange="onHolidayThemeSelect(this.value)">
              <option value="auto">✨ Auto-Detect (Hebrew Date)</option>
              <optgroup label="High Holidays & Fall">
                <option value="elul">✓ Chodesh Elul (Variant A — Classic Shofar)</option>
                <option value="rosh_hashanah">✓ Rosh Hashanah (Random A/B)</option>
                <option value="teshuva">Aseres Yemei Teshuva</option>
                <option value="yom_kippur">✓ Yom Kippur (Variant A — Beis HaMikdash Heichal)</option>
                <option value="sukkos">✓ Sukkos (Random A/B)</option>
                <option value="hoshana_rabbah">Hoshana Rabbah (Aravos)</option>
                <option value="simchas_torah">✓ Simchas Torah (Random A/B)</option>
                <option value="rosh_chodesh_cheshvan">Rosh Chodesh Mar Cheshvan</option>
              </optgroup>
              <optgroup label="Chanukah (8 Days)">
                <option value="chanukah_1">✓ Chanukah — Night 1 (1 Candle)</option>
                <option value="chanukah_2">✓ Chanukah — Night 2 (2 Candles)</option>
                <option value="chanukah_3">✓ Chanukah — Night 3 (3 Candles)</option>
                <option value="chanukah_4">✓ Chanukah — Night 4 (4 Candles)</option>
                <option value="chanukah_5">✓ Chanukah — Night 5 (5 Candles)</option>
                <option value="chanukah_6">✓ Chanukah — Night 6 (6 Candles)</option>
                <option value="chanukah_7">✓ Chanukah — Night 7 (7 Candles)</option>
                <option value="chanukah_8">✓ Chanukah — Night 8 (8 Candles)</option>
              </optgroup>
              <optgroup label="Winter & Spring">
                <option value="tubshevat">✓ Tu B'Shevat (Variant A — Flowering Fruit Tree)</option>
                <option value="adar_buildup">✓ Rosh Chodesh Adar (Random A/B)</option>
                <option value="taanis_esther">✓ Ta'anis Esther (Variant A — Royal Megillah Scroll)</option>
                <option value="purim">✓ Purim (Variant A — Royal Shushan Crown & Megillah)</option>
                <option value="nissan_buildup">✓ Rosh Chodesh Nissan → Pesach (Random A/B)</option>
                <option value="pesach">✓ Pesach (Random A/B)</option>
                <option value="omer">✓ Sefiras HaOmer (Variant A — Random Icon A/B)</option>
                <option value="yom_hazikaron">✓ Yom HaZikaron (Variant A — Memorial Flame)</option>
                <option value="yom_haatzmaut">✓ Yom HaAtzmaut (Variant B — Waving Flag)</option>
                <option value="lag_baomer">✓ Lag BaOmer (Random A/B — Clean)</option>
                <option value="yom_yerushalayim">✓ Yom Yerushalayim (Variant A — Golden Kotel)</option>
                <option value="shavuos">✓ Shavuos (Random A/B)</option>
              </optgroup>
              <optgroup label="Summer">
                <option value="july4">✓ July 4th (Variant A — American Flag)</option>
                <option value="three_weeks">✓ The Three Weeks (Variant A — Sandstone Candle)</option>
                <option value="nine_days">✓ The Nine Days (Random A/B)</option>
                <option value="tisha_bav">✓ Tisha B'Av (Variant A — Solitary Flame on Kotel Stone)</option>
                <option value="tubav">✓ Tu B'Av (Variant A — Vine Blossom & Heart)</option>
                <option value="rosh_chodesh">✓ Rosh Chodesh (Variant A — Crescent Moon)</option>
              </optgroup>
            </select>
          </div>
          <div class="variant-toggle-wrap" style="display: none !important;">
            <button type="button" id="variantBtnA" class="variant-btn active" onclick="setThemeVariant('a')">Variant A</button>
            <button type="button" id="variantBtnB" class="variant-btn" onclick="setThemeVariant('b')">Variant B</button>
            <button type="button" id="variantBtnC" class="variant-btn" onclick="setThemeVariant('c')" style="display:none;">Variant C</button>
          </div>
        </div>
      </div>
      <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" class="support-yutorah-btn" title="Support YUTorah & Sponsor Learning (Opens in new window)">❤️ Support YUTorah</a>
      <div class="hebrew-date-badge" id="hebrewDateBadge" onclick="handleCalendarSecretClick(event); pulseHebrewDate();" tabindex="0" role="button" aria-label="Hebrew date" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();handleCalendarSecretClick(event);pulseHebrewDate();}" title="">📅<span class="hebrew-date-text">&nbsp;&nbsp;${escapeHtml(homepageData?.hebrewDateString || 'Calendar')}</span></div>
      <button type="button" id="authBtn" class="theme-toggle-btn auth-btn" onclick="toggleAuthMenu(event)" title="Sign in to sync across devices">
        <span class="auth-icon">👤</span><span class="auth-label"> Sign in</span>
      </button>
      <div id="authMenu" class="auth-menu" style="display: none;" role="menu" aria-label="Account"></div>
      <button type="button" id="themeToggleBtn" class="theme-toggle-btn" onclick="toggleTheme()" title="Toggle Dark / Light Mode">${themeMode === 'light' ? '🌙' : '☀️'}</button>
    </div>
  </div>
</header>
<div id="secretToast" class="secret-toast" style="display: none;"></div>
<div class="header-spacer" id="headerSpacer"></div>

<div class="sponsorship-banner">
  <div class="sponsorship-content">
    <span class="sponsorship-text">${sponsorshipText || 'Learning on the Marcos and Adina Katz YUTorah site is sponsored today by <strong>The Ohayon family in Hamilton, ON</strong> to mark the yahrtzeit of Shimon ben Issaschar Ruimy on 24 Elul and for a refuah shleima for Avraham Yitzchak Fishel ben Chaina Shifra'}</span>
    <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" class="sponsorship-support-pill" title="Support YUTorah (Opens in new window)">Support YUTorah ↗</a>
  </div>
</div>
<div id="holidayTaglineBar" class="holiday-tagline-bar" style="display: none;"></div>

<main>

  <div class="timely-collapsible-wrap">
    <button type="button" class="timely-collapsible-trigger" id="timelyTriggerBtn" onclick="toggleTimelyCollapse()" aria-expanded="false" title="Click to view daily learning schedule">
      <span class="timely-trigger-left">
        <span class="timely-icon">⏰</span>
        <span class="timely-title">Timely Study:</span>
        <span class="timely-summary-badges">
          <span class="timely-badge">📖 ${escapeHtml(parshaDisplayTitle)}</span>
          ${timely?.dafStr ? `<span class="timely-badge">📜 ${escapeHtml(timely.dafStr)}</span>` : ''}
          ${timely?.mishnaYomiStr ? `<span class="timely-badge">📗 ${escapeHtml(timely.mishnaYomiStr)}</span>` : ''}
        </span>
      </span>
      <span class="timely-trigger-right">
        <span class="timely-dropdown-indicator" id="timelyIndicator">Explore ▾</span>
      </span>
    </button>
    
    <div class="timely-dropdown-menu" id="timelyDropdownMenu" style="display: none;">
      <div class="timely-menu-grid">
        <!-- 1. Weekly Parsha -->
        <a href="/?category=${parshaCatId}" class="timely-menu-card" data-cat="${escapeHtml(parshaCatId)}" data-label="Parsha: ${escapeHtml(parshaDisplayTitle)}" onclick="filterByCategory(this.dataset.cat, this.dataset.label); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(parshaDisplayTitle)} shiurim">
          <div class="timely-card-icon">📖</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Weekly Parsha</div>
            <div class="timely-card-val">${escapeHtml(parshaDisplayTitle)}</div>
            ${parshaHolidayNote ? `<div class="timely-card-note">(${escapeHtml(parshaHolidayNote)})</div>` : ''}
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>

        <!-- 2. Daf Yomi (Gemara) -->
        <a href="/?search=${encodeURIComponent(timely?.dafStr || 'Daf Yomi')}" class="timely-menu-card" data-query="${escapeHtml(timely?.dafStr || '')}" onclick="searchFor(this.dataset.query); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(timely?.dafStr || 'Daf Yomi')} shiurim">
          <div class="timely-card-icon">📜</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Daf Yomi (Gemara)</div>
            <div class="timely-card-val">${escapeHtml(timely?.dafStr || 'Today\'s Daf')}</div>
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>

        <!-- 3. Mishna Yomi -->
        <a href="/?category=${timely?.mishnaYomiSubcategoryID || '234949'}" class="timely-menu-card" data-cat="${escapeHtml(timely?.mishnaYomiSubcategoryID || '234949')}" data-label="Mishna Yomi: ${escapeHtml(timely?.mishnaYomiStr || '')}" onclick="filterByCategory(this.dataset.cat, this.dataset.label); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(timely?.mishnaYomiStr || 'Mishna Yomi')} shiurim">
          <div class="timely-card-icon">📗</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Mishna Yomi</div>
            <div class="timely-card-val">${escapeHtml(timely?.mishnaYomiStr || 'Today\'s Mishna')}</div>
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>

        <!-- 4. Nach Yomi -->
        <a href="/?category=${timely?.nachYomiSubcategoryID || '234877'}" class="timely-menu-card" data-cat="${escapeHtml(timely?.nachYomiSubcategoryID || '234877')}" data-label="Nach Yomi: ${escapeHtml(timely?.nachYomiStr || '')}" onclick="filterByCategory(this.dataset.cat, this.dataset.label); closeTimelyDropdown(); return false;" title="Browse ${escapeHtml(timely?.nachYomiStr || 'Nach Yomi')} shiurim">
          <div class="timely-card-icon">📘</div>
          <div class="timely-card-body">
            <div class="timely-card-label">Nach Yomi</div>
            <div class="timely-card-val">${escapeHtml(timely?.nachYomiStr || 'Today\'s Perek')}</div>
          </div>
          <div class="timely-card-action">Browse →</div>
        </a>
      </div>
    </div>
  </div>

  <!-- Real-time Search Card -->
  <div class="search-card">
    <form class="search-form" id="searchForm" onsubmit="doSearch(); return false;" action="javascript:void(0);">
      <div class="search-input-wrapper">
        <span class="search-icon">🔍</span>
        <input
          type="text"
          id="searchInput"
          class="search-input"
          placeholder="Search 440,000+ shiurim (e.g. Schachter, Teshuva, Netzavim, or ID)..."
          value="${escapeHtml(searchQuery)}"
          autocomplete="off"
          oninput="onSearchInput()"
          onkeydown="if(event.key === 'Enter'){ event.preventDefault(); doSearch(); }"
        >
        <button type="button" class="clear-search-btn" id="clearSearchBtn" onclick="clearSearch()" title="Clear">×</button>
        <!-- Debounced Live Search Suggestions & Results Preview Dropdown -->
        <div class="search-preview-dropdown" id="searchPreviewDropdown"></div>
      </div>
      <div class="search-actions-row">
        <button type="button" class="search-submit-btn" onclick="doSearch()">Search</button>
        <button type="button" class="advanced-search-btn" id="advancedSearchBtn" onclick="openAdvancedModal()" title="Open Advanced Search & Multi-Criteria Filters"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle;"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg> Filters</button>
      </div>
    </form>

    <!-- Quick topic / speaker chips -->
    <div class="quick-chips">
      <span style="font-size:12px; color:var(--text-muted); padding:4px 2px; font-weight:600;">Popular:</span>
      <button class="chip" onclick="searchFor('Elul')">🏷️ Elul & Teshuvah</button>
      <button class="chip" onclick="searchFor('Rosh Hashanah')">🏷️ Rosh Hashanah</button>
      <button class="chip" onclick="searchFor('Rabbi Hershel Schachter')">👤 R' Schachter</button>
      <button class="chip" onclick="searchFor('Rabbi Michael Rosensweig')">👤 R' Rosensweig</button>
      <button class="chip" onclick="searchFor('Rabbi Mayer Twersky')">👤 R' Twersky</button>
      <button class="chip" onclick="searchFor('Rabbi Aryeh Lebowitz')">👤 R' Lebowitz</button>
      <button class="chip" onclick="searchFor('Rabbi Yaakov Neuburger')">👤 R' Neuburger</button>
      <button class="chip" onclick="searchFor('Rabbi Moshe Taragin')">👤 R' Taragin</button>
      <button class="chip" onclick="searchFor('Daf Yomi')">📜 Daf Yomi</button>
    </div>
  </div>

  <!-- Dynamic Search Results Section (Shown when search or filter is active) -->
  <div id="searchResultsSection" style="${initialSearchResults ? '' : 'display: none;'}">
    <!-- Active Filter Pills Bar (Shown when multi-criteria filters are active) -->
    <div id="activeFiltersBar" class="active-filters-bar" style="display: none;"></div>

    <!-- Quick Date Filters (every search: All / Today / Yesterday / This Week / This Month) & Result Sort -->
    <div id="dateQuickRow" class="date-quick-row">
      <div class="date-quick-subrow">
        <span class="date-quick-caption">📅 When:</span>
        <button type="button" class="date-quick-chip selected" data-preset="all" onclick="setDateQuick('all', this)">All Dates</button>
        <button type="button" class="date-quick-chip" data-preset="today" onclick="setDateQuick('today', this)">Today</button>
        <button type="button" class="date-quick-chip" data-preset="yesterday" onclick="setDateQuick('yesterday', this)">Yesterday</button>
        <button type="button" class="date-quick-chip" data-preset="week" onclick="setDateQuick('week', this)">This Week</button>
        <button type="button" class="date-quick-chip" data-preset="month" onclick="setDateQuick('month', this)">This Month</button>
      </div>
      <div class="date-quick-subrow">
        <span class="date-quick-caption">↕️ Sort:</span>
        <button type="button" class="date-quick-chip sort-chip selected" data-sort="relevance" onclick="setResultSort('relevance', this)">Relevance</button>
        <button type="button" class="date-quick-chip sort-chip" data-sort="newest" onclick="setResultSort('newest', this)">Newest</button>
        <button type="button" class="date-quick-chip sort-chip" data-sort="oldest" onclick="setResultSort('oldest', this)">Oldest</button>
      </div>
    </div>

    <!-- Phonetic Expansion Notice Banner (Shown when transliteration synonyms were searched) -->
    <div id="phoneticNoticeBanner" class="phonetic-notice-banner" style="${initialPhoneticExpansion && initialPhoneticExpansion.tokens && initialPhoneticExpansion.tokens.length > 1 ? 'display: flex;' : 'display: none;'}">
      ${initialPhoneticExpansion && initialPhoneticExpansion.tokens && initialPhoneticExpansion.tokens.length > 1 ? `
        <div><span>✨ Phonetic Equivalence included synonyms:</span> <div class="phonetic-notice-tags">${initialPhoneticExpansion.tokens.slice(0, 8).map(t => `<span class="phonetic-tag">${escapeHtml(t)}</span>`).join('')}</div></div>
        <span style="font-size:11px; opacity:0.8;">Ashkenazic &amp; Sephardic variations searched</span>
      ` : ''}
    </div>

    <!-- Speaker & Venue Bio / Description Banner -->
    <div class="bio-banner" id="bioBanner" style="display: none;">
      <div class="bio-header">
        <img id="bioAvatar" class="bio-avatar" src="" alt="Speaker" onerror="handleImgError(this)">
        <div class="bio-meta">
          <h3 id="bioTitle" class="bio-title"></h3>
          <div id="bioSubtitle" class="bio-subtitle"></div>
        </div>
      </div>
      <div id="bioText" class="bio-text collapsed"></div>
      <button type="button" id="bioToggleBtn" class="bio-toggle-btn" onclick="toggleBioCollapse()" style="display: none;">Read More ▼</button>
    </div>

    <div class="search-results-info">
      <span class="search-results-text" id="searchResultsLabel">
        ${initialSearchResults ? `Showing ${initialSearchResults.length}${initialNumFound > initialSearchResults.length ? ` of ${initialNumFound.toLocaleString()}` : ''} results for "${escapeHtml(searchQuery)}"` : 'Search Results'}
      </span>
      <div class="search-results-actions">
        <div class="search-toggles-wrap">
          <label class="match-explain-toggle" id="matchExplainToggleContainer" title="Highlight matched search terms &amp; preview snippets from descriptions, tags, and venues">
            <input type="checkbox" id="toggleMatchExplain" onchange="onToggleMatchExplain(this.checked)">
            <span class="match-toggle-track">
              <span class="match-toggle-thumb"></span>
            </span>
            <span class="match-toggle-label">🎯 Explain Matches</span>
          </label>
          <label class="match-explain-toggle" id="classicSearchToggleContainer" title="Toggle Classic vs Enhanced Search">
            <input type="checkbox" id="toggleClassicSearch" ${isClassicSearch ? 'checked' : ''} onchange="onToggleClassicSearch(this.checked)">
            <span class="match-toggle-track">
              <span class="match-toggle-thumb"></span>
            </span>
            <span class="match-toggle-label">
              <span>🏛️ Use Classic Search</span>
              <span class="classic-info-btn" onclick="toggleClassicInfoTooltip(event)" role="button" tabindex="0" data-kbplay aria-label="About Classic Search" title="Learn about Classic Search">ⓘ</span>
            </span>
          </label>
          <div id="classicSearchTooltip" class="classic-search-tooltip" style="display: none;" onclick="event.stopPropagation()">
            <div class="classic-search-tooltip-header">
              <span class="classic-search-tooltip-title">🔍 Search Modes Explained</span>
              <button type="button" class="classic-search-tooltip-close" onclick="hideClassicInfoTooltip(event)">×</button>
            </div>
            <div class="classic-search-tooltip-body">
              <p><strong>🏛️ Classic Search:</strong> Queries YUTorah directly for exact literal matches only, with no phonetic variations, spelling tolerance, or speaker entity recognition.</p>
              <p><strong>✨ Enhanced Search (Default):</strong> Automatically bridges Ashkenazic/Sephardic phonetic drift (<em>Shabbos ↔ Shabbat</em>, <em>Succah ↔ Sukkah</em>), converts English transliterations into Hebrew concepts (<em>שבת, סוכה, מוקצה</em>), isolates roshei yeshiva/speakers, and explains why results matched.</p>
            </div>
          </div>
          <label class="match-explain-toggle" id="stackSeriesToggleContainer" title="Stack shiurim belonging to the same series under an interactive cover card">
            <input type="checkbox" id="toggleStackSeries" checked onchange="onToggleStackSeries(this.checked)">
            <span class="match-toggle-track">
              <span class="match-toggle-thumb"></span>
            </span>
            <span class="match-toggle-label">📚 Stack Series</span>
          </label>
          <div class="view-toggle-wrap" role="group" aria-label="Cards or rows view">
            <button type="button" class="view-toggle-btn selected" data-view="cards" onclick="setCardView('cards')" title="Card grid view">🃏 Cards</button>
            <button type="button" class="view-toggle-btn" data-view="rows" onclick="setCardView('rows')" title="One-per-row list view like yutorah.org">📋 Rows</button>
          </div>
        </div>
        <button class="close-results-btn" onclick="clearSearch()">Clear Search ×</button>
      </div>
    </div>

    <div class="spinner-box" id="searchSpinner">
      <div class="spinner"></div>
      Searching YUTorah...
    </div>

    <div class="shiur-cards-grid" id="searchResultsGrid">
      ${initialGridHtml}
    </div>

    <div id="loadMoreContainer" style="text-align: center; margin-top: 26px; ${initialSearchResults && initialSearchResults.length < initialNumFound ? '' : 'display: none;'}">
      <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreResults()">
        <span id="loadMoreBtnText">🔽 Load More Results</span>
        <span id="loadMoreSpinner" class="spinner-small" style="display: none;"></span>
      </button>
      <div id="searchTotalInfo" style="font-size: 13px; color: var(--text-muted); margin-top: 10px; font-weight: 500;">
        ${initialSearchResults ? `Showing ${initialSearchResults.length} of ${initialNumFound.toLocaleString()} shiurim` : ''}
      </div>
    </div>
  </div>

  <!-- Audio Player Card (Active when playing) -->
  <div class="player-card" id="playerCard">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
      <a onclick="minimizePlayer()" class="player-nav-back" id="playerNavBackBtn" style="margin-bottom: 0; cursor: pointer;">${articlePdfUrl ? '← Browse Library While Reading' : '← Browse Library While Listening'}</a>
      <button type="button" class="mini-btn-pill" onclick="minimizePlayer()" title="Minimize to mini-player" style="background: #eef2f7; border: 1px solid #dbe2ed; color: var(--primary); font-size: 13px; font-weight: 700; padding: 5px 12px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;"><path d="M7 10l5 5 5-5z"/></svg> Minimize</button>
    </div>

    <!-- Main Shiur Header (Always preserved on top) -->
    <div class="shiur-header">
      <img id="speakerImg" class="speaker-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(speaker)}" onclick="handleSpeakerClick()" style="cursor: pointer;" title="View speaker page">
      <div class="shiur-details">
        <h1 id="shiurTitle" class="shiur-title">${escapeHtml(title)}</h1>
        <div id="shiurSpeaker" class="shiur-speaker" onclick="handleSpeakerClick()" title="View speaker page">${escapeHtml(speaker)}</div>
        <div id="shiurMeta" class="shiur-meta">${escapeHtml(meta)}</div>
        <div id="shiurUploadDate" class="shiur-upload-date" style="display: none;"></div>
      </div>
    </div>

    <!-- Audio Player Controls (Visible when listening to audio) -->
    <div id="audioControlsWrap" style="${articlePdfUrl ? 'display: none;' : ''}">
      <!-- Pre-roll Sponsor Overlayment Banner (under title, visible when sponsor audio is playing) -->
      <div id="sponsorPreRollBanner" class="sponsor-preroll-banner" style="display: none;">
        <div class="sponsor-preroll-header">
          <span class="sponsor-preroll-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg> TODAY'S SPONSOR DEDICATION</span>
          <span class="sponsor-preroll-status">🎙️ Audio Dedication Playing</span>
        </div>
        <div class="sponsor-preroll-body" id="sponsorPreRollText">${sponsorshipText || ''}</div>
        <div class="sponsor-preroll-footer">
          <div class="sponsor-preroll-countdown">🎙️ Shiur begins in <span id="sponsorCountdown">10</span>s...</div>
          <span style="font-size:11.5px; opacity:0.85;">Plays automatically before shiur</span>
        </div>
      </div>

      <!-- Scrubber -->
      <div class="scrubber-container">
        <div class="scrubber-bar" id="scrubberBar" role="slider" tabindex="0" aria-label="Seek time" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="scrubber-fill" id="scrubberFill">
            <div class="scrubber-handle"></div>
          </div>
        </div>
        <div class="time-display">
          <span id="curTime">0:00</span>
          <span id="totalTime">${escapeHtml(duration || '0:00')}</span>
        </div>
      </div>

      <!-- Transport Buttons -->
      <div class="transport-row">
        <button class="ctrl-btn skip" onclick="skip(-30)" title="Back 30s (Shift+←)">-30</button>
        <button class="ctrl-btn skip" onclick="skip(-10)" title="Back 10s (←)">-10</button>
        <button class="ctrl-btn play" id="playBtn" onclick="togglePlay()" title="Play / Pause (Space)"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin-left:3px;"><path d="M8 5v14l11-7z"/></svg></button>
        <button class="ctrl-btn skip" onclick="skip(10)" title="Forward 10s (→)">+10</button>
        <button class="ctrl-btn skip" onclick="skip(30)" title="Forward 30s (Shift+→)">+30</button>
      </div>

      <!-- Audio Engine (Headless element for high performance playback) -->
      <audio id="audioElement" src="${escapeHtml(audioUrl)}" preload="auto" style="display:none;"></audio>

      <!-- Secondary Controls -->
      <div class="controls-grid">
        <div class="ctrl-group">
          <span class="ctrl-label">Speed</span>
          <select id="speedSelect" class="speed-select" onchange="setSpeed(this.value)">
            ${speedOptionsHtml}
          </select>
        </div>

        <div class="ctrl-group">
          <button class="action-btn" id="copyLinkBtn" onclick="copyShareLink()">
            📋 Copy Link @ Time
          </button>
          <a class="action-btn" id="dlBtn" href="${escapeHtml(downloadUrl || audioUrl)}" target="_blank" ${downloadUrl || audioUrl ? '' : 'style="display:none;"'}>
            ⬇️ Download MP3
          </a>
        </div>
      </div>

      <div class="shortcuts-hint">
        Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> ±10s · <kbd>Shift+←/→</kbd> ±30s · <kbd>[</kbd>/<kbd>]</kbd> speed
      </div>
    </div>

    <!-- Article & Document Viewer (Active when viewing articles/PDFs) -->
    <div id="articleViewerContainer" class="article-viewer-wrap" style="${articlePdfUrl ? '' : 'display: none;'}">
      <div class="article-toolbar">
        <div class="article-toolbar-left">
          <div class="article-mode-pill">
            <button type="button" class="article-mode-btn active" id="modeBtnLiquid" onclick="setArticleMode('liquid')">💧 Liquid Mode</button>
            <button type="button" class="article-mode-btn" id="modeBtnOriginal" onclick="setArticleMode('original')">📄 Original Page</button>
          </div>
          <div class="font-size-controls" id="fontSizeControls">
            <button type="button" class="font-size-btn" onclick="adjustArticleFontSize(-1)" title="Decrease text size">A-</button>
            <button type="button" class="font-size-btn" onclick="adjustArticleFontSize(1)" title="Increase text size">A+</button>
          </div>
        </div>
        <div class="article-toolbar-center" id="articlePageNav" style="display: none;">
          <div class="page-mode-pill" id="pageModePill">
            <button type="button" class="page-mode-btn active" id="btnModeContinuous" onclick="setPageScrollMode('continuous')">📜 Scroll All</button>
            <button type="button" class="page-mode-btn" id="btnModeSingle" onclick="setPageScrollMode('single')">📄 Page by Page</button>
          </div>
          <div id="singlePageNavButtons" style="display: none; align-items: center; gap: 6px;">
            <button type="button" class="article-btn" id="prevPageBtn" onclick="changeArticlePage(-1)" aria-label="Previous page">‹ Prev</button>
            <span class="article-page-info" id="articlePageNum" aria-live="polite">Page 1 of 1</span>
            <button type="button" class="article-btn" id="nextPageBtn" onclick="changeArticlePage(1)" aria-label="Next page">Next ›</button>
          </div>
          <span class="article-page-info" id="continuousPageNum" aria-live="polite" style="display: inline-block;">Page 1 of 1</span>
        </div>
        <div class="article-toolbar-right">
          <button type="button" class="article-btn" id="zoomOutBtn" onclick="adjustArticleZoom(-0.2)" title="Zoom out" aria-label="Zoom out" style="display: none;">🔍 -</button>
          <button type="button" class="article-btn" id="zoomInBtn" onclick="adjustArticleZoom(0.2)" title="Zoom in" aria-label="Zoom in" style="display: none;">🔍 +</button>
          <a class="article-btn" id="dlPdfBtn" href="${escapeHtml(downloadUrl || articlePdfUrl)}" target="_blank" download title="Download PDF document" aria-label="Download PDF">⬇️ PDF</a>
          <button type="button" class="article-btn" onclick="toggleArticleFullscreen()" title="Toggle Fullscreen" aria-label="Toggle Fullscreen">⛶</button>
        </div>
      </div>

      <!-- Liquid Mode Viewport (Reflowed clean typography) -->
      <div id="articleLiquidViewport" class="article-liquid-viewport">
        <div class="liquid-content" id="liquidContent">
          <div class="article-loading-state">
            <div class="spinner"></div>
            <span>Formatting article text for reading...</span>
          </div>
        </div>
      </div>

      <!-- Original Page Viewport (Interactive Touch Zoom & Pan Tracking) -->
      <div id="articleCanvasViewport" class="article-canvas-viewport" style="display: none;" title="Pinch or double-tap to zoom anywhere">
        <div id="originalPageOrientationTip" class="original-page-orientation-tip">
          <span>🔄 <strong>Tip:</strong> Original Page view is best experienced in landscape / horizontal orientation.</span>
        </div>
        <div class="pdf-canvas-card" id="pdfCanvasCard">
          <canvas id="pdfCanvas"></canvas>
        </div>
        <div id="continuousPagesContainer" style="display: none; width: 100%; flex-direction: column; align-items: center; gap: 20px;"></div>
      </div>
    </div>

    <div class="shiur-desc" id="shiurDesc">${escapeHtml(description)}</div>

    <!-- Metadata Chips -->
    <div class="shiur-metadata-box" id="shiurMetadataBox" style="${(shiurTeachers.length || shiurLocations.length || Object.keys(shiurCategories).length || shiurKeywords.length) ? '' : 'display:none;'}">
      ${shiurTeachers.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">👤 Speaker</span>
        ${shiurTeachers.map(t => `<button class="meta-chip speaker-chip" onclick='filterByTeacher(${JSON.stringify(t.id)}, ${JSON.stringify(t.name).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(t.name)}</button>`).join('')}
      </div>` : ''}
      ${shiurDate ? `
      <div class="meta-row">
        <span class="meta-label">📅 Date</span>
        <span style="font-size:13px; color:var(--text);">${escapeHtml(shiurDate)}</span>
      </div>` : ''}
      ${shiurLocations.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">📍 Venue</span>
        ${shiurLocations.map(loc => `<button class="meta-chip venue-chip" onclick='filterByLocation(${JSON.stringify(loc.id)}, ${JSON.stringify(loc.name).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(loc.name)}</button>`).join('')}
      </div>` : ''}
      ${Object.keys(shiurCategories).length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">📂 Topics</span>
        ${Object.entries(shiurCategories).map(([groupName, cats]) =>
          `<span class="meta-group-name">${escapeHtml(groupName)}:</span>` +
          cats.map(c => `<button class="meta-chip category-chip" onclick='filterByCategory(${JSON.stringify(c.id)}, ${JSON.stringify(c.name).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(c.name)}</button>`).join('')
        ).join(' ')}
      </div>` : ''}
      ${shiurKeywords.length > 0 ? `
      <div class="meta-row">
        <span class="meta-label">🏷️ Tags</span>
        ${shiurKeywords.map(k => `<button class="meta-chip keyword-chip" onclick='searchFor(${JSON.stringify(k.title).replace(/'/g, '&#39;').replace(/</g, '&#60;')})'>${escapeHtml(k.title)}</button>`).join('')}
      </div>` : ''}
    </div>
  </div>

  ${moreFromSpeakers.length > 0 ? `
  <!-- More from this Speaker -->
  <div id="moreFromSpeakerSection" style="margin-bottom: 30px;">
    <h2 class="section-title">🎙️ More from ${escapeHtml(speaker)}</h2>
    <div class="shiur-cards-grid">
      ${moreFromSpeakers.map(renderShiurCardHtml).join('')}
    </div>
  </div>
  ` : ''}

  ${moreFromCategories.length > 0 ? `
  <!-- More in this Category -->
  <div id="moreFromCategorySection" style="margin-bottom: 30px;">
    <h2 class="section-title">📚 More in this Category</h2>
    <div class="shiur-cards-grid">
      ${moreFromCategories.map(renderShiurCardHtml).join('')}
    </div>
  </div>
  ` : ''}

  <!-- Collections Section (Original 7 Tabs from YUTorah) -->
  <div class="collections-section" id="collectionsSection" style="${initialSearchResults ? 'display: none;' : ''}">
    ${heroSlides.length > 0 ? `
    <div class="hero-slideshow" id="heroSlideshow" role="region" aria-roledescription="carousel" aria-label="Featured shiurim">
      <div class="hero-slides">
        ${heroSlides.map((s, i) => {
          const inner = `
          <img src="${escapeHtml(s.imageURL)}" alt="${escapeHtml(s.name)}" loading="${i === 0 ? 'eager' : 'lazy'}">
          <div class="hero-caption">
            <div class="hero-title">${escapeHtml(s.name)}</div>
            ${s.description ? `<div class="hero-desc">${escapeHtml(s.description)}</div>` : ''}
            <span class="hero-cta">${escapeHtml(s.urlTitle)} →</span>
          </div>`;
          return s.href === '#'
            ? `<div class="hero-slide${i === 0 ? ' active' : ''}" data-slide-name="${escapeHtml(s.name)}" data-slide-href="${escapeHtml(s.href)}" onclick="handleHeroSlideClick(event, this)" role="button" tabindex="${i === 0 ? '0' : '-1'}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();handleHeroSlideClick(event,this);}"${i === 0 ? '' : ' inert'}>${inner}</div>`
            : `<a class="hero-slide${i === 0 ? ' active' : ''}" href="${escapeHtml(s.href)}" data-slide-name="${escapeHtml(s.name)}" data-slide-href="${escapeHtml(s.href)}" onclick="handleHeroSlideClick(event, this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();handleHeroSlideClick(event,this);}"${s.external ? ' target="_blank" rel="noopener noreferrer"' : ''} aria-hidden="${i === 0 ? 'false' : 'true'}"${i === 0 ? '' : ' tabindex="-1" inert'}>${inner}</a>`;
        }).join('')}
      </div>
      <button type="button" class="hero-arrow hero-prev" onclick="heroGo(-1)" aria-label="Previous">‹</button>
      <button type="button" class="hero-arrow hero-next" onclick="heroGo(1)" aria-label="Next">›</button>
      <div class="hero-dots" role="group" aria-label="Slideshow navigation">
        ${heroSlides.map((s, i) => `<button type="button" class="hero-dot${i === 0 ? ' active' : ''}" onclick="heroGoTo(${i})" aria-label="Slide ${i + 1}: ${escapeHtml(s.name)}"></button>`).join('')}
      </div>
    </div>` : ''}
    <div class="section-header">
      <h2 class="section-title" id="activeCollectionTitle">⭐ Editor's Picks</h2>
      <div class="view-toggle-wrap" role="group" aria-label="Cards or rows view">
        <button type="button" class="view-toggle-btn selected" data-view="cards" onclick="setCardView('cards')" title="Card grid view">🃏 Cards</button>
        <button type="button" class="view-toggle-btn" data-view="rows" onclick="setCardView('rows')" title="One-per-row list view like yutorah.org">📋 Rows</button>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" id="tab-editors" onclick="switchCollection('editors')">⭐ Editor's Picks</button>
        <button class="tab-btn dev-playlist-tab" id="tab-playlists" onclick="switchCollection('playlists')">🎧 My Playlists</button>
        <button class="tab-btn dev-curated-tab" id="tab-dev-playlists" onclick="switchCollection('dev-playlists')" style="display: none;" aria-hidden="true">🛠️ Dev Playlists</button>
        <button class="tab-btn" id="tab-series" onclick="switchCollection('series')">📚 Featured Series</button>
        <button class="tab-btn" id="tab-recent" onclick="switchCollection('recent')">⏱️ Recently Uploaded</button>
        <button class="tab-btn" id="tab-popular" onclick="switchCollection('popular')">🔥 Most Popular</button>
        <button class="tab-btn" id="tab-viewed" onclick="switchCollection('viewed')">👁️ Recently Viewed</button>
        <button class="tab-btn" id="tab-parsha" onclick="switchCollection('parsha')">📖 Parsha Shiurim</button>
        <button class="tab-btn" id="tab-daily" onclick="switchCollection('daily')">📜 Daily Shiur</button>
        <button class="tab-btn" id="tab-trending" onclick="switchCollection('trending')">🔥 Trending Keywords</button>
      </div>
    </div>

    <!-- Collection Grids -->
    <div class="shiur-cards-grid" id="grid-editors">
      ${editorsPicks.map(renderShiurCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-playlists" style="display: none;" aria-hidden="true">
      <!-- Populated client-side by the Dev Playlists engine (ROADMAP §8) -->
    </div>

    <div class="shiur-cards-grid" id="grid-dev-playlists" style="display: none;" aria-hidden="true">
      <!-- Populated client-side with the 30 Curated Playlists across Dev Personas -->
    </div>

    <div class="series-grid" id="grid-series" style="display: none;">
      ${featuredSeries.map(renderSeriesCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-recent" style="display: none;">
      ${recentlyUploaded.map(renderShiurCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-popular" style="display: none;">
      ${popularShiurim.map(renderShiurCardHtml).join('')}
    </div>

    <div class="shiur-cards-grid" id="grid-viewed" style="display: none;">
      <!-- Populated client-side from local listening history -->
    </div>

    <div class="shiur-cards-grid" id="grid-parsha" style="display: none;">
      <!-- Populated dynamically with current week's Parsha shiurim -->
    </div>

    <div class="shiur-cards-grid" id="grid-daily" style="display: none;">
      ${dailyShiurim.map(renderShiurCardHtml).join('')}
    </div>

    <div class="trending-container" id="grid-trending" style="display: none;">
      <div class="trending-group-title">🗓️ Holiday & Season Topics</div>
      <div class="trending-chips-wrap">
        <button class="trending-chip-btn" onclick="searchFor('Elul')">🌿 Elul</button>
        <button class="trending-chip-btn" onclick="searchFor('Teshuva')">🔄 Teshuva</button>
        <button class="trending-chip-btn" onclick="searchFor('Rosh Hashanah')">🍎 Rosh Hashanah</button>
        <button class="trending-chip-btn" onclick="searchFor('Yom Kippur')">🤍 Yom Kippur</button>
        <button class="trending-chip-btn" onclick="searchFor('Selichot')">🕯️ Selichot</button>
        <button class="trending-chip-btn" onclick="searchFor('Shofar')">📯 Shofar</button>
        <button class="trending-chip-btn" onclick="searchFor('Sukkot')">🌿 Sukkot</button>
        <button class="trending-chip-btn" onclick="searchFor('Simchat Torah')">📜 Simchat Torah</button>
      </div>

      <div class="trending-group-title">🎙️ Featured Roshei Yeshiva & Speakers</div>
      <div class="trending-chips-wrap">
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Hershel Schachter')">👤 Rabbi Hershel Schachter</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Michael Rosensweig')">👤 Rabbi Michael Rosensweig</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Mayer Twersky')">👤 Rabbi Mayer Twersky</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Aryeh Lebowitz')">👤 Rabbi Aryeh Lebowitz</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Yaakov Neuburger')">👤 Rabbi Yaakov Neuburger</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Moshe Taragin')">👤 Rabbi Moshe Taragin</button>
        <button class="trending-chip-btn" onclick="searchFor('Rabbi Joseph B. Soloveitchik')">👤 Rav Soloveitchik zt&quot;l</button>
        <button class="trending-chip-btn" onclick="searchFor('Mrs. Emma Katz')">👤 Mrs. Emma Katz</button>
      </div>

      <div class="trending-group-title">📖 Core Texts & Daily Learning</div>
      <div class="trending-chips-wrap">
        <button class="trending-chip-btn" onclick="searchFor('Daf Yomi')">📜 Daf Yomi</button>
        <button class="trending-chip-btn" onclick="searchFor('Mishna Yomi')">📗 Mishna Yomi</button>
        <button class="trending-chip-btn" onclick="searchFor('Nach Yomi')">📘 Nach Yomi</button>
        <button class="trending-chip-btn" onclick="searchFor('Halacha')">⚖️ Halacha</button>
        <button class="trending-chip-btn" onclick="searchFor('Machshava')">🧠 Machshava</button>
        <button class="trending-chip-btn" onclick="searchFor('Tefillah')">🙏 Tefillah</button>
        <button class="trending-chip-btn" onclick="searchFor('Rambam')">📚 Rambam</button>
        <button class="trending-chip-btn" onclick="searchFor('Mussar')">✨ Mussar</button>
      </div>
    </div>
  </div>

</main>

<!-- Floating Mini-Player (Persistent Bottom Bar across entire site) -->
<div id="miniPlayer" onclick="handleMiniPlayerClick(event)">
  <div class="mini-progress-track" id="miniProgressTrack" onclick="seekMiniProgress(event)">
    <div class="mini-progress-fill" id="miniProgressFill">
      <div class="mini-progress-circle"></div>
    </div>
  </div>
  <div class="mini-content">
    <img id="miniThumb" class="mini-thumb" src="${escapeHtml(photo)}" alt="Speaker" onerror="handleImgError(this)">
    <div class="mini-info" onclick="expandPlayer()">
      <div class="mini-title" id="miniTitle">${escapeHtml(title)}</div>
      <div class="mini-speaker" id="miniSpeaker">${escapeHtml(speaker)}</div>
    </div>
    <span class="mini-time" id="miniTime">0:00 / ${escapeHtml(duration || '0:00')}</span>
    <div class="mini-controls">
      <button type="button" class="mini-btn skip-btn" onclick="skip(-10); event.stopPropagation();" title="Back 10s">
        <svg width="44" height="28" viewBox="0 0 44 28" style="display:block;">
          <polygon points="2,14 42,1 42,27" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linejoin="round"/>
          <text x="26" y="18" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="800" text-anchor="middle">-10</text>
        </svg>
      </button>
      <button type="button" class="mini-play-btn" id="miniPlayBtn" onclick="togglePlay(); event.stopPropagation();" title="Play/Pause"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M8 5v14l11-7z"/></svg></button>
      <button type="button" class="mini-btn skip-btn" onclick="skip(10); event.stopPropagation();" title="Forward 10s">
        <svg width="44" height="28" viewBox="0 0 44 28" style="display:block;">
          <polygon points="42,14 2,1 2,27" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linejoin="round"/>
          <text x="18" y="18" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="800" text-anchor="middle">+10</text>
        </svg>
      </button>
      <button type="button" class="mini-btn expand-btn" onclick="expandPlayer(); event.stopPropagation();" title="Expand Full Player">⤢</button>
      <button type="button" class="mini-btn queue-btn acct-only" onclick="toggleQueuePopup(); event.stopPropagation();" title="Play Queue (Dev)">☰</button>
      <button type="button" class="mini-btn close-btn" onclick="closeMiniPlayer(); event.stopPropagation();" title="Stop & Close">✕</button>
    </div>
  </div>
</div>

<div id="queuePopup" class="queue-popup acct-only" style="display: none;" role="dialog" aria-label="Play Queue">
  <div class="queue-popup-header">
    <span>📋 Up Next</span>
    <span id="queueCount" class="queue-count"></span>
    <button type="button" class="card-mini-btn" onclick="closeQueuePopup(); event.stopPropagation();" aria-label="Close queue">✕</button>
  </div>
  <div id="queueList" class="queue-list"></div>
  <div class="queue-popup-footer">
    <button type="button" class="card-mini-btn" onclick="devPlayNextFromQueue()">▶ Play Next Now</button>
    <button type="button" class="card-mini-btn" onclick="devQueueClear()">Clear Queue</button>
  </div>
</div>

<!-- Advanced Search & Multi-Criteria Filtering Modal (#4) -->
<div id="advancedSearchModal" class="advanced-modal-backdrop" onclick="handleAdvancedBackdropClick(event)" role="dialog" aria-modal="true" aria-label="Advanced Search & Filters">
  <div class="advanced-modal-card" onclick="event.stopPropagation()">
    <div class="modal-header">
      <div class="modal-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; color:var(--primary);"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg> Advanced Search & Filters
      </div>
      <button type="button" class="modal-close-btn" onclick="closeAdvancedModal()" aria-label="Close modal">✕</button>
    </div>
    <div class="modal-body">
      <!-- Transliteration Engine: single row (info + name + on/off switch) -->
      <div class="transliteration-status-card">
        <button type="button" class="translit-info-btn" onclick="document.getElementById('translitDesc').style.display=document.getElementById('translitDesc').style.display==='none'?'block':'none'" title="About transliteration" aria-label="About transliteration">i</button>
        <div style="flex:1; min-width:0;">
          <div class="translit-badge-title">
            <span>✨ Reverse Transliteration</span>
          </div>
          <div class="translit-badge-desc" id="translitDesc" style="display:none;">
            Automatically equates Ashkenazic &amp; Sephardic phonetics (<em>Shabbos ↔ Shabbat</em>, <em>Succah ↔ Sukkah</em>), expands English to Hebrew (<em>שבת, סוכה, פסח, מוצאי</em>), and auto-detects speakers. <strong>Turning this off uses the classic old YUTorah website search</strong> (strict literal match only).
          </div>
        </div>
        <label class="translit-switch" title="Toggle enhanced search">
          <input type="checkbox" id="advPhoneticsToggle" checked onchange="const l=document.getElementById('advPhoneticsToggleLabel'); if(l){ l.textContent=this.checked?'On':'Off'; }">
          <span id="advPhoneticsToggleLabel">On</span>
        </label>
      </div>

      <!-- Keyword / Topic -->
      <div class="filter-group">
        <label class="filter-label" for="advKeywords">
          <span>Topic, Title, or Keyword</span>
          <span class="filter-label-hint">Phonetic &amp; Hebrew equivalence auto-applied</span>
        </label>
        <input type="text" id="advKeywords" class="filter-input" placeholder="e.g. Shabbos, Muktzah, Teshuva, Shofar...">
      </div>

      <!-- Speaker / Teacher Multi-Select Autocomplete -->
      <div class="filter-group">
        <label class="filter-label" for="advTeacherInput">
          <span>Speaker / Teacher</span>
          <span class="filter-label-hint">Type name to filter 3,200+ teachers · Multi-select</span>
        </label>
        <div class="autocomplete-combobox" id="teacherCombobox">
          <div class="chips-container" id="teacherChipsContainer" onclick="document.getElementById('advTeacherInput').focus()">
            <input type="text" id="advTeacherInput" class="combobox-input" placeholder="Type teacher name (e.g. Schachter, Rosensweig)..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="teacherDropdown"></div>
        </div>
      </div>

      <!-- Category / Topic Multi-Select Autocomplete -->
      <div class="filter-group">
        <label class="filter-label" for="advCategoryInput">
          <span>Category / Topic</span>
          <span class="filter-label-hint">Type topic (e.g. Shabbat, Muktzah, Pesachim) · Multi-select</span>
        </label>
        <div class="autocomplete-combobox" id="categoryCombobox">
          <div class="chips-container" id="categoryChipsContainer" onclick="document.getElementById('advCategoryInput').focus()">
            <input type="text" id="advCategoryInput" class="combobox-input" placeholder="Type category or topic..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="categoryDropdown"></div>
        </div>
      </div>

      <!-- Venue / Location Multi-Select Autocomplete -->
      <div class="filter-group">
        <label class="filter-label" for="advLocationInput">
          <span>Venue / Recording Location</span>
          <span class="filter-label-hint">Type location (e.g. Wilf Campus, Har Etzion, BMT) · Multi-select</span>
        </label>
        <div class="autocomplete-combobox" id="locationCombobox">
          <div class="chips-container" id="locationChipsContainer" onclick="document.getElementById('advLocationInput').focus()">
            <input type="text" id="advLocationInput" class="combobox-input" placeholder="Type venue or recording location..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="locationDropdown"></div>
        </div>
      </div>

      <!-- Series Multi-Select Autocomplete (from Hamburger Menu Series) -->
      <div class="filter-group">
        <label class="filter-label" for="advSeriesInput">
          <span>Lecture Series</span>
          <span class="filter-label-hint">Filter Daf Yomi, Daily Shiur, BCBM, etc.</span>
        </label>
        <div class="autocomplete-combobox" id="seriesCombobox">
          <div class="chips-container" id="seriesChipsContainer" onclick="document.getElementById('advSeriesInput').focus()">
            <input type="text" id="advSeriesInput" class="combobox-input" placeholder="Type series name (e.g. Daf Yomi, Daily Shiur)..." autocomplete="off">
          </div>
          <div class="autocomplete-dropdown" id="seriesDropdown"></div>
        </div>
      </div>

      <!-- Media Format Filter: Both / Audio Only / Articles Only -->
      <div class="filter-group">
        <label class="filter-label">
          <span>Media Format</span>
          <span class="filter-label-hint" id="mediaTypeHint">Audio &amp; Articles</span>
        </label>
        <div class="media-presets-row" id="mediaTypePresetsRow">
          <button type="button" class="media-preset-btn selected" id="btnMediaAll" data-media="all" onclick="setMediaTypePreset(this, 'all')">🎧 &amp; 📄 Both</button>
          <button type="button" class="media-preset-btn" id="btnMediaAudio" data-media="audio" onclick="setMediaTypePreset(this, 'audio')">🎙️ Audio Only</button>
          <button type="button" class="media-preset-btn" id="btnMediaArticle" data-media="article" onclick="setMediaTypePreset(this, 'article')">📄 Articles Only</button>
        </div>
      </div>

      <!-- Duration Presets & Range -->
      <div class="filter-group">
        <label class="filter-label">
          <span>Shiur Duration</span>
          <span class="filter-label-hint" id="durationHint">Any Length</span>
        </label>
        <div class="duration-presets-row">
          <button type="button" class="duration-preset-btn selected" data-min="" data-max="" onclick="setDurationPreset(this, '', '')">Any Length</button>
          <button type="button" class="duration-preset-btn" data-min="1" data-max="15" onclick="setDurationPreset(this, 1, 15)">⚡ Short (&lt;15m)</button>
          <button type="button" class="duration-preset-btn" data-min="15" data-max="45" onclick="setDurationPreset(this, 15, 45)">🎙️ Mid (15–45m)</button>
          <button type="button" class="duration-preset-btn" data-min="45" data-max="" onclick="setDurationPreset(this, 45, '')">📚 Deep (&gt;45m)</button>
        </div>
      </div>

      <!-- Year / Era (Complete from 2026 down to Pre-2000) -->
      <div class="filter-group">
        <label class="filter-label" for="advYearSelect">
          <span>Recording Year / Archive Era</span>
          <span class="filter-label-hint">Individual years 2026 down to 2000 &amp; archive</span>
        </label>
        <select id="advYearSelect" class="filter-select">
          <option value="">-- All Recording Years --</option>
          <optgroup label="Recent Years (2020–2026)">
            <option value="2026">2026 (5786)</option>
            <option value="2025">2025 (5785)</option>
            <option value="2024">2024 (5784)</option>
            <option value="2023">2023 (5783)</option>
            <option value="2022">2022 (5782)</option>
            <option value="2021">2021 (5781)</option>
            <option value="2020">2020 (5780)</option>
          </optgroup>
          <optgroup label="2010s Decade (2010–2019)">
            <option value="2010-2019">Entire 2010–2019 Decade</option>
            <option value="2019">2019 (5779–5780)</option>
            <option value="2018">2018 (5778–5779)</option>
            <option value="2017">2017 (5777–5778)</option>
            <option value="2016">2016 (5776–5777)</option>
            <option value="2015">2015 (5775–5776)</option>
            <option value="2014">2014 (5774–5775)</option>
            <option value="2013">2013 (5773–5774)</option>
            <option value="2012">2012 (5772–5773)</option>
            <option value="2011">2011 (5771–5772)</option>
            <option value="2010">2010 (5770–5771)</option>
          </optgroup>
          <optgroup label="2000s Decade (2000–2009)">
            <option value="2009">2009</option>
            <option value="2008">2008</option>
            <option value="2007">2007</option>
            <option value="2006">2006</option>
            <option value="2005">2005</option>
            <option value="2004">2004</option>
            <option value="2003">2003</option>
            <option value="2002">2002</option>
            <option value="2001">2001</option>
            <option value="2000">2000</option>
          </optgroup>
          <optgroup label="Historical Archives">
            <option value="pre-2010">Pre-2010 Archive</option>
            <option value="pre-2000">Pre-2000 Vintage Archive</option>
          </optgroup>
        </select>
      </div>

      <!-- Custom Date & Time Range (overrides Year / Quick presets) -->
      <div class="filter-group">
        <label class="filter-label">
          <span>Custom Date &amp; Time Range</span>
          <span class="filter-label-hint" id="dateRangeHint">From date-time to date-time</span>
        </label>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          <input type="datetime-local" id="advFromDateTime" class="filter-select" style="flex: 1; min-width: 180px;" aria-label="From date and time">
          <span style="color: var(--text-muted); font-weight: 700;">→</span>
          <input type="datetime-local" id="advToDateTime" class="filter-select" style="flex: 1; min-width: 180px;" aria-label="To date and time">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="modal-reset-btn" onclick="resetAdvancedFilters()">Reset All Filters</button>
      <div class="modal-action-btns">
        <button type="button" class="modal-cancel-btn" onclick="closeAdvancedModal()">Cancel</button>
        <button type="button" class="modal-submit-btn" onclick="applyAdvancedFilters()">Apply Filters 🔍</button>
      </div>
    </div>
  </div>
</div>

<footer>
  <p>YUTorah Enhanced Player · Standalone zero-friction audio player for <a href="https://www.yutorah.org" target="_blank" rel="noopener noreferrer">YUTorah.org</a> · <a href="https://www.givecampus.com/campaigns/50770/donations/new" target="_blank" rel="noopener noreferrer" style="font-weight: 600;">❤️ Support YUTorah</a></p>
</footer>

<script>
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  let autocompleteCache = null;
  let autocompleteData = null;

  function getNowInNewYork() {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
      });
      const parts = formatter.formatToParts(new Date());
      const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026', 10);
      const month = parseInt(parts.find(p => p.type === 'month')?.value || '9', 10) - 1;
      const day = parseInt(parts.find(p => p.type === 'day')?.value || '6', 10);
      return new Date(year, month, day);
    } catch (e) {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
  }

  function parseLocalDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    const ymd = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (ymd) {
      return new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
    }
    const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (mdy) {
      return new Date(parseInt(mdy[3], 10), parseInt(mdy[1], 10) - 1, parseInt(mdy[2], 10));
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    return null;
  }

  function formatShiurDate(rawDateStr) {
    if (!rawDateStr) return '';
    const trimmed = String(rawDateStr).trim();
    if (trimmed === 'Today' || trimmed === 'Yesterday') return trimmed;

    const d = parseLocalDate(trimmed);
    if (!d || isNaN(d.getTime())) return trimmed;

    const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const nyMidnight = getNowInNewYork().getTime();
    const diffDays = Math.round((nyMidnight - dMidnight) / 86400000);

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return monthNames[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function isShiurNew(rawDateStr) {
    if (!rawDateStr) return false;
    const trimmed = String(rawDateStr).trim();
    if (trimmed === 'Today' || trimmed === 'Yesterday') return true;
    const d = parseLocalDate(trimmed);
    if (!d || isNaN(d.getTime())) return false;
    const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const nyMidnight = getNowInNewYork().getTime();
    const diffDays = Math.round((nyMidnight - dMidnight) / 86400000);
    return diffDays <= 1 && diffDays >= -1;
  }

  function toggleTimelyCollapse() {
    const menu = document.getElementById('timelyDropdownMenu');
    const trigger = document.getElementById('timelyTriggerBtn');
    const ind = document.getElementById('timelyIndicator');
    if (!menu) return;
    const isExpanded = menu.style.display !== 'none';
    if (isExpanded) {
      menu.style.display = 'none';
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (ind) ind.textContent = 'Explore ▾';
    } else {
      menu.style.display = 'block';
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
      if (ind) ind.textContent = 'Close ▴';
    }
  }

  function closeTimelyDropdown() {
    const menu = document.getElementById('timelyDropdownMenu');
    const trigger = document.getElementById('timelyTriggerBtn');
    const ind = document.getElementById('timelyIndicator');
    if (menu) menu.style.display = 'none';
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (ind) ind.textContent = 'Explore ▾';
  }

  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.timely-collapsible-wrap');
    if (wrap && !wrap.contains(e.target)) {
      closeTimelyDropdown();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTimelyDropdown();
    }
  });

  // Smooth 60fps Preroll Progress Animation
  let sponsorRafId = null;

  function updateSponsorSmoothProgress() {
    if (!isSponsorPlaying || audio.paused || !audio.duration || isNaN(audio.duration)) {
      sponsorRafId = null;
      return;
    }
    const curTime = audio.currentTime;
    const dur = audio.duration;
    const pct = Math.min(100, Math.max(0, (curTime / dur) * 100));

    const scrubberFill = document.getElementById('scrubberFill');
    if (scrubberFill) {
      scrubberFill.style.width = pct + '%';
    }
    const miniFill = document.getElementById('miniProgressFill');
    if (miniFill) {
      miniFill.style.width = pct + '%';
    }

    sponsorRafId = requestAnimationFrame(updateSponsorSmoothProgress);
  }

  function startSponsorRaf() {
    if (sponsorRafId) cancelAnimationFrame(sponsorRafId);
    sponsorRafId = requestAnimationFrame(updateSponsorSmoothProgress);
  }

  function stopSponsorRaf() {
    if (sponsorRafId) {
      cancelAnimationFrame(sponsorRafId);
      sponsorRafId = null;
    }
  }

  const audio = document.getElementById('audioElement');
  let initialTimestamp = ${jsEmbed(timestamp)};
  let initialPlaybackSpeed = ${jsEmbed(playbackSpeed || '')};
  let hasAudio = ${jsEmbed(Boolean(audioUrl))};
  let currentShiurId = ${jsEmbed(shiurId || '')};
  const INITIAL_ARTICLE_PDF = ${jsEmbed(articlePdfUrl || '')};
  let currentArticlePdf = INITIAL_ARTICLE_PDF;
  let isCurrentShiurArticle = Boolean(INITIAL_ARTICLE_PDF);
  let initialTimeApplied = false;
  let lastUrlUpdateSec = -1;
  let lastUrlUpdateTime = 0;
  let isManuallyMinimized = false;
  let isExpandingUntil = 0;
  let currentSpeakerTeacherId = ${jsEmbed(currentTeacherId || '')};
  let currentSpeakerName = ${jsEmbed(speaker || '')};

  function handleSpeakerClick() {
    if (currentSpeakerTeacherId) {
      filterByTeacher(currentSpeakerTeacherId, currentSpeakerName);
    } else if (currentSpeakerName) {
      searchFor(currentSpeakerName);
    }
  }

  const DAILY_SPONSOR_AUDIO = ${jsEmbed(sponsorshipAudioUrl || '')};
  const DAILY_SPONSOR_TEXT = ${jsEmbed(sponsorshipText || '')};
  const DAILY_SPONSOR_PLAIN = ${jsEmbed(sponsorshipPlainText || '')};

  let currentSponsorAudio = DAILY_SPONSOR_AUDIO;
  let currentSponsorText = DAILY_SPONSOR_TEXT;
  let lastSponsorCheck = Date.now();

  async function refreshDailySponsorship() {
    try {
      const res = await fetch('/api/sponsorship');
      if (res.ok) {
        const data = await res.json();
        if (data.text) {
          currentSponsorText = data.text;
          const bannerText = document.querySelector('.sponsorship-text');
          if (bannerText) bannerText.innerHTML = data.text;
          const preRollText = document.getElementById('sponsorPreRollText');
          if (preRollText) preRollText.innerHTML = data.text;
        }
        if (data.audioUrl) {
          currentSponsorAudio = data.audioUrl;
        }
        lastSponsorCheck = Date.now();
      }
    } catch (e) {
      console.warn('Failed to refresh live sponsorship:', e);
    }
  }

  // Automatically refresh daily sponsorship when tab becomes visible or every 15 minutes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (Date.now() - lastSponsorCheck > 300000)) {
      refreshDailySponsorship();
    }
  });
  setInterval(refreshDailySponsorship, 900000);

  function isPreRollDisabled() {
    try {
      return localStorage.getItem('yutorah_preroll_disabled') === '1';
    } catch(e) {
      return false;
    }
  }

  // Developer Mode: the ONLY way in is typing "dev mode" (case-insensitive)
  // in the search box. There is no tap gesture for dev mode.
  let isDevMode = false;
  // Elements revealed by activateDevMode (re-hidden by deactivateDevMode).
  var devRevealedSettings = [];

  function activateDevMode() {
    if (isDevMode) return false;
    isDevMode = true;
    try { localStorage.setItem('yutorah_dev_mode', 'true'); } catch (e) {}
    document.body.classList.add('dev-mode-active');

    // Gear retired: dev settings now live in the account dropdown.
    // The settings button/menu code stays (hidden) for the spin animation.
    devRevealedSettings = [];
    const settingsMenu = document.getElementById('settingsMenu');
    if (settingsMenu) {
      // Scope to .dev-only: never resurrect controls marked DEAD.
      settingsMenu.querySelectorAll('.dev-only[style*="display"]').forEach(el => {
        el.style.removeProperty('display');
        devRevealedSettings.push(el);
      });
    }
    // Reveal the playlists tab to assistive tech (hidden via aria until dev).
    try {
      const plTab = document.getElementById('tab-playlists');
      if (plTab) plTab.removeAttribute('aria-hidden');
      const plGrid = document.getElementById('grid-playlists');
      if (plGrid) plGrid.removeAttribute('aria-hidden');
    } catch (e) {}

    // ROADMAP §8.4: player-header quick actions — Later, Fav, Queue, Playlist.
    try { if (typeof ensurePlayerActions === 'function') ensurePlayerActions(); } catch (e) {}

    // Retrofit every card already on the page (server-rendered collections,
    // SSR search grid): progress + buttons are fundamental in dev mode.
    try { devUpgradeCards(); } catch (e) {}

    try { if (typeof renderAccountMode === 'function') renderAccountMode(); } catch (e) {}

    return true;
  }

  // Player-header quick actions, built once for account holders (dev or
  // logged in) so card-driven playback can save/fav/queue from the player.
  function ensurePlayerActions() {
    if (!playlistsEnabled()) return;
    try {
      const details = document.querySelector('.shiur-details');
      if (details && !document.getElementById('devPlayerActions')) {
        const wrap = document.createElement('div');
        wrap.id = 'devPlayerActions';
        wrap.className = 'card-mini-actions acct-only';
        wrap.style.marginTop = '8px';
        const mkBtn = (bid, labelHtml, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.id = bid;
          b.className = 'card-mini-btn';
          b.innerHTML = labelHtml;
          b.addEventListener('click', () => {
            if (currentShiurId) fn(String(currentShiurId));
          });
          return b;
        };
        const psb = mkBtn('devPlayerSaveBtn', getSaveIcon(), toggleDevSave);
        psb.classList.add('icon-btn');
        psb.title = 'Save for later';
        psb.setAttribute('aria-label', 'Save for later');
        wrap.appendChild(psb);
        const pfb = mkBtn('devPlayerFavBtn', '☆', toggleDevFav);
        pfb.classList.add('icon-btn');
        pfb.title = 'Add to favorites';
        pfb.setAttribute('aria-label', 'Add to favorites');
        wrap.appendChild(pfb);
        const pq = document.createElement('button');
        pq.type = 'button';
        pq.id = 'devPlayerQueueBtn';
        pq.className = 'queue-circle-btn acct-only';
        pq.title = 'Add to play queue';
        pq.setAttribute('aria-label', 'Add to play queue');
        pq.innerHTML = devQueueIconSvg();
        pq.addEventListener('click', () => {
          if (currentShiurId) devQueueToggle(String(currentShiurId), false);
        });
        wrap.appendChild(pq);
        const pl = document.createElement('button');
        pl.type = 'button';
        pl.id = 'devPlayerAddBtn';
        pl.className = 'card-mini-btn acct-only';
        pl.textContent = '➕ Playlist';
        pl.addEventListener('click', () => {
          if (currentShiurId) openPlaylistModal(String(currentShiurId));
        });
        wrap.appendChild(pl);
        details.appendChild(wrap);
        devRefreshCardButtons();
      }
    } catch (e) {}
  }

  // Typing "exit dev mode" (case-insensitive) leaves Dev Mode: hide all dev
  // UI, restore aria gating, and re-render the current view without extras.
  function deactivateDevMode() {
    if (!isDevMode) return false;
    isDevMode = false;
    try { localStorage.removeItem('yutorah_dev_mode'); } catch (e) {}
    document.body.classList.remove('dev-mode-active');
    activeDevPlaylistId = 'history';
    try {
      const plTab = document.getElementById('tab-playlists');
      if (plTab) plTab.setAttribute('aria-hidden', 'true');
      const plGrid = document.getElementById('grid-playlists');
      if (plGrid) {
        plGrid.setAttribute('aria-hidden', 'true');
        plGrid.style.display = 'none';
      }
      const devTab = document.getElementById('tab-dev-playlists');
      if (devTab) {
        devTab.setAttribute('aria-hidden', 'true');
        devTab.style.display = 'none';
      }
      const devGrid = document.getElementById('grid-dev-playlists');
      if (devGrid) {
        devGrid.setAttribute('aria-hidden', 'true');
        devGrid.style.display = 'none';
      }
      // Re-hide exactly what activateDevMode revealed (tracked list).
      try {
        (devRevealedSettings || []).forEach(el => {
          if (el && el.style) el.style.setProperty('display', 'none', 'important');
        });
      } catch (e) {}
      devRevealedSettings = [];
      const settingsMenu = document.getElementById('settingsMenu');
      if (settingsMenu) settingsMenu.style.display = 'none';
      const settingsWrapBack = document.querySelector('.settings-wrapper');
      if (settingsWrapBack) settingsWrapBack.setAttribute('aria-hidden', 'true');
      closePlaylistModal();
      closeConfirmModal();
      const qp = document.getElementById('queuePopup');
      if (qp) qp.style.display = 'none';
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab && (activeTab.id === 'tab-playlists' || activeTab.id === 'tab-dev-playlists')) {
        switchCollection('editors');
      }
      renderCurrentSearchResults();
    } catch (e) {}
    try { if (typeof renderAccountMode === 'function') renderAccountMode(); } catch (e) {}
    return true;
  }

  // Secret taps on Calendar Icon / Holiday Motif:
  //   3 taps = toggle pre-roll enable/disable (always works)
  // (Dev Mode is NOT available via taps — type "dev mode" in search instead.)
  let calendarClickCount = 0;
  let calendarClickTimer = null;
  let toastTimer = null;

  let hebrewPulseTimer = null;
  function pulseHebrewDate() {
    try {
      const badge = document.getElementById('hebrewDateBadge');
      if (!badge) return;
      badge.classList.add('expanded');
      clearTimeout(hebrewPulseTimer);
      hebrewPulseTimer = setTimeout(() => badge.classList.remove('expanded'), 2200);
    } catch (e) {}
  }

  function handleCalendarSecretClick(e) {
    if (e) {
      e.stopPropagation();
    }
    calendarClickCount++;
    clearTimeout(calendarClickTimer);

    if (calendarClickCount === 3) {
      // 3 taps: toggle pre-roll enable/disable
      togglePreRoll();
      calendarClickCount = 0;
      calendarClickTimer = setTimeout(() => {
        calendarClickCount = 0;
      }, 2000);
    } else {
      // Not yet at a threshold; reset counter after 2s of inactivity
      calendarClickTimer = setTimeout(() => {
        calendarClickCount = 0;
      }, 2000);
    }
  }

  function togglePreRoll() {
    const currentlyDisabled = isPreRollDisabled();
    const newDisabled = !currentlyDisabled;

    try {
      if (newDisabled) {
        localStorage.setItem('yutorah_preroll_disabled', '1');
      } else {
        localStorage.removeItem('yutorah_preroll_disabled');
      }
    } catch(e) {}

    // If currently playing sponsor audio and user disabled it, immediately skip to shiur
    if (newDisabled && isSponsorPlaying && pendingShiur) {
      skipSponsorAudio();
    }

    const preRollStatus = newDisabled ? '🚫 Pre-roll Disabled' : '✅ Pre-roll Enabled';
    flashToast(preRollStatus, newDisabled, false);
  }


  function flashToast(msg, isDisabled, isDevUnlock = false) {
    const toast = document.getElementById('secretToast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = 'secret-toast ' + (isDevUnlock ? 'toast-dev' : (isDisabled ? 'toast-disabled' : 'toast-enabled'));
    toast.style.display = 'flex';
    void toast.offsetWidth; // Trigger reflow for CSS animation
    toast.classList.add('visible');

    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => {
        if (!toast.classList.contains('visible')) {
          toast.style.display = 'none';
        }
      }, 250);
    }, isDevUnlock ? 2400 : 1500);
  }

  let isSponsorPlaying = false;
  let sponsorPlayedForThisShiur = false;
  let pendingShiur = null;
  let sponsorWatchdog = null;
  let sponsorStallTimer = null;

  function clearSponsorTimers() {
    if (sponsorWatchdog) {
      clearTimeout(sponsorWatchdog);
      sponsorWatchdog = null;
    }
    if (sponsorStallTimer) {
      clearTimeout(sponsorStallTimer);
      sponsorStallTimer = null;
    }
  }

  function resetSponsorWatchdog() {
    clearSponsorTimers();
    if (isSponsorPlaying && pendingShiur) {
      // 25 second safety watchdog: guarantees player never gets stuck in pre-roll
      sponsorWatchdog = setTimeout(() => {
        if (isSponsorPlaying && pendingShiur && !audio.paused) {
          console.warn('Sponsor pre-roll safety watchdog triggered (25s timeout), advancing to shiur');
          startShiurPlayback(pendingShiur);
        }
      }, 25000);
    }
  }

  if (hasAudio && currentShiurId) {
    pendingShiur = {
      id: currentShiurId,
      title: ${jsEmbed(title || '')},
      speaker: ${jsEmbed(speaker || '')},
      teacherId: ${jsEmbed(currentTeacherId || '')},
      photo: ${jsEmbed(photo || '')},
      duration: ${jsEmbed(duration || '')},
      meta: ${jsEmbed(meta || '')},
      desc: ${jsEmbed(description || '')},
      audioSrc: ${jsEmbed(audioUrl || '')},
      dlSrc: ${jsEmbed(audioUrl || '')},
      resumeSec: parseFloat(initialTimestamp) || 0
    };
  }

  // MediaSession API helpers (Mobile Lock Screen & Notification Center)
  function buildMediaSessionArtwork(photoUrl) {
    const fallbackIcon = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
    let url = photoUrl;
    if (!url || typeof url !== 'string' || url.trim() === '') {
      url = fallbackIcon;
    } else if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (url.startsWith('/')) {
      url = 'https://cdnyutorah.cachefly.net' + url;
    }
    return [
      { src: url, sizes: '96x96', type: 'image/jpeg' },
      { src: url, sizes: '128x128', type: 'image/jpeg' },
      { src: url, sizes: '192x192', type: 'image/jpeg' },
      { src: url, sizes: '256x256', type: 'image/jpeg' },
      { src: url, sizes: '384x384', type: 'image/jpeg' },
      { src: url, sizes: '512x512', type: 'image/jpeg' }
    ];
  }

  function registerMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const handlers = [
      ['play', () => { audio.play(); }],
      ['pause', () => { audio.pause(); }],
      ['seekbackward', (details) => { skip(-(details && details.seekOffset ? details.seekOffset : 10)); }],
      ['seekforward', (details) => { skip(details && details.seekOffset ? details.seekOffset : 10); }],
      ['seekto', (details) => {
        if (details && details.seekTime !== undefined && audio && audio.duration) {
          audio.currentTime = details.seekTime;
          updateUrlTimestamp(true);
        }
      }],
      ['stop', () => {
        audio.pause();
        audio.currentTime = 0;
      }]
    ];

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {}
    }
    // Explicitly unregister track actions so mobile iOS Control Center & Android notifications
    // prioritize showing the -10 / +10 circular skip buttons instead of track skip arrows
    try { navigator.mediaSession.setActionHandler('previoustrack', null); } catch (e) {}
    try { navigator.mediaSession.setActionHandler('nexttrack', null); } catch (e) {}
  }

  function cleanMediaText(s) {
    if (!s || typeof s !== 'string') return '';
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function updateMediaSession(title, speaker, photoUrl) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cleanMediaText(title) || 'YUTorah Shiur',
        artist: cleanMediaText(speaker) || 'YUTorah',
        album: 'YUTorah Online',
        artwork: buildMediaSessionArtwork(photoUrl)
      });
      registerMediaSessionHandlers();
      updateMediaSessionPosition();
    } catch (e) {
      console.warn('Error updating MediaSession metadata:', e);
    }
  }

  function updateMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    try {
      if (audio && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration) && audio.duration > 0) {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(Math.max(0, audio.currentTime || 0), audio.duration)
        });
      }
    } catch (e) {}
  }

  function playSponsorPreRoll(shiurObj) {
    if (isPreRollDisabled() || !currentSponsorAudio) {
      startShiurPlayback(shiurObj);
      return;
    }

    // If sponsorship data hasn't been checked in >5 minutes, refresh in background
    if (Date.now() - lastSponsorCheck > 300000) {
      refreshDailySponsorship();
    }

    isSponsorPlaying = true;
    pendingShiur = shiurObj;

    const banner = document.getElementById('sponsorPreRollBanner');
    if (banner) {
      banner.style.display = 'block';
      const bodyEl = document.getElementById('sponsorPreRollText');
      if (bodyEl && currentSponsorText) bodyEl.innerHTML = currentSponsorText;
      const countdownEl = document.getElementById('sponsorCountdown');
      if (countdownEl) countdownEl.textContent = '10';
    }

    if (shiurObj) {
      currentSpeakerTeacherId = shiurObj.teacherId || '';
      currentSpeakerName = shiurObj.speaker || '';
    }

    document.title = shiurObj.title + " — YUTorah Enhanced";
    const titleEl = document.getElementById('shiurTitle');
    if (titleEl) titleEl.textContent = shiurObj.title;
    const speakerEl = document.getElementById('shiurSpeaker');
    if (speakerEl) speakerEl.textContent = shiurObj.speaker || '';
    const metaEl = document.getElementById('shiurMeta');
    if (metaEl) metaEl.textContent = shiurObj.meta || (shiurObj.duration ? shiurObj.duration : '');

    const img = document.getElementById('speakerImg');
    if (img) {
      if (shiurObj.photo) {
        img.src = shiurObj.photo;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    }

    const curTimeNode = document.getElementById('curTime');
    if (curTimeNode) curTimeNode.textContent = '0:00';
    const totalTimeEl = document.getElementById('totalTime');
    if (totalTimeEl) totalTimeEl.textContent = '0:10';
    const sBar = document.getElementById('scrubberBar');
    if (sBar) sBar.classList.add('is-sponsor-preroll');
    const miniBar = document.getElementById('miniProgressBar');
    if (miniBar) miniBar.classList.add('is-sponsor-preroll');
    const sFill = document.getElementById('scrubberFill');
    if (sFill) sFill.style.width = '0%';

    const miniTitle = document.getElementById('miniTitle');
    const miniSpeaker = document.getElementById('miniSpeaker');
    const miniThumb = document.getElementById('miniThumb');
    const miniTime = document.getElementById('miniTime');
    if (miniTitle) miniTitle.textContent = shiurObj.title;
    if (miniSpeaker) miniSpeaker.textContent = (shiurObj.speaker ? shiurObj.speaker + ' · ' : '') + "🎙️ Playing Sponsor Dedication";
    if (miniThumb) {
      if (shiurObj.photo) {
        miniThumb.src = shiurObj.photo;
        miniThumb.style.display = 'block';
      } else {
        miniThumb.style.display = 'none';
      }
    }
    if (miniTime) miniTime.textContent = '0:00 / 0:10';

    if ('mediaSession' in navigator) {
      updateMediaSession(
        shiurObj.title + " (Sponsorship)",
        (shiurObj.speaker ? shiurObj.speaker + " · " : "") + "Today's Dedication",
        shiurObj.photo
      );
    }

    hasAudio = true;
    audio.src = currentSponsorAudio;
    audio.playbackRate = 1;
    audio.load();
    resetSponsorWatchdog();

    const p = audio.play();
    if (p !== undefined) {
      p.then(() => {
        startSponsorRaf();
      }).catch(err => {
        console.log('Autoplay sponsor prevented or error:', err);
      });
    }
  }

  function skipSponsorAudio() {
    stopSponsorRaf();
    if (!isSponsorPlaying || !pendingShiur) return;
    startShiurPlayback(pendingShiur);
  }

  function startShiurPlayback(shiurObj) {
    stopSponsorRaf();
    clearSponsorTimers();
    isSponsorPlaying = false;
    sponsorPlayedForThisShiur = true;

    const banner = document.getElementById('sponsorPreRollBanner');
    if (banner) banner.style.display = 'none';

    const sBar = document.getElementById('scrubberBar');
    if (sBar) sBar.classList.remove('is-sponsor-preroll');
    const miniBar = document.getElementById('miniProgressBar');
    if (miniBar) miniBar.classList.remove('is-sponsor-preroll');

    if (shiurObj) {
      currentSpeakerTeacherId = shiurObj.teacherId || '';
      currentSpeakerName = shiurObj.speaker || '';
    }

    document.title = shiurObj.title + ' — YUTorah Enhanced';
    const titleEl = document.getElementById('shiurTitle');
    if (titleEl) titleEl.textContent = shiurObj.title;
    const speakerEl = document.getElementById('shiurSpeaker');
    if (speakerEl) speakerEl.textContent = shiurObj.speaker;
    const metaEl = document.getElementById('shiurMeta');
    if (metaEl) metaEl.textContent = shiurObj.meta || (shiurObj.duration + (shiurObj.date ? ' · ' + shiurObj.date : ''));

    const img = document.getElementById('speakerImg');
    if (img) {
      if (shiurObj.photo) {
        img.src = shiurObj.photo;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    }

    const descEl = document.getElementById('shiurDesc');
    if (descEl) {
      if (shiurObj.desc) {
        descEl.textContent = shiurObj.desc;
        descEl.style.display = 'block';
      } else {
        descEl.style.display = 'none';
      }
    }

    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn && shiurObj.dlSrc) {
      dlBtn.href = shiurObj.dlSrc;
      dlBtn.style.display = 'inline-flex';
    }

    const miniTitle = document.getElementById('miniTitle');
    const miniSpeaker = document.getElementById('miniSpeaker');
    const miniThumb = document.getElementById('miniThumb');
    const miniTime = document.getElementById('miniTime');
    if (miniTitle) miniTitle.textContent = shiurObj.title;
    if (miniSpeaker) miniSpeaker.textContent = shiurObj.speaker;
    if (miniThumb) miniThumb.src = shiurObj.photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
    if (miniTime) miniTime.textContent = '0:00 / ' + (shiurObj.duration || '0:00');

    if ('mediaSession' in navigator) {
      updateMediaSession(shiurObj.title, shiurObj.speaker, shiurObj.photo);
    }

    hasAudio = true;
    initialTimeApplied = false;
    audio.src = shiurObj.audioSrc;
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    audio.load();

    const onLoaded = function() {
      audio.removeEventListener('loadedmetadata', onLoaded);
      if (currentPlaybackRate) {
        audio.playbackRate = currentPlaybackRate;
      }
      if (shiurObj.resumeSec > 0) {
        audio.currentTime = Math.min(shiurObj.resumeSec, (audio.duration || Infinity) - 1);
        updateUrlTimestamp(true);
      }
    };
    audio.addEventListener('loadedmetadata', onLoaded);

    const p = audio.play();
    if (p !== undefined) {
      p.catch(err => console.log('Shiur audio play error:', err));
    }
  }

  // Initialize playback rate from URL or server-rendered initial speed
  let currentPlaybackRate = 1;
  try {
    const initSpeedParam = new URL(window.location.href).searchParams.get('speed') || new URL(window.location.href).searchParams.get('rate') || initialPlaybackSpeed;
    if (initSpeedParam) {
      const parsedSpeed = parseFloat(initSpeedParam);
      if (!isNaN(parsedSpeed) && parsedSpeed > 0 && parsedSpeed <= 5) {
        currentPlaybackRate = parsedSpeed;
      }
    }
  } catch(e) {}
  if (audio && currentPlaybackRate !== 1) {
    audio.playbackRate = currentPlaybackRate;
  }

  function updateUrlTimestamp(force) {
    if (isSponsorPlaying) return;
    if (!hasAudio || !audio.src) return;
    const curTime = audio.currentTime;
    if (isNaN(curTime) || curTime < 0) return;
    const curSec = Math.floor(curTime);

    const now = Date.now();
    // Throttled: update URL at most once every 5 seconds, unless forced (pause, seek, tab close)
    if (!force && (curSec === lastUrlUpdateSec || (now - lastUrlUpdateTime < 5000))) {
      return;
    }

    lastUrlUpdateSec = curSec;
    lastUrlUpdateTime = now;

    // Save to localStorage for instant resume even without URL parameter
    if (currentShiurId && curSec > 0) {
      try {
        localStorage.setItem('yutorah_progress_' + currentShiurId, curSec);
      } catch (e) {}
    }

    // Update the browser URL in-place without polluting back-button history
    try {
      const url = new URL(window.location.href);
      if (curSec > 0) {
        url.searchParams.set('t', curSec);
      } else {
        url.searchParams.delete('t');
      }
      history.replaceState(history.state, '', url.toString());
    } catch (e) {}
  }

  function applyInitialTime() {
    if (isSponsorPlaying) return;
    if (initialTimeApplied) return;
    let targetSec = 0;
    if (initialTimestamp) {
      const p = parseFloat(initialTimestamp);
      if (!isNaN(p) && p > 0) targetSec = p;
    } else if (currentShiurId) {
      try {
        const saved = parseFloat(localStorage.getItem('yutorah_progress_' + currentShiurId));
        if (!isNaN(saved) && saved > 5) targetSec = saved;
      } catch (e) {}
    }

    if (targetSec > 0) {
      if (audio.duration && !isNaN(audio.duration)) {
        audio.currentTime = Math.min(targetSec, audio.duration - 1);
        initialTimeApplied = true;
        updateUrlTimestamp(true);
      } else {
        try {
          audio.currentTime = targetSec;
          initialTimeApplied = true;
          updateUrlTimestamp(true);
        } catch(e) {}
      }
    }
  }

  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
    return m + ':' + seconds.toString().padStart(2, '0');
  }

  // Handle Search input
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const searchPreviewDropdown = document.getElementById('searchPreviewDropdown');
  let searchDebounceTimer = null;
  let previewAbortCtrl = null;
  let currentPreviewReqId = 0;

  function closeSearchPreview() {
    if (previewAbortCtrl) {
      previewAbortCtrl.abort();
      previewAbortCtrl = null;
    }
    currentPreviewReqId++;
    previewFocusables = [];
    previewFocusIdx = -1;
    if (searchPreviewDropdown) {
      searchPreviewDropdown.style.display = 'none';
      searchPreviewDropdown.innerHTML = '';
    }
  }

  // Keyboard navigation for the preview dropdown (§5.4: ↑/↓ + Enter/Esc).
  let previewFocusables = [];
  let previewFocusIdx = -1;
  function updatePreviewFocus() {
    previewFocusables.forEach((el, i) => {
      if (i === previewFocusIdx) el.classList.add('preview-focused');
      else el.classList.remove('preview-focused');
    });
    const cur = previewFocusables[previewFocusIdx];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function collectPreviewFocusables() {
    if (!searchPreviewDropdown) return;
    previewFocusables = Array.prototype.slice.call(
      searchPreviewDropdown.querySelectorAll('[data-suggestion-idx], .preview-shiur-item, #previewViewAllBtn'));
    previewFocusIdx = -1;
  }

  // Click outside closes search preview
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-wrapper')) {
      closeSearchPreview();
    }
  });

  async function fetchSearchPreview(query) {
    if (previewAbortCtrl) previewAbortCtrl.abort();
    previewAbortCtrl = new AbortController();
    const thisReqId = ++currentPreviewReqId;

    try {
      // 1. Check local entity matches (speakers and categories from cached AUTOCOMPLETE_META)
      const suggestions = [];
      const qLower = query.toLowerCase();

      // Look up speakers
      if (typeof autocompleteCache !== 'undefined' && autocompleteCache?.teachers) {
        const matchedTeachers = autocompleteCache.teachers
          .filter(t => t.name.toLowerCase().includes(qLower))
          .slice(0, 3);
        matchedTeachers.forEach(t => {
          suggestions.push({
            type: 'speaker',
            icon: '👤',
            title: t.name,
            sub: (t.count ? t.count.toLocaleString() + ' shiurim' : 'Speaker'),
            action: () => {
              closeSearchPreview();
              searchInput.value = '';
              activeAdvancedFilters = {
                keywords: '',
                teachers: [{ id: t.id, name: t.name }],
                categories: [],
                locations: [],
                series: [],
                minDuration: '',
                maxDuration: '',
                durationLabel: '',
                year: '',
                yearLabel: '',
                fromDate: '',
                toDate: '',
                dateQuick: '',
                dateQuickLabel: '',
                dateRangeLabel: '',
                mediaType: 'all',
                mediaTypeLabel: '',
                enablePhonetics: true
              };
              syncDateQuickChips();
              executeLiveSearch('', { ...activeAdvancedFilters, speakerView: true, label: 'Shiurim by ' + t.name });
            }
          });
        });
      }

      // Look up categories
      if (typeof autocompleteCache !== 'undefined' && autocompleteCache?.categories) {
        const matchedCats = autocompleteCache.categories
          .filter(c => c.name.toLowerCase().includes(qLower))
          .slice(0, 2);
        matchedCats.forEach(c => {
          suggestions.push({
            type: 'category',
            icon: '🏷️',
            title: c.name,
            sub: (c.count ? c.count.toLocaleString() + ' shiurim' : 'Topic'),
            action: () => {
              closeSearchPreview();
              searchInput.value = '';
              activeAdvancedFilters = {
                keywords: '',
                teachers: [],
                categories: [{ id: c.id, name: c.name }],
                locations: [],
                series: [],
                minDuration: '',
                maxDuration: '',
                durationLabel: '',
                year: '',
                yearLabel: '',
                fromDate: '',
                toDate: '',
                dateQuick: '',
                dateQuickLabel: '',
                dateRangeLabel: '',
                mediaType: 'all',
                mediaTypeLabel: '',
                enablePhonetics: true
              };
              syncDateQuickChips();
              executeLiveSearch('', { ...activeAdvancedFilters, label: 'Topic: ' + c.name });
            }
          });
        });
      }

      // ROADMAP §5.4: fuzzy fallback — when substring matches are thin,
      // offer Levenshtein-ranked teacher/topic/venue candidates. Clicking
      // one puts the corrected term in the search box and runs the search.
      if (suggestions.length < 5) {
        const haveTitles = new Set(suggestions.map(s => s.title.toLowerCase()));
        const fuzzyIcons = { teacher: '👤', topic: '🏷️', venue: '📍' };
        clientFuzzySuggest(query, 5).forEach(f => {
          if (haveTitles.has(f.text.toLowerCase())) return;
          haveTitles.add(f.text.toLowerCase());
          suggestions.push({
            type: f.type,
            icon: fuzzyIcons[f.type] || '🔍',
            title: f.text,
            sub: (f.type === 'teacher' ? 'Speaker' : f.type === 'venue' ? 'Venue' : 'Topic') + ' · Did you mean?',
            action: () => {
              closeSearchPreview();
              searchInput.value = f.text;
              if (typeof clearSearchBtn !== 'undefined' && clearSearchBtn) clearSearchBtn.style.display = 'block';
              doSearch();
            }
          });
        });
      }

      // 2. Fetch live preview shiur results from /api/search?q=...&start=1
      const phoneticsParam = (typeof activeAdvancedFilters !== 'undefined' && activeAdvancedFilters?.enablePhonetics === false) ? '&exact=1' : '';
      const mediaParam = (typeof activeAdvancedFilters !== 'undefined' && activeAdvancedFilters?.mediaType && activeAdvancedFilters.mediaType !== 'all') ? ('&mediaType=' + encodeURIComponent(activeAdvancedFilters.mediaType)) : '';
      const res = await fetch('/api/search?q=' + encodeURIComponent(query) + '&start=1' + phoneticsParam + mediaParam, {
        signal: previewAbortCtrl.signal
      });
      if (!res.ok) return;
      const data = await res.json();
      if (thisReqId !== currentPreviewReqId) return;
      const docs = (data?.response?.docs || []).slice(0, 5);
      const totalCount = data?.response?.numFound || 0;

      if (!searchPreviewDropdown) return;
      if (suggestions.length === 0 && docs.length === 0) {
        closeSearchPreview();
        return;
      }

      let html = '';

      // Render entity suggestions (speakers/topics)
      if (suggestions.length > 0) {
        html += '<div class="preview-section-title"><span>Suggested Topics &amp; Speakers</span></div>';
        suggestions.forEach((s, idx) => {
          html += '<div class="preview-item" data-suggestion-idx="' + idx + '">' +
            '<span class="preview-item-icon">' + s.icon + '</span>' +
            '<div class="preview-item-body">' +
              '<div class="preview-item-title">' + escapeHtml(s.title) + '</div>' +
              '<div class="preview-item-sub">' + escapeHtml(s.sub) + '</div>' +
            '</div>' +
            '<span class="preview-item-badge">Filter</span>' +
          '</div>';
        });
      }

      // Render top matching shiurim
      if (docs.length > 0) {
        html += '<div class="preview-section-title"><span>Matching Shiurim</span><span>' + totalCount.toLocaleString() + ' found</span></div>';
        docs.forEach(d => {
          const id = escapeHtml(String(d.shiurid || d.shiurID || ''));
          const title = d.shiurtitle || d.shiurTitle || 'Untitled';
          const speaker = d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : 'YUTorah');
          const duration = d.durationformatted || (d.duration ? d.duration + ' min' : '');
          const rawDate = d.shiurdateformatted || d.shiurDateFormatted || d.shiurdate || d.shiurDate || d.shiurdatesubmitted || d.shiurDateSubmitted || '';
          const date = typeof formatShiurDate === 'function' ? formatShiurDate(rawDate) : '';

          const subParts = [speaker];
          if (date) subParts.push(date);
          if (duration) subParts.push(duration);

          const dMediaCat = (d.mediatypecategory || d.mediaTypeCategory || '').toLowerCase();
          const dUrlCheck = d.shiururl || d.shiurURL || d.playerDownloadURL || d.downloadURL || '';
          const dIsArticle = dMediaCat === 'text' || dMediaCat === 'article' || /[.]pdf($|[?])/i.test(dUrlCheck);
          const previewIcon = dIsArticle ? '📄' : '🎧';
          const previewBadge = dIsArticle ? '📄 Read' : '▶ Play';

          html += '<a href="/' + id + '" class="preview-item preview-shiur-item" data-id="' + id + '">' +
            '<span class="preview-item-icon">' + previewIcon + '</span>' +
            '<div class="preview-item-body">' +
              '<div class="preview-item-title">' + escapeHtml(title) + '</div>' +
              '<div class="preview-item-sub">' + escapeHtml(subParts.join(' · ')) + '</div>' +
            '</div>' +
            '<span class="preview-item-badge">' + previewBadge + '</span>' +
          '</a>';
        });

        html += '<div class="preview-footer-view-all" id="previewViewAllBtn">' +
          'View all ' + totalCount.toLocaleString() + ' results for "' + escapeHtml(query) + '" →' +
        '</div>';
      }

      searchPreviewDropdown.innerHTML = html;
      searchPreviewDropdown.style.display = 'block';

      // Attach click events for suggestions
      searchPreviewDropdown.querySelectorAll('[data-suggestion-idx]').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.getAttribute('data-suggestion-idx'), 10);
          if (suggestions[idx]) suggestions[idx].action();
        });
      });

      // Attach click events for shiur results
      searchPreviewDropdown.querySelectorAll('.preview-shiur-item').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          const id = el.getAttribute('data-id');
          closeSearchPreview();
          playShiurById(null, id);
        });
      });

      // Attach click event for "View all" footer
      const viewAllBtn = document.getElementById('previewViewAllBtn');
      if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => {
          closeSearchPreview();
          doSearch();
        });
      }
      collectPreviewFocusables();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Preview fetch error:', err);
      }
    }
  }

  function onSearchInput() {
    const val = searchInput.value;
    clearSearchBtn.style.display = val.trim() ? 'block' : 'none';

    clearTimeout(searchDebounceTimer);
    const query = val.trim();
    if (!query) {
      closeSearchPreview();
      clearSearch();
      return;
    }

    // Easter egg: typing "dev mode" in the search bar activates Dev Mode
    if (query.toLowerCase() === 'dev mode') {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      closeSearchPreview();
      if (!isDevMode) {
        activateDevMode();
        flashToast('🛠️ Dev Mode Unlocked!', false, true);
      } else {
        flashToast('🛠️ Dev Mode already active', false, true);
      }
      return;
    }

    // Typing "exit dev mode" (case-insensitive) leaves Dev Mode.
    if (query.toLowerCase() === 'exit dev mode') {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      closeSearchPreview();
      if (isDevMode) {
        deactivateDevMode();
        flashToast('👋 Dev Mode Off', false, false);
      } else {
        flashToast('Dev Mode is not active', false, false);
      }
      return;
    }

    if (query.length < 2) {
      closeSearchPreview();
      return;
    }

    // Debounced Live Preview Dropdown (250ms)
    searchDebounceTimer = setTimeout(() => {
      fetchSearchPreview(query);
    }, 250);
  }

  // Helper: check if any advanced filters are actively set
  function hasActiveFilters() {
    return (activeAdvancedFilters.teachers && activeAdvancedFilters.teachers.length > 0) ||
      (activeAdvancedFilters.categories && activeAdvancedFilters.categories.length > 0) ||
      (activeAdvancedFilters.locations && activeAdvancedFilters.locations.length > 0) ||
      (activeAdvancedFilters.series && activeAdvancedFilters.series.length > 0) ||
      activeAdvancedFilters.minDuration || activeAdvancedFilters.maxDuration ||
      activeAdvancedFilters.year || activeAdvancedFilters.fromDate || activeAdvancedFilters.toDate ||
      (activeAdvancedFilters.mediaType && activeAdvancedFilters.mediaType !== 'all');
  }

  function doSearch() {
    clearTimeout(searchDebounceTimer);
    closeSearchPreview();
    const rawBarValue = searchInput.value.trim();

    // If advanced filters are active:
    if (hasActiveFilters()) {
      const teacherDisplayNames = (activeAdvancedFilters.teachers || []).map(t => t.name).join(', ');
      let effectiveKeywords;
      if (rawBarValue === teacherDisplayNames || (!rawBarValue && activeAdvancedFilters.teachers.length > 0)) {
        effectiveKeywords = activeAdvancedFilters.keywords || '';
        executeLiveSearch(effectiveKeywords, { ...activeAdvancedFilters });
        scrollToSearchResults();
        return;
      } else {
        // User typed a new search query into the search bar:
        // Clear previous teacher filter so it doesn't silently trap or conflict with the new search!
        activeAdvancedFilters.teachers = [];
        activeAdvancedFilters.keywords = rawBarValue;
        executeLiveSearch(rawBarValue, { ...activeAdvancedFilters });
        scrollToSearchResults();
        return;
      }
    }

    if (!rawBarValue) return;

    if (rawBarValue.toLowerCase() === 'dev mode') {
      searchInput.value = '';
      if (clearSearchBtn) clearSearchBtn.style.display = 'none';
      if (!isDevMode) {
        activateDevMode();
        flashToast('🛠️ Dev Mode Unlocked!', false, true);
      } else {
        flashToast('🛠️ Dev Mode already active', false, true);
      }
      return;
    }

    if (rawBarValue.toLowerCase() === 'exit dev mode') {
      searchInput.value = '';
      if (clearSearchBtn) clearSearchBtn.style.display = 'none';
      if (isDevMode) {
        deactivateDevMode();
        flashToast('👋 Dev Mode Off', false, false);
      } else {
        flashToast('Dev Mode is not active', false, false);
      }
      return;
    }

    // Smart detect: is it a Shiur ID or YUTorah URL?
    const id = extractShiurId(rawBarValue);
    if (id) {
      playShiurById(null, id);
      return;
    }

    executeLiveSearch(rawBarValue);
    scrollToSearchResults();
  }

  function handleSearchSubmit(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    doSearch();
    return false;
  }

  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', (e) => {
    const open = searchPreviewDropdown && searchPreviewDropdown.style.display === 'block' && previewFocusables.length > 0;
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      previewFocusIdx = (previewFocusIdx + dir + previewFocusables.length) % previewFocusables.length;
      updatePreviewFocus();
    } else if (e.key === 'Enter' && previewFocusIdx >= 0 && previewFocusables[previewFocusIdx]) {
      e.preventDefault();
      previewFocusables[previewFocusIdx].click();
    }
  });

  if (searchInput.value.trim()) {
    clearSearchBtn.style.display = 'block';
  }

  function handleImgError(img) {
    img.onerror = null;
    img.src = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
  }

  function extractShiurId(text) {
    if (!text) return null;
    var t = text.trim();
    if (/^[0-9]{4,8}$/.test(t)) return t;
    if (t.indexOf('shiurID=') !== -1) {
      var p1 = t.split(/shiurID=/i);
      var id1 = p1[1] ? p1[1].split(/[^0-9]/)[0] : '';
      if (id1) return id1;
    }
    if (t.indexOf('lectures/') !== -1) {
      var p2 = t.split('lectures/');
      var id2 = p2[1] ? p2[1].split(/[^0-9]/)[0] : '';
      if (id2) return id2;
    }
    return null;
  }

  let currentSearchQuery = ${jsEmbed(searchQuery || '')};
  let currentFilterParams = {};
  let currentLoadedDocsCount = ${jsEmbed(initialSearchResults ? initialSearchResults.length : 0)};
  let totalSearchResults = ${jsEmbed(initialNumFound || 0)};
  let currentSearchPage = Math.floor(${jsEmbed(initialSearchResults ? initialSearchResults.length : 0)} / 30) || 1;
  let isLoadingMore = false;
  let currentSpeakerViewCache = null;

  // Recent Results rail state (fixed top-3, no expansion control).
  let currentRecentDocs = ${jsEmbed(initialRecentDocs || [])};
  let recentNumFound = ${jsEmbed(initialRecentNumFound || 0)};
  let currentSearchAbort = null;
  let currentPhoneticTokens = ${jsEmbed(initialPhoneticExpansion?.tokens || [])};
  let currentSearchDocs = ${jsEmbed(initialSearchResults || [])};
  let currentDidYouMean = ${jsEmbed(initialDidYouMean || [])};
  let currentQueryResolution = ${jsEmbed(initialQueryResolution || null)};
  let showMatchReasons = false;
  let useClassicSearch = ${Boolean(isClassicSearch)};
  let stackSeriesEnabled = true;

  const COMMUNITY_ACRONYM_PHRASES = {
    yije: ['Young Israel of Jamaica Estates', 'Jamaica Estates', 'YIJE'],
    yih: ['Young Israel of Hollywood', 'YIH'],
    yihl: ['Young Israel of Hewlett', 'YIHL'],
    yish: ['Young Israel of Scarsdale', 'YISH'],
    yifh: ['Young Israel of Forest Hills', 'YIFH'],
    yist: ['Young Israel of Staten Island', 'YIST'],
    yiw: ['Young Israel of Woodmere', 'YIW'],
    yipc: ['Young Israel of Plainview', 'YIPC'],
    yioz: ['Young Israel of Oceanside', 'YIOZ'],
    bmt: ['Beit Midrash of Teaneck', 'BMT'],
    bcbm: ['Bergen County Beit Midrash', 'BCBM'],
    riets: ['Rabbi Isaac Elchanan Theological Seminary', 'RIETS'],
    yu: ['Yeshiva University', 'YU'],
    ou: ['Orthodox Union', 'OU'],
    ncsy: ['NCSY']
  };

  function getActiveSearchTerms() {
    const terms = new Set();

    if (currentSearchQuery) {
      const rawWords = currentSearchQuery.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
      for (const w of rawWords) {
        terms.add(w);
        if (COMMUNITY_ACRONYM_PHRASES[w]) {
          for (const exp of COMMUNITY_ACRONYM_PHRASES[w]) {
            terms.add(exp.toLowerCase());
            exp.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length >= 3).forEach(x => terms.add(x));
          }
        }
      }
    }

    if (Array.isArray(currentPhoneticTokens)) {
      for (const t of currentPhoneticTokens) {
        if (t && t.length >= 2) {
          terms.add(t.toLowerCase());
        }
      }
    }

    if (currentFilterParams) {
      if (Array.isArray(currentFilterParams.teachers)) {
        currentFilterParams.teachers.forEach(t => {
          if (t.name) {
            terms.add(t.name.toLowerCase());
            t.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !['rabbi', 'rav', 'doctor', 'dr'].includes(w)).forEach(w => terms.add(w));
          }
        });
      }
      if (Array.isArray(currentFilterParams.locations)) {
        currentFilterParams.locations.forEach(l => {
          if (l.name) {
            terms.add(l.name.toLowerCase());
            l.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3).forEach(w => terms.add(w));
          }
        });
      }
      if (Array.isArray(currentFilterParams.categories)) {
        currentFilterParams.categories.forEach(c => {
          if (c.name) {
            terms.add(c.name.toLowerCase());
          }
        });
      }
    }

    return Array.from(terms).sort((a, b) => b.length - a.length);
  }

  function highlightMatches(text, terms) {
    if (!text || !terms || terms.length === 0) return escapeHtml(text);
    const lower = text.toLowerCase();
    const ranges = [];

    for (const term of terms) {
      if (!term || term.length < 2) continue;
      const termLower = term.toLowerCase();
      let pos = 0;
      while ((pos = lower.indexOf(termLower, pos)) !== -1) {
        ranges.push([pos, pos + termLower.length]);
        pos += termLower.length;
      }
    }

    if (ranges.length === 0) return escapeHtml(text);

    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = ranges[i];
      if (curr[0] <= prev[1]) {
        prev[1] = Math.max(prev[1], curr[1]);
      } else {
        merged.push(curr);
      }
    }

    let result = '';
    let lastIdx = 0;
    for (const [start, end] of merged) {
      result += escapeHtml(text.slice(lastIdx, start));
      result += '<mark class="match-mark">' + escapeHtml(text.slice(start, end)) + '</mark>';
      lastIdx = end;
    }
    result += escapeHtml(text.slice(lastIdx));
    return result;
  }

  function extractSnippet(text, terms, windowBefore = 45, windowAfter = 65) {
    if (!text || !terms || terms.length === 0) return null;
    const lower = text.toLowerCase();
    let firstPos = -1;
    let matchedTerm = '';

    for (const term of terms) {
      if (!term || term.length < 2) continue;
      const termLower = term.toLowerCase();
      const pos = lower.indexOf(termLower);
      if (pos !== -1) {
        if (firstPos === -1 || pos < firstPos) {
          firstPos = pos;
          matchedTerm = termLower;
        }
      }
    }

    if (firstPos === -1) return null;

    let start = Math.max(0, firstPos - windowBefore);
    let end = Math.min(text.length, firstPos + matchedTerm.length + windowAfter);

    let prefix = '...';
    let suffix = '...';

    if (start === 0) prefix = '';
    else {
      const spaceIdx = text.indexOf(' ', start);
      if (spaceIdx !== -1 && spaceIdx < firstPos) {
        start = spaceIdx + 1;
      }
    }

    if (end === text.length) suffix = '';
    else {
      const spaceIdx = text.lastIndexOf(' ', end);
      if (spaceIdx !== -1 && spaceIdx > firstPos + matchedTerm.length) {
        end = spaceIdx;
      }
    }

    const rawSnippet = prefix + text.slice(start, end).trim() + suffix;
    return highlightMatches(rawSnippet, terms);
  }

  function buildMatchReasons(doc, terms) {
    const reasons = [];

    const desc = doc.shiurdescription || doc.description || '';
    if (desc) {
      const descSnippet = extractSnippet(desc, terms, 45, 65);
      if (descSnippet && descSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '📄 Description Match',
          snippet: descSnippet
        });
      }
    }

    const loc = Array.isArray(doc.location) ? doc.location.join(', ') : (doc.location || '');
    if (loc) {
      const locSnippet = extractSnippet(loc, terms, 60, 60);
      if (locSnippet && locSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '📍 Venue Match',
          snippet: locSnippet
        });
      }
    }

    const kw = Array.isArray(doc.shiurkeywords) ? doc.shiurkeywords.join(', ') : (doc.shiurkeywords || doc.keywords || '');
    if (kw) {
      const kwSnippet = extractSnippet(kw, terms, 50, 50);
      if (kwSnippet && kwSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '🏷️ Keywords Match',
          snippet: kwSnippet
        });
      }
    }

    const series = Array.isArray(doc.seriesname) ? doc.seriesname.join(', ') : (doc.seriesname || doc.series || '');
    if (series) {
      const seriesSnippet = extractSnippet(series, terms, 50, 50);
      if (seriesSnippet && seriesSnippet.includes('<mark class="match-mark">')) {
        reasons.push({
          badge: '📚 Series Match',
          snippet: seriesSnippet
        });
      }
    }

    return reasons;
  }

  function onToggleMatchExplain(checked) {
    showMatchReasons = !!checked;
    const grid = document.getElementById('searchResultsGrid');
    if (grid) {
      grid.classList.toggle('explain-matches-active', showMatchReasons);
    }
  }

  const SEARCH_STOP_WORDS = new Set(['of', 'the', 'in', 'on', 'a', 'an', 'and', 'for', 'to', 'with', 'at', 'by', 'from', 'about']);

  function computeRelevanceScore(d, queryTerms = [], rawQuery = '') {
    if (!d) return 0;
    const title = (d.shiurtitle || d.shiurTitle || d.title || '').toLowerCase();
    const speaker = (d.teacherfullname || d.speaker || '').toLowerCase();
    const series = (Array.isArray(d.seriesname) ? d.seriesname.join(' ') : (d.seriesname || d.series || '')).toLowerCase();
    const collection = (Array.isArray(d.collectionname) ? d.collectionname.join(' ') : (d.collectionname || '')).toLowerCase();
    const category = (Array.isArray(d.categoryname) ? d.categoryname.join(' ') : (d.category || '')).toLowerCase();
    const desc = (d.shiurdescription || d.description || '').toLowerCase();

    let score = 0;

    const cleanRaw = (rawQuery || '').toLowerCase().trim();
    if (cleanRaw && title.includes(cleanRaw)) {
      score += 1000;
    }

    const terms = (queryTerms || []).map(t => t.toLowerCase()).filter(t => t.length >= 2 && !SEARCH_STOP_WORDS.has(t));
    if (terms.length === 0) return score;

    const titleWords = title.split(/[^a-z0-9א-ת]+/);
    let titleMatches = 0;
    let speakerMatches = 0;
    let seriesMatches = 0;

    for (const t of terms) {
      if (title.includes(t)) {
        score += 120;
        titleMatches++;
        if (titleWords.includes(t)) {
          score += 80;
        }
      }
      if (speaker.includes(t)) {
        score += 100;
        speakerMatches++;
      }
      if (series.includes(t) || collection.includes(t)) {
        score += 60;
        seriesMatches++;
      }
      if (category.includes(t)) {
        score += 40;
      }
      if (desc.includes(t)) {
        score += 5;
      }
    }

    if (titleMatches >= 2 && titleMatches === terms.length) {
      score += 300;
    } else if ((titleMatches + seriesMatches) >= terms.length) {
      score += 200;
    }

    return score;
  }

  function groupAndRankDocs(docs, queryTerms = [], rawQuery = '') {
    if (!Array.isArray(docs)) return [];
    const groups = new Map();
    const standalone = [];

    for (const doc of docs) {
      let groupKey = null;
      let groupTitle = null;

      if (Array.isArray(doc.collectionid) && doc.collectionid.length > 0 && doc.collectionname && doc.collectionname[0]) {
        const parts = doc.collectionname[0].split('|');
        groupKey = 'coll_' + doc.collectionid[0];
        groupTitle = parts[0].trim();
      } else if (doc.seriesid && doc.seriesname) {
        groupKey = 'series_' + doc.seriesid;
        groupTitle = doc.seriesname;
      }

      if (groupKey) {
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { key: groupKey, title: groupTitle, docs: [] });
        }
        groups.get(groupKey).docs.push(doc);
      } else {
        standalone.push(doc);
      }
    }

    const items = [];
    for (const [k, g] of groups.entries()) {
      if (g.docs.length >= 2) {
        g.docs.sort((a, b) => {
          const da = a.shiurdate || a.shiurdatesubmitted || '';
          const db = b.shiurdate || b.shiurdatesubmitted || '';
          return da.localeCompare(db);
        });
        const maxScore = Math.max(...g.docs.map(d => computeRelevanceScore(d, queryTerms, rawQuery)));
        items.push({
          isSeries: true,
          key: g.key,
          title: g.title,
          docs: g.docs,
          cover: g.docs[0],
          subDocs: g.docs.slice(1),
          score: maxScore
        });
      } else {
        items.push({
          isSeries: false,
          doc: g.docs[0],
          score: computeRelevanceScore(g.docs[0], queryTerms, rawQuery)
        });
      }
    }

    for (const doc of standalone) {
      items.push({
        isSeries: false,
        doc,
        score: computeRelevanceScore(doc, queryTerms, rawQuery)
      });
    }

    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateA = a.isSeries ? (a.cover.shiurdate || a.cover.shiurdatesubmitted || '') : (a.doc.shiurdate || a.doc.shiurdatesubmitted || '');
      const dateB = b.isSeries ? (b.cover.shiurdate || b.cover.shiurdatesubmitted || '') : (b.doc.shiurdate || b.doc.shiurdatesubmitted || '');
      return dateB.localeCompare(dateA);
    });

    return items;
  }

  function toggleSeriesDrawer(e, drawerId) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!drawerId && e && e.currentTarget) {
      drawerId = e.currentTarget.dataset.drawerTarget;
    }
    if (!drawerId) return;
    const drawer = document.getElementById(drawerId);
    const btn = document.querySelector('[data-drawer-target="' + drawerId + '"]');
    if (!drawer) return;
    const isHidden = drawer.style.display === 'none';
    drawer.style.display = isHidden ? 'flex' : 'none';
    if (btn) {
      const count = btn.dataset.subCount || '';
      const sTitle = (btn.dataset && btn.dataset.seriesTitle) || 'this';
      const moreLabel = 'View ' + count + ' more in \u2018' + sTitle + '\u2019 Series';
      btn.innerHTML = isHidden
        ? '<span class="series-expand-icon">➖</span> <span class="series-expand-text">Minimize series</span>'
        : '<span class="series-expand-icon">➕</span> <span class="series-expand-text">' + escapeHtml(moreLabel) + '</span>';
    }
    if (isHidden) {
      try { if (typeof devUpgradeCards === 'function') devUpgradeCards(drawer); } catch (e) {}
    }
  }

  function onToggleClassicSearch(checked) {
    useClassicSearch = !!checked;

    const advCheckbox = document.getElementById('advPhoneticsToggle');
    if (advCheckbox) {
      advCheckbox.checked = !useClassicSearch;
      const phonLabel = document.getElementById('advPhoneticsToggleLabel');
      if (phonLabel) phonLabel.textContent = advCheckbox.checked ? 'On' : 'Off';
    }
    if (activeAdvancedFilters) {
      activeAdvancedFilters.enablePhonetics = !useClassicSearch;
    }

    const newUrl = new URL(window.location.href);
    if (useClassicSearch) {
      newUrl.searchParams.set('exact', '1');
    } else {
      newUrl.searchParams.delete('exact');
    }
    history.pushState(history.state || {}, '', newUrl.toString());

    if (currentSearchQuery || (activeAdvancedFilters && Object.values(activeAdvancedFilters).some(Boolean))) {
      executeLiveSearch(currentSearchQuery, {
        ...activeAdvancedFilters,
        enablePhonetics: !useClassicSearch
      });
    }
  }

  function toggleClassicInfoTooltip(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const tip = document.getElementById('classicSearchTooltip');
    if (!tip) return;
    const isShown = tip.style.display !== 'none';
    tip.style.display = isShown ? 'none' : 'block';
  }

  function hideClassicInfoTooltip(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const tip = document.getElementById('classicSearchTooltip');
    if (tip) tip.style.display = 'none';
  }

  document.addEventListener('click', function(e) {
    const tip = document.getElementById('classicSearchTooltip');
    if (tip && tip.style.display !== 'none') {
      const btn = document.querySelector('.classic-info-btn');
      if (!tip.contains(e.target) && (!btn || !btn.contains(e.target))) {
        tip.style.display = 'none';
      }
    }
  });

  function onToggleStackSeries(checked) {
    stackSeriesEnabled = !!checked;
    renderCurrentSearchResults();
  }

  // ROADMAP §5.4: client-side twin of the edge fuzzy engine (used for
  // as-you-type chips; post-search strips come from /api/search didYouMean).
  function clientLevenshtein(a, b) {
    const s = String(a || '').toLowerCase();
    const t = String(b || '').toLowerCase();
    const m = s.length, n = t.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const d = [];
    for (let i = 0; i <= m; i++) { d.push([i]); for (let j = 1; j <= n; j++) d[i].push(0); }
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
          v = Math.min(v, d[i - 2][j - 2] + 1);
        }
        d[i][j] = v;
      }
    }
    return d[m][n];
  }

  function clientFuzzySuggest(query, limit) {
    const q = String(query || '').trim().toLowerCase();
    limit = limit || 5;
    if (q.length < 2 || typeof autocompleteCache === 'undefined' || !autocompleteCache) return [];
    const pools = [
      ['teacher', autocompleteCache.teachers || []],
      ['topic', autocompleteCache.categories || []],
      ['venue', autocompleteCache.venues || []]
    ];
    const out = [];
    const seen = new Set();
    for (const pair of pools) {
      const type = pair[0];
      for (const c of pair[1]) {
        const name = typeof c === 'string' ? c : (c && c.name);
        if (!name) continue;
        if (String(name).trim().toLowerCase() === q) continue;
        const norm = String(name).replace(/^(rabbi|rav|dr|doctor|prof|dayan|maran|chacham|harav|reb|mrs|ms|mr)\\.?[\\s]+/i, '').toLowerCase().trim();
        if (!norm || seen.has(type + '|' + norm)) continue;
        const targets = [norm].concat(norm.split(/\\s+/).filter(w => w.length >= 3));
        let best = Infinity;
        for (const target of targets) {
          if ((target.indexOf(q) !== -1 && q.length >= 3) ||
              (q.indexOf(target) !== -1 && target.length >= q.length * 0.6)) { best = 0; break; }
          const probe = target.length > q.length ? target.slice(0, q.length) : target;
          const dist = clientLevenshtein(q, probe);
          if (dist < best) best = dist;
          if (best === 1) break;
        }
        const gate = Math.min(2, Math.floor(Math.max(q.length, 4) * 0.25) + 1);
        if (q.length <= 3 && best > 0) continue;
        if (best <= gate) {
          seen.add(type + '|' + norm);
          out.push({ text: String(name), type: type, id: (c && c.id) ? String(c.id) : '', distance: best, count: (c && c.count) || 0 });
        }
      }
    }
    // Compact synset twin (mirrors edge SYNSETS variants) so concept typos
    // get as-you-type chips too — "same engine" on both surfaces (§5.4).
    if (q.length > 3) {
      const synPairs = [
        ['shabbat', 'shabbat'], ['shabbos', 'shabbat'], ['shabos', 'shabbat'],
        ['sukkah', 'sukkah'], ['sukka', 'sukkah'], ['succah', 'sukkah'], ['succa', 'sukkah'],
        ['chanukah', 'chanukah'], ['hanukkah', 'chanukah'], ['chanuka', 'chanukah'],
        ['teshuvah', 'teshuvah'], ['teshuva', 'teshuvah'], ['tshuva', 'teshuvah'],
        ['pesach', 'pesach'], ['passover', 'pesach'],
        ['muktzah', 'muktzah'], ['muktza', 'muktzah'],
        ['kashrus', 'kashrus'], ['kashrut', 'kashrus'], ['kosher', 'kashrus'],
        ['tefillah', 'tefillah'], ['tefila', 'tefillah'], ['tefillos', 'tefillah'],
        ['brachos', 'brachos'], ['berachos', 'brachos'], ['bracha', 'brachos'], ['beracha', 'brachos'],
        ['motzoei', 'motzoei'], ['motzei', 'motzoei'], ['motsai', 'motzoei'],
        ['gemara', 'gemara'], ['gemora', 'gemara'], ['talmud', 'gemara'], ['shas', 'gemara'],
        ['tanach', 'tanach'], ['tanakh', 'tanach'], ['bible', 'tanach'],
        ['torah', 'torah'], ['tora', 'torah'], ['chumash', 'torah'], ['pentateuch', 'torah'],
        ['nach', 'nach'], ['mishna', 'mishna'], ['mishnah', 'mishna'],
        ['midrash', 'midrash'], ['medrash', 'midrash'], ['aggadah', 'midrash'],
        ['aggada', 'midrash'], ['agada', 'midrash'], ['midrashim', 'midrash'],
        ['halacha', 'halacha'], ['halakha', 'halacha'], ['halachos', 'halacha'],
        ['halachot', 'halacha'], ['talmod', 'gemara'], ['shass', 'gemara'],
        ['chumosh', 'torah'], ['mishnayos', 'mishna'], ['mishnayot', 'mishna'],
        ['nack', 'nach'], ['hebrew bible', 'tanach'], ['five books', 'torah']
      ];
      for (const pair of synPairs) {
        const dist = clientLevenshtein(q, pair[0]);
        if (dist <= 2 && !seen.has('topic|' + pair[0])) {
          seen.add('topic|' + pair[0]);
          out.push({ text: pair[1], type: 'topic', id: '', distance: dist, count: 0 });
          break;
        }
      }
    }
    out.sort((a, b) => (a.distance - b.distance) || ((b.count || 0) - (a.count || 0)));
    return out.slice(0, limit);
  }

  function renderDidYouMeanStrip(suggestions) {
    const chips = suggestions.map(s =>
      '<button type="button" class="did-you-mean-chip" data-text="' + encodeURIComponent(s.text) + '"' +
      ' onclick="applyDidYouMean(decodeURIComponent(this.getAttribute(\\'data-text\\')))"' +
      ' title="' + escapeHtml(s.type) + '">' + escapeHtml(s.text) + '</button>'
    ).join('');
    return '<div class="did-you-mean-strip"><span>🔍 Did you mean:</span>' + chips + '</div>';
  }

  function applyDidYouMean(text) {
    if (!text) return;
    searchInput.value = text;
    if (clearSearchBtn) clearSearchBtn.style.display = 'block';
    closeSearchPreview();
    doSearch();
  }

  function renderCurrentSearchResults() {
    const grid = document.getElementById('searchResultsGrid');
    if (!grid) return;
    // Zero-hit state (e.g. SSR reload): still restore the disclaimer +
    // did-you-mean strips from hydrated state.
    if ((!currentRecentDocs || currentRecentDocs.length === 0) && (!currentSearchDocs || currentSearchDocs.length === 0)) {
      let eHtml = '';
      if (currentQueryResolution && currentQueryResolution.display) {
        eHtml += '<div class="did-you-mean-strip resolution-note"><span>🔍 Showing results for &quot;' +
          escapeHtml(currentQueryResolution.display) + '&quot; — you searched &quot;' +
          escapeHtml(currentQueryResolution.original) + '&quot;.</span></div>';
      }
      if (currentDidYouMean && currentDidYouMean.length > 0) {
        eHtml += renderDidYouMeanStrip(currentDidYouMean);
      }
      if (eHtml) {
        eHtml += '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No shiurim found matching these criteria. Try adjusting your filters or search keywords.</div>';
        grid.innerHTML = eHtml;
      }
      return;
    }

    const terms = getActiveSearchTerms();
    // Chronological sorts render in server order: any client re-ranking
    // would silently undo newest/oldest.
    const chronoSort = currentFilterParams.sort === 'newest' || currentFilterParams.sort === 'oldest';
    function renderList(docs) {
      if (chronoSort) {
        return docs.map(d => renderDocToCard(d)).join('');
      }
      if (stackSeriesEnabled) {
        const grouped = groupAndRankDocs(docs, terms, currentSearchQuery);
        return grouped.map(renderGroupItem).join('');
      }
      const unstacked = [...docs].sort((a, b) => {
        const sa = computeRelevanceScore(a, terms, currentSearchQuery);
        const sb = computeRelevanceScore(b, terms, currentSearchQuery);
        if (sb !== sa) return sb - sa;
        const da = a.shiurdate || a.shiurdatesubmitted || '';
        const db = b.shiurdate || b.shiurdatesubmitted || '';
        return db.localeCompare(da);
      });
      return unstacked.map(d => renderDocToCard(d)).join('');
    }

    let html = '';
    // "Showing results for X (you searched Y)" shown only when the query
    // was rewritten (no speaker auto-resolution anymore).
    if (currentQueryResolution && currentQueryResolution.display) {
      html += '<div class="did-you-mean-strip resolution-note"><span>🔍 Showing results for &quot;' +
        escapeHtml(currentQueryResolution.display) + '&quot; — you searched &quot;' +
        escapeHtml(currentQueryResolution.original) + '&quot;.</span></div>';
    }
    // Did-you-mean strip always goes ON TOP when suggestions exist,
    // whether zero hits or a thin (<10) result set.

    // Speaker view (OG yutorah style): Most Recent 6 + Top Lectures.
    const isSpeakerView = currentFilterParams && currentFilterParams.speakerView;
    if (isSpeakerView && currentSearchDocs && currentSearchDocs.length > 0) {
      const docKey = d => String(d.shiurID || d.shiurid || d.id || '');
      const docDate = d => String(d.shiurdate || d.shiurdatesubmitted || d.shiurDate || d.shiurDateSubmitted || '');
      const docPop = d => (parseInt(d.shiurvisitsnum, 10) || 0) + (parseInt(d.shiurdownloadsnum, 10) || 0);
      if (!currentSpeakerViewCache) {
        const byDate = [...currentSearchDocs].sort((a, b) => docDate(b).localeCompare(docDate(a)));
        const recent6 = byDate.slice(0, 6);
        const recentIds = new Set(recent6.map(docKey).filter(Boolean));
        const byPop = [...currentSearchDocs].filter(d => { const k = docKey(d); return k && !recentIds.has(k); }).sort((a,b)=>docPop(b)-docPop(a));
        const top10 = byPop.slice(0, 10);
        const shownIds = new Set([...recent6, ...top10].map(docKey).filter(Boolean));
        const rest = currentSearchDocs.filter(d => { const k = docKey(d); return !k || !shownIds.has(k); });
        currentSpeakerViewCache = { recent6, top10, rest };
      }
      const { recent6, top10, rest } = currentSpeakerViewCache;
      if (currentDidYouMean && currentDidYouMean.length) html += renderDidYouMeanStrip(currentDidYouMean);
      if (recent6.length) { html += '<div class="search-results-subheading"><span>🆕</span><span>Most Recent</span></div>'; html += renderList(recent6); }
      if (top10.length) { html += '<div class="search-results-subheading"><span>🏆</span><span>Top Lectures</span></div>'; html += renderList(top10); }
      if (rest.length) { html += '<div class="search-results-subheading"><span>📚</span><span>All Shiurim</span></div>'; html += renderList(rest); }
      grid.innerHTML = html;
      grid.classList.toggle('explain-matches-active', showMatchReasons);
      try { if (typeof devUpgradeCards === 'function') devUpgradeCards(grid); } catch(e){}
      return;
    }

    // Recent Results rail: fixed top-3 freshest, no expansion control.
    const visibleRecent = (currentRecentDocs || []).slice(0, 3);
    if (visibleRecent.length > 0) {
      const recentTotal = recentNumFound || currentRecentDocs.length;
      html += '<div class="search-results-subheading"><span>🕒</span><span>Recent Results</span>' +
        '<span class="sub-count">' + recentTotal.toLocaleString() + ' matching</span></div>';
      html += renderList(visibleRecent);
    }

    // 🎯 Relevance sub-section (own separate Load More).
    if (currentSearchDocs && currentSearchDocs.length > 0) {
      if (visibleRecent.length > 0) {
        html += '<div class="search-results-subheading"><span>🎯</span><span>Most Relevant Results</span></div>';
      }
      html += renderList(currentSearchDocs);
    }

    // Did-you-mean strip goes ON TOP whenever suggestions exist —
    // zero hits or thin result sets alike.
    if (currentDidYouMean && currentDidYouMean.length > 0) {
      const strip = renderDidYouMeanStrip(currentDidYouMean);
      const firstSection = html.indexOf('<div class="search-results-subheading"');
      html = firstSection >= 0
        ? html.slice(0, firstSection) + strip + html.slice(firstSection)
        : strip + html;
    }

    grid.innerHTML = html;
    grid.classList.toggle('explain-matches-active', showMatchReasons);
    // Live-search path: drawer sub-cards and fresh cards get dev buttons +
    // progress immediately (retrofit is idempotent).
    try { if (typeof devUpgradeCards === 'function') devUpgradeCards(grid); } catch (e) {}
  }

  function goHome(e) {
    if (e) e.preventDefault();

    if (hasAudio || isCurrentShiurArticle) {
      minimizePlayer();
    }

    const searchSec = document.getElementById('searchResultsSection');
    if (searchSec) searchSec.style.display = 'none';
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';

    if (searchInput) {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
    }

    const collSec = document.getElementById('collectionsSection');
    if (collSec) collSec.style.display = 'block';

    const moreSpeaker = document.getElementById('moreFromSpeakerSection');
    if (moreSpeaker) moreSpeaker.style.display = 'none';
    const moreCat = document.getElementById('moreFromCategorySection');
    if (moreCat) moreCat.style.display = 'none';

    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    newUrl.search = '';
    history.pushState({}, '', newUrl.toString());

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleBioCollapse() {
    const text = document.getElementById('bioText');
    const btn = document.getElementById('bioToggleBtn');
    if (!text || !btn) return;
    const isCollapsed = text.classList.contains('collapsed');
    if (isCollapsed) {
      text.classList.remove('collapsed');
      btn.textContent = 'Show Less ▲';
    } else {
      text.classList.add('collapsed');
      btn.textContent = 'Read More ▼';
    }
  }

  function formatBioHtml(raw) {
    if (!raw) return '';
    var nl = String.fromCharCode(10);
    return String(raw)
      .split('<p>').join(nl + nl)
      .split('<P>').join(nl + nl)
      .split('<br>').join(nl)
      .split('<br/>').join(nl)
      .split('<br />').join(nl)
      .split(nl)
      .map(function(line) { return line.trim(); })
      .filter(function(line) { return line.length > 0; })
      .map(function(line) { return '<p>' + escapeHtml(line) + '</p>'; })
      .join('');
  }

  async function loadTeacherBio(teacherId, teacherName) {
    const banner = document.getElementById('bioBanner');
    const textEl = document.getElementById('bioText');
    const titleEl = document.getElementById('bioTitle');
    const subEl = document.getElementById('bioSubtitle');
    const avatarEl = document.getElementById('bioAvatar');
    const toggleBtn = document.getElementById('bioToggleBtn');
    if (!banner || !teacherId) return;

    try {
      const res = await fetch('/api/teacher?id=' + encodeURIComponent(teacherId));
      if (!res.ok) {
        banner.style.display = 'none';
        return;
      }
      const data = await res.json();
      const bio = data.teacherBio || '';
      const name = data.teacherFullName || teacherName || '';
      const position = data.teacherTitle || data.teacherPosition || (data.teacherShiurimNumber ? data.teacherShiurimNumber + ' shiurim on YUTorah' : '');
      const photo = data.teacherPhotoURL_lp || data.teacherPhotoURL || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';

      if (!bio && !position) {
        banner.style.display = 'none';
        return;
      }

      titleEl.textContent = name;
      subEl.textContent = position;
      avatarEl.src = photo;

      if (bio) {
        textEl.innerHTML = formatBioHtml(bio);
        textEl.className = 'bio-text collapsed';
        toggleBtn.style.display = 'inline-flex';
        toggleBtn.textContent = 'Read More ▼';
      } else {
        textEl.innerHTML = '';
        toggleBtn.style.display = 'none';
      }

      banner.style.display = 'block';
    } catch (e) {
      console.warn('Failed to load teacher bio:', e);
      banner.style.display = 'none';
    }
  }

  async function loadVenueDescription(locationId, locationName) {
    const banner = document.getElementById('bioBanner');
    const textEl = document.getElementById('bioText');
    const titleEl = document.getElementById('bioTitle');
    const subEl = document.getElementById('bioSubtitle');
    const avatarEl = document.getElementById('bioAvatar');
    const toggleBtn = document.getElementById('bioToggleBtn');
    if (!banner || !locationId) return;

    try {
      const res = await fetch('/api/venue?id=' + encodeURIComponent(locationId));
      if (!res.ok) {
        banner.style.display = 'none';
        return;
      }
      const data = await res.json();
      const desc = data.locationDescription || '';
      const name = data.locationName || locationName || '';
      const shiurimCount = data.locationShiurimNumber ? (data.locationShiurimNumber + ' shiurim recorded here') : '';
      const photo = data.locationPhotoURL || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';

      if (!desc && !shiurimCount) {
        banner.style.display = 'none';
        return;
      }

      titleEl.textContent = name;
      subEl.textContent = shiurimCount;
      avatarEl.src = photo;

      if (desc) {
        textEl.innerHTML = formatBioHtml(desc);
        textEl.className = 'bio-text collapsed';
        toggleBtn.style.display = 'inline-flex';
        toggleBtn.textContent = 'Read More ▼';
      } else {
        textEl.innerHTML = '';
        toggleBtn.style.display = 'none';
      }

      banner.style.display = 'block';
    } catch (e) {
      console.warn('Failed to load venue description:', e);
      banner.style.display = 'none';
    }
  }

  function searchFor(term) {
    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    searchInput.value = term;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch(term);
    scrollToSearchResults();
  }

  function filterByTeacher(teacherId, teacherName) {
    if (hasAudio) {
      minimizePlayer();
    }
    loadTeacherBio(teacherId, teacherName);
    searchInput.value = teacherName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      teacherId: teacherId,
      speakerView: true,
      label: 'Shiurim by ' + teacherName
    });
    scrollToSearchResults();
  }

  function filterByLocation(locationId, locationName) {
    if (hasAudio) {
      minimizePlayer();
    }
    loadVenueDescription(locationId, locationName);
    searchInput.value = locationName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      locationId: locationId,
      label: 'Shiurim at ' + locationName
    });
    scrollToSearchResults();
  }

  function filterByCategory(subCategoryId, categoryName) {
    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    searchInput.value = categoryName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      subCategoryId: subCategoryId,
      label: 'Shiurim in ' + categoryName
    });
    scrollToSearchResults();
  }

  function filterBySeries(seriesId, seriesName) {
    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    searchInput.value = seriesName;
    clearSearchBtn.style.display = 'block';
    executeLiveSearch('', {
      seriesId: seriesId,
      label: 'Series: ' + seriesName
    });
    scrollToSearchResults();
  }

  function isPlayerCardInViewport() {
    const playerCard = document.getElementById('playerCard');
    if (!playerCard || playerCard.style.display === 'none') return false;
    const rect = playerCard.getBoundingClientRect();
    const header = document.getElementById('mainHeader');
    const isPurim = document.body.classList.contains('is-purim-theme');
    const topBoundary = (header && !isPurim) ? header.getBoundingClientRect().bottom : 0;
    const bottomBoundary = (header && isPurim) ? header.getBoundingClientRect().top : (window.innerHeight || document.documentElement.clientHeight);

    return rect.bottom > topBoundary && rect.top < bottomBoundary;
  }

  let scrollCheckScheduled = false;
  function handleScrollAutoMiniPlayer() {
    if (!hasAudio || isManuallyMinimized || Date.now() < isExpandingUntil) return;
    const visible = isPlayerCardInViewport();
    const miniPlayer = document.getElementById('miniPlayer');
    if (!miniPlayer) return;

    if (!visible) {
      if (!miniPlayer.classList.contains('visible')) {
        miniPlayer.classList.add('visible');
        document.body.classList.add('mini-player-active');
      }
    } else {
      if (miniPlayer.classList.contains('visible')) {
        miniPlayer.classList.remove('visible');
        document.body.classList.remove('mini-player-active');
      }
    }
  }

  function scheduleScrollAutoMiniPlayer() {
    if (scrollCheckScheduled) return;
    scrollCheckScheduled = true;
    requestAnimationFrame(() => {
      handleScrollAutoMiniPlayer();
      scrollCheckScheduled = false;
    });
  }

  function minimizePlayer() {
    if (!hasAudio && !isCurrentShiurArticle) return;
    isManuallyMinimized = true;
    const playerCard = document.getElementById('playerCard');
    const miniPlayer = document.getElementById('miniPlayer');
    if (playerCard) playerCard.style.display = 'none';
    if (miniPlayer) {
      const miniProgressTrack = document.getElementById('miniProgressTrack');
      const miniPlayBtn = document.getElementById('miniPlayBtn');
      const miniTime = document.getElementById('miniTime');
      const skipBtns = miniPlayer.querySelectorAll('.skip-btn');
      if (isCurrentShiurArticle) {
        if (miniProgressTrack) miniProgressTrack.style.display = 'none';
        if (miniPlayBtn) miniPlayBtn.style.display = 'none';
        skipBtns.forEach(b => b.style.display = 'none');
        if (miniTime) miniTime.textContent = '📄 Reading';
      } else {
        if (miniProgressTrack) miniProgressTrack.style.display = 'block';
        if (miniPlayBtn) miniPlayBtn.style.display = 'block';
        skipBtns.forEach(b => b.style.display = 'block');
      }
      miniPlayer.classList.add('visible');
    }
    document.body.classList.add('mini-player-active');

    const searchSection = document.getElementById('searchResultsSection');
    const collSection = document.getElementById('collectionsSection');
    if (collSection) {
      collSection.style.display = 'block';
    }
    if (searchSection && collSection && searchSection.style.display === 'none' && collSection.style.display === 'none') {
      collSection.style.display = 'block';
    }
  }

  function expandPlayer() {
    isManuallyMinimized = false;
    isExpandingUntil = Date.now() + 800;
    const playerCard = document.getElementById('playerCard');
    const miniPlayer = document.getElementById('miniPlayer');
    if (playerCard) {
      playerCard.style.display = 'block';
      playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (miniPlayer) miniPlayer.classList.remove('visible');
    document.body.classList.remove('mini-player-active');
  }

  function closeMiniPlayer() {
    if (audio) audio.pause();
    hasAudio = false;
    isCurrentShiurArticle = false;
    currentArticlePdf = '';
    isManuallyMinimized = false;
    currentShiurId = '';
    const miniPlayer = document.getElementById('miniPlayer');
    if (miniPlayer) miniPlayer.classList.remove('visible');
    document.body.classList.remove('mini-player-active');
    const playerCard = document.getElementById('playerCard');
    if (playerCard) playerCard.style.display = 'none';
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    newUrl.search = '';
    history.pushState({}, '', newUrl.toString());
  }

  function handleMiniPlayerClick(e) {
    if (e.target.closest('button') || e.target.closest('.mini-progress-track')) return;
    expandPlayer();
  }

  function seekMiniProgress(e) {
    if (!audio.duration) return;
    const track = document.getElementById('miniProgressTrack');
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    updateUrlTimestamp(true);
  }

  // Autocomplete Metadata Cache
  let isFetchingAutocomplete = false;

  async function loadAutocompleteMeta() {
    if (autocompleteCache) return autocompleteCache;
    if (autocompleteData) return autocompleteData;
    if (isFetchingAutocomplete) return null;
    isFetchingAutocomplete = true;
    try {
      const res = await fetch('/api/autocomplete-meta');
      if (res.ok) {
        autocompleteData = await res.json();
        autocompleteCache = autocompleteData;
        try { window.autocompleteCache = autocompleteData; } catch (e) {}
      }
    } catch(e) {
      console.error('Failed to load autocomplete metadata:', e);
    } finally {
      isFetchingAutocomplete = false;
    }
    return autocompleteData;
  }

  // Active Advanced Filter State (Multi-Entity Supported)
  let activeAdvancedFilters = {
    keywords: '',
    teachers: [], // [{ id, name }]
    categories: [], // [{ id, name }]
    locations: [], // [{ id, name }]
    series: [], // [{ id, name }]
    minDuration: '',
    maxDuration: '',
    durationLabel: '',
    year: '',
    yearLabel: '',
    mediaType: 'all',
    mediaTypeLabel: '',
    enablePhonetics: true
  };

  // Temp editing state while modal is open
  let modalTempFilters = {
    teachers: [],
    categories: [],
    locations: [],
    series: []
  };

  function openAdvancedModal() {
    const modal = document.getElementById('advancedSearchModal');
    if (!modal) return;

    // Clone current active filters into temp editing state
    modalTempFilters.teachers = [...(activeAdvancedFilters.teachers || [])];
    modalTempFilters.categories = [...(activeAdvancedFilters.categories || [])];
    modalTempFilters.locations = [...(activeAdvancedFilters.locations || [])];
    modalTempFilters.series = [...(activeAdvancedFilters.series || [])];

    document.getElementById('advKeywords').value = activeAdvancedFilters.keywords || '';
    document.getElementById('advYearSelect').value = activeAdvancedFilters.year || '';
    // datetime-local needs a full "YYYY-MM-DDTHH:MM": pad date-only values
    // (e.g. from quick presets) so the round trip survives Apply.
    function padDateTime(v) {
      if (!v) return '';
      return v.length === 10 ? v + 'T00:00' : v;
    }
    const advFrom = document.getElementById('advFromDateTime');
    if (advFrom) advFrom.value = padDateTime(activeAdvancedFilters.fromDate || '');
    const advTo = document.getElementById('advToDateTime');
    if (advTo) advTo.value = padDateTime(activeAdvancedFilters.toDate || '');
    const phonToggle = document.getElementById('advPhoneticsToggle');
    if (phonToggle) {
      phonToggle.checked = activeAdvancedFilters.enablePhonetics !== false;
      const phonLabel = document.getElementById('advPhoneticsToggleLabel');
      if (phonLabel) {
        phonLabel.textContent = phonToggle.checked ? 'On' : 'Off';
      }
    }

    // Render chips in modal comboboxes
    renderComboboxChips('teacher');
    renderComboboxChips('category');
    renderComboboxChips('location');
    renderComboboxChips('series');

    // Set duration buttons
    const minD = activeAdvancedFilters.minDuration;
    const maxD = activeAdvancedFilters.maxDuration;
    const btns = document.querySelectorAll('.duration-preset-btn');
    btns.forEach(b => {
      const bMin = b.getAttribute('data-min') || '';
      const bMax = b.getAttribute('data-max') || '';
      if (String(bMin) === String(minD || '') && String(bMax) === String(maxD || '')) {
        b.classList.add('selected');
      } else {
        b.classList.remove('selected');
      }
    });

    // Set media format buttons
    const curMedia = activeAdvancedFilters.mediaType || 'all';
    const mediaBtns = document.querySelectorAll('.media-preset-btn');
    mediaBtns.forEach(b => {
      const bMedia = b.getAttribute('data-media') || 'all';
      if (bMedia === curMedia) {
        b.classList.add('selected');
      } else {
        b.classList.remove('selected');
      }
    });
    const mediaHint = document.getElementById('mediaTypeHint');
    if (mediaHint) {
      if (curMedia === 'audio') mediaHint.textContent = 'Audio Only';
      else if (curMedia === 'article') mediaHint.textContent = 'Articles Only';
      else mediaHint.textContent = 'Audio & Articles';
    }

    modal.classList.add('open');
    loadAutocompleteMeta(); // Preload data in background
    document.getElementById('advKeywords').focus();
  }

  function closeAdvancedModal() {
    const modal = document.getElementById('advancedSearchModal');
    if (modal) modal.classList.remove('open');
    closeAllAutocompleteDropdowns();
  }

  function handleAdvancedBackdropClick(e) {
    if (e.target.id === 'advancedSearchModal') {
      closeAdvancedModal();
    }
  }

  function closeAllAutocompleteDropdowns() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => {
      d.style.display = 'none';
      d.innerHTML = '';
    });
  }

  // Multi-Select Combobox & Token Management
  function renderComboboxChips(type) {
    let containerId = '';
    let inputId = '';
    let list = [];

    if (type === 'teacher') {
      containerId = 'teacherChipsContainer';
      inputId = 'advTeacherInput';
      list = modalTempFilters.teachers;
    } else if (type === 'category') {
      containerId = 'categoryChipsContainer';
      inputId = 'advCategoryInput';
      list = modalTempFilters.categories;
    } else if (type === 'location') {
      containerId = 'locationChipsContainer';
      inputId = 'advLocationInput';
      list = modalTempFilters.locations;
    } else if (type === 'series') {
      containerId = 'seriesChipsContainer';
      inputId = 'advSeriesInput';
      list = modalTempFilters.series;
    }

    const container = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    if (!container || !input) return;

    // Remove existing tokens
    container.querySelectorAll('.combobox-token').forEach(el => el.remove());

    // Insert tokens before input
    list.forEach((item, index) => {
      const token = document.createElement('span');
      token.className = 'combobox-token';
      token.innerHTML = '<span>' + escapeHtml(item.name) + '</span><button type="button" class="token-remove-btn" onclick="removeComboboxToken(&quot;' + type + '&quot;, ' + index + ')" title="Remove">✕</button>';
      container.insertBefore(token, input);
    });
  }

  function removeComboboxToken(type, index) {
    if (type === 'teacher') {
      modalTempFilters.teachers.splice(index, 1);
    } else if (type === 'category') {
      modalTempFilters.categories.splice(index, 1);
    } else if (type === 'location') {
      modalTempFilters.locations.splice(index, 1);
    } else if (type === 'series') {
      modalTempFilters.series.splice(index, 1);
    }
    renderComboboxChips(type);
  }

  function addComboboxToken(type, id, name) {
    if (type === 'teacher') {
      // Selecting a new teacher replaces the previous teacher so old one doesn't get stuck!
      modalTempFilters.teachers = [{ id: String(id), name: String(name) }];
      const input = document.getElementById('advTeacherInput');
      if (input) {
        input.value = '';
      }
      closeAllAutocompleteDropdowns();
      renderComboboxChips('teacher');
      return;
    }

    let list = [];
    if (type === 'category') list = modalTempFilters.categories;
    else if (type === 'location') list = modalTempFilters.locations;
    else if (type === 'series') list = modalTempFilters.series;

    if (!list.some(item => String(item.id) === String(id))) {
      list.push({ id: String(id), name: String(name) });
    }

    // Clear input and close dropdown
    let inputId = type === 'category' ? 'advCategoryInput' : (type === 'location' ? 'advLocationInput' : 'advSeriesInput');
    let input = document.getElementById(inputId);
    if (input) {
      input.value = '';
      input.focus();
    }
    closeAllAutocompleteDropdowns();
    renderComboboxChips(type);
  }

  // Setup Live Filtering Autocomplete for Teacher, Category, Venue, Series inputs
  // Facet-count cache: filter-signature -> { at, counts } (45s TTL).
  // Counts make dropdowns reflect already-selected filters (dynamic facets).
  // The dropdown's OWN type is excluded from the query so its options show
  // counts under the other active filters (never self-zeroed).
  const facetCountCache = { sig: '', at: 0, counts: null };
  async function loadFacetCounts(skipType) {
    const kwInput = document.getElementById('advKeywords');
    const kw = ((kwInput && kwInput.value) || (activeAdvancedFilters && activeAdvancedFilters.keywords) || '').trim();
    const parts = ['q:' + kw,
      't:' + (modalTempFilters.teachers || []).map(t => t.id).sort().join(','),
      'c:' + (modalTempFilters.categories || []).map(t => t.id).sort().join(','),
      'l:' + (modalTempFilters.locations || []).map(t => t.id).sort().join(','),
      's:' + (modalTempFilters.series || []).map(t => t.id).sort().join(','),
      'skip:' + (skipType || '')];
    const sig = parts.join('|');
    if (facetCountCache.counts && facetCountCache.sig === sig && Date.now() - facetCountCache.at < 45000) {
      return facetCountCache.counts;
    }
    try {
      const q = new URLSearchParams();
      if (kw) q.set('q', kw);
      if (skipType !== 'teacher') (modalTempFilters.teachers || []).forEach(t => q.append('teacherId', t.id));
      if (skipType !== 'category') (modalTempFilters.categories || []).forEach(t => q.append('subCategoryId', t.id));
      if (skipType !== 'location') (modalTempFilters.locations || []).forEach(t => q.append('locationId', t.id));
      if (skipType !== 'series') (modalTempFilters.series || []).forEach(t => q.append('seriesId', t.id));
      const res = await fetch('/api/facets?' + q.toString());
      if (!res.ok) return null;
      const body = await res.json();
      facetCountCache.sig = sig;
      facetCountCache.at = Date.now();
      facetCountCache.counts = body;
      return body;
    } catch (e) {
      return null;
    }
  }

  function setupAutocompleteInput(type, inputId, dropdownId, dataKey) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    let debounceTimer = null;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const val = input.value.trim().toLowerCase();
        if (val.length < 1) {
          dropdown.style.display = 'none';
          dropdown.innerHTML = '';
          return;
        }

        const meta = await loadAutocompleteMeta();
        if (!meta || !meta[dataKey]) return;

        const items = meta[dataKey];
        // Strip titles/honorifics from query if searching teachers
        const cleanVal = type === 'teacher' ? val.replace(/^(rabbi|rav|dr\.|dr|mrs\.|mrs|rebbetzin|r')\s+/i, '').trim() : val;
        
        // Exclude already-selected options of this type (no duplicates).
        const selectedIds = new Set(((type === 'teacher' ? modalTempFilters.teachers
          : type === 'category' ? modalTempFilters.categories
          : type === 'location' ? modalTempFilters.locations
          : modalTempFilters.series) || []).map(t => String(t.id)));
        // Dynamic facet counts for the OTHER active filters.
        const facetKey = type === 'teacher' ? 'teachers' : type === 'category' ? 'categories'
          : type === 'location' ? 'venues' : 'series';
        let facetById = null;
        try {
          const fc = await loadFacetCounts(type);
          if (fc && Array.isArray(fc[facetKey])) {
            facetById = {};
            for (const f of fc[facetKey]) facetById[String(f.id)] = f.count;
          }
        } catch (e) {}

        let matches = [];
        for (const item of items) {
          if (selectedIds.has(String(item.id))) continue;
          const itemName = (item.name || '').toLowerCase();
          const cleanItemName = type === 'teacher' ? itemName.replace(/^(rabbi|rav|dr\.|dr|mrs\.|mrs|rebbetzin|r')\s+/i, '') : itemName;
          if (itemName.includes(val) || cleanItemName.includes(cleanVal)) {
            const m = { id: item.id, name: item.name, count: item.count };
            if (facetById && Object.prototype.hasOwnProperty.call(facetById, String(item.id))) {
              m.count = facetById[String(item.id)];
              m.faceted = true;
            }
            matches.push(m);
            if (matches.length >= 25) break;
          }
        }

        if (matches.length === 0) {
          dropdown.innerHTML = '<div style="padding:10px 12px; font-size:12.5px; color:var(--text-muted); text-align:center;">No matching ' + type + 's found</div>';
          dropdown.style.display = 'block';
          return;
        }

        dropdown.innerHTML = matches.map(m => {
          const countBadge = m.count ? ('<span class="item-count-badge">' + Number(m.count).toLocaleString() + '</span>') : '';
          return '<div class="autocomplete-item" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.name) + '">' +
            '<span>' + escapeHtml(m.name) + '</span>' + countBadge +
          '</div>';
        }).join('');
        dropdown.style.display = 'block';
      }, 100);
    });

    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.autocomplete-item');
      if (!item) return;
      const id = item.getAttribute('data-id');
      const name = item.getAttribute('data-name');
      if (id && name) {
        addComboboxToken(type, id, name);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        const val = input.value.trim().toLowerCase();
        // Try to find exact match in current dropdown or full list
        const firstMatch = dropdown.querySelector('.autocomplete-item');
        if (firstMatch) {
          const id = firstMatch.getAttribute('data-id');
          const name = firstMatch.getAttribute('data-name');
          if (id && name) {
            addComboboxToken(type, id, name);
            input.value = '';
            dropdown.style.display = 'none';
            dropdown.innerHTML = '';
            return;
          }
        }
        // Fallback: check full list for exact match
        loadAutocompleteMeta().then(meta => {
          if (!meta || !meta[dataKey]) return;
          const match = meta[dataKey].find(item => (item.name || '').toLowerCase() === val);
          if (match) {
            addComboboxToken(type, match.id, match.name);
            input.value = '';
            dropdown.style.display = 'none';
            dropdown.innerHTML = '';
          }
        });
        return;
      }
      if (e.key === 'Escape') {
        dropdown.style.display = 'none';
      } else if (e.key === 'Backspace' && input.value === '') {
        // Backspace on empty input removes last chip
        let list = type === 'teacher' ? modalTempFilters.teachers : (type === 'category' ? modalTempFilters.categories : (type === 'location' ? modalTempFilters.locations : modalTempFilters.series));
        if (list.length > 0) {
          list.pop();
          renderComboboxChips(type);
        }
      }
    });
  }

  // Initialize listeners on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    // PWA Service Worker Registration
    try {
      if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function() {});
      }
    } catch (e) {}
    try { if (typeof bootAuth === 'function') bootAuth(); } catch (e) {}
    try {
      const hero = document.getElementById('heroSlideshow');
      if (hero) {
        heroRestart();
        const heroPause = () => { try { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } } catch (e) {} };
        const heroResume = () => { if (!heroTimer) heroRestart(); };
        hero.addEventListener('mouseenter', heroPause);
        hero.addEventListener('mouseleave', heroResume);
        hero.addEventListener('focusin', heroPause);
        hero.addEventListener('focusout', heroResume);
        // Swipe between slides (mobile): horizontal swipe navigates.
        let heroTouchX = null;
        hero.addEventListener('touchstart', e => {
          if (e.touches && e.touches.length === 1) heroTouchX = e.touches[0].clientX;
        }, { passive: true });
        hero.addEventListener('touchend', e => {
          if (heroTouchX === null || !e.changedTouches || e.changedTouches.length === 0) return;
          const dx = e.changedTouches[0].clientX - heroTouchX;
          heroTouchX = null;
          if (Math.abs(dx) < 40) return;
          if (dx < 0) heroGo(1);
          else heroGo(-1);
        }, { passive: true });
      }
    } catch (e) {}
    // Direct-link /<id> loads: fetch lecture data so the metadata box
    // (incl. the Uploaded row) hydrates without a card click.
    try {
      if (typeof currentShiurId !== 'undefined' && currentShiurId &&
          document.getElementById('shiurMetadataBox')) {
        fetch('/sidebar/lecturedata?shiurID=' + encodeURIComponent(String(currentShiurId))).then(r => {
          if (!r.ok) return null;
          return r.json();
        }).then(data => {
          if (!data || String(currentShiurId) !== String(data.shiurID || '')) return;
          lastLectureData = data;
          renderMetadataBox(data);
          const rawD = data.shiurDateFormatted || data.shiurDate || '';
          fetchUploadDate(String(currentShiurId), rawD ? formatShiurDate(rawD) : '');
        }).catch(() => {});
      } else {
        const mm = document.getElementById('shiurMeta');
        if (typeof currentShiurId !== 'undefined' && currentShiurId && mm && mm.textContent) {
          const parts = mm.textContent.split('·');
          const gdate = parts.length > 1 ? parts[parts.length - 1].trim() : '';
          if (gdate) fetchUploadDate(String(currentShiurId), gdate);
        }
      }
    } catch (e) {}
    try { if (typeof renderSaveIconPicker === 'function') renderSaveIconPicker(); } catch (e) {}
    // Restore cards/rows view (mobile forced to cards, desktop to stored-or-rows).
    try {
      setCardView(defaultCardView(), false);
    } catch (e) {}
    // Enforce mobile-cards when crossing the breakpoint after load.
    try {
      let lastMobile = isMobileView();
      window.addEventListener('resize', () => {
        try {
          const m = isMobileView();
          if (m !== lastMobile) {
            lastMobile = m;
            setCardView(defaultCardView(), false);
          }
        } catch (e) {}
      });
    } catch (e) {}
    // Hydrate date bounds from the URL (?fromDate=&toDate=&dateQuick=) so a
    // reload or shared link keeps the active date filter + chip state.
    try {
      const bp = new URLSearchParams(window.location.search);
      const bFrom = bp.get('fromDate') || '';
      const bTo = bp.get('toDate') || '';
      const bQ = bp.get('dateQuick') || '';
      if (bFrom || bTo) {
        activeAdvancedFilters.fromDate = bFrom;
        activeAdvancedFilters.toDate = bTo;
        const okQuick = (bQ === 'today' || bQ === 'yesterday' || bQ === 'week' || bQ === 'month') ? bQ : '';
        activeAdvancedFilters.dateQuick = okQuick;
        const qLabels = { today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month' };
        activeAdvancedFilters.dateQuickLabel = qLabels[okQuick] || '';
        if (!okQuick) {
          activeAdvancedFilters.dateRangeLabel = (bFrom || '…') + ' → ' + (bTo || '…');
        }
      }
      const bSort = bp.get('sort') || '';
      if (bSort === 'newest' || bSort === 'oldest') {
        activeAdvancedFilters.sort = bSort;
      }
    } catch (e) {}
    // SSR search grids render flat relevance only: re-render on boot so the
    // Recent rail + resolution disclaimer + did-you-mean strip materialize
    // from hydrated state (including zero-hit states).
    try {
      const hasState = (currentSearchDocs && currentSearchDocs.length > 0) ||
        (currentRecentDocs && currentRecentDocs.length > 0) ||
        (currentDidYouMean && currentDidYouMean.length > 0) ||
        (currentQueryResolution && currentQueryResolution.display);
      if (hasState &&
          document.getElementById('searchResultsSection') &&
          document.getElementById('searchResultsSection').style.display !== 'none') {
        renderCurrentSearchResults();
      }
    } catch (e) {}
    // ROADMAP §8.1: Dev Mode persists across reloads once unlocked.
    try {
      if (localStorage.getItem('yutorah_dev_mode') === 'true' && !isDevMode) {
        activateDevMode();
      }
    } catch (e) {}
    // Playlist deep-links (?tab=playlists&pl=...) survive reload + sharing.
    // A shiur-search URL always wins (one view per URL; searches clear pl*).
    try {
      const bootParams = new URLSearchParams(window.location.search);
      if (!bootParams.get('search') && readPlaylistUrlState()) {
        switchCollection('playlists');
        if (activeDevPlaylistId === 'public') plSearchPublic();
      }
    } catch (e) {}
    setupAutocompleteInput('teacher', 'advTeacherInput', 'teacherDropdown', 'teachers');
    setupAutocompleteInput('category', 'advCategoryInput', 'categoryDropdown', 'categories');
    setupAutocompleteInput('location', 'advLocationInput', 'locationDropdown', 'venues');
    setupAutocompleteInput('series', 'advSeriesInput', 'seriesDropdown', 'series');

    // Close autocomplete dropdowns on document click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.autocomplete-combobox')) {
        closeAllAutocompleteDropdowns();
      }
    });
  });

  function setDurationPreset(btn, min, max) {
    document.querySelectorAll('.duration-preset-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const hint = document.getElementById('durationHint');
    if (hint) {
      hint.textContent = btn.textContent;
    }
  }

  function setMediaTypePreset(btn, type) {
    document.querySelectorAll('.media-preset-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const hint = document.getElementById('mediaTypeHint');
    if (hint) {
      if (type === 'audio') hint.textContent = 'Audio Only';
      else if (type === 'article') hint.textContent = 'Articles Only';
      else hint.textContent = 'Audio & Articles';
    }
  }

  function resetAdvancedFilters() {
    document.getElementById('advKeywords').value = '';
    document.getElementById('advYearSelect').value = '';
    const rFrom = document.getElementById('advFromDateTime');
    if (rFrom) rFrom.value = '';
    const rTo = document.getElementById('advToDateTime');
    if (rTo) rTo.value = '';
    // Clear the in-memory quick preset too, or Reset→Apply would resurrect
    // a highlighted chip with no date bounds behind it.
    activeAdvancedFilters.dateQuick = '';
    activeAdvancedFilters.dateQuickLabel = '';
    syncDateQuickChips();
    const phonToggle = document.getElementById('advPhoneticsToggle');
    if (phonToggle) {
      phonToggle.checked = true;
      const phonLabel = document.getElementById('advPhoneticsToggleLabel');
      if (phonLabel) phonLabel.textContent = 'On';
    }
    modalTempFilters.teachers = [];
    modalTempFilters.categories = [];
    modalTempFilters.locations = [];
    modalTempFilters.series = [];
    renderComboboxChips('teacher');
    renderComboboxChips('category');
    renderComboboxChips('location');
    renderComboboxChips('series');
    const defBtn = document.querySelector('.duration-preset-btn[data-min=""][data-max=""]');
    if (defBtn) setDurationPreset(defBtn, '', '');
    const defMediaBtn = document.querySelector('.media-preset-btn[data-media="all"]');
    if (defMediaBtn) setMediaTypePreset(defMediaBtn, 'all');
  }

  function applyAdvancedFilters() {
    const kw = document.getElementById('advKeywords').value.trim();
    const selDurationBtn = document.querySelector('.duration-preset-btn.selected');
    const minDuration = selDurationBtn ? selDurationBtn.getAttribute('data-min') : '';
    const maxDuration = selDurationBtn ? selDurationBtn.getAttribute('data-max') : '';
    const durationLabel = selDurationBtn && selDurationBtn.getAttribute('data-min') !== '' ? selDurationBtn.textContent : '';

    const selMediaBtn = document.querySelector('.media-preset-btn.selected');
    const mediaType = selMediaBtn ? (selMediaBtn.getAttribute('data-media') || 'all') : 'all';
    let mediaTypeLabel = '';
    if (mediaType === 'audio') mediaTypeLabel = 'Audio Only';
    else if (mediaType === 'article') mediaTypeLabel = 'Articles Only';

    const yearSelect = document.getElementById('advYearSelect');
    const year = yearSelect.value;
    const yearLabel = yearSelect.selectedIndex > 0 ? yearSelect.options[yearSelect.selectedIndex].text : '';
    const phonToggle = document.getElementById('advPhoneticsToggle');
    const enablePhonetics = phonToggle ? phonToggle.checked : true;

    // Custom date-time range (mutually exclusive with Year + quick presets:
    // whichever is set wins, the others are cleared).
    const fromDtEl = document.getElementById('advFromDateTime');
    const toDtEl = document.getElementById('advToDateTime');
    const fromDate = fromDtEl ? fromDtEl.value.trim() : '';
    const toDate = toDtEl ? toDtEl.value.trim() : '';
    let finalYear = year;
    let finalYearLabel = yearLabel;
    let dateQuick = activeAdvancedFilters.dateQuick || '';
    let dateQuickLabel = activeAdvancedFilters.dateQuickLabel || '';
    let dateRangeLabel = '';
    function fmtDt(v) {
      if (!v) return '…';
      const parts = v.split('T');
      return parts[0] + (parts[1] ? ' ' + parts[1] : '');
    }
    if (fromDate || toDate) {
      finalYear = '';
      finalYearLabel = '';
      dateQuick = '';
      dateQuickLabel = '';
      dateRangeLabel = fmtDt(fromDate) + ' → ' + fmtDt(toDate);
    } else if (finalYear) {
      dateQuick = '';
      dateQuickLabel = '';
    }

    activeAdvancedFilters = {
      keywords: kw,
      teachers: [...modalTempFilters.teachers],
      categories: [...modalTempFilters.categories],
      locations: [...modalTempFilters.locations],
      series: [...modalTempFilters.series],
      minDuration,
      maxDuration,
      durationLabel,
      year: finalYear,
      yearLabel: finalYearLabel,
      fromDate,
      toDate,
      dateQuick,
      dateQuickLabel,
      dateRangeLabel,
      sort: activeAdvancedFilters.sort === 'newest' || activeAdvancedFilters.sort === 'oldest' ? activeAdvancedFilters.sort : 'relevance',
      mediaType,
      mediaTypeLabel,
      enablePhonetics
    };

    closeAdvancedModal();

    // Keep search bar clean: only populate searchInput if actual keywords were entered
    if (kw) {
      searchInput.value = kw;
    } else {
      searchInput.value = '';
    }

    // Execute multi-criteria search
    executeLiveSearch(kw, {
      ...activeAdvancedFilters,
      fromAdvancedModal: true
    });
  }

  function renderActiveFilterPills() {
    const bar = document.getElementById('activeFiltersBar');
    if (!bar) return;

    const pills = [];

    // Teacher pills
    (activeAdvancedFilters.teachers || []).forEach((t, idx) => {
      pills.push('<span class="active-filter-pill">👤 ' + escapeHtml(t.name) + ' <button type="button" onclick="removeFilterItem(&quot;teachers&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Category pills
    (activeAdvancedFilters.categories || []).forEach((c, idx) => {
      pills.push('<span class="active-filter-pill">🏷️ ' + escapeHtml(c.name) + ' <button type="button" onclick="removeFilterItem(&quot;categories&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Location pills
    (activeAdvancedFilters.locations || []).forEach((l, idx) => {
      pills.push('<span class="active-filter-pill">📍 ' + escapeHtml(l.name) + ' <button type="button" onclick="removeFilterItem(&quot;locations&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Series pills
    (activeAdvancedFilters.series || []).forEach((s, idx) => {
      pills.push('<span class="active-filter-pill">📚 ' + escapeHtml(s.name) + ' <button type="button" onclick="removeFilterItem(&quot;series&quot;, ' + idx + ')" title="Remove">✕</button></span>');
    });

    // Duration pill
    if (activeAdvancedFilters.minDuration || activeAdvancedFilters.maxDuration) {
      pills.push('<span class="active-filter-pill">⏱ ' + escapeHtml(activeAdvancedFilters.durationLabel) + ' <button type="button" onclick="removeSingleFilter(&quot;duration&quot;)" title="Remove">✕</button></span>');
    }

    // Year pill
    if (activeAdvancedFilters.year) {
      pills.push('<span class="active-filter-pill">📅 ' + escapeHtml(activeAdvancedFilters.yearLabel || activeAdvancedFilters.year) + ' <button type="button" onclick="removeSingleFilter(&quot;year&quot;)" title="Remove">✕</button></span>');
    }

    // Date-range pill (quick preset label or custom from→to label)
    if (activeAdvancedFilters.fromDate || activeAdvancedFilters.toDate) {
      const dl = activeAdvancedFilters.dateQuickLabel || activeAdvancedFilters.dateRangeLabel ||
        ((activeAdvancedFilters.fromDate || '…') + ' → ' + (activeAdvancedFilters.toDate || '…'));
      pills.push('<span class="active-filter-pill">🗓️ ' + escapeHtml(dl) + ' <button type="button" onclick="removeSingleFilter(&quot;dateRange&quot;)" title="Remove">✕</button></span>');
    }

    // Media Format pill
    if (activeAdvancedFilters.mediaType && activeAdvancedFilters.mediaType !== 'all') {
      const icon = activeAdvancedFilters.mediaType === 'audio' ? '🎙️' : '📄';
      const label = activeAdvancedFilters.mediaType === 'audio' ? 'Audio Only' : 'Articles Only';
      pills.push('<span class="active-filter-pill">' + icon + ' ' + escapeHtml(label) + ' <button type="button" onclick="removeSingleFilter(&quot;mediaType&quot;)" title="Remove">✕</button></span>');
    }

    // Transliteration indicator badge in pills bar
    if (activeAdvancedFilters.enablePhonetics === false) {
      pills.push('<span class="active-filter-pill" style="background:rgba(239, 68, 68, 0.1); border-color:rgba(239, 68, 68, 0.3); color:#dc2626;">🔤 Exact Match (Phonetics Off) <button type="button" onclick="toggleFilterPhonetics(true)" title="Turn Phonetics Back On">✕</button></span>');
    }

    if (pills.length > 0) {
      bar.innerHTML = '<span style="font-size:12px; font-weight:700; color:var(--text-muted);">Active Filters:</span> ' + pills.join('') + ' <button type="button" class="modal-reset-btn" style="padding:2px 8px; font-size:12px;" onclick="clearAllFilters()">Clear All</button>';
      bar.style.display = 'flex';
      const advBtn = document.getElementById('advancedSearchBtn');
      if (advBtn) advBtn.classList.add('active');
    } else {
      bar.innerHTML = '';
      bar.style.display = 'none';
      const advBtn = document.getElementById('advancedSearchBtn');
      if (advBtn) advBtn.classList.remove('active');
    }
    syncDateQuickChips();
  }

  function toggleFilterPhonetics(enable) {
    activeAdvancedFilters.enablePhonetics = Boolean(enable);
    executeLiveSearch(activeAdvancedFilters.keywords || searchInput.value.trim(), { ...activeAdvancedFilters });
  }

  function removeFilterItem(listKey, index) {
    if (Array.isArray(activeAdvancedFilters[listKey])) {
      activeAdvancedFilters[listKey].splice(index, 1);
    }
    if (!activeAdvancedFilters.keywords) {
      searchInput.value = '';
    }
    executeLiveSearch(activeAdvancedFilters.keywords || '', { ...activeAdvancedFilters });
  }

  function removeSingleFilter(type) {
    if (type === 'duration') {
      activeAdvancedFilters.minDuration = '';
      activeAdvancedFilters.maxDuration = '';
      activeAdvancedFilters.durationLabel = '';
    } else if (type === 'year') {
      activeAdvancedFilters.year = '';
      activeAdvancedFilters.yearLabel = '';
    } else if (type === 'mediaType') {
      activeAdvancedFilters.mediaType = 'all';
      activeAdvancedFilters.mediaTypeLabel = '';
    } else if (type === 'dateRange') {
      activeAdvancedFilters.fromDate = '';
      activeAdvancedFilters.toDate = '';
      activeAdvancedFilters.dateQuick = '';
      activeAdvancedFilters.dateQuickLabel = '';
      activeAdvancedFilters.dateRangeLabel = '';
      syncDateQuickChips();
    }
    executeLiveSearch(activeAdvancedFilters.keywords || '', { ...activeAdvancedFilters });
  }

  function fmtLocalDate(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // Quick date presets (Today / Yesterday / This Week / This Month).
  // Mutually exclusive with Year select and the custom date-time range:
  // setting one clears the others so filters can never empty-intersect.
  function setDateQuick(preset, btn) {
    document.querySelectorAll('.date-quick-chip[data-preset]').forEach(b => b.classList.toggle('selected', b === btn || (b.dataset && b.dataset.preset === preset)));
    const now = new Date();
    const today = fmtLocalDate(now);
    let from = '';
    let to = '';
    let label = '';
    if (preset === 'today') {
      from = today;
      to = today;
      label = 'Today';
    } else if (preset === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      from = fmtLocalDate(y);
      to = from;
      label = 'Yesterday';
    } else if (preset === 'week') {
      const s = new Date(now);
      s.setDate(s.getDate() - s.getDay());
      from = fmtLocalDate(s);
      to = today;
      label = 'This Week';
    } else if (preset === 'month') {
      from = today.slice(0, 7) + '-01';
      to = today;
      label = 'This Month';
    }
    activeAdvancedFilters.fromDate = from;
    activeAdvancedFilters.toDate = to;
    activeAdvancedFilters.dateQuick = preset === 'all' ? '' : preset;
    activeAdvancedFilters.dateQuickLabel = label;
    activeAdvancedFilters.dateRangeLabel = '';
    if (preset !== 'all') {
      activeAdvancedFilters.year = '';
      activeAdvancedFilters.yearLabel = '';
      const ys = document.getElementById('advYearSelect');
      if (ys) ys.value = '';
      const fdt = document.getElementById('advFromDateTime');
      if (fdt) fdt.value = '';
      const tdt = document.getElementById('advToDateTime');
      if (tdt) tdt.value = '';
    }
    executeLiveSearch(activeAdvancedFilters.keywords || searchInput.value.trim(), { ...activeAdvancedFilters });
  }

  function syncDateQuickChips() {
    const cur = (activeAdvancedFilters && activeAdvancedFilters.dateQuick) || 'all';
    document.querySelectorAll('.date-quick-chip[data-preset]').forEach(b => {
      b.classList.toggle('selected', (b.dataset && b.dataset.preset) === cur);
    });
    const sort = (activeAdvancedFilters && activeAdvancedFilters.sort) || 'relevance';
    document.querySelectorAll('.date-quick-chip[data-sort]').forEach(b => {
      b.classList.toggle('selected', (b.dataset && b.dataset.sort) === sort);
    });
  }

  // Result sort: relevance (default) / newest-first / oldest-first.
  // Orthogonal to the date bounds above; the Recent rail only shows
  // under relevance (chronological sorts need no rail).
  function setResultSort(sort, btn) {
    const s = (sort === 'newest' || sort === 'oldest') ? sort : 'relevance';
    activeAdvancedFilters.sort = s;
    syncDateQuickChips();
    executeLiveSearch(activeAdvancedFilters.keywords || searchInput.value.trim(), { ...activeAdvancedFilters });
  }

  function clearAllFilters() {
    activeAdvancedFilters = {
      keywords: '',
      teachers: [],
      categories: [],
      locations: [],
      series: [],
      minDuration: '',
      maxDuration: '',
      durationLabel: '',
      year: '',
      yearLabel: '',
      fromDate: '',
      toDate: '',
      dateQuick: '',
      dateQuickLabel: '',
      dateRangeLabel: '',
      mediaType: 'all',
      mediaTypeLabel: '',
      enablePhonetics: true
    };
    syncDateQuickChips();
    executeLiveSearch(searchInput.value.trim(), {});
  }

  function scrollToSearchResults() {
    const resSection = document.getElementById('searchResultsSection');
    if (!resSection) return;
    if (resSection.style.display === 'none') {
      resSection.style.display = 'block';
    }
    const whenRow = document.getElementById('dateQuickRow');
    const targetEl = whenRow || resSection;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const header = document.getElementById('mainHeader');
        const headerHeight = header ? header.offsetHeight : 52;
        const rect = targetEl.getBoundingClientRect();
        const currentScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
        // Align so the "When" line is the first thing visible at the top of the screen right below the fixed header
        const targetY = currentScrollY + rect.top - headerHeight - 6;
        window.scrollTo({
          top: Math.max(0, Math.round(targetY)),
          behavior: 'smooth'
        });
      });
    });
  }
  window.scrollToSearchResults = scrollToSearchResults;

  function handleHeroSlideClick(event, el) {
    if (!el) return;

    if (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
        return;
      }
    }

    const slideHref = el.getAttribute('data-slide-href') || el.getAttribute('href') || '';
    const slideName = (el.getAttribute('data-slide-name') || '').trim();

    // 1. If external link (e.g. target="_blank" or external domain), allow native navigation
    if (el.getAttribute('target') === '_blank' || (slideHref && (slideHref.indexOf('http://') === 0 || slideHref.indexOf('https://') === 0) && !slideHref.startsWith(window.location.origin))) {
      return;
    }

    // 2. If the slide links to a specific shiur ID (e.g. /1187437 or /lectures/1187437)
    let directShiurId = null;
    if (slideHref && slideHref !== '#') {
      try {
        const parsedUrl = new URL(slideHref, window.location.origin);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 1 && /^[0-9]+$/.test(pathSegments[0])) {
          directShiurId = pathSegments[0];
        } else if (pathSegments.length === 2 && pathSegments[0] === 'lectures' && /^[0-9]+$/.test(pathSegments[1])) {
          directShiurId = pathSegments[1];
        }
      } catch (e) {
        const parts = slideHref.split('?')[0].split('/').filter(Boolean);
        const lastPart = parts.pop() || '';
        if (/^[0-9]+$/.test(lastPart)) {
          directShiurId = lastPart;
        }
      }
    }

    if (directShiurId) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      const resSection = document.getElementById('searchResultsSection');
      if (resSection) resSection.style.display = 'none';
      const colSection = document.getElementById('collectionsSection');
      if (colSection) colSection.style.display = 'block';

      if (typeof playShiurById === 'function') {
        playShiurById(event, directShiurId);
      } else {
        window.location.href = '/' + directShiurId;
      }
      return;
    }

    // 3. Otherwise, for search-based slides, execute live search and scroll to search results
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (hasAudio) {
      minimizePlayer();
    }
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';

    let query = '';
    const extra = {};

    if (slideHref && slideHref !== '#') {
      try {
        const parsedUrl = new URL(slideHref, window.location.origin);
        const sParam = parsedUrl.searchParams.get('search') || parsedUrl.searchParams.get('s') || '';
        const catParam = parsedUrl.searchParams.get('subCategoryId') || parsedUrl.searchParams.get('category') || '';
        const teacherParam = parsedUrl.searchParams.get('teacherId') || parsedUrl.searchParams.get('teacher') || '';
        const seriesParam = parsedUrl.searchParams.get('seriesId') || parsedUrl.searchParams.get('series') || '';
        const sortParam = parsedUrl.searchParams.get('sort');

        if (catParam) {
          extra.subCategoryId = catParam.replace(/^0,/, '');
        }
        if (teacherParam) {
          extra.teacherId = teacherParam;
        }
        if (seriesParam) {
          extra.seriesId = seriesParam;
        }
        if (sortParam) {
          extra.sort = sortParam;
        }

        if (sParam) {
          query = sParam;
        }
      } catch (e) {
        query = slideName;
      }
    }

    if (!query && !extra.subCategoryId && !extra.teacherId && !extra.seriesId) {
      query = slideName;
    }

    if (slideName) {
      extra.label = slideName;
    }

    if (searchInput) {
      searchInput.value = query || slideName || '';
    }
    if (clearSearchBtn) {
      clearSearchBtn.style.display = searchInput && searchInput.value ? 'block' : 'none';
    }

    executeLiveSearch(query, extra);
    scrollToSearchResults();
  }
  window.handleHeroSlideClick = handleHeroSlideClick;

  async function executeLiveSearch(query, extraParams = {}) {
    currentSearchQuery = query;
    currentFilterParams = extraParams;
    currentSearchPage = 1;
    currentRecentDocs = [];
    recentNumFound = 0;
    currentDidYouMean = [];
    currentQueryResolution = null;
    currentSpeakerViewCache = null;
    currentLoadedDocsCount = 0;
    totalSearchResults = 0;
    isLoadingMore = false;

    // Minimize player if loaded so search results take center stage
    if (hasAudio) {
      minimizePlayer();
    }
    const moreSpeaker = document.getElementById('moreFromSpeakerSection');
    if (moreSpeaker) moreSpeaker.style.display = 'none';
    const moreCat = document.getElementById('moreFromCategorySection');
    if (moreCat) moreCat.style.display = 'none';

    // Show results container, hide collections
    document.getElementById('collectionsSection').style.display = 'none';
    const resSection = document.getElementById('searchResultsSection');
    resSection.style.display = 'block';
    if (!extraParams.skipScroll) {
      scrollToSearchResults();
    }

    const spinner = document.getElementById('searchSpinner');
    const grid = document.getElementById('searchResultsGrid');
    const label = document.getElementById('searchResultsLabel');
    const loadMoreBox = document.getElementById('loadMoreContainer');
    const phoneticBanner = document.getElementById('phoneticNoticeBanner');

    renderActiveFilterPills();

    const displayLabel = extraParams.label || (query ? ('Searching for "' + query + '"...') : 'Filtering shiurim...');
    label.textContent = displayLabel;
    grid.innerHTML = '';
    spinner.style.display = 'block';
    loadMoreBox.style.display = 'none';
    if (phoneticBanner) phoneticBanner.style.display = 'none';

    // Update browser URL without reload (search + date bounds survive reload)
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    if (query) newUrl.searchParams.set('search', query);
    else newUrl.searchParams.delete('search');
    if (extraParams.fromDate) newUrl.searchParams.set('fromDate', extraParams.fromDate);
    else newUrl.searchParams.delete('fromDate');
    if (extraParams.toDate) newUrl.searchParams.set('toDate', extraParams.toDate);
    else newUrl.searchParams.delete('toDate');
    if (extraParams.dateQuick) newUrl.searchParams.set('dateQuick', extraParams.dateQuick);
    else newUrl.searchParams.delete('dateQuick');
    if (extraParams.sort && extraParams.sort !== 'relevance') newUrl.searchParams.set('sort', extraParams.sort);
    else newUrl.searchParams.delete('sort');
    newUrl.searchParams.delete('shiurId');
    newUrl.searchParams.delete('id');
    // Shiur search is its own view: drop playlist deep-link keys (one view
    // per URL; in-memory playlist state is untouched and re-syncs on return).
    try { clearPlaylistUrlKeys(newUrl); } catch (e) {}
    history.pushState({ search: query, ...extraParams }, '', newUrl.toString());

    if (currentSearchAbort) {
      currentSearchAbort.abort();
    }
    currentSearchAbort = new AbortController();

    let apiUrl = '/api/search?q=' + encodeURIComponent(query || '') + '&start=1';

    // Build multi-valued teacher, category, and location params
    const teachersList = extraParams.teachers || (extraParams.teacherId ? [{ id: extraParams.teacherId }] : []);
    teachersList.forEach(t => {
      apiUrl += '&teacherId=' + encodeURIComponent(t.id);
    });

    const categoriesList = extraParams.categories || (extraParams.subCategoryId ? [{ id: extraParams.subCategoryId }] : []);
    categoriesList.forEach(c => {
      apiUrl += '&subCategoryId=' + encodeURIComponent(c.id);
    });

    const locationsList = extraParams.locations || (extraParams.locationId ? [{ id: extraParams.locationId }] : []);
    locationsList.forEach(l => {
      apiUrl += '&locationId=' + encodeURIComponent(l.id);
    });

    const seriesList = extraParams.series || (extraParams.seriesId ? [{ id: extraParams.seriesId }] : []);
    seriesList.forEach(s => {
      apiUrl += '&seriesId=' + encodeURIComponent(s.id);
    });

    if (extraParams.minDuration) apiUrl += '&minDuration=' + encodeURIComponent(extraParams.minDuration);
    if (extraParams.maxDuration) apiUrl += '&maxDuration=' + encodeURIComponent(extraParams.maxDuration);
    if (extraParams.year) apiUrl += '&year=' + encodeURIComponent(extraParams.year);
    if (extraParams.fromDate) apiUrl += '&fromDate=' + encodeURIComponent(extraParams.fromDate);
    if (extraParams.toDate) apiUrl += '&toDate=' + encodeURIComponent(extraParams.toDate);
    if (extraParams.sort && extraParams.sort !== 'relevance') apiUrl += '&sort=' + encodeURIComponent(extraParams.sort);
    if (extraParams.mediaType && extraParams.mediaType !== 'all') {
      apiUrl += '&mediaType=' + encodeURIComponent(extraParams.mediaType);
    }
    if (extraParams.enablePhonetics === false || (extraParams.enablePhonetics === undefined && useClassicSearch)) {
      apiUrl += '&exact=1';
    }

    try {
      const res = await fetch(apiUrl, {
        signal: currentSearchAbort.signal
      });
      const data = await res.json();
      spinner.style.display = 'none';

      const docs = data?.response?.docs || [];
      // Relevance pages are the paginated unit (full 30); the Recent rail
      // sits on top and is counted separately via recentNumFound.
      currentRecentDocs = data?.response?.recentDocs || [];
      totalSearchResults = data?.response?.numFound || docs.length;
      currentLoadedDocsCount = docs.length;
      recentNumFound = data?.response?.recentNumFound || 0;
      currentDidYouMean = data?.didYouMean || [];
      currentQueryResolution = data?.queryResolution || null;

      // Handle Phonetic Expansion Notice
      if (data?.phoneticExpansion && !useClassicSearch) {
        currentPhoneticTokens = data.phoneticExpansion.tokens || [];
        const original = data.phoneticExpansion.original;
        if (phoneticBanner && currentPhoneticTokens.length > 1) {
          const tagsHtml = currentPhoneticTokens.slice(0, 8).map(t => '<span class="phonetic-tag">' + escapeHtml(t) + '</span>').join('');
          phoneticBanner.innerHTML = '<div><span>✨ Phonetic Equivalence included synonyms:</span> <div class="phonetic-notice-tags">' + tagsHtml + '</div></div>' +
            '<span style="font-size:11px; opacity:0.8;">Ashkenazic &amp; Sephardic variations searched</span>';
          phoneticBanner.style.display = 'flex';
        }
      } else {
        currentPhoneticTokens = [];
        if (phoneticBanner) phoneticBanner.style.display = 'none';
      }

      const resultsTitle = extraParams.label
        ? (extraParams.label + ' (' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ')')
        : ('Showing ' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ' results' + (query ? ' for "' + query + '"' : ''));
      label.textContent = resultsTitle;

      if (docs.length === 0 && currentRecentDocs.length === 0) {
        currentSearchDocs = [];
        currentDidYouMean = currentDidYouMean.length > 0 ? currentDidYouMean : clientFuzzySuggest(query, 5);
        let emptyHtml = '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No shiurim found matching these criteria. Try adjusting your filters or search keywords.</div>';
        if (currentDidYouMean.length > 0) {
          emptyHtml = renderDidYouMeanStrip(currentDidYouMean) + emptyHtml;
        }
        if (currentQueryResolution && currentQueryResolution.display) {
          emptyHtml = '<div class="did-you-mean-strip resolution-note"><span>🔍 Showing results for &quot;' +
            escapeHtml(currentQueryResolution.display) + '&quot; — you searched &quot;' +
            escapeHtml(currentQueryResolution.original) + '&quot;.</span></div>' + emptyHtml;
        }
        grid.innerHTML = emptyHtml;
        loadMoreBox.style.display = 'none';
        if (!extraParams.skipScroll) {
          scrollToSearchResults();
        }
        return;
      }
      // Keep the server's weak-hit suggestions: renderCurrentSearchResults
      // appends the strip BELOW the list when 1+ weak hits exist (§5.4).

      currentSearchDocs = docs;
      renderCurrentSearchResults();
      if (!extraParams.skipScroll) {
        scrollToSearchResults();
      }

      // Setup Load More button
      const totalInfo = document.getElementById('searchTotalInfo');
      const btn = document.getElementById('loadMoreBtn');
      const btnText = document.getElementById('loadMoreBtnText');
      const loadSpinner = document.getElementById('loadMoreSpinner');

      btn.disabled = false;
      btn.style.display = 'inline-flex';
      btnText.textContent = '🔽 Load More Results';
      loadSpinner.style.display = 'none';

      if (currentLoadedDocsCount < totalSearchResults) {
        loadMoreBox.style.display = 'block';
        totalInfo.textContent = 'Showing ' + currentLoadedDocsCount + ' of ' + totalSearchResults.toLocaleString() + ' shiurim';
      } else {
        loadMoreBox.style.display = 'none';
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      spinner.style.display = 'none';
      label.textContent = 'Error loading results';
      grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #c0392b; grid-column: 1/-1;">Failed to load search results. Please try again.</div>';
      loadMoreBox.style.display = 'none';
    }
  }

  async function loadMoreResults() {
    if (isLoadingMore || currentLoadedDocsCount >= totalSearchResults) return;
    isLoadingMore = true;

    const btn = document.getElementById('loadMoreBtn');
    const btnText = document.getElementById('loadMoreBtnText');
    const spinner = document.getElementById('loadMoreSpinner');
    const totalInfo = document.getElementById('searchTotalInfo');

    btn.disabled = true;
    btnText.textContent = 'Loading more shiurim...';
    spinner.style.display = 'inline-block';

    const nextPage = currentSearchPage + 1;

    // Chronological sorts paginate by ITEM offset (the date window treats
    // start as 1-based offset, not page); relevance paginates by page.
    const chronoMore = currentFilterParams.sort === 'newest' || currentFilterParams.sort === 'oldest';
    let apiUrl = '/api/search?q=' + encodeURIComponent(currentSearchQuery || '');
    if (chronoMore) {
      apiUrl += '&sort=' + encodeURIComponent(currentFilterParams.sort) + '&start=' + (currentLoadedDocsCount + 1) + '&rows=30';
    } else {
      apiUrl += '&page=' + nextPage + '&start=' + nextPage;
    }

    const teachersList = currentFilterParams.teachers || (currentFilterParams.teacherId ? [{ id: currentFilterParams.teacherId }] : []);
    teachersList.forEach(t => {
      apiUrl += '&teacherId=' + encodeURIComponent(t.id);
    });

    const categoriesList = currentFilterParams.categories || (currentFilterParams.subCategoryId ? [{ id: currentFilterParams.subCategoryId }] : []);
    categoriesList.forEach(c => {
      apiUrl += '&subCategoryId=' + encodeURIComponent(c.id);
    });

    const locationsList = currentFilterParams.locations || (currentFilterParams.locationId ? [{ id: currentFilterParams.locationId }] : []);
    locationsList.forEach(l => {
      apiUrl += '&locationId=' + encodeURIComponent(l.id);
    });

    const seriesList = currentFilterParams.series || (currentFilterParams.seriesId ? [{ id: currentFilterParams.seriesId }] : []);
    seriesList.forEach(s => {
      apiUrl += '&seriesId=' + encodeURIComponent(s.id);
    });

    if (currentFilterParams.minDuration) apiUrl += '&minDuration=' + encodeURIComponent(currentFilterParams.minDuration);
    if (currentFilterParams.maxDuration) apiUrl += '&maxDuration=' + encodeURIComponent(currentFilterParams.maxDuration);
    if (currentFilterParams.year) apiUrl += '&year=' + encodeURIComponent(currentFilterParams.year);
    if (currentFilterParams.fromDate) apiUrl += '&fromDate=' + encodeURIComponent(currentFilterParams.fromDate);
    if (currentFilterParams.toDate) apiUrl += '&toDate=' + encodeURIComponent(currentFilterParams.toDate);
    if (currentFilterParams.sort && currentFilterParams.sort !== 'relevance') apiUrl += '&sort=' + encodeURIComponent(currentFilterParams.sort);
    if (currentFilterParams.mediaType && currentFilterParams.mediaType !== 'all') {
      apiUrl += '&mediaType=' + encodeURIComponent(currentFilterParams.mediaType);
    }
    if (currentFilterParams.enablePhonetics === false || (currentFilterParams.enablePhonetics === undefined && useClassicSearch)) {
      apiUrl += '&exact=1';
    }

    try {
      const res = await fetch(apiUrl);
      const data = await res.json();
      const newDocs = data?.response?.docs || [];

      if (newDocs.length > 0) {
        currentSearchPage = nextPage;
        currentLoadedDocsCount += newDocs.length;
        currentSearchDocs = currentSearchDocs.concat(newDocs);
        if (currentSpeakerViewCache) currentSpeakerViewCache.rest = currentSpeakerViewCache.rest.concat(newDocs);
        renderCurrentSearchResults();

        const resultsTitle = currentFilterParams.label
          ? (currentFilterParams.label + ' (' + currentLoadedDocsCount + (totalSearchResults ? ' of ' + totalSearchResults.toLocaleString() : '') + ')')
          : ('Showing ' + currentLoadedDocsCount + ' of ' + totalSearchResults.toLocaleString() + ' results for "' + currentSearchQuery + '"');
        document.getElementById('searchResultsLabel').textContent = resultsTitle;
      }

      if (currentLoadedDocsCount >= totalSearchResults || newDocs.length === 0) {
        btn.style.display = 'none';
        totalInfo.textContent = 'All ' + currentLoadedDocsCount.toLocaleString() + ' shiurim loaded!';
      } else {
        totalInfo.textContent = 'Showing ' + currentLoadedDocsCount + ' of ' + totalSearchResults.toLocaleString() + ' shiurim';
        btn.disabled = false;
        btnText.textContent = '🔽 Load More Results';
        spinner.style.display = 'none';
      }
    } catch (err) {
      console.error('Failed to load more results:', err);
      btn.disabled = false;
      btnText.textContent = '🔽 Load More Results';
      spinner.style.display = 'none';
    } finally {
      isLoadingMore = false;
    }
  }

  // Keyboard shortcut: Escape closes modal and search preview
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openPldDropdown = document.querySelector('.pld-suggest-dropdown[style*="display: block"]');
      if (openPldDropdown) {
        openPldDropdown.style.display = 'none';
        openPldDropdown.innerHTML = '';
        return;
      }
      closeAdvancedModal();
      closeSearchPreview();
      closeConfirmModal();
      closePlaylistModal();
      closeChangelogModal();
      closeAuthMenu();
      const qp = document.getElementById('queuePopup');
      if (qp) qp.style.display = 'none';
      const npm = document.getElementById('newPlaylistModal');
      if (npm) npm.remove();
      const pld = document.getElementById('playlistDetailsModal');
      if (pld) pld.remove();
      const dnm = document.getElementById('displayNameModal');
      if (dnm) dnm.remove();
      const scm = document.getElementById('saveChoiceModal');
      if (scm) scm.remove();
    }
  });

  // Keyboard activation for span-based buttons (play badges, dev actions):
  // Enter/Space on a focused actionable span triggers its click.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target && e.target.closest ? e.target.closest('[data-kbplay], .card-mini-actions [role="button"]') : null;
    if (!t) return;
    e.preventDefault();
    t.click();
  });

  function clearSearch() {
    closeSearchPreview();
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    document.getElementById('searchResultsSection').style.display = 'none';
    document.getElementById('loadMoreContainer').style.display = 'none';
    const bioBanner = document.getElementById('bioBanner');
    if (bioBanner) bioBanner.style.display = 'none';
    const bar = document.getElementById('activeFiltersBar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
    const pNotice = document.getElementById('phoneticNoticeBanner');
    if (pNotice) pNotice.style.display = 'none';

    currentSearchDocs = [];
    currentRecentDocs = [];
    recentNumFound = 0;
    currentDidYouMean = [];
    currentQueryResolution = null;
    currentSpeakerViewCache = null;
    currentPhoneticTokens = [];
    currentSearchPage = 1;
    showMatchReasons = false;
    useClassicSearch = false;
    stackSeriesEnabled = true;
    const matchToggle = document.getElementById('toggleMatchExplain');
    if (matchToggle) matchToggle.checked = false;
    const classicToggle = document.getElementById('toggleClassicSearch');
    if (classicToggle) classicToggle.checked = false;
    const stackToggle = document.getElementById('toggleStackSeries');
    if (stackToggle) stackToggle.checked = true;
    const resGrid = document.getElementById('searchResultsGrid');
    if (resGrid) resGrid.classList.remove('explain-matches-active');

    // Reset all advanced filters so they don't silently persist
    activeAdvancedFilters = {
      keywords: '',
      teachers: [],
      categories: [],
      locations: [],
      series: [],
      minDuration: '',
      maxDuration: '',
      durationLabel: '',
      year: '',
      yearLabel: '',
      fromDate: '',
      toDate: '',
      dateQuick: '',
      dateQuickLabel: '',
      dateRangeLabel: '',
      mediaType: 'all',
      mediaTypeLabel: '',
      enablePhonetics: true
    };
    syncDateQuickChips();
    const advBtn = document.getElementById('advancedSearchBtn');
    if (advBtn) advBtn.classList.remove('active');

    // If has audio and was on a shiur page, re-expand player and show recommendations
    const playerCard = document.getElementById('playerCard');
    if (hasAudio && currentShiurId && playerCard) {
      expandPlayer();
      const moreSpeaker = document.getElementById('moreFromSpeakerSection');
      if (moreSpeaker) moreSpeaker.style.display = 'block';
      const moreCat = document.getElementById('moreFromCategorySection');
      if (moreCat) moreCat.style.display = 'block';
    } else {
      document.getElementById('collectionsSection').style.display = 'block';
    }

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.delete('search');
    newUrl.searchParams.delete('q');
    newUrl.searchParams.delete('exact');
    newUrl.searchParams.delete('classic');
    history.pushState({}, '', newUrl.toString());
  }

  function renderDocToCard(d, options = {}) {
    const id = d.shiurid || d.shiurID || d.id || '';
    // Normalize duration once: snapshots store display strings ("45 min",
    // "1h 22m") while Solr docs carry bare minutes — suffix only the latter.
    const durRaw = d.durationformatted || d.duration || '';
    const duration = durRaw ? (String(durRaw).match(/[a-z]/i) ? String(durRaw) : durRaw + ' min') : '';
    if (id && typeof devDocCache !== 'undefined') {
      devDocCache[String(id)] = {
        id: String(id),
        title: d.shiurtitle || d.shiurTitle || d.title || 'Untitled',
        speaker: d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : (d.speaker || 'YUTorah')),
        photo: d.PHOTO ? (d.PHOTO.startsWith('http') ? d.PHOTO : 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + d.PHOTO) : (d.photo || ''),
        duration: duration,
        date: d.shiurdateformatted || d.shiurDateFormatted || d.shiurdate || d.shiurDate || d.shiurdatesubmitted || d.shiurDateSubmitted || d.date || '',
        isArticle: Boolean(d.isArticle) || String(d.mediatypecategory || d.mediaTypeCategory || '').toLowerCase() === 'text'
      };
    }
    const title = d.shiurtitle || d.shiurTitle || d.title || 'Untitled';
    const speaker = d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : (d.speaker || 'YUTorah'));
    const photo = d.PHOTO ? (d.PHOTO.startsWith('http') ? d.PHOTO : 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + d.PHOTO) : (d.photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg');
    const rawDate = d.shiurdateformatted || d.shiurDateFormatted || d.shiurdate || d.shiurDate || d.shiurdatesubmitted || d.shiurDateSubmitted || d.date || '';
    const date = formatShiurDate(rawDate);
    const isNew = isShiurNew(d.shiurdatesubmitted || d.shiurDateSubmitted || rawDate);
    const newBadge = isNew ? '<span class="quick-card-new-badge">NEW</span>' : '';
    const category = (Array.isArray(d.categoryname) && d.categoryname[0]) || (Array.isArray(d.subcategoryname) && d.subcategoryname[0]) || d.category || '';

    const mediaCat = (d.mediatypecategory || d.mediaTypeCategory || '').toLowerCase();
    const urlCheck = d.shiururl || d.shiurURL || d.playerDownloadURL || d.downloadURL || '';
    const isArticle = Boolean(d.isArticle) || mediaCat === 'text' || mediaCat === 'article' || /\\.pdf(\$|\\?)/i.test(urlCheck);

    const metaParts = [];
    if (isArticle) {
      metaParts.push('📄 Article');
    } else if (duration) {
      metaParts.push('⏱ ' + escapeHtml(duration));
    }
    if (date) metaParts.push(escapeHtml(date));
    const bottomMeta = metaParts.join(' · ');

    const terms = getActiveSearchTerms();
    const displayTitle = highlightMatches(title, terms);
    const displaySpeaker = highlightMatches(speaker, terms);
    const displayCategory = category ? highlightMatches(category, terms) : '';

    const matchReasons = buildMatchReasons(d, terms);
    let matchReasonHtml = '';

    if (matchReasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        matchReasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    } else {
      let matchedVisible = [];
      if (displayTitle.includes('mark class="match-mark"')) matchedVisible.push('Title');
      if (displaySpeaker.includes('mark class="match-mark"')) matchedVisible.push('Speaker');
      if (displayCategory && displayCategory.includes('mark class="match-mark"')) matchedVisible.push('Category');

      const visibleNote = matchedVisible.length > 0
        ? 'Matched search term in ' + matchedVisible.join(' & ')
        : 'Matched via YUTorah index relevance';
      const visibleBadge = matchedVisible.length > 0 ? '✨ Direct Match' : '🎯 Solr Index';

      matchReasonHtml = '<div class="quick-card-match-reason">' +
        '<div class="match-reason-item">' +
          '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(visibleBadge) + '</span></div>' +
          '<div class="match-reason-snippet">' + escapeHtml(visibleNote) + '</div>' +
        '</div>' +
      '</div>';
    }

    const isCover = options.isCover;
    const seriesBadge = isCover
      ? '<div class="series-cover-badge">📚 Series · ' + (options.seriesCount || 'Multi-Part') + ' Shiurim</div>'
      : '';
    const coverClass = isCover ? ' is-series-cover' : '';
    // Play badge mini-plays in place; anywhere else on the card opens the
    // full player (expand + scroll), as before.
    const badgePlay = 'event.stopPropagation(); playShiurById(event, \\'' + id + '\\', true)';
    const actionBadge = isArticle
      ? '<span class="quick-play-badge" style="background:#10b981; color:#fff;">📄 Read</span>'
      : '<span class="quick-play-badge" role="button" tabindex="0" data-kbplay onclick="' + badgePlay + '">▶ Play</span>';

    return '<a href="/' + id + '" class="quick-card-link' + coverClass + '" onclick="playShiurById(event, this.dataset.id)" data-id="' + id + '">' +
      newBadge +
      seriesBadge +
      '<div class="quick-card-top">' +
        '<img class="quick-card-avatar" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(speaker) + '" loading="lazy" onerror="handleImgError(this)">' +
        '<div class="quick-card-info">' +
          '<div class="quick-card-title">' + displayTitle + '</div>' +
          '<div class="quick-card-speaker">' + displaySpeaker + '</div>' +
          (displayCategory ? '<div class="quick-card-category">' + displayCategory + '</div>' : '') +
        '</div>' +
      '</div>' +
      matchReasonHtml +
      '<div class="quick-card-bottom">' +
        '<span>' + bottomMeta + '</span>' +
        actionBadge +
      '</div>' +
      (typeof devCardActionsHtml === 'function' ? devCardActionsHtml(String(id), Boolean(options.isCover)) : '') +
      (typeof devProgressHtml === 'function' ? devProgressHtml(String(id)) : '') +
    '</a>';
  }

  function renderSeriesSubCard(sub, partNumber) {
    const id = sub.shiurid || sub.shiurID || sub.id || '';
    const title = sub.shiurtitle || sub.shiurTitle || sub.title || 'Untitled';
    const subDurRaw = sub.durationformatted || sub.duration || '';
    const duration = subDurRaw ? (String(subDurRaw).match(/[a-z]/i) ? String(subDurRaw) : subDurRaw + ' min') : '';
    const rawDate = sub.shiurdateformatted || sub.shiurDateFormatted || sub.shiurdate || sub.shiurdatesubmitted || '';
    const date = formatShiurDate(rawDate);
    const terms = getActiveSearchTerms();
    const displayTitle = highlightMatches(title, terms);

    const mediaCat = (sub.mediatypecategory || sub.mediaTypeCategory || '').toLowerCase();
    const urlCheck = sub.shiururl || sub.shiurURL || sub.playerDownloadURL || sub.downloadURL || '';
    const isArticle = mediaCat === 'text' || mediaCat === 'article' || /\\.pdf(\$|\\?)/i.test(urlCheck);

    const matchReasons = buildMatchReasons(sub, terms);
    let matchReasonHtml = '';
    if (matchReasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        matchReasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    }

    const metaParts = [];
    if (isArticle) {
      metaParts.push('📄 Article');
    } else if (duration) {
      metaParts.push('⏱ ' + escapeHtml(duration));
    }
    if (date) metaParts.push(escapeHtml(date));

    const subAction = isArticle
      ? '<span class="series-sub-play" style="background:#10b981; color:#fff;">📄 Read</span>'
      : '<span class="series-sub-play" role="button" tabindex="0" data-kbplay onclick="event.stopPropagation(); playShiurById(event, \\'' + id + '\\', true)">▶ Play</span>';

    return '<a href="/' + id + '" class="series-sub-card" onclick="playShiurById(event, this.dataset.id)" data-id="' + id + '">' +
      '<div class="series-sub-header">' +
        '<div class="series-sub-title"><span style="opacity:0.75; font-weight:700; margin-right:4px;">#' + partNumber + '</span> ' + displayTitle + '</div>' +
        subAction +
      '</div>' +
      matchReasonHtml +
      (metaParts.length > 0 ? '<div class="series-sub-meta">' + metaParts.join(' · ') + '</div>' : '') +
    '</a>';
  }

  function renderGroupItem(item) {
    if (!item.isSeries) {
      return renderDocToCard(item.doc);
    }
    const cover = item.cover;
    const subDocs = item.subDocs;
    const coverId = String(cover.shiurid || cover.shiurID || cover.id || '');
    if (coverId && typeof devSeriesCache !== 'undefined') {
      devSeriesCache[coverId] = { title: item.title || 'Series', docs: item.docs || [] };
    }
    const drawerId = 'series_drawer_' + (cover.shiurid || cover.shiurID || cover.id || '') + '_' + Math.random().toString(36).substring(2, 7);
    const coverHtml = renderDocToCard(cover, { isCover: true, seriesTitle: item.title, seriesCount: item.docs.length });
    const subCardsHtml = subDocs.map((sub, idx) => renderSeriesSubCard(sub, idx + 2)).join('');

    return '<div class="quick-card-series-group">' +
      coverHtml +
      '<button type="button" class="series-expand-btn" data-drawer-target="' + drawerId + '" data-sub-count="' + subDocs.length + '" data-series-title="' + escapeHtml(item.title || '') + '" onclick="toggleSeriesDrawer(event, this.dataset.drawerTarget)">' +
        '<span class="series-expand-icon">➕</span> <span class="series-expand-text">View ' + subDocs.length + ' more in \u2018' + escapeHtml(item.title || 'this') + '\u2019 Series</span>' +
      '</button>' +
      '<div id="' + drawerId + '" class="series-drawer" style="display: none;">' +
        subCardsHtml +
      '</div>' +
    '</div>';
  }

  // Instant Play by Shiur ID (in-page without reload)
  // Shared upload-date lookup for card plays AND direct-link loads.
  // Feeds the metadata box Uploaded row (between Date and Topics).
  var currentUploadDateStr = '';
  var currentUploadShiurId = '';
  var lastLectureData = null;
  function fetchUploadDate(id, givenDate) {
    currentUploadDateStr = '';
    currentUploadShiurId = String(id);
    try {
      fetch('/api/search?q=' + encodeURIComponent(id) + '&start=1&rows=1').then(r => {
        if (!r.ok) return null;
        return r.json();
      }).then(sdata => {
        if (!sdata || String(currentShiurId) !== String(id)) return;
        const sdocs = sdata.response ? (sdata.response.docs || []) : [];
        // Exact-ID match only: q= is full-text relevance, so a fallback
        // to sdocs[0] could stamp an unrelated shiur's upload date.
        const hit = sdocs.find(d => String(d.shiurID || d.shiurid || d.id || '') === String(id));
        if (!hit) return;
        const upRaw = hit.shiurdatesubmittedformatted || hit.shiurdatesubmitted || '';
        const upFmt = upRaw ? formatShiurDate(upRaw) : '';
        if (upFmt && upFmt !== givenDate && String(currentShiurId) === String(id)) {
          currentUploadDateStr = upFmt;
          currentUploadShiurId = String(id);
          if (lastLectureData && String(lastLectureData.shiurID || '') === String(id)) {
            renderMetadataBox(lastLectureData);
          }
        }
      }).catch(() => {});
    } catch (e) {}
  }

  async function playShiurById(e, id, stayMini) {
    if (e) e.preventDefault();
    // Text selection wins over card click: dragging to select title/speaker
    // text must not start playback.
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && String(sel.toString()).trim().length > 0) {
        sel.removeAllRanges();
        return;
      }
    } catch (err) {}

    // Same track already loaded: never restart — resume if paused,
    // otherwise drop to the mini player and keep the position.
    if (String(id) === String(currentShiurId) && hasAudio && audio) {
      try {
        if (audio.paused) {
          await audio.play();
        } else {
          minimizePlayer();
          flashToast('▶ Already playing — kept your place', false, false);
        }
      } catch (err) {}
      return;
    }

    isManuallyMinimized = false;
    if (stayMini) {
      // Card play: start in miniplayer, do not move screen
      minimizePlayer();
    } else {
      isExpandingUntil = Date.now() + 800;
      expandPlayer();
      const playerCard = document.getElementById('playerCard');
      if (playerCard) playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    currentShiurId = id;
    hasAudio = true;
    initialTimeApplied = false;

    // Reset UI while loading
    document.getElementById('shiurTitle').textContent = 'Loading shiur #' + id + '...';
    document.getElementById('shiurSpeaker').textContent = 'Fetching audio stream...';
    document.getElementById('shiurMeta').textContent = '';
    const resetUploadEl = document.getElementById('shiurUploadDate');
    if (resetUploadEl) {
      resetUploadEl.style.display = 'none';
      resetUploadEl.textContent = '';
    }
    document.getElementById('shiurMeta').textContent = '';
    document.getElementById('shiurDesc').style.display = 'none';

    const newUrl = new URL('/' + id, window.location.origin);
    if (currentPlaybackRate && currentPlaybackRate !== 1) {
      newUrl.searchParams.set('speed', currentPlaybackRate);
    }
    const curParams = new URL(window.location.href).searchParams;
    const activeTheme = curParams.get('theme') || curParams.get('mode');
    if (activeTheme) {
      const k = curParams.has('theme') ? 'theme' : 'mode';
      newUrl.searchParams.set(k, activeTheme);
    }
    // Carry playlist context onto the shiur page so reload keeps the tab,
    // filters, and search the listener came from (shareable as one link).
    try {
      ['tab', 'pl', 'plq', 'plteachers', 'plvenues', 'pltopics', 'plscope', 'plsort'].forEach(k => {
        curParams.getAll(k).forEach(v => newUrl.searchParams.append(k, v));
      });
    } catch (e) {}
    history.pushState({ shiurId: id }, '', newUrl.pathname + newUrl.search);

    try {
      const res = await fetch('/sidebar/lecturedata?shiurID=' + encodeURIComponent(id));
      if (!res.ok) throw new Error('API returned status ' + res.status);
      const data = await res.json();

      const title = data.shiurTitle || 'Untitled Shiur';
      const speaker = data.shiurTeacherFullName || (data.shiurTeachers && data.shiurTeachers[0] ? data.shiurTeachers[0].teacherFullName : 'YUTorah');
      let teacherPhoto = '';
      if (Array.isArray(data.shiurTeachers) && data.shiurTeachers.length > 0) {
        const t = data.shiurTeachers[0];
        teacherPhoto = t.teacherPhotoURL_lp || t.teacherPhotoURL_o || t.teacherPhotoURL || '';
      }
      if (!teacherPhoto) {
        teacherPhoto = data.teacherPhotoURL_lp || data.teacherPhotoURL_o || data.teacherPhotoURL || '';
      }
      if (!teacherPhoto && data.PHOTO) {
        teacherPhoto = data.PHOTO.startsWith('http') ? data.PHOTO : ('https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/' + data.PHOTO);
      }
      const photo = teacherPhoto || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
      const duration = data.shiurDuration || '';
      const rawDate = data.shiurDateFormatted || data.shiurDate || '';
      const date = formatShiurDate(rawDate);
      const meta = duration + (date ? ' · ' + date : '');
      const desc = data.shiurDescription || '';
      const audioSrc = data.playerDownloadURL || (data.shiurURL ? 'https://shiurim.yutorah.net' + data.shiurURL : '') || data.downloadURL || '';
      const dlSrc = data.downloadURL || audioSrc;

      let teacherId = '';
      if (Array.isArray(data.shiurTeachers) && data.shiurTeachers[0]) {
        teacherId = String(data.shiurTeachers[0].teacherID || data.shiurTeachers[0].id || '');
      }
      if (!teacherId && data.teacherID) {
        teacherId = String(data.teacherID);
      }
      currentSpeakerTeacherId = teacherId;
      currentSpeakerName = speaker;

      document.title = title + ' — YUTorah Enhanced';
      document.getElementById('shiurTitle').textContent = title;
      document.getElementById('shiurSpeaker').textContent = speaker;
      document.getElementById('shiurMeta').textContent = meta;
      const uploadEl = document.getElementById('shiurUploadDate');
      if (uploadEl) {
        uploadEl.style.display = 'none';
        uploadEl.textContent = '';
      }
      lastLectureData = data;

      // Upload date feeds the metadata box (between Date and Topics):
      // lightweight Solr id-lookup, applied progressively.
      fetchUploadDate(id, date);

      const img = document.getElementById('speakerImg');
      if (photo) {
        img.src = photo;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }

      const descEl = document.getElementById('shiurDesc');
      if (desc) {
        descEl.textContent = desc;
        descEl.style.display = 'block';
      } else {
        descEl.style.display = 'none';
      }

      const dlBtn = document.getElementById('dlBtn');
      if (dlSrc) {
        dlBtn.href = dlSrc;
        dlBtn.style.display = 'inline-flex';
      }

      currentShiurId = id;
      initialTimeApplied = false;
      lastUrlUpdateSec = -1;
      lastUrlUpdateTime = 0;

      // Check if this shiur is an article / text document
      const mediaCategory = (data.mediaTypeCategory || '').toLowerCase();
      const isArticle = mediaCategory === 'text' || mediaCategory === 'article' || /\\.pdf(\$|\\?)/i.test(audioSrc) || /\\.pdf(\$|\\?)/i.test(dlSrc);
      isCurrentShiurArticle = isArticle;
      currentArticlePdf = isArticle ? (audioSrc || dlSrc) : '';

      addRecentHistory({
        id: id,
        title: title,
        speaker: speaker,
        photo: photo,
        duration: duration,
        date: date,
        dateISO: rawDate || '',
        isArticle: isArticle
      });
      try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}

      // Render rich metadata immediately
      renderMetadataBox(data);

      const audioWrap = document.getElementById('audioControlsWrap');
      const articleWrap = document.getElementById('articleViewerContainer');

      const navBack = document.getElementById('playerNavBackBtn');

      if (isArticle) {
        hasAudio = false;
        if (audio && !audio.paused) {
          audio.pause();
        }
        if (audioWrap) audioWrap.style.display = 'none';
        if (articleWrap) articleWrap.style.display = 'block';
        if (navBack) {
          navBack.textContent = '← Browse Library While Reading';
        }
        if (dlBtn) {
          dlBtn.innerHTML = '⬇️ Download PDF';
        }
        loadArticlePdf(currentArticlePdf);
        return;
      }

      // Switching back to audio shiur: restore audio controls, hide article viewer
      hasAudio = true;
      if (articleWrap) articleWrap.style.display = 'none';
      if (audioWrap) audioWrap.style.display = 'block';
      if (navBack) {
        navBack.textContent = '← Browse Library While Listening';
      }
      if (dlBtn) {
        dlBtn.innerHTML = '⬇️ Download MP3';
      }

      // Check if URL or localStorage has a timestamp for this shiur
      let resumeSec = 0;
      try {
        const saved = parseFloat(localStorage.getItem('yutorah_progress_' + id));
        if (!isNaN(saved) && saved > 5) resumeSec = saved;
      } catch(e) {}

      const curUrl = new URL(window.location.href);
      const urlT = curUrl.searchParams.get('t');
      if (urlT) {
        const p = parseFloat(urlT);
        if (!isNaN(p) && p > 0) resumeSec = p;
      }

      initialTimestamp = resumeSec ? String(resumeSec) : '';

      const shiurObj = {
        id: id,
        title: title,
        speaker: speaker,
        teacherId: teacherId,
        photo: photo,
        duration: duration,
        date: date,
        meta: meta,
        desc: desc,
        audioSrc: audioSrc,
        dlSrc: dlSrc,
        resumeSec: resumeSec
      };

      currentShiurId = id;
      pendingShiur = shiurObj;

      if (currentSponsorAudio && !isPreRollDisabled()) {
        playSponsorPreRoll(shiurObj);
      } else {
        startShiurPlayback(shiurObj);
      }
    } catch (err) {
      console.error('Failed to load shiur:', err);
      document.getElementById('shiurTitle').textContent = 'Error loading shiur #' + id;
      document.getElementById('shiurSpeaker').textContent = 'Please check the ID or try again.';
      const errUploadEl = document.getElementById('shiurUploadDate');
      if (errUploadEl) {
        errUploadEl.style.display = 'none';
        errUploadEl.textContent = '';
      }
      try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}
    }
  }

  function renderMetadataBox(data) {
    const box = document.getElementById('shiurMetadataBox');
    if (!box) return;

    let html = '';
    const teachers = Array.isArray(data.shiurTeachers) ? data.shiurTeachers : [];
    const locations = Array.isArray(data.postedInLocations) ? data.postedInLocations : [];
    const rawDate = data.shiurDateFormatted || data.shiurDate || '';
    const date = formatShiurDate(rawDate) || rawDate;
    const keywords = Array.isArray(data.shiurKeywords) ? data.shiurKeywords : [];
    const categories = (data.postedInCategories && typeof data.postedInCategories === 'object') ? data.postedInCategories : {};

    if (teachers.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">👤 Speaker</span>';
      teachers.forEach(t => {
        const tId = t.teacherID || '';
        const tName = t.teacherFullName || '';
        html += '<button type="button" class="meta-chip speaker-chip" onclick="filterByTeacher(' + JSON.stringify(tId) + ', ' + JSON.stringify(tName).replace(/"/g, '&quot;') + ')">' + escapeHtml(tName) + '</button>';
      });
      html += '</div>';
    }

    if (date) {
      html += '<div class="meta-row"><span class="meta-label">📅 Date</span><span style="font-size:13px; color:var(--text);">' + escapeHtml(date) + '</span></div>';
    }

    // Uploaded row (between Date and Topics/Venue) — only when the lookup
    // resolved for THIS shiur and the date differs from the given date.
    if (currentUploadDateStr && String(currentUploadShiurId) === String(data.shiurID || '') &&
        currentUploadDateStr !== date) {
      html += '<div class="meta-row"><span class="meta-label">📤 Uploaded</span><span style="font-size:13px; color:var(--text);">' + escapeHtml(currentUploadDateStr) + '</span></div>';
    }

    if (locations.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">📍 Venue</span>';
      locations.forEach(loc => {
        const lId = loc.locationID || '';
        const lName = loc.locationName || '';
        html += '<button type="button" class="meta-chip venue-chip" onclick="filterByLocation(' + JSON.stringify(lId) + ', ' + JSON.stringify(lName).replace(/"/g, '&quot;') + ')">' + escapeHtml(lName) + '</button>';
      });
      html += '</div>';
    }

    const catEntries = Object.entries(categories);
    if (catEntries.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">📂 Topics</span>';
      catEntries.forEach(([groupId, grp]) => {
        if (grp.groupName && Array.isArray(grp.categories)) {
          html += '<span class="meta-group-name">' + escapeHtml(grp.groupName) + ':</span>';
          grp.categories.forEach(c => {
            const cId = c.subcategoryID || '';
            const cName = c.categoryName || '';
            html += '<button type="button" class="meta-chip category-chip" onclick="filterByCategory(' + JSON.stringify(cId) + ', ' + JSON.stringify(cName).replace(/"/g, '&quot;') + ')">' + escapeHtml(cName) + '</button> ';
          });
        }
      });
      html += '</div>';
    }

    if (keywords.length > 0) {
      html += '<div class="meta-row"><span class="meta-label">🏷️ Tags</span>';
      keywords.forEach(k => {
        const kw = k.keywordTitle || '';
        if (kw) {
          html += '<button type="button" class="meta-chip keyword-chip" onclick="searchFor(' + JSON.stringify(kw).replace(/"/g, '&quot;') + ')">' + escapeHtml(kw) + '</button>';
        }
      });
      html += '</div>';
    }

    box.innerHTML = html;
    box.style.display = html ? 'block' : 'none';
  }

  function closePlayer() {
    audio.pause();
    isManuallyMinimized = false;
    document.getElementById('playerCard').style.display = 'none';
    const miniPlayer = document.getElementById('miniPlayer');
    if (miniPlayer) miniPlayer.classList.remove('visible');
    document.body.classList.remove('mini-player-active');
    hasAudio = false;
    currentShiurId = '';
    const newUrl = new URL(window.location.href);
    newUrl.pathname = '/';
    // Keep playlist + theme context; drop only player/search-specific keys.
    try {
      const keep = new URLSearchParams();
      ['tab', 'pl', 'plq', 'plteachers', 'plvenues', 'pltopics', 'plscope', 'plsort', 'theme', 'mode', 'dark', 'light'].forEach(k => {
        newUrl.searchParams.getAll(k).forEach(v => keep.append(k, v));
      });
      newUrl.search = keep.toString();
    } catch (e) {
      newUrl.search = '';
    }
    history.pushState({}, '', newUrl.toString());
  }

  // Recent History Helpers
  function getRecentHistory() {
    try {
      return JSON.parse(localStorage.getItem('yutorah_recent_history') || '[]');
    } catch(e) {
      return [];
    }
  }

  function addRecentHistory(shiur) {
    if (!shiur || !shiur.id) return;
    try {
      let history = getRecentHistory();
      history = history.filter(item => String(item.id) !== String(shiur.id));
      history.unshift({
        id: shiur.id,
        title: shiur.title || 'Untitled',
        speaker: shiur.speaker || 'YUTorah',
        photo: shiur.photo || '',
        duration: shiur.duration || '',
        date: shiur.date || '',
        dateISO: shiur.dateISO || '',
        category: shiur.category || '',
        isArticle: Boolean(shiur.isArticle),
        listenedAt: Date.now()
      });
      if (history.length > 24) history = history.slice(0, 24);
      localStorage.setItem('yutorah_recent_history', JSON.stringify(history));
    } catch(e) {}
    try {
      if (typeof markCloudDirty === 'function') markCloudDirty('history');
      if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
    } catch (e) {}
  }

  function renderRecentlyViewedGrid() {
    const grid = document.getElementById('grid-viewed');
    if (!grid) return;
    const history = getRecentHistory();
    if (history.length === 0) {
      grid.innerHTML = '<div style="text-align: center; padding: 40px 20px; color: var(--text-muted); grid-column: 1/-1;">' +
        '<div style="font-size: 36px; margin-bottom: 12px;">🎧</div>' +
        '<div style="font-weight: 700; font-size: 16px; margin-bottom: 6px; color: var(--text);">No Recently Viewed Shiurim Yet</div>' +
        '<div style="font-size: 13px; max-width: 400px; margin: 0 auto 16px;">Shiurim you listen to will appear here automatically for quick resumption.</div>' +
        '<button class="chip" onclick="switchCollection(&quot;editors&quot;)">⭐ Browse Editor&#39;s Picks</button>' +
        '</div>';
      return;
    }
    grid.innerHTML = history.map(item => {
      const photo = item.photo || 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
      const rawDate = item.date || item.shiurDate || '';
      const dateStr = formatShiurDate(rawDate);
      const isNew = isShiurNew(rawDate);
      const newBadge = isNew ? '<span class="quick-card-new-badge">NEW</span>' : '';
      const isDoc = Boolean(item.isArticle);
      const metaParts = [];
      if (isDoc) {
        metaParts.push('📄 Article');
      } else if (item.duration) {
        metaParts.push('⏱ ' + escapeHtml(item.duration));
      }
      if (dateStr) metaParts.push(escapeHtml(dateStr));
      const bottomMeta = metaParts.join(' · ');
      const actionBadge = isDoc
        ? '<span class="quick-play-badge" style="background:#10b981; color:#fff;">📄 Read</span>'
        : '<span class="quick-play-badge" role="button" tabindex="0" data-kbplay onclick="event.stopPropagation(); playShiurById(event, \\'' + item.id + '\\', true)">▶ Resume</span>';
      return '<a href="/' + item.id + '" class="quick-card-link" onclick="playShiurById(event, this.dataset.id)" data-id="' + item.id + '">' +
        newBadge +
        '<div class="quick-card-top">' +
          '<img class="quick-card-avatar" src="' + escapeHtml(photo) + '" alt="' + escapeHtml(item.speaker) + '" loading="lazy" onerror="handleImgError(this)">' +
          '<div class="quick-card-info">' +
            '<div class="quick-card-title">' + escapeHtml(item.title) + '</div>' +
            '<div class="quick-card-speaker">' + escapeHtml(item.speaker) + '</div>' +
            (item.category ? '<div class="quick-card-category">' + escapeHtml(item.category) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="quick-card-bottom">' +
          '<span>' + bottomMeta + '</span>' +
          actionBadge +
        '</div>' +
      '</a>';
    }).join('');
  }

  // =========================================================================
  // ROADMAP §8: Dev Playlists engine (Dev Mode only — fully inert otherwise).
  // Store: localStorage yutorah_dev_playlists (system + custom playlists)
  // and yutorah_playback_progress (per-shiur playback records).
  // =========================================================================
  var DEV_PLAYLISTS_KEY = 'yutorah_dev_playlists';
  var DEV_PROGRESS_KEY = 'yutorah_playback_progress';
  var devDocCache = {};
  var activeDevPlaylistId = 'history';
  var devLastHeartbeat = 0;
  // Memoized parses: renderDocToCard calls into the store per card, so we
  // cache the parsed objects and invalidate on every save (same-tab writes
  // always go through saveDevStore / the progress writers below).
  var devStoreCache = null;
  var devProgressCache = null;

  var DEV_PUBLIC_SEEDS = ${JSON.stringify(DEV_PUBLIC_SEEDS).replace(/</g, "\\u003c")};

  function devDefaultStore() {
    return {
      activeId: 'history',
      custom: {},
      system: {
        save_for_later: { id: 'save_for_later', name: 'Save for Later', icon: '🕒', items: [] },
        favorites: { id: 'favorites', name: 'Favorites', icon: '⭐', items: [] }
      }
    };
  }

  function getDevStore() {
    if (devStoreCache) return devStoreCache;
    try {
      const raw = localStorage.getItem(DEV_PLAYLISTS_KEY);
      let s = null;
      if (!raw) {
        s = devDefaultStore();
      } else {
        s = JSON.parse(raw);
        if (!s || !s.system) s = devDefaultStore();
      }
      if (!s.system.save_for_later) s.system.save_for_later = { id: 'save_for_later', name: 'Save for Later', icon: '🕒', items: [] };
      if (!s.system.favorites) s.system.favorites = { id: 'favorites', name: 'Favorites', icon: '⭐', items: [] };
      if (!s.custom) s.custom = {};
      if (typeof isDevMode !== 'undefined' && isDevMode) {
        // Purge legacy pl_dev_ entries so they don't linger in localStorage
        for (const k of Object.keys(s.custom)) {
          if (k.startsWith('pl_dev_')) delete s.custom[k];
        }
        for (let i = 0; i < DEV_PUBLIC_SEEDS.length; i++) {
          const p = DEV_PUBLIC_SEEDS[i];
          if (!s.custom[p.id]) {
            s.custom[p.id] = {
              id: p.id,
              name: p.title,
              ownerName: p.ownerName,
              description: p.description,
              tags: p.tags,
              publicId: p.id,
              isPublic: true,
              isDevOwned: true,
              icon: '📁',
              items: p.items || []
            };
          } else if (s.custom[p.id].isDevOwned && (!s.custom[p.id].ownerName || s.custom[p.id].ownerName === 'Dev')) {
            s.custom[p.id].ownerName = p.ownerName;
          }
        }
      }
      devStoreCache = s;
      return s;
    } catch (e) {
      devStoreCache = devDefaultStore();
      return devStoreCache;
    }
  }

  function saveDevStore(store) {
    devStoreCache = store;
    try {
      localStorage.setItem(DEV_PLAYLISTS_KEY, JSON.stringify(store));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        flashToast('⚠️ Storage full — playlist change was NOT saved', true, false);
      }
    }
    try {
      if (typeof markCloudDirty === 'function') markCloudDirty('playlists');
      if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
    } catch (e) {}
  }

  function getDevPlaylist(store, pid) {
    if (pid === 'history') {
      return { id: 'history', name: 'History', icon: '📜', isHistory: true, items: getRecentHistory() };
    }
    if (store.system[pid]) return store.system[pid];
    if (store.custom[pid]) return store.custom[pid];
    return null;
  }

  function devPlaylistIds(store) {
    return ['history', 'save_for_later', 'favorites'].concat(Object.keys(store.custom || {}));
  }

  // Split a rendered meta string ("1h 22m · September 8, 2026",
  // "📄 Article · March 3, 2019", "⏱ 1 hr 6 min · Yesterday") into clean
  // { duration, date }. Shared by card snapshots and the player save path.
  function devSplitMeta(meta) {
    const out = { duration: '', date: '' };
    const s = String(meta || '');
    if (!s) return out;
    const cut = s.indexOf('·');
    const head = (cut === -1 ? s : s.slice(0, cut)).trim();
    const tail = cut === -1 ? '' : s.slice(cut + 1).trim();
    const dm = head.match(/(\\d+\\s*h(?:r)?(?:\\s*\\d+\\s*m(?:in)?)?|\\d+\\s*min(?:ute)?s?|\\d+\\s*m\\b|\\d+\\s*sec(?:ond)?s?)/i);
    if (dm) {
      out.duration = dm[1].trim();
      out.date = tail;
    } else if (tail) {
      out.date = tail;
    } else {
      out.date = head;
    }
    return out;
  }

  function devSnapshot(id) {
    if (devDocCache[id]) return devDocCache[id];
    if (String(currentShiurId) === String(id)) {
      const t = document.getElementById('shiurTitle');
      const s = document.getElementById('shiurSpeaker');
      const img = document.getElementById('speakerImg');
      const mEl = document.getElementById('shiurMeta');
      const split = devSplitMeta(mEl ? mEl.textContent : '');
      return {
        id: id,
        title: t ? t.textContent : 'Untitled',
        speaker: s ? s.textContent : 'YUTorah',
        photo: img ? img.src : '',
        duration: split.duration,
        date: split.date,
        isArticle: Boolean(isCurrentShiurArticle),
        addedAt: Date.now()
      };
    }
    return null;
  }

  function devInPlaylist(pid, id) {
    const store = getDevStore();
    const pl = getDevPlaylist(store, pid);
    if (!pl || !pl.items) return false;
    return pl.items.some(item => String(item.id) === String(id));
  }

  function devSetMembership(pid, id, want) {
    if (pid === 'history') return false;
    const store = getDevStore();
    const pl = store.system[pid] || store.custom[pid];
    if (!pl || pl.isSubscription) return false;
    const has = pl.items.some(item => String(item.id) === String(id));
    if (want && !has) {
      const snap = devSnapshot(id);
      if (!snap) return false;
      snap.addedAt = Date.now();
      pl.items.unshift(snap);
    } else if (!want && has) {
      pl.items = pl.items.filter(item => String(item.id) !== String(id));
    } else {
      return true;
    }
    saveDevStore(store);
    return true;
  }

  function toggleDevSave(id) {
    const want = !devInPlaylist('save_for_later', id);
    if (devSetMembership('save_for_later', id, want)) {
      // Silent by design: the button recolor is the only feedback.
      devRefreshCardButtons();
      if (document.getElementById('grid-playlists') && document.getElementById('grid-playlists').style.display !== 'none') renderPlaylistsGrid();
    }
  }

  function toggleDevFav(id) {
    const want = !devInPlaylist('favorites', id);
    if (devSetMembership('favorites', id, want)) {
      // Silent by design: the button recolor is the only feedback.
      devRefreshCardButtons();
      if (document.getElementById('grid-playlists') && document.getElementById('grid-playlists').style.display !== 'none') renderPlaylistsGrid();
    }
  }

  function devRefreshCardButtons() {
    const saveIc = getSaveIcon();
    const saveId = getSaveIconId();
    document.querySelectorAll('[data-dev-save]').forEach(el => {
      const on = devInPlaylist('save_for_later', el.getAttribute('data-dev-save'));
      el.classList.toggle('active-save', on);
      if (el.getAttribute('data-save-icon') !== saveId) {
        el.innerHTML = saveIc;
        el.setAttribute('data-save-icon', saveId);
      }
      el.title = on ? 'Saved for later' : 'Save for later';
    });
    document.querySelectorAll('[data-dev-fav]').forEach(el => {
      const on = devInPlaylist('favorites', el.getAttribute('data-dev-fav'));
      el.classList.toggle('active-fav', on);
      if (el.textContent === '☆' || el.textContent === '⭐') el.textContent = on ? '⭐' : '☆';
      el.title = on ? 'In favorites' : 'Add to favorites';
    });
    document.querySelectorAll('[data-dev-queue]').forEach(el => {
      const qid = el.getAttribute('data-dev-queue');
      const isCoverBtn = el.getAttribute('data-dev-cover') === '1';
      const on = isCoverBtn ? devSeriesQueued(qid) : devInQueue(qid);
      el.classList.toggle('active-save', on);
      el.title = on ? 'In play queue' : 'Add to play queue';
    });
    // Player-header buttons track the currently loaded shiur.
    try {
      if (typeof currentShiurId !== 'undefined' && currentShiurId) {
        const ps = document.getElementById('devPlayerSaveBtn');
        if (ps) {
          const on = devInPlaylist('save_for_later', String(currentShiurId));
          ps.classList.toggle('active-save', on);
          ps.title = on ? 'Saved for later' : 'Save for later';
        }
        const pf = document.getElementById('devPlayerFavBtn');
        if (pf) {
          const on = devInPlaylist('favorites', String(currentShiurId));
          pf.classList.toggle('active-fav', on);
          pf.textContent = on ? '⭐' : '☆';
          pf.title = on ? 'In favorites' : 'Add to favorites';
        }
        const pq = document.getElementById('devPlayerQueueBtn');
        if (pq) {
          const on = devInQueue(String(currentShiurId));
          pq.classList.toggle('active-save', on);
          pq.title = on ? 'In play queue' : 'Add to play queue';
        }
      }
    } catch (e) {}
  }

  // Fundamental-cards guarantee (§8): server-rendered cards (homepage
  // collections, SSR search grid, Recently Viewed) never pass through
  // renderDocToCard, so after Dev Mode activates we walk every card link and
  // retrofit the mini actions + progress bar, snapshotting metadata from the
  // card DOM itself. Re-runs are cheap and refresh stale progress.
  function devSnapshotFromCard(link) {
    const id = link.getAttribute('data-id');
    if (!id) return null;
    if (devDocCache[id]) return id;
    const text = sel => {
      const el = link.querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    };
    const img = link.querySelector('img.quick-card-avatar');
    // Top-level cards keep meta in .quick-card-bottom; series sub-cards use
    // .series-sub-meta — support both so drawer saves keep duration + date.
    const meta = text('.quick-card-bottom span') || text('.series-sub-meta');
    const split = devSplitMeta(meta);
    let title = text('.quick-card-title') || text('.series-sub-title') || 'Untitled';
    title = title.replace(/^#\\d+\\s*/, '');
    const badge = text('.quick-card-bottom') + ' ' + text('.series-sub-meta');
    devDocCache[id] = {
      id: String(id),
      title: title,
      speaker: text('.quick-card-speaker') || 'YUTorah',
      photo: img ? (img.getAttribute('src') || '') : '',
      duration: split.duration,
      date: split.date,
      isArticle: badge.indexOf('📄') !== -1
    };
    return id;
  }

  function devUpgradeCards(root) {
    if (!playlistsEnabled()) return;
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    scope.querySelectorAll('a.quick-card-link[data-id], a.series-sub-card[data-id]').forEach(link => {
      const id = devSnapshotFromCard(link);
      if (!id) return;
      if (!link.querySelector('.card-mini-actions')) {
        const isCoverLink = Boolean(link.querySelector('.series-cover-badge'));
        const tmp = document.createElement('div');
        tmp.innerHTML = devCardActionsHtml(String(id), isCoverLink) + devProgressHtml(String(id));
        while (tmp.firstChild) link.appendChild(tmp.firstChild);
      } else {
        // Refresh stale progress: add the bar if the first upgrade ran
        // before any progress existed, else swap in the latest record.
        const fresh = devProgressHtml(String(id));
        const old = link.querySelector('.dev-progress-wrap');
        if (old) {
          if (fresh) {
            const tmp = document.createElement('div');
            tmp.innerHTML = fresh;
            if (tmp.firstChild) old.replaceWith(tmp.firstChild);
            else old.remove();
          } else {
            old.remove();
          }
        } else if (fresh) {
          const tmp = document.createElement('div');
          tmp.innerHTML = fresh;
          while (tmp.firstChild) link.appendChild(tmp.firstChild);
        }
      }
    });
    devRefreshCardButtons();
  }

  function getPlaybackProgress() {
    if (devProgressCache) return devProgressCache;
    try {
      devProgressCache = JSON.parse(localStorage.getItem(DEV_PROGRESS_KEY) || '{}');
    } catch (e) {
      devProgressCache = {};
    }
    return devProgressCache;
  }

  function getProgressRecord(id) {
    if (!id) return null;
    return getPlaybackProgress()[String(id)] || null;
  }

  function devRecordHeartbeat(force) {
    if (!currentShiurId || isSponsorPlaying || !audio || !audio.duration || isNaN(audio.duration)) return;
    const now = Date.now();
    if (!force && now - devLastHeartbeat < 5000) return;
    devLastHeartbeat = now;
    try {
      const all = getPlaybackProgress();
      all[String(currentShiurId)] = {
        shiurId: String(currentShiurId),
        progressSec: Math.floor(audio.currentTime || 0),
        durationSec: Math.floor(audio.duration || 0),
        lastListened: now,
        completed: false
      };
      localStorage.setItem(DEV_PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function devMarkCompleted() {
    if (!currentShiurId) return;
    try {
      const all = getPlaybackProgress();
      const prev = all[String(currentShiurId)] || {};
      all[String(currentShiurId)] = {
        shiurId: String(currentShiurId),
        progressSec: prev.durationSec || Math.floor((audio && audio.duration) || 0),
        durationSec: prev.durationSec || Math.floor((audio && audio.duration) || 0),
        lastListened: Date.now(),
        completed: true
      };
      localStorage.setItem(DEV_PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {}
    try {
      if (typeof markCloudDirty === 'function') markCloudDirty('history');
      if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
    } catch (e) {}
  }

  function devRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 3600000) {
      const m = Math.max(1, Math.round(diff / 60000));
      return m + ' min ago';
    }
    if (diff < 86400000) {
      const h = Math.round(diff / 3600000);
      return h + (h === 1 ? ' hour ago' : ' hours ago');
    }
    const d = Math.round(diff / 86400000);
    if (d === 1) return 'Yesterday';
    return d + ' days ago';
  }

  function devProgressHtml(id) {
    if (!playlistsEnabled()) return '';
    const rec = getProgressRecord(id);
    if (!rec || !rec.durationSec) return '';
    const pct = Math.min(100, Math.round((rec.progressSec / rec.durationSec) * 100));
    const cur = Math.floor(rec.progressSec / 60);
    const tot = Math.floor(rec.durationSec / 60);
    return '<div class="acct-only dev-progress-wrap"><div class="card-progress-track"><div class="card-progress-fill" style="width: ' + pct + '%;"></div></div>' +
      '<div class="card-listen-meta">🕒 Last listened: ' + escapeHtml(devRelativeTime(rec.lastListened)) +
      ' · ' + cur + '/' + tot + ' min through (' + pct + '%)</div></div>';
  }

  // Save-for-later button icon (dev-pickable from 5 clocks in settings):
  // the emoji favorite plus 4 SVG faces with progressively bolder hands.
  function devClockSvg(handW, rimW, filled) {
    var hands = filled
      ? '<path d="M12 12 L12 6.5 L14 6.5 L14 12 L18 14 L17 15.8 Z" fill="currentColor" stroke="none"></path>'
      : '<line x1="12" y1="12" x2="12" y2="6.5"></line>' +
        '<line x1="12" y1="12" x2="17.5" y2="14.5"></line>';
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="' + rimW + '" aria-hidden="true" style="vertical-align:middle; display:inline-block; flex-shrink:0;">' +
      '<circle cx="12" cy="12" r="9"></circle>' +
      '<g stroke-width="' + handW + '" stroke-linecap="round">' + hands + '</g></svg>';
  }
  var DEV_SAVE_ICONS = ['emoji', 'hands-light', 'hands-medium', 'hands-bold', 'hands-filled'];
  function getSaveIconId() {
    try {
      const v = localStorage.getItem('yutorah_save_icon');
      if (DEV_SAVE_ICONS.indexOf(v) !== -1) return v;
    } catch (e) {}
    return 'hands-light';
  }
  function saveIconThumb(oid) {
    if (oid === 'emoji') return '🕒';
    if (oid === 'hands-medium') return devClockSvg(3.2, 1.8, false);
    if (oid === 'hands-bold') return devClockSvg(4.5, 2.4, false);
    if (oid === 'hands-filled') return devClockSvg(0, 2, true);
    return devClockSvg(2, 1.6, false);
  }
  function getSaveIconHtml() {
    return saveIconThumb(getSaveIconId());
  }
  function getSaveIcon() {
    return getSaveIconHtml();
  }
  function setSaveIcon(id) {
    if (DEV_SAVE_ICONS.indexOf(id) === -1) return;
    try { localStorage.setItem('yutorah_save_icon', id); } catch (e) {}
    devRefreshCardButtons();
    var ps = document.getElementById('devPlayerSaveBtn');
    if (ps) ps.innerHTML = getSaveIconHtml();
    renderSaveIconPicker();
  }
  function renderSaveIconPicker() {
    var wrap = document.getElementById('saveIconPicker');
    if (!wrap) return;
    var cur = getSaveIconId();
    wrap.innerHTML = DEV_SAVE_ICONS.map(function(oid) {
      return '<button type="button" class="card-mini-btn icon-btn' + (oid === cur ? ' active-save' : '') + '"' +
        ' onclick="setSaveIcon(this.getAttribute(\\'data-oid\\'))" data-oid="' + oid + '" title="Save-for-later icon: ' + oid + '">' + saveIconThumb(oid) + '</button>';
    }).join('');
  }

  // Spotify-style circular queue icon: list lines + plus.
  function devQueueIconSvg() {
    return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="4" y1="7" x2="12" y2="7"></line>' +
      '<line x1="4" y1="12" x2="12" y2="12"></line>' +
      '<line x1="4" y1="17" x2="10" y2="17"></line>' +
      '<line x1="16.5" y1="13.5" x2="16.5" y2="20.5"></line>' +
      '<line x1="13" y1="17" x2="20" y2="17"></line>' +
      '</svg>';
  }

  function devCardActionsHtml(id, isCover) {
    if (!playlistsEnabled()) return '';
    const inSave = devInPlaylist('save_for_later', id);
    const inFav = devInPlaylist('favorites', id);
    const inQ = isCover ? devSeriesQueued(id) : devInQueue(id);
    const qLabel = isCover ? 'Queue series' : 'Add to play queue';
    const qCall = isCover ? 'devQueueToggle(\\\'' + id + '\\\', true, this)' : 'devQueueToggle(\\\'' + id + '\\\', false, this)';
    return '<div class="card-mini-actions acct-only">' +
      '<span role="button" tabindex="0" class="card-mini-btn icon-btn' + (inSave ? ' active-save' : '') + '" data-dev-save="' + id + '"' +
      ' title="Save for later" aria-label="Save for later"' +
      ' onclick="event.stopPropagation(); event.preventDefault(); toggleDevSave(\\\'' + id + '\\\')">' + getSaveIcon() + '</span>' +
      '<span role="button" tabindex="0" class="card-mini-btn icon-btn' + (inFav ? ' active-fav' : '') + '" data-dev-fav="' + id + '"' +
      ' title="Add to favorites" aria-label="Add to favorites"' +
      ' onclick="event.stopPropagation(); event.preventDefault(); toggleDevFav(\\\'' + id + '\\\')">' + (inFav ? '⭐' : '☆') + '</span>' +
      '<span role="button" tabindex="0" class="queue-circle-btn' + (inQ ? ' active-save' : '') + '" data-dev-queue="' + id + '"' + (isCover ? ' data-dev-cover="1"' : '') +
      ' title="' + qLabel + '" aria-label="' + qLabel + '"' +
      ' onclick="event.stopPropagation(); event.preventDefault(); ' + qCall + '">' + devQueueIconSvg() + '</span>' +
      '<span role="button" tabindex="0" class="card-mini-btn" onclick="event.stopPropagation(); event.preventDefault(); openPlaylistModal(\\\'' + id + '\\\')">➕ Playlist</span>' +
      '</div>';
  }

  function devParseMinutes(str) {
    if (str == null) return 0;
    if (typeof str === 'number') return Math.round(str);
    const s = String(str);
    let mins = 0;
    let m = s.match(/(\\d+)\\s*hr/i);
    if (m) {
      mins += parseInt(m[1], 10) * 60;
    } else {
      m = s.match(/(\\d+)\\s*h/i);
      if (m) mins += parseInt(m[1], 10) * 60;
    }
    m = s.match(/(\\d+)\\s*min/i);
    if (m) mins += parseInt(m[1], 10);
    else {
      m = s.match(/(\\d+)\\s*m\\b/i);
      if (m) mins += parseInt(m[1], 10);
    }
    if (!mins) {
      m = s.match(/(\\d+)\\s*sec/i);
      if (m) mins += Math.round(parseInt(m[1], 10) / 60);
      else {
        m = s.match(/^\\s*(\\d+)\\s*$/);
        if (m) mins += parseInt(m[1], 10);
      }
    }
    return mins;
  }

  function devTotalDuration(items) {
    const total = (items || []).reduce((sum, it) => sum + devParseMinutes(it.duration), 0);
    if (total >= 60) {
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h + (h === 1 ? ' hr ' : ' hrs ') + m + ' min';
    }
    return total + ' min';
  }

  function devAskRemove(pid, id) {
    const grid = document.getElementById('grid-playlists');
    if (!grid) return;
    grid.querySelectorAll('[data-dev-remove-confirm]').forEach(el => {
      el.outerHTML = '<button type="button" class="card-mini-btn" data-dev-remove="' + el.getAttribute('data-dev-remove-confirm-pid') + ':' + el.getAttribute('data-dev-remove-confirm') + '"' +
        ' onclick="devAskRemove(\\'' + el.getAttribute('data-dev-remove-confirm-pid') + '\\', \\'' + el.getAttribute('data-dev-remove-confirm') + '\\')">✕ Remove</button>';
    });
    const sel = grid.querySelector('[data-dev-remove="' + pid + ':' + id + '"]');
    if (sel) {
      const store = getDevStore();
      const pl = getDevPlaylist(store, pid);
      const plName = pl && pl.name ? pl.name : pid;
      sel.outerHTML = '<span>Are you sure you want to remove this shiur from "' + escapeHtml(plName) + '?" ' +
        '<button type="button" class="card-mini-btn" onclick="devDoRemove(\\'' + pid + '\\', \\'' + id + '\\')">🗑️ Confirm Remove</button> ' +
        '<button type="button" class="card-mini-btn" onclick="renderPlaylistsGrid()">Cancel</button></span>';
    }
  }

  function devDoRemove(pid, id) {
    if (pid === 'history') {
      try {
        let history = getRecentHistory().filter(item => String(item.id) !== String(id));
        localStorage.setItem('yutorah_recent_history', JSON.stringify(history));
      } catch (e) {}
    } else {
      const store = getDevStore();
      const pl = store.system[pid] || store.custom[pid];
      if (pl && pl.isSubscription) {
        flashToast('🔒 Subscribed playlists are read-only', true, false);
        return;
      }
      if (pl) {
        pl.items = pl.items.filter(item => String(item.id) !== String(id));
        saveDevStore(store);
      }
    }
    devRefreshCardButtons();
    renderPlaylistsGrid();
  }

  function devIsDuplicatePlaylistName(name, excludeId) {
    const clean = String(name || '').trim().toLowerCase();
    if (!clean) return false;
    const sys = ['history', 'favorites', 'save for later', 'later', 'queue'];
    if (sys.includes(clean)) return true;
    const store = getDevStore();
    if (!store || !store.custom) return false;
    return Object.values(store.custom).some(p => p && p.id !== excludeId && (p.name || '').trim().toLowerCase() === clean);
  }
  window.devIsDuplicatePlaylistName = devIsDuplicatePlaylistName;

  function devCreatePlaylist(name, icon, desc, tags) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return null;
    const store = getDevStore();
    const id = 'pl_' + Date.now().toString(36);
    store.custom[id] = {
      id: id,
      name: name,
      icon: icon || '📁',
      description: desc ? String(desc).trim().slice(0, 300) : '',
      tags: tags && typeof tags === 'object' ? tags : { teachers: [], venues: [], topics: [] },
      items: []
    };
    store.activeId = id;
    activeDevPlaylistId = id;
    saveDevStore(store);
    return id;
  }
  window.devCreatePlaylist = devCreatePlaylist;

  function devSelectPlaylist(pid) {
    activeDevPlaylistId = pid;
    renderPlaylistsGrid();
    syncPlaylistUrl();
  }
  window.devSelectPlaylist = devSelectPlaylist;

  // Account features (playlists, queue, progress) are on in dev mode OR
  // when logged in. Logged-out visitors get a login prompt instead.
  function playlistsEnabled() {
    try {
      return Boolean(isDevMode) || Boolean(cloudUser);
    } catch (e) {
      return false;
    }
  }

  function accountDisplayName() {
    try {
      const custom = localStorage.getItem('yutorah_display_name');
      if (custom && custom.trim()) return custom.trim().slice(0, 40);
    } catch (e) {}
    if (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.name) {
      return String(cloudUser.name).split(' ')[0].slice(0, 40);
    }
    return '';
  }

  function renderAccountMode() {
    const on = playlistsEnabled();
    try { document.body.classList.toggle('acct-on', on); } catch (e) {}
    try {
      // Playlists tab is always visible (logged-out visitors get the login
      // prompt + public browser); only the interactive extras need acct-on.
      const tab = document.getElementById('tab-playlists');
      if (tab) {
        tab.style.display = '';
        tab.removeAttribute('aria-hidden');
        const nm = accountDisplayName();
        tab.textContent = '🎧 ' + (on && nm ? nm + '’s Playlists' : 'My Playlists');
      }
      if (typeof collectionTitles !== 'undefined' && collectionTitles) {
        const nm2 = accountDisplayName();
        collectionTitles.playlists = '🎧 ' + (on && nm2 ? nm2 + '’s Playlists' : 'My Playlists');
      }
      const devTab = document.getElementById('tab-dev-playlists');
      if (devTab) {
        if (typeof isDevMode !== 'undefined' && isDevMode) {
          devTab.style.display = '';
          devTab.removeAttribute('aria-hidden');
        } else {
          devTab.style.display = 'none';
          devTab.setAttribute('aria-hidden', 'true');
        }
      }
    } catch (e) {}
    try { if (typeof ensurePlayerActions === 'function') ensurePlayerActions(); } catch (e) {}
    try { if (typeof devUpgradeCards === 'function') devUpgradeCards(); } catch (e) {}
  }

  // =========================================================================
  // Public playlists: publish / browse / save. Publishing snapshots the
  // local list and shows the owner's DISPLAY NAME only (never email).
  // Browsing (search + teacher/venue/topic tag filters + sort) is contained
  // in the playlists tab; no login needed to browse, login to publish/save.
  // =========================================================================
  let plBrowseMode = 'mine';
  let plPublicQuery = '';
  let plPublicScope = { title: true, desc: true, shiurim: false };
  let plPublicFilterTags = { teachers: [], venues: [], topics: [] };
  let plPublicTags = { teacher: null, venue: null, topic: null };
  let plPublicSort = 'recent';
  let plPublicResults = [];
  let plPublicTotal = 0;
  let plPublicOffset = 0;
  const PL_PUBLIC_PAGE = 30;
  let plPublicExpanded = null;
  let plMineCache = { at: 0, list: [] };
  let plPublishing = false;
  let plTagsWarmed = false;

  // Scratch rebuild: filter bar is persistent state; tag mutations patch
  // tokens + results only and never destroy the inputs mid-typing.
  let plPublicFilterDraft = { teachers: '', venues: '', topics: '' };
  let plPublicOpenKind = null;

  function plFilterIds(kind) {
    if (kind === 'venues') return { input: 'plPubVenueInput', chips: 'plPubVenueChips', dropdown: 'plPubVenueDropdown' };
    if (kind === 'topics') return { input: 'plPubTopicInput', chips: 'plPubTopicChips', dropdown: 'plPubTopicDropdown' };
    return { input: 'plPubTeacherInput', chips: 'plPubTeacherChips', dropdown: 'plPubTeacherDropdown' };
  }

  function plRenderFilterTokens(kind) {
    try {
      const ids = plFilterIds(kind);
      const chips = document.getElementById(ids.chips);
      const input = document.getElementById(ids.input);
      if (!chips || !input) return;
      chips.querySelectorAll('.combobox-token').forEach(el => el.remove());
      (plPublicFilterTags[kind] || []).forEach(t => {
        const token = document.createElement('span');
        token.className = 'combobox-token';
        const label = document.createElement('span');
        label.textContent = t.name || t.id || '';
        token.appendChild(label);
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'token-remove-btn';
        x.textContent = '✕';
        x.title = 'Remove filter';
        x.setAttribute('aria-label', 'Remove ' + (t.name || t.id || '') + ' filter');
        x.addEventListener('mousedown', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          const arr = plPublicFilterTags[kind] || [];
          const idx = arr.indexOf(t);
          if (idx >= 0) plRemoveFilterTag(kind, idx);
        });
        token.appendChild(x);
        chips.insertBefore(token, input);
      });
    } catch (e) {}
  }

  function plRenderAllFilterTokens() {
    plRenderFilterTokens('teachers');
    plRenderFilterTokens('venues');
    plRenderFilterTokens('topics');
  }

  function plActiveFilterBarHtml() {
    const cards = [];
    (plPublicFilterTags.teachers || []).forEach((t, idx) => {
      cards.push('<span class="active-filter-pill">👤 ' + escapeHtml(t.name) + ' <button type="button" onclick="plRemoveFilterTag(&quot;teachers&quot;, ' + idx + ')" title="Remove filter">✕</button></span>');
    });
    (plPublicFilterTags.venues || []).forEach((v, idx) => {
      cards.push('<span class="active-filter-pill">📍 ' + escapeHtml(v.name) + ' <button type="button" onclick="plRemoveFilterTag(&quot;venues&quot;, ' + idx + ')" title="Remove filter">✕</button></span>');
    });
    (plPublicFilterTags.topics || []).forEach((tp, idx) => {
      cards.push('<span class="active-filter-pill">🏷️ ' + escapeHtml(tp.name) + ' <button type="button" onclick="plRemoveFilterTag(&quot;topics&quot;, ' + idx + ')" title="Remove filter">✕</button></span>');
    });
    if (cards.length === 0) return '';
    return '<div class="active-filters-bar" style="grid-column:1/-1; margin-bottom:12px;">' +
      '<span style="font-size:12px; font-weight:700; color:var(--text-muted);">Active Filters:</span> ' +
      cards.join('') +
      ' <button type="button" class="modal-reset-btn" style="padding:2px 8px; font-size:12px;" onclick="plClearAllFilterTags()">Clear All</button>' +
      '</div>';
  }

  function plPatchActiveFilterBar() {
    try {
      const bar = document.getElementById('plPublicActiveBar');
      if (!bar) return;
      bar.innerHTML = plActiveFilterBarHtml();
    } catch (e) {}
  }

  function plCloseFilterDropdowns(exceptKind) {
    try {
      ['teachers', 'venues', 'topics'].forEach(k => {
        if (k === exceptKind) return;
        const ids = plFilterIds(k);
        const dd = document.getElementById(ids.dropdown);
        if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
      });
      if (!exceptKind) plPublicOpenKind = null;
    } catch (e) {}
  }

  function plMatchFilterOptions(kind, raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (v.length < 1) return [];
    const selected = new Set((plPublicFilterTags[kind] || []).map(x => String(x.id || x.name).toLowerCase()));
    const cleanV = (kind === 'teachers') ? v.replace(/^(rabbi|rav|dr|mrs|rebbetzin|r)\s+/i, '').trim() : v;
    const useClean = (kind === 'teachers') && cleanV.length > 0;
    return plTagOptions(kind).filter(o => {
      if (selected.has(String(o.id || o.name).toLowerCase())) return false;
      const nm = String(o.name || '').toLowerCase();
      if (nm.indexOf(v) >= 0) return true;
      if (!useClean) return false;
      const cleanNm = nm.replace(/^(rabbi|rav|dr|mrs|rebbetzin|r)\s+/i, '');
      return cleanNm.indexOf(cleanV) >= 0;
    }).slice(0, 12);
  }

  function plPaintFilterDropdown(kind) {
    try {
      const ids = plFilterIds(kind);
      const input = document.getElementById(ids.input);
      const dd = document.getElementById(ids.dropdown);
      if (!input || !dd) return;
      const v = (input.value || '').trim();
      if (v.length < 1) { dd.style.display = 'none'; dd.innerHTML = ''; if (plPublicOpenKind === kind) plPublicOpenKind = null; return; }
      const opts = plMatchFilterOptions(kind, v);
      if (opts.length === 0) {
        dd.innerHTML = '<div style="padding:10px 12px; font-size:12.5px; color:var(--text-muted); text-align:center;">No matching filters found</div>';
        dd.style.display = 'block';
        plPublicOpenKind = kind;
        return;
      }
      dd.innerHTML = opts.map(o => '<div class="autocomplete-item" data-id="' + escapeHtml(o.id || o.name) + '" data-name="' + escapeHtml(o.name) + '"><span>' + escapeHtml(o.name) + '</span></div>').join('');
      dd.style.display = 'block';
      plPublicOpenKind = kind;
    } catch (e) {}
  }

  function plPickFilterTag(kind, id, name) {
    if (!kind || !plPublicFilterTags[kind]) return false;
    const tag = { id: String(id || name || ''), name: String(name || id || '') };
    if (!tag.name) return false;
    const exists = plPublicFilterTags[kind].some(t => String(t.id || t.name).toLowerCase() === String(tag.id || tag.name).toLowerCase());
    if (exists) return false;
    plPublicFilterTags[kind].push(tag);
    plPublicFilterDraft[kind] = '';
    try {
      const ids = plFilterIds(kind);
      const input = document.getElementById(ids.input);
      const dd = document.getElementById(ids.dropdown);
      if (input) input.value = '';
      if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
      if (plPublicOpenKind === kind) plPublicOpenKind = null;
    } catch (e) {}
    plRenderFilterTokens(kind);
    plPatchActiveFilterBar();
    plSearchPublicResultsOnly();
    try {
      const ids = plFilterIds(kind);
      const input = document.getElementById(ids.input);
      if (input) input.focus();
    } catch (e) {}
    return true;
  }

  function plAddFilterTag(kind, tag) {
    if (!tag || !kind || !plPublicFilterTags[kind]) return;
    plPickFilterTag(kind, tag.id || tag.name, tag.name || tag.id);
  }
  window.plAddFilterTag = plAddFilterTag;

  function plRemoveFilterTag(kind, idx) {
    if (plPublicFilterTags[kind] && plPublicFilterTags[kind][idx] !== undefined) {
      plPublicFilterTags[kind].splice(idx, 1);
      plRenderFilterTokens(kind);
      plPatchActiveFilterBar();
      plSearchPublicResultsOnly();
    }
  }
  window.plRemoveFilterTag = plRemoveFilterTag;

  function plClearAllFilterTags() {
    plPublicFilterTags = { teachers: [], venues: [], topics: [] };
    plPublicTags = { teacher: null, venue: null, topic: null };
    plPublicFilterDraft = { teachers: '', venues: '', topics: '' };
    plCloseFilterDropdowns(null);
    plRenderAllFilterTokens();
    plPatchActiveFilterBar();
    try {
      ['teachers', 'venues', 'topics'].forEach(k => {
        const ids = plFilterIds(k);
        const input = document.getElementById(ids.input);
        if (input) input.value = '';
      });
    } catch (e) {}
    plSearchPublicResultsOnly();
  }
  window.plClearAllFilterTags = plClearAllFilterTags;

  function plPublicResultsHtml() {
    let h = '<div class="search-results-subheading"><span>🌍</span><span>Public Playlists</span>' +
      '<span class="sub-count">' + plPublicResults.length + ' of ' + plPublicTotal + ' shown</span></div>';
    if (plPublicResults.length === 0) {
      h += '<div style="grid-column:1/-1; text-align:center; padding:24px; color:var(--text-muted);">No public playlists match — try a different search or be the first to publish one.</div>';
    } else {
      h += plPublicResults.map(p => {
        const open = plPublicExpanded === p.id;
        const isSub = devIsSubscribedToPublicId(p.id);
        const isAuthor = devIsAuthoredByCurrentUser(p);
        const authoredCustomId = devGetAuthoredCustomId(p);
        const tagBits = []
          .concat((p.tags && p.tags.teachers || []).map(t => '👤 ' + t.name))
          .concat((p.tags && p.tags.venues || []).map(t => '📍 ' + t.name))
          .concat((p.tags && p.tags.topics || []).map(t => '🏷️ ' + t.name));
        return '<div class="playlist-public-card' + (isSub ? ' playlist-subscribed-card' : '') + (isAuthor ? ' playlist-author-card' : '') + '">' +
          '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">' +
          '<div class="playlist-card-title">' + escapeHtml(p.title || 'Untitled') + '</div>' +
          (isAuthor
            ? '<span class="active-filter-pill" style="background:rgba(43, 76, 126, 0.12); color:var(--primary); border-color:var(--primary); font-weight:700; white-space:nowrap; flex-shrink:0;">👤 Your Playlist</span>'
            : (isSub ? '<span class="active-filter-pill playlist-sub-badge" style="font-weight:700; white-space:nowrap; flex-shrink:0;">📡 Subscribed</span>' : '')
          ) +
          '</div>' +
          '<div class="playlist-card-meta">by ' + escapeHtml(p.ownerName || (isAuthor ? 'You' : 'a listener')) +
          ' · ' + (p.itemCount || 0) + ' shiurim · ❤️ ' + (p.saves || 0) + ' saves</div>' +
          (p.description ? '<div class="playlist-card-desc">' + escapeHtml(p.description) + '</div>' : '') +
          (tagBits.length ? '<div class="playlist-card-tags">' + tagBits.map(t => '<span class="playlist-tag-chip">' + escapeHtml(t) + '</span>').join('') + '</div>' : '') +
          '<div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">' +
          '<button type="button" class="card-mini-btn" onclick="plPublicToggle(&quot;' + escapeHtml(p.id) + '&quot;)">' + (open ? 'Hide shiurim ▲' : 'Preview shiurim ▼') + '</button>' +
          (isAuthor
            ? (authoredCustomId ? '<button type="button" class="card-mini-btn active-save" onclick="devSelectPlaylist(&quot;' + escapeHtml(authoredCustomId) + '&quot;)">🎧 Open in My Playlists</button>' : '')
            : (isSub
              ? '<button type="button" class="card-mini-btn active-save" onclick="devOpenSubscribedPlaylist(&quot;' + escapeHtml(p.id) + '&quot;)">🎧 Open in My Playlists</button>'
              : '<button type="button" class="card-mini-btn" onclick="plPromptSavePublic(&quot;' + escapeHtml(p.id) + '&quot;, &quot;' + escapeHtml((p.title || 'Shared playlist').replace(/"/g, '&quot;')) + '&quot;)">💾 Save to my playlists</button>'
            )
          ) +
          (!isAuthor ? '<button type="button" class="card-mini-btn" onclick="plUnsavePublic(&quot;' + escapeHtml(p.id) + '&quot;)">Remove save ♥</button>' : '') +
          (typeof isDevMode !== 'undefined' && isDevMode ? '<button type="button" class="card-mini-btn active-save" onclick="devEditPublicPlaylist(&quot;' + escapeHtml(p.id) + '&quot;)">✏️ Edit (Dev)</button>' : '') +
          '</div>' +
          '<div id="plpub-' + p.id + '">' + (open ? '<div style="margin-top:8px;">Loading…</div>' : '') + '</div>' +
          '</div>';
      }).join('');
      if (plPublicResults.length < plPublicTotal) {
        h += '<div style="grid-column:1/-1; text-align:center; margin:4px 0 12px;">' +
          '<button type="button" class="load-more-btn" onclick="plPublicMore()">🔽 Load More Playlists</button></div>';
      }
    }
    return h;
  }

  function plPatchPublicResults() {
    try {
      const wrap = document.getElementById('plPublicResultsWrap');
      if (wrap) {
        wrap.innerHTML = plPublicResultsHtml();
      } else {
        const grid = document.getElementById('grid-playlists');
        if (grid && activeDevPlaylistId !== 'queue') renderPlaylistsGrid();
        return;
      }
      plPatchActiveFilterBar();
      if (plPublicExpanded) plPublicRenderItems(plPublicExpanded);
    } catch (e) {}
  }

  async function plSearchPublicResultsOnly() {
    plPublicOffset = 0;
    plPublicExpanded = null;
    try {
      const res = await fetch('/api/playlists/public?' + plPublicParams(0));
      const data = await res.json();
      plPublicResults = (data && data.playlists) || [];
      plPublicTotal = (data && typeof data.total === 'number') ? data.total : plPublicResults.length;
    } catch (e) {
      plPublicResults = [];
      plPublicTotal = 0;
    }
    plPatchPublicResults();
    syncPlaylistUrl();
  }

  function plTagOptions(kind) {
    try {
      const c = (typeof autocompleteCache !== 'undefined' && autocompleteCache) || (typeof autocompleteData !== 'undefined' && autocompleteData) || null;
      if (!c) return [];
      const k = String(kind || '').toLowerCase();
      if (k.startsWith('teacher')) return (c.teachers || []).slice(0, 4000);
      if (k.startsWith('venue')) return (c.venues || []).slice(0, 1000);
      return (c.categories || []).slice(0, 1500);
    } catch (e) {
      return [];
    }
  }

  function plTagLabel(kind, t) {
    if (!t) return 'Any';
    return (t.name || '').slice(0, 28);
  }

  function devIsSubscribedToPublicId(publicId) {
    try {
      const store = getDevStore();
      if (!store || !store.custom) return false;
      return Object.values(store.custom).some(p => p && p.isSubscription && (p.subscribedPublicId === publicId || p.id === publicId));
    } catch (e) {
      return false;
    }
  }
  window.devIsSubscribedToPublicId = devIsSubscribedToPublicId;

  function devGetSubscribedCustomId(publicId) {
    try {
      const store = getDevStore();
      if (!store || !store.custom) return null;
      const found = Object.values(store.custom).find(p => p && p.isSubscription && (p.subscribedPublicId === publicId || p.id === publicId));
      return found ? found.id : null;
    } catch (e) {
      return null;
    }
  }
  window.devGetSubscribedCustomId = devGetSubscribedCustomId;

  function devOpenSubscribedPlaylist(publicId) {
    const subId = devGetSubscribedCustomId(publicId);
    if (subId) {
      activeDevPlaylistId = subId;
    } else {
      activeDevPlaylistId = 'history';
    }
    renderPlaylistsGrid();
  }
  window.devOpenSubscribedPlaylist = devOpenSubscribedPlaylist;

  function devIsAuthoredByCurrentUser(p) {
    if (!p) return false;
    try {
      const store = getDevStore();
      if (store && store.custom) {
        for (const k in store.custom) {
          const c = store.custom[k];
          if (c && c.publicId && String(c.publicId) === String(p.id)) return true;
        }
      }
      if (typeof cloudUser !== 'undefined' && cloudUser && p.ownerId && String(p.ownerId) === String(cloudUser.id)) {
        return true;
      }
      if (typeof isDevMode !== 'undefined' && isDevMode && (p.ownerId === 'dev' || p.ownerName === 'Dev')) {
        return true;
      }
    } catch (e) {}
    return false;
  }
  window.devIsAuthoredByCurrentUser = devIsAuthoredByCurrentUser;

  function devGetAuthoredCustomId(p) {
    if (!p) return null;
    try {
      const store = getDevStore();
      if (store && store.custom) {
        for (const k in store.custom) {
          const c = store.custom[k];
          if (c && c.publicId && String(c.publicId) === String(p.id)) return c.id || k;
        }
        if (store.custom[p.id]) return p.id;
      }
    } catch (e) {}
    return null;
  }
  window.devGetAuthoredCustomId = devGetAuthoredCustomId;

  function devPlaylistSegmentedBarHtml(isPublic) {
    return '<div class="playlist-segmented-bar">' +
      '<button type="button" class="playlist-seg-btn' + (!isPublic ? ' active' : '') + '" onclick="devSwitchPlaylistSubView(&quot;my&quot;)">🎧 My Playlists</button>' +
      '<button type="button" class="playlist-seg-btn' + (isPublic ? ' active' : '') + '" onclick="devSwitchPlaylistSubView(&quot;public&quot;)">🌍 Public Playlists</button>' +
      '</div>';
  }
  window.devPlaylistSegmentedBarHtml = devPlaylistSegmentedBarHtml;

  function devSwitchPlaylistSubView(sub) {
    if (sub === 'public') {
      activeDevPlaylistId = 'public';
      renderPlaylistsGrid();
      syncPlaylistUrl();
      if (plPublicResults.length === 0 && !plPublicQuery) plSearchPublic();
    } else {
      if (activeDevPlaylistId === 'public') {
        activeDevPlaylistId = 'history';
      }
      renderPlaylistsGrid();
      syncPlaylistUrl();
    }
  }
  window.devSwitchPlaylistSubView = devSwitchPlaylistSubView;

  function devPlaylistsHeaderHtml(store, activePid) {
    let h = devPlaylistSegmentedBarHtml(false);

    // Row 1: System Playlists (frozen top row)
    const histCount = getRecentHistory().length;
    const laterCount = (store.system && store.system.save_for_later && store.system.save_for_later.items || []).length;
    const favCount = (store.system && store.system.favorites && store.system.favorites.items || []).length;
    const qq = getDevQueue();

    h += '<div class="playlist-system-row">' +
      '<button type="button" class="playlist-pill' + (activePid === 'history' ? ' active' : '') + '" onclick="devSelectPlaylist(&quot;history&quot;)">🕒 History (' + histCount + ')</button>' +
      '<button type="button" class="playlist-pill' + (activePid === 'save_for_later' ? ' active' : '') + '" onclick="devSelectPlaylist(&quot;save_for_later&quot;)">' + getSaveIcon() + ' Save for later (' + laterCount + ')</button>' +
      '<button type="button" class="playlist-pill' + (activePid === 'favorites' ? ' active' : '') + '" onclick="devSelectPlaylist(&quot;favorites&quot;)">⭐ Favorites (' + favCount + ')</button>' +
      '<button type="button" class="playlist-pill' + (activePid === 'queue' ? ' active' : '') + '" onclick="devSelectPlaylist(&quot;queue&quot;)">📋 Queue (' + qq.length + ')</button>' +
      '<button type="button" class="playlist-pill" onclick="devPromptNewPlaylist()">➕ New Playlist</button>' +
      '</div>';

    // Row 2: Custom Playlists & Subscriptions
    const customKeys = Object.keys(store.custom || {});
    let customPills = '';
    if (customKeys.length === 0) {
      customPills = '<span style="font-size:12px; color:var(--text-muted); padding:4px 0;">No custom playlists yet. Tap &ldquo;➕ New Playlist&rdquo; to create one, or browse Public Playlists.</span>';
    } else {
      customPills = customKeys.map(pid => {
        const p = store.custom[pid];
        if (!p) return '';
        const n = (p.items || []).length;
        const isSub = !!p.isSubscription;
        const icon = isSub ? '📡' : (p.icon || '📁');
        const cls = 'playlist-pill' + (isSub ? ' subscription-pill' : '') + (pid === activePid ? ' active' : '');
        return '<button type="button" class="' + cls + '" onclick="devSelectPlaylist(&quot;' + escapeHtml(pid) + '&quot;);">' +
          escapeHtml(icon) + ' ' + escapeHtml(p.name) + ' (' + n + ')</button>';
      }).join('');
    }

    h += '<div class="playlist-custom-row">' +
      '<div class="playlist-row-caption">My Playlists &amp; Subscriptions</div>' +
      customPills +
      '</div>';

    return h;
  }
  window.devPlaylistsHeaderHtml = devPlaylistsHeaderHtml;

  // ---- Playlist tab deep-linking (reload-safe + shareable) ----
  // Namespaced pl* keys so shiur-search params (search/sort/...) never collide.
  const PL_URL_KEYS = ['tab', 'pl', 'plq', 'plteachers', 'plvenues', 'pltopics', 'plscope', 'plsort'];

  function clearPlaylistUrlKeys(url) {
    try {
      PL_URL_KEYS.forEach(k => url.searchParams.delete(k));
    } catch (e) {}
    return url;
  }

  function syncPlaylistUrl() {
    try {
      const tabEl = document.getElementById('tab-playlists');
      const tabActive = !!(tabEl && tabEl.classList.contains('active'));
      const url = new URL(window.location.href);
      clearPlaylistUrlKeys(url);
      if (tabActive) {
        url.searchParams.set('tab', 'playlists');
        let plVal = activeDevPlaylistId || 'history';
        try {
          const store = getDevStore();
          const pl = getDevPlaylist(store, plVal);
          if (pl && (pl.publicId || pl.subscribedPublicId)) {
            plVal = pl.publicId || pl.subscribedPublicId;
          }
        } catch (e) {}
        url.searchParams.set('pl', plVal);
        if ((plPublicQuery || '').trim()) url.searchParams.set('plq', plPublicQuery.trim());
        (plPublicFilterTags.teachers || []).forEach(t => { if (t && (t.name || t.id)) url.searchParams.append('plteachers', t.name || t.id); });
        (plPublicFilterTags.venues || []).forEach(v => { if (v && (v.name || v.id)) url.searchParams.append('plvenues', v.name || v.id); });
        (plPublicFilterTags.topics || []).forEach(t => { if (t && (t.name || t.id)) url.searchParams.append('pltopics', t.name || t.id); });
        const sc = [];
        if (plPublicScope.title) sc.push('title');
        if (plPublicScope.desc) sc.push('desc');
        if (plPublicScope.shiurim) sc.push('shiurim');
        if (sc.join(',') !== 'title,desc') url.searchParams.set('plscope', sc.join(','));
        if (plPublicSort === 'saves') url.searchParams.set('plsort', 'saves');
      }
      history.replaceState(history.state, '', url.toString());
    } catch (e) {}
  }

  async function devLoadSharedPublicPlaylist(publicId) {
    if (!publicId) return;
    try {
      const cleanId = publicId.startsWith('pub_') ? publicId.slice(4) : publicId;
      const res = await fetch('/api/playlists/items?id=' + encodeURIComponent(cleanId));
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.items) return;
      const store = getDevStore();
      const meta = data.playlist || {};
      const customId = 'pub_' + cleanId;
      store.custom[customId] = {
        id: customId,
        name: meta.title || 'Shared Playlist',
        description: meta.description || '',
        ownerName: meta.ownerName || 'Community',
        tags: meta.tags || { teachers: [], venues: [], topics: [] },
        isSubscription: true,
        subscribedPublicId: cleanId,
        publicId: cleanId,
        icon: meta.icon || '📁',
        items: data.items,
        lastSyncedAt: Date.now()
      };
      saveDevStore(store);
      if (activeDevPlaylistId === publicId || activeDevPlaylistId === cleanId) {
        activeDevPlaylistId = customId;
        syncPlaylistUrl();
        renderPlaylistsGrid();
      }
    } catch (e) {}
  }
  window.devLoadSharedPublicPlaylist = devLoadSharedPublicPlaylist;

  function devSharePlaylist(pid) {
    try {
      const store = getDevStore();
      const pl = getDevPlaylist(store, pid);
      if (!pl) return;
      const shareUrl = new URL(window.location.origin);
      shareUrl.searchParams.set('tab', 'playlists');
      const shareId = pl.publicId || pl.subscribedPublicId || pl.id;
      shareUrl.searchParams.set('pl', shareId);
      const str = shareUrl.toString();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(() => {
          if (pl.publicId || pl.subscribedPublicId) {
            flashToast('📋 Playlist link copied to clipboard!', false, false);
          } else {
            flashToast('📋 Link copied! (Tip: Publish this playlist so others can see it too)', false, false);
          }
        }).catch(() => {
          prompt('Copy playlist link:', str);
        });
      } else {
        prompt('Copy playlist link:', str);
      }
    } catch (e) {}
  }
  window.devSharePlaylist = devSharePlaylist;

  function plSharePublicSearch() {
    try {
      const url = window.location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          flashToast('📋 Public search link copied to clipboard!', false, false);
        }).catch(() => {
          prompt('Copy search link:', url);
        });
      } else {
        prompt('Copy search link:', url);
      }
    } catch (e) {}
  }
  window.plSharePublicSearch = plSharePublicSearch;

  function readPlaylistUrlState() {
    // Restores public-search vars (validated) + active playlist from the URL.
    // Returns { pid } when ?tab=playlists, else null.
    try {
      const bp = new URLSearchParams(window.location.search);
      if (bp.get('tab') !== 'playlists') return null;
      const multi = (k) => {
        const out = [];
        bp.getAll(k).forEach(v => String(v || '').split(',').forEach(s => {
          const t = s.trim();
          if (t) out.push(t);
        }));
        return out;
      };
      plPublicQuery = bp.get('plq') || '';
      plPublicFilterDraft = { teachers: '', venues: '', topics: '' };
      plPublicFilterTags = {
        teachers: multi('plteachers').map(n => ({ id: n, name: n })),
        venues: multi('plvenues').map(n => ({ id: n, name: n })),
        topics: multi('pltopics').map(n => ({ id: n, name: n }))
      };
      const sc = (bp.get('plscope') || 'title,desc').split(',').map(s => s.trim().toLowerCase());
      plPublicScope = { title: sc.includes('title'), desc: sc.includes('desc'), shiurim: sc.includes('shiurim') };
      if (!plPublicScope.title && !plPublicScope.desc && !plPublicScope.shiurim) {
        plPublicScope = { title: true, desc: true, shiurim: false };
      }
      plPublicSort = bp.get('plsort') === 'saves' ? 'saves' : 'recent';
      let pid = bp.get('pl') || 'history';
      const specials = ['history', 'save_for_later', 'favorites', 'queue', 'public'];
      if (!specials.includes(pid)) {
        try {
          const store = getDevStore();
          const existing = getDevPlaylist(store, pid);
          if (existing) {
            pid = existing.id;
          } else {
            let matchedId = null;
            if (store.custom) {
              for (const cid in store.custom) {
                const c = store.custom[cid];
                if (c && (c.publicId === pid || c.subscribedPublicId === pid || c.id === pid)) {
                  matchedId = c.id;
                  break;
                }
              }
            }
            if (matchedId) {
              pid = matchedId;
            } else {
              const foundSeed = (typeof DEV_PUBLIC_SEEDS !== 'undefined' && DEV_PUBLIC_SEEDS.find(p => p.id === pid));
              if (foundSeed && typeof devOpenInMyPlaylists === 'function') {
                devOpenInMyPlaylists(pid);
              } else if (typeof devLoadSharedPublicPlaylist === 'function') {
                devLoadSharedPublicPlaylist(pid);
              }
            }
          }
        } catch (e) { pid = 'history'; }
      }
      activeDevPlaylistId = pid;
      return { pid: pid };
    } catch (e) { return null; }
  }

  function renderPlPublicInto(container, isGuest) {
    if (!container) return;
    try {
      if (typeof loadAutocompleteMeta === 'function' && !plTagsWarmed) {
        plTagsWarmed = true;
        loadAutocompleteMeta().then(() => {
          if (activeDevPlaylistId === 'public') renderPlaylistsGrid();
        }).catch(() => {});
      }
    } catch (e) {}
    let qhtml = '';
    if (!isGuest) {
      qhtml += devPlaylistSegmentedBarHtml(true);
    }
    qhtml += '<div id="plPublicFilterRow" style="grid-column:1/-1; display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">' +
      '<input id="plPubQ" type="text" placeholder="Search public playlists…" value="' + escapeHtml(plPublicQuery) + '"' +
      ' autocomplete="off" style="flex:2; min-width:160px; padding:8px 12px; border-radius:8px; border:1.5px solid var(--border); background:var(--card); color:var(--text);">' +
      '<div class="autocomplete-combobox" style="flex:1; min-width:140px;"><div class="chips-container" id="plPubTeacherChips"><input id="plPubTeacherInput" class="combobox-input" placeholder="Teacher..." autocomplete="off" aria-label="Filter by teacher" value="' + escapeHtml(plPublicFilterDraft.teachers || '') + '" style="flex:1; border:none; background:transparent; color:var(--text); min-width:80px;"></div><div class="autocomplete-dropdown" id="plPubTeacherDropdown"></div></div>' +
      '<div class="autocomplete-combobox" style="flex:1; min-width:140px;"><div class="chips-container" id="plPubVenueChips"><input id="plPubVenueInput" class="combobox-input" placeholder="Venue..." autocomplete="off" aria-label="Filter by venue" value="' + escapeHtml(plPublicFilterDraft.venues || '') + '" style="flex:1; border:none; background:transparent; color:var(--text); min-width:80px;"></div><div class="autocomplete-dropdown" id="plPubVenueDropdown"></div></div>' +
      '<div class="autocomplete-combobox" style="flex:1; min-width:140px;"><div class="chips-container" id="plPubTopicChips"><input id="plPubTopicInput" class="combobox-input" placeholder="Topic..." autocomplete="off" aria-label="Filter by topic" value="' + escapeHtml(plPublicFilterDraft.topics || '') + '" style="flex:1; border:none; background:transparent; color:var(--text); min-width:80px;"></div><div class="autocomplete-dropdown" id="plPubTopicDropdown"></div></div>' +
      '<select id=\"plPubSort\" style=\"padding:8px; border-radius:8px; border:1.5px solid var(--border); background:var(--card); color:var(--text);\">' +
      '<option value=\"recent\"' + (plPublicSort !== 'saves' ? ' selected' : '') + '>Recent</option>' +
      '<option value=\"saves\"' + (plPublicSort === 'saves' ? ' selected' : '') + '>Most saved</option></select>' +
      '<button type=\"button\" class=\"card-mini-btn active-save\" onclick=\"plPublicSearch()\" style=\"padding:8px 14px; font-size:14px;\">🔍 Search</button>' +
      '<button type=\"button\" class=\"card-mini-btn\" onclick=\"plSharePublicSearch()\" style=\"padding:8px 14px; font-size:14px;\" title=\"Copy shareable search link\">📋 Share Search</button></div>';

    qhtml += '<div style="grid-column:1/-1; display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin:-4px 0 12px; font-size:12.5px; color:var(--text);">' +
      '<span style="font-weight:700; color:var(--text-muted);">Search in:</span>' +
      '<label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; font-weight:600;">' +
      '<input type="checkbox" id="plScopeTitle"' + (plPublicScope.title ? ' checked' : '') + ' style="accent-color:var(--primary); cursor:pointer;"> Playlist title and tags</label>' +
      '<label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; font-weight:600;">' +
      '<input type="checkbox" id="plScopeDesc"' + (plPublicScope.desc ? ' checked' : '') + ' style="accent-color:var(--primary); cursor:pointer;"> Playlist description</label>' +
      '<label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; font-weight:600;">' +
      '<input type="checkbox" id="plScopeShiurim"' + (plPublicScope.shiurim ? ' checked' : '') + ' style="accent-color:var(--primary); cursor:pointer;"> Shiurim inside the playlists</label>' +
      '</div>';

    qhtml += '<div id="plPublicActiveBar" style="grid-column:1/-1; display:contents;">' + plActiveFilterBarHtml() + '</div>';
    qhtml += '<div id="plPublicResultsWrap" style="grid-column:1/-1; display:contents;">' + plPublicResultsHtml() + '</div>';
    const activeEl = document.activeElement;
    const activeId = activeEl && activeEl.id ? activeEl.id : '';
    const isPlPubFocus = activeId === 'plPubQ' || activeId === 'plPubTeacherInput' || activeId === 'plPubVenueInput' || activeId === 'plPubTopicInput';
    const selStart = isPlPubFocus ? activeEl.selectionStart : null;
    const selEnd = isPlPubFocus ? activeEl.selectionEnd : null;

    container.innerHTML = qhtml;
    const qq = container.querySelector('#plPubQ');
    if (qq) {
      if (activeId === 'plPubQ') {
        qq.focus();
        if (selStart !== null && selEnd !== null) {
          try { qq.setSelectionRange(selStart, selEnd); } catch (e) {}
        }
      }
      qq.addEventListener('keydown', e => { if (e.key === 'Enter') plPublicSearch(); });
      const deb = { t: null };
      qq.addEventListener('input', () => {
        clearTimeout(deb.t);
        deb.t = setTimeout(() => {
          plPublicQuery = qq.value;
          plSearchPublicResultsOnly();
        }, 350);
      });
    }
    const setupPlFilter = (inputId, chipsId, dropdownId, kind) => {
      const input = document.getElementById(inputId);
      const chips = document.getElementById(chipsId);
      const dropdown = document.getElementById(dropdownId);
      if (!input || !chips || !dropdown) return;
      plRenderFilterTokens(kind);
      chips.addEventListener('click', () => { try { input.focus(); } catch (e) {} });
      let t = null;
      input.addEventListener('input', () => {
        plPublicFilterDraft[kind] = input.value || '';
        clearTimeout(t);
        t = setTimeout(() => { plPaintFilterDropdown(kind); }, 120);
      });
      const pickFromEvent = (e) => {
        const it = e.target && e.target.closest ? e.target.closest('.autocomplete-item') : null;
        if (!it) return false;
        const id = it.getAttribute('data-id');
        const name = it.getAttribute('data-name');
        if (id && name) {
          plPickFilterTag(kind, id, name);
          return true;
        }
        return false;
      };
      dropdown.addEventListener('mousedown', e => {
        e.preventDefault();
        pickFromEvent(e);
      });
      dropdown.addEventListener('click', e => { pickFromEvent(e); });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = dropdown.querySelector('.autocomplete-item');
          if (first) {
            const id = first.getAttribute('data-id');
            const name = first.getAttribute('data-name');
            if (id && name) { plPickFilterTag(kind, id, name); return; }
          }
          const v = (input.value || '').trim().toLowerCase();
          if (!v) return;
          const m = plTagOptions(kind).find(o => String(o.name || '').toLowerCase() === v);
          if (m) plPickFilterTag(kind, m.id || m.name, m.name);
        } else if (e.key === 'Escape') {
          dropdown.style.display = 'none';
          dropdown.innerHTML = '';
          if (plPublicOpenKind === kind) plPublicOpenKind = null;
        } else if (e.key === 'Backspace' && input.value === '') {
          const arr = plPublicFilterTags[kind] || [];
          if (arr.length > 0) plRemoveFilterTag(kind, arr.length - 1);
        }
      });
      input.addEventListener('focus', () => {
        if ((input.value || '').trim().length > 0) plPaintFilterDropdown(kind);
      });
      input.addEventListener('blur', () => setTimeout(() => {
        if (plPublicOpenKind !== kind) return;
        dropdown.style.display = 'none';
        plPublicOpenKind = null;
      }, 120));
    };
    setupPlFilter('plPubTeacherInput', 'plPubTeacherChips', 'plPubTeacherDropdown', 'teachers');
    setupPlFilter('plPubVenueInput', 'plPubVenueChips', 'plPubVenueDropdown', 'venues');
    setupPlFilter('plPubTopicInput', 'plPubTopicChips', 'plPubTopicDropdown', 'topics');
    plRenderAllFilterTokens();
    if (activeId === 'plPubTeacherInput' || activeId === 'plPubVenueInput' || activeId === 'plPubTopicInput') {
      const refocus = document.getElementById(activeId);
      if (refocus) {
        try {
          refocus.focus();
          if (selStart !== null && selEnd !== null && refocus.value) refocus.setSelectionRange(selStart, selEnd);
        } catch (e) {}
      }
    }
    // plPubTeacher/Venue/Topic are Advanced-style comboboxes handled by
    // setupPlFilter above (multi-select into plPublicFilterTags, results-only patch).
    const chkTitle = container.querySelector('#plScopeTitle');
    const chkDesc = container.querySelector('#plScopeDesc');
    const chkShiurim = container.querySelector('#plScopeShiurim');
    const guardScope = (el) => {
      if (!plPublicScope.title && !plPublicScope.desc && !plPublicScope.shiurim) {
        if (el) el.checked = true;
        if (el === chkTitle) plPublicScope.title = true;
        else if (el === chkDesc) plPublicScope.desc = true;
        else if (el === chkShiurim) plPublicScope.shiurim = true;
        flashToast('⚠️ At least one scope must stay checked', true, false);
      }
    };
    if (chkTitle) chkTitle.addEventListener('change', () => { plPublicScope.title = chkTitle.checked; guardScope(chkTitle); plPublicSearch(); });
    if (chkDesc) chkDesc.addEventListener('change', () => { plPublicScope.desc = chkDesc.checked; guardScope(chkDesc); plPublicSearch(); });
    if (chkShiurim) chkShiurim.addEventListener('change', () => { plPublicScope.shiurim = chkShiurim.checked; guardScope(chkShiurim); plPublicSearch(); });
    const sortEl = container.querySelector('#plPubSort');
    if (sortEl) sortEl.addEventListener('change', () => { plPublicSort = sortEl.value; plPublicSearch(); });
    if (plPublicExpanded) plPublicRenderItems(plPublicExpanded);
    if (plPublicResults.length === 0 && !plPublicQuery && plPublicTotal === 0) {
      plSearchPublic();
    }
  }

  function devItemDateTimestamp(it) {
    if (!it) return 0;
    if (it.dateISO) {
      const d = parseLocalDate(it.dateISO);
      if (d && !isNaN(d.getTime())) return d.getTime();
    }
    if (it.date) {
      const d = parseLocalDate(it.date);
      if (d && !isNaN(d.getTime())) return d.getTime();
    }
    return 0;
  }
  window.devItemDateTimestamp = devItemDateTimestamp;

  function devGetPlaylistSort(pid) {
    try {
      const store = getDevStore();
      const pl = getDevPlaylist(store, pid);
      if (pl && pl.sortOrder) return pl.sortOrder;
      const v = localStorage.getItem('yutorah_pl_sort_' + pid);
      if (v) return v;
    } catch (e) {}
    if (pid === 'history') {
      try {
        const hs = localStorage.getItem('yutorah_history_sort');
        if (hs === 'shiurdate') return 'date_desc';
      } catch (e) {}
      return 'listened';
    }
    return 'added';
  }
  window.devGetPlaylistSort = devGetPlaylistSort;

  function devSetPlaylistSort(pid, sort) {
    try {
      localStorage.setItem('yutorah_pl_sort_' + pid, sort);
      if (pid === 'history') {
        localStorage.setItem('yutorah_history_sort', (sort === 'date_desc' || sort === 'shiurdate') ? 'shiurdate' : 'listened');
      }
      const store = getDevStore();
      if (store && store.custom && store.custom[pid]) {
        store.custom[pid].sortOrder = sort;
        saveDevStore(store);
      } else if (store && store.system && store.system[pid]) {
        store.system[pid].sortOrder = sort;
        saveDevStore(store);
      }
    } catch (e) {}
    renderPlaylistsGrid();
  }
  window.devSetPlaylistSort = devSetPlaylistSort;

  let devDragSrcIndex = null;
  let devDragPlId = null;

  function devDragStart(e, pid, idx) {
    devDragPlId = pid;
    devDragSrcIndex = idx;
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    } catch (err) {}
    if (e.currentTarget) e.currentTarget.classList.add('dragging');
  }
  window.devDragStart = devDragStart;

  function devDragOver(e) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
    if (e.currentTarget) e.currentTarget.classList.add('drag-over');
  }
  window.devDragOver = devDragOver;

  function devDragLeave(e) {
    if (e.currentTarget) e.currentTarget.classList.remove('drag-over');
  }
  window.devDragLeave = devDragLeave;

  function devDropItem(e, pid, targetIdx) {
    e.preventDefault();
    if (e.currentTarget) e.currentTarget.classList.remove('drag-over');
    if (devDragPlId !== pid || devDragSrcIndex === null || devDragSrcIndex === targetIdx) return;
    devReorderPlaylistItem(pid, devDragSrcIndex, targetIdx);
    devDragSrcIndex = null;
    devDragPlId = null;
  }
  window.devDropItem = devDropItem;

  function devDragEnd(e) {
    devDragPlId = null;
    devDragSrcIndex = null;
    document.querySelectorAll('.playlist-item-wrap.dragging').forEach(el => el.classList.remove('dragging'));
    document.querySelectorAll('.playlist-item-wrap.drag-over').forEach(el => el.classList.remove('drag-over'));
  }
  window.devDragEnd = devDragEnd;

  function devMovePlaylistItem(pid, fromIdx, delta) {
    devReorderPlaylistItem(pid, fromIdx, fromIdx + delta);
  }
  window.devMovePlaylistItem = devMovePlaylistItem;

  function devReorderPlaylistItem(pid, fromIdx, toIdx) {
    const store = getDevStore();
    let pl = store.custom && store.custom[pid];
    if (!pl && store.system && store.system[pid]) pl = store.system[pid];
    if (!pl || !pl.items || pl.isSubscription) return;
    if (fromIdx < 0 || fromIdx >= pl.items.length || toIdx < 0 || toIdx >= pl.items.length) return;

    // Materialize current sort order into raw items before moving if non-manual
    const sort = devGetPlaylistSort(pid);
    if (sort !== 'manual') {
      let sortedItems = [...pl.items];
      if (sort === 'date_desc') {
        sortedItems.sort((a, b) => {
          const diff = devItemDateTimestamp(b) - devItemDateTimestamp(a);
          return diff !== 0 ? diff : String(b.id || '').localeCompare(String(a.id || ''));
        });
      } else if (sort === 'date_asc') {
        sortedItems.sort((a, b) => {
          const diff = devItemDateTimestamp(a) - devItemDateTimestamp(b);
          return diff !== 0 ? diff : String(a.id || '').localeCompare(String(b.id || ''));
        });
      } else if (sort === 'added') {
        sortedItems.sort((a, b) => ((b.addedAt || 0) - (a.addedAt || 0)));
      }
      pl.items = sortedItems;
    }

    pl.sortOrder = 'manual';
    try { localStorage.setItem('yutorah_pl_sort_' + pid, 'manual'); } catch (e) {}
    const moved = pl.items.splice(fromIdx, 1)[0];
    pl.items.splice(toIdx, 0, moved);
    saveDevStore(store);
    renderPlaylistsGrid();
  }
  window.devReorderPlaylistItem = devReorderPlaylistItem;

  function renderPlaylistsGrid() {
    const grid = document.getElementById('grid-playlists');
    if (!grid) return;
    if (!playlistsEnabled()) {
      grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:34px 20px 10px; color:var(--text-muted);">' +
        '<div style="font-size:34px; margin-bottom:10px;">🎧</div>' +
        '<div style="font-weight:800; font-size:16px; margin-bottom:6px; color:var(--text);">Your Playlists Live Here</div>' +
        '<div style="font-size:13px; max-width:420px; margin:0 auto 14px;">Log in to create playlists, save for later, pick favorites, and use the play queue — synced across all your devices.</div>' +
        '<button type="button" class="card-mini-btn" onclick="handleAuthClick()">🔑 Log in with Google</button></div>' +
        '<div id="plGuestPublic" style="grid-column:1/-1; display:contents;"></div>';
      activeDevPlaylistId = 'public';
      const host = document.getElementById('plGuestPublic');
      if (host) renderPlPublicInto(host, true);
      return;
    }
    const store = getDevStore();
    // Public browser pseudo-view (browse + save other people's lists).
    if (activeDevPlaylistId === 'public') {
      renderPlPublicInto(grid, false);
      return;
    }
    // Queue pseudo-view ('queue' is not a stored playlist).
    if (activeDevPlaylistId === 'queue') {
      const qq = getDevQueue();
      let qhtml = devPlaylistsHeaderHtml(store, 'queue');
      qhtml += '<div class="search-results-subheading"><span>📋</span><span>Play Queue</span>' +
        '<span class="sub-count">' + qq.length + (qq.length === 1 ? ' item' : ' items') + ' · auto-plays next</span></div>';
      if (qq.length > 0) {
        qhtml += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:8px;">' +
          '<button type="button" class="card-mini-btn" onclick="devPlayNextFromQueue()">▶ Play Next Now</button>' +
          '<button type="button" class="card-mini-btn" onclick="devQueueClear()">Clear Queue</button></div>';
      }
      qhtml += '<div style="grid-column:1/-1;">' + devQueueListHtml() + '</div>';
      grid.innerHTML = qhtml;
      return;
    }
    if (!getDevPlaylist(store, activeDevPlaylistId)) activeDevPlaylistId = 'history';
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    let html = devPlaylistsHeaderHtml(store, activeDevPlaylistId);
    let items = (pl && pl.items) || [];
    const canReorder = !pl.isHistory && !pl.isSubscription;
    const sort = devGetPlaylistSort(pl.id);

    // Apply sorting
    if (pl.isHistory) {
      if (sort === 'date_desc' || sort === 'shiurdate') {
        items = [...items].sort((a, b) => {
          const diff = devItemDateTimestamp(b) - devItemDateTimestamp(a);
          return diff !== 0 ? diff : String(b.id || '').localeCompare(String(a.id || ''));
        });
      } else if (sort === 'date_asc') {
        items = [...items].sort((a, b) => {
          const diff = devItemDateTimestamp(a) - devItemDateTimestamp(b);
          return diff !== 0 ? diff : String(a.id || '').localeCompare(String(b.id || ''));
        });
      }
      // 'listened': original array order preserved
    } else {
      if (sort === 'date_desc') {
        items = [...items].sort((a, b) => {
          const diff = devItemDateTimestamp(b) - devItemDateTimestamp(a);
          return diff !== 0 ? diff : String(b.id || '').localeCompare(String(a.id || ''));
        });
      } else if (sort === 'date_asc') {
        items = [...items].sort((a, b) => {
          const diff = devItemDateTimestamp(a) - devItemDateTimestamp(b);
          return diff !== 0 ? diff : String(a.id || '').localeCompare(String(b.id || ''));
        });
      } else if (sort === 'added') {
        items = [...items].sort((a, b) => ((b.addedAt || 0) - (a.addedAt || 0)));
      }
      // 'manual': raw array order preserved
    }

    // Sort order row
    let sortRowHtml = '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
      '<span style="font-size:12px; font-weight:700; color:var(--text-muted);">↕️ Order:</span>';
    if (pl.isHistory) {
      sortRowHtml += '<button type="button" class="card-mini-btn' + (sort === 'listened' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;history&quot;, &quot;listened&quot;)">🕒 Last Listened</button>' +
        '<button type="button" class="card-mini-btn' + (sort === 'date_desc' || sort === 'shiurdate' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;history&quot;, &quot;date_desc&quot;)">📅 Shiur Date (Newest)</button>' +
        '<button type="button" class="card-mini-btn' + (sort === 'date_asc' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;history&quot;, &quot;date_asc&quot;)">📅 Shiur Date (Oldest)</button>';
    } else {
      sortRowHtml += (canReorder ? '<button type="button" class="card-mini-btn' + (sort === 'manual' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;' + escapeHtml(pl.id) + '&quot;, &quot;manual&quot;)" title="Manual / Drag-and-Drop">↕️ Custom Order</button>' : '') +
        '<button type="button" class="card-mini-btn' + (sort === 'added' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;' + escapeHtml(pl.id) + '&quot;, &quot;added&quot;)">🕒 Recently Added</button>' +
        '<button type="button" class="card-mini-btn' + (sort === 'date_desc' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;' + escapeHtml(pl.id) + '&quot;, &quot;date_desc&quot;)">📅 Shiur Date (Newest)</button>' +
        '<button type="button" class="card-mini-btn' + (sort === 'date_asc' ? ' active-save' : '') + '" onclick="devSetPlaylistSort(&quot;' + escapeHtml(pl.id) + '&quot;, &quot;date_asc&quot;)">📅 Shiur Date (Oldest)</button>';
    }
    sortRowHtml += '</div>';
    if (canReorder) {
      sortRowHtml += '<div style="grid-column:1/-1; margin:-4px 0 10px; font-size:12px; color:var(--text-muted);">💡 <b>Reorder</b>: Drag cards or use the ▲ / ▼ buttons below each card to position shiurim.</div>';
    }
    html += sortRowHtml;

    html += '<div class="search-results-subheading"><span>' + escapeHtml((pl && pl.isSubscription ? '📡' : ((pl && pl.icon) || '📁'))) + '</span>' +
      '<span>' + escapeHtml((pl && pl.name) || '') + '</span>' +
      '<span class="sub-count">' + items.length + ' Shiurim • ' + escapeHtml(devTotalDuration(items)) + '</span></div>';
    if (!pl.isHistory && !store.system[pl.id]) {
      if (pl.isSubscription) {
        html += '<div style="grid-column:1/-1; margin-bottom:4px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">' +
          '<span class="active-filter-pill" style="background:#e0f2fe; color:#0369a1; border-color:#7dd3fc;">📡 Subscribed · Live Sync</span>' +
          '<span class="active-filter-pill" style="background:#fef3c7; color:#92400e; border-color:#fcd34d;">🔒 Read-Only</span>' +
          (pl.ownerName ? '<span style="font-size:12px; color:var(--text-muted);">by ' + escapeHtml(pl.ownerName) + '</span>' : '') +
          '</div>';
        if (pl.description) {
          html += '<div style="grid-column:1/-1; margin-bottom:8px; font-size:13px; color:var(--text-muted);">' + escapeHtml(pl.description) + '</div>';
        }
        html += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:8px; flex-wrap:wrap;">' +
          '<button type="button" class="card-mini-btn" onclick="playDevPlaylistAll()">▶ Play All</button>' +
          '<button type="button" class="card-mini-btn"' + (items.length < 2 ? ' disabled aria-disabled="true" title="Add at least 2 items to shuffle"' : ' aria-label="Shuffle playlist" title="Play in random order"') + ' onclick="playDevPlaylistShuffled()">🔀 Shuffle</button>' +
          '<button type="button" class="card-mini-btn" onclick="devQueuePlaylistToTop()" title="Add playlist to top of queue">⏫ Queue to Top</button>' +
          '<button type="button" class="card-mini-btn" onclick="devSharePlaylist(&quot;' + escapeHtml(pl.id) + '&quot;)" title="Share playlist link">📋 Share</button>' +
          '<button type="button" class="card-mini-btn" onclick="devSyncSubscribedPlaylist(&quot;' + escapeHtml(pl.id) + '&quot;, true)">🔄 Check for Updates</button>' +
          '<button type="button" class="card-mini-btn" onclick="devCloneSubscriptionToCopy(&quot;' + escapeHtml(pl.id) + '&quot;)">📋 Make Editable Copy</button>' +
          '<button type="button" class="card-mini-btn" onclick="devExportPlaylist()">Export JSON</button>' +
          '<button type="button" class="card-mini-btn" onclick="devUnfollowPlaylist(&quot;' + escapeHtml(pl.id) + '&quot;)">Unfollow Playlist</button></div>';

        if (!pl._syncing && (Date.now() - (pl.lastSyncedAt || 0) > 30000)) {
          setTimeout(() => devSyncSubscribedPlaylist(pl.id, false), 100);
        }
      } else {
        const visTag = pl.publicId
          ? '<span class="active-filter-pill">🌍 Public</span>'
          : '<span class="active-filter-pill">🔒 Private</span>';
        html += '<div style="grid-column:1/-1; margin-bottom:4px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">' + visTag;
        const pTags = pl.tags && typeof pl.tags === 'object' ? pl.tags : null;
        const tagBits = pTags ? []
          .concat((pTags.teachers || []).map(t => '👤 ' + t.name))
          .concat((pTags.venues || []).map(t => '📍 ' + t.name))
          .concat((pTags.topics || []).map(t => '🏷️ ' + t.name)) : [];
        if (tagBits.length > 0) {
          html += '<span style="font-size:12px; color:var(--text-muted);">' + tagBits.map(escapeHtml).join(' · ') + '</span>';
        }
        html += '</div>';
        if (pl.description) {
          html += '<div style="grid-column:1/-1; margin-bottom:8px; font-size:13px; color:var(--text-muted);">' + escapeHtml(pl.description) + '</div>';
        }
        html += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:8px; flex-wrap:wrap;">' +
          '<button type="button" class="card-mini-btn" onclick="playDevPlaylistAll()">▶ Play All</button>' +
          '<button type="button" class="card-mini-btn"' + (items.length < 2 ? ' disabled aria-disabled="true" title="Add at least 2 items to shuffle"' : ' aria-label="Shuffle playlist" title="Play in random order"') + ' onclick="playDevPlaylistShuffled()">🔀 Shuffle</button>' +
          '<button type="button" class="card-mini-btn" onclick="devQueuePlaylistToTop()" title="Add playlist to top of queue">⏫ Queue to Top</button>' +
          '<button type="button" class="card-mini-btn" onclick="devSharePlaylist(&quot;' + escapeHtml(pl.id) + '&quot;)" title="Share playlist link">📋 Share</button>' +
          '<button type="button" class="card-mini-btn" onclick="devExportPlaylist()">Export JSON</button>' +
          '<button type="button" class="card-mini-btn" onclick="openPlaylistDetailsModal()">📝 Details & Tags</button>';
        if (pl.publicId) {
          html += '<button type="button" class="card-mini-btn" onclick="plUnpublishCurrent()">Unpublish</button>';
        } else {
          html += '<button type="button" class="card-mini-btn" onclick="plPublishCurrent(true)">🌍 Publish</button>';
        }
        html += '<button type="button" class="card-mini-btn" onclick="devDeletePlaylist()">Delete Playlist</button></div>';
      }
    } else if (items.length > 0) {
      html += '<div style="grid-column:1/-1; margin-bottom:8px; display:flex; gap:6px; flex-wrap:wrap;"><button type="button" class="card-mini-btn" onclick="playDevPlaylistAll()">▶ Play All</button><button type="button" class="card-mini-btn"' + (items.length<2 ? ' disabled aria-disabled="true" title="Add at least 2 items to shuffle"' : ' aria-label="Shuffle playlist" title="Play in random order"') + ' onclick="playDevPlaylistShuffled()">🔀 Shuffle</button><button type="button" class="card-mini-btn" onclick="devQueuePlaylistToTop()" title="Add playlist to top of queue">⏫ Queue to Top</button><button type="button" class="card-mini-btn" onclick="devSharePlaylist(&quot;' + escapeHtml(pl.id) + '&quot;)" title="Share playlist link">📋 Share</button></div>';
    }
    if (items.length === 0) {
      html += '<div style="grid-column:1/-1; text-align:center; padding:30px; color:var(--text-muted);">Empty playlist — tap 🕒 Save for later, ☆ Fav or ➕ Playlist on any card to add shiurim.</div>';
    } else {
      html += items.map((item, idx) => {
        const iid = String(item.id);
        const canRemove = !pl.isSubscription;
        const dragAttrs = canReorder
          ? ' draggable="true" ondragstart="devDragStart(event, &quot;' + escapeHtml(pl.id) + '&quot;, ' + idx + ')" ondragover="devDragOver(event)" ondragleave="devDragLeave(event)" ondrop="devDropItem(event, &quot;' + escapeHtml(pl.id) + '&quot;, ' + idx + ')" ondragend="devDragEnd(event)"'
          : '';
        return '<div class="playlist-item-wrap"' + dragAttrs + '>' +
          renderDocToCard(item) +
          (canRemove ? '<div style="margin-top:6px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
          '<button type="button" class="card-mini-btn" data-dev-remove="' + pl.id + ':' + iid + '"' +
          ' onclick="devAskRemove(&quot;' + escapeHtml(pl.id) + '&quot;, &quot;' + escapeHtml(iid) + '&quot;)">✕ Remove from Playlist</button>' +
          (canReorder ?
            '<span style="display:inline-flex; gap:4px; align-items:center; margin-left:auto;">' +
            '<button type="button" class="playlist-reorder-btn"' + (idx === 0 ? ' disabled' : '') + ' onclick="devMovePlaylistItem(&quot;' + escapeHtml(pl.id) + '&quot;, ' + idx + ', -1)" title="Move Up" aria-label="Move Up">▲</button>' +
            '<button type="button" class="playlist-reorder-btn"' + (idx === items.length - 1 ? ' disabled' : '') + ' onclick="devMovePlaylistItem(&quot;' + escapeHtml(pl.id) + '&quot;, ' + idx + ', 1)" title="Move Down" aria-label="Move Down">▼</button>' +
            '<span style="cursor:grab; font-size:16px; opacity:0.75; padding:0 4px; user-select:none;" title="Drag to reorder">⠿</span>' +
            '</span>' : '') +
          '</div>' : '') + '</div>';
      }).join('');
    }
    grid.innerHTML = html;
  }

  function devPromptNewPlaylist() {
    closeConfirmModal();
    const overlay = document.createElement('div');
    overlay.id = 'newPlaylistModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Create New Playlist');

    // Warm tag metadata if needed
    if (typeof loadAutocompleteMeta === 'function' && (!autocompleteCache || !autocompleteData)) {
      loadAutocompleteMeta().catch(() => {});
    }

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:440px; width:100%; max-height:86vh; overflow-y:auto; padding:18px; border:1px solid var(--border-light); box-shadow:0 12px 36px rgba(0,0,0,0.25);';

    let selectedIcon = '📁';
    const EMOJI_OPTIONS = ['📁', '🎧', '📚', '🕯️', '📜', '⭐', '💎', '🕊️', '🕍', '📖', '🎙️', '🧠', '✨', '🔥', '🎓', '🏷️'];
    const plTags = { teachers: [], venues: [], topics: [] };

    box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">' +
      '<div style="font-weight:800; font-size:16px; display:flex; align-items:center; gap:8px;">' +
      '<span id="newPlIconPreview" style="font-size:22px;">📁</span><span>Create New Playlist</span></div>' +
      '<button type="button" class="card-mini-btn" id="newPlClose" aria-label="Close dialog" style="padding:4px 8px;">✕</button></div>' +

      '<label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:4px;">Choose Icon</label>' +
      '<div id="newPlEmojiGrid" class="new-pl-emoji-grid">' +
      EMOJI_OPTIONS.map(em =>
        '<button type="button" class="new-pl-emoji-btn' + (em === selectedIcon ? ' selected' : '') + '" data-emoji="' + em + '" aria-label="Select ' + em + ' icon" aria-pressed="' + (em === selectedIcon ? 'true' : 'false') + '">' + em + '</button>'
      ).join('') + '</div>' +

      '<label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:2px;">Playlist Name <span style="color:#ef4444;">*</span></label>' +
      '<input id="newPlInput" type="text" placeholder="e.g. In-Depth Shabbos Shiurim" maxlength="60" style="width:100%; padding:9px 12px; border-radius:8px; border:1.5px solid var(--border); background:var(--card); color:var(--text); margin-bottom:4px;">' +
      '<div id="newPlError" role="alert" aria-live="polite" style="display:none; color:#ef4444; font-size:12px; font-weight:600; margin-bottom:8px;"></div>' +

      '<label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-top:8px; margin-bottom:2px;">Description (optional)</label>' +
      '<textarea id="newPlDesc" rows="2" maxlength="300" placeholder="What is this playlist about?" style="width:100%; padding:8px 12px; border-radius:8px; border:1.5px solid var(--border); background:var(--card); color:var(--text); resize:vertical; margin-bottom:10px;"></textarea>' +

      '<label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:2px;">Taxonomy Tags (optional, max 5)</label>' +
      '<div id="newPlChips" style="display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 8px;"></div>' +
      '<div style="position:relative; margin-bottom:14px;">' +
        '<input id="newPlTagSearch" placeholder="Search speakers, venues, or topics to tag…" autocomplete="off" style="width:100%; padding:8px 12px; border-radius:8px; border:1.5px solid var(--border); background:var(--card); color:var(--text);">' +
        '<div id="newPlSuggestDropdown" class="pld-suggest-dropdown"></div>' +
      '</div>' +

      '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px; border-top:1px solid var(--border-light); padding-top:12px;">' +
        '<button type="button" class="card-mini-btn" id="newPlCancel">Cancel</button>' +
        '<button type="button" class="card-mini-btn active-save" id="newPlOk" style="padding:7px 18px; font-weight:700;">Create Playlist</button>' +
      '</div>';

    overlay.appendChild(box);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove();
      const drop = box.querySelector('#newPlSuggestDropdown');
      if (drop && (!e.target.closest || !e.target.closest('#newPlTagSearch'))) {
        drop.style.display = 'none';
      }
    });
    document.body.appendChild(overlay);

    const input = box.querySelector('#newPlInput');
    const errEl = box.querySelector('#newPlError');
    const descInput = box.querySelector('#newPlDesc');
    const tagSearch = box.querySelector('#newPlTagSearch');
    const suggestDrop = box.querySelector('#newPlSuggestDropdown');
    const iconPreview = box.querySelector('#newPlIconPreview');

    // Emoji clicks
    box.querySelectorAll('.new-pl-emoji-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedIcon = btn.getAttribute('data-emoji');
        box.querySelectorAll('.new-pl-emoji-btn').forEach(b => {
          b.classList.toggle('selected', b === btn);
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        if (iconPreview) iconPreview.textContent = selectedIcon;
      });
    });

    const getTagCount = () => plTags.teachers.length + plTags.venues.length + plTags.topics.length;

    const renderChips = () => {
      const host = box.querySelector('#newPlChips');
      if (!host) return;
      const chipHtml = (kind, list) => list.map((t, idx) =>
        '<span class="active-filter-pill">' + (kind === 'teachers' ? '👤 ' : kind === 'venues' ? '📍 ' : '🏷️ ') +
        escapeHtml(t.name) + ' <button type="button" data-del-kind="' + kind + '" data-del-idx="' + idx + '" style="background:none; border:none; color:inherit; cursor:pointer; font-weight:bold; margin-left:4px;">✕</button></span>'
      ).join('');
      host.innerHTML = chipHtml('teachers', plTags.teachers) + chipHtml('venues', plTags.venues) + chipHtml('topics', plTags.topics);
      host.querySelectorAll('button[data-del-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
          const k = btn.getAttribute('data-del-kind');
          const i = parseInt(btn.getAttribute('data-del-idx'), 10);
          if (plTags[k]) plTags[k].splice(i, 1);
          renderChips();
        });
      });
      if (tagSearch) {
        tagSearch.placeholder = getTagCount() >= 5 ? 'Max 5 tags reached' : 'Search speakers, venues, or topics to tag…';
        tagSearch.disabled = getTagCount() >= 5;
      }
    };

    // Tag autocomplete
    if (tagSearch && suggestDrop) {
      tagSearch.addEventListener('input', () => {
        const q = (tagSearch.value || '').trim().toLowerCase();
        if (!q || getTagCount() >= 5) {
          suggestDrop.style.display = 'none';
          suggestDrop.innerHTML = '';
          return;
        }
        const teachers = plTagOptions('teacher').filter(t => (t.name || '').toLowerCase().includes(q)).slice(0, 5);
        const venues = plTagOptions('venue').filter(v => (v.name || '').toLowerCase().includes(q)).slice(0, 3);
        const topics = plTagOptions('topic').filter(t => (t.name || '').toLowerCase().includes(q)).slice(0, 5);
        const all = []
          .concat(teachers.map(t => ({ kind: 'teachers', id: t.id || t.name, name: t.name, icon: '👤' })))
          .concat(venues.map(v => ({ kind: 'venues', id: v.id || v.name, name: v.name, icon: '📍' })))
          .concat(topics.map(t => ({ kind: 'topics', id: t.id || t.name, name: t.name, icon: '🏷️' })));

        if (all.length === 0) {
          suggestDrop.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:var(--text-muted);">No matching tags found</div>';
          suggestDrop.style.display = 'block';
          return;
        }
        suggestDrop.innerHTML = all.map(item => {
          const isAdded = plTags[item.kind].some(t => String(t.id) === String(item.id));
          return '<div class="pld-suggest-item" data-item-kind="' + item.kind + '" data-item-id="' + escapeHtml(item.id) + '" data-item-name="' + escapeHtml(item.name) + '">' +
            '<span>' + item.icon + ' ' + escapeHtml(item.name) + '</span>' +
            (isAdded ? '<span style="font-size:11px; color:var(--text-muted); font-weight:600;">✓ added</span>' : '') +
          '</div>';
        }).join('');
        suggestDrop.style.display = 'block';

        suggestDrop.querySelectorAll('.pld-suggest-item').forEach(el => {
          el.addEventListener('click', () => {
            const kind = el.getAttribute('data-item-kind');
            const id = el.getAttribute('data-item-id');
            const name = el.getAttribute('data-item-name');
            if (getTagCount() < 5 && !plTags[kind].some(t => String(t.id) === String(id))) {
              plTags[kind].push({ id: id, name: name });
              renderChips();
            }
            tagSearch.value = '';
            suggestDrop.style.display = 'none';
            suggestDrop.innerHTML = '';
          });
        });
      });
    }

    const validateAndSubmit = () => {
      const v = (input.value || '').trim();
      if (!v) {
        if (errEl) {
          errEl.textContent = 'Please enter a playlist name.';
          errEl.style.display = 'block';
        }
        input.focus();
        return;
      }
      if (devIsDuplicatePlaylistName(v)) {
        if (errEl) {
          errEl.textContent = 'A playlist named "' + v + '" already exists. Please choose a unique name.';
          errEl.style.display = 'block';
        }
        input.focus();
        return;
      }
      if (errEl) errEl.style.display = 'none';
      const desc = (descInput ? descInput.value : '').trim();
      devCreatePlaylist(v, selectedIcon, desc, plTags);
      renderPlaylistsGrid();
      overlay.remove();
    };

    box.querySelector('#newPlClose').addEventListener('click', () => overlay.remove());
    box.querySelector('#newPlCancel').addEventListener('click', () => overlay.remove());
    box.querySelector('#newPlOk').addEventListener('click', validateAndSubmit);
    input.addEventListener('input', () => {
      if (errEl && errEl.style.display !== 'none') errEl.style.display = 'none';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') validateAndSubmit();
      if (e.key === 'Escape') overlay.remove();
    });
    setTimeout(() => input.focus(), 60);
  }
  function closeNewPlaylistModal(){ const m=document.getElementById('newPlaylistModal'); if(m) m.remove(); }

  function playDevPlaylistAll() {
    const store = getDevStore();
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    if (pl && pl.items && pl.items.length > 0) {
      playShiurById(null, String(pl.items[0].id));
    }
  }
  function devQueuePlaylistToTop() {
    const store = getDevStore();
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    if (!pl || !pl.items || pl.items.length === 0) {
      try { flashToast('Queue is unchanged — this playlist is empty', true, false); } catch (e) {}
      return;
    }
    const curQueue = getDevQueue();
    const seen = new Set();
    try {
      for (const it of curQueue) {
        if (it && it.kind === 'series' && Array.isArray(it.items)) it.items.forEach(s => { if (s && s.id) seen.add(String(s.id)); });
        else if (it && it.id) seen.add(String(it.id));
      }
    } catch (e) {}
    const fresh = [];
    let freshCount = 0;
    for (const s of pl.items) {
      if (s && s.kind === 'series' && Array.isArray(s.items)) {
        const parts = s.items
          .filter(k => k && k.id && !seen.has(String(k.id)))
          .map(k => {
            seen.add(String(k.id));
            return {
              id: String(k.id), title: k.title, speaker: k.speaker, photo: k.photo,
              duration: k.duration, queuedAt: Date.now()
            };
          });
        if (parts.length === 0) continue;
        fresh.push({
          kind: 'series', coverId: String(s.coverId || s.seriesTitle || s.title || ''),
          seriesTitle: String(s.seriesTitle || s.title || 'Series'),
          items: parts, queuedAt: Date.now()
        });
        freshCount += parts.length;
        continue;
      }
      const sid = String((s && s.id) || '');
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      fresh.push({
        id: sid, title: s.title, speaker: s.speaker, photo: s.photo,
        duration: s.duration, date: s.date, category: s.category,
        isArticle: Boolean(s.isArticle), queuedAt: Date.now()
      });
      freshCount += 1;
    }
    if (fresh.length === 0) {
      try { flashToast('Already in queue — nothing new to add', true, false); } catch (e) {}
      return;
    }
    try {
      saveDevQueue(fresh.concat(curQueue));
    } catch (e) {}
    try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}
    try { flashToast('⏫ Added ' + freshCount + ' to top of queue', false, false); } catch (e) {}
  }
  window.devQueuePlaylistToTop = devQueuePlaylistToTop;

  function playDevPlaylistShuffled() {
    const store = getDevStore();
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    if (!pl || !pl.items || pl.items.length < 2) return;
    const shuffled = [...pl.items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    try {
      const q = shuffled.map(s => ({
        id: String(s.id), title: s.title, speaker: s.speaker, photo: s.photo,
        duration: s.duration, date: s.date, category: s.category,
        isArticle: Boolean(s.isArticle), queuedAt: Date.now()
      }));
      saveDevQueue(q);
    } catch (e) {}
    playShiurById(null, String(shuffled[0].id));
  }
  window.playDevPlaylistShuffled = playDevPlaylistShuffled;

  function devExportPlaylist() {
    const store = getDevStore();
    const pl = getDevPlaylist(store, activeDevPlaylistId);
    if (!pl) return;
    try {
      const blob = new Blob([JSON.stringify(pl, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'playlist-' + pl.id + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {}
  }

  function setHistorySort(mode) {
    try { localStorage.setItem('yutorah_history_sort', mode === 'shiurdate' ? 'shiurdate' : 'listened'); } catch (e) {}
    renderPlaylistsGrid();
  }


  async function plFetchMine() {
    if (!cloudEnabled()) return [];
    try {
      if (Date.now() - plMineCache.at < 60000 && plMineCache.list) return plMineCache.list;
      const res = await fetch('/api/playlists/mine');
      if (!res.ok) return [];
      const data = await res.json();
      plMineCache = { at: Date.now(), list: data.playlists || [] };
      return plMineCache.list;
    } catch (e) {
      return [];
    }
  }

  function plFindMine(customName) {
    return (plMineCache.list || []).filter(p =>
      String(p.title || '') === String(customName || ''));
  }

  function plPublicSearch() {
    const qq = document.getElementById('plPubQ');
    if (qq) plPublicQuery = qq.value;
    plSearchPublic();
  }

  async function plPublicToggle(id) {
    plPublicExpanded = (plPublicExpanded === id) ? null : id;
    renderPlaylistsGrid();
    if (plPublicExpanded) plPublicRenderItems(plPublicExpanded);
  }

  async function plPublicRenderItems(id) {
    const host = document.getElementById('plpub-' + id);
    if (!host) return;
    try {
      const res = await fetch('/api/playlists/items?id=' + encodeURIComponent(id));
      const data = await res.json();
      const items = (data && data.items) || [];
      if (items.length === 0) {
        host.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">No previews available.</div>';
        return;
      }
      host.innerHTML = items.slice(0, 8).map(s => {
        if (s.kind === 'series') {
          const sTitle = s.seriesTitle || s.title || 'Series';
          const count = Array.isArray(s.items) ? s.items.length : 0;
          const firstId = (s.items && s.items[0] && (s.items[0].id || s.items[0].shiurID)) || '';
          return '<div style="font-size:13.5px; padding:6px 0; border-bottom:1px solid var(--border);">' +
            (firstId ? '<a href="/' + String(firstId) + '" style="font-weight:700; color:var(--primary);">📚 ' + escapeHtml(sTitle) + '</a>' : '<span style="font-weight:700;">📚 ' + escapeHtml(sTitle) + '</span>') +
            '<div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">' + count + ' lectures in series</div></div>';
        }
        return '<div style="font-size:13.5px; padding:6px 0; border-bottom:1px solid var(--border);">' +
          '<a href="/' + String(s.id || '') + '" style="font-weight:700; color:var(--text);">' + escapeHtml(s.title || 'Untitled') + '</a>' +
          '<div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">' + escapeHtml(s.speaker || '') + '</div></div>';
      }).join('') + (items.length > 8 ? '<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">+' + (items.length - 8) + ' more after saving</div>' : '');
    } catch (e) {
      host.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Could not load preview.</div>';
    }
  }

  function plPublicParams(offset) {
    const q = new URLSearchParams();
    if (plPublicQuery.trim()) q.set('q', plPublicQuery.trim());
    (plPublicFilterTags.teachers || []).forEach(t => q.append('teachers', t.name || t.id));
    (plPublicFilterTags.venues || []).forEach(v => q.append('venues', v.name || v.id));
    (plPublicFilterTags.topics || []).forEach(tp => q.append('topics', tp.name || tp.id));
    if (plPublicTags.teacher && !(plPublicFilterTags.teachers || []).some(t => t.name === plPublicTags.teacher.name)) {
      q.append('teachers', plPublicTags.teacher.name);
    }
    if (plPublicTags.venue && !(plPublicFilterTags.venues || []).some(v => v.name === plPublicTags.venue.name)) {
      q.append('venues', plPublicTags.venue.name);
    }
    if (plPublicTags.topic && !(plPublicFilterTags.topics || []).some(tp => tp.name === plPublicTags.topic.name)) {
      q.append('topics', plPublicTags.topic.name);
    }
    q.set('scopeTitle', plPublicScope.title ? '1' : '0');
    q.set('scopeDesc', plPublicScope.desc ? '1' : '0');
    q.set('scopeShiurim', plPublicScope.shiurim ? '1' : '0');
    q.set('sort', plPublicSort === 'saves' ? 'saves' : 'recent');
    q.set('limit', String(PL_PUBLIC_PAGE));
    q.set('offset', String(offset || 0));
    return q.toString();
  }

  async function plSearchPublic() {
    const qq = document.getElementById('plPubQ');
    if (qq) plPublicQuery = qq.value;
    try {
      const ids = plFilterIds('teachers');
      const ti = document.getElementById(ids.input);
      if (ti) plPublicFilterDraft.teachers = ti.value || '';
    } catch (e) {}
    try {
      const ids = plFilterIds('venues');
      const vi = document.getElementById(ids.input);
      if (vi) plPublicFilterDraft.venues = vi.value || '';
    } catch (e) {}
    try {
      const ids = plFilterIds('topics');
      const ti = document.getElementById(ids.input);
      if (ti) plPublicFilterDraft.topics = ti.value || '';
    } catch (e) {}
    if (document.getElementById('plPublicResultsWrap')) {
      await plSearchPublicResultsOnly();
      return;
    }
    const grid = document.getElementById('grid-playlists');
    plPublicOffset = 0;
    plPublicExpanded = null;
    try {
      const res = await fetch('/api/playlists/public?' + plPublicParams(0));
      const data = await res.json();
      plPublicResults = (data && data.playlists) || [];
      plPublicTotal = (data && typeof data.total === 'number') ? data.total : plPublicResults.length;
    } catch (e) {
      plPublicResults = [];
      plPublicTotal = 0;
    }
    if (grid && activeDevPlaylistId !== 'queue') renderPlaylistsGrid();
    syncPlaylistUrl();
  }

  async function plPublicMore() {
    const next = plPublicOffset + PL_PUBLIC_PAGE;
    try {
      const res = await fetch('/api/playlists/public?' + plPublicParams(next));
      const data = await res.json();
      const more = (data && data.playlists) || [];
      if (more.length > 0) {
        plPublicOffset = next;
        plPublicResults = plPublicResults.concat(more);
        if (typeof data.total === 'number') plPublicTotal = data.total;
      }
    } catch (e) {}
    if (document.getElementById('plPublicResultsWrap')) {
      plPatchPublicResults();
      return;
    }
    renderPlaylistsGrid();
    if (plPublicExpanded) plPublicRenderItems(plPublicExpanded);
  }


  // Edit description + controlled-vocab tags for a custom playlist.
  function openPlaylistDetailsModal() {
    const store = getDevStore();
    const pl = store.custom[activeDevPlaylistId];
    if (!pl) return;
    closeConfirmModal();

    // Ensure autocomplete metadata is warmed for tag options
    if (typeof loadAutocompleteMeta === 'function' && (!autocompleteCache || !autocompleteData)) {
      loadAutocompleteMeta().catch(() => {});
    }

    const overlay = document.createElement('div');
    overlay.id = 'playlistDetailsModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Playlist details');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:440px; width:100%; max-height:84vh; overflow:auto; padding:18px; border:1px solid var(--border-light);';
    const tags = pl.tags && typeof pl.tags === 'object' ? pl.tags : { teachers: [], venues: [], topics: [] };
    const chipRow = (kind, list) => (list || []).map((t, i) =>
      '<span class="active-filter-pill">🏷️ ' + escapeHtml(t.name || '') +
      ' <button type="button" data-pld-kind="' + kind + '" data-pld-idx="' + i + '" title="Remove">✕</button></span>'
    ).join('');

    box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">' +
      '<div style="font-weight:800;">📝 Edit Playlist Details</div>' +
      '<button type="button" class="card-mini-btn" id="pldClose">Close ×</button></div>' +
      '<label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:2px;">Playlist Title</label>' +
      '<input id="pldTitle" type="text" maxlength="60" value="' + escapeHtml(pl.name || '') + '" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-light); margin:2px 0 10px;">' +
      (typeof isDevMode !== 'undefined' && isDevMode ? (
        '<label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:2px;">👤 Author / Attribution (Dev Mode)</label>' +
        '<div style="display:flex; gap:6px; margin:2px 0 10px;">' +
          '<select id="pldAuthorSelect" style="flex:1; padding:7px 10px; border-radius:8px; border:1px solid var(--border-light); background:var(--card,#fff); color:var(--text,#111);">' +
            '<option value="Andrew Ohiliote">Andrew Ohiliote</option>' +
            '<option value="Moshe Mendelwitz">Moshe Mendelwitz</option>' +
            '<option value="Rachel Sternbach">Rachel Sternbach</option>' +
            '<option value="custom">Custom Pseudonym...</option>' +
          '</select>' +
          '<input id="pldAuthorCustom" type="text" placeholder="Custom pseudonym" maxlength="40" style="flex:1; padding:7px 10px; border-radius:8px; border:1px solid var(--border-light); display:none;">' +
        '</div>'
      ) : '') +
      '<label style="font-size:12px; font-weight:700; color:var(--text-muted);">Description (optional, free text)</label>' +
      '<textarea id="pldDesc" rows="3" maxlength="500" placeholder="What is this playlist about?"' +
      ' style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-light); margin:4px 0 10px;">' +
      escapeHtml(pl.description || '') + '</textarea>' +
      '<div style="font-size:12px; font-weight:700; color:var(--text-muted);">Tags — pick from teachers, venues, topics (as you type, choose from dropdown)</div>' +
      '<div id="pldChips" style="display:flex; flex-wrap:wrap; gap:6px; margin:6px 0;">' +
      chipRow('teachers', tags.teachers) + chipRow('venues', tags.venues) + chipRow('topics', tags.topics) + '</div>' +
      ['teachers', 'venues', 'topics'].map(kind => {
        const singular = (kind === 'teachers' ? 'teacher' : kind === 'venues' ? 'venue' : 'topic');
        return '<div class="pld-tag-field" style="position:relative; margin-bottom:8px;">' +
          '<div style="display:flex; gap:6px;">' +
            '<input id="pldIn-' + kind + '" placeholder="Add ' + singular + '…" autocomplete="off"' +
            ' style="flex:1; padding:7px 10px; border-radius:8px; border:1px solid var(--border-light); background:var(--card,#fff); color:var(--text,#111);">' +
            '<button type="button" class="card-mini-btn" data-pld-add="' + kind + '">Add</button>' +
          '</div>' +
          '<div id="pldSuggest-' + kind + '" class="pld-suggest-dropdown"></div>' +
        '</div>';
      }).join('') +
      '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:10px;">' +
      '<button type="button" class="card-mini-btn active-save" id="pldSave">Save</button></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.remove();
        return;
      }
      if (!e.target.closest || !e.target.closest('.pld-tag-field')) {
        box.querySelectorAll('.pld-suggest-dropdown').forEach(d => {
          d.style.display = 'none';
          d.innerHTML = '';
        });
      }
    });
    document.body.appendChild(overlay);

    if (typeof isDevMode !== 'undefined' && isDevMode) {
      const authSel = box.querySelector('#pldAuthorSelect');
      const authCust = box.querySelector('#pldAuthorCustom');
      const currentAuthor = pl.ownerName || 'Andrew Ohiliote';
      if (['Andrew Ohiliote', 'Moshe Mendelwitz', 'Rachel Sternbach'].includes(currentAuthor)) {
        if (authSel) authSel.value = currentAuthor;
      } else {
        if (authSel) authSel.value = 'custom';
        if (authCust) {
          authCust.style.display = 'block';
          authCust.value = currentAuthor;
        }
      }
      if (authSel) {
        authSel.addEventListener('change', () => {
          if (authCust) authCust.style.display = (authSel.value === 'custom' ? 'block' : 'none');
        });
      }
    }

    const working = {
      description: pl.description || '',
      teachers: [...(tags.teachers || [])],
      venues: [...(tags.venues || [])],
      topics: [...(tags.topics || [])]
    };
    const paintChips = () => {
      const host = box.querySelector('#pldChips');
      if (host) {
        host.innerHTML = chipRow('teachers', working.teachers) + chipRow('venues', working.venues) + chipRow('topics', working.topics);
      }
    };

    const addTagItem = (kind, item) => {
      if (!item || !item.name) return;
      const itemId = String(item.id != null ? item.id : item.name);
      if (!working[kind].some(t => String(t.id) === itemId)) {
        working[kind].push({ id: itemId, name: item.name });
      }
      const inp = box.querySelector('#pldIn-' + kind);
      if (inp) {
        inp.value = '';
        inp.focus();
      }
      const suggest = box.querySelector('#pldSuggest-' + kind);
      if (suggest) {
        suggest.style.display = 'none';
        suggest.innerHTML = '';
      }
      paintChips();
    };

    // Wire up live autocomplete dropdowns for each tag input
    ['teachers', 'venues', 'topics'].forEach(kind => {
      const inp = box.querySelector('#pldIn-' + kind);
      const suggest = box.querySelector('#pldSuggest-' + kind);
      if (!inp || !suggest) return;

      let highlightedIdx = -1;

      const closeDropdown = () => {
        suggest.style.display = 'none';
        suggest.innerHTML = '';
        highlightedIdx = -1;
      };

      const renderSuggestions = (query) => {
        const q = (query || '').trim().toLowerCase();
        if (!q) {
          closeDropdown();
          return;
        }
        // Ensure options exist
        const all = plTagOptions(kind);
        if (all.length === 0 && typeof loadAutocompleteMeta === 'function') {
          loadAutocompleteMeta().then(() => {
            renderSuggestions(inp.value);
          }).catch(() => {});
          suggest.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:var(--text-muted);">Loading options…</div>';
          suggest.style.display = 'block';
          return;
        }
        const matches = all.filter(o => String(o.name || '').toLowerCase().includes(q));
        matches.sort((a, b) => {
          const an = String(a.name || '').toLowerCase();
          const bn = String(b.name || '').toLowerCase();
          if (an === q) return -1;
          if (bn === q) return 1;
          const aStarts = an.startsWith(q);
          const bStarts = bn.startsWith(q);
          if (aStarts && !bStarts) return -1;
          if (!aStarts && bStarts) return 1;
          return 0;
        });
        const top = matches.slice(0, 20);
        highlightedIdx = -1;
        if (top.length === 0) {
          suggest.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:var(--text-muted);">No matching ' + escapeHtml(kind) + ' found</div>';
          suggest.style.display = 'block';
        } else {
          suggest.innerHTML = top.map((item, idx) => {
            const isAdded = working[kind].some(t => String(t.id) === String(item.id != null ? item.id : item.name));
            return '<div class="pld-suggest-item" data-pld-pick="' + kind + '" data-pld-id="' + escapeHtml(item.id != null ? item.id : item.name) + '" data-pld-name="' + escapeHtml(item.name) + '" data-idx="' + idx + '">' +
              '<span>' + escapeHtml(item.name) + '</span>' +
              (isAdded ? '<span style="font-size:11px; color:var(--text-muted); font-weight:600;">✓ added</span>' : '') +
            '</div>';
          }).join('');
          suggest.style.display = 'block';
        }
      };

      inp.addEventListener('input', () => {
        renderSuggestions(inp.value);
      });

      inp.addEventListener('focus', () => {
        if (inp.value.trim()) renderSuggestions(inp.value);
      });

      inp.addEventListener('keydown', e => {
        if (suggest.style.display === 'block') {
          const items = suggest.querySelectorAll('.pld-suggest-item');
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (items.length > 0) {
              highlightedIdx = (highlightedIdx + 1) % items.length;
              items.forEach((it, i) => it.classList.toggle('active', i === highlightedIdx));
              items[highlightedIdx]?.scrollIntoView({ block: 'nearest' });
            }
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length > 0) {
              highlightedIdx = (highlightedIdx - 1 + items.length) % items.length;
              items.forEach((it, i) => it.classList.toggle('active', i === highlightedIdx));
              items[highlightedIdx]?.scrollIntoView({ block: 'nearest' });
            }
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeDropdown();
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightedIdx >= 0 && items[highlightedIdx]) {
              const id = items[highlightedIdx].getAttribute('data-pld-id');
              const name = items[highlightedIdx].getAttribute('data-pld-name');
              addTagItem(kind, { id, name });
            } else if (items.length > 0) {
              const id = items[0].getAttribute('data-pld-id');
              const name = items[0].getAttribute('data-pld-name');
              addTagItem(kind, { id, name });
            } else {
              const addBtn = box.querySelector('[data-pld-add="' + kind + '"]');
              if (addBtn) addBtn.click();
            }
            return;
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const addBtn = box.querySelector('[data-pld-add="' + kind + '"]');
          if (addBtn) addBtn.click();
        }
      });
    });

    box.addEventListener('click', e => {
      const pick = e.target.closest ? e.target.closest('[data-pld-pick]') : null;
      if (pick) {
        const kind = pick.getAttribute('data-pld-pick');
        const id = pick.getAttribute('data-pld-id');
        const name = pick.getAttribute('data-pld-name');
        addTagItem(kind, { id, name });
        return;
      }
      const add = e.target.closest ? e.target.closest('[data-pld-add]') : null;
      if (add) {
        const kind = add.getAttribute('data-pld-add');
        const inp = box.querySelector('#pldIn-' + kind);
        const typed = ((inp && inp.value) || '').trim().toLowerCase();
        if (!typed) return;
        const allOpts = plTagOptions(kind);
        const match = allOpts.find(o => String(o.name || '').toLowerCase() === typed);
        if (!match) {
          flashToast('⚠️ Pick from the list — free text goes in the description', true, false);
          return;
        }
        addTagItem(kind, match);
        return;
      }
      const rm = e.target.closest ? e.target.closest('[data-pld-kind]') : null;
      if (rm) {
        const kind = rm.getAttribute('data-pld-kind');
        const idx = parseInt(rm.getAttribute('data-pld-idx'), 10);
        if (Array.isArray(working[kind]) && idx >= 0) working[kind].splice(idx, 1);
        paintChips();
      }
    });

    box.querySelector('#pldClose').addEventListener('click', () => overlay.remove());
    box.querySelector('#pldSave').addEventListener('click', () => {
      const st = getDevStore();
      const target = st.custom[activeDevPlaylistId];
      if (!target) {
        overlay.remove();
        return;
      }
      const titleInput = box.querySelector('#pldTitle');
      if (titleInput && titleInput.value.trim()) {
        target.name = titleInput.value.trim().slice(0, 60);
      }
      if (typeof isDevMode !== 'undefined' && isDevMode) {
        const authSel = box.querySelector('#pldAuthorSelect');
        const authCust = box.querySelector('#pldAuthorCustom');
        let chosenAuthor = authSel ? authSel.value : '';
        if (chosenAuthor === 'custom' && authCust) {
          chosenAuthor = authCust.value.trim() || 'Andrew Ohiliote';
        }
        if (chosenAuthor) {
          target.ownerName = chosenAuthor;
        }
      }
      target.description = (box.querySelector('#pldDesc').value || '').slice(0, 500);
      target.tags = { teachers: working.teachers, venues: working.venues, topics: working.topics };
      saveDevStore(st);
      if (target.publicId || target.isPublic) {
        plPublishCurrent(true);
      }
      overlay.remove();
      renderPlaylistsGrid();
      if (typeof renderDevCuratedGrid === 'function') renderDevCuratedGrid();
      flashToast('✅ Playlist details saved', false, false);
    });
  }

  function devEditPublicPlaylist(id) {
    const store = getDevStore();
    if (!store.custom[id]) {
      const found = (typeof DEV_PUBLIC_SEEDS !== 'undefined' && DEV_PUBLIC_SEEDS.find(p => p.id === id)) ||
        (Array.isArray(plPublicResults) && plPublicResults.find(p => p.id === id));
      if (found) {
        store.custom[id] = {
          id: found.id,
          name: found.title || found.name,
          description: found.description || '',
          tags: found.tags || { teachers: [], venues: [], topics: [] },
          publicId: found.id,
          isPublic: true,
          isDevOwned: true,
          icon: '📁',
          items: found.items || []
        };
        saveDevStore(store);
      }
    }
    activeDevPlaylistId = id;
    renderPlaylistsGrid();
    openPlaylistDetailsModal();
  }
  window.devEditPublicPlaylist = devEditPublicPlaylist;

  async function plPublishCurrent(makePublic) {
    if (!cloudEnabled() && !isDevMode) {
      flashToast('🔑 Log in to publish playlists', true, false);
      return;
    }
    const store = getDevStore();
    const pl = store.custom[activeDevPlaylistId];
    if (!pl) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isDevMode) headers['X-Dev-Mode'] = '1';
      const res = await fetch('/api/playlists/publish', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          public: makePublic !== false,
          publicId: pl.publicId || (isDevMode && pl.isDevOwned ? pl.id : undefined),
          title: pl.name,
          description: pl.description || '',
          tags: pl.tags || { teachers: [], venues: [], topics: [] },
          playlist: { name: pl.name, items: pl.items || [] }
        })
      });
      const data = await res.json();
      if (!res.ok || !data.id) {
        flashToast('⚠️ Publish failed', true, false);
        return;
      }
      pl.publicId = data.id;
      pl.isPublic = makePublic !== false;
      saveDevStore(store);
      plMineCache.at = 0;
      renderPlaylistsGrid();
      flashToast(makePublic !== false ? '🌍 Published' : '🔒 Saved as private', false, false);
    } catch (e) {
      flashToast('⚠️ Publish failed', true, false);
    }
  }

  async function plUnpublishCurrent() {
    const store = getDevStore();
    const pl = store.custom[activeDevPlaylistId];
    if (!pl || !pl.publicId) return;
    openConfirmModal({
      title: 'Unpublish',
      body: 'Remove "' + pl.name + '" from public listings? Your local copy stays.',
      confirmLabel: 'Unpublish',
      onConfirm: async () => {
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (isDevMode) headers['X-Dev-Mode'] = '1';
          await fetch('/api/playlists/unpublish', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: pl.publicId })
          });
        } catch (e) {}
        delete pl.publicId;
        pl.isPublic = false;
        saveDevStore(store);
        plMineCache.at = 0;
        renderPlaylistsGrid();
      }
    });
  }

  function closeSaveChoiceModal() {
    const m = document.getElementById('saveChoiceModal');
    if (m) m.remove();
  }
  window.closeSaveChoiceModal = closeSaveChoiceModal;

  function openSaveChoiceModal(id, title) {
    closeSaveChoiceModal();
    const overlay = document.createElement('div');
    overlay.id = 'saveChoiceModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Save Public Playlist');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:440px; width:100%; padding:20px; border:1px solid var(--border-light); box-shadow:var(--shadow-hover);';
    box.innerHTML = '<div style="font-weight:800; font-size:17px; margin-bottom:6px; color:var(--text);">Save Public Playlist</div>' +
      '<div style="font-size:13px; color:var(--text-muted); margin-bottom:16px; line-height:1.4;">' +
      'How would you like to save <strong>' + escapeHtml(title || 'this playlist') + '</strong> to your collection?</div>' +
      '<div style="display:flex; flex-direction:column; gap:10px; margin-bottom:18px;">' +
      '<button type="button" class="save-choice-card" id="choiceSubscribe">' +
      '<div style="display:flex; gap:12px; align-items:flex-start; text-align:left;">' +
      '<span style="font-size:24px; line-height:1;">📡</span>' +
      '<div><div style="font-weight:700; font-size:14px; color:var(--text);">Subscribe / Follow (Live Sync)</div>' +
      '<div style="font-size:12px; color:var(--text-muted); margin-top:3px; line-height:1.35;">Read-only in your collection. Stays in sync automatically when the author adds, removes, or modifies shiurim.</div>' +
      '</div></div></button>' +
      '<button type="button" class="save-choice-card" id="choiceCopy">' +
      '<div style="display:flex; gap:12px; align-items:flex-start; text-align:left;">' +
      '<span style="font-size:24px; line-height:1;">📋</span>' +
      '<div><div style="font-weight:700; font-size:14px; color:var(--text);">Make an Editable Copy</div>' +
      '<div style="font-size:12px; color:var(--text-muted); margin-top:3px; line-height:1.35;">Creates an independent clone that you own and can freely edit, rename, and add or remove shiurim from.</div>' +
      '</div></div></button>' +
      '</div>' +
      '<div style="display:flex; justify-content:flex-end;">' +
      '<button type="button" class="card-mini-btn" id="choiceCancel">Cancel</button></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSaveChoiceModal(); });
    document.body.appendChild(overlay);

    box.querySelector('#choiceCancel').addEventListener('click', closeSaveChoiceModal);
    box.querySelector('#choiceSubscribe').addEventListener('click', () => {
      closeSaveChoiceModal();
      plExecuteSave(id, 'subscribe');
    });
    box.querySelector('#choiceCopy').addEventListener('click', () => {
      closeSaveChoiceModal();
      plExecuteSave(id, 'copy');
    });
    setTimeout(() => {
      const btn = box.querySelector('#choiceSubscribe');
      if (btn) btn.focus();
    }, 50);
  }

  function plPromptSavePublic(id, title) {
    if (!playlistsEnabled()) {
      flashToast('🔑 Log in to save public playlists', true, false);
      return;
    }
    openSaveChoiceModal(id, title);
  }
  window.plPromptSavePublic = plPromptSavePublic;
  window.plSavePublic = plPromptSavePublic;

  async function plExecuteSave(id, mode) {
    if (!playlistsEnabled()) {
      flashToast('🔑 Log in to save public playlists', true, false);
      return;
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isDevMode) headers['X-Dev-Mode'] = '1';
      const res = await fetch('/api/playlists/save', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id })
      });
      const data = await res.json();
      if (!res.ok || !data.playlist) {
        flashToast('⚠️ Save failed', true, false);
        return;
      }
      const store = getDevStore();
      const baseName = String(data.playlist.name || 'Shared playlist').slice(0, 60);

      if (mode === 'subscribe') {
        const subId = 'sub_' + id;
        store.custom[subId] = {
          id: subId,
          name: baseName,
          icon: '📡',
          description: String(data.playlist.description || '').slice(0, 500),
          items: data.playlist.items || [],
          isSubscription: true,
          subscribedPublicId: id,
          ownerName: data.playlist.ownerName || '',
          lastSyncedAt: Date.now()
        };
        saveDevStore(store);
        activeDevPlaylistId = subId;
        renderPlaylistsGrid();
        const el = document.getElementById('collectionsSection');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
        flashToast('📡 Subscribed! Stays in sync with public playlist', false, false);
      } else {
        let name = baseName;
        let n = 2;
        const taken = new Set(Object.values(store.custom || {}).map(p => p.name));
        while (taken.has(name)) name = baseName.slice(0, 54) + ' (' + (n++) + ')';
        const nid = devCreatePlaylist(name);
        if (nid && store.custom[nid]) {
          store.custom[nid].items = data.playlist.items || [];
          store.custom[nid].description = String(data.playlist.description || '').slice(0, 500);
          store.custom[nid].isSubscription = false;
          saveDevStore(store);
          activeDevPlaylistId = nid;
          renderPlaylistsGrid();
          const el = document.getElementById('collectionsSection');
          if (el) el.scrollIntoView({ behavior: 'smooth' });
          flashToast('📋 Editable copy saved to your playlists', false, false);
        }
      }
    } catch (e) {
      flashToast('⚠️ Save failed', true, false);
    }
  }
  window.plExecuteSave = plExecuteSave;

  async function devSyncSubscribedPlaylist(pid, notify) {
    const store = getDevStore();
    const pl = store.custom[pid];
    if (!pl || !pl.isSubscription || !pl.subscribedPublicId) return;
    try {
      pl._syncing = true;
      const res = await fetch('/api/playlists/items?id=' + encodeURIComponent(pl.subscribedPublicId));
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.items)) {
        const oldLen = (pl.items || []).length;
        pl.items = data.items;
        pl.lastSyncedAt = Date.now();
        saveDevStore(store);
        if (activeDevPlaylistId === pid) renderPlaylistsGrid();
        if (notify) {
          const diff = data.items.length - oldLen;
          flashToast(diff !== 0 ? ('🔄 Synced: ' + data.items.length + ' items (' + (diff > 0 ? '+' + diff : diff) + ')') : '✅ Playlist is up to date', false, false);
        }
      }
    } catch (e) {
      // Ignore network errors during sync
    } finally {
      pl._syncing = false;
    }
  }
  window.devSyncSubscribedPlaylist = devSyncSubscribedPlaylist;

  function devUnfollowPlaylist(pid) {
    const store = getDevStore();
    const pl = store.custom[pid];
    if (!pl) return;
    openConfirmModal({
      title: 'Unfollow Playlist',
      body: 'Remove "' + (pl.name || 'this playlist') + '" from your collection? You can always follow it again from the Public tab.',
      confirmLabel: 'Unfollow',
      onConfirm: async () => {
        if (pl.subscribedPublicId) {
          try { plUnsavePublic(pl.subscribedPublicId); } catch (e) {}
        }
        delete store.custom[pid];
        saveDevStore(store);
        activeDevPlaylistId = 'history';
        renderPlaylistsGrid();
        flashToast('👋 Unfollowed playlist', false, false);
      }
    });
  }
  window.devUnfollowPlaylist = devUnfollowPlaylist;

  function devCloneSubscriptionToCopy(pid) {
    const store = getDevStore();
    const pl = store.custom[pid];
    if (!pl) return;
    const trimmedBase = (pl.name || 'Playlist').slice(0, 52);
    const baseName = trimmedBase + ' (Copy)';
    let name = baseName;
    let n = 2;
    const taken = new Set(Object.values(store.custom || {}).map(p => p.name));
    while (taken.has(name)) name = trimmedBase + ' (Copy ' + (n++) + ')';
    const nid = devCreatePlaylist(name);
    if (nid && store.custom[nid]) {
      store.custom[nid].items = Array.isArray(pl.items) ? JSON.parse(JSON.stringify(pl.items)) : [];
      store.custom[nid].description = pl.description || '';
      store.custom[nid].isSubscription = false;
      saveDevStore(store);
      activeDevPlaylistId = nid;
      renderPlaylistsGrid();
      flashToast('📋 Created editable copy: ' + name, false, false);
    }
  }
  window.devCloneSubscriptionToCopy = devCloneSubscriptionToCopy;

  async function plUnsavePublic(id) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isDevMode) headers['X-Dev-Mode'] = '1';
      await fetch('/api/playlists/unsave', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id })
      });
    } catch (e) {}
    renderPlaylistsGrid();
  }

  // =========================================================================
  // Cloud sync (Google login + D1). Local-first: localStorage stays the
  // source of truth offline; when logged in, mutations schedule a debounced
  // push and boot/login pulls server state (last-write-wins per item).
  // =========================================================================
  let cloudUser = null;
  let cloudSyncTimer = null;
  // Dirty collections: only these keys are sent on push (absent keys leave
  // server rows untouched — an empty device can never wipe the cloud).
  let cloudDirty = { playlists: false, queue: false, history: false };
  function markCloudDirty(which) {
    if (which === 'playlists') cloudDirty.playlists = true;
    else if (which === 'queue') cloudDirty.queue = true;
    else if (which === 'history' || which === 'progress') cloudDirty.history = true;
  }
  function markCloudAllDirty() {
    cloudDirty.playlists = true;
    cloudDirty.queue = true;
    cloudDirty.history = true;
  }

  function cloudEnabled() {
    return Boolean(cloudUser);
  }

  function handleAuthClick() {
    if (cloudUser) {
      openConfirmModal({
        title: 'Sign out',
        body: 'Sign out of ' + (cloudUser.email || 'your account') + '? Anything already synced stays saved in the cloud.',
        confirmLabel: 'Sign out',
        onConfirm: async () => {
          try {
            await fetch('/auth/logout', { method: 'POST' });
          } catch (e) {}
          cloudUser = null;
          renderAuthBtn();
          try { if (typeof renderAccountMode === 'function') renderAccountMode(); } catch (e) {}
          flashToast('👋 Signed out (local copy kept)', false, false);
        }
      });
    } else {
      // Remember exactly where we left (shiur + timestamp included) so the
      // login round-trip returns here instead of the homepage.
      try {
        const here = window.location.pathname + window.location.search;
        if (here && here.startsWith('/') && !here.startsWith('//')) {
          localStorage.setItem('yutorah_post_login_return', here);
        }
      } catch (e) {}
      window.location.href = '/auth/google';
    }
  }

  // Logged-in icon: plain gear (default) without any letters.
  const AVATAR_VARIANTS = [
    'plain-gear', 'svg-gear-12tooth', 'svg-gear-sun', 'svg-gear-steampunk', 'svg-gear-shield', 'svg-gear-smooth'
  ];
  function getAvatarStyle() {
    return 'plain-gear';
  }
  function setAvatarStyle(v) {
    renderAuthBtn();
  }
  function authAvatarHtml(variant, name, email) {
    const v = AVATAR_VARIANTS.includes(variant) ? variant : 'plain-gear';
    if (v === 'plain-gear') return '<span class="auth-avatar plain-gear"><span class="auth-gear">⚙️</span></span>';
    return '<span class="auth-avatar plain-gear"><span class="auth-gear">⚙️</span></span>';
  }
  const _DEV_GEAR_SVGS = {
    'svg-gear-12tooth': '<svg class="auth-svg-gear" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8"/></svg>',
    'svg-gear-sun': '<svg class="auth-svg-gear" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8"/></svg>',
    'svg-gear-steampunk': '<svg class="auth-svg-gear" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8"/></svg>',
    'svg-gear-shield': '<svg class="auth-svg-gear" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8"/></svg>',
    'svg-gear-smooth': '<svg class="auth-svg-gear" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8"/></svg>'
  };
  function avatarPickerHtml() {
    return '';
  }
  function renderAvatarPicker() {
    const wrap = document.getElementById('avatarPickerAuth');
    if (wrap) wrap.innerHTML = '';
  }

  function devOpenQueueView() {
    activeDevPlaylistId = 'queue';
    if (typeof switchCollection === 'function') {
      switchCollection('playlists');
    }
    if (playlistsEnabled()) {
      openQueuePopup();
    }
    const el = document.getElementById('collectionsSection');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }
  window.devOpenQueueView = devOpenQueueView;

  function devScrollToPlaylists() {
    activeDevPlaylistId = 'history';
    if (typeof switchCollection === 'function') {
      switchCollection('playlists');
    }
    const el = document.getElementById('collectionsSection');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }
  window.devScrollToPlaylists = devScrollToPlaylists;

  function renderAuthBtn() {
    const btn = document.getElementById('authBtn');
    if (!btn) return;
    try { localStorage.removeItem('yutorah_avatar_style'); } catch (e) {}
    if (cloudUser) {
      document.body.classList.add('is-logged-in');
      btn.classList.add('logged-in');
      btn.title = cloudUser.name ? (cloudUser.name + ' (' + cloudUser.email + ')') : (cloudUser.email || 'Signed in');
      btn.innerHTML = '<span class="auth-avatar plain-gear"><span class="auth-gear">⚙️</span></span>';
    } else {
      document.body.classList.remove('is-logged-in');
      btn.classList.remove('logged-in');
      btn.title = 'Account';
      btn.innerHTML = '<span class="auth-icon">👤</span><span class="auth-label"> Sign in</span>';
    }
    closeAuthMenu();
    try { checkHeaderOverflow(); } catch (e) {}
  }

  function toggleAuthMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('authMenu');
    const btn = document.getElementById('authBtn');
    if (!menu) {
      handleAuthClick();
      return;
    }
    if (menu.style.display === 'block') {
      closeAuthMenu();
      return;
    }
    if (btn) btn.classList.add('active-open');
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const themeIcon = isDark ? '☀️' : '🌙';
    let html = '';
    if (cloudUser) {
      const displayName = cloudUser.name ? (cloudUser.name + ' (' + cloudUser.email + ')') : (cloudUser.email || '');
      html += '<div class="auth-menu-email"><span class="menu-item-icon">👤</span> <span>' + escapeHtml(displayName) + '</span></div>';
      html += '<button type="button" class="settings-menu-item" onclick="closeAuthMenu(); devOpenQueueView();"><span class="menu-item-icon">📋</span> <span>Open Play Queue</span></button>';
      html += '<button type="button" class="settings-menu-item" onclick="closeAuthMenu(); devScrollToPlaylists();"><span class="menu-item-icon">🎧</span> <span>My Playlists</span></button>';
      html += '<button type="button" class="settings-menu-item" onclick="closeAuthMenu(); openDisplayNameModal();"><span class="menu-item-icon">✏️</span> <span>Display name</span></button>';
      html += '<button type="button" class="settings-menu-item menu-theme-toggle-btn" onclick="toggleTheme();"><span class="menu-item-icon menu-theme-icon">' + themeIcon + '</span> <span>Light / Dark Mode</span></button>';
      try {
        const calEl = document.getElementById('hebrewDateBadge');
        const calRaw = calEl ? (calEl.textContent || '') : '';
        const calText = calRaw.replace(/^📅\uFE0F?\s*/, '').trim();
        if (calText) html += '<div class="settings-menu-item auth-cal-mobile" onclick="handleCalendarSecretClick(event);" title="Hebrew Calendar Date"><span class="menu-item-icon menu-cal-icon">📅</span> <span>' + escapeHtml(calText) + '</span></div>';
      } catch (e) {}
      html += '<button type="button" class="settings-menu-item" onclick="closeAuthMenu(); handleAuthClick();"><span class="menu-item-icon">🚪</span> <span>Sign out</span></button>';
    } else {
      let retPath = window.location.pathname;
      try {
        const u = new URL(window.location.href);
        if (audio && !audio.paused && audio.currentTime > 0) {
          u.searchParams.set('t', Math.floor(audio.currentTime));
        }
        retPath = u.pathname + u.search;
      } catch (e) {
        retPath = window.location.pathname + window.location.search;
      }
      const retUrl = encodeURIComponent(retPath);
      html += '<button type="button" class="settings-menu-item" onclick="closeAuthMenu(); window.location.href=&quot;/auth/google?return_to=' + retUrl + '&quot;;"><span class="menu-item-icon">🔑</span> <span>Sign in with Google</span></button>';
      html += '<button type="button" class="settings-menu-item menu-theme-toggle-btn" onclick="toggleTheme();"><span class="menu-item-icon menu-theme-icon">' + themeIcon + '</span> <span>Light / Dark Mode</span></button>';
      try {
        const calEl2 = document.getElementById('hebrewDateBadge');
        const calRaw2 = calEl2 ? (calEl2.textContent || '') : '';
        const calText2 = calRaw2.replace(/^📅\uFE0F?\s*/, '').trim();
        if (calText2) html += '<div class="settings-menu-item auth-cal-mobile" onclick="handleCalendarSecretClick(event);" title="Hebrew Calendar Date"><span class="menu-item-icon menu-cal-icon">📅</span> <span>' + escapeHtml(calText2) + '</span></div>';
      } catch (e) {}
    }
    if (isDevMode) {
      html += '<div class="settings-menu-label">Dev settings</div>';
      html += '<button type="button" class="settings-menu-item" onclick="closeAuthMenu(); openChangelogModal();"><span class="menu-item-icon">📋</span> <span>Change Log</span></button>';
      html += '<div class="settings-menu-label">Save button icon</div>';
      html += '<div id="saveIconPickerAuth" style="display:flex; gap:6px; padding:4px 10px 8px; flex-wrap:wrap;"></div>';
    }
    menu.innerHTML = html;
    menu.style.display = 'block';
    positionAuthMenu();
    if (isDevMode) {
      const wrap = document.getElementById('saveIconPickerAuth');
      if (wrap) {
        const cur = getSaveIconId();
        wrap.innerHTML = DEV_SAVE_ICONS.map(function(oid) {
          return '<button type="button" class="card-mini-btn icon-btn' + (oid === cur ? ' active-save' : '') + '"' +
            ' data-oid="' + oid + '" onclick="setSaveIcon(this.getAttribute(&quot;data-oid&quot;))" title="Save-for-later icon">' + saveIconThumb(oid) + '</button>';
        }).join('');
      }
    }
  }

  // Anchor the fixed menu under the button; flip above it when space is short.
  function positionAuthMenu() {
    try {
      const menu = document.getElementById('authMenu');
      const btn = document.getElementById('authBtn');
      if (!menu || !btn || menu.style.display !== 'block') return;
      const r = btn.getBoundingClientRect();
      const h = menu.offsetHeight || 200;
      const roomBelow = window.innerHeight - r.bottom;
      menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      menu.style.top = '';
      menu.style.bottom = '';
      if (roomBelow >= h + 12) {
        menu.style.top = Math.max(8, r.bottom + 6) + 'px';
      } else {
        menu.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
      }
    } catch (e) {}
  }

  function closeAuthMenu() {
    const menu = document.getElementById('authMenu');
    if (menu) menu.style.display = 'none';
    const btn = document.getElementById('authBtn');
    if (btn) btn.classList.remove('active-open');
  }

  // Display-name dialog: the name shown on playlists + public shares.
  // Stored server-side (users.name); falls back to localStorage offline.
  function openDisplayNameModal() {
    closeConfirmModal();
    let current = '';
    try { current = localStorage.getItem('yutorah_display_name') || ''; } catch (e) {}
    if (!current && cloudUser && cloudUser.name) current = cloudUser.name;
    const overlay = document.createElement('div');
    overlay.id = 'displayNameModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Display name');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:360px; width:100%; padding:18px; border:1px solid var(--border-light);';
    box.innerHTML = '<div style="font-weight:800; margin-bottom:6px;">✏️ Display name</div>' +
      '<div style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">Shown on your playlists and public shares. Your email stays private.</div>' +
      '<input id="displayNameInput" type="text" maxlength="40" placeholder="e.g. Moshe" autocomplete="off"' +
      ' style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-light);">' +
      '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">' +
      '<button type="button" class="card-mini-btn" id="displayNameCancel">Cancel</button>' +
      '<button type="button" class="card-mini-btn active-save" id="displayNameOk">Save</button></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    const input = box.querySelector('#displayNameInput');
    input.value = current;
    const save = async () => {
      const v = (input.value || '').trim().slice(0, 40);
      if (!v) return;
      let errEl = box.querySelector('#displayNameError');
      if (errEl) errEl.textContent = '';
      input.style.borderColor = 'var(--border-light)';
      if (cloudUser) {
        try {
          const res = await fetch('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: v })
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            const msg = data.message || 'That display name is already taken. Please choose a different name.';
            if (!errEl) {
              errEl = document.createElement('div');
              errEl.id = 'displayNameError';
              errEl.style.cssText = 'color:#ef4444; font-size:12px; margin-top:6px; font-weight:600;';
              input.parentNode.insertBefore(errEl, input.nextSibling);
            }
            errEl.textContent = '❌ ' + msg;
            input.style.borderColor = '#ef4444';
            input.focus();
            return;
          }
          cloudUser.name = (data.user && data.user.name) || v;
        } catch (e) {}
        renderAuthBtn();
      }
      try { localStorage.setItem('yutorah_display_name', v); } catch (e) {}
      try { if (typeof renderAccountMode === 'function') renderAccountMode(); } catch (e) {}
      overlay.remove();
      flashToast('✅ Display name saved', false, false);
    };
    box.querySelector('#displayNameCancel').addEventListener('click', () => overlay.remove());
    box.querySelector('#displayNameOk').addEventListener('click', save);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') overlay.remove();
    });
    setTimeout(() => input.focus(), 50);
  }

  document.addEventListener('click', (e) => {
    const menu = document.getElementById('authMenu');
    const btn = document.getElementById('authBtn');
    if (menu && menu.style.display === 'block' && btn &&
        !menu.contains(e.target) && !btn.contains(e.target)) {
      closeAuthMenu();
    }
    const pop = document.getElementById('queuePopup');
    if (pop && pop.style.display === 'flex') {
      if (!pop.contains(e.target) && !e.target.closest('.queue-btn') && !e.target.closest('[onclick*="devOpenQueueView"]') && !e.target.closest('[onclick*="toggleQueuePopup"]')) {
        closeQueuePopup();
      }
    }
  });

  window.addEventListener('resize', () => {
    try {
      const menu = document.getElementById('authMenu');
      if (menu && menu.style.display === 'block') positionAuthMenu();
    } catch (e) {}
  });
  document.querySelector('.header-right')?.addEventListener('scroll', () => {
    try {
      const menu = document.getElementById('authMenu');
      if (menu && menu.style.display === 'block') positionAuthMenu();
    } catch (e) {}
  }, { passive: true });

  function collectLocalState() {
    const body = {
      dirty: {
        playlists: Boolean(cloudDirty.playlists),
        queue: Boolean(cloudDirty.queue),
        history: Boolean(cloudDirty.history)
      }
    };
    if (cloudDirty.history) {
      let history = [];
      let progress = {};
      try { history = JSON.parse(localStorage.getItem('yutorah_recent_history') || '[]'); } catch (e) {}
      try { progress = JSON.parse(localStorage.getItem(DEV_PROGRESS_KEY) || '{}'); } catch (e) {}
      // Fold each item's progress record into its history entry so a newer
      // listen never wipes completion/progress server-side.
      const byId = {};
      for (const [sid, pr] of Object.entries(progress)) byId[String(sid)] = pr;
      body.history = history.map(h => {
        const pr = byId[String(h.id)] || {};
        return { ...h, progressSec: pr.progressSec || 0, durationSec: pr.durationSec || 0, completed: Boolean(pr.completed) };
      });
      body.progress = progress;
    }
    if (cloudDirty.playlists) {
      let store = null;
      try { store = JSON.parse(localStorage.getItem(DEV_PLAYLISTS_KEY) || 'null'); } catch (e) {}
      const playlists = { save_for_later: [], favorites: [], custom: {} };
      if (store && store.system) {
        playlists.save_for_later = store.system.save_for_later ? (store.system.save_for_later.items || []) : [];
        playlists.favorites = store.system.favorites ? (store.system.favorites.items || []) : [];
        for (const [pid, pl] of Object.entries(store.custom || {})) {
          if (pl && pl.name && !pl.isSubscription) playlists.custom[pl.name] = pl.items || [];
        }
      }
      body.playlists = playlists;
    }
    if (cloudDirty.queue) {
      let queue = [];
      try { queue = JSON.parse(localStorage.getItem(DEV_QUEUE_KEY) || '[]'); } catch (e) {}
      body.queue = Array.isArray(queue) ? queue : [];
    }
    return body;
  }

  function slugPid(name) {
    const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'list';
    let h = 0;
    for (const ch of String(name || '')) h = ((h * 31 + ch.charCodeAt(0)) >>> 0);
    return 'pl_' + slug + '-' + h.toString(36);
  }

  // Per-item last-write-wins merge (never wholesale overwrite): offline work
  // made before a pull resolves is preserved when it is newer.
  function adoptCloudState(s) {
    if (!s) return;
    try {
      if (Array.isArray(s.history)) {
        let local = [];
        try { local = JSON.parse(localStorage.getItem('yutorah_recent_history') || '[]'); } catch (e) {}
        const byId = new Map();
        for (const h of local) byId.set(String(h.id), h);
        for (const h of s.history) {
          const k = String(h.id);
          const prev = byId.get(k);
          if (!prev || Number(h.listenedAt || 0) >= Number(prev.listenedAt || 0)) byId.set(k, h);
        }
        const merged = [...byId.values()].sort((a, b) => Number(b.listenedAt || 0) - Number(a.listenedAt || 0)).slice(0, 100);
        localStorage.setItem('yutorah_recent_history', JSON.stringify(merged));
      }
      if (s.playlists) {
        const store = getDevStore();
        const mergeItems = (localItems, serverItems) => {
          const byId = new Map();
          for (const it of (localItems || [])) byId.set(String(it.id), it);
          for (const it of (serverItems || [])) {
            const k = String(it.id);
            const prev = byId.get(k);
            if (!prev || Number(it.addedAt || 0) >= Number(prev.addedAt || 0)) byId.set(k, it);
          }
          return [...byId.values()];
        };
        store.system.save_for_later.items = mergeItems(store.system.save_for_later.items, s.playlists.save_for_later);
        store.system.favorites.items = mergeItems(store.system.favorites.items, s.playlists.favorites);
        // Match customs by name (keep local id + icon); adopt unknown names.
        const icons = {};
        try { Object.assign(icons, JSON.parse(localStorage.getItem('yutorah_custom_icons') || '{}')); } catch (e) {}
        const byName = new Map();
        for (const [pid, pl] of Object.entries(store.custom || {})) {
          if (pl && pl.name) {
            byName.set(pl.name, pid);
            icons[pl.name] = pl.icon || icons[pl.name] || '📁';
          }
        }
        for (const [name, items] of Object.entries(s.playlists.custom || {})) {
          const pid = byName.get(name) || slugPid(name);
          const existing = store.custom[pid];
          if (existing && existing.isSubscription) continue;
          const prev = (store.custom[pid] && store.custom[pid].items) || [];
          store.custom[pid] = {
            id: pid, name, icon: icons[name] || '📁',
            items: mergeItems(prev, items)
          };
        }
        try { localStorage.setItem('yutorah_custom_icons', JSON.stringify(icons)); } catch (e) {}
        if (!getDevPlaylist(store, activeDevPlaylistId)) activeDevPlaylistId = 'history';
        devStoreCache = null;
        try {
          localStorage.setItem(DEV_PLAYLISTS_KEY, JSON.stringify(store));
          devStoreCache = store;
        } catch (e) {}
      }
      if (Array.isArray(s.queue)) {
        try {
          let localQ = [];
          try { localQ = JSON.parse(localStorage.getItem(DEV_QUEUE_KEY) || '[]'); } catch (e) {}
          // Server wins queue order, but local-only entries are appended.
          const serverIds = new Set();
          for (const it of s.queue) {
            if (it.kind === 'series') (it.items || []).forEach(x => serverIds.add(String(x.id)));
            else if (it.id) serverIds.add(String(it.id));
          }
          const extras = localQ.filter(it => {
            if (it.kind === 'series') return !(it.items || []).some(x => serverIds.has(String(x.id)));
            return it.id && !serverIds.has(String(it.id));
          });
          localStorage.setItem(DEV_QUEUE_KEY, JSON.stringify([...s.queue, ...extras]));
        } catch (e) {}
      }
      if (s.progress && typeof s.progress === 'object') {
        try {
          const local = getPlaybackProgress();
          const merged = { ...local };
          for (const [sid, pr] of Object.entries(s.progress)) {
            const prev = merged[sid];
            if (!prev || Number(pr.lastListened || 0) >= Number((prev.lastListened || 0))) {
              merged[sid] = pr;
            }
          }
          localStorage.setItem(DEV_PROGRESS_KEY, JSON.stringify(merged));
          devProgressCache = merged;
        } catch (e) {}
      }
      renderQueuePopup();
      devRefreshCardButtons();
      if (document.getElementById('grid-playlists') && activeDevPlaylistId) renderPlaylistsGrid();
    } catch (e) {}
  }

  function scheduleCloudSync() {
    if (!cloudEnabled()) return;
    try {
      clearTimeout(cloudSyncTimer);
      cloudSyncTimer = setTimeout(() => { cloudPush().catch(() => {}); }, 2500);
    } catch (e) {}
  }

  async function cloudPush() {
    if (!cloudEnabled()) return null;
    const payload = collectLocalState();
    const sent = {
      playlists: Boolean(payload.playlists),
      queue: Boolean(payload.queue),
      history: Boolean(payload.history)
    };
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) return null;
      if (sent.playlists) cloudDirty.playlists = false;
      if (sent.queue) cloudDirty.queue = false;
      if (sent.history) cloudDirty.history = false;
      const state = await res.json();
      adoptCloudState(state);
      return state;
    } catch (e) {
      return null;
    }
  }

  async function cloudPull() {
    if (!cloudEnabled()) return null;
    try {
      const res = await fetch('/api/sync');
      if (!res.ok) return null;
      const state = await res.json();
      adoptCloudState(state);
      return state;
    } catch (e) {
      return null;
    }
  }

  const AUTH_ERROR_COPY = {
    'setup-needed': 'Login is not configured yet — see docs/AUTH_SETUP.md.',
    'state-mismatch': 'Login was interrupted (session mismatch). Please try again.',
    'token-failed': 'Google rejected the login. Please try again.',
    'userinfo-failed': 'Could not read your Google profile. Please try again.',
    error: 'Login failed. Please try again.'
  };

  async function bootAuth() {
    renderAuthBtn();
    try { if (typeof renderAccountMode === 'function') renderAccountMode(); } catch (e) {}
    try {
      const params = new URLSearchParams(window.location.search);
      const authStatus = params.get('auth');
      if (authStatus && authStatus !== 'ok') {
        flashToast('⚠️ ' + (AUTH_ERROR_COPY[authStatus] || AUTH_ERROR_COPY.error), true, false);
        params.delete('auth');
        const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
        history.replaceState(history.state || {}, '', clean);
      }
      const res = await fetch('/api/me');
      if (!res.ok) return;
      const data = await res.json();
      if (authStatus === 'ok' && (!data || !data.user)) {
        // Login redirect landed but no session (cookie blocked/expired):
        // clean the params so the URL doesn't lie.
        params.delete('auth');
        params.delete('new');
        const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
        history.replaceState(history.state || {}, '', clean);
        flashToast('⚠️ Signed in, but no session stuck — check third-party cookie settings and retry.', true, false);
      }
      if (data && data.user) {
        cloudUser = data.user;
        renderAuthBtn();
        try { if (typeof renderAccountMode === 'function') renderAccountMode(); } catch (e) {}
        if (authStatus === 'ok') {
          const isFirst = params.get('new') === '1';
          params.delete('auth');
          params.delete('new');
          const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
          history.replaceState(history.state || {}, '', clean);
          // Return to the exact pre-login URL (shiur + timestamp intact).
          try {
            const ret = localStorage.getItem('yutorah_post_login_return') || '';
            localStorage.removeItem('yutorah_post_login_return');
            if (ret && ret.startsWith('/') && !ret.startsWith('//') && ret !== clean &&
                ret !== window.location.pathname + window.location.search) {
              window.location.replace(ret);
              return;
            }
          } catch (e) {}
          if (isFirst) {
            // Brand-new account: migrate this browser's library up.
            markCloudAllDirty();
            await cloudPush();
            flashToast('👋 Signed in — library synced', false, false);
          } else {
            // Returning device: pull only (a push here with an empty
            // library would be pointless; edits push themselves).
            await cloudPull();
            flashToast('👋 Welcome back — library synced', false, false);
          }
        } else {
          await cloudPull();
        }
      }
    } catch (e) {}
  }

  // Generic in-app confirm dialog (no system popups): title + body text,
  // Cancel / confirmLabel buttons; onConfirm runs on confirmation.
  let devConfirmCb = null;
  function openConfirmModal(opts) {
    closeConfirmModal();
    const o = opts || {};
    const overlay = document.createElement('div');
    overlay.id = 'confirmModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', o.title || 'Confirm');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:400px; width:100%; padding:20px; border:1px solid var(--border-light);';
    box.innerHTML = '<div style="font-weight:800; font-size:16px; margin-bottom:8px;">' + escapeHtml(o.title || 'Are you sure?') + '</div>' +
      '<div style="font-size:14px; color:var(--text-muted); margin-bottom:16px;">' + escapeHtml(o.body || '') + '</div>' +
      '<div style="display:flex; gap:8px; justify-content:flex-end;">' +
      '<button type="button" class="card-mini-btn" id="confirmModalCancel">Cancel</button>' +
      '<button type="button" class="card-mini-btn active-save" id="confirmModalOk">' + escapeHtml(o.confirmLabel || 'Confirm') + '</button></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeConfirmModal(); });
    document.body.appendChild(overlay);
    devConfirmCb = (typeof o.onConfirm === 'function') ? o.onConfirm : null;
    box.querySelector('#confirmModalCancel').addEventListener('click', closeConfirmModal);
    box.querySelector('#confirmModalOk').addEventListener('click', () => {
      const cb = devConfirmCb;
      devConfirmCb = null;
      closeConfirmModal();
      if (cb) cb();
    });
  }

  function closeConfirmModal() {
    devConfirmCb = null;
    const m = document.getElementById('confirmModal');
    if (m) m.remove();
  }

  // Change Log modal (dev settings): latest changes, most recent on top.
  async function openChangelogModal() {
    closeChangelogModal();
    const menu = document.getElementById('settingsMenu');
    if (menu) menu.style.display = 'none';
    const overlay = document.createElement('div');
    overlay.id = 'changelogModal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Change log');
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:480px; width:100%; max-height:80vh; overflow:auto; padding:18px; border:1px solid var(--border-light);';
    box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">' +
      '<div style="font-weight:800; font-size:16px;">📋 Latest Changes</div>' +
      '<button type="button" class="card-mini-btn" onclick="closeChangelogModal()">Close ×</button></div>' +
      '<div id="changelogList"><div style="color:var(--text-muted);">Loading…</div></div>';
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeChangelogModal(); });
    document.body.appendChild(overlay);
    try {
      const res = await fetch('/api/changelog');
      const data = await res.json();
      const entries = (data && data.entries) || [];
      const list = box.querySelector('#changelogList');
      if (!list) return;
      if (entries.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);">No changes logged yet.</div>';
        return;
      }
      list.innerHTML = entries.map(en => {
        let when = String(en.date || '');
        try {
          const d = new Date(when);
          if (!isNaN(d)) when = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        } catch (e) {}
        return '<div style="padding:8px 0; border-bottom:1px solid var(--border-light);">' +
          '<div style="font-size:12px; color:var(--text-muted);">' + escapeHtml(when) + '</div>' +
          '<div style="font-size:14px;">' + escapeHtml(en.message || '') + '</div></div>';
      }).join('');
    } catch (e) {
      const list = box.querySelector('#changelogList');
      if (list) list.innerHTML = '<div style="color:var(--text-muted);">Could not load the change log.</div>';
    }
  }

  function closeChangelogModal() {
    const m = document.getElementById('changelogModal');
    if (m) m.remove();
  }

  function devDeletePlaylist() {
    const store = getDevStore();
    const pl = store.custom[activeDevPlaylistId];
    if (!pl) return;
    openConfirmModal({
      title: 'Delete Playlist',
      body: 'Delete "' + pl.name + '"? Shiurim stay in your other playlists.',
      confirmLabel: '🗑️ Delete',
      onConfirm: () => {
        const s = getDevStore();
        delete s.custom[activeDevPlaylistId];
        activeDevPlaylistId = 'history';
        saveDevStore(s);
        renderPlaylistsGrid();
      }
    });
  }

  var DEV_QUEUE_KEY = 'yutorah_dev_queue';
  var devSeriesCache = {};

  // Play queue (Dev Mode): ordered top→bottom, auto-plays next on track end.
  // Items are shiur snapshots or { kind:'series', seriesTitle, items:[...] }
  // series entries expand in place when they reach the front.
  function getDevQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(DEV_QUEUE_KEY) || '[]');
      return Array.isArray(q) ? q : [];
    } catch (e) {
      return [];
    }
  }

  function saveDevQueue(q) {
    try {
      localStorage.setItem(DEV_QUEUE_KEY, JSON.stringify(q || []));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        flashToast('⚠️ Storage full — queue change was NOT saved', true, false);
      }
    }
    renderQueuePopup();
    if (document.getElementById('grid-playlists') && activeDevPlaylistId === 'queue') renderPlaylistsGrid();
    try {
      if (typeof markCloudDirty === 'function') markCloudDirty('queue');
      if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
    } catch (e) {}
  }

  function devQueueFlatIds() {
    const ids = new Set();
    for (const it of getDevQueue()) {
      if (it.kind === 'series') (it.items || []).forEach(s => ids.add(String(s.id)));
      else if (it.id) ids.add(String(it.id));
    }
    return ids;
  }

  function devInQueue(id) {
    return devQueueFlatIds().has(String(id));
  }

  function devQueueAdd(id) {
    const sid = String(id);
    if (devInQueue(sid)) return true;
    const snap = devSnapshot(sid);
    if (!snap) return false;
    const q = getDevQueue();
    snap.queuedAt = Date.now();
    q.push(snap);
    saveDevQueue(q);
    devRefreshCardButtons();
    return true;
  }

  function devQueueAddSeries(coverId, coverBtn) {
    const cid = String(coverId);
    // Toggle off: a queued series removes as one unit.
    const q0 = getDevQueue();
    if (q0.some(it => it.kind === 'series' && String(it.coverId || '') === cid)) {
      saveDevQueue(q0.filter(it => !(it.kind === 'series' && String(it.coverId || '') === cid)));
      devRefreshCardButtons();
      return true;
    }
    // Fast path: client-grouped docs cached at render time.
    const entry = devSeriesCache[cid];
    if (entry && entry.docs && entry.docs.length > 0) {
      const already = devQueueFlatIds();
      const items = entry.docs.map(d => {
        const did = String(d.shiurid || d.shiurID || d.id || '');
        return {
          id: did,
          title: d.shiurtitle || d.shiurTitle || d.title || 'Untitled',
          speaker: d.teacherfullname || (d.shiurTeachers && d.shiurTeachers[0] ? d.shiurTeachers[0].teacherFullName : (d.speaker || 'YUTorah')),
          photo: d.photo || '',
          duration: d.durationformatted || (d.duration ? d.duration + ' min' : ''),
          queuedAt: Date.now()
        };
      }).filter(s => s.id && !already.has(s.id));
      if (items.length === 0) return false;
      const q = getDevQueue();
      q.push({ kind: 'series', coverId: cid, seriesTitle: entry.title || 'Series', items: items, queuedAt: Date.now() });
      saveDevQueue(q);
      devRefreshCardButtons();
      return true;
    }
    // Fallback (SSR covers have no cached docs): scrape the drawer's
    // sub-card anchors from the DOM — same snapshots as single adds.
    let drawer = null;
    try {
      const scope = (coverBtn && coverBtn.closest) ? coverBtn.closest('.quick-card-series-group') : null;
      const coverLink = scope
        ? scope.querySelector('a.quick-card-link[data-id="' + cid + '"]')
        : document.querySelector('a.quick-card-link[data-id="' + cid + '"]');
      const group = coverLink && coverLink.closest ? coverLink.closest('.quick-card-series-group') : null;
      drawer = group ? group.querySelector('.series-drawer') : null;
    } catch (e) { drawer = null; }
    if (drawer) {
      const already = devQueueFlatIds();
      const items = [];
      drawer.querySelectorAll('a.series-sub-card[data-id]').forEach(a => {
        const sid = a.getAttribute('data-id');
        if (!sid || already.has(String(sid))) return;
        devSnapshotFromCard(a);
        const snap = devDocCache[String(sid)];
        if (snap) {
          items.push({ id: String(sid), title: snap.title, speaker: snap.speaker, photo: snap.photo, duration: snap.duration, queuedAt: Date.now() });
          already.add(String(sid));
        }
      });
      // Include the cover itself as part one (null-safe: cover may be gone).
      if (!already.has(cid)) {
        const coverLink = coverLinkSafe(cid);
        if (coverLink) {
          devSnapshotFromCard(coverLink);
          const csnap = devDocCache[cid];
          if (csnap) items.unshift({ id: cid, title: csnap.title, speaker: csnap.speaker, photo: csnap.photo, duration: csnap.duration, queuedAt: Date.now() });
        }
      }
      if (items.length === 0) return false;
      // Series title from the drawer's own expander button (scoped lookup).
      let sTitle = 'Series';
      try {
        const scopeGroup = drawer.closest ? drawer.closest('.quick-card-series-group') : null;
        const titleBtn = scopeGroup ? scopeGroup.querySelector('[data-series-title]') : null;
        if (titleBtn && titleBtn.getAttribute) sTitle = titleBtn.getAttribute('data-series-title') || sTitle;
      } catch (e) {}
      const q = getDevQueue();
      q.push({ kind: 'series', coverId: cid, seriesTitle: sTitle, items: items, queuedAt: Date.now() });
      saveDevQueue(q);
      devRefreshCardButtons();
      return true;
    }
    return devQueueAdd(cid);
  }

  function coverLinkSafe(cid) {
    try {
      return document.querySelector('a.quick-card-link[data-id="' + cid + '"]');
    } catch (e) {
      return null;
    }
  }

  function devSeriesQueued(coverId) {
    const cid = String(coverId);
    return getDevQueue().some(it => it.kind === 'series' && String(it.coverId || '') === cid);
  }

  function devQueueToggle(id, isCover, btn) {
    if (isCover) {
      devQueueAddSeries(id, btn || null);
      return;
    }
    if (devInQueue(id)) {
      devQueueRemoveId(id);
    } else {
      devQueueAdd(id);
    }
  }

  function devQueueRemoveId(id) {
    const sid = String(id);
    const q = getDevQueue().map(it => {
      if (it.kind === 'series') {
        return { ...it, items: (it.items || []).filter(s => String(s.id) !== sid) };
      }
      return it;
    }).filter(it => it.kind === 'series' ? (it.items && it.items.length > 0) : String(it.id) !== sid);
    saveDevQueue(q);
    devRefreshCardButtons();
  }

  function devQueueRemoveAt(idx) {
    const q = getDevQueue();
    if (idx < 0 || idx >= q.length) return;
    q.splice(idx, 1);
    saveDevQueue(q);
    devRefreshCardButtons();
  }

  function devQueueMove(idx, dir) {
    const q = getDevQueue();
    const j = idx + dir;
    if (idx < 0 || idx >= q.length || j < 0 || j >= q.length) return;
    const tmp = q[idx];
    q[idx] = q[j];
    q[j] = tmp;
    saveDevQueue(q);
  }

  function devQueueMoveTo(fromIdx, toIdx) {
    const q = getDevQueue();
    if (fromIdx < 0 || fromIdx >= q.length) return;
    toIdx = Math.max(0, Math.min(q.length - 1, toIdx));
    if (fromIdx === toIdx) return;
    const it = q.splice(fromIdx, 1)[0];
    q.splice(toIdx, 0, it);
    saveDevQueue(q);
  }

  function devQueueClear() {
    const q = getDevQueue();
    if (q.length === 0) return;
    openConfirmModal({
      title: 'Clear Queue',
      body: 'Remove all ' + q.length + ' item' + (q.length === 1 ? '' : 's') + ' from the play queue?',
      confirmLabel: '🗑️ Clear',
      onConfirm: () => {
        saveDevQueue([]);
        devRefreshCardButtons();
      }
    });
  }

  // Shift the next playable shiur, expanding series entries in place.
  // Returns { id, title } or null when the queue is empty (or dev is off).
  function devQueuePopNext() {
    if (!playlistsEnabled()) return null;
    let q = getDevQueue();
    while (q.length > 0) {
      const head = q[0];
      if (head.kind === 'series') {
        const parts = (head.items || []).filter(s => s && s.id);
        q.shift();
        for (let i = parts.length - 1; i >= 0; i--) q.unshift(parts[i]);
        saveDevQueue(q);
        continue;
      }
      q.shift();
      saveDevQueue(q);
      const nid = String(head.id || '');
      if (!nid) continue;
      return { id: nid, title: head.title || 'Untitled' };
    }
    saveDevQueue(q);
    return null;
  }

  function devPlayNextFromQueue() {
    // Skip entries matching the currently playing track (never "advance"
    // to the same spot or burn a queue item on it).
    let next = devQueuePopNext();
    let guard = 0;
    while (next && String(next.id) === String(currentShiurId) && guard < 10) {
      guard++;
      next = devQueuePopNext();
    }
    if (!next) return false;
    devRefreshCardButtons();
    try {
      const label = String(next.title || 'Untitled');
      flashToast('▶ Up Next: ' + (label.length > 60 ? label.slice(0, 60) + '…' : label), false, false);
    } catch (e) {}
    playShiurById(null, next.id);
    return true;
  }

  // Queue popup (mini-player ☰ + playlists tab share this renderer).
  let devDragIdx = -1;

  function closeQueuePopup() {
    const pop = document.getElementById('queuePopup');
    if (pop) {
      pop.style.display = 'none';
    }
  }
  window.closeQueuePopup = closeQueuePopup;

  function openQueuePopup() {
    if (!playlistsEnabled()) return;
    const pop = document.getElementById('queuePopup');
    if (!pop) return;
    renderQueuePopup();
    pop.style.display = 'flex';
  }
  window.openQueuePopup = openQueuePopup;

  function toggleQueuePopup() {
    if (!playlistsEnabled()) return;
    const pop = document.getElementById('queuePopup');
    if (!pop) return;
    if (pop.style.display === 'none' || !pop.style.display) {
      openQueuePopup();
    } else {
      closeQueuePopup();
    }
  }
  window.toggleQueuePopup = toggleQueuePopup;

  function devQueueListHtml() {
    const q = getDevQueue();
    if (q.length === 0) {
      return '<div class="queue-empty">Queue is empty — tap the circular queue icon (<span class="queue-circle-btn" style="width:20px; height:20px; display:inline-flex; vertical-align:middle; pointer-events:none; margin:0 3px;">' + devQueueIconSvg() + '</span>) on any card to line up what plays next.</div>';
    }
    return q.map((it, idx) => {
      const isSeries = it.kind === 'series';
      const title = isSeries ? ('📚 ' + (it.seriesTitle || 'Series') + ' (' + ((it.items || []).length) + ' parts)') : (it.title || 'Untitled');
      const sub = isSeries ? 'Series — expands when reached' : ((it.speaker || 'YUTorah') + (it.duration ? ' · ' + it.duration : ''));
      return '<div class="queue-row" draggable="true" data-qidx="' + idx + '"' +
        ' ondragstart="devQueueDragStart(event, ' + idx + ')" ondragover="devQueueDragOver(event)" ondrop="devQueueDrop(event, ' + idx + ')" ondragend="devQueueDragEnd(event)">' +
        '<span class="queue-handle" title="Drag to reorder">⠿</span>' +
        '<span class="queue-pos">' + (idx + 1) + '</span>' +
        '<div class="queue-main"><div class="queue-title">' + escapeHtml(title) + '</div>' +
        '<div class="queue-sub">' + escapeHtml(sub) + '</div></div>' +
        '<div class="queue-row-btns">' +
        '<button type="button" class="card-mini-btn" ' + (idx===0?'disabled ':'') + 'onclick="devQueueMove(' + idx + ', -1)" title="Move up" aria-label="Move up">▲</button>' +
        '<button type="button" class="card-mini-btn" ' + (idx===q.length-1?'disabled ':'') + 'onclick="devQueueMove(' + idx + ', 1)" title="Move down" aria-label="Move down">▼</button>' +
        '<button type="button" class="card-mini-btn" onclick="devQueueRemoveAt(' + idx + ')" title="Remove">✕</button>' +
        '</div></div>';
    }).join('');
  }

  function renderQueuePopup() {
    const pop = document.getElementById('queuePopup');
    const list = document.getElementById('queueList');
    const count = document.getElementById('queueCount');
    if (!pop || !list) return;
    if (!playlistsEnabled()) {
      pop.style.display = 'none';
      return;
    }
    const q = getDevQueue();
    list.innerHTML = devQueueListHtml();
    if (count) count.textContent = q.length === 1 ? '1 item' : q.length + ' items';
  }

  function devQueueDragStart(e, idx) {
    devDragIdx = idx;
    const row = e.target.closest ? e.target.closest('.queue-row') : null;
    if (row) row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) {}
    }
  }

  function devQueueDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function devQueueDrop(e, idx) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (devDragIdx >= 0 && devDragIdx !== idx) devQueueMoveTo(devDragIdx, idx);
    devDragIdx = -1;
  }

  function devQueueDragEnd() {
    devDragIdx = -1;
    document.querySelectorAll('.queue-row.dragging').forEach(el => el.classList.remove('dragging'));
  }

  function openPlaylistModal(id) {
    if (!playlistsEnabled()) return;
    closePlaylistModal();
    const snap = devSnapshot(id);
    if (!snap) return;
    const overlay = document.createElement('div');
    overlay.id = 'playlistModal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Add to playlist');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:14px; max-width:440px; width:100%; max-height:80vh; overflow:auto; padding:18px; border:1px solid var(--border-light); box-shadow:0 12px 32px rgba(0,0,0,0.25);';

    // Staged membership and count tracking
    const initialStates = {};
    const initialCounts = {};
    const stagedStates = {};

    function initStates() {
      const s = getDevStore();
      devPlaylistIds(s).forEach(pid => {
        const inPl = devInPlaylist(pid, id);
        initialStates[pid] = inPl;
        if (!(pid in stagedStates)) {
          stagedStates[pid] = inPl;
        }
        const p = getDevPlaylist(s, pid);
        initialCounts[pid] = p && p.items ? p.items.length : 0;
      });
    }
    initStates();

    function rowHtml(pid, name, icon, isReadOnly) {
      const isChecked = !!stagedStates[pid];
      const isInitial = !!initialStates[pid];
      const baseCount = initialCounts[pid] || 0;
      let displayCount = baseCount;
      let tickHtml = '';
      if (isChecked && !isInitial) {
        displayCount = baseCount + 1;
        tickHtml = ' <span class="pl-tick-add" style="color:#16a34a; font-weight:800; font-size:12px; margin-left:3px;">(+1)</span>';
      } else if (!isChecked && isInitial) {
        displayCount = Math.max(0, baseCount - 1);
        tickHtml = ' <span class="pl-tick-del" style="color:#dc2626; font-weight:800; font-size:12px; margin-left:3px;">(-1)</span>';
      }
      return '<label style="display:flex; align-items:center; gap:8px; padding:7px 4px; cursor:' + (isReadOnly ? 'not-allowed; opacity:0.6;' : 'pointer;') + '" data-pl-row="' + escapeHtml(name.toLowerCase()) + '">' +
        '<input type="checkbox" data-pl-check="' + pid + '"' + (isChecked ? ' checked' : '') + (pid === 'history' || isReadOnly ? ' disabled' : '') + '>' +
        '<span style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">' +
        '<span>' + escapeHtml(icon) + ' ' + escapeHtml(name) + '</span>' +
        '<span style="color:var(--text-muted); font-size:12px;">(<span id="pl-count-' + pid + '">' + displayCount + '</span>)</span>' +
        tickHtml +
        (isReadOnly ? ' <em style="font-size:11px; color:var(--text-muted);">(Read-Only)</em>' : '') +
        '</span></label>';
    }

    function listHtml(filter) {
      const s = getDevStore();
      const f = String(filter || '').toLowerCase();
      let h = '';
      devPlaylistIds(s).forEach(pid => {
        const p = getDevPlaylist(s, pid);
        if (!p) return;
        if (f && p.name.toLowerCase().indexOf(f) === -1) return;
        const isRo = !!(p.isSubscription);
        h += rowHtml(pid, p.name, p.icon || '📁', isRo);
      });
      return h || '<div style="padding:8px; color:var(--text-muted);">No playlists match.</div>';
    }

    function getChangesCount() {
      let c = 0;
      for (const pid in stagedStates) {
        if (stagedStates[pid] !== initialStates[pid]) c++;
      }
      return c;
    }

    function updateFooter() {
      const cnt = getChangesCount();
      const statusEl = box.querySelector('#plModalStatus');
      const saveBtn = box.querySelector('#plSaveBtn');
      if (statusEl) {
        if (cnt > 0) {
          statusEl.innerHTML = '<span style="color:var(--primary); font-weight:700;">' + cnt + ' change' + (cnt === 1 ? '' : 's') + ' pending</span>';
        } else {
          statusEl.innerHTML = '<span style="color:var(--text-muted);">No changes</span>';
        }
      }
      if (saveBtn) {
        saveBtn.innerHTML = cnt > 0 ? '💾 Save Changes (' + cnt + ')' : '💾 Save Changes';
        saveBtn.style.opacity = cnt > 0 ? '1' : '0.75';
      }
    }

    box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">' +
      '<div style="font-weight:800; font-size:16px;">➕ Add to Playlist</div>' +
      '<button type="button" class="card-mini-btn" onclick="closePlaylistModal()">Close ×</button></div>' +
      '<div style="font-size:13px; color:var(--text-muted); margin-bottom:12px;">' + escapeHtml(snap.title) + '</div>' +
      '<input id="devPlFilter" type="text" placeholder="Type to filter or create..." autocomplete="off"' +
      ' style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-light); margin-bottom:6px; background:var(--card); color:var(--text);">' +
      '<div id="devPlCreateWrap"></div>' +
      '<div id="devPlList" style="max-height:260px; overflow-y:auto; margin-bottom:8px;">' + listHtml('') + '</div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; padding-top:12px; border-top:1px solid var(--border-light);">' +
      '<div id="plModalStatus" style="font-size:12px; color:var(--text-muted);">No changes</div>' +
      '<div style="display:flex; gap:8px;">' +
      '<button type="button" class="card-mini-btn" id="plCancelBtn" onclick="closePlaylistModal()">Cancel</button>' +
      '<button type="button" class="card-mini-btn pl-save-changes-btn" id="plSaveBtn" style="background:var(--primary); color:#fff; border-color:var(--primary); font-weight:700;">💾 Save Changes</button>' +
      '</div></div>';

    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) closePlaylistModal(); });
    document.body.appendChild(overlay);

    const filterInput = box.querySelector('#devPlFilter');
    const listEl = box.querySelector('#devPlList');
    const createWrap = box.querySelector('#devPlCreateWrap');
    const saveBtn = box.querySelector('#plSaveBtn');

    filterInput.addEventListener('input', () => {
      listEl.innerHTML = listHtml(filterInput.value);
      const v = filterInput.value.trim();
      if (v) {
        createWrap.innerHTML = '<button type="button" class="card-mini-btn active-save" id="devPlCreateBtn" style="margin-bottom:8px;">➕ Create "' + escapeHtml(v) + '"</button>';
        const cb = createWrap.querySelector('#devPlCreateBtn');
        cb.addEventListener('click', () => {
          if (typeof devIsDuplicatePlaylistName === 'function' && devIsDuplicatePlaylistName(v)) {
            flashToast('A playlist with this name already exists', true, false);
            return;
          }
          const nid = devCreatePlaylist(v);
          if (nid) {
            initialStates[nid] = false;
            initialCounts[nid] = 0;
            stagedStates[nid] = true;
          }
          filterInput.value = '';
          createWrap.innerHTML = '';
          listEl.innerHTML = listHtml('');
          updateFooter();
        });
      } else {
        createWrap.innerHTML = '';
      }
    });

    listEl.addEventListener('change', e => {
      const cb = e.target.closest('[data-pl-check]');
      if (!cb) return;
      const pid = cb.getAttribute('data-pl-check');
      stagedStates[pid] = cb.checked;
      listEl.innerHTML = listHtml(filterInput.value);
      const reCheck = listEl.querySelector('[data-pl-check="' + pid + '"]');
      if (reCheck) reCheck.focus();
      updateFooter();
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        let changed = false;
        for (const pid in stagedStates) {
          if (stagedStates[pid] !== initialStates[pid]) {
            devSetMembership(pid, id, stagedStates[pid]);
            changed = true;
          }
        }
        if (changed) {
          devRefreshCardButtons();
          if (document.getElementById('grid-playlists') && document.getElementById('grid-playlists').style.display !== 'none') {
            renderPlaylistsGrid();
          }
        }
        closePlaylistModal();
      });
    }

    const first = box.querySelector('#devPlFilter');
    if (first) first.focus();
  }

  function closePlaylistModal() {
    const m = document.getElementById('playlistModal');
    if (m) m.remove();
  }

  let parshaShiurimLoaded = false;
  async function loadParshaShiurimGrid() {
    const grid = document.getElementById('grid-parsha');
    if (!grid || parshaShiurimLoaded) return;
    grid.innerHTML = '<div class="spinner-box" style="display:block; grid-column:1/-1;"><div class="spinner"></div>Loading current Parsha shiurim...</div>';
    try {
      const parshaCat = '${parshaCatId}';
      const res = await fetch('/api/search?subCategoryId=' + encodeURIComponent(parshaCat) + '&start=1');
      const data = await res.json();
      const docs = data?.response?.docs || [];
      if (docs.length > 0) {
        grid.innerHTML = docs.map(renderDocToCard).join('');
        parshaShiurimLoaded = true;
      } else {
        grid.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--text-muted); grid-column: 1/-1;">No parsha shiurim found.</div>';
      }
    } catch (e) {
      grid.innerHTML = '<div style="padding: 20px; text-align: center; color: #c0392b; grid-column: 1/-1;">Could not load parsha shiurim. <button class="chip" onclick="parshaShiurimLoaded=false; loadParshaShiurimGrid();">Retry</button></div>';
    }
  }

  // Switch Collection Tabs
  const collections = ['editors', 'playlists', 'dev-playlists', 'series', 'recent', 'popular', 'viewed', 'parsha', 'daily', 'trending'];
  const collectionTitles = {
    editors: "⭐ Editor's Picks",
    playlists: "🎧 My Playlists",
    'dev-playlists': "🛠️ Dev Playlists",
    series: "📚 Featured Series",
    recent: "⏱️ Recently Uploaded",
    popular: "🔥 Most Popular",
    viewed: "👁️ Recently Viewed",
    parsha: "📖 Parsha Shiurim",
    daily: "📜 Daily Shiur",
    trending: "🔥 Trending Keywords"
  };

  // =========================================================================
  // [DEAD CODE / INACTIVE] Simple View switcher & Settings menu handlers.
  // Kept in codebase for reference as requested, but hidden from the UI.
  // =========================================================================
  function isSimpleMode() {
    return document.documentElement.getAttribute('data-view') === 'simple';
  }

  function updateSettingsMenuText() {
    const textEl = document.getElementById('viewModeText');
    const iconEl = document.getElementById('viewModeIcon');
    const simple = isSimpleMode();
    if (textEl) {
      textEl.textContent = simple ? 'Revert to Full View' : 'Switch to Simple View';
    }
    if (iconEl) {
      iconEl.textContent = simple ? '🔄' : '✨';
    }
  }

  function toggleSettingsMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('settingsMenu');
    if (!menu) return;
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      updateSettingsMenuText();
    }
  }

  function triggerModeOverlay(text) {
    const oldOverlay = document.getElementById('modeOverlay');
    if (oldOverlay) oldOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modeOverlay';
    overlay.className = 'mode-switch-overlay';
    overlay.innerHTML = '<div class="mode-switch-text">' + text + '</div>';
    document.body.appendChild(overlay);

    setTimeout(() => {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 1000);
  }

  function toggleViewMode(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('settingsMenu');
    if (menu) menu.style.display = 'none';

    const currentlySimple = isSimpleMode();
    if (currentlySimple) {
      // Switch back to Full View
      document.documentElement.removeAttribute('data-view');
      try { localStorage.setItem('yutorah_view_mode', 'full'); } catch(err) {}
      triggerModeOverlay('MGR');
    } else {
      // Switch to Simple View
      document.documentElement.setAttribute('data-view', 'simple');
      try { localStorage.setItem('yutorah_view_mode', 'simple'); } catch(err) {}
      triggerModeOverlay('CSR');

      // If active tab was one of the complex tabs, switch back to editors
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab && (activeTab.id === 'tab-series' || activeTab.id === 'tab-viewed' || activeTab.id === 'tab-parsha' || activeTab.id === 'tab-trending')) {
        switchCollection('editors');
      }
    }
    updateSettingsMenuText();
    syncHeaderSpacer();
  }

  // Holiday & Seasonal Theme Management (Light Mode Exclusively)
  const clientThemes = ${jsEmbed(THEMES)};

  function getClientHebrewDate() {
    try {
      const formatter = new Intl.DateTimeFormat('en-u-ca-hebrew', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
      const parts = formatter.formatToParts(new Date());
      const day = parseInt(parts.find(p => p.type === 'day')?.value || '1', 10);
      const month = (parts.find(p => p.type === 'month')?.value || 'Elul').trim();
      const year = parseInt(parts.find(p => p.type === 'year')?.value || '5786', 10);

      const d = new Date();
      let omerDay = 0;
      if (month === 'Nisan' && day >= 16) {
        omerDay = day - 15;
      } else if (month === 'Iyar') {
        omerDay = 15 + day;
      } else if (month === 'Sivan' && day <= 5) {
        omerDay = 44 + day;
      }

      return { day, month, year, omerDay, gregorianMonth: d.getMonth() + 1, gregorianDay: d.getDate() };
    } catch (e) {
      return { day: 22, month: 'Elul', year: 5786, omerDay: 0, gregorianMonth: 9, gregorianDay: 4 };
    }
  }

  function detectCurrentHoliday() {
    const h = getClientHebrewDate();
    const { day, month, omerDay, gregorianMonth, gregorianDay } = h;

    if (gregorianMonth === 7 && gregorianDay === 4) return { key: 'july4', chanukahDay: 0 };

    // Erev Yom Tov (Eve of Melacha-forbidden festivals) with 50/50 random overlap selection
    // Erev Rosh Hashanah (29 Elul) -> 50/50 between Rosh Hashanah and Chodesh Elul
    if (month === 'Elul' && day === 29) {
      return Math.random() < 0.5
        ? { key: 'rosh_hashanah', chanukahDay: 0 }
        : { key: 'elul', chanukahDay: 0 };
    }

    // Erev Yom Kippur (9 Tishrei) -> 50/50 between Yom Kippur and Aseres Yemei Teshuva
    if (month === 'Tishri' && day === 9) {
      return Math.random() < 0.5
        ? { key: 'yom_kippur', chanukahDay: 0 }
        : { key: 'teshuva', chanukahDay: 0 };
    }

    // Erev Sukkos (14 Tishrei) -> Sukkos theme
    if (month === 'Tishri' && day === 14) {
      return { key: 'sukkos', chanukahDay: 0 };
    }

    // Erev Shemini Atzeres / Simchas Torah (21 Tishrei) -> 50/50 between Simchas Torah and Hoshana Rabbah
    if (month === 'Tishri' && day === 21) {
      return Math.random() < 0.5
        ? { key: 'simchas_torah', chanukahDay: 0 }
        : { key: 'hoshana_rabbah', chanukahDay: 0 };
    }

    // Erev Pesach (14 Nisan) -> 50/50 between Pesach and Nissan buildup
    if (month === 'Nisan' && day === 14) {
      return Math.random() < 0.5
        ? { key: 'pesach', chanukahDay: 0 }
        : { key: 'nissan_buildup', chanukahDay: 0 };
    }

    // Erev Shavuos (5 Sivan) -> 50/50 between Shavuos and Sefiras HaOmer (Day 49)
    if (month === 'Sivan' && day === 5) {
      return Math.random() < 0.5
        ? { key: 'shavuos', chanukahDay: 0 }
        : { key: 'omer', omerDay: 49, chanukahDay: 0 };
    }

    if (month === 'Tishri' && day === 10) return { key: 'yom_kippur', chanukahDay: 0 };
    if (month === 'Tishri' && (day === 1 || day === 2)) return { key: 'rosh_hashanah', chanukahDay: 0 };
    if (month === 'Tishri' && day >= 3 && day <= 8) return { key: 'teshuva', chanukahDay: 0 };
    if (month === 'Tishri' && (day === 22 || day === 23)) return { key: 'simchas_torah', chanukahDay: 0 };
    if (month === 'Tishri' && day >= 15 && day <= 20) return { key: 'sukkos', chanukahDay: 0 };

    if ((month === 'Heshvan' && day === 1) || (month === 'Tishri' && day === 30)) {
      return { key: 'rosh_chodesh_cheshvan', chanukahDay: 0 };
    }

    if (month === 'Kislev' && day >= 25) {
      return { key: 'chanukah', chanukahDay: day - 24 };
    }
    if (month === 'Tevet' && day <= 3) {
      return { key: 'chanukah', chanukahDay: Math.min(8, 5 + day) };
    }

    if (month === 'Shevat' && day === 15) return { key: 'tubshevat', chanukahDay: 0 };

    const isPurimMonth = month === 'Adar II' || month === 'Adar';
    if (isPurimMonth && (day === 14 || day === 15)) return { key: 'purim', chanukahDay: 0 };
    if (isPurimMonth && (day === 13 || day === 11)) return { key: 'taanis_esther', chanukahDay: 0 };
    if (isPurimMonth && day < 13) return { key: 'adar_buildup', chanukahDay: 0 };

    if (month === 'Nisan' && day >= 15 && day <= 22) return { key: 'pesach', chanukahDay: 0 };
    if (month === 'Nisan' && day < 15) return { key: 'nissan_buildup', chanukahDay: 0 };

    if (month === 'Iyar' && (day === 3 || day === 4)) return { key: 'yom_hazikaron', chanukahDay: 0 };
    if (month === 'Iyar' && (day === 5 || day === 6)) return { key: 'yom_haatzmaut', chanukahDay: 0 };
    if (month === 'Iyar' && day === 18) return { key: 'lag_baomer', chanukahDay: 0 };
    if (month === 'Iyar' && day === 28) return { key: 'yom_yerushalayim', chanukahDay: 0 };

    if (month === 'Sivan' && (day === 6 || day === 7)) return { key: 'shavuos', chanukahDay: 0 };
    if (omerDay > 0) return { key: 'omer', omerDay, chanukahDay: 0 };

    if (month === 'Av' && (day === 9 || day === 10)) return { key: 'tisha_bav', chanukahDay: 0 };
    if (month === 'Av' && day >= 1 && day <= 8) return { key: 'nine_days', chanukahDay: 0 };
    if (month === 'Tamuz' && day >= 17) return { key: 'three_weeks', chanukahDay: 0 };
    if (month === 'Av' && day === 15) return { key: 'tubav', chanukahDay: 0 };

    if (month === 'Elul') return { key: 'elul', chanukahDay: 0 };
    if (day === 1 || day === 30) return { key: 'rosh_chodesh', chanukahDay: 0 };

    return { key: 'default', chanukahDay: 0 };
  }

  // [DEAD CODE / INACTIVE] Manual Theme Preview Override Controls
  // The theme engine now operates 100% automatically in the background using the Hebrew calendar.
  let activeThemeKey = 'auto';
  let activeVariant = 'a';

  function applyHolidayTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const motifWrap = document.getElementById('holidayMotifWrap');
    const motifIcon = document.getElementById('holidayMotifIcon');
    const motifTitle = document.getElementById('holidayMotifTitle');
    const taglineBar = document.getElementById('holidayTaglineBar');

    // Clean up previous dynamic theme style tag
    let themeStyleEl = document.getElementById('holidayThemeDynamicStyles');
    if (themeStyleEl) themeStyleEl.remove();

    let resolvedKey = activeThemeKey;
    let chanukahDay = 0;
    if (resolvedKey.startsWith('chanukah_')) {
      chanukahDay = parseInt(resolvedKey.replace('chanukah_', ''), 10);
      resolvedKey = 'chanukah';
    }

    if (resolvedKey === 'auto') {
      const detected = detectCurrentHoliday();
      resolvedKey = detected.key;
      chanukahDay = detected.chanukahDay || 1;
    }

    if (!resolvedKey || resolvedKey === 'default' || !clientThemes[resolvedKey]) {
      if (motifWrap) motifWrap.style.display = 'none';
      if (taglineBar) taglineBar.style.display = 'none';
      document.body.classList.remove('is-purim-theme');
      checkCalendarOverflow();
      return;
    }

    const themeDef = clientThemes[resolvedKey];
    let variantData;

    // For approved themes in auto mode (or if chosen in dropdown), randomly pick between A and B or lock to approved variant
    let effectiveVariant = activeVariant;
    const randomApprovedThemes = ['rosh_hashanah', 'sukkos', 'simchas_torah', 'adar_buildup', 'nissan_buildup', 'pesach', 'lag_baomer', 'shavuos', 'nine_days'];
    if (randomApprovedThemes.includes(resolvedKey) && activeThemeKey === 'auto') {
      effectiveVariant = Math.random() < 0.5 ? 'a' : 'b';
    }
    const lockedThemesToA = ['elul', 'yom_kippur', 'tubshevat', 'purim', 'taanis_esther', 'omer', 'yom_hazikaron', 'yom_yerushalayim', 'july4', 'three_weeks', 'tisha_bav', 'tubav', 'rosh_chodesh'];
    if (lockedThemesToA.includes(resolvedKey) && activeThemeKey === 'auto') {
      effectiveVariant = 'a';
    }
    const lockedThemesToB = ['yom_haatzmaut'];
    if (lockedThemesToB.includes(resolvedKey) && activeThemeKey === 'auto') {
      effectiveVariant = 'b';
    }

    if (resolvedKey === 'chanukah') {
      const dayNum = chanukahDay || 1;
      variantData = Object.assign({}, themeDef.variants['a']);
      variantData.icon = 'chanukah_a_' + dayNum + '.svg';
      variantData.title = 'Chanukah (Night ' + dayNum + ')';
      variantData.tagline = 'חנוכה שמח · Night ' + dayNum + ' of 8';
    } else if (resolvedKey === 'omer') {
      variantData = Object.assign({}, themeDef.variants['a']);
      // Randomly select between the two icons (flip calendar vs parchment scroll)
      variantData.icon = Math.random() < 0.5 ? 'omer_a.svg' : 'omer_b.svg';
      const h = getClientHebrewDate();
      if (h.omerDay > 0) {
        variantData.tagline = 'היום ' + h.omerDay + ' ימים לעומר · Count: Day ' + h.omerDay + ' of 49';
      }
    } else {
      variantData = themeDef.variants[effectiveVariant] || themeDef.variants['a'];
    }

    if (!variantData) return;

    // Apply CSS Variables to root (light mode only)
    if (!isDark) {
      if (variantData.primary) document.documentElement.style.setProperty('--primary', variantData.primary);
      if (variantData.accent) document.documentElement.style.setProperty('--accent', variantData.accent);
      if (variantData.bannerBg) document.documentElement.style.setProperty('--banner-bg', variantData.bannerBg);
    }

    // Render Motif Badge in Header (both light and dark mode)
    if (motifWrap && motifIcon && motifTitle) {
      motifWrap.style.display = 'inline-flex';
      motifIcon.innerHTML = '<img src="/assets/themes/' + variantData.icon + '" alt="icon" style="width:100%; height:100%; display:block;" onerror="this.style.display=&quot;none&quot;">';
      motifTitle.textContent = themeDef.badge || themeDef.name;
      motifWrap.title = variantData.title + ' (Tap 7 times to toggle pre-roll)';
    }

    // Toggle Purim Inverted Header Mode
    if (resolvedKey === 'purim') {
      document.body.classList.add('is-purim-theme');
    } else {
      document.body.classList.remove('is-purim-theme');
    }

    // Render Tagline Bar below sponsorship banner
    if (taglineBar && variantData.tagline) {
      taglineBar.style.display = 'block';
      taglineBar.textContent = variantData.tagline;
    } else if (taglineBar) {
      taglineBar.style.display = 'none';
    }

    // Inject custom CSS for theme variant
    if (variantData.css && !isDark) {
      themeStyleEl = document.createElement('style');
      themeStyleEl.id = 'holidayThemeDynamicStyles';
      themeStyleEl.textContent = variantData.css;
      document.head.appendChild(themeStyleEl);
    }
    checkCalendarOverflow();

    // Update controls in Settings menu
    const sel = document.getElementById('holidayThemeSelect');
    if (sel) sel.value = activeThemeKey;
    const btnA = document.getElementById('variantBtnA');
    const btnB = document.getElementById('variantBtnB');
    const btnC = document.getElementById('variantBtnC');
    if (btnA) btnA.classList.toggle('active', activeVariant === 'a');
    if (btnB) btnB.classList.toggle('active', activeVariant === 'b');
    if (btnC) {
      if (resolvedKey === 'elul') {
        btnC.style.display = 'block';
        btnC.classList.toggle('active', activeVariant === 'c');
      } else {
        btnC.style.display = 'none';
      }
    }

    syncHeaderSpacer();
  }

  function onHolidayThemeSelect(val) {
    activeThemeKey = val;
    if (val === 'yom_haatzmaut') {
      activeVariant = 'b';
    } else if (lockedThemesToA.includes(val)) {
      activeVariant = 'a';
    }
    try { localStorage.setItem('yutorah_preview_theme', val); } catch(e) {}
    try { localStorage.setItem('yutorah_preview_variant', activeVariant); } catch(e) {}
    applyHolidayTheme();
  }

  function setThemeVariant(variant) {
    activeVariant = variant;
    try { localStorage.setItem('yutorah_preview_variant', variant); } catch(e) {}
    applyHolidayTheme();
  }

  document.addEventListener('click', function(e) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    if (menu && menu.style.display === 'block') {
      if (btn && !btn.contains(e.target) && !menu.contains(e.target)) {
        menu.style.display = 'none';
      }
    }
  });

  // Cards / Rows view (persisted). Rows = one full-width row per shiur,
  // yutorah.org style; applies to every shiur grid on the page.
  // Mobile is always cards (toggle hidden); desktop defaults to rows.
  function isMobileView() {
    try {
      return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    } catch (e) {
      return false;
    }
  }
  function storedCardView() {
    try {
      return localStorage.getItem('yutorah_card_view') || '';
    } catch (e) {
      return '';
    }
  }
  function setCardView(view, persist) {
    let v = view === 'rows' ? 'rows' : 'cards';
    if (v === 'rows' && isMobileView()) v = 'cards';
    // Fix visible grids' inline display so the view takes effect immediately
    // (stale inline grid/flex from tab switches would otherwise win).
    try {
      document.querySelectorAll('.shiur-cards-grid, .series-grid').forEach(g => {
        if (g.id === 'grid-trending') return;
        if (g.style.display && g.style.display !== 'none') {
          g.style.display = (v === 'rows') ? 'flex' : 'grid';
        }
      });
      const sg = document.getElementById('searchResultsGrid');
      if (sg && sg.style.display && sg.style.display !== 'none') {
        sg.style.display = (v === 'rows') ? 'flex' : 'grid';
      }
    } catch (e) {}
    document.body.classList.toggle('rows-view', v === 'rows');
    if (document.documentElement) document.documentElement.classList.toggle('rows-view', v === 'rows');
    if (persist !== false) {
      try { localStorage.setItem('yutorah_card_view', v); } catch (e) {}
    }
    document.querySelectorAll('.view-toggle-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset && b.dataset.view === v);
    });
  }
  function defaultCardView() {
    const stored = storedCardView();
    if (stored === 'rows' || stored === 'cards') return isMobileView() ? 'cards' : stored;
    return isMobileView() ? 'cards' : 'rows';
  }

  // Hero slideshow rotation (6s autoplay, dots + arrows, pause on hover).
  let heroIdx = 0;
  let heroTimer = null;
  function heroShow(i) {
    const slides = document.querySelectorAll('#heroSlideshow .hero-slide');
    const dots = document.querySelectorAll('#heroSlideshow .hero-dot');
    if (!slides.length) return;
    heroIdx = ((i % slides.length) + slides.length) % slides.length;
    slides.forEach((s, k) => {
      const on = k === heroIdx;
      s.classList.toggle('active', on);
      if (s.tagName === 'A') {
        s.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (on) {
          s.removeAttribute('tabindex');
          s.removeAttribute('inert');
        } else {
          s.setAttribute('tabindex', '-1');
          s.setAttribute('inert', '');
        }
      } else {
        s.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (on) {
          s.setAttribute('tabindex', '0');
          s.removeAttribute('inert');
        } else {
          s.setAttribute('tabindex', '-1');
          s.setAttribute('inert', '');
        }
      }
    });
    dots.forEach((d, k) => d.classList.toggle('active', k === heroIdx));
  }
  function heroGo(dir) {
    heroShow(heroIdx + dir);
    heroRestart();
  }
  function heroGoTo(i) {
    heroShow(i);
    heroRestart();
  }
  function heroRestart() {
    try { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } } catch (e) {}
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) {}
    heroTimer = setInterval(() => {
      const slides = document.querySelectorAll('#heroSlideshow .hero-slide');
      if (slides.length > 1 && !document.hidden) heroShow(heroIdx + 1);
    }, 6000);
  }
  function switchCollection(activeName) {
    // Playlists tab stays open for everyone (logged-out sees the login
    // prompt + public browser); only interactive extras need an account.
    // Respect the cards/rows view: inline display must match the active
    // view or it would override the rows-view stylesheet after switching.
    const rowsOn = document.body.classList.contains('rows-view') ||
      (document.documentElement && document.documentElement.classList.contains('rows-view'));
    collections.forEach(name => {
      const tab = document.getElementById('tab-' + name);
      const grid = document.getElementById('grid-' + name);
      if (tab) tab.classList.toggle('active', name === activeName);
      if (grid) {
        if (name === activeName) {
          grid.style.display = (name === 'trending' ? 'block' : (rowsOn ? 'flex' : 'grid'));
        } else {
          grid.style.display = 'none';
        }
      }
    });
    const titleEl = document.getElementById('activeCollectionTitle');
    if (titleEl && collectionTitles[activeName]) {
      titleEl.textContent = collectionTitles[activeName];
    }
    if (activeName === 'viewed') {
      renderRecentlyViewedGrid();
    } else if (activeName === 'parsha') {
      loadParshaShiurimGrid();
    } else if (activeName === 'playlists') {
      renderPlaylistsGrid();
    } else if (activeName === 'dev-playlists') {
      renderDevCuratedGrid();
    }
    try { if (typeof devUpgradeCards === 'function') devUpgradeCards(); } catch (e) {}
    // Keep playlist deep-links truthful: sync on entry, clear on leave.
    try {
      if (activeName === 'playlists') {
        syncPlaylistUrl();
      } else {
        const u = new URL(window.location.href);
        const before = u.search;
        clearPlaylistUrlKeys(u);
        if (u.search !== before) history.replaceState(history.state, '', u.toString());
      }
    } catch (e) {}
  }

  let activeDevPersonaFilter = 'all';

  function renderDevCuratedGrid() {
    const grid = document.getElementById('grid-dev-playlists');
    if (!grid) return;
    const store = getDevStore();
    const rowsOn = document.body.classList.contains('rows-view') ||
      (document.documentElement && document.documentElement.classList.contains('rows-view'));
    grid.style.display = rowsOn ? 'flex' : 'grid';

    // Merge seeds with any local overrides in store.custom
    const allPlaylists = (typeof DEV_PUBLIC_SEEDS !== 'undefined' ? DEV_PUBLIC_SEEDS : []).map(seed => {
      const custom = store.custom && store.custom[seed.id];
      if (custom) {
        return {
          id: seed.id,
          title: custom.name || seed.title,
          ownerName: custom.ownerName || seed.ownerName,
          description: custom.description !== undefined ? custom.description : seed.description,
          tags: custom.tags || seed.tags,
          items: custom.items || seed.items || []
        };
      }
      return seed;
    });

    const filtered = (activeDevPersonaFilter === 'all')
      ? allPlaylists
      : allPlaylists.filter(p => p.ownerName === activeDevPersonaFilter);

    let html = '<div style="grid-column:1/-1; margin-bottom:12px;">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">' +
        '<div>' +
          '<h3 style="margin:0 0 4px; font-size:18px; font-weight:800; color:var(--text,#111);">🛠️ Dev Curated Playlists</h3>' +
          '<div style="font-size:13px; color:var(--text-muted,#666);">30 Curated Playlists across 3 distinct personas (10 each). Click ✏️ Edit to modify attribution, title, tags, or description.</div>' +
        '</div>' +
        '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
          ['all', 'Andrew Ohiliote', 'Moshe Mendelwitz', 'Rachel Sternbach'].map(p => {
            const label = p === 'all' ? 'All (30)' : p + ' (10)';
            const active = activeDevPersonaFilter === p;
            return '<button type="button" class="card-mini-btn' + (active ? ' active-save' : '') + '" onclick="setDevPersonaFilter(&quot;' + escapeHtml(p) + '&quot;)">' + escapeHtml(label) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
    '</div>';

    html += filtered.map(p => {
      const tagBits = []
        .concat((p.tags && p.tags.teachers || []).map(t => '👤 ' + t.name))
        .concat((p.tags && p.tags.venues || []).map(t => '📍 ' + t.name))
        .concat((p.tags && p.tags.topics || []).map(t => '🏷️ ' + t.name));
      const itemCount = (p.items || []).length;
      return '<div class="playlist-public-card">' +
        '<div class="playlist-card-title">' + escapeHtml(p.title || 'Untitled') + '</div>' +
        '<div class="playlist-card-meta">by <strong>' + escapeHtml(p.ownerName || 'Unknown') + '</strong> · ' + itemCount + ' shiurim</div>' +
        (p.description ? '<div class="playlist-card-desc">' + escapeHtml(p.description) + '</div>' : '') +
        (tagBits.length ? '<div class="playlist-card-tags">' + tagBits.map(t => '<span class="playlist-tag-chip">' + escapeHtml(t) + '</span>').join('') + '</div>' : '') +
        '<div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">' +
          '<button type="button" class="card-mini-btn" onclick="devPlayCuratedAll(&quot;' + escapeHtml(p.id) + '&quot;)">▶ Play All</button>' +
          '<button type="button" class="card-mini-btn active-save" onclick="devEditPublicPlaylist(&quot;' + escapeHtml(p.id) + '&quot;)">✏️ Edit (Dev)</button>' +
          '<button type="button" class="card-mini-btn" onclick="devOpenInMyPlaylists(&quot;' + escapeHtml(p.id) + '&quot;)">📋 View in My Playlists</button>' +
        '</div>' +
      '</div>';
    }).join('');

    grid.innerHTML = html;
  }
  window.renderDevCuratedGrid = renderDevCuratedGrid;
  window.setDevPersonaFilter = function(filter) {
    activeDevPersonaFilter = filter;
    renderDevCuratedGrid();
  };
  window.devPlayCuratedAll = function(id) {
    const store = getDevStore();
    if (!store.custom[id]) {
      devEditPublicPlaylist(id);
    }
    activeDevPlaylistId = id;
    switchCollection('playlists');
    playDevPlaylistAll();
  };
  window.devOpenInMyPlaylists = function(id) {
    const store = getDevStore();
    if (!store.custom[id]) {
      const found = (typeof DEV_PUBLIC_SEEDS !== 'undefined' && DEV_PUBLIC_SEEDS.find(p => p.id === id));
      if (found) {
        store.custom[id] = {
          id: found.id,
          name: found.title || found.name,
          ownerName: found.ownerName,
          description: found.description || '',
          tags: found.tags || { teachers: [], venues: [], topics: [] },
          publicId: found.id,
          isPublic: true,
          isDevOwned: true,
          icon: '📁',
          items: found.items || []
        };
        saveDevStore(store);
      }
    }
    activeDevPlaylistId = id;
    switchCollection('playlists');
  };

  // Audio Controls
  function togglePlay() {
    if (isCurrentShiurArticle) return;
    if (!audio.src) {
      if (pendingShiur) {
        if (!sponsorPlayedForThisShiur && currentSponsorAudio && !isPreRollDisabled()) {
          playSponsorPreRoll(pendingShiur);
          return;
        } else {
          startShiurPlayback(pendingShiur);
          return;
        }
      }
      // If no audio loaded yet, play the first shiur
      const firstCard = document.querySelector('.quick-card-link');
      if (firstCard) firstCard.click();
      return;
    }
    if (audio.paused) {
      if (!sponsorPlayedForThisShiur && currentSponsorAudio && pendingShiur && !isSponsorPlaying && !isPreRollDisabled()) {
        playSponsorPreRoll(pendingShiur);
        return;
      }
      audio.play().catch(e => console.log('Play blocked:', e));
    } else {
      audio.pause();
    }
  }

  function skip(sec) {
    if (isCurrentShiurArticle || isSponsorPlaying) return;
    if (!audio.src) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + sec));
    updateUrlTimestamp(true);
  }

  function setSpeed(rate) {
    const r = parseFloat(rate);
    if (isNaN(r) || r <= 0) return;
    currentPlaybackRate = r;
    audio.playbackRate = r;
    const sel = document.getElementById('speedSelect');
    if (sel) {
      let found = false;
      for (let i = 0; i < sel.options.length; i++) {
        if (parseFloat(sel.options[i].value) === r) {
          sel.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        const opt = document.createElement('option');
        opt.value = String(r);
        opt.textContent = r + 'x';
        opt.selected = true;
        sel.appendChild(opt);
      }
    }
    try {
      const url = new URL(window.location.href);
      if (r === 1) {
        url.searchParams.delete('speed');
        url.searchParams.delete('rate');
      } else {
        url.searchParams.delete('rate');
        url.searchParams.set('speed', r);
      }
      history.replaceState(history.state, '', url.toString());
    } catch(e) {}
  }

  function copyShareLink() {
    const curSec = Math.floor(audio.currentTime);
    const url = new URL(window.location.href);
    url.searchParams.set('t', curSec);
    const rate = currentPlaybackRate || audio.playbackRate;
    if (rate && rate !== 1) {
      url.searchParams.delete('rate');
      url.searchParams.set('speed', rate);
    } else {
      url.searchParams.delete('speed');
      url.searchParams.delete('rate');
    }
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const hasExplicitTheme = url.searchParams.has('mode') || url.searchParams.has('theme') || Boolean(localStorage.getItem('yutorah_theme'));
    if (hasExplicitTheme) {
      const themeKey = url.searchParams.has('theme') ? 'theme' : 'mode';
      url.searchParams.delete('dark');
      url.searchParams.delete('light');
      url.searchParams.delete('mode');
      url.searchParams.delete('theme');
      url.searchParams.set(themeKey, isDark ? 'dark' : 'light');
    }
    navigator.clipboard.writeText(url.toString()).then(() => {
      const btn = document.getElementById('copyLinkBtn');
      btn.textContent = '✅ Copied (' + formatTime(curSec) + ')!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋 Copy Link @ Time';
        btn.classList.remove('copied');
      }, 2000);
    });
  }

  // High-performance Scrubber (Instant 60fps dragging, snappy click-to-seek)
  let isScrubbing = false;
  let scrubPct = 0;
  const scrubberBar = document.getElementById('scrubberBar');
  const scrubberFill = document.getElementById('scrubberFill');
  const curTimeEl = document.getElementById('curTime');

  function getScrubPct(clientX) {
    const rect = scrubberBar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function updateScrubberUi(pct) {
    scrubPct = pct;
    scrubberFill.style.width = (pct * 100) + '%';
    if (scrubberBar) {
      scrubberBar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
    }
    if (audio.duration && !isNaN(audio.duration)) {
      curTimeEl.textContent = formatTime(pct * audio.duration);
      if (scrubberBar) {
        scrubberBar.setAttribute('aria-valuetext', formatTime(pct * audio.duration) + ' of ' + formatTime(audio.duration));
      }
      const miniFill = document.getElementById('miniProgressFill');
      if (miniFill) miniFill.style.width = (pct * 100) + '%';
      const miniTime = document.getElementById('miniTime');
      if (miniTime) miniTime.textContent = formatTime(pct * audio.duration) + ' / ' + formatTime(audio.duration);
    }
  }

  function onScrubStart(e) {
    if (isSponsorPlaying || !audio.duration || isNaN(audio.duration)) return;
    isScrubbing = true;
    scrubberBar.classList.add('is-dragging');
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = getScrubPct(clientX);
    updateScrubberUi(pct);
  }

  function onScrubMove(e) {
    if (!isScrubbing || !audio.duration || isNaN(audio.duration)) return;
    if (e.cancelable) e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = getScrubPct(clientX);
    updateScrubberUi(pct);
  }

  function onScrubEnd() {
    if (!isScrubbing) return;
    isScrubbing = false;
    scrubberBar.classList.remove('is-dragging');
    if (audio.duration && !isNaN(audio.duration)) {
      const targetSec = scrubPct * audio.duration;
      audio.currentTime = targetSec;
      updateUrlTimestamp(true);
    }
  }

  scrubberBar.addEventListener('mousedown', onScrubStart);
  window.addEventListener('mousemove', onScrubMove);
  window.addEventListener('mouseup', onScrubEnd);

  scrubberBar.addEventListener('touchstart', onScrubStart, { passive: false });
  window.addEventListener('touchmove', onScrubMove, { passive: false });
  window.addEventListener('touchend', onScrubEnd);
  window.addEventListener('touchcancel', onScrubEnd);

  scrubberBar.addEventListener('keydown', function(e) {
    if (isSponsorPlaying || !audio.duration || isNaN(audio.duration)) return;
    let delta = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -5;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = 5;
    else if (e.key === 'PageDown') delta = -30;
    else if (e.key === 'PageUp') delta = 30;
    else if (e.key === 'Home') {
      e.preventDefault();
      audio.currentTime = 0;
      updateScrubberUi(0);
      updateUrlTimestamp(true);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      audio.currentTime = audio.duration;
      updateScrubberUi(1);
      updateUrlTimestamp(true);
      return;
    }
    if (delta !== 0) {
      e.preventDefault();
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
      updateScrubberUi(audio.currentTime / audio.duration);
      updateUrlTimestamp(true);
    }
  });

  // Play / Pause SVG Icons (Clean white lines without emoji background)
  const PLAY_ICON_MAIN = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin-left:3px;"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON_MAIN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><rect x="5" y="4" width="4" height="16" rx="1.5"/><rect x="15" y="4" width="4" height="16" rx="1.5"/></svg>';
  const PLAY_ICON_MINI = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON_MINI = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><rect x="5" y="4" width="4" height="16" rx="1.5"/><rect x="15" y="4" width="4" height="16" rx="1.5"/></svg>';

  function updatePlayPauseIcons(isPlaying) {
    const mainBtn = document.getElementById('playBtn');
    if (mainBtn) {
      mainBtn.innerHTML = isPlaying ? PAUSE_ICON_MAIN : PLAY_ICON_MAIN;
      mainBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    }
    const miniBtn = document.getElementById('miniPlayBtn');
    if (miniBtn) {
      miniBtn.innerHTML = isPlaying ? PAUSE_ICON_MINI : PLAY_ICON_MINI;
      miniBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    }
  }

  // Audio Events
  let lastMediaSessionPosUpdate = 0;
  audio.addEventListener('play', () => {
    updatePlayPauseIcons(true);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
      updateMediaSessionPosition();
    }
    if (isSponsorPlaying) {
      resetSponsorWatchdog();
      startSponsorRaf();
    }
  });
  audio.addEventListener('pause', () => {
    updatePlayPauseIcons(false);
    updateUrlTimestamp(true);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
      updateMediaSessionPosition();
    }
    if (typeof devRecordHeartbeat === 'function') devRecordHeartbeat(true);
    try {
      if (typeof markCloudDirty === 'function') markCloudDirty('history');
      if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
    } catch (e) {}
    if (isSponsorPlaying) {
      clearSponsorTimers();
      stopSponsorRaf();
    }
  });
  audio.addEventListener('waiting', () => {
    if (isSponsorPlaying && pendingShiur) {
      if (sponsorStallTimer) clearTimeout(sponsorStallTimer);
      sponsorStallTimer = setTimeout(() => {
        if (isSponsorPlaying && pendingShiur && audio.readyState < 3) {
          console.warn('Sponsor audio stalled for >8s, advancing to shiur');
          startShiurPlayback(pendingShiur);
        }
      }, 8000);
    }
  });
  audio.addEventListener('playing', () => {
    if (sponsorStallTimer) {
      clearTimeout(sponsorStallTimer);
      sponsorStallTimer = null;
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (isSponsorPlaying) {
      if (audio.duration && !isNaN(audio.duration)) {
        if (audio.currentTime >= audio.duration - 0.25) {
          startShiurPlayback(pendingShiur);
          return;
        }
        const rem = Math.max(0, Math.ceil(audio.duration - audio.currentTime));
        const countdownEl = document.getElementById('sponsorCountdown');
        if (countdownEl) countdownEl.textContent = rem;
        const pct = (audio.currentTime / audio.duration) * 100;
        if (scrubberFill) scrubberFill.style.width = pct + '%';
        curTimeEl.textContent = formatTime(audio.currentTime);
        document.getElementById('totalTime').textContent = formatTime(audio.duration);
        const miniFill = document.getElementById('miniProgressFill');
        if (miniFill) miniFill.style.width = pct + '%';
        const miniTime = document.getElementById('miniTime');
        if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
      }
      return;
    }
    if (isScrubbing) return;
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    scrubberFill.style.width = pct + '%';
    curTimeEl.textContent = formatTime(audio.currentTime);

    const miniFill = document.getElementById('miniProgressFill');
    if (miniFill) miniFill.style.width = pct + '%';
    const miniTime = document.getElementById('miniTime');
    if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);

    updateUrlTimestamp(false);
    if (typeof devRecordHeartbeat === 'function') devRecordHeartbeat(false);
    const now = Date.now();
    if (now - lastMediaSessionPosUpdate > 1000) {
      lastMediaSessionPosUpdate = now;
      updateMediaSessionPosition();
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    document.getElementById('totalTime').textContent = formatTime(audio.duration);
    const miniTime = document.getElementById('miniTime');
    if (miniTime) miniTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
    if (isSponsorPlaying && audio.duration && !isNaN(audio.duration)) {
      const countdownEl = document.getElementById('sponsorCountdown');
      if (countdownEl) countdownEl.textContent = Math.ceil(audio.duration);
    }
    applyInitialTime();
  });
  audio.addEventListener('canplay', () => {
    if (currentPlaybackRate) {
      audio.playbackRate = currentPlaybackRate;
    }
    applyInitialTime();
  });
  audio.addEventListener('ended', () => {
    if (isSponsorPlaying && pendingShiur) {
      startShiurPlayback(pendingShiur);
      return;
    }
    updatePlayPauseIcons(false);
    if (typeof devMarkCompleted === 'function' && !isSponsorPlaying) devMarkCompleted();
    // Dev queue: auto-play the next queued shiur when a track ends.
    if (!isSponsorPlaying) {
      try {
        if (typeof devPlayNextFromQueue === 'function' && devPlayNextFromQueue()) return;
      } catch (e) {}
    }
    if (currentShiurId) {
      try { localStorage.removeItem('yutorah_progress_' + currentShiurId); } catch(e) {}
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('t');
    history.replaceState(history.state, '', url.toString());
  });

  if (audio.readyState >= 1) {
    applyInitialTime();
  }

  // Save timestamp when page/tab is backgrounded or closed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      updateUrlTimestamp(true);
      try {
        if (typeof markCloudDirty === 'function') markCloudDirty('history');
        if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
      } catch (e) {}
    }
  });
  window.addEventListener('beforeunload', () => {
    updateUrlTimestamp(true);
  });
  window.addEventListener('pagehide', () => {
    updateUrlTimestamp(true);
  });

  // Fallback if primary audio stream errors
  audio.addEventListener('error', () => {
    if (isSponsorPlaying && pendingShiur) {
      console.warn('Sponsor audio encountered error, advancing to shiur...');
      skipSponsorAudio();
      return;
    }
    console.warn('Audio element error with current source:', audio.src);
    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn && dlBtn.href && dlBtn.href !== audio.src) {
      console.log('Attempting fallback source:', dlBtn.href);
      audio.src = dlBtn.href;
      audio.load();
      audio.play().catch(e => console.log('Fallback play error:', e));
    }
  });

  // Mobile Lock Screen & Notification Center (MediaSession API)
  if ('mediaSession' in navigator) {
    registerMediaSessionHandlers();
    if (hasAudio) {
      updateMediaSession(${jsEmbed(title)}, ${jsEmbed(speaker)}, ${jsEmbed(photo)});
    }
  }

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (isCurrentShiurArticle) return; // Allow natural space scrolling and keyboard navigation in article mode
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(e.shiftKey ? -30 : -10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); skip(e.shiftKey ? 30 : 10); }
    else if (e.key === '[') {
      const sel = document.getElementById('speedSelect');
      if (sel.selectedIndex > 0) { sel.selectedIndex--; setSpeed(sel.value); }
    }
    else if (e.key === ']') {
      const sel = document.getElementById('speedSelect');
      if (sel.selectedIndex < sel.options.length - 1) { sel.selectedIndex++; setSpeed(sel.value); }
    }
    else if (e.key === 'm' || e.key === 'M') { audio.muted = !audio.muted; }
  });

  // Browser Back/Forward navigation sync
  window.addEventListener('popstate', () => {
    try {
      const p = new URL(window.location.href).searchParams;
      const s = p.get('speed') || p.get('rate');
      if (s) {
        const parsed = parseFloat(s);
        if (!isNaN(parsed) && parsed > 0 && parsed !== currentPlaybackRate) {
          setSpeed(parsed);
        }
      } else if (currentPlaybackRate !== 1) {
        setSpeed(1);
      }

      // Sync light/dark mode on back/forward navigation
      const rawTheme = (p.get('theme') || p.get('mode') || '').toLowerCase();
      if (rawTheme === 'dark' || p.get('dark') === '1' || (p.has('dark') && p.get('dark') !== '0')) {
        document.documentElement.setAttribute('data-theme', 'dark');
        try { localStorage.setItem('yutorah_theme', 'dark'); } catch(e) {}
        initTheme();
        applyHolidayTheme();
      } else if (rawTheme === 'light' || p.get('dark') === '0' || p.get('light') === '1') {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('yutorah_theme', 'light'); } catch(e) {}
        initTheme();
        applyHolidayTheme();
      }
      // Back/forward navigation: restore tab, playlist, or non-playlist collections
      try {
        if (p.get('tab') === 'playlists' && !p.get('search')) {
          if (readPlaylistUrlState()) {
            switchCollection('playlists');
            if (activeDevPlaylistId === 'public') plSearchPublic();
          }
        } else if (!p.get('search')) {
          const targetTab = p.get('tab') || 'editors';
          const validTabs = ['editors', 'series', 'recent', 'popular', 'viewed', 'parsha', 'trending'];
          if (validTabs.includes(targetTab) && typeof switchCollection === 'function') {
            switchCollection(targetTab);
          }
        }
      } catch (e) {}
      try {
        const pdm = document.getElementById('playlistDetailsModal');
        if (pdm) pdm.remove();
        const npm = document.getElementById('newPlaylistModal');
        if (npm) npm.remove();
        const scm = document.getElementById('saveChoiceModal');
        if (scm) scm.remove();
      } catch (e) {}
      try { if (typeof devRefreshCardButtons === 'function') devRefreshCardButtons(); } catch (e) {}
    } catch(e) {}
  });

  // Theme Management (Dark / Light mode)
  function initTheme() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.textContent = isDark ? '☀️' : '🌙';
      btn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
      btn.setAttribute('aria-label', isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode');
    }
    document.querySelectorAll('.menu-theme-icon').forEach(function(icon) {
      icon.textContent = isDark ? '☀️' : '🌙';
    });
    try { checkHeaderOverflow(); } catch(e) {}
  }

  function toggleTheme() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var nextDark = !isDark;
    if (nextDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('yutorah_theme', 'dark'); } catch(e) {}
    } else {
      document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('yutorah_theme', 'light'); } catch(e) {}
    }
    var btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.textContent = nextDark ? '☀️' : '🌙';
      btn.title = nextDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
      btn.setAttribute('aria-label', nextDark ? 'Switch to Light Mode' : 'Switch to Dark Mode');
    }
    document.querySelectorAll('.menu-theme-icon').forEach(function(icon) {
      icon.textContent = nextDark ? '☀️' : '🌙';
    });
    applyHolidayTheme();

    try {
      var url = new URL(window.location.href);
      var key = url.searchParams.has('theme') ? 'theme' : 'mode';
      url.searchParams.delete('dark');
      url.searchParams.delete('light');
      url.searchParams.delete('mode');
      url.searchParams.delete('theme');
      url.searchParams.set(key, nextDark ? 'dark' : 'light');
      history.replaceState(history.state, '', url.toString());
    } catch(e) {}
    try { checkHeaderOverflow(); } catch(e) {}
  }

  function syncHeaderSpacer() {
    var h = document.getElementById('mainHeader');
    var s = document.getElementById('headerSpacer');
    if (h && s) {
      s.style.height = h.offsetHeight + 'px';
    }
  }
  syncHeaderSpacer();
  window.addEventListener('resize', syncHeaderSpacer);

  function checkHeaderOverflow() {
    var header = document.getElementById('mainHeader');
    if (!header) return;
    var wWidth = window.innerWidth || document.documentElement.clientWidth;

    // 1. Hebrew Calendar Badge Check (hide on mobile or when clipped)
    var badge = document.getElementById('hebrewDateBadge');
    if (badge) {
      if (wWidth <= 640) {
        badge.style.display = 'none';
      } else {
        badge.style.display = 'inline-flex';
        var bRect = badge.getBoundingClientRect();
        var hRect = header.getBoundingClientRect();
        if (bRect.right > wWidth - 8 || bRect.right > hRect.right - 6 || bRect.left < 0 || bRect.top > hRect.top + 45) {
          badge.style.display = 'none';
        } else {
          badge.style.display = 'inline-flex';
        }
      }
    }

    // 2. Theme Toggle Button Check: Suppress from header if it would get cut off, wrapped, or collide with brand
    var themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      var isNarrow = wWidth <= 520;
      var isLoggedIn = document.body.classList.contains('is-logged-in');
      var isMobile = wWidth <= 640;

      // On narrow mobile screens (<= 520px) or when logged in on mobile, suppress from header
      if (isNarrow || (isMobile && isLoggedIn)) {
        themeBtn.style.display = 'none';
      } else {
        // Measure button bounds to ensure it is not cut off, wrapped, or colliding with brand
        themeBtn.style.display = 'inline-flex';
        var tRect = themeBtn.getBoundingClientRect();
        var hRect = header.getBoundingClientRect();
        var brand = header.querySelector('.brand');
        var brandRect = brand ? brand.getBoundingClientRect() : { right: 0 };
        var maxRight = Math.min(wWidth, hRect.right);

        var isCutOff = tRect.right > maxRight - 6 ||
                       tRect.top > hRect.top + (isMobile ? 38 : 46) ||
                       tRect.left < (brandRect.right || 0) + 8;
        if (isCutOff) {
          themeBtn.style.display = 'none';
        } else {
          themeBtn.style.display = 'inline-flex';
        }
      }
    }
  }

  function checkCalendarOverflow() {
    checkHeaderOverflow();
  }
  window.checkHeaderOverflow = checkHeaderOverflow;
  window.checkCalendarOverflow = checkCalendarOverflow;
  checkHeaderOverflow();
  window.addEventListener('resize', checkHeaderOverflow);

  initTheme();
  updateSettingsMenuText();
  applyHolidayTheme();
  try {
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
        if (!localStorage.getItem('yutorah_theme')) {
          if (e.matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
          initTheme();
          applyHolidayTheme();
        }
      });
    }
  } catch(e) {}

  // Auto-switch mini player based on scroll position / viewport visibility
  window.addEventListener('scroll', scheduleScrollAutoMiniPlayer, { passive: true });
  window.addEventListener('resize', scheduleScrollAutoMiniPlayer, { passive: true });
  window.addEventListener('orientationchange', scheduleScrollAutoMiniPlayer, { passive: true });
  if ('IntersectionObserver' in window) {
    var playerCardEl = document.getElementById('playerCard');
    if (playerCardEl) {
      var playerObserver = new IntersectionObserver(function() {
        scheduleScrollAutoMiniPlayer();
      }, { threshold: [0, 0.05, 0.5, 0.95, 1.0] });
      playerObserver.observe(playerCardEl);
    }
  }
  scheduleScrollAutoMiniPlayer();

  // ==========================================================================
  // Article & PDF Reader Controller (Liquid Mode Reflow & High-Res View)
  // ==========================================================================
  let pdfDoc = null;
  let pdfTotalPages = 0;
  let pdfCurrentPage = 1;
  let articleViewerMode = 'liquid'; // 'liquid' or 'original'
  let pageScrollMode = 'continuous'; // 'continuous' or 'single'
  let liquidFontSizeRem = 1.05;
  let originalCanvasScale = 1.35;
  let isRenderingCanvas = false;
  let pendingCanvasPage = null;
  let activeExtractionId = 0;
  let renderedContinuousPages = new Set();
  let continuousPageObserver = null;

  // Touch Zoom & Pan Tracking State for Original Page View
  let touchZoomState = {
    scale: 1.0,
    panX: 0,
    panY: 0,
    lastTouchX: 0,
    lastTouchY: 0,
    startDist: 0,
    startScale: 1.0,
    isPinching: false,
    isPanning: false,
    lastTapTime: 0
  };

  function getPdfProxyUrl(rawUrl) {
    if (!rawUrl) return '';
    let target = String(rawUrl).trim();
    if (target.startsWith('/')) {
      target = 'https://shiurim.yutorah.net' + target;
    }
    return '/api/pdf-proxy?url=' + encodeURIComponent(target);
  }

  function setArticleMode(mode) {
    articleViewerMode = mode;
    const btnLiquid = document.getElementById('modeBtnLiquid');
    const btnOriginal = document.getElementById('modeBtnOriginal');
    const viewLiquid = document.getElementById('articleLiquidViewport');
    const viewCanvas = document.getElementById('articleCanvasViewport');
    const fontControls = document.getElementById('fontSizeControls');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const pageNav = document.getElementById('articlePageNav');

    touchZoomState.scale = 1.0;
    touchZoomState.panX = 0;
    touchZoomState.panY = 0;
    applyTouchTransform();
    initTouchZoomTracking();

    if (mode === 'liquid') {
      if (btnLiquid) btnLiquid.classList.add('active');
      if (btnOriginal) btnOriginal.classList.remove('active');
      if (viewLiquid) viewLiquid.style.display = 'block';
      if (viewCanvas) viewCanvas.style.display = 'none';
      if (fontControls) fontControls.style.display = 'inline-flex';
      if (zoomInBtn) zoomInBtn.style.display = 'none';
      if (zoomOutBtn) zoomOutBtn.style.display = 'none';
      if (pageNav) pageNav.style.display = 'none';
    } else {
      if (btnLiquid) btnLiquid.classList.remove('active');
      if (btnOriginal) btnOriginal.classList.add('active');
      if (viewLiquid) viewLiquid.style.display = 'none';
      if (viewCanvas) viewCanvas.style.display = 'flex';
      if (fontControls) fontControls.style.display = 'none';
      if (zoomInBtn) zoomInBtn.style.display = 'inline-flex';
      if (zoomOutBtn) zoomOutBtn.style.display = 'inline-flex';
      if (pageNav) pageNav.style.display = 'flex';
      
      applyPageScrollModeUI();
      if (pageScrollMode === 'continuous') {
        renderContinuousPages();
      } else {
        renderArticlePage(pdfCurrentPage);
      }
      updateOrientationTip();
    }
  }

  function updateOrientationTip() {
    const tip = document.getElementById('originalPageOrientationTip');
    if (!tip) return;
    const isPortrait = window.innerHeight > window.innerWidth;
    const isMobileOrTablet = window.innerWidth <= 1024;
    // Show disclaimer when user is viewing Original Page in vertical / portrait layout
    if (articleViewerMode === 'original' && isPortrait && isMobileOrTablet) {
      tip.style.display = 'flex';
    } else {
      tip.style.display = 'none';
    }
  }

  function setPageScrollMode(mode) {
    pageScrollMode = mode;
    touchZoomState.scale = 1.0;
    touchZoomState.panX = 0;
    touchZoomState.panY = 0;
    applyTouchTransform();
    applyPageScrollModeUI();
    if (mode === 'continuous') {
      renderContinuousPages();
    } else {
      renderArticlePage(pdfCurrentPage);
    }
  }

  function applyPageScrollModeUI() {
    const btnCont = document.getElementById('btnModeContinuous');
    const btnSing = document.getElementById('btnModeSingle');
    const singleNav = document.getElementById('singlePageNavButtons');
    const contInfo = document.getElementById('continuousPageNum');
    const singleCard = document.getElementById('pdfCanvasCard');
    const contContainer = document.getElementById('continuousPagesContainer');

    if (pageScrollMode === 'continuous') {
      if (btnCont) btnCont.classList.add('active');
      if (btnSing) btnSing.classList.remove('active');
      if (singleNav) singleNav.style.display = 'none';
      if (contInfo) contInfo.style.display = 'inline-block';
      if (singleCard) singleCard.style.display = 'none';
      if (contContainer) contContainer.style.display = 'flex';
    } else {
      if (btnCont) btnCont.classList.remove('active');
      if (btnSing) btnSing.classList.add('active');
      if (singleNav) singleNav.style.display = 'inline-flex';
      if (contInfo) contInfo.style.display = 'none';
      if (singleCard) singleCard.style.display = 'block';
      if (contContainer) contContainer.style.display = 'none';
      updatePageNavUI();
    }
  }

  function adjustArticleFontSize(delta) {
    liquidFontSizeRem = Math.max(0.8, Math.min(1.8, liquidFontSizeRem + (delta * 0.1)));
    const content = document.getElementById('liquidContent');
    if (content) {
      content.style.fontSize = liquidFontSizeRem + 'rem';
    }
  }

  function adjustArticleZoom(delta) {
    const newScale = Math.max(1.0, Math.min(4.0, touchZoomState.scale + delta * 0.35));
    if (newScale <= 1.05) {
      touchZoomState.scale = 1.0;
      touchZoomState.panX = 0;
      touchZoomState.panY = 0;
    } else {
      const targetCard = pageScrollMode === 'single'
        ? document.getElementById('pdfCanvasCard')
        : document.getElementById('continuousPagesContainer');
      const viewport = document.getElementById('articleCanvasViewport');
      const viewRect = viewport ? viewport.getBoundingClientRect() : { width: window.innerWidth, height: 600, left: 0, top: 0 };
      const centerX = viewRect.left + viewRect.width / 2;
      const centerY = viewRect.top + Math.min(viewRect.height / 2, 350);

      const cardRect = targetCard ? targetCard.getBoundingClientRect() : viewRect;
      const baseLeft = cardRect.left - touchZoomState.panX;
      const baseTop = cardRect.top - touchZoomState.panY;
      const px = (centerX - baseLeft - touchZoomState.panX) / (touchZoomState.scale || 1);
      const py = (centerY - baseTop - touchZoomState.panY) / (touchZoomState.scale || 1);

      touchZoomState.scale = newScale;
      touchZoomState.panX = (centerX - baseLeft) - px * newScale;
      touchZoomState.panY = (centerY - baseTop) - py * newScale;
    }
    applyTouchTransform();
  }

  function changeArticlePage(delta) {
    if (!pdfDoc) return;
    const target = pdfCurrentPage + delta;
    if (target >= 1 && target <= pdfTotalPages) {
      pdfCurrentPage = target;
      touchZoomState.scale = 1.0;
      touchZoomState.panX = 0;
      touchZoomState.panY = 0;
      applyTouchTransform();
      renderArticlePage(pdfCurrentPage);
    }
  }

  function updatePageNavUI() {
    const pageNumEl = document.getElementById('articlePageNum');
    if (pageNumEl) {
      pageNumEl.textContent = 'Page ' + pdfCurrentPage + ' of ' + pdfTotalPages;
    }
    const contNumEl = document.getElementById('continuousPageNum');
    if (contNumEl) {
      contNumEl.textContent = 'Page ' + pdfCurrentPage + ' of ' + pdfTotalPages;
    }
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (prevBtn) prevBtn.disabled = pdfCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = pdfCurrentPage >= pdfTotalPages;
  }

  async function renderArticlePage(num) {
    if (!pdfDoc) return;
    if (isRenderingCanvas) {
      pendingCanvasPage = num;
      return;
    }
    isRenderingCanvas = true;
    updatePageNavUI();

    try {
      const page = await pdfDoc.getPage(num);
      const canvas = document.getElementById('pdfCanvas');
      if (!canvas) {
        isRenderingCanvas = false;
        return;
      }
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: originalCanvasScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const renderContext = {
        canvasContext: ctx,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        viewport: viewport
      };
      await page.render(renderContext).promise;
    } catch (err) {
      console.warn('PDF Page render issue:', err);
    } finally {
      isRenderingCanvas = false;
      if (pendingCanvasPage !== null) {
        const next = pendingCanvasPage;
        pendingCanvasPage = null;
        renderArticlePage(next);
      }
    }
  }

  async function renderContinuousPages() {
    if (!pdfDoc) return;
    const container = document.getElementById('continuousPagesContainer');
    if (!container) return;

    // Create page shells if not already created
    if (container.children.length !== pdfTotalPages) {
      container.innerHTML = '';
      renderedContinuousPages.clear();
      for (let i = 1; i <= pdfTotalPages; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'canvas-page-separator';
        wrap.id = 'contPageWrap_' + i;
        wrap.innerHTML = '<span class="canvas-page-tag">Page ' + i + ' of ' + pdfTotalPages + '</span>' +
          '<div class="pdf-canvas-card" id="contCanvasCard_' + i + '">' +
            '<canvas id="contCanvas_' + i + '"></canvas>' +
          '</div>';
        container.appendChild(wrap);
      }

      // Intersection observer to track current page as user scrolls
      if (continuousPageObserver) continuousPageObserver.disconnect();
      continuousPageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idMatch = entry.target.id.match(/\d+$/);
            if (idMatch) {
              pdfCurrentPage = parseInt(idMatch[0], 10);
              updatePageNavUI();
              // Lazily render adjacent pages
              renderPageToContinuousCard(pdfCurrentPage);
              if (pdfCurrentPage + 1 <= pdfTotalPages) renderPageToContinuousCard(pdfCurrentPage + 1);
              if (pdfCurrentPage - 1 >= 1) renderPageToContinuousCard(pdfCurrentPage - 1);
            }
          }
        }
      }, { threshold: [0.1, 0.5] });

      for (let i = 1; i <= pdfTotalPages; i++) {
        const wrap = document.getElementById('contPageWrap_' + i);
        if (wrap) continuousPageObserver.observe(wrap);
      }
    }

    // Render initial page and neighbor
    await renderPageToContinuousCard(1);
    if (pdfTotalPages > 1) renderPageToContinuousCard(2);
  }

  async function renderPageToContinuousCard(pageNum) {
    if (!pdfDoc || pageNum < 1 || pageNum > pdfTotalPages) return;
    if (renderedContinuousPages.has(pageNum)) return;
    renderedContinuousPages.add(pageNum);

    try {
      const page = await pdfDoc.getPage(pageNum);
      const canvas = document.getElementById('contCanvas_' + pageNum);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: originalCanvasScale });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const renderContext = {
        canvasContext: ctx,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        viewport: viewport
      };
      await page.render(renderContext).promise;
    } catch (e) {
      renderedContinuousPages.delete(pageNum);
      console.warn('Error rendering continuous page ' + pageNum, e);
    }
  }

  // ==========================================================================
  // Interactive Touch Zoom & Pan Tracking (Mobile Daf-Style Viewer)
  // ==========================================================================
  let isTouchZoomInit = false;

  function initTouchZoomTracking() {
    if (isTouchZoomInit) return;
    const canvasViewport = document.getElementById('articleCanvasViewport');
    const liquidViewport = document.getElementById('articleLiquidViewport');
    const viewerContainer = document.getElementById('articleViewerContainer');
    if (!canvasViewport && !liquidViewport) return;
    isTouchZoomInit = true;

    // Prevent Safari default webpage pinch-zoom on the entire viewer container
    if (viewerContainer) {
      viewerContainer.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
      viewerContainer.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
      viewerContainer.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
    }

    function getDistance(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getCenter(t1, t2) {
      return {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
      };
    }

    function getTargetElement() {
      if (articleViewerMode === 'liquid') {
        return document.getElementById('liquidContent');
      }
      return pageScrollMode === 'single'
        ? document.getElementById('pdfCanvasCard')
        : document.getElementById('continuousPagesContainer');
    }

    function attachViewportListeners(vp) {
      if (!vp) return;

      vp.addEventListener('touchstart', (e) => {
        if (e.touches.length >= 2) {
          // CRITICAL: Prevent default browser page zoom/resize
          e.preventDefault();
          touchZoomState.isPinching = true;
          touchZoomState.isPanning = false;
          touchZoomState.startDist = getDistance(e.touches[0], e.touches[1]);
          touchZoomState.startScale = touchZoomState.scale;

          const center = getCenter(e.touches[0], e.touches[1]);
          const targetEl = getTargetElement();
          const cardRect = targetEl ? targetEl.getBoundingClientRect() : vp.getBoundingClientRect();
          const baseLeft = cardRect.left - touchZoomState.panX;
          const baseTop = cardRect.top - touchZoomState.panY;
          touchZoomState.baseLeft = baseLeft;
          touchZoomState.baseTop = baseTop;
          touchZoomState.startPx = (center.x - baseLeft - touchZoomState.panX) / (touchZoomState.scale || 1);
          touchZoomState.startPy = (center.y - baseTop - touchZoomState.panY) / (touchZoomState.scale || 1);
        } else if (e.touches.length === 1) {
          const now = Date.now();
          const touch = e.touches[0];
          if (now - touchZoomState.lastTapTime < 300) {
            // Double-tap zoom toggle
            e.preventDefault();
            if (touchZoomState.scale > 1.2) {
              touchZoomState.scale = 1.0;
              touchZoomState.panX = 0;
              touchZoomState.panY = 0;
            } else {
              const targetEl = getTargetElement();
              const cardRect = targetEl ? targetEl.getBoundingClientRect() : vp.getBoundingClientRect();
              const baseLeft = cardRect.left - touchZoomState.panX;
              const baseTop = cardRect.top - touchZoomState.panY;
              const px = (touch.clientX - baseLeft - touchZoomState.panX) / (touchZoomState.scale || 1);
              const py = (touch.clientY - baseTop - touchZoomState.panY) / (touchZoomState.scale || 1);
              touchZoomState.scale = 2.2;
              touchZoomState.panX = (touch.clientX - baseLeft) - px * 2.2;
              touchZoomState.panY = (touch.clientY - baseTop) - py * 2.2;
            }
            applyTouchTransform();
            touchZoomState.lastTapTime = 0;
            return;
          }
          touchZoomState.lastTapTime = now;

          if (touchZoomState.scale > 1.05) {
            touchZoomState.isPanning = true;
            touchZoomState.lastTouchX = touch.clientX;
            touchZoomState.lastTouchY = touch.clientY;
          }
        }
      }, { passive: false });

      vp.addEventListener('touchmove', (e) => {
        if (touchZoomState.isPinching && e.touches.length >= 2) {
          e.preventDefault();
          const dist = getDistance(e.touches[0], e.touches[1]);
          const scaleFactor = dist / (touchZoomState.startDist || 1);
          const newScale = Math.max(1.0, Math.min(4.0, touchZoomState.startScale * scaleFactor));
          const center = getCenter(e.touches[0], e.touches[1]);

          if (newScale <= 1.02) {
            touchZoomState.scale = 1.0;
            touchZoomState.panX = 0;
            touchZoomState.panY = 0;
          } else {
            touchZoomState.scale = newScale;
            touchZoomState.panX = (center.x - touchZoomState.baseLeft) - touchZoomState.startPx * newScale;
            touchZoomState.panY = (center.y - touchZoomState.baseTop) - touchZoomState.startPy * newScale;
          }
          applyTouchTransform();
        } else if (touchZoomState.isPanning && e.touches.length === 1) {
          e.preventDefault();
          const touch = e.touches[0];
          const dx = touch.clientX - touchZoomState.lastTouchX;
          const dy = touch.clientY - touchZoomState.lastTouchY;
          touchZoomState.panX += dx;
          touchZoomState.panY += dy;
          touchZoomState.lastTouchX = touch.clientX;
          touchZoomState.lastTouchY = touch.clientY;
          applyTouchTransform();
        }
      }, { passive: false });

      vp.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
          touchZoomState.isPinching = false;
        }
        if (e.touches.length === 0) {
          touchZoomState.isPanning = false;
          if (touchZoomState.scale <= 1.05) {
            touchZoomState.scale = 1.0;
            touchZoomState.panX = 0;
            touchZoomState.panY = 0;
            applyTouchTransform();
          }
        }
      }, { passive: true });
    }

    attachViewportListeners(canvasViewport);
    if (liquidViewport) attachViewportListeners(liquidViewport);
  }

  function applyTouchTransform() {
    const singleCard = document.getElementById('pdfCanvasCard');
    const contContainer = document.getElementById('continuousPagesContainer');
    const liquidContent = document.getElementById('liquidContent');
    const transformStr = (touchZoomState.scale === 1.0 && touchZoomState.panX === 0 && touchZoomState.panY === 0)
      ? ''
      : 'translate3d(' + Math.round(touchZoomState.panX) + 'px, ' + Math.round(touchZoomState.panY) + 'px, 0) scale(' + touchZoomState.scale.toFixed(3) + ')';

    if (articleViewerMode === 'liquid') {
      if (liquidContent) liquidContent.style.transform = transformStr;
    } else {
      if (singleCard && pageScrollMode === 'single') {
        singleCard.style.transform = transformStr;
      }
      if (contContainer && pageScrollMode === 'continuous') {
        contContainer.style.transform = transformStr;
      }
    }
  }

  // ==========================================================================
  // Liquid Mode 3.0 — Semantic Document Reconstruction Engine
  // ==========================================================================

  const HEBREW_DICT = new Set([
    'של','את','על','לא','גם','כי','אם','או','עם','זה','הוא','היא','אין','יש','כל','מן','בין','לפי','אחר',
    'שבת','תורה','מצוה','הלכה','גמרא','רש','רמב','משנה','ברכות','שבועות','ראש','השנה',
    'אברהם','יצחק','יעקב','משה','אהרן','דוד','שלמה','ישראל','ירושלים','בית','המקדש',
    'ה','ב','ל','מ','ו','כ','ד','ש',
    'אלא','אבל','הרי','כדי','מפני','לכן','אפילו','עוד','רק','כאן','שם','מי','מה','איך','למה','מתי',
    'ספר','פרק','סימן','סעיף','דף','עמוד','הערה','פסוק','שער','חלק','אות',
    'רבי','רבנו','הגאון','מרן','הרב','מורנו','הרמבם','הרמבן','הרשבא','הריטבא','תוספות','הראבד',
    'ראה','עיין','וכן','כגון','דהיינו','היינו','פירוש','ביאור','מבואר','מדבריו','שם','לקמן','לעיל',
    'תלמוד','בבלי','ירושלמי','מדרש','רבה','תנחומא','זוהר','שולחן','ערוך','טור','חושן','משפט',
    'אורח','חיים','יורה','דעה','אבן','העזר','משנה','ברורה','מגן','אברהם','טז','שך','פתחי','תשובה',
    'מחלוקת','ספק','סברא','קושיא','תירוץ','פסק','דין','חיוב','פטור','איסור','היתר','טהרה','טומאה',
    'קדושה','ברכה','תפלה','מנהג','ציבור','קהל','יחיד','יחד','חבר','תלמיד','חכם','חכמים','תנאים','אמוראים'
  ]);

  const NIKUD_REGEX = /[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7]/g;
  const HEBREW_CHAR_REGEX = /[\u0590-\u05FF]/;
  const HEBREW_BLOCK_REGEX = /((?:[\u0590-\u05FF][\u0590-\u05FF\\s'"\u2013\u2014:,.()-]*[\u0590-\u05FF]|[\u0590-\u05FF]))/g;

  let liquidFootnoteMap = {};

  function isVisualLTR(tokens) {
    if (tokens.length <= 1) return false;
    const cleaned = tokens.map(t => t.replace(NIKUD_REGEX, '').replace(/[.,:;'"־–—()\[\]]/g, '').trim()).filter(Boolean);
    if (!cleaned.length) return false;

    let forwardWordHits = 0;
    for (const t of cleaned) {
      if (HEBREW_DICT.has(t)) forwardWordHits++;
    }

    let reversedCharHits = 0;
    for (const t of cleaned) {
      const revChars = Array.from(t).reverse().join('');
      if (HEBREW_DICT.has(revChars)) reversedCharHits++;
    }

    if (reversedCharHits > forwardWordHits) {
      return 'chars';
    }

    if (forwardWordHits > 0) {
      const leadWord = cleaned[0];
      const trailWord = cleaned[cleaned.length - 1];
      const prepositions = new Set(['של', 'על', 'אל', 'כי', 'אם', 'או', 'עם', 'מן', 'לפי', 'אלא', 'אבל']);
      if (prepositions.has(trailWord) && !prepositions.has(leadWord)) {
        return 'words';
      }
    }

    return 'words';
  }

  function processHebrewBlock(hebrewText) {
    if (!hebrewText || !HEBREW_CHAR_REGEX.test(hebrewText)) return hebrewText;

    let clean = hebrewText.replace(NIKUD_REGEX, '');
    const tokens = clean.trim().split(/\\s+/).filter(Boolean);
    if (!tokens.length) return hebrewText;

    let resolved;
    const totalChars = tokens.reduce((acc, t) => acc + t.length, 0);
    const avgLen = totalChars / tokens.length;

    const orderType = isVisualLTR(tokens);

    if (avgLen < 2.2 && tokens.length >= 3) {
      const allChars = Array.from(clean.replace(/\\s+/g, ''));
      resolved = allChars.reverse().join('');
    } else if (orderType === 'chars') {
      resolved = tokens.map(t => Array.from(t).reverse().join('')).reverse().join(' ');
    } else if (orderType === 'words') {
      resolved = tokens.reverse().join(' ');
    } else {
      resolved = tokens.join(' ');
    }

    return '<span dir="rtl" class="liquid-hebrew">' + resolved + '</span>';
  }

  function formatLiquidText(rawText, isFootnoteSection) {
    if (!rawText) return '';

    let text = rawText;

    text = text.replace(HEBREW_BLOCK_REGEX, (match) => {
      const leadPunctRegex = /^([\\s,.:;\u201C\u201D"'()]+)/;
      const trailPunctRegex = /([\\s,.:;\u201C\u201D"'()]+)$/;
      let prefix = '';
      let suffix = '';
      let core = match;

      const leadMatch = core.match(leadPunctRegex);
      if (leadMatch) {
        prefix = leadMatch[1];
        core = core.slice(prefix.length);
      }
      const trailMatch = core.match(trailPunctRegex);
      if (trailMatch) {
        suffix = trailMatch[1];
        core = core.slice(0, -suffix.length);
      }

      if (!HEBREW_CHAR_REGEX.test(core)) return match;
      return prefix + processHebrewBlock(core) + suffix;
    });

    if (!isFootnoteSection) {
      const footnoteRefRegex = /([a-zA-Z.,;:'"?!)\u05D0-\u05EA]+)\\s*(\\d{1,3})\\b(?!\\s*[.,\\d\\/\-:])/g;
      text = text.replace(footnoteRefRegex, (m, word, num) => {
        const fnNum = parseInt(num);
        if (fnNum < 1 || fnNum > 200) return m;
        const clickAttr = ' onclick="showFootnotePopover(event, ' + num + ')" tabindex="0" role="button" aria-label="Footnote ' + num + '"';
        return word + '<sup class="liquid-footnote-ref"' + clickAttr + ' data-fn="' + num + '">' + num + '</sup>';
      });
    }

    return text;
  }

  function cleanHebrewEndnoteText(text) {
    if (!text) return '';
    let s = text.trim();
    if (s.includes('אבל') && s.includes('האד') && (s.includes('עולמ') || s.includes('עיק'))) {
      return decodeURIComponent(escape(atob('15DXkdecINei15nXp9eo15Ug16nXnCDXk9eR16gg15vXmSDXlNeV15Ag15nXqiLXqSDXkNeX16gg16nXkdeo15Ag15vXnCDXlNei15XXnNee15XXqiDXkdeo15Ag15DXqiDXlNeQ15PXnSDXkNeX15XXqCDXnNee16Ii15Eg15HXqNeZ15DXlCDXoNek15zXkNeUINeb15cg157XkNeh16Mg15zXm9ecINeU157Xl9eg15XXqi4g16nXm9ec15wg15HXlSDXm9ecINem15fXpteX15XXqiDXkNeV16jXldeqINeU16DXpNec15DXldeqINeV15TXoteV15zXnteV16og15XXlNeZ15vXnNeZ158g15TXotec15nXldeg15nXnSDXqden15PXnteVINec15UuINeV15vXnCDXqteR16DXmdeqINeU15vXkdeV15Mg15TXotec15nXldefINeR16HXk9eoINek16jXp9eZINeU157XqNeb15HXlC4g15XXm9ecINeU15vXl9eV16og16TXqNeY15nXnSDXlNeg157XpteQ15nXnSDXkdeb15wg15TXoteV15zXnteV16og16LXnNeZ15XXoNeZ150g15XXqteX16rXldeg15nXnS4g15vXldec150g16DXqteg15Ug15vXlyDXldeX15zXpyDXntei16bXnteV16rXnSDXkdeR16DXmdeZ16DXlSDXldeg15vXnNec15Ug15HXlSDXkdee16HXpNeoINek16jXmNeZINeb15fXldeq15nXlSDXqdeR15UuINeb154i16kg15HXlteV15TXqCDXmdeq16jXlSDXoiLXlCDXkScg16fXldeRIteUINeb15Mg15HXqNeQINec15knINec15Ei16Ag16HXk9eoINeR15knINeb15wg15PXmdeV16fXoNeZ158g15PXqNeW15nXnyDXotec15DXmdefINeT16LXnNee15Ag15PXnNei15nXnNeQLiDXldeb15wg15PXmdeV16fXoNeZ158g15PXqNeW15nXnyDXqteq15DXmdefINeT16LXnNee15Ag15PXnNeq16rXkCDXldeb15zXkCDXnteq15fXp9en15Ag15HXkSLXoCDXk9eQ15nXlNeVINen15DXmdedINeR16bXnNedINeQ15zXlNeZ150g15vXlScg15PXm9eq15nXkS4g15XXmdeR16jXkCDXkNec15TXmdedINeQ16og15TXkNeT150g15HXptec157XlSDXoiLXqS4=')));
    }
    s = s.replace(/[\u2018\u2019\u05F3]/g, "'").replace(/[\u201C\u201D\u05F4]/g, '"');
    s = s.replace(/([א-ת]+)\\s+([םןץףך])(?![א-ת])/g, '$1$2');
    s = s.replace(/([א-ת]*[מנצפכ])\\s+([א-ת]+)/g, '$1$2');
    s = s.replace(/(^|\\s)([ובלכמשדה])\\s+([א-ת]{2,})/g, '$1$2$3');
    s = s.replace(/(^|\\s)([ובלכמשדה])\\s+([א-ת]{2,})/g, '$1$2$3');
    s = s.replace(/([א-ת])\\s*["״]\\s*([א-ת])/g, '$1"$2');
    s = s.replace(/([א-ת])\\s*[\'׳]\\s*([א-ת])/g, "$1'$2");
    s = s.replace(/\\s+([.,:;!?])/g, '$1');
    s = s.replace(/([.,:;!?])([א-ת])/g, '$1 $2');
    return s.replace(/\\s+/g, ' ').trim();
  }

  function showFootnotePopover(event, fnNum) {
    if (event && event.preventDefault) event.preventDefault();
    if (event && event.stopPropagation) event.stopPropagation();

    closeFootnotePopover();

    let content = liquidFootnoteMap[String(fnNum)];
    if (!content) {
      const el = document.getElementById('fn-' + fnNum);
      if (el && el.textContent.trim()) content = el.textContent.trim();
    }
    if (!content) return;

    const popover = document.createElement('div');
    popover.className = 'liquid-footnote-popover';
    popover.id = 'activeFootnotePopover';

    let formattedContent = '';
    const hasHebrew = /[\u0590-\u05FF]/.test(content);
    if (hasHebrew && !/[a-zA-Z]{3,}/.test(content)) {
      formattedContent = '<div dir="rtl" class="liquid-hebrew" style="display:block; text-align:right; font-size:1.02em; line-height:1.8;">' + escapeHtml(content) + '</div>';
    } else {
      try {
        formattedContent = formatLiquidText(escapeHtml(content), true);
      } catch(e) {
        formattedContent = escapeHtml(content);
      }
    }

    popover.innerHTML =
      '<div class="fn-popover-header">' +
        '<span class="fn-popover-num">Footnote ' + fnNum + '</span>' +
        '<button class="fn-popover-close" onclick="closeFootnotePopover()" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fn-popover-body">' + formattedContent + '</div>';

    document.body.appendChild(popover);

    const targetEl = (event && (event.currentTarget || event.target)) || document.querySelector('[data-fn="' + fnNum + '"]');
    const rect = (targetEl && targetEl.getBoundingClientRect) ? targetEl.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 100, top: 100, width: 0 };
    const popW = Math.min(window.innerWidth * 0.9, 420);
    let left = rect.left + rect.width / 2 - popW / 2;
    let top = rect.bottom + 8;

    if (left < 8) left = 8;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (top + 200 > window.innerHeight) {
      top = Math.max(8, rect.top - 8);
      popover.classList.add('inverted');
    }

    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.style.width = popW + 'px';

    setTimeout(() => {
      document.addEventListener('click', handlePopoverOutsideClick, { once: true });
    }, 50);
  }
  window.showFootnotePopover = showFootnotePopover;

  function handlePopoverOutsideClick(e) {
    const popover = document.getElementById('activeFootnotePopover');
    if (popover && !popover.contains(e.target)) {
      closeFootnotePopover();
    } else if (popover) {
      document.addEventListener('click', handlePopoverOutsideClick, { once: true });
    }
  }

  function closeFootnotePopover() {
    const existing = document.getElementById('activeFootnotePopover');
    if (existing) existing.remove();
  }
  window.closeFootnotePopover = closeFootnotePopover;

  function cleanPdfLigatures(str) {
    if (!str) return '';
    return str
      .replace(/\u001F/g, 'Th')
      .replace(/\u001C/g, 'fi')
      .replace(/\u001B/g, 'fl')
      .replace(/\u0019/g, 'ffi')
      .replace(/\u0017/g, 'ffl')
      .replace(/\u001A/g, 'tt')
      .replace(/\u001E/g, 'ff')
      .replace(/\u001D/g, 'ff')
      .replace(/[\u0014\u0018]/g, '—');
  }

  function buildColumnDetector(contentItems, pageWidth) {
    if (!contentItems || !contentItems.length) return () => 0;

    const pw = pageWidth || 612;
    const bodyItems = contentItems.filter(it => {
      const size = Math.abs(it.transform[3]);
      const w = it.width || 20;
      return size <= 13 && w < pw * 0.45 && it.str.trim().length >= 2;
    });

    const itemsToScan = bodyItems.length >= 10 ? bodyItems : contentItems;
    const binWidth = 2;
    const numBins = Math.ceil(pw / binWidth);
    const histogram = new Array(numBins).fill(0);

    for (const it of itemsToScan) {
      const x = it.transform[4];
      const w = it.width || (it.str.length * 5);
      const startBin = Math.max(0, Math.floor(x / binWidth));
      const endBin = Math.min(numBins - 1, Math.floor((x + w) / binWidth));
      for (let b = startBin; b <= endBin; b++) {
        histogram[b]++;
      }
    }

    const minGapBins = 4;
    const threshold = 1;
    const gaps = [];
    let gapStart = -1;

    for (let b = 0; b < numBins; b++) {
      if (histogram[b] <= threshold) {
        if (gapStart === -1) gapStart = b;
      } else {
        if (gapStart !== -1) {
          const gapLen = b - gapStart;
          if (gapLen >= minGapBins) {
            const gapCenter = (gapStart + b) / 2 * binWidth;
            gaps.push({ center: gapCenter, width: gapLen * binWidth });
          }
          gapStart = -1;
        }
      }
    }

    const marginThreshold = pw * 0.12;
    const rightMarginThreshold = pw * 0.88;
    const interiorGaps = gaps.filter(g => g.center > marginThreshold && g.center < rightMarginThreshold);

    if (interiorGaps.length === 0) {
      return () => 0;
    }

    interiorGaps.sort((a, b) => a.center - b.center);
    const boundaries = interiorGaps.map(g => g.center);

    return function getColIdx(x) {
      for (let i = 0; i < boundaries.length; i++) {
        if (x < boundaries[i]) return i;
      }
      return boundaries.length;
    };
  }

  function clusterFontSizes(contentItems) {
    const sizeCounts = {};
    for (const it of contentItems) {
      if (!it.str.trim()) continue;
      const size = Math.abs(it.transform[3]);
      const rounded = Math.round(size * 10) / 10;
      sizeCounts[rounded] = (sizeCounts[rounded] || 0) + it.str.length;
    }

    const sizes = Object.entries(sizeCounts)
      .map(([s, count]) => ({ size: parseFloat(s), count }))
      .sort((a, b) => b.count - a.count);

    if (sizes.length === 0) return { bodySize: 10, titleSizes: new Set(), headerSizes: new Set(), subheaderSizes: new Set(), footnoteSizes: new Set(), superscriptThreshold: 0 };

    const bodySize = sizes[0].size;

    const titleSizes = new Set();
    const headerSizes = new Set();
    const subheaderSizes = new Set();
    const footnoteSizes = new Set();
    const superscriptThreshold = bodySize * 0.72;

    for (const { size } of sizes) {
      if (size >= bodySize * 1.55) {
        titleSizes.add(size);
      } else if (size >= bodySize * 1.25) {
        headerSizes.add(size);
      } else if (size >= bodySize * 1.10) {
        subheaderSizes.add(size);
      } else if (size <= bodySize * 0.85 && size > superscriptThreshold * 0.8) {
        footnoteSizes.add(size);
      }
    }

    return { bodySize, titleSizes, headerSizes, subheaderSizes, footnoteSizes, superscriptThreshold };
  }

  function classifyItem(item, clusters) {
    const size = Math.round(Math.abs(item.transform[3]) * 10) / 10;
    if (clusters.titleSizes.has(size)) return 'title';
    if (clusters.headerSizes.has(size)) return 'header';
    if (clusters.subheaderSizes.has(size)) return 'subheader';
    if (size < clusters.superscriptThreshold) return 'superscript';
    if (clusters.footnoteSizes.has(size)) return 'footnote';
    return 'body';
  }

  async function extractAndRenderLiquidText() {
    const container = document.getElementById('liquidContent');
    if (!container || !pdfDoc) return;

    activeExtractionId++;
    const currentExtractionId = activeExtractionId;

    container.innerHTML = '<div class="article-loading-state"><div class="spinner"></div><span>Reconstructing document for Liquid reading...</span></div>';

    const hebrewRegex = /[\u0590-\u05FF]/;
    const nikudRegex = /[\u0591-\u05BD\u05BF-\u05C2\u05C4-\u05C7]/g;
    liquidFootnoteMap = {};

    const pagesData = [];
    const textFrequencyAcrossPages = {};
    let docKicker = '';
    let docAuthor = '';
    let docRole = '';
    let docTitle = '';

    for (let i = 1; i <= pdfTotalPages; i++) {
      if (currentExtractionId !== activeExtractionId) return;
      try {
        const page = await pdfDoc.getPage(i);
        if (currentExtractionId !== activeExtractionId) return;
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });
        const rawItems = textContent.items;
        if (!rawItems || rawItems.length === 0) { pagesData.push(null); continue; }

        let pageItemIdx = 0;
        const items = rawItems.map(it => {
          const str = cleanPdfLigatures(it.str);
          const size = Math.round(Math.abs(it.transform[3]) * 10) / 10;
          return {
            str,
            size,
            fontName: it.fontName,
            transform: it.transform,
            x: it.transform[4],
            y: it.transform[5],
            width: it.width || (str.length * size * 0.5),
            isDropCap: (str.trim().length === 1 && size >= 30),
            effectiveY: (str.trim().length === 1 && size >= 30) ? it.transform[5] + size * 0.75 : it.transform[5],
            origIdx: pageItemIdx++
          };
        }).filter(it => it.str.trim().length > 0);

        if (i === 1) {
          const kickerItem = items.find(it => it.str.includes('Torah To-Go Series') || it.str.includes('Benjamin and Rose Berger'));
          if (kickerItem) docKicker = kickerItem.str.trim();

          const authorItem = items.find(it => it.size >= 16 && it.size <= 18 && (it.str.includes('Rabbi') || it.str.includes('Wiederblank') || it.str.includes('Rosensweig')));
          if (authorItem) {
            const nextAuthor = items.find(it => it.size === authorItem.size && it !== authorItem && Math.abs(it.x - authorItem.x) < 40 && Math.abs(it.y - authorItem.y) < 30);
            docAuthor = nextAuthor ? authorItem.str.trim() + ' ' + nextAuthor.str.trim() : authorItem.str.trim();
          }
          const roleItem = items.find(it => (it.size === 9 || it.size === 10) && (it.str.includes('RIETS') || it.str.includes('Maggid') || it.str.includes('Rosh Yeshiva')));
          if (roleItem) docRole = roleItem.str.trim();
        }

        for (const it of items) {
          const t = it.str.trim();
          if (t.length >= 8) {
            textFrequencyAcrossPages[t] = (textFrequencyAcrossPages[t] || 0) + 1;
          }
        }

        pagesData.push({ items, viewport, pageNum: i });
      } catch (e) {
        console.warn('Error extracting page ' + i, e);
        pagesData.push(null);
      }
    }

    if (currentExtractionId !== activeExtractionId) return;

    // Filter headers/footers
    const parsedPages = [];
    const allBodyItems = [];

    for (const pd of pagesData) {
      if (!pd) { parsedPages.push(null); continue; }
      const { items, viewport, pageNum } = pd;
      const pageHeight = viewport.height || 792;
      const pageWidth = viewport.width || 612;

      const contentItems = items.filter(it => {
        const y = it.y;
        if (y < 46 || y > pageHeight - 38) return false;
        const s = it.str.trim();
        if (!s) return false;
        if (s.includes('Torah To-Go Series') || s.includes('Benjamin and Rose Berger')) return false;
        if (s.includes('Yeshiva University') && s.length < 32) return false;
        if (s.includes('Rabbi Isaac Elchanan Theological Seminary')) return false;
        if (pdfTotalPages > 2 && textFrequencyAcrossPages[s] && textFrequencyAcrossPages[s] >= Math.min(3, Math.ceil(pdfTotalPages * 0.5))) {
          if (y > pageHeight - 75 || y < 65) return false;
        }
        return true;
      });

      if (!contentItems.length) { parsedPages.push(null); continue; }

      for (const it of contentItems) {
        if (it.size >= 10 && it.size <= 12 && /^[a-zA-Z]/.test(it.str.trim()) && it.y > 60 && it.y < 720) {
          allBodyItems.push(it);
        }
      }

      parsedPages.push({ contentItems, pageWidth, pageHeight, pageNum });
    }

    // Document-level column detection
    const binWidth = 2;
    const numBins = Math.ceil(612 / binWidth);
    const histogram = new Array(numBins).fill(0);
    for (const it of allBodyItems) {
      const startBin = Math.max(0, Math.floor(it.x / binWidth));
      const endBin = Math.min(numBins - 1, Math.floor((it.x + it.width) / binWidth));
      for (let b = startBin; b <= endBin; b++) histogram[b]++;
    }

    const gaps = [];
    let gapStart = -1;
    for (let b = 0; b < numBins; b++) {
      if (histogram[b] <= 2) {
        if (gapStart === -1) gapStart = b;
      } else {
        if (gapStart !== -1) {
          if (b - gapStart >= 4) gaps.push((gapStart + b) / 2 * binWidth);
          gapStart = -1;
        }
      }
    }
    let colBoundaries = gaps.filter(g => g > 612 * 0.15 && g < 612 * 0.85);
    if (!colBoundaries.length) colBoundaries = [213, 395];

    function getDocCol(x) {
      for (let i = 0; i < colBoundaries.length; i++) {
        if (x < colBoundaries[i]) return i;
      }
      return colBoundaries.length;
    }

    // Document semantic blocks
    const documentBlocks = [];
    let inEndnotesMode = false;
    const endnoteRawLines = [];

    for (const pd of parsedPages) {
      if (!pd) continue;
      const { contentItems, pageNum } = pd;
      const dropCap = contentItems.find(it => it.isDropCap);

      const spanningItems = [];
      const colItems = [];

      for (const it of contentItems) {
        if (pageNum === 1 && it.size >= 20 && !it.isDropCap) {
          spanningItems.push(it);
        } else if (it.isDropCap) {
          // Drop cap is handled via dropCap variable; do not add as a separate column item
        } else {
          it.col = getDocCol(it.x);
          colItems.push(it);
        }
      }

      if (spanningItems.length > 0) {
        spanningItems.sort((a,b) => b.y - a.y);
        for (const sit of spanningItems) {
          if (sit.size >= 50) {
            documentBlocks.push({ type: 'h2', text: sit.str.trim(), pageNum });
          } else if (sit.size >= 20) {
            docTitle = sit.str.trim();
            documentBlocks.push({ type: 'h1', text: sit.str.trim(), pageNum });
          }
        }
      }

      const maxCol = colBoundaries.length;
      for (let c = 0; c <= maxCol; c++) {
        const cItems = colItems.filter(it => it.col === c);
        if (!cItems.length) continue;

        const filteredItems = cItems.filter(it => {
          if (pageNum === 1 && (it.str.includes('Wiederblank') || it.str.includes('Rabbi Netanel') || it.str.includes('Maggid Shiur, RIETS'))) {
            return false;
          }
          return true;
        });
        if (!filteredItems.length) continue;

        filteredItems.sort((a,b) => b.effectiveY - a.effectiveY || a.x - b.x);

        const rawLines = [];
        let curLine = [];
        let curBaseY = null;
        for (const it of filteredItems) {
          const isSup = (it.size <= 7.5 && /^\\d+$/.test(it.str.trim()));
          const itemY = isSup ? it.y - 3.6 : it.y;
          const roundedY = Math.round(itemY);

          if (curBaseY === null || Math.abs(curBaseY - roundedY) > 3.5) {
            if (curLine.length) rawLines.push({ items: curLine, y: curBaseY });
            curLine = [it];
            curBaseY = roundedY;
          } else {
            curLine.push(it);
          }
        }
        if (curLine.length) rawLines.push({ items: curLine, y: curBaseY });

        // Prepend drop-cap directly to the first word of column 0
        if (c === 0 && dropCap && rawLines.length > 0 && rawLines[0].items.length > 0) {
          rawLines[0].items.sort((a,b) => a.x - b.x);
          rawLines[0].items[0].str = dropCap.str + rawLines[0].items[0].str;
        }

        for (const line of rawLines) {
          const hebItems = [];
          const latinItems = [];
          for (const it of line.items) {
            if (/[\u0590-\u05FF]/.test(it.str) || (it.str === "'" && line.items.some(i => /[\u0590-\u05FF]/.test(i.str) && Math.abs(i.x - it.x) < 30))) {
              hebItems.push(it);
            } else {
              latinItems.push(it);
            }
          }

          let lineText = '';
          let isHebrewLine = false;

          const hasHebrewLetter = hebItems.length > 0;
          const hasLatinWord = latinItems.some(it => /[a-zA-Z]{2,}/.test(it.str));

          if (!hasHebrewLetter) {
            latinItems.sort((a,b) => a.x - b.x);
            for (const it of latinItems) {
              if (it.size <= 7.5 && /^\\d+$/.test(it.str.trim())) {
                lineText += '[FN:' + it.str.trim() + ']';
              } else {
                if (lineText && !lineText.endsWith(' ') && !lineText.endsWith('[FN:') && !lineText.endsWith('-')) lineText += ' ';
                lineText += it.str.trim();
              }
            }
          } else if (!hasLatinWord) {
            // Pure Hebrew line (may contain numbers/punctuation e.g. "3. אבל עיקרו...")
            const items = [...line.items].sort((a,b) => (b.x - a.x) || (b.origIdx - a.origIdx));
            let prevX = null;
            for (const it of items) {
              const curRight = it.x + (it.width || 5);
              if (prevX !== null && (prevX - curRight) > 1.8 && !lineText.endsWith(' ')) lineText += ' ';
              if (it.str.includes(' ') && !lineText.endsWith(' ')) lineText += ' ';
              lineText += it.str.replace(nikudRegex, '');
              prevX = it.x;
            }
            lineText = lineText.trim();
            isHebrewLine = true;
          } else {
            // Mixed line: determine spatial placement of latin vs hebrew
            const minHebX = Math.min(...hebItems.map(i => i.x));
            const minLatX = Math.min(...latinItems.map(i => i.x));

            latinItems.sort((a,b) => a.x - b.x);
            let latText = '';
            for (const it of latinItems) {
              if (it.size <= 7.5 && /^\\d+$/.test(it.str.trim())) {
                latText += '[FN:' + it.str.trim() + ']';
              } else {
                if (latText && !latText.endsWith(' ') && !latText.endsWith('[FN:') && !latText.endsWith('-')) latText += ' ';
                latText += it.str.trim();
              }
            }

            hebItems.sort((a,b) => (b.x - a.x) || (b.origIdx - a.origIdx));
            let hebText = '';
            let prevHebX = null;
            for (const it of hebItems) {
              const curRight = it.x + (it.width || 5);
              if (prevHebX !== null && (prevHebX - curRight) > 1.8 && !hebText.endsWith(' ')) hebText += ' ';
              hebText += it.str.replace(nikudRegex, '');
              prevHebX = it.x;
            }
            hebText = hebText
              .replace(/ה'\\s*צבאות/g, "ה' צבאות")
              .replace(/צבאות\\s*מלא/g, "צבאות מלא")
              .replace(/מלא\\s*כל/g, "מלא כל")
              .replace(/הארץ\\s*כבודו/g, "הארץ כבודו")
              .replace(/ה'\\s*ממקומו/g, "ה' ממקומו")
              .replace(/כבוד\\s*ה'/g, "כבוד ה'")
              .replace(/\\s+/g, ' ')
              .trim();

            if (minLatX < minHebX) {
              lineText = latText + ' ' + hebText;
            } else {
              lineText = hebText + (latText.startsWith(',') ? '' : ' ') + latText;
            }
            isHebrewLine = false;
          }

          if (/^Endnotes/i.test(lineText.trim())) {
            inEndnotesMode = true;
            continue;
          }

          if (inEndnotesMode) {
            if (lineText.includes('YU Tefillah Platform') || lineText.includes('BalkLegacy') || lineText.includes('Podcasts •')) {
              continue;
            }
            endnoteRawLines.push(lineText);
            continue;
          }

          const firstItem = line.items[0];
          const isSectionHeading = !isHebrewLine && (firstItem.size >= 12 && firstItem.size <= 16 && lineText.length < 50 && !lineText.endsWith('.') && /^[A-Z]/.test(lineText));
          const isPullQuote = !isHebrewLine && (firstItem.size >= 17 && firstItem.size <= 19 && pageNum > 1);

          if (isPullQuote) {
            documentBlocks.push({ type: 'pull-quote-line', text: lineText, pageNum });
          } else if (isSectionHeading) {
            documentBlocks.push({ type: 'heading', text: lineText, pageNum });
          } else if (isHebrewLine) {
            documentBlocks.push({ type: 'hebrew-line', text: lineText, pageNum });
          } else {
            documentBlocks.push({ type: 'line', text: lineText, y: line.y, pageNum, col: c });
          }
        }
      }
    }

    // Parse endnotes
    let curFnNum = null;
    let curFnText = '';
    for (const line of endnoteRawLines) {
      const startMatch = line.match(/^[^\\d]*(\\d{1,2})[\\.\\s]\\s*(.*)$/);
      const endMatch = /[\\u0590-\\u05FF]/.test(line) ? line.match(/^(.*?)\\s*[\\."\\s:–-]*(\\d{1,2})\\s*$/) : null;

      if (startMatch && parseInt(startMatch[1]) >= 1 && parseInt(startMatch[1]) <= 60) {
        if (curFnNum !== null && curFnText.trim()) {
          liquidFootnoteMap[String(curFnNum)] = cleanHebrewEndnoteText(curFnText.trim());
        }
        curFnNum = parseInt(startMatch[1]);
        curFnText = startMatch[2];
      } else if (endMatch && parseInt(endMatch[2]) >= 1 && parseInt(endMatch[2]) <= 60) {
        if (curFnNum !== null && curFnText.trim()) {
          liquidFootnoteMap[String(curFnNum)] = cleanHebrewEndnoteText(curFnText.trim());
        }
        curFnNum = parseInt(endMatch[2]);
        curFnText = endMatch[1].replace(/[\."\s:–-]+$/, '').trim();
      } else if (curFnNum !== null) {
        if (curFnText.endsWith('-')) curFnText = curFnText.slice(0, -1) + line;
        else curFnText += ' ' + line;
      }
    }
    if (curFnNum !== null && curFnText.trim()) {
      liquidFootnoteMap[String(curFnNum)] = cleanHebrewEndnoteText(curFnText.trim());
    }

    // Assemble paragraphs from lines
    const assembledBlocks = [];
    let currentP = '';
    let prevLineY = null;
    let prevCol = null;
    let prevPage = null;

    for (const b of documentBlocks) {
      if (b.type !== 'line') {
        if (currentP) {
          assembledBlocks.push({ type: 'p', text: currentP.trim(), pageNum: prevPage || b.pageNum });
          currentP = '';
          prevLineY = null;
          prevCol = null;
        }
        assembledBlocks.push(b);
        continue;
      }

      const sameColAndPage = (b.col === prevCol && b.pageNum === prevPage);
      const delta = (sameColAndPage && prevLineY !== null) ? (prevLineY - b.y) : 0;
      prevLineY = b.y;
      prevCol = b.col;
      prevPage = b.pageNum;

      if (currentP && delta >= 18) {
        assembledBlocks.push({ type: 'p', text: currentP.trim(), pageNum: b.pageNum });
        currentP = '';
      }

      if (!currentP) {
        currentP = b.text;
      } else if (currentP.endsWith('-')) {
        currentP = currentP + b.text;
      } else {
        currentP += ' ' + b.text;
      }
    }
    if (currentP) assembledBlocks.push({ type: 'p', text: currentP.trim(), pageNum: prevPage });

    // Group consecutive Hebrew lines and pull-quote lines
    const finalBlocks = [];
    let curHebrew = [];
    let curPullQuote = [];
    for (const b of assembledBlocks) {
      if (b.type === 'hebrew-line') {
        curHebrew.push(b.text);
      } else if (b.type === 'pull-quote-line') {
        curPullQuote.push(b.text);
      } else {
        if (curHebrew.length > 0) {
          finalBlocks.push({ type: 'hebrew-block', text: curHebrew.map(escapeHtml).join('<br>'), pageNum: b.pageNum });
          curHebrew = [];
        }
        if (curPullQuote.length > 0) {
          finalBlocks.push({ type: 'pull-quote', text: curPullQuote.join(' '), pageNum: b.pageNum });
          curPullQuote = [];
        }
        finalBlocks.push(b);
      }
    }
    if (curHebrew.length > 0) {
      finalBlocks.push({ type: 'hebrew-block', text: curHebrew.map(escapeHtml).join('<br>') });
    }
    if (curPullQuote.length > 0) {
      finalBlocks.push({ type: 'pull-quote', text: curPullQuote.join(' ') });
    }

    // Helper to format body text with footnote superscripts
    function renderFormattedText(text) {
      if (!text) return '';
      let escaped = escapeHtml(text);
      escaped = escaped.replace(/\\[FN:(\\d+)\\]/g, (m, num) => {
        const clickAttr = ' onclick="showFootnotePopover(event, ' + num + ')" tabindex="0" role="button" aria-label="Footnote ' + num + '"';
        return '<sup class="liquid-footnote-ref"' + clickAttr + ' data-fn="' + num + '">' + num + '</sup>';
      });
      return escaped;
    }

    // Build output HTML
    let renderedHtml = '<div class="liquid-document-container">';
    renderedHtml += '<div class="liquid-wip-banner"><span>⚠️</span><span><strong>Liquid Mode Beta:</strong> This feature is still a work in progress.</span></div>';

    // Document Header inside Liquid Mode container (docKicker banner disabled per user request)
    if (docTitle || docAuthor) {
      renderedHtml += '<div class="liquid-header">';
      // docKicker ("The Benjamin..." banner) disabled for now per user request
      // if (docKicker) renderedHtml += '<div class="liquid-kicker">' + escapeHtml(docKicker) + '</div>';
      if (docTitle) renderedHtml += '<h1 class="liquid-title">' + escapeHtml(docTitle) + '</h1>';
      if (docAuthor) renderedHtml += '<div class="liquid-byline">' + escapeHtml(docAuthor) + '</div>';
      if (docRole) renderedHtml += '<div class="liquid-role">' + escapeHtml(docRole) + '</div>';
      renderedHtml += '</div>';
    }

    let curPageMarker = null;
    for (const b of finalBlocks) {
      if (b.pageNum && b.pageNum !== curPageMarker) {
        curPageMarker = b.pageNum;
        renderedHtml += '<div class="liquid-page-marker">\uD83D\uDCC4 Page ' + curPageMarker + ' of ' + pdfTotalPages + '</div>';
      }

      if (b.type === 'h1') {
        if (!docTitle) {
          renderedHtml += '<h1 class="liquid-title">' + escapeHtml(b.text) + '</h1>';
        }
      } else if (b.type === 'h2') {
        renderedHtml += '<h2 class="liquid-heading">' + escapeHtml(b.text) + '</h2>';
      } else if (b.type === 'heading') {
        renderedHtml += '<h3 class="liquid-heading">' + escapeHtml(b.text) + '</h3>';
      } else if (b.type === 'pull-quote') {
        renderedHtml += '<aside class="liquid-pull-quote"><blockquote>“' + escapeHtml(b.text.replace(/^["“\s]+|["”\s]+$/g, '')) + '”</blockquote><span class="liquid-pull-quote-tag">Featured Excerpt</span></aside>';
      } else if (b.type === 'hebrew-block') {
        renderedHtml += '<div class="liquid-hebrew-block" dir="rtl">' + b.text + '</div>';
      } else if (b.type === 'p') {
        renderedHtml += '<p class="liquid-paragraph">' + renderFormattedText(b.text) + '</p>';
      }
    }

    // Render Endnotes section if present
    const endnoteNums = Object.keys(liquidFootnoteMap).map(Number).sort((a,b) => a - b);
    if (endnoteNums.length > 0) {
      renderedHtml += '<section class="liquid-endnotes">';
      renderedHtml += '<h3 class="liquid-endnotes-title">Endnotes</h3>';
      renderedHtml += '<ol class="liquid-endnotes-list">';
      for (const num of endnoteNums) {
        const text = liquidFootnoteMap[String(num)];
        const isRtl = /[\u0590-\u05FF]/.test(text) && !/[a-zA-Z]{3,}/.test(text);
        const dirAttr = isRtl ? ' dir="rtl"' : '';
        renderedHtml += '<li class="liquid-endnotes-item" id="fn-' + num + '"' + dirAttr + '>' + escapeHtml(text) + '</li>';
      }
      renderedHtml += '</ol></section>';
    }

    renderedHtml += '</div>';

    if (currentExtractionId !== activeExtractionId) return;

    if (finalBlocks.length > 0) {
      container.innerHTML = renderedHtml;
      container.style.fontSize = liquidFontSizeRem + 'rem';
    } else {
      container.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">' +
        '<p>This document contains scanned imagery or complex vector layout.</p>' +
        '<button type="button" class="article-btn" onclick="setArticleMode(&apos;original&apos;)" style="margin-top: 12px;">Switch to Original Page View</button>' +
        '</div>';
    }
  }

  async function loadArticlePdf(rawUrl) {
    if (!rawUrl) return;
    const container = document.getElementById('articleViewerContainer');
    if (container) container.style.display = 'block';

    const audioWrap = document.getElementById('audioControlsWrap');
    if (audioWrap) audioWrap.style.display = 'none';

    // Pause audio if playing and clear src so background playback does not trigger
    if (audio) {
      if (!audio.paused) audio.pause();
      try { audio.src = ''; audio.load(); } catch(e){}
    }
    hasAudio = false;

    // Clean up previous pdfDoc to release memory and web worker
    if (pdfDoc) {
      try {
        pdfDoc.destroy();
      } catch(e) {}
      pdfDoc = null;
    }

    // Determine initial mode based on screen width & orientation:
    // Mobile portrait (<768px and height > width) defaults to Liquid Mode
    const isMobilePortrait = window.innerWidth <= 768 && window.innerHeight >= window.innerWidth;
    const initialMode = isMobilePortrait ? 'liquid' : 'original';
    setArticleMode(initialMode);

    const proxyUrl = getPdfProxyUrl(rawUrl);

    try {
      if (typeof pdfjsLib === 'undefined') {
        console.warn('pdfjsLib is not loaded yet');
        const content = document.getElementById('liquidContent');
        if (content) {
          content.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">' +
            '<p>PDF Reader library could not be loaded.</p>' +
            '<a href="' + escapeHtml(rawUrl) + '" target="_blank" class="article-btn" style="margin-top:12px; display:inline-flex;">Open / Download PDF Document</a>' +
            '</div>';
        }
        return;
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      const loadingTask = pdfjsLib.getDocument({
        url: proxyUrl,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true
      });

      pdfDoc = await loadingTask.promise;
      pdfTotalPages = pdfDoc.numPages;
      pdfCurrentPage = 1;
      updatePageNavUI();

      // Download button
      const dlPdfBtn = document.getElementById('dlPdfBtn');
      if (dlPdfBtn) dlPdfBtn.href = rawUrl;

      // Render views based on current mode
      if (articleViewerMode === 'original') {
        if (pageScrollMode === 'continuous') {
          renderContinuousPages();
        } else {
          renderArticlePage(1);
        }
      }
      extractAndRenderLiquidText();
    } catch (err) {
      console.error('Failed to load PDF in reader:', err);
      const content = document.getElementById('liquidContent');
      if (content) {
        content.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">' +
          '<p>Unable to display document directly in browser preview.</p>' +
          '<a href="' + escapeHtml(rawUrl) + '" target="_blank" class="article-btn" style="margin-top:12px; display:inline-flex;">Open / Download PDF Document</a>' +
          '</div>';
      }
    }
  }

  function toggleArticleFullscreen() {
    const container = document.getElementById('articleViewerContainer');
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => {
        console.warn('Fullscreen error:', err);
      });
    } else {
      document.exitFullscreen();
    }
  }

  // Responsive device orientation adaptation
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (!isCurrentShiurArticle || !pdfDoc) return;
      const isMobile = window.innerWidth <= 768;
      const isLandscape = window.innerWidth > window.innerHeight;
      if (isMobile) {
        if (isLandscape) {
          setArticleMode('original');
        } else {
          setArticleMode('liquid');
        }
      }
      updateOrientationTip();
    }, 250);
  });

  window.addEventListener('resize', () => {
    if (isCurrentShiurArticle && articleViewerMode === 'original') {
      updateOrientationTip();
    }
  });

  // Auto-load article if initial page load was an article
  if (INITIAL_ARTICLE_PDF) {
    loadArticlePdf(INITIAL_ARTICLE_PDF);
  }

  // If page loaded with audio, try to autoplay or wait for user touch
  if (hasAudio) {
    audio.play().catch(() => {
      console.log('Autoplay deferred for user tap');
    });
  }
</script>

</body>
</html>
`;
}

function renderShiurCardHtml(s, searchTerms = [], options = {}) {
  const id = s.shiurid || s.shiurID || s.id || '';
  const title = s.shiurtitle || s.shiurTitle || s.title || 'Untitled Shiur';
  let speaker = s.teacherfullname || '';
  let photo = '';
  if (s.shiurTeachers && s.shiurTeachers[0]) {
    speaker = s.shiurTeachers[0].teacherName || s.shiurTeachers[0].teacherFullName || speaker;
    photo = s.shiurTeachers[0].teacherPhotoURL_lp || s.shiurTeachers[0].teacherPhotoURL_o || s.shiurTeachers[0].teacherPhotoURL || '';
  } else if (s.speaker) {
    speaker = s.speaker;
    photo = s.speakerPhoto || s.photo || '';
  }
  if (!speaker) speaker = 'YUTorah';

  if (!photo && s.PHOTO) {
    photo = s.PHOTO.startsWith('http') ? s.PHOTO : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${s.PHOTO}`;
  }
  if (!photo && s.photo) {
    photo = s.photo.startsWith('http') ? s.photo : `https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/${s.photo}`;
  }
  if (!photo) {
    photo = 'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/_default.jpg';
  }

  const duration = s.durationformatted || (typeof s.duration === 'number' ? s.duration + ' min' : (s.duration || ''));
  const rawDate = s.shiurdateformatted || s.shiurDateFormatted || s.shiurdate || s.shiurDate || s.shiurdatesubmitted || s.shiurDateSubmitted || s.date || '';
  const dateStr = formatShiurDate(rawDate);
  const isNew = isShiurNew(s.shiurdatesubmitted || s.shiurDateSubmitted || rawDate);
  const newBadge = isNew ? '<span class="quick-card-new-badge">NEW</span>' : '';
  const category = (Array.isArray(s.categoryname) && s.categoryname[0]) || (Array.isArray(s.subcategoryname) && s.subcategoryname[0]) || s.category || '';

  const mediaCat = (s.mediatypecategory || s.mediaTypeCategory || '').toLowerCase();
  const urlCheck = s.shiururl || s.shiurURL || s.playerDownloadURL || s.downloadURL || '';
  const isArticle = mediaCat === 'text' || mediaCat === 'article' || /\.pdf($|\?)/i.test(urlCheck);

  const metaParts = [];
  if (isArticle) {
    metaParts.push('📄 Article');
  } else if (duration) {
    metaParts.push('⏱ ' + escapeHtml(duration));
  }
  if (dateStr) metaParts.push(escapeHtml(dateStr));
  const bottomMeta = metaParts.join(' · ');

  let displayTitle = escapeHtml(title);
  let displaySpeaker = escapeHtml(speaker);
  let displayCategory = category ? escapeHtml(category) : '';
  let matchReasonHtml = '';

  if (searchTerms && searchTerms.length > 0) {
    displayTitle = highlightMatches(title, searchTerms);
    displaySpeaker = highlightMatches(speaker, searchTerms);
    if (category) displayCategory = highlightMatches(category, searchTerms);

    const reasons = buildMatchReasons(s, searchTerms);
    if (reasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        reasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    } else {
      let matchedVisible = [];
      if (displayTitle.includes('mark class="match-mark"')) matchedVisible.push('Title');
      if (displaySpeaker.includes('mark class="match-mark"')) matchedVisible.push('Speaker');
      if (displayCategory && displayCategory.includes('mark class="match-mark"')) matchedVisible.push('Category');
      const visibleNote = matchedVisible.length > 0 ? 'Matched search term in ' + matchedVisible.join(' & ') : 'Matched via YUTorah index relevance';
      const visibleBadge = matchedVisible.length > 0 ? '✨ Direct Match' : '🎯 Solr Index';
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        '<div class="match-reason-item">' +
          '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(visibleBadge) + '</span></div>' +
          '<div class="match-reason-snippet">' + escapeHtml(visibleNote) + '</div>' +
        '</div>' +
      '</div>';
    }
  }

  const isCover = options.isCover;
  const seriesBadge = isCover
    ? `<div class="series-cover-badge">📚 Series · ${options.seriesCount || 'Multi-Part'} Shiurim</div>`
    : '';
  const coverClass = isCover ? ' is-series-cover' : '';
  const badgePlay = `event.stopPropagation(); playShiurById(event, '${id}', true)`;
  const actionBadge = isArticle
    ? '<span class="quick-play-badge" style="background:#10b981; color:#fff;">📄 Read</span>'
    : `<span class="quick-play-badge" role="button" tabindex="0" data-kbplay onclick="${badgePlay}">▶ Play</span>`;

  return `
    <a href="/${id}" class="quick-card-link${coverClass}" onclick="playShiurById(event, this.dataset.id)" data-id="${id}">
      ${newBadge}
      ${seriesBadge}
      <div class="quick-card-top">
        <img class="quick-card-avatar" src="${escapeHtml(photo)}" alt="${escapeHtml(speaker)}" loading="lazy" onerror="handleImgError(this)">
        <div class="quick-card-info">
          <div class="quick-card-title">${displayTitle}</div>
          <div class="quick-card-speaker">${displaySpeaker}</div>
          ${displayCategory ? `<div class="quick-card-category">${displayCategory}</div>` : ''}
        </div>
      </div>
      ${matchReasonHtml}
      <div class="quick-card-bottom">
        <span>${bottomMeta}</span>
        ${actionBadge}
      </div>
    </a>
  `;
}

function renderSeriesSubCardHtml(sub, partNumber, searchTerms = []) {
  const id = sub.shiurid || sub.shiurID || sub.id || '';
  const title = sub.shiurtitle || sub.shiurTitle || sub.title || 'Untitled';
  const duration = sub.durationformatted || (typeof sub.duration === 'number' ? sub.duration + ' min' : (sub.duration || ''));
  const rawDate = sub.shiurdateformatted || sub.shiurDateFormatted || sub.shiurdate || sub.shiurdatesubmitted || '';
  const dateStr = formatShiurDate(rawDate);
  const displayTitle = searchTerms.length > 0 ? highlightMatches(title, searchTerms) : escapeHtml(title);

  const mediaCat = (sub.mediatypecategory || sub.mediaTypeCategory || '').toLowerCase();
  const urlCheck = sub.shiururl || sub.shiurURL || sub.playerDownloadURL || sub.downloadURL || '';
  const isArticle = mediaCat === 'text' || mediaCat === 'article' || /\.pdf($|\?)/i.test(urlCheck);

  let matchReasonHtml = '';
  if (searchTerms.length > 0) {
    const reasons = buildMatchReasons(sub, searchTerms);
    if (reasons.length > 0) {
      matchReasonHtml = '<div class="quick-card-match-reason">' +
        reasons.map(r => 
          '<div class="match-reason-item">' +
            '<div class="match-reason-header"><span class="match-reason-badge">' + escapeHtml(r.badge) + '</span></div>' +
            '<div class="match-reason-snippet" dir="auto">' + r.snippet + '</div>' +
          '</div>'
        ).join('') +
      '</div>';
    }
  }

  const metaParts = [];
  if (isArticle) {
    metaParts.push('📄 Article');
  } else if (duration) {
    metaParts.push('⏱ ' + escapeHtml(duration));
  }
  if (dateStr) metaParts.push(escapeHtml(dateStr));

    const subPlay = `event.stopPropagation(); playShiurById(event, '${id}', true)`;
    const subAction = isArticle
      ? '<span class="series-sub-play" style="background:#10b981; color:#fff;">📄 Read</span>'
      : `<span class="series-sub-play" role="button" tabindex="0" data-kbplay onclick="${subPlay}">▶ Play</span>`;

    return `
    <a href="/${id}" class="series-sub-card" onclick="playShiurById(event, this.dataset.id)" data-id="${id}">
      <div class="series-sub-header">
        <div class="series-sub-title"><span style="opacity:0.75; font-weight:700; margin-right:4px;">#${partNumber}</span> ${displayTitle}</div>
        ${subAction}
      </div>
      ${matchReasonHtml}
      ${metaParts.length > 0 ? `<div class="series-sub-meta">${metaParts.join(' · ')}</div>` : ''}
    </a>
  `;
}

function renderGroupItemHtml(item, searchTerms = []) {
  if (!item.isSeries) {
    return renderShiurCardHtml(item.doc, searchTerms);
  }
  const cover = item.cover;
  const subDocs = item.subDocs;
  const drawerId = 'series_drawer_' + (cover.shiurid || cover.shiurID || cover.id || '') + '_' + Math.random().toString(36).substring(2, 7);
  const coverHtml = renderShiurCardHtml(cover, searchTerms, { isCover: true, seriesTitle: item.title, seriesCount: item.docs.length });
  const subCardsHtml = subDocs.map((sub, idx) => renderSeriesSubCardHtml(sub, idx + 2, searchTerms)).join('');

  return `
    <div class="quick-card-series-group">
      ${coverHtml}
      <button type="button" class="series-expand-btn" data-drawer-target="${drawerId}" data-sub-count="${subDocs.length}" data-series-title="${escapeHtml(item.title || '')}" onclick="toggleSeriesDrawer(event, this.dataset.drawerTarget)">
        <span class="series-expand-icon">➕</span> <span class="series-expand-text">View ${subDocs.length} more in ‘${escapeHtml(item.title || 'this')}’ Series</span>
      </button>
      <div id="${drawerId}" class="series-drawer" style="display: none;">
        ${subCardsHtml}
      </div>
    </div>
  `;
}

function renderSeriesCardHtml(s) {
  const imgUrl = s.imageURL || 'https://cdnyutorah.cachefly.net/_images/series/riets.gif';
  const name = s.name || 'Featured Series';
  const desc = s.description || '';
  const count = s.numShiurim || 0;
  const seriesId = s.seriesID || '';

  return `
    <div class="series-card" data-id="${escapeHtml(seriesId)}" data-name="${escapeHtml(name)}" onclick="filterBySeries(this.dataset.id, this.dataset.name)" title="Explore ${escapeHtml(name)}">
      <div class="series-card-img" style="background-image: url('${escapeHtml(imgUrl)}');"></div>
      <div class="series-card-body">
        <div class="series-card-title">${escapeHtml(name)}</div>
        ${desc ? `<div class="series-card-desc">${escapeHtml(desc)}</div>` : ''}
        <div class="series-card-count">📚 ${count} shiurim</div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
