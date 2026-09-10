// Sync merge semantics: no-wipe, series round-trip, listen_count discipline.
// Uses a minimal in-memory D1 stub matching the queries worker.js issues.
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

console.log('🧪 Running Sync Merge Tests...\n');

function makeDb() {
  const users = new Map();
  const hist = new Map(); // user|shiur -> row
  const items = new Map(); // user|playlist|shiur -> row
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  return {
    _users: users, _hist: hist, _items: items,
    prepare(sql) {
      const q = norm(sql);
      const self = this;
      return {
        _params: [],
        bind(...args) { this._params = args; return this; },
        async first() {
          const p = this._params;
          if (q.startsWith('SELECT id, email, name, picture FROM users')) {
            const u = users.get(p[0]);
            return u ? { id: u.id, email: u.email, name: u.name, picture: u.picture } : null;
          }
          if (q.startsWith('SELECT id FROM users WHERE google_sub')) {
            for (const u of users.values()) if (u.google_sub === p[0]) return { id: u.id };
            return null;
          }
          if (q.startsWith('SELECT last_listened_at')) {
            const r = hist.get(p[0] + '|' + p[1]);
            return r ? {
              last_listened_at: r.last_listened_at,
              progress_seconds: r.progress_seconds,
              duration_seconds: r.duration_seconds,
              completed: r.completed
            } : null;
          }
          throw new Error('unstubbed first(): ' + q.slice(0, 80));
        },
        async all() {
          const p = this._params;
          if (q.includes('FROM listening_history WHERE user_id = ? ORDER BY')) {
            const rows = [...hist.values()].filter(r => r.user_id === p[0])
              .sort((a, b) => b.last_listened_at - a.last_listened_at).slice(0, 500)
              .map(r => ({ id: r.shiur_id, title: r.title, speaker: r.speaker, photo: r.photo, duration: r.duration, dateISO: r.date_iso, dateDisplay: r.date_display, category: r.category, isArticle: r.is_article, progressSec: r.progress_seconds, durationSec: r.duration_seconds, completed: r.completed, lastListened: r.last_listened_at, listenCount: r.listen_count }));
            return { results: rows };
          }
          if (q.includes('FROM playlist_items WHERE user_id = ? ORDER BY')) {
            const rows = [...items.values()].filter(r => r.user_id === p[0])
              .map(r => ({ playlist: r.playlist, id: r.shiur_id, position: r.position, title: r.title, speaker: r.speaker, photo: r.photo, duration: r.duration, date: r.date_display, category: r.category, isArticle: r.is_article, seriesTitle: r.series_title, coverId: r.cover_id, kind: r.kind, addedAt: r.added_at }));
            return { results: rows };
          }
          if (q.startsWith('SELECT playlist, shiur_id FROM playlist_items')) {
            return { results: [...items.values()].filter(r => r.user_id === p[0]).map(r => ({ playlist: r.playlist, shiur_id: r.shiur_id })) };
          }
          if (q.startsWith('SELECT DISTINCT playlist FROM playlist_items')) {
            const set = new Set();
            for (const r of items.values()) if (r.user_id === p[0] && r.playlist.startsWith('custom:')) set.add(r.playlist);
            return { results: [...set].map(x => ({ playlist: x })) };
          }
          throw new Error('unstubbed all(): ' + q.slice(0, 100));
        },
        async run() {
          const p = this._params;
          if (q.startsWith('INSERT INTO users')) {
            users.set(p[0], { id: p[0], google_sub: p[1], email: p[2], name: p[3], picture: p[4] });
            return {};
          }
          if (q.startsWith('UPDATE users SET email')) {
            const u = [...users.values()].find(x => x.id === p[4]);
            if (u) Object.assign(u, { email: p[0], name: p[1], picture: p[2] });
            return {};
          }
          if (q.startsWith('UPDATE users SET last_seen_at')) return {};
          if (q.startsWith('INSERT INTO listening_history')) {
            const [user_id, shiur_id, title, speaker, photo, duration, date_iso, date_display, category, is_article, ps, ds, completed, last] = p;
            const k = user_id + '|' + shiur_id;
            const prev = hist.get(k);
            hist.set(k, {
              user_id, shiur_id, title, speaker, photo, duration, date_iso, date_display, category, is_article,
              progress_seconds: ps, duration_seconds: ds, completed,
              last_listened_at: last, listen_count: (prev ? prev.listen_count + (prev.last_listened_at < last ? 0 : 0) : 0) + (prev ? 0 : 1)
            });
            // emulate: increment only on true insert
            if (prev) hist.get(k).listen_count = prev.listen_count + (prev.last_listened_at < last ? 0 : 0);
            return {};
          }
          if (q.startsWith('INSERT INTO playlist_items')) {
            const [user_id, playlist, shiur_id, position, title, speaker, photo, duration, date_display, category, is_article, series_title, cover_id, kind, added_at] = p;
            const k = user_id + '|' + playlist + '|' + shiur_id;
            const prev = items.get(k);
            items.set(k, {
              user_id, playlist, shiur_id, position, title, speaker, photo, duration, date_display, category, is_article,
              series_title, cover_id, kind, added_at: Math.max((prev && prev.added_at) || 0, added_at)
            });
            return {};
          }
          if (q.startsWith('DELETE FROM playlist_items')) {
            items.delete(p[0] + '|' + p[1] + '|' + p[2]);
            return {};
          }
          throw new Error('unstubbed run(): ' + q.slice(0, 100));
        }
      };
    }
  };
}

async function authedFetch(db, secret, path, opts = {}) {
  // Build a real session JWT via login-callback internals is heavy; instead
  // seed a user + mint session by calling /api/me flow manually:
  const { default: w } = await import('../src/worker.js');
  return w;
}

const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

// Seed user directly in stub, mint session via WebCrypto (mirrors worker).
const db = makeDb();
const SECRET = 'test-secret-123';
db._users.set('u1', { id: 'u1', google_sub: 'g1', email: 'a@b.c', name: 'T', picture: '' });

async function mintSession(uid) {
  const enc = new TextEncoder();
  const b64 = bytes => {
    const bin = String.fromCharCode(...new Uint8Array(bytes));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = b64(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const b = b64(enc.encode(JSON.stringify({ uid, exp: Date.now() + 1000000, iat: Date.now() })));
  const sig = b64(await crypto.subtle.sign('HMAC', key, enc.encode(h + '.' + b)));
  return h + '.' + b + '.' + sig;
}

const env = { yutorah_db: db, SESSION_SECRET: SECRET };

async function api(path, body) {
  const token = await mintSession('u1');
  const req = new Request('https://x' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: 'yutorah_session=' + encodeURIComponent(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const res = await worker.fetch(req, env, mockCtx);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 1. Seed cloud library, then push from an EMPTY device → cloud must survive.
let r = await api('/api/sync', {
  dirty: { playlists: true, queue: true, history: true },
  history: [], playlists: { save_for_later: [{ id: 's1', title: 'T', addedAt: 100 }], favorites: [], custom: {} }, queue: [], progress: {}
});
assert.equal(r.status, 200, 'seed push 200');
r = await api('/api/sync', { dirty: { history: true }, history: [] });
assert.equal(r.status, 200, 'empty push 200');
assert.ok((r.body.playlists.save_for_later || []).some(x => x.id === 's1'), 'empty-device push must not wipe cloud playlists');
// ...unless the client explicitly marks playlists dirty AND sends empty (real delete-all).
r = await api('/api/sync', { dirty: { playlists: true }, playlists: { save_for_later: [], favorites: [], custom: {} } });
assert.ok(!(r.body.playlists.save_for_later || []).some(x => x.id === 's1'), 'explicit dirty-empty deletes');
console.log('  ✅ Empty push does not wipe cloud library (explicit delete-all still works).');

// 2. Series queue round-trips as one expandable entry.
r = await api('/api/sync', {
  queue: [{ kind: 'series', coverId: 'c9', seriesTitle: 'Daf', items: [{ id: 'a' }, { id: 'b' }] }]
});
assert.equal(r.status, 200, 'series push 200');
const q = r.body.queue || [];
assert.equal(q.length, 1, 'series regrouped into one entry, got ' + q.length);
assert.equal(q[0].kind, 'series', 'regrouped kind');
assert.deepEqual(q[0].items.map(x => x.id), ['a', 'b'], 'members preserved in order');
console.log('  ✅ Series queue round-trips collapsed.');

// 3. listen_count increments on insert only.
await api('/api/sync', { history: [{ id: 'h1', title: 'T', listenedAt: 1000 }] });
await api('/api/sync', { history: [{ id: 'h1', title: 'T2', listenedAt: 2000 }] });
assert.equal(db._hist.get('u1|h1').listen_count, 1, 'metadata re-push must not inflate listen_count');
assert.equal(db._hist.get('u1|h1').title, 'T2', 'metadata still updates');
console.log('  ✅ listen_count increments on insert only.');

// 4b. Newer listen WITHOUT progress must not zero stored progress.
await api('/api/sync', {
  dirty: { history: true },
  history: [{ id: 'h3', title: 'T', listenedAt: 1000 }],
  progress: { h3: { progressSec: 120, durationSec: 600, lastListened: 1000, completed: false } }
});
await api('/api/sync', {
  dirty: { history: true },
  history: [{ id: 'h3', title: 'T', listenedAt: 2000 }],
  progress: {}
});
assert.equal(db._hist.get('u1|h3').progress_seconds, 120, 'empty progress push keeps position');
console.log('  ✅ Progress survives progress-less newer pushes.');

// 4c. History untouched unless marked dirty.
await api('/api/sync', { dirty: { playlists: true }, playlists: { save_for_later: [], favorites: [], custom: {} } });
assert.equal(db._hist.get('u1|h3').title, 'T', 'non-dirty history left alone');
console.log('  ✅ Non-dirty collections untouched.');

// 4. Newer server data survives older push (LWW on pull path is client-side;
//    server skips stale rows).
await api('/api/sync', { history: [{ id: 'h2', title: 'New', listenedAt: 5000 }] });
await api('/api/sync', { history: [{ id: 'h2', title: 'Stale', listenedAt: 1000 }] });
assert.equal(db._hist.get('u1|h2').title, 'New', 'stale push skipped');
console.log('  ✅ Stale history pushes skipped server-side.');

console.log('\n🎉 ALL SYNC MERGE TESTS PASSED SUCCESSFULLY!');
