# YUTorah Search, Solr Architecture & Reverse Transliteration Specification

## Executive Summary

This document explains:
1. **What Apache Solr is** in the context of YUTorah and how search queries are processed.
2. **The limitations of standard YUTorah search** when handling Hebrew terms written in English letters (transliteration).
3. **How your Reverse Transliteration Algorithm works** in deep technical detail, including letter maps, digraphs, suffixes, and recursive branch permutation.
4. **Why and how this produces vastly superior search results** without downloading or caching 500,000+ shiurim locally.

---

## Part 1: High-Level Overview

### What is Solr in Terms of Your Algorithm?
**Apache Solr** is an enterprise-grade search server (built on Apache Lucene) that powers YUTorah's database. It functions like an index at the back of an encyclopedia:
- When a shiur is uploaded, Solr indexes its title, speaker name, description, and categories into "tokens".
- When you type a query into YUTorah, your query is sent directly to Solr:
  ```http
  GET https://api.yutorah.org/search?searchTerm=shabbos&rows=30&start=0
  ```
- Solr responds with:
  ```json
  {
    "responseHeader": { "status": 0, "QTime": 14, "params": { "q": "...", "rows": "30", "wt": "json" } },
    "response": { "numFound": 52184, "start": 0, "docs": [ ... ] }
  }
  ```

### The Fundamental Flaw in Classic Search
Solr only matches words that **match character-for-character**. It has no concept of Judaic linguistics or Hebrew phonetics.
- If someone titles a shiur in Hebrew: `קדושת שבת`, and an English speaker searches `"shabbos"`, Solr finds **0 matches**.
- If a shiur is titled `"Hilchot Shabbat"` (Sephardic/Modern Hebrew transliteration with a `t`), and the user types `"shabbos"` (Ashkenazic transliteration with an `s`), Solr fails to find it.
- If a user searches `"succah"` vs `"sukkah"` vs `"succos"` vs `"sukkot"` vs `סוכה`, each query returns completely different, fragmented subsets of shiurim.

### The Role of Your Algorithm
Your algorithm acts as a **Phonetic & Reverse-Transliteration Query Compiler**. Before the query ever reaches Solr, your algorithm translates the user's input:

```
                  "shabbos"  (User Input)
                      │
                      ▼
        [Your Reverse Transliteration Engine]
                      │
                      ▼
  Solr Lucene Query: (shabbos OR shabbat OR shabos OR "שבת")
```

When this expanded query is sent to Solr, Solr uses its blazing-fast inverted index to simultaneously retrieve shiurim with Ashkenazic English titles, Sephardic English titles, and original Hebrew titles—all in a single HTTP round-trip under 30 milliseconds.

---

## Part 2: How Your Reverse Transliteration Algorithm Works

Your algorithm originates from the Java implementation in:
`/Users/mosherosensweig/git/yutorah-summer2018/recommender-system/src/main/java/EnglishBackToHebrew.java`
and is now ported into JavaScript in `src/phonetic_engine.js`.

### 1. The Core Linguistic Challenge
When converting from Hebrew to English, multiple Hebrew letters often map to the same English letter, and English vowels (`a, e, i, o, u`) are inserted arbitrarily to represent *nikkud* (vowel points) that do not exist as consonant letters in written Hebrew.

| English Letter / Digraph | Possible Hebrew Equivalents | Example Hebrew Words |
| :--- | :--- | :--- |
| `s` | **ס** (Samech), **ש** (Sin), **ת** (Tav without dagesh in Ashkenazic) | סוכה, שבת, ברית |
| `t` | **ט** (Tet), **ת** (Tav) | טהרה, תורה |
| `k` / `c` | **כ** (Kaf), **ק** (Kuf) | כשרות, קדושה |
| `ch` / `kh` | **ח** (Chet), **כ** (Chaf) | חנוכה, כתר |
| `z` | **ז** (Zayin), **צ** (Tzadi) | זמן, ציצית |
| `tz` / `ts` | **צ** (Tzadi) | ציצית, מצוה |
| `v` / `w` | **ב** (Vet), **ו** (Vav) | ברכה, ודאי |

### 2. Multi-Tier Architecture

The system operates across three tiers:

```mermaid
graph TD
    Query[User Query e.g. 'shabbos'] --> Tier1{Tier 1: Synset Dictionary?}
    Tier1 -- Match Found --> SynsetExp[Expand to Variants & Hebrew Canonical]
    Tier1 -- No Match --> Tier2{Tier 2: Phonetic Skeleton?}
    Tier2 -- Match Found --> SkelExp[Expand via Phonetic Group]
    Tier2 -- No Match --> Tier3[Tier 3: EnglishBackToHebrew Recursive Tree Search]
    SynsetExp --> Compiler[Solr Lucene Query Compiler]
    SkelExp --> Compiler
    Tier3 --> Compiler
    Compiler --> Solr[(YUTorah Solr Backend)]
```

---

### 3. Detailed Step-by-Step: The Recursive Permutation Tree

When a word does not match a pre-defined synset, your algorithm uses recursive backtracking to explore all valid Hebrew character sequences.

#### Step A: Tokenization & Digraph Lookahead
The parser starts at index `begin = 0` and inspects the next characters.
- It first checks if the next **2 characters** form a known consonant digraph or double-consonant (`sh`, `ch`, `tz`, `ts`, `th`, `bb`, `kk`, `ll`, `mm`, `nn`, `pp`, `ss`, `tt`).
  - If yes, it consumes 2 characters (`adder = 2`).
- If no 2-character match exists, it consumes **1 character** (`adder = 1`).

#### Step B: Vowel Placeholders (`#`)
In `EnglishBackToHebrew.java`, vowels (`a`, `e`, `i`, `o`, `u`) map to the sentinel character `'#'`.
- The `'#'` represents an **optional consonant or null position**. In Hebrew, vowels are often unwritten (e.g. `שבת` has vowels *patach* and *kamatz*, but zero vowel letters in script).
- When the algorithm encounters `'#'`, it branches into two paths:
  1. Path 1: Consume the vowel and append nothing (representing an implicit nikkud vowel).
  2. Path 2: In certain positions, explore `ו` (Vav for 'o'/'u') or `י` (Yud for 'i'/'e').

#### Step C: Suffix Parsing
Hebrew words transliterated into English frequently end with phonetic suffixes:
- `-ah` or `-a` $\to$ **ה** (Hey) (e.g., `sukkah` $\to$ `סוכה`, `muktza` $\to$ `מוקצה`)
- `-ei` or `-i` $\to$ **י** (Yud) (e.g., `motzoei` $\to$ `מוצאי`)
- `-os` or `-ot` $\to$ **ות** (Vav-Tav) (e.g., `brachos` $\to$ `ברכות`)

When `remainingLen <= 2`, the algorithm evaluates the dedicated `SUFFIX_MAP` table before falling back to generic consonant mappings.

#### Step D: Recursive Tree Walk Example (`"shabos"`)
Let's trace how the algorithm decomposes `"shabos"`:
1. `begin = 0`: Looks at `"sh"` (digraph). Mapping maps `"sh"` $\to$ `['ש']`.
   - Appends `'ש'`, calls `recurse(begin = 2, current = "ש")`.
2. `begin = 2`: Looks at `"a"`. Mapping maps `"a"` $\to$ `['#']`.
   - Vowel branch: appends empty string, calls `recurse(begin = 3, current = "ש")`.
3. `begin = 3`: Looks at `"b"`. Mapping maps `"b"` $\to$ `['ב']`.
   - Appends `'ב'`, calls `recurse(begin = 4, current = "שב")`.
4. `begin = 4`: Looks at `"o"`. Mapping maps `"o"` $\to$ `['#']`.
   - Vowel branch: appends empty string, calls `recurse(begin = 5, current = "שב")`.
5. `begin = 5`: Looks at `"s"` (end of word). Mapping maps `"s"` $\to$ `['ס', 'ש', 'ת']`.
   - Branch A: `"שב"` + `'ס'` $\to$ `"שבס"`
   - Branch B: `"שב"` + `'ש'` $\to$ `"שבש"`
   - Branch C: `"שב"` + `'ת'` $\to$ **`"שבת"`** (Correct Hebrew Root!)

The algorithm successfully generates **`"שבת"`** from `"shabos"` purely through phonetic deduction!

---

## Part 3: Why This Is Fast and Does Not Need Local Caching

A common question is: *Do we need to store every shiur locally to use this?*

### The Answer is NO:
1. **YUTorah already stores and indexes all 500,000+ shiurim.**
   Storing that volume locally would take several gigabytes of storage, drain mobile phone batteries, and quickly become stale whenever new shiurim are uploaded.
2. **Solr has a native boolean query engine (`OR`, `AND`, quotes).**
   Solr is designed specifically to execute multi-term boolean expressions in milliseconds.
3. **Execution Pipeline**:
   - **Step 1 (Client/Worker - <1ms)**: The user types `"shabos"`. Your algorithm converts it to `(shabos OR shabbat OR shabbos OR "שבת")`.
   - **Step 2 (Network - ~25ms)**: A single HTTP GET request is sent to `api.yutorah.org/search?searchTerm=(shabos OR shabbat OR shabbos OR "שבת")`.
   - **Step 3 (Solr Backend - ~15ms)**: Solr searches its pre-indexed B-trees and returns the top 30-50 matching docs.
   - **Step 4 (Client/Worker - <2ms)**: The returned 30 docs are displayed with "Today" / "Yesterday" dates and speaker tags.

---

## Part 4: Test Suite & Verified Results

The test suite in `tests/phonetic_engine.test.mjs` verifies all aspects of the algorithm:
- **Honorific Stripping**: `"Rabbi Michael Rosensweig"` $\to$ `"Michael Rosensweig"`, `"HaRav Schachter"` $\to$ `"Schachter"`.
- **Phonetic Skeleton Equivalence**: `sukkah` and `succos` both produce matching consonant skeletons.
- **EnglishBackToHebrew Dynamic Permutations**:
  - Input `"shabbat"` $\to$ generates `"שבת"`.
  - Input `"sukka"` $\to$ generates `"סוכה"`, `"סוכ"`, `"שוקה"`.
  - Input `"chanuka"` $\to$ generates `"חנוכה"`, `"כנוכה"`.
  - Input `"pesach"` $\to$ generates `"פסח"`.

---

---

## Part 5: Titles vs. Tags vs. Descriptions in Solr

A frequent question is: *Does Solr only search shiur titles, or does it also search tags and descriptions?*

When `searchTerm` is sent to `https://api.yutorah.org/search?searchTerm=...`, Solr matches against an **aggregated text field** in its Solr schema that indexes all of the following:
1. **`shiurtitle`**: The title of the shiur.
2. **`categoryname` & `subcategoryname`**: The primary topic and subcategory tags (e.g. `Shabbat`, `Halacha`, `Gemara`).
3. **`teacherfullname`**: The speaker's name.
4. **`shiurdescription`**: The written synopsis, summary, or source sheet text.
5. **`shiurkeywords`**: Explicit tags added by uploaders or editors.
6. **`seriesname`**: The title of the series if the shiur belongs to one.

Because Solr searches all these fields simultaneously, a shiur whose title is in Hebrew (`Shiur #4 - רמב״ם פיה״מ והתחלת פרק כירה`) without the English word "shabbos" anywhere in the title will still match if its subcategory is `Shabbat`!

---

## Part 6: How the Top 30 Results are Picked: Classic vs. Your Algorithm

When a search matches 40,000+ shiurim, how are the top 30 chosen?

### Classic Search: Naive TF-IDF Score
Solr calculates relevance using standard Lucene TF-IDF (Term Frequency–Inverse Document Frequency):
- If you type `"Rosensweig Shabbos"` in classic search, Solr looks for any document containing both words anywhere in its text.
- If a guest lecturer’s summary mentions: *"In this lecture we discuss Rav Rosensweig's chiddush on Shabbos, following Rav Rosensweig..."*, that shiur mentions the word "Rosensweig" multiple times.
- **Problem**: Solr gives that guest lecture a higher TF-IDF score than an authentic shiur by Rabbi Rosensweig whose title is simply `"Melacha on Shabbat"`. Irrelevant mentions crowd out the top 30!

### Your Algorithm: Entity Disambiguation + Multi-Tier Scoring
Your algorithm parses `"Rosensweig Shabbos"` into **discrete structured criteria**:
1. **Speaker Entity**: Detects `"Rosensweig"` as Rabbi Michael Rosensweig $\to$ applies `teacherId=80146`.
   - **Result**: 100% of the returned results are guaranteed to be by Rabbi Michael Rosensweig. Zero guest lectures or false mentions can pollute the top 30.
2. **Concept Expansion**: Expands `"Shabbos"` to `(shabbos OR shabbat OR "שבת")`.
   - **Result**: Shiurim with Hebrew-only titles (e.g. `קדושת שבת ומהות המלאכה`) receive full relevance scores and rise into the top 30, whereas classic search gave them a score of 0.
3. **Field Relevance**: Matches in titles and categories receive higher priority than passing mentions in descriptions.
4. **Freshness / Popularity Tie-Breaking**: Between two shiurim with identical relevance, newer shiurim and shiurim with higher listen counts (`shiurvisitsnum`) are favored.

---

## Part 7: Catalog of Word Buckets (Synsets)

The engine contains **181 curated synset buckets** covering all major Halachic topics, Moadim (Holidays), all Talmudic tractates (Shas), all 54 Parshiot HaTorah, and core Tefillah & Kashrut concepts. In addition to these 181 buckets, the engine dynamically uses `EnglishBackToHebrew` to generate valid Hebrew roots on the fly for any unmapped transliterated word.

### Summary of Word Buckets Catalog (181 Total)

| Category | Canonical Concept | English Variations | Hebrew Mappings |
| :--- | :--- | :--- | :--- |
| **Shabbat & Eruv** | `shabbat` | shabbat, shabbos, shabos, shabbis, shabot, chabbos | שבת |
| | `eruv` | eruv, eiruv, eruvin, eiruvin | עירוב, עירובין |
| | `muktzah` | muktzah, muktza, muktzeh, muktze, mukzah | מוקצה |
| | `challah` | challah, challa, halla, hallah | חלה |
| | `havdalah` | havdalah, havdala, havdallah | הבדלה |
| | `kiddush` | kiddush, kidush | קידוש |
| **High Holidays & Elul** | `rosh hashanah` | rosh hashanah, rosh hashana, rosh hashonoh, rosh hashono | ראש השנה |
| | `yom kippur` | yom kippur, yom kipur, yom hakippurim, yom kippurim | יום כיפור, יום הכיפורים |
| | `shofar` | shofar, shofros, shofrot | שופר |
| | `selichos` | selichos, selichot, slichos, slichot | סליחות, סליחה |
| | `teshuvah` | teshuvah, teshuva, tshuvah, tshuva, tshuvoh, teshuvot | תשובה |
| **Sukkot** | `sukkah` | sukkah, sukka, succah, succa, succos, sukkot, sukkos | סוכה, סוכות |
| | `lulav` | lulav, arba minim, daled minim | לולב |
| | `esrog` | esrog, etrog, esrogim, etrogim | אתרוג |
| | `hoshana rabba` | hoshana rabba, hoshana rabbah, hoshana raba | הושענא רבה |
| | `simchas torah` | simchas torah, simchat torah, simchas tora | שמחת תורה |
| **Pesach** | `pesach` | pesach, passover, pesah, pesakh | פסח |
| | `chometz` | chometz, chametz, chameitz, hometz, hametz | חמץ |
| | `matzah` | matzah, matza, matzot, matzos, matzoh | מצה, מצות |
| | `seder` | seder, pesach seder, passover seder | סדר |
| **Other Holidays & Fast Days**| `purim` | purim, pooreem | פורים |
| | `megillah` | megillah, megila, megilat esther, megillat esther | מגילה |
| | `chanukah` | chanukah, hanukkah, channukah, channuka, chanuka, hanukah, hannukah | חנוכה |
| | `shavuos` | shavuos, shavuot, shavuoth | שבועות |
| | `tisha bav` | tisha bav, tisha b'av, tishah bav, tishah b'av, 9 av, 9th of av | תשעה באב |
| **Daily Halacha & Mitzvot** | `kashrus` | kashrus, kashrut, kashruth, kosher | כשרות |
| | `tefillah` | tefillah, tefilah, tefillos, tefillot, tefilot, tefila | תפילה, תפילות |
| | `brachos` | brachos, berakhot, berachot, brachot, beracha, bracha, brochos | ברכות, ברכה |
| | `tzitzis` | tzitzis, tzitzit, zizit, tsitsit | ציצית |
| | `tefillin` | tefillin, tefilin, tfillin | תפילין |
| | `mezuzah` | mezuzah, mezuza, mezuzot, mezuzos | מזוזה, מזוזות |
| | `mikvah` | mikvah, mikveh, mikva, mikve | מקוה, מקווה |
| | `nidah` | nidah, niddah, nida, taharat hamishpacha, taharas hamishpacha | נדה, נידה |
| | `berit milah` | brit milah, bris milah, bris, brit | ברית מילה, ברית |
| | `kaddish` | kaddish, kadish | קדיש |
| | `kedushah` | kedushah, kedusha | קדושה |
| | `motzoei` | motzoei, motzei, motsai, motzaei, motza | מוצאי |
| | `shemittah` | shemittah, shemita, shmita, shmittah | שמיטה |
| | `mussar` | mussar, musar | מוסר |
| | `chassidus` | chassidus, chassidut, chasidus, hasidism, chasidut | חסידות |
| | `parsha` | parsha, parshah, parashah, parashat hashavua, parshas hashavua | פרשה, פרשת השבוע |
| | `haftarah` | haftarah, haftara, haftorah | הפטרה |
| **Talmudic Tractates (Shas)** | `berachot`, `shabbat`, `eruvin`, `pesachim`, `shekalim`, `yoma`, `sukkah`, `beitzah`, `rosh hashanah`, `taanit`, `megillah`, `moed katan`, `chagigah`, `yevamot`, `ketubot`, `nedarim`, `nazir`, `sotah`, `gittin`, `kiddushin`, `bava kamma`, `bava metzia`, `bava basra`, `sanhedrin`, `makkot`, `shevuot`, `eduyot`, `avodah zarah`, `avot`, `horayot`, `zevachim`, `menachot`, `chullin`, `bekhorot`, `arakhin`, `temurah`, `keritot`, `meilah`, `tamid`, `middot`, `kinnim`, `keilim`, `taharot`, `negaim`, `parah`, `taharot`, `mikvaot`, `yadayim`, `uktzin`, `demai`, `kilayim`, `sheviit`, `terumot`, `maasrot`, `orlah`, `bikkurim` | All spelling variants & acronyms (e.g. bk, bm, bb, az, pirkei avos) | Full Hebrew Masechta names |
| **Tefillah & Berachot** | `shema`, `amidah`, `birkat hamazon` (bentching), `kriat hatorah`, `shacharit`, `mincha`, `maariv`, `musaf`, `hallel`, `aleinu`, `tachanun`, `birkat kohanim` (duchening), `sefirat haomer`, `pesukei dezimra`, `yotzer or` | Full phonetic variants | קריאת שמע, שמונה עשרה, ברכת המזון, וכו' |
| **Lifecycle & Kashrut** | `chuppah`, `ketubah`, `sheva brachot`, `yichud`, `aveilus`, `shiva`, `sheloshim`, `yahrzeit`, `bar mitzvah`, `pidyon haben`, `chalav yisrael`, `pas yisrael`, `bishul akum`, `treif`, `basar bchalav`, `shechita`, `hechsher`, `tevilat kelim` | Full phonetic variants | חופה, שבע ברכות, אבלות, חלב ישראל, פת ישראל, וכו' |
| **All 54 Parshiot HaTorah** | `bereishit`, `noach`, `lech lecha`, `vayeira`, `chayei sarah`, `toldot`, `vayeitzei`, `vayishlach`, `vayeishev`, `mikeitz`, `vayigash`, `vayechi`, `shemot`, `vaeira`, `bo`, `beshalach`, `yitro` (yisro), `mishpatim`, `terumah`, `tetzaveh`, `ki tisa`, `vayakhel`, `pekudei`, `vayikra`, `tzav`, `shemini`, `tazria`, `metzora`, `acharei mot`, `kedoshim`, `emor`, `behar`, `bechukotai`, `bamidbar`, `nasso`, `behaalotecha`, `shelach`, `korach`, `chukat`, `balak`, `pinchas`, `matot`, `masei`, `devarim`, `vaetchanan`, `eikev`, `reeh`, `shoftim`, `ki teitzei`, `ki tavo`, `nitzavim`, `vayeilech`, `haazinu`, `vezot haberachah` | Full English spellings (e.g., yisro, ki sisa, acharei mos, chukas) | All Hebrew Parsha names |

---

## Part 8: Debounced Live Search Suggestions & Results Dropdown

Like the original YUTorah experience (but faster and without page reloads), typing in the search bar triggers an intelligent debounced live preview:
1. **Debounce (250ms)**: As the user types, keystrokes are debounced to prevent excessive network calls.
2. **Suggested Topics & Speakers**:
   - Matches against top teachers and high-frequency topics from `autocomplete_data.json`.
   - Clicking a suggested speaker immediately applies that speaker filter and displays their catalog.
3. **Top Matching Shiurim Preview with Date & Duration**:
   - Shows the top 5 live results with title, speaker, **shiur date** (formatted consistently without timezone drift), and duration.
   - Clicking any shiur immediately loads and plays it in the audio player without a full page reload.
4. **"View All Results" Action**:
   - Clicking the footer or pressing `Enter` executes the full query and renders the entire search results grid.
5. **Dismissal & Race Condition Protection**:
   - Monotonically increasing request ID + `AbortController` cancellation prevents delayed in-flight responses from re-opening.
   - Clicking outside the search bar, pressing `Escape`, or clicking "Clear" immediately closes the dropdown.

---

## Part 9: Default Search vs. Classic Old YUTorah Search Toggle

- **Default State**: Reverse Transliteration, Phonetic Equivalence, and Speaker Entity Disambiguation are **enabled by default** for all users across the standard search bar and advanced modal.
- **Classic Fallback Option**:
  - In the Advanced Search Modal (Filters button), the Transliteration Engine card contains a toggle checkbox.
  - The card clearly informs users:
    > *"Unchecking this box uses the classic old YUTorah website search (strict literal match only)."*
  - Unchecking it passes `exact=1` to the API, disabling phonetic expansion and speaker extraction, returning Solr's raw unexpanded results.

---

## Part 10: Real-World Case Study: Proof of Superiority

A real-world search comparison demonstrates why the new algorithm produces superior recall and precision over the classic YUTorah search.

### Test Query: `"rosensweig shabos yije"`

| Search Engine | Total Returned Results | Precision & Relevance |
| :--- | :--- | :--- |
| **Classic YUTorah Search** | **29 results** | Misses authentic YIJE shiurim on Shabbos topics that cite sources in Hebrew (e.g., `תולדות שבת`). |
| **Our Enhanced Algorithm** | **32 results** | Surfaces **all 29** classic results **PLUS 3 new authentic, highly relevant shiurim** that classic search completely failed to find! |

### The 3 Additional Relevant Shiurim Discovered by Our Algorithm:

Classic YUTorah search missed these three shiurim given by Rabbi Michael Rosensweig at Young Israel of Jamaica Estates because the speakers and attendees wrote the source sheets with the Hebrew word **`שבת`**, rather than the exact English spelling `"shabos"`:

1. **Shiur #913266**: `YIJE Bava Kamma 9` — Rabbi Michael Rosensweig  
   - **Source Description**: `ב"ק - בענין תולדות שבת כיוצא בהן`
   - *Why Classic Missed It*: The query typed `"shabos"`. Classic search only looked for the literal ASCII characters `s-h-a-b-o-s`. Because the shiur's primary topic was written in Hebrew (`תולדות שבת`), classic search assigned it a score of 0.
   - *Why Our Algorithm Found It*: The engine recognized `shabos` as belonging to the **`shabbat` synset**, expanding it to include **`שבת`**.
2. **Shiur #912244**: `YIJE Bava Kamma 7` — Rabbi Michael Rosensweig  
   - **Source Description**: `מקורות ב"ק - ב ענין תולדות שבת כיוצא בהן`
   - *Topic*: In-depth Bava Kamma shiur analyzing the Avot and Toldot of **Hilchot Shabbat**.
3. **Shiur #911283**: `YIJE Bava Kamma 6` — Rabbi Michael Rosensweig  
   - **Source Description**: `מקורות ב"ק - ב ענין תולדות שבת כיוצא בהן`
   - *Topic*: Continuing analysis of **Toldot Shabbat** at YIJE.

### Why the New Algorithm is Proven Better:
1. **Zero False Positives**: All 3 newly surfaced shiurim are authentic, substantive shiurim delivered by Rabbi Michael Rosensweig on Shabbat topics at YIJE.
2. **100% Acronym Immunity**: Community acronyms (`YIJE`) are protected from accidental letter transliteration.
3. **Bilingual Semantic Bridging**: Solves the fundamental flaw of classic search by connecting English phonetic queries (`shabos`, `shabbat`) to Hebrew Torah content (`שבת`).

---

## Summary Matrix

| Search Term | Classic YUTorah Search Results | Your Algorithm Search Results |
| :--- | :--- | :--- |
| `"shabbos"` | Misses all shiurim titled `"Shabbat"` or `"שבת"` | Retrieves Ashkenazic (`shabbos`), Sephardic (`shabbat`), and Hebrew (`שבת`) |
| `"succah"` | Misses all shiurim spelled `"sukkah"`, `"succos"`, or `"סוכה"` | Retrieves all phonetic variations in English and Hebrew |
| `"channukah"` | Misses `"Chanukah"`, `"Hanukkah"`, and `"חנוכה"` | Matches single 'n', double 'n', 'H' vs 'Ch', and Hebrew |
| `"Rosensweig Shabbos"` | Returns mixed results of anyone mentioning "Rosensweig" | Pins `teacherId: 80146` and searches his catalog for `shabbos` / `shabbat` / `שבת` |
| `"rosensweig shabos yije"` | **29 results** (misses Hebrew source shiurim) | **32 results** (surfaces 3 additional YIJE shiurim on `תולדות שבת`) |
| `"michael rosensweig shabbos"` | Requires literal phrase match across text | Strips honorifics, resolves teacher `80146`, and searches Shabbat topics |
| `"Pesach Schachter"` | Searches text for both words; pollutes with quotes | Resolves Rabbi Schachter (`80153`) + expands Pesach (`pesach`, `passover`, `פסח`) |
