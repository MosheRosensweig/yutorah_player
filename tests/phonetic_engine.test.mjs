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
assert.ok(spk2 && spk2.id === '80146');
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
assert.ok(exp4.solrQuery.includes('hilchot'));
assert.ok(exp4.solrQuery.includes('הלכות'));

const exp5 = expandQueryWithPhonetics('quantum mechanics');
assert.equal(exp5.solrQuery, 'quantum mechanics');
assert.equal(exp5.matchedSynset, null);
console.log('  ✅ Solr query expansion tests passed.');

// 5. Test Ported Java EnglishBackToHebrew Algorithm & Final Letters
console.log('5. Testing Ported EnglishBackToHebrew Permutations:');
import { convertEnglishBackToHebrew, applyHebrewFinalLetters } from '../src/phonetic_engine.js';

// Test final letters (sofit)
assert.equal(applyHebrewFinalLetters('פסכ'), 'פסך');
assert.equal(applyHebrewFinalLetters('שלמ'), 'שלם');
assert.equal(applyHebrewFinalLetters('כהנ'), 'כהן');
assert.equal(applyHebrewFinalLetters('כפ'), 'כף');
assert.equal(applyHebrewFinalLetters('ארצ'), 'ארץ');

// Test algorithmic reverse transliterations
const shabbatCands = convertEnglishBackToHebrew('shabbat');
assert.ok(shabbatCands.includes('שבת'));

const succahCands = convertEnglishBackToHebrew('succah');
assert.ok(succahCands.includes('סכה'));

const pesachCands = convertEnglishBackToHebrew('pesach');
assert.ok(pesachCands.includes('פסח'));

const motsaiCands = convertEnglishBackToHebrew('motsai');
assert.ok(motsaiCands.includes('מצי'));

console.log('  ✅ EnglishBackToHebrew algorithmic tests passed.');

// 6. Test parseQueryEntities (Speaker vs Topic Separation)
console.log('6. Testing Query Entity Parsing:');
import { parseQueryEntities } from '../src/phonetic_engine.js';

// Single-word speaker + topic
const pe1 = parseQueryEntities('Rosensweig Shabbos');
assert.equal(pe1.speaker?.id, '80146');
assert.equal(pe1.remainingQuery, 'Shabbos');

// Topic + trailing speaker
const pe2 = parseQueryEntities('Shabbos Rosensweig');
assert.equal(pe2.speaker?.id, '80146');
assert.equal(pe2.remainingQuery, 'Shabbos');

// Multi-title speaker prefix + topic
const pe3 = parseQueryEntities('Rabbi Dr. Michael Rosensweig Shabbos');
assert.equal(pe3.speaker?.id, '80146');
assert.equal(pe3.remainingQuery, 'Shabbos');

// Topic + multi-word trailing speaker
const pe4 = parseQueryEntities('Yom Kippur Rabbi Hershel Schachter');
assert.equal(pe4.speaker?.id, '80153');
assert.equal(pe4.remainingQuery, 'Yom Kippur');

// Only speaker
const pe5 = parseQueryEntities('Rabbi Hershel Schachter');
assert.equal(pe5.speaker?.id, '80153');
assert.equal(pe5.remainingQuery, '');

// Non-speaker query
const pe6 = parseQueryEntities('hilchot shabbos');
assert.equal(pe6.speaker, null);
assert.equal(pe6.remainingQuery, 'hilchot shabbos');

// Empty query
const pe7 = parseQueryEntities('');
assert.equal(pe7.speaker, null);
assert.equal(pe7.remainingQuery, '');
console.log('  ✅ Query entity parsing tests passed.');

// 7. Verify 62 Synset Buckets Integrity
console.log('7. Testing 62 Synset Buckets Integrity:');
assert.equal(SYNSETS.length, 62, 'Should have exactly 62 synsets');
const seenCanonical = new Set();
for (const s of SYNSETS) {
  assert.ok(s.canonical, 'Synset must have canonical name');
  assert.ok(!seenCanonical.has(s.canonical), `Duplicate canonical: ${s.canonical}`);
  seenCanonical.add(s.canonical);
  assert.ok(Array.isArray(s.hebrew) && s.hebrew.length > 0, `Synset ${s.canonical} missing Hebrew`);
  assert.ok(Array.isArray(s.variants) && s.variants.length > 0, `Synset ${s.canonical} missing variants`);
}
console.log('  ✅ All 62 synset buckets passed integrity checks.');

console.log('\n🎉 ALL PHONETIC & REVERSE TRANSLITERATION TESTS PASSED SUCCESSFULLY!');

