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
      src: "/icons/icon-shield-192.png?v=3",
      sizes: "192x192",
      type: "image/png",
      purpose: "any"
    },
    {
      src: "/icons/icon-shield-512.png?v=3",
      sizes: "512x512",
      type: "image/png",
      purpose: "any"
    },
    {
      src: "/icons/icon-shield-192.png?v=3",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable"
    },
    {
      src: "/icons/icon-shield-512.png?v=3",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable"
    }
  ]
};

const PWA_ICON_192_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAACXBIWXMAAAAAAAAAAQCEeRdzAAADAFBMVEUAAAAAAAAAAAAAAAAAAQEAAQEAAQEBAQEBAQEBAQEBAQIBAQIBAgIBAgIBAgICAgICAgMCAgMCAgMCAgMCAwMCAwMCAwQCAwQCAwQDAwQDAwQDAwQDBAUDBAUDBAUDBAUEBAYEBQYEBQYFBQcFBgcFBggFBggFBwkFBwkGBwkGCAoHCAoHCQsICg0ICg0JCw4JCw4JCw8KDA8KDBAKDRALDhIMDhMMDxMNEBQOEBUOERYPEhcPEhcPExgQExkRFBkRFRoSFRsSFhwTFx0TFx4UGB4UGB8VGSAVGSEWGiIXGyMXGyQYHSUYHSYZHicaHygaICkaICkbISocIisdIywdIy0eJC4eJC8eJS8fJTAgJjEgJzIhJzMiKDQiKTQjKTUjKjYkKzglLDkmLTsmLjwnLz0oMD4oMT8pMkApMkAqM0ErNEIrNEMsNUUtNkYuN0cuOEgvOEgvOUkwOkoxO0syO0wyPE4zPU8zPlA0PlA1P1E1QFM2QVQ3QlY4Q1Y5RVg5RVk6Rlo7R1s8SFw9SV49Sl89Sl8+TGJATWNBTmVBT2VCT2ZDUGdEUmlEUmpFU2tFVGxGVWxHVW5HVm5IVm9JV3FJWHJKWXJKWXNLW3RMW3VMXHZNXXhOXnlPX3pQYHtQYX1RYX1RYn5SYn9SYn9SY39TZIBTZIFTZIFUZYFUZYJUZYJUZYNVZoNVZoRVZoRVZoRVZ4RVZ4RWZ4VWZ4VWZ4VWZ4VWaIZXaIZXaIdXaYdXaYdXaYdXaYhYaYhYaYhYaYhYaYhYaohYaohYaohYaohYaolYaolZa4lZa4lZa4pZa4pZbItabItabIxabYxbbYxbbo1bbo1bbo5cb49cb49dcJBdcJBdcJFecZFecZFecZJfcpNfcpNfc5Rgc5RgdJVhdJZhdZZhdZdidpdidphidphidpljd5ljd5ljd5pkeJpkeJtkeZtleZxleZxlep1lep5me55me59nfKBnfaFofaFpfqNqf6RsgaZsgqhuhKpwh65zirF2jbYA/wAl6fVBAAABAHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AU/cHJQAAEABJREFUeJztXduL20i633/7wD7sOYeF2bOXmZ2dmXN2djaZdpDFCEsg6qHkAumhHoQRrbaMhbCxaNlWTEx3YpJMyFz2oU5dZV1tt9shLOQLaV90q1/Vd6+vyr8h/+b0m4/dgMfSJwAfmz4B+Nj0CcDHpk8APjZ9AvCx6YMC8CR9yGd8IAC9P6HhwCpoMER/+jAP+hAA7u9e34xWdnqfb17tCNm9evVyl4LV6Gb38vIPuzQAs29Q0sZpcvv5f+2//u3nt4tsahj9NO7Byz7xYgAsGwALjKNxFEVx+ylhNAnCMQL0TPtSj70MgNEo8IdDhBwUjsPDp44Dh56IhkM/GI0u8exHAkiSwHFM09LRer3sOGcWNb5artdINy00COZx8rgWPAKAZ9u6rluGt3mR/dRxjrEgz3R9w97e1c75ZZtZy0nP0IEV5ue34kwAhm1Z0A7XeZ697jqnbwDPN/187TDtM37a0tWf/f3NKscA6FTwj/BeFz0YANfuCFPzNF6AjnNMm5ITRchDgU6I9oZ+F94EQdp+wWIyjadxwO9sPrQ9DwHglanzpOI89moz7vnmV/pnAvn3YPGIez8CwDSOEALWAKTZatN51oAqopsJ8ej4uGhNSIbNt6XDv8wgALNDj0lXiWVaJkAoiqentew4gNupafxg6IY5WO1+Lr7VShydqTcG9vDQYd1JyJDJBobjJ5WbZX01Aql2vWp93rv8LjVN+kADzLPWMx4GYGTY4WqVv8jvK19PA5+/epRpLV1+eYM8ghEgmAJArKUY6zXlihXwGA4tZs500kK759kyz3zLbj16EgCdClSfvZmA0Pii5QTbWzJLRMUZe9aP8kvmJoQx/ZIeoAILkTMNqpflyijMAGV237Yx6mwkChD3Oza6RYfkdADUTiI/8KkE8o9Gh5L2EHIRYeoI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";
const PWA_ICON_512_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAAACXBIWXMAAAAAAAAAAQCEeRdzAAADAFBMVEUAAAAAAAAAAAAAAAAAAQEAAQEAAQEAAQEAAQEAAQEBAQEBAQEBAQEBAQEBAQIBAQIBAgIBAgIBAgICAgICAgMCAgMCAgMCAwMCAwQDAwQDAwQDAwQDAwQDBAUDBAUDBAUEBAUEBAYEBQYEBQYEBQYEBQcEBQcFBgcFBgcFBggFBwkFBwkGCAoHCAoHCQsICQwICg0ICg4JCw4JCw8KDA8KDBAKDRELDhELDhIMDhIMDxMNEBQNEBUOERYOERYPEhcPExgQExgRFBkRFRsSFRoSFhsTFx0TFx4UGB4UGB8VGSAVGSAVGSEWGiIXGyMXHCQYHSUZHiYZHycaICkbISocIisdIy0eJC4fJTAgJjEgJjIhJzMhKDQiKDUjKjYkKzglLDklLTomLTsmLjwnLzwnLz0oMD4pMkAqM0ErM0IrNEMsNUUtNkYtN0cuOEgvOUkwOkoxO0wyPE0zPU80PlA0PlE1P1E1QFI1QFM2QVQ2QVU3QlU4QlY4RFc5RVg6Rlo7R1s8SFw9SV49Sl8+S2E/TGE/TGJATWJATWNBTmRBTmVCT2ZDUWdEUmlFU2pFU2tFU2xGVGxHVW1HVm5IVm9JV3FJWHFKWXNLWnRMW3VMXHZNXXdOXnlOXnlPX3pPX3pQYHtQYHxRYX1RYn5RYn5SYn9SY39SY4BTZIBTZIFUZYJUZYJUZoNVZoNVZoRVZoRVZoRVZ4RWZ4RWZ4VWZ4VWaIVWaIZWaIZXaIZXaIdXaYdXaYdYaYhYaYhYaYhYaYhYaohYaohYaohYaolYaolYaolZa4lZa4pZa4pZa4pZbItabItabIxbbYxbbY1bbY1bbo1bbo1cbo5cb49cb49dcJBdcJFecZFecZFecZJecpJfcpNfcpNfc5Rgc5RgdJVhdJZhdJZhdZZhdZdidZdidphidphidpljd5ljd5ljd5pkeJtkeZtkeZxleZxlep1mep5me59nfJ9nfKBofaFofaFpfqNqf6VrgKZsgadtg6lvhqxxiK9zi7N2jrcA/wDov3CiAAABAHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AU/cHJQAAEABJREFUeJzsvfuPo1ieL3j/5L27o9Udre7O9PTsqPtW97S6p+udSnVFKMPBkUFCR0b4iB+QkEAyBlkgbGFksEygtOzMiMrKVL1mrrzne8A2B7/AjszK6syvuisdGMMBPnzfj/+2+kgfNP23X3oBH+mXpY8A+MDpIwA+cPoIgA+cPgLgA6ePAPjA6SMAPnD6CIAPnD4C4AOnjwD4wOkjAD5w+giAD5w+AuADp48A+MDpIwA+cPoIgA+cPgLgA6ePAPjA6SMAPnD6CIAPnD4C4AOnjwD4wOkjAD5w+giAD5w+AuADp48A+MDpIwA+cPoIgA+cPgLgA6ePAPjA6QMFgLaHfuk1/TL0YQJg3/P/CIAPgroiJkcI/9Lre+f0IQHgyvEtCbUl+SBJbSSZvvNLL/Rd0gcBAFXHz54+vcGGQbAs4yNEvyWG0bl5+vTZB8IMPgQADAxi+eHIM4huDzxv4LruYEA/0I+MPPYR/oJ/bZ0Y3ij0LWL80gt/F/R3DYC79C5bLKa+hnU/jtwuNofpPEun01maPZ8vl4vnsNfzxWIxz2mxXKRDExM3in0da/50nk0Xb37py3ir9HcJgDDwgyGlIAhGYejbqqRYjk1kbAXTLJvGcTKt/gSe/gL+Nw0MLGu2YymSYlO+EYziJJC++utnV9YvcCVvn/4OAdDpKOqGFEVRNcOyDJ3+xyQSEgQBHfjhDaWWIBFzvbtGf64qHawafde1qP7wTq/j3dDfGwCGBrq5EdCGhFarbfiTeOSPsyy4/uM//eP/c+TX//2//1//7x+vgyyLw2g2C22MBHqEG2SOppMBvrlqYfudXck7or8fAIzHURyHA4Jub3kAiFaYZUm8rH+oNz+8mi8eXs58TWKHQMTxB4YkCCKx/fFkEo3Hb+863jH9HQDAKJOu7Xp3KDs/68DW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";

const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <!-- Yeshiva University Authentic Shield -->
  <image href="data:image/png;base64,${PWA_ICON_512_BASE64}" x="16" y="31" width="480" height="450"/>
</svg>`;

const SW_SCRIPT = `// YUTorah Player Service Worker v1.0.0
const CACHE_NAME = 'yutorah-pwa-v3';
const PRECACHE_URLS = [
  '/',
  '/manifest.json?v=3',
  '/icons/icon-shield-192.png?v=3',
  '/icons/icon-shield-512.png?v=3'
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
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0'
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

  if (
    url.pathname === '/icons/icon-shield-192.png' ||
    url.pathname === '/icons/icon-192.png' ||
    url.pathname === '/icons/icon-maskable-192.png' ||
    url.pathname === '/favicon.ico'
  ) {
    return new Response(getIcon192Bytes(), {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  if (
    url.pathname === '/icons/icon-shield-512.png' ||
    url.pathname === '/icons/icon-512.png' ||
    url.pathname === '/icons/icon-maskable-512.png'
  ) {
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
  <link rel="icon" type="image/png" href="/icons/icon-shield-192.png?v=3">
  <link rel="manifest" href="/manifest.json?v=3">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="YUTorah">
  <meta name="application-name" content="YUTorah">
  <meta name="theme-color" content="#2b4c7e" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f141c" media="(prefers-color-scheme: dark)">
  <link rel="apple-touch-icon" href="/icons/icon-shield-192.png?v=3">
  <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-shield-192.png?v=3">
  <link rel="apple-touch-icon" sizes="512x512" href="/icons/icon-shield-512.png?v=3">
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
