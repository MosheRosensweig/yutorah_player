// Regression tests for ROADMAP §5.4 (fuzzy Did-You-Mean) and §7 (Recent Results).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { damerauLevenshtein, suggestDidYouMean } from '../src/phonetic_engine.js';
import worker from '../src/worker.js';

console.log('🧪 Running Fuzzy Suggest & Recent Results Regression Tests...\n');
const meta = JSON.parse(fs.readFileSync(new URL('../src/autocomplete_data.json', import.meta.url)));
const pools = { teacher: meta.teachers, topic: meta.categories, venue: meta.venues };
const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

// 1. Edit-distance vectors
assert.equal(damerauLevenshtein('weider', 'wieder'), 1, 'transposition = 1');
assert.equal(damerauLevenshtein('kitten', 'sitting'), 3, 'classic vector');
assert.equal(damerauLevenshtein('same', 'same'), 0, 'identical = 0');
assert.equal(damerauLevenshtein('', 'abc'), 3, 'empty string');
console.log('  ✅ damerauLevenshtein vectors correct.');

// 2. The user's exact example: weiderblank -> Rabbi Netanel Wiederblank
const typo = suggestDidYouMean('weiderblank', pools);
assert.ok(typo.some(s => s.text === 'Rabbi Netanel Wiederblank' && s.distance === 1),
  'weiderblank must suggest Rabbi Netanel Wiederblank at distance 1, got: ' + JSON.stringify(typo));
assert.equal(typo[0].text, 'Rabbi Netanel Wiederblank', 'true typo correction must rank first (short-word hijack guard)');
console.log('  ✅ weiderblank → Rabbi Netanel Wiederblank (rank 1, distance 1).');

// 3. Other entity types + guards
const leb = suggestDidYouMean('Lebowtiz', pools);
assert.ok(leb.length > 0 && leb[0].text === 'Rabbi Aryeh Lebowitz', 'Lebowtiz → Lebowitz');
const pref = suggestDidYouMean('schach', pools);
assert.ok(pref.length > 0 && pref[0].text.includes('Schachter'), 'prefix schach → Schachter');
assert.deepEqual(suggestDidYouMean('xqzvkp', pools), [], 'garbage yields zero suggestions');
assert.deepEqual(suggestDidYouMean('qx', pools), [], 'short non-substring yields zero suggestions (no confident junk)');
assert.deepEqual(suggestDidYouMean('x', pools), [], 'single char yields zero suggestions');
console.log('  ✅ teacher/topic/venue ranking + garbage guards correct.');

// 4. /api/suggest endpoint (edge, local data only)
let res = await worker.fetch(new Request('https://x/api/suggest?q=weiderblank'), {}, mockCtx);
assert.equal(res.status, 200, '/api/suggest 200');
let body = await res.json();
assert.ok(body.suggestions.some(s => s.text === 'Rabbi Netanel Wiederblank'), '/api/suggest returns Wiederblank');
res = await worker.fetch(new Request('https://x/api/suggest?q=x'), {}, mockCtx);
body = await res.json();
assert.deepEqual(body.suggestions, [], '/api/suggest short query → []');
console.log('  ✅ /api/suggest endpoint correct.');

// 5. /api/search Recent Results rail (§7): full 30 relevance + extra 3 recent
res = await worker.fetch(new Request('https://x/api/search?q=shabbos&start=1'), {}, mockCtx);
assert.equal(res.status, 200, '/api/search 200');
body = await res.json();
assert.equal((body.response.recentDocs || []).length, 3, 'first page carries exactly 3 recentDocs');
assert.equal(body.response.docs.length, 30, 'relevance keeps its full 30 (recent rail is extra, not carved out)');
console.log('  ✅ recentDocs rail (3 extra) + full relevance page correct.');

// 5b. Speaker auto-resolution rules: single-word surnames must NOT narrow
// (all Rosensweigs match); multi-word names still resolve with disclaimer;
// distance-1 typos auto-correct onto the obvious entity with disclaimer.
res = await worker.fetch(new Request('https://x/api/search?q=Lebowitz&start=1'), {}, mockCtx);
body = await res.json();
assert.equal(body.queryResolution, null, 'single-word surname must not narrow to one speaker');
res = await worker.fetch(new Request('https://x/api/search?q=Aryeh%20Lebowitz&start=1'), {}, mockCtx);
body = await res.json();
assert.equal(body.queryResolution, null, 'multi-word queries stay plain text (no speaker split)');
res = await worker.fetch(new Request('https://x/api/search?q=rosensweig%20shabbos&start=1'), {}, mockCtx);
body = await res.json();
assert.equal(body.queryResolution, null, 'rosensweig shabbos does not narrow to one speaker');
const teachers = new Set((body.response.docs || []).map(d => d.teacherfullname || ((d.shiurTeachers || [])[0] || {}).teacherFullName));
assert.ok(teachers.size > 1 || (body.response.docs || []).length === 0, 'rosensweig shabbos spans multiple speakers, got: ' + JSON.stringify([...teachers]));
res = await worker.fetch(new Request('https://x/api/search?q=weiderblank&start=1'), {}, mockCtx);
body = await res.json();
assert.equal(body.queryResolution, null, 'no auto-rewrites: typo shows own matches');
assert.ok((body.didYouMean || []).some(s => s.text.includes('Wiederblank')),
  'typo offers Wiederblank strip, got: ' + JSON.stringify(body.didYouMean));
console.log('  ✅ resolution rules (no narrow / no rewrite / strip on top) correct.');

// 6. sort=date window is reverse-chronological
res = await worker.fetch(new Request('https://x/api/search?q=shabbos&sort=date&start=1&rows=5'), {}, mockCtx);
body = await res.json();
const dates = body.response.docs.map(d => String(d.shiurdate || d.shiurdatesubmitted || ''));
assert.equal(dates.length, 5, 'date window returns requested rows');
const sorted = [...dates].sort().reverse();
assert.deepEqual(dates, sorted, 'date window is reverse-chronological: ' + JSON.stringify(dates));
console.log('  ✅ sort=date window reverse-chronological.');

console.log('\n🎉 ALL FUZZY SUGGEST & RECENT RESULTS TESTS PASSED SUCCESSFULLY!');
