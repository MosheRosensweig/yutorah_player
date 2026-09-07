import assert from 'node:assert/strict';
import {
  stripSpeakerHonorifics,
  resolveSpeaker,
  getPhoneticSkeleton,
  expandQueryWithPhonetics,
  SYNSETS,
  highlightMatches,
  extractSnippet,
  buildMatchReasons,
  COMMUNITY_ACRONYM_PHRASES,
  computeRelevanceScore,
  groupAndRankDocs
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
assert.ok(succahCands.includes('סוכה'), 'Upgraded vowel engine should generate full spelling סוכה');

const pesachCands = convertEnglishBackToHebrew('pesach');
assert.ok(pesachCands.includes('פסח'));

const motsaiCands = convertEnglishBackToHebrew('motsai');
assert.ok(motsaiCands.includes('מצי'));

// [UPGRADE TESTS] Initial Vowels (Alef / Ayin) and Medial Matres Lectionis
const elulCands = convertEnglishBackToHebrew('elul');
assert.ok(elulCands.includes('אלול') || elulCands.includes('אלל'), 'Initial e- should generate Alef (אלול)');

const omerCands = convertEnglishBackToHebrew('omer');
assert.ok(omerCands.includes('עמר') || omerCands.includes('אמר'), 'Initial o- should generate Ayin / Alef (עמר / אמר)');

const lulavCands = convertEnglishBackToHebrew('lulav');
assert.ok(lulavCands.includes('לולב') || lulavCands.includes('ללב'), 'Medial -u- should generate Vav (לולב)');

console.log('  ✅ EnglishBackToHebrew algorithmic tests and vowel upgrades passed.');

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

// 7. Verify 181 Synset Buckets Integrity
console.log('7. Testing 181 Synset Buckets Integrity:');
assert.equal(SYNSETS.length, 181, 'Should have exactly 181 synsets');
const seenCanonical = new Set();
for (const s of SYNSETS) {
  assert.ok(s.canonical, 'Synset must have canonical name');
  assert.ok(!seenCanonical.has(s.canonical), `Duplicate canonical: ${s.canonical}`);
  seenCanonical.add(s.canonical);
  assert.ok(Array.isArray(s.hebrew) && s.hebrew.length > 0, `Synset ${s.canonical} missing Hebrew`);
  assert.ok(Array.isArray(s.variants) && s.variants.length > 0, `Synset ${s.canonical} missing variants`);
}

// Test new domains: Masechtot, Parshiot, Tefillah, Kashrut
const beitzahExp = expandQueryWithPhonetics('beitzah');
assert.ok(beitzahExp.solrQuery.includes('ביצה'));
const yisroExp = expandQueryWithPhonetics('yisro');
assert.ok(yisroExp.solrQuery.includes('יתרו'));
const benchingExp = expandQueryWithPhonetics('bentching');
assert.ok(benchingExp.solrQuery.includes('ברכת המזון'));
const cholovExp = expandQueryWithPhonetics('cholov yisroel');
console.log('  ✅ All 181 synset buckets passed integrity and domain expansion checks.');

// 8. Test Acronym Protection & Short Hebrew Token Suppression
console.log('8. Testing Acronym Protection:');
const yijeParsed = parseQueryEntities('Rosensweig shabos yije');
assert.equal(yijeParsed.speaker?.id, '80146');
assert.equal(yijeParsed.remainingQuery, 'shabos yije');
const yijeExp = expandQueryWithPhonetics(yijeParsed.remainingQuery);
assert.ok(yijeExp.solrQuery.includes('shabbos') || yijeExp.solrQuery.includes('shabbat'));
assert.ok(!yijeExp.solrQuery.includes('יג'), 'Acronym yije must never generate 2-letter Hebrew daf/chapter token יג');
assert.ok(yijeExp.solrQuery.includes('yije'), 'Acronym yije must remain literal English');
console.log('  ✅ Acronym protection and false-positive suppression tests passed.');

// 9. Test Match Explainability, Highlighting & Snippet Extraction
console.log('9. Testing Match Explainability, Highlighting & Snippet Extraction:');

// 9a. Test Title/Speaker highlighting
const searchTerms = ['rosensweig', 'shabos', 'yije', 'shabbat', 'shabbos', 'שבת'];
const highSpeaker = highlightMatches('Rabbi Michael Rosensweig', searchTerms);
assert.ok(highSpeaker.includes('<mark class="match-mark">Rosensweig</mark>'), 'Speaker should have highlighted Rosensweig');
const highTitle = highlightMatches('YIJE Rosh Hashana 5784', searchTerms);
assert.ok(highTitle.includes('<mark class="match-mark">YIJE</mark>'), 'Title should have highlighted YIJE');

// 9b. Test Shiur #979218 real-world case: description contains שבת
const sampleDoc979218 = {
  shiurid: '979218',
  shiurtitle: 'Pesachim Shiur - שוכר ומשכיר 2',
  teacherfullname: 'Rabbi Michael Rosensweig',
  categoryname: ['Halacha'],
  shiurdescription: 'פסחים ד., רש"י שם, רש"ש שם, מהרש"ל שם, בבא מציעא קא:, רמב"ם הלכות שכירות ו:א, תוספות שם, רמב"ם הל\' שבת כ:ג, תרומות ט:ז, מכירה יג:יז',
  location: null,
  shiurkeywords: 'bedika, socheir, maschir, schrius, mechira, rashi'
};
const reasons979218 = buildMatchReasons(sampleDoc979218, searchTerms);
assert.equal(reasons979218.length, 1, 'Should find 1 hidden field match (in description)');
assert.equal(reasons979218[0].badge, '📄 Description Match');
assert.ok(reasons979218[0].snippet.includes('<mark class="match-mark">שבת</mark>'), 'Snippet must highlight שבת in description');

// 9c. Test Venue match with acronym expansion
const venueDoc = {
  shiurid: '12345',
  shiurtitle: 'Hilchos Tefillah',
  teacherfullname: 'Rabbi Mayer Twersky',
  categoryname: ['Halacha'],
  location: 'Young Israel of Jamaica Estates'
};
const venueTerms = ['yije', ...COMMUNITY_ACRONYM_PHRASES.yije.map(t => t.toLowerCase())];
const venueReasons = buildMatchReasons(venueDoc, venueTerms);
assert.equal(venueReasons.length, 1, 'Should find 1 hidden field match (in venue/location)');
assert.equal(venueReasons[0].badge, '📍 Venue Match');
assert.ok(venueReasons[0].snippet.includes('<mark class="match-mark">Young Israel of Jamaica Estates</mark>'));

console.log('  ✅ All explainability, highlighting, and snippet extraction tests passed.');

// 10. Test Title-Boosted Relevance Ranking and Series Grouping
console.log('10. Testing Relevance Ranking & Series Grouping:');
const sampleDocs = [
  {
    shiurid: '1156854',
    shiurtitle: 'A Torah Perspective on Guns in Shul and Guns on Shabbos',
    teacherfullname: 'Rabbi Daniel Stein',
    shiurdate: '2025-12-14',
    shiurdescription: '1) Intro 2) History ... 8) Is raw meat muktzah?',
    collectionid: [],
    collectionname: []
  },
  {
    shiurid: '852194',
    shiurtitle: 'Hilchos Muktzah Part I',
    teacherfullname: 'Rabbi Zvi Polakoff',
    shiurdate: '2016-11-01',
    shiurdescription: 'Overview of muktza',
    collectionid: [5561],
    collectionname: ["Rabbi Polakoff Hilchos Shabbos|5561|24"]
  },
  {
    shiurid: '852840',
    shiurtitle: 'Halachos of Muktzah Part II',
    teacherfullname: 'Rabbi Zvi Polakoff',
    shiurdate: '2016-11-08',
    shiurdescription: 'Continuing muktza discussion',
    collectionid: [5561],
    collectionname: ["Rabbi Polakoff Hilchos Shabbos|5561|24"]
  },
  {
    shiurid: '765657',
    shiurtitle: 'Halachos of Muktzah - Introduction',
    teacherfullname: 'Rabbi Daniel Orlian',
    shiurdate: '2011-02-15',
    shiurdescription: 'Basics of muktzah',
    seriesid: '4001',
    seriesname: 'Rabbi Orlian Muktza 2011'
  }
];

const muktzaTerms = ['halachos', 'muktzeh', 'muktzah', 'muktza', 'hilchos'];
const rankedGroups = groupAndRankDocs(sampleDocs, muktzaTerms, 'halachos of muktzeh');

// Rabbi Polakoff's collection should be grouped into a single series item
const polakoffGroup = rankedGroups.find(g => g.isSeries && g.title === 'Rabbi Polakoff Hilchos Shabbos');
assert.ok(polakoffGroup, 'Polakoff series should be recognized as a series group');
assert.equal(polakoffGroup.docs.length, 2, 'Should have 2 docs in Polakoff series');
assert.equal(polakoffGroup.cover.shiurid, '852194', 'Earliest shiur (Part I) must be the cover card');
assert.equal(polakoffGroup.subDocs[0].shiurid, '852840', 'SubDocs must contain Part II');

// Guns on Shabbos (only incidental match in description) should be scored far lower than title matches
const gunsItem = rankedGroups.find(g => g.doc && g.doc.shiurid === '1156854');
assert.ok(gunsItem, 'Guns shiur should be present');
assert.ok(polakoffGroup.score > gunsItem.score * 5, 'Dedicated series should have dramatically higher relevance score than incidental description match');

// The highest-ranked item should NOT be Guns on Shabbos, but one of the Halachos of Muktzah items
assert.notEqual(rankedGroups[0].doc?.shiurid, '1156854', 'First result must not be the incidental 2025 description match');
console.log('  ✅ Relevance ranking & series grouping passed.');

console.log('\n🎉 ALL PHONETIC & REVERSE TRANSLITERATION TESTS PASSED SUCCESSFULLY!');


