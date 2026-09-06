import assert from 'node:assert/strict';
import {
  stripSpeakerHonorifics,
  resolveSpeaker,
  getPhoneticSkeleton,
  expandQueryWithPhonetics,
  SYNSETS
} from '../src/phonetic_engine.js';

console.log('🧪 Running Phonetic & Reverse Transliteration Test Suite...\n');

// 1. Test Speaker Honorific Stripping
console.log('1. Testing Speaker Honorific Stripping:');
assert.equal(stripSpeakerHonorifics('Rabbi Hershel Schachter'), 'Hershel Schachter');
assert.equal(stripSpeakerHonorifics('Rav Michael Rosensweig'), 'Michael Rosensweig');
assert.equal(stripSpeakerHonorifics('Rabbi Dr. Michael Rosensweig'), 'Michael Rosensweig');
assert.equal(stripSpeakerHonorifics("R' Aryeh Lebowitz"), 'Aryeh Lebowitz');
assert.equal(stripSpeakerHonorifics('Mrs. Michal Horowitz'), 'Michal Horowitz');
assert.equal(stripSpeakerHonorifics('HaRav Mordechai Willig'), 'Mordechai Willig');
console.log('  ✅ All honorific stripping tests passed.');

// 2. Test Speaker Resolution
console.log('2. Testing Speaker Resolution:');
const spk1 = resolveSpeaker('Rav Schachter');
assert.ok(spk1 && spk1.id === '80153');
const spk2 = resolveSpeaker('Rabbi Dr. Michael Rosensweig');
assert.ok(spk2 && spk2.id === '80018');
const spk3 = resolveSpeaker('Mrs. Horowitz');
assert.ok(spk3 && spk3.id === '82537');
console.log('  ✅ Speaker resolution tests passed.');

// 3. Test Phonetic Skeleton
console.log('3. Testing Phonetic Skeleton:');
// shabbos and shabbat both reduce to invariant shabat
assert.equal(getPhoneticSkeleton('shabbos'), 'shabat');
assert.equal(getPhoneticSkeleton('shabbat'), 'shabat');
assert.equal(getPhoneticSkeleton('shabos'), 'shabat');
// sukka, succah, and sukkah all reduce to suka
assert.equal(getPhoneticSkeleton('sukka'), 'suka');
assert.equal(getPhoneticSkeleton('sukkah'), 'suka');
assert.equal(getPhoneticSkeleton('succah'), 'suka');
// brachos and berakhot reduce identically
assert.equal(getPhoneticSkeleton('brachos'), 'brakhat');
console.log('  ✅ Phonetic skeleton tests passed.');

// 4. Test Query Expansion for Solr
console.log('4. Testing Solr Query Expansion:');
const exp1 = expandQueryWithPhonetics('shabbos');
assert.ok(exp1.solrQuery.includes('shabbat'));
assert.ok(exp1.solrQuery.includes('shabbos'));
assert.ok(exp1.solrQuery.includes('שבת'));
assert.equal(exp1.matchedSynset, 'shabbat');

const exp2 = expandQueryWithPhonetics('succah');
assert.ok(exp2.solrQuery.includes('sukkah'));
assert.ok(exp2.solrQuery.includes('סוכה'));

const exp3 = expandQueryWithPhonetics('chanukah');
assert.ok(exp3.solrQuery.includes('hanukkah'));
assert.ok(exp3.solrQuery.includes('חנוכה'));

const exp4 = expandQueryWithPhonetics('hilchot shabbos');
assert.ok(exp4.solrQuery.includes('shabbat'));
assert.ok(exp4.solrQuery.includes('shabbos'));
assert.ok(exp4.solrQuery.startsWith('hilchot '));

const exp5 = expandQueryWithPhonetics('quantum mechanics');
assert.equal(exp5.solrQuery, 'quantum mechanics');
assert.equal(exp5.matchedSynset, null);

console.log('  ✅ Query expansion tests passed.');
console.log('\n🎉 ALL PHONETIC TESTS PASSED SUCCESSFULLY!');
