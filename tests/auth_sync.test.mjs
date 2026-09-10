// Regression tests for Google OAuth session probe + D1 sync gating.
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

console.log('🧪 Running Auth & Sync Regression Tests...\n');
const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
const noDbEnv = {};

// 1. /api/me with no session → { user: null }, never errors
let res = await worker.fetch(new Request('https://x/api/me'), noDbEnv, mockCtx);
assert.equal(res.status, 200, '/api/me 200');
let body = await res.json();
assert.equal(body.user, null, 'anonymous session yields null user');
console.log('  ✅ /api/me anonymous probe correct.');

// 2. /api/sync without DB binding → 503 (not a crash)
res = await worker.fetch(new Request('https://x/api/sync'), noDbEnv, mockCtx);
assert.equal(res.status, 503, '/api/sync without DB → 503');
console.log('  ✅ /api/sync degrades gracefully without DB.');

// 3. /api/sync without session (DB present, fake) → 401, not 500
const fakeDb = {
  prepare: () => { throw new Error('should not reach db without session'); }
};
res = await worker.fetch(new Request('https://x/api/sync'), { yutorah_db: fakeDb }, mockCtx);
assert.equal(res.status, 401, '/api/sync anonymous → 401');
console.log('  ✅ /api/sync rejects anonymous callers.');

// 4. /auth/google without credentials → setup page (503), not redirect loop
res = await worker.fetch(new Request('https://x/auth/google'), {}, mockCtx);
assert.equal(res.status, 503, '/auth/google without creds → setup page');
const setupHtml = await res.text();
assert.ok(setupHtml.includes('/auth/callback'), 'setup page documents callback URL');
console.log('  ✅ /auth/google explains setup without credentials.');

// 5. /auth/logout clears the session cookie (POST only; GET is rejected)
res = await worker.fetch(new Request('https://x/auth/logout'), {}, mockCtx);
assert.equal(res.status, 405, 'logout via GET rejected');
res = await worker.fetch(new Request('https://x/auth/logout', { method: 'POST' }), {}, mockCtx);
assert.equal(res.status, 200, 'logout via POST ok');
const logoutBody = await res.json();
assert.equal(logoutBody.ok, true, 'logout confirms');
const setCookie = res.headers.get('set-cookie') || '';
assert.ok(setCookie.includes('yutorah_session=') && setCookie.includes('Max-Age=0'), 'logout clears cookie');
console.log('  ✅ /auth/logout clears session cookie (POST-only).');

// 6. Forged session cookies are rejected (HMAC, no DB hit needed)
const forgedDb = {
  prepare: () => { throw new Error('must not query db on bad signature'); }
};
res = await worker.fetch(new Request('https://x/api/sync', {
  headers: { Cookie: 'yutorah_session=aaa.bbb.ccc' }
}), { yutorah_db: forgedDb, SESSION_SECRET: 'test-secret' }, mockCtx);
assert.equal(res.status, 401, 'forged session → 401');
console.log('  ✅ Forged sessions rejected before any DB access.');

console.log('\n🎉 ALL AUTH & SYNC TESTS PASSED SUCCESSFULLY!');
