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
  const clean = stripSpeakerHonorifics(query).toLowerCase();
  for (const s of KNOWN_SPEAKERS) {
    if (s.name.toLowerCase() === query.toLowerCase()) return s;
    if (s.aliases.some(a => clean === a || clean.includes(a))) {
      return s;
    }
  }
  return null;
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

// 4. Query Expansion for Solr
export function expandQueryWithPhonetics(rawQuery) {
  if (!rawQuery) {
    return {
      original: '',
      solrQuery: '',
      expandedTokens: [],
      matchedSynset: null
    };
  }

  const query = rawQuery.trim();
  const lowerQuery = query.toLowerCase();

  // Case A: Full query exactly matches a known synset
  const directSynset = SYNSET_LOOKUP.get(lowerQuery);
  if (directSynset) {
    const allTerms = Array.from(new Set([...directSynset.variants, ...directSynset.hebrew]));
    const formatted = allTerms.map(t => t.includes(' ') ? `"${t}"` : t);
    return {
      original: query,
      solrQuery: `(${formatted.join(' OR ')})`,
      expandedTokens: allTerms,
      matchedSynset: directSynset.canonical
    };
  }

  // Case B: Multi-word query - check if individual words are synsets
  const words = query.split(/\s+/);
  let hasExpansion = false;
  const expandedWordGroups = [];
  const allAliases = [];

  for (const word of words) {
    const cleanWord = word.replace(/^[^\wא-ת]+|[^\wא-ת]+$/g, '').toLowerCase();
    const wordSynset = SYNSET_LOOKUP.get(cleanWord);
    if (wordSynset) {
      hasExpansion = true;
      const terms = Array.from(new Set([...wordSynset.variants, ...wordSynset.hebrew]));
      const formatted = terms.map(t => t.includes(' ') ? `"${t}"` : t);
      expandedWordGroups.push(`(${formatted.join(' OR ')})`);
      allAliases.push(...terms);
    } else {
      // Check phonetic skeleton
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
        const terms = Array.from(new Set([...matchedBySkeleton.variants, ...matchedBySkeleton.hebrew]));
        const formatted = terms.map(t => t.includes(' ') ? `"${t}"` : t);
        expandedWordGroups.push(`(${formatted.join(' OR ')})`);
        allAliases.push(...terms);
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
      matchedSynset: 'multiple'
    };
  }

  // Case C: No synset match, return original query intact
  return {
    original: query,
    solrQuery: query,
    expandedTokens: [query],
    matchedSynset: null
  };
}
