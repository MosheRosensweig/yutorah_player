/**
 * YUTorah Reverse Transliteration & Phonetic Equivalence Engine
 *
 * Implements a 3-tier normalization system:
 * 1. Tier 1: Synset Dictionary for high-frequency Halachic and Moadim terms.
 * 2. Tier 2: Consonantal Skeleton & Phonetic Equivalence (Ashkenazic Tav /s/ vs Sephardic /t/, degemination, digraphs).
 * 3. Tier 3: Speaker Honorific Stripping & Matching.
 */

// 1. Curated Synsets (Bidirectional Concept Equivalence)
export const SYNSETS = [
  {
    canonical: 'shabbat',
    hebrew: ['שבת'],
    variants: ['shabbat', 'shabbos', 'shabos', 'shabbis', 'shabot', 'chabbos']
  },
  {
    canonical: 'sukkah',
    hebrew: ['סוכה', 'סוכות'],
    variants: ['sukkah', 'sukka', 'succah', 'succa', 'succos', 'sukkot', 'sukkos']
  },
  {
    canonical: 'chanukah',
    hebrew: ['חנוכה'],
    variants: ['chanukah', 'hanukkah', 'channukah', 'channuka', 'chanuka', 'hanukah', 'hannukah']
  },
  {
    canonical: 'teshuvah',
    hebrew: ['תשובה'],
    variants: ['teshuvah', 'teshuva', 'tshuvah', 'tshuva', 'tshuvoh', 'teshuvot']
  },
  {
    canonical: 'pesach',
    hebrew: ['פסח'],
    variants: ['pesach', 'passover', 'pesah', 'pesakh']
  },
  {
    canonical: 'muktzah',
    hebrew: ['מוקצה'],
    variants: ['muktzah', 'muktza', 'muktzeh', 'muktze', 'mukzah']
  },
  {
    canonical: 'kashrus',
    hebrew: ['כשרות'],
    variants: ['kashrus', 'kashrut', 'kashruth', 'kosher']
  },
  {
    canonical: 'tefillah',
    hebrew: ['תפילה', 'תפילות'],
    variants: ['tefillah', 'tefilah', 'tefillos', 'tefillot', 'tefilot', 'tefila']
  },
  {
    canonical: 'brachos',
    hebrew: ['ברכות', 'ברכה'],
    variants: ['brachos', 'berakhot', 'berachot', 'brachot', 'beracha', 'bracha', 'brochos', 'brocha']
  },
  {
    canonical: 'motzoei',
    hebrew: ['מוצאי'],
    variants: ['motzoei', 'motzei', 'motsai', 'motzaei', 'motza']
  },
  {
    canonical: 'rosh hashanah',
    hebrew: ['ראש השנה'],
    variants: ['rosh hashanah', 'rosh hashana', 'rosh hashonoh', 'rosh hashono']
  },
  {
    canonical: 'yom kippur',
    hebrew: ['יום כיפור', 'יום הכיפורים'],
    variants: ['yom kippur', 'yom kipur', 'yom hakippurim', 'yom kippurim']
  },
  {
    canonical: 'shemittah',
    hebrew: ['שמיטה'],
    variants: ['shemittah', 'shemita', 'shmita', 'shmittah']
  },
  {
    canonical: 'chagigah',
    hebrew: ['חגיגה'],
    variants: ['chagigah', 'chagiga', 'hagigah', 'hagiga']
  },
  {
    canonical: 'kiddushin',
    hebrew: ['קידושין'],
    variants: ['kiddushin', 'kidushin', 'kedushin']
  },
  {
    canonical: 'sanhedrin',
    hebrew: ['סנהדרין'],
    variants: ['sanhedrin', 'sanhedryn']
  },
  {
    canonical: 'bava kamma',
    hebrew: ['בבא קמא'],
    variants: ['bava kamma', 'bava kama', 'bavam kamma', 'bk']
  },
  {
    canonical: 'bava metzia',
    hebrew: ['בבא מציעא'],
    variants: ['bava metzia', 'bava metziah', 'bava mezia', 'bm']
  },
  {
    canonical: 'bava basra',
    hebrew: ['בבא בתרא'],
    variants: ['bava basra', 'bava batra', 'bb']
  },
  {
    canonical: 'megillah',
    hebrew: ['מגילה'],
    variants: ['megillah', 'megila', 'megilat esther', 'megillat esther']
  },
  {
    canonical: 'purim',
    hebrew: ['פורים'],
    variants: ['purim', 'pooreem']
  },
  {
    canonical: 'shavuos',
    hebrew: ['שבועות'],
    variants: ['shavuos', 'shavuot', 'shavuoth']
  },
  {
    canonical: 'tzitzis',
    hebrew: ['ציצית'],
    variants: ['tzitzis', 'tzitzit', 'zizit', 'tsitsit']
  },
  {
    canonical: 'tefillin',
    hebrew: ['תפילין'],
    variants: ['tefillin', 'tefilin', 'tfillin']
  },
  {
    canonical: 'challah',
    hebrew: ['חלה'],
    variants: ['challah', 'challa', 'halla', 'hallah']
  },
  {
    canonical: 'eruv',
    hebrew: ['עירוב', 'עירובין'],
    variants: ['eruv', 'eiruv', 'eruvin', 'eiruvin']
  },
  {
    canonical: 'mikvah',
    hebrew: ['מקוה', 'מקווה'],
    variants: ['mikvah', 'mikveh', 'mikva', 'mikve']
  },
  {
    canonical: 'mezuzah',
    hebrew: ['מזוזה', 'מזוזות'],
    variants: ['mezuzah', 'mezuza', 'mezuzot', 'mezuzos']
  },
  {
    canonical: 'selichos',
    hebrew: ['סליחות', 'סליחה'],
    variants: ['selichos', 'selichot', 'slichos', 'slichot', 'selichot']
  },
  {
    canonical: 'simchas torah',
    hebrew: ['שמחת תורה'],
    variants: ['simchas torah', 'simchat torah', 'simchas tora']
  },
  {
    canonical: 'hoshana rabba',
    hebrew: ['הושענא רבה'],
    variants: ['hoshana rabba', 'hoshana rabbah', 'hoshana raba']
  },
  {
    canonical: 'tisha bav',
    hebrew: ['תשעה באב'],
    variants: ['tisha bav', 'tisha b\'av', 'tishah bav', 'tishah b\'av', '9 av', '9th of av']
  },
  {
    canonical: 'chometz',
    hebrew: ['חמץ'],
    variants: ['chometz', 'chametz', 'chameitz', 'hometz', 'hametz']
  },
  {
    canonical: 'matzah',
    hebrew: ['מצה', 'מצות'],
    variants: ['matzah', 'matza', 'matzot', 'matzos', 'matzoh']
  },
  {
    canonical: 'seder',
    hebrew: ['סדר'],
    variants: ['seder', 'pesach seder', 'passover seder']
  },
  {
    canonical: 'shofar',
    hebrew: ['שופר'],
    variants: ['shofar', 'shofros', 'shofrot']
  },
  {
    canonical: 'lulav',
    hebrew: ['לולב'],
    variants: ['lulav', 'lulav and etrog', 'arba minim', 'daled minim']
  },
  {
    canonical: 'esrog',
    hebrew: ['אתרוג'],
    variants: ['esrog', 'etrog', 'esrogim', 'etrogim']
  },
  {
    canonical: 'mussar',
    hebrew: ['מוסר'],
    variants: ['mussar', 'musar']
  },
  {
    canonical: 'chassidus',
    hebrew: ['חסידות'],
    variants: ['chassidus', 'chassidut', 'chasidus', 'hasidism', 'chasidut']
  },
  {
    canonical: 'nidah',
    hebrew: ['נדה', 'נידה'],
    variants: ['nidah', 'niddah', 'nida', 'taharat hamishpacha', 'taharas hamishpacha']
  },
  {
    canonical: 'berit milah',
    hebrew: ['ברית מילה', 'ברית'],
    variants: ['brit milah', 'bris milah', 'bris', 'brit']
  },
  {
    canonical: 'kaddish',
    hebrew: ['קדיש'],
    variants: ['kaddish', 'kadish']
  },
  {
    canonical: 'kedushah',
    hebrew: ['קדושה'],
    variants: ['kedushah', 'kedusha']
  },
  {
    canonical: 'kiddush',
    hebrew: ['קידוש'],
    variants: ['kiddush', 'kidush']
  },
  {
    canonical: 'havdalah',
    hebrew: ['הבדלה'],
    variants: ['havdalah', 'havdala', 'havdallah']
  },
  {
    canonical: 'parsha',
    hebrew: ['פרשה', 'פרשת השבוע'],
    variants: ['parsha', 'parshah', 'parashah', 'parashat hashavua', 'parshas hashavua']
  },
  {
    canonical: 'haftarah',
    hebrew: ['הפטרה'],
    variants: ['haftarah', 'haftara', 'haftorah']
  },
  {
    canonical: 'chullin',
    hebrew: ['חולין'],
    variants: ['chullin', 'chulin', 'hullin']
  },
  {
    canonical: 'pesachim',
    hebrew: ['פסחים'],
    variants: ['pesachim', 'psachim']
  },
  {
    canonical: 'berachot',
    hebrew: ['ברכות'],
    variants: ['berachot', 'brachot', 'berakhot', 'brochos']
  },
  {
    canonical: 'ketubot',
    hebrew: ['כתובות'],
    variants: ['ketubot', 'kesuvos', 'ketuvot', 'kesubos']
  },
  {
    canonical: 'yevamot',
    hebrew: ['יבמות'],
    variants: ['yevamot', 'yevamos']
  },
  {
    canonical: 'gittin',
    hebrew: ['גיטין'],
    variants: ['gittin', 'gitin']
  },
  {
    canonical: 'sotah',
    hebrew: ['סוטה'],
    variants: ['sotah', 'sota']
  },
  {
    canonical: 'nazir',
    hebrew: ['נזיר'],
    variants: ['nazir']
  },
  {
    canonical: 'nedarim',
    hebrew: ['נדרים'],
    variants: ['nedarim']
  },
  {
    canonical: 'menachot',
    hebrew: ['מנחות'],
    variants: ['menachot', 'menachos']
  },
  {
    canonical: 'zevachim',
    hebrew: ['זבחים'],
    variants: ['zevachim', 'zvachim']
  },
  {
    canonical: 'taharot',
    hebrew: ['טהרות'],
    variants: ['taharot', 'taharos', 'tohorot', 'tohoros']
  },
  {
    canonical: 'keilim',
    hebrew: ['כלים'],
    variants: ['keilim', 'kelim']
  },
  {
    canonical: 'negaim',
    hebrew: ['נגעים'],
    variants: ['negaim', 'negayim']
  }
];

// Quick synset lookup map: variant -> synset
const SYNSET_LOOKUP = new Map();
for (const synset of SYNSETS) {
  for (const v of synset.variants) {
    SYNSET_LOOKUP.set(v.toLowerCase(), synset);
  }
  for (const h of synset.hebrew) {
    SYNSET_LOOKUP.set(h, synset);
  }
}

// 2. Speaker Honorifics & Clean Matching
const HONORIFIC_REGEX = /^(rabbi|rav|dr\.?|doctor|morah|mrs\.?|ms\.?|miss|rebbetzin|rebbitzen|r'|r\.|harav|maran|dayan)\s+/i;
const MULTI_TITLE_REGEX = /^(rabbi\s+dr\.?|rav\s+dr\.?|harav\s+hagaon|harav)\s+/i;

export function stripSpeakerHonorifics(speakerName) {
  if (!speakerName) return '';
  let cleaned = speakerName.trim();
  // Strip compound titles first (e.g. "Rabbi Dr.")
  cleaned = cleaned.replace(MULTI_TITLE_REGEX, '').trim();
  // Strip single titles
  cleaned = cleaned.replace(HONORIFIC_REGEX, '').trim();
  return cleaned;
}

// Known Top Speakers Directory for Quick Resolving
export const KNOWN_SPEAKERS = [
  { id: '80153', name: 'Rabbi Hershel Schachter', aliases: ['hershel schachter', 'schachter'] },
  { id: '80146', name: 'Rabbi Michael Rosensweig', aliases: ['michael rosensweig', 'rosensweig'] },
  { id: '80198', name: 'Rabbi Mayer E. Twersky', aliases: ['mayer twersky', 'twersky', 'mayer e twersky'] },
  { id: '80714', name: 'Rabbi Aryeh Lebowitz', aliases: ['aryeh lebowitz', 'lebowitz'] },
  { id: '80124', name: 'Rabbi Yaakov B. Neuburger', aliases: ['yaakov neuburger', 'neuburger', 'yaakov b neuburger'] },
  { id: '80307', name: 'Rabbi Moshe Taragin', aliases: ['moshe taragin', 'taragin'] },
  { id: '80215', name: 'Rabbi Mordechai I. Willig', aliases: ['mordechai willig', 'willig', 'mordechai i willig'] },
  { id: '80056', name: 'Rabbi Daniel Z. Feldman', aliases: ['daniel feldman', 'daniel z feldman', 'feldman'] },
  { id: '80236', name: 'Rabbi Menachem Penner', aliases: ['menachem penner', 'penner'] },
  { id: '80214', name: 'Rabbi Jeremy Wieder', aliases: ['jeremy wieder', 'wieder'] },
  { id: '82537', name: 'Mrs. Michal Horowitz', aliases: ['michal horowitz', 'horowitz'] },
  { id: '83175', name: 'Mrs. Emma Katz', aliases: ['emma katz'] },
  { id: '80346', name: 'Rabbi Ally Ehrman', aliases: ['ally ehrman', 'ehrman'] },
  { id: '80182', name: 'Rabbi Zvi Sobolofsky', aliases: ['zvi sobolofsky', 'sobolofsky'] },
  { id: '80179', name: 'Rabbi Baruch Simon', aliases: ['baruch simon', 'simon'] }
];

export function resolveSpeaker(query) {
  if (!query) return null;
  const clean = stripSpeakerHonorifics(query).toLowerCase().trim();
  for (const s of KNOWN_SPEAKERS) {
    if (s.name.toLowerCase() === clean) return s;
    if (s.aliases.some(a => clean === a)) {
      return s;
    }
  }
  return null;
}

/**
 * Parses a query to see if part of it is a recognized speaker and the rest is topic keywords.
 * Example: "Rosensweig Shabbos" -> { speaker: Rabbi Michael Rosensweig (80146), remainingQuery: "Shabbos" }
 * Example: "shabbos" -> { speaker: null, remainingQuery: "shabbos" }
 */
export function parseQueryEntities(rawQuery) {
  if (!rawQuery) return { speaker: null, remainingQuery: '' };
  const trimmed = rawQuery.trim();

  // Try exact speaker resolution on full query first
  const fullSpeaker = resolveSpeaker(trimmed);
  if (fullSpeaker) {
    return { speaker: fullSpeaker, remainingQuery: '' };
  }

  // Check multi-word split
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) {
    return { speaker: null, remainingQuery: trimmed };
  }

  // 1. Try first 3 words: e.g. "Rabbi Hershel Schachter Yom Kippur", "Rabbi Dr. Michael Rosensweig Shabbos"
  if (words.length >= 3) {
    const firstThree = words.slice(0, 3).join(' ');
    const spk3 = resolveSpeaker(firstThree);
    if (spk3) {
      return { speaker: spk3, remainingQuery: words.slice(3).join(' ') };
    }
  }

  // 2. Try first 2 words: e.g. "Michael Rosensweig Shabbos", "Rav Schachter Sukkot"
  if (words.length >= 2) {
    const firstTwo = words.slice(0, 2).join(' ');
    const spk2 = resolveSpeaker(firstTwo);
    if (spk2) {
      return { speaker: spk2, remainingQuery: words.slice(2).join(' ') };
    }
  }

  // 3. Try first word: e.g. "Rosensweig Shabbos"
  const firstOne = words[0];
  const spk1 = resolveSpeaker(firstOne);
  if (spk1) {
    return { speaker: spk1, remainingQuery: words.slice(1).join(' ') };
  }

  // 4. Try last 3 words: e.g. "Yom Kippur Rabbi Hershel Schachter"
  if (words.length >= 3) {
    const lastThree = words.slice(-3).join(' ');
    const spkLast3 = resolveSpeaker(lastThree);
    if (spkLast3) {
      return { speaker: spkLast3, remainingQuery: words.slice(0, -3).join(' ') };
    }
  }

  // 5. Try last 2 words: e.g. "Shabbos Michael Rosensweig"
  if (words.length >= 2) {
    const lastTwo = words.slice(-2).join(' ');
    const spkLast2 = resolveSpeaker(lastTwo);
    if (spkLast2) {
      return { speaker: spkLast2, remainingQuery: words.slice(0, -2).join(' ') };
    }
  }

  // 6. Try last word: e.g. "Shabbos Rosensweig"
  const lastOne = words[words.length - 1];
  const spkLast1 = resolveSpeaker(lastOne);
  if (spkLast1) {
    return { speaker: spkLast1, remainingQuery: words.slice(0, -1).join(' ') };
  }

  return { speaker: null, remainingQuery: trimmed };
}

// 3. Phonetic Skeleton & Ashkenazic/Sephardic Rules
export function getPhoneticSkeleton(word) {
  if (!word) return '';
  let s = word.toLowerCase().trim();

  // Strip terminal silent 'h' (e.g. sukkah -> sukka, torah -> tora, halacha -> halacha)
  s = s.replace(/ah$/, 'a');
  s = s.replace(/eh$/, 'e');

  // Replace German/Yiddish trigraphs/digraphs
  s = s.replace(/sch/g, 'sh');
  s = s.replace(/kh/g, 'ch');
  s = s.replace(/c(?=[eiy])/g, 's'); // soft c
  s = s.replace(/c/g, 'k');          // hard c (succah -> sukkah)
  s = s.replace(/ph/g, 'f');
  s = s.replace(/tz|ts/g, 'z');

  // Terminal Tav: Ashkenazic -os, -as, -is, -es -> -at
  s = s.replace(/(os|as|is|es)$/, 'at');

  // Degeminate identical consecutive consonants (bb -> b, tt -> t, kk -> k, etc.)
  s = s.replace(/([b-df-hj-np-tv-z])\1+/g, '$1');

  return s;
}

// 3b. Common secular English words and stop words that should not be algorithmically transliterated to Hebrew
export const COMMON_ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'into', 'over', 'after',
  'quantum', 'mechanics', 'science', 'history', 'philosophy', 'physics', 'mathematics',
  'computer', 'university', 'college', 'medical', 'ethics', 'law', 'legal', 'business',
  'economics', 'politics', 'society', 'community', 'family', 'children', 'parenting',
  'education', 'school', 'music', 'art', 'literature', 'modern', 'ancient', 'world',
  'america', 'israel', 'jerusalem', 'york', 'london', 'spring', 'summer', 'autumn', 'winter'
]);

// 4. Java EnglishBackToHebrew Algorithm Port & Enhancements
// Ported from /recommender-system/src/main/java/EnglishBackToHebrew.java
// Original Author: mosherosensweig (7/3/18)
// Modernized for JavaScript / Cloudflare Workers Edge execution with combinatorial pruning

export const DIGRAPH_CONSONANT_MAP = {
  ' ': ['_'],
  'a': ['#'],
  'b': ['ב'],
  'c': ['כ'],
  'd': ['ד'],
  'e': ['#'],
  'f': ['פ'],
  'g': ['ג'],
  'h': ['ה'],
  'i': ['#'],
  'j': ['ג'],
  'k': ['כ', 'ק'],
  'l': ['ל'],
  'm': ['מ'],
  'n': ['נ'],
  'o': ['#'],
  'p': ['פ'],
  'q': ['ק'],
  'r': ['ר'],
  's': ['ס', 'ש', 'ת'],
  't': ['ט', 'ת'],
  'u': ['#'],
  'v': ['ב', 'ו'],
  'w': ['ו'],
  'x': ['כ', 'ס'],
  'y': ['י'],
  'z': ['ז', 'צ'],
  // Digraphs & Geminate Consonants
  'bb': ['ב'],
  'cc': ['כ'],
  'ch': ['ח', 'כ'],
  'ck': ['ק'],
  'dd': ['ד'],
  'ff': ['פ'],
  'gg': ['ג'],
  'kh': ['ח'],
  'kk': ['ק', 'כ'],
  'll': ['ל'],
  'mm': ['מ'],
  'nn': ['נ'],
  'ph': ['פ'],
  'pp': ['פ'],
  'rr': ['ר'],
  'ss': ['ס', 'ש', 'ת'],
  'sh': ['ש'],
  'th': ['ת'],
  'ts': ['צ'],
  'tt': ['ט', 'ת'],
  'tz': ['צ']
};

export const SUFFIX_MAP = {
  'a': ['ה', '#'],
  'ah': ['ה'],
  'eh': ['ה'],
  'ei': ['י'],
  'ai': ['י'],
  'ay': ['י'],
  'os': ['ות', 'ת'],
  'ot': ['ות', 'ת'],
  'is': ['ית', 'ת'],
  'im': ['ים']
};

// Final letter normalization (Sofit)
export function applyHebrewFinalLetters(word) {
  if (!word || word.length === 0) return '';
  const lastChar = word[word.length - 1];
  const stem = word.slice(0, -1);
  switch (lastChar) {
    case 'כ': return stem + 'ך';
    case 'מ': return stem + 'ם';
    case 'נ': return stem + 'ן';
    case 'פ': return stem + 'ף';
    case 'צ': return stem + 'ץ';
    default: return word;
  }
}

/**
 * Port of EnglishBackToHebrew.convertBackToHebrewAccountForSuffixs
 * Recursively parses English transliterations into candidate Hebrew spellings.
 * Enhanced with combinatorial pruning to prevent exponential blowup on long words.
 *
 * @param {string} rawWord Input transliterated English word (e.g. 'shabbat', 'succah', 'motsai')
 * @param {number} maxResults Maximum candidate permutations to return (default: 16)
 * @returns {string[]} Clean Hebrew candidate strings with '#' stripped and final letters resolved.
 */
export function convertEnglishBackToHebrew(rawWord, maxResults = 16) {
  if (!rawWord) return [];
  const str = rawWord.toLowerCase().replace(/[^a-z]/g, '');
  if (!str) return [];

  const permutations = [];

  function recurse(begin, currentHebrew) {
    if (permutations.length >= maxResults * 3) return; // Combinatorial pruning guard

    if (begin === str.length) {
      // Remove placeholder '#' and double hashes
      const clean = currentHebrew.replace(/#+/g, '');
      if (clean.length > 0) {
        const withSofit = applyHebrewFinalLetters(clean);
        if (!permutations.includes(withSofit)) {
          permutations.push(withSofit);
        }
      }
      return;
    }

    const remainingLen = str.length - begin;

    // Check 2-character digraph / suffix branch
    if (remainingLen >= 2) {
      const twoChar = str.substring(begin, begin + 2);
      if (remainingLen === 2 && SUFFIX_MAP[twoChar]) {
        for (const ch of SUFFIX_MAP[twoChar]) {
          recurse(begin + 2, currentHebrew + (ch === '#' ? '' : ch));
        }
      } else if (DIGRAPH_CONSONANT_MAP[twoChar]) {
        for (const ch of DIGRAPH_CONSONANT_MAP[twoChar]) {
          recurse(begin + 2, currentHebrew + (ch === '#' ? '' : ch));
        }
      }
    }

    // Single character branch
    const oneChar = str.substring(begin, begin + 1);
    if (remainingLen === 1 && SUFFIX_MAP[oneChar]) {
      for (const ch of SUFFIX_MAP[oneChar]) {
        recurse(begin + 1, currentHebrew + (ch === '#' ? '' : ch));
      }
    } else if (DIGRAPH_CONSONANT_MAP[oneChar]) {
      for (const ch of DIGRAPH_CONSONANT_MAP[oneChar]) {
        recurse(begin + 1, currentHebrew + (ch === '#' ? '' : ch));
      }
    } else {
      recurse(begin + 1, currentHebrew);
    }
  }

  recurse(0, '');
  return permutations.slice(0, maxResults);
}

// 5. Query Expansion for Solr (Integrating Synsets, Phonetic Skeleton & EnglishBackToHebrew)
export function expandQueryWithPhonetics(rawQuery, enableDynamicHebrew = true) {
  if (!rawQuery) {
    return {
      original: '',
      solrQuery: '',
      expandedTokens: [],
      matchedSynset: null,
      hebrewCandidates: []
    };
  }

  const query = rawQuery.trim();
  const lowerQuery = query.toLowerCase();

  // Case A: Full query exactly matches a known synset
  const directSynset = SYNSET_LOOKUP.get(lowerQuery);
  if (directSynset) {
    const dynamicHebrew = enableDynamicHebrew ? convertEnglishBackToHebrew(lowerQuery, 4) : [];
    const allTerms = Array.from(new Set([...directSynset.variants, ...directSynset.hebrew, ...dynamicHebrew]));
    const formatted = allTerms.map(t => t.includes(' ') ? `"${t}"` : t);
    return {
      original: query,
      solrQuery: `(${formatted.join(' OR ')})`,
      expandedTokens: allTerms,
      matchedSynset: directSynset.canonical,
      hebrewCandidates: Array.from(new Set([...directSynset.hebrew, ...dynamicHebrew]))
    };
  }

  // Case B: Multi-word query - check if individual words are synsets or need algorithmic reverse transliteration
  const words = query.split(/\s+/);
  let hasExpansion = false;
  const expandedWordGroups = [];
  const allAliases = [];
  const allHebrewCandidates = [];

  for (const word of words) {
    const cleanWord = word.replace(/^[^\wא-ת]+|[^\wא-ת]+$/g, '').toLowerCase();
    const wordSynset = SYNSET_LOOKUP.get(cleanWord);
    if (wordSynset) {
      hasExpansion = true;
      const dynamicHebrew = enableDynamicHebrew ? convertEnglishBackToHebrew(cleanWord, 4) : [];
      const terms = Array.from(new Set([...wordSynset.variants, ...wordSynset.hebrew, ...dynamicHebrew]));
      const formatted = terms.map(t => t.includes(' ') ? `"${t}"` : t);
      expandedWordGroups.push(`(${formatted.join(' OR ')})`);
      allAliases.push(...terms);
      allHebrewCandidates.push(...wordSynset.hebrew, ...dynamicHebrew);
    } else {
      // Check phonetic skeleton against known synsets
      const skeleton = getPhoneticSkeleton(cleanWord);
      let matchedBySkeleton = null;
      for (const synset of SYNSETS) {
        if (synset.variants.some(v => getPhoneticSkeleton(v) === skeleton)) {
          matchedBySkeleton = synset;
          break;
        }
      }

      if (matchedBySkeleton) {
        hasExpansion = true;
        const dynamicHebrew = enableDynamicHebrew ? convertEnglishBackToHebrew(cleanWord, 4) : [];
        const terms = Array.from(new Set([...matchedBySkeleton.variants, ...matchedBySkeleton.hebrew, ...dynamicHebrew]));
        const formatted = terms.map(t => t.includes(' ') ? `"${t}"` : t);
        expandedWordGroups.push(`(${formatted.join(' OR ')})`);
        allAliases.push(...terms);
        allHebrewCandidates.push(...matchedBySkeleton.hebrew, ...dynamicHebrew);
      } else if (enableDynamicHebrew && cleanWord.length >= 3 && /^[a-z]+$/.test(cleanWord) && !COMMON_ENGLISH_STOPWORDS.has(cleanWord)) {
        // Algorithmic Reverse Transliteration from EnglishBackToHebrew
        const generatedHebrew = convertEnglishBackToHebrew(cleanWord, 4);
        if (generatedHebrew.length > 0) {
          hasExpansion = true;
          const terms = [word, ...generatedHebrew];
          expandedWordGroups.push(`(${terms.join(' OR ')})`);
          allAliases.push(...terms);
          allHebrewCandidates.push(...generatedHebrew);
        } else {
          expandedWordGroups.push(word);
        }
      } else {
        expandedWordGroups.push(word);
      }
    }
  }

  if (hasExpansion) {
    return {
      original: query,
      solrQuery: expandedWordGroups.join(' '),
      expandedTokens: Array.from(new Set(allAliases)),
      matchedSynset: 'multiple',
      hebrewCandidates: Array.from(new Set(allHebrewCandidates))
    };
  }

  // Case C: No synset or transliteration match, return original query intact
  return {
    original: query,
    solrQuery: query,
    expandedTokens: [query],
    matchedSynset: null,
    hebrewCandidates: []
  };
}

