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
    variants: ['selichos', 'selichot', 'slichos', 'slichot']
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
  },
  {
    canonical: "eruvin",
    hebrew: ["עירובין"],
    variants: ["eruvin","eiruvin"]
  },
  {
    canonical: "shekalim",
    hebrew: ["שקלים"],
    variants: ["shekalim","shkalim"]
  },
  {
    canonical: "yoma",
    hebrew: ["יומא"],
    variants: ["yoma","yomah"]
  },
  {
    canonical: "beitzah",
    hebrew: ["ביצה"],
    variants: ["beitzah","beitza","beitzo","betza","betzah"]
  },
  {
    canonical: "taanit",
    hebrew: ["תענית"],
    variants: ["taanit","taanis","taanith","ta'anit","ta'anis"]
  },
  {
    canonical: "moed katan",
    hebrew: ["מועד קטן"],
    variants: ["moed katan","moed kotan","mo'ed katan","mk"]
  },
  {
    canonical: "horayot",
    hebrew: ["הוריות"],
    variants: ["horayot","horayos","horaiot"]
  },
  {
    canonical: "eduyot",
    hebrew: ["עדויות"],
    variants: ["eduyot","eduyos","eiduyot","eiduyos"]
  },
  {
    canonical: "avot",
    hebrew: ["אבות","פרקי אבות"],
    variants: ["avot","avos","pirkei avot","pirkei avos","pirkay avot"]
  },
  {
    canonical: "shevuot",
    hebrew: ["שבועות"],
    variants: ["shevuot","shevuos","shvuot","shvuos"]
  },
  {
    canonical: "makkot",
    hebrew: ["מכות"],
    variants: ["makkot","makkos","makot","makos"]
  },
  {
    canonical: "avodah zarah",
    hebrew: ["עבודה זרה"],
    variants: ["avodah zarah","avoda zara","avodah zara","az"]
  },
  {
    canonical: "bekhorot",
    hebrew: ["בכורות"],
    variants: ["bechorot","bechoros","bekhorot","bchorot","bchoros"]
  },
  {
    canonical: "arakhin",
    hebrew: ["ערכין"],
    variants: ["arachim","arachin","erchin","erkhin"]
  },
  {
    canonical: "temurah",
    hebrew: ["תמורה"],
    variants: ["temurah","temura","tmurah","tmura"]
  },
  {
    canonical: "keritot",
    hebrew: ["כריתות"],
    variants: ["keritot","kerisos","krisot","krisos","krito"]
  },
  {
    canonical: "meilah",
    hebrew: ["מעילה"],
    variants: ["meilah","meila","me'ilah"]
  },
  {
    canonical: "tamid",
    hebrew: ["תמיד"],
    variants: ["tamid","tameed"]
  },
  {
    canonical: "middot",
    hebrew: ["מידות"],
    variants: ["middot","middos","midot","midos"]
  },
  {
    canonical: "kinnim",
    hebrew: ["קנים"],
    variants: ["kinnim","kinim"]
  },
  {
    canonical: "mikvaot",
    hebrew: ["מקואות","מקוואות"],
    variants: ["mikvaot","mikvaos","mikva'ot"]
  },
  {
    canonical: "yadim",
    hebrew: ["ידיים"],
    variants: ["yadayim","yadaim","yadim"]
  },
  {
    canonical: "uktzin",
    hebrew: ["עוקצין"],
    variants: ["uktzin","uktsin","oktzin"]
  },
  {
    canonical: "parah",
    hebrew: ["פרה","פרה אדומה"],
    variants: ["parah","para","parah adumah","para aduma"]
  },
  {
    canonical: "demai",
    hebrew: ["דמאי"],
    variants: ["demai","dmai"]
  },
  {
    canonical: "kilayim",
    hebrew: ["כלאים"],
    variants: ["kilayim","kilaim","shatnez","shaatnez"]
  },
  {
    canonical: "sheviit",
    hebrew: ["שביעית"],
    variants: ["sheviit","shevi'is","sheviis","shviit","shviis"]
  },
  {
    canonical: "terumot",
    hebrew: ["תרומות"],
    variants: ["terumot","terumos","trumot","trumos"]
  },
  {
    canonical: "maasrot",
    hebrew: ["מעשרות"],
    variants: ["maasrot","maasros","ma'asrot","ma'asros","maaser","ma'aser"]
  },
  {
    canonical: "challah masechet",
    hebrew: ["חלה"],
    variants: ["masachet challah","masechet challah","hilchot challah"]
  },
  {
    canonical: "orlah",
    hebrew: ["ערלה"],
    variants: ["orlah","orla"]
  },
  {
    canonical: "bikkurim",
    hebrew: ["ביכורים"],
    variants: ["bikkurim","bikurim","bichurim"]
  },
  {
    canonical: "shema",
    hebrew: ["קריאת שמע","שמע"],
    variants: ["shema","kriat shema","krias shema","shma"]
  },
  {
    canonical: "amidah",
    hebrew: ["עמידה","שמונה עשרה"],
    variants: ["amidah","amida","shmoneh esreh","shmone esre","shemoneh esreh"]
  },
  {
    canonical: "birkat hamazon",
    hebrew: ["ברכת המזון"],
    variants: ["birkat hamazon","birkas hamazon","bentching","benching","bentshing"]
  },
  {
    canonical: "kriat hatorah",
    hebrew: ["קריאת התורה"],
    variants: ["kriat hatorah","krias hatorah","kriat hatora"]
  },
  {
    canonical: "shacharit",
    hebrew: ["שחרית"],
    variants: ["shacharit","shacharis","shachrit","shachris"]
  },
  {
    canonical: "mincha",
    hebrew: ["מנחה"],
    variants: ["mincha","minchah"]
  },
  {
    canonical: "maariv",
    hebrew: ["מעריב","ערבית"],
    variants: ["maariv","ma'ariv","arvit","arvis"]
  },
  {
    canonical: "musaf",
    hebrew: ["מוסף"],
    variants: ["musaf","mussaf"]
  },
  {
    canonical: "hallel",
    hebrew: ["הלל"],
    variants: ["hallel","halel"]
  },
  {
    canonical: "aleinu",
    hebrew: ["עלינו"],
    variants: ["aleinu","aleynu"]
  },
  {
    canonical: "tachanun",
    hebrew: ["תחנון"],
    variants: ["tachanun","tahanun"]
  },
  {
    canonical: "birkat kohanim",
    hebrew: ["ברכת כהנים","דוכנים"],
    variants: ["birkat kohanim","birkas kohanim","duchening","duchaning","nesiat kapayim"]
  },
  {
    canonical: "sefirat haomer",
    hebrew: ["ספירת העומר"],
    variants: ["sefirat haomer","sfirat haomer","sefiras haomer","sfiras haomer","the omer"]
  },
  {
    canonical: "pesukei dezimra",
    hebrew: ["פסוקי דזמרה"],
    variants: ["pesukei dezimra","psukei dzimra","pesukei d'zimra"]
  },
  {
    canonical: "yotzer or",
    hebrew: ["יוצר אור"],
    variants: ["yotzer or","birkot krias shema","birkot kriat shema"]
  },
  {
    canonical: "chuppah",
    hebrew: ["חופה"],
    variants: ["chuppah","chuppa","chupa","chupah","huppah","hupa"]
  },
  {
    canonical: "ketubah",
    hebrew: ["כתובה"],
    variants: ["ketubah","ketuba","kesubah","kesuba"]
  },
  {
    canonical: "sheva brachot",
    hebrew: ["שבע ברכות"],
    variants: ["sheva brachot","sheva brachos","sheva berachot","sheva berachos"]
  },
  {
    canonical: "yichud",
    hebrew: ["ייחוד","איסור ייחוד"],
    variants: ["yichud","yihud","hilchot yichud"]
  },
  {
    canonical: "aveilus",
    hebrew: ["אבלות","הלכות אבלות"],
    variants: ["aveilus","aveilut","avelus","avelut","mourning"]
  },
  {
    canonical: "shiva",
    hebrew: ["שבעה"],
    variants: ["shiva","shivah"]
  },
  {
    canonical: "sheloshim",
    hebrew: ["שלושים"],
    variants: ["sheloshim","shloshim"]
  },
  {
    canonical: "yahrzeit",
    hebrew: ["יארצייט"],
    variants: ["yahrzeit","yahrtzeit","yartzeit","yarzeit"]
  },
  {
    canonical: "bar mitzvah",
    hebrew: ["בר מצווה","בר מצוה"],
    variants: ["bar mitzvah","bar mitzva","bat mitzvah","bas mitzvah","bat mitzva"]
  },
  {
    canonical: "pidyon haben",
    hebrew: ["פדיון הבן"],
    variants: ["pidyon haben","pidyon haban"]
  },
  {
    canonical: "chalav yisrael",
    hebrew: ["חלב ישראל"],
    variants: ["chalav yisrael","cholov yisroel","chalav yisroel","cholov yisrael","chalav stam"]
  },
  {
    canonical: "pas yisrael",
    hebrew: ["פת ישראל"],
    variants: ["pas yisrael","pas yisroel","pat yisrael","pat yisroel","pas palter"]
  },
  {
    canonical: "bishul akum",
    hebrew: ["בישול עכו\"ם","בישול נכרי"],
    variants: ["bishul akum","bishul nochri","bishul goy"]
  },
  {
    canonical: "treif",
    hebrew: ["טרף","טרפה"],
    variants: ["treif","treifah","tereifah","traif","treifa"]
  },
  {
    canonical: "basar bchalav",
    hebrew: ["בשר בחלב"],
    variants: ["basar b'chalav","basar bchalav","basar bechalav","meat and milk"]
  },
  {
    canonical: "shechita",
    hebrew: ["שחיטה"],
    variants: ["shechita","shechitah","shchita"]
  },
  {
    canonical: "hechsher",
    hebrew: ["הכשר","כשרות"],
    variants: ["hechsher","hechshere","kashrut supervision"]
  },
  {
    canonical: "tevilat kelim",
    hebrew: ["טבילת כלים"],
    variants: ["tevilat kelim","tevilas keilim","tevilat keilim","tvilat kelim"]
  },
  {
    canonical: "bereishit",
    hebrew: ["בראשית","פרשת בראשית"],
    variants: ["bereishit","bereishis","bereshit","bereshis"]
  },
  {
    canonical: "noach",
    hebrew: ["נח","פרשת נח"],
    variants: ["noach","noah"]
  },
  {
    canonical: "lech lecha",
    hebrew: ["לך לך","פרשת לך לך"],
    variants: ["lech lecha","lech l'cha","lech-lecha"]
  },
  {
    canonical: "vayeira",
    hebrew: ["וירא","פרשת וירא"],
    variants: ["vayeira","vayera"]
  },
  {
    canonical: "chayei sarah",
    hebrew: ["חיי שרה","פרשת חיי שרה"],
    variants: ["chayei sarah","chayei sara","chaye sarah"]
  },
  {
    canonical: "toldot",
    hebrew: ["תולדות","פרשת תולדות"],
    variants: ["toldot","toldos"]
  },
  {
    canonical: "vayeitzei",
    hebrew: ["ויצא","פרשת ויצא"],
    variants: ["vayeitzei","vayetzei","vayetze"]
  },
  {
    canonical: "vayishlach",
    hebrew: ["וישלח","פרשת וישלח"],
    variants: ["vayishlach","vayishlah"]
  },
  {
    canonical: "vayeishev",
    hebrew: ["וישב","פרשת וישב"],
    variants: ["vayeishev","vayeshev"]
  },
  {
    canonical: "mikeitz",
    hebrew: ["מקץ","פרשת מקץ"],
    variants: ["mikeitz","miketz"]
  },
  {
    canonical: "vayigash",
    hebrew: ["ויגש","פרשת ויגש"],
    variants: ["vayigash"]
  },
  {
    canonical: "vayechi",
    hebrew: ["ויחי","פרשת ויחי"],
    variants: ["vayechi","vayehi"]
  },
  {
    canonical: "shemot",
    hebrew: ["שמות","פרשת שמות"],
    variants: ["shemot","shemos","shmot","shmos"]
  },
  {
    canonical: "vaeira",
    hebrew: ["וארא","פרשת וארא"],
    variants: ["vaeira","vaera","va'eira"]
  },
  {
    canonical: "bo",
    hebrew: ["בא","פרשת בא"],
    variants: ["bo","parshat bo","parshas bo"]
  },
  {
    canonical: "beshalach",
    hebrew: ["בשלח","פרשת בשלח"],
    variants: ["beshalach","bshalach","shabbat shira","shabbos shirah"]
  },
  {
    canonical: "yitro",
    hebrew: ["יתרו","פרשת יתרו"],
    variants: ["yitro","yisro"]
  },
  {
    canonical: "mishpatim",
    hebrew: ["משפטים","פרשת משפטים"],
    variants: ["mishpatim"]
  },
  {
    canonical: "terumah",
    hebrew: ["תרומה","פרשת תרומה"],
    variants: ["terumah","teruma","trumah","truma"]
  },
  {
    canonical: "tetzaveh",
    hebrew: ["תצוה","פרשת תצוה"],
    variants: ["tetzaveh","tetzave","tetzaveh"]
  },
  {
    canonical: "ki tisa",
    hebrew: ["כי תשא","פרשת כי תשא"],
    variants: ["ki tisa","ki sisa","ki tissa","ki sissa"]
  },
  {
    canonical: "vayakhel",
    hebrew: ["ויקהל","פרשת ויקהל"],
    variants: ["vayakhel","vayakkhel"]
  },
  {
    canonical: "pekudei",
    hebrew: ["פקודי","פרשת פקודי"],
    variants: ["pekudei","pekudey","pkudei"]
  },
  {
    canonical: "vayikra",
    hebrew: ["ויקרא","פרשת ויקרא"],
    variants: ["vayikra"]
  },
  {
    canonical: "tzav",
    hebrew: ["צו","פרשת צו"],
    variants: ["tzav","parshat tzav","parshas tzav"]
  },
  {
    canonical: "shemini",
    hebrew: ["שמיני","פרשת שמיני"],
    variants: ["shemini","shmini"]
  },
  {
    canonical: "tazria",
    hebrew: ["תזריע","פרשת תזריע"],
    variants: ["tazria","tazriah"]
  },
  {
    canonical: "metzora",
    hebrew: ["מצורע","פרשת מצורע"],
    variants: ["metzora","m'tzora"]
  },
  {
    canonical: "acharei mot",
    hebrew: ["אחרי מות","פרשת אחרי מות"],
    variants: ["acharei mot","acharei mos","acharei","achrei mot"]
  },
  {
    canonical: "kedoshim",
    hebrew: ["קדושים","פרשת קדושים"],
    variants: ["kedoshim","kdoshim"]
  },
  {
    canonical: "emor",
    hebrew: ["אמור","פרשת אמור"],
    variants: ["emor"]
  },
  {
    canonical: "behar",
    hebrew: ["בהר","פרשת בהר"],
    variants: ["behar"]
  },
  {
    canonical: "bechukotai",
    hebrew: ["בחוקותי","פרשת בחוקתי"],
    variants: ["bechukotai","bechukosai","bchukotai","bchukosai"]
  },
  {
    canonical: "bamidbar",
    hebrew: ["במדבר","פרשת במדבר"],
    variants: ["bamidbar","bmidbar"]
  },
  {
    canonical: "nasso",
    hebrew: ["נשא","פרשת נשא"],
    variants: ["nasso","naso"]
  },
  {
    canonical: "behaalotecha",
    hebrew: ["בהעלותך","פרשת בהעלותך"],
    variants: ["behaalotecha","beha'alotcha","behaaloscha","beha'aloscha"]
  },
  {
    canonical: "shelach",
    hebrew: ["שלח","פרשת שלח"],
    variants: ["shelach","shlach","shelach lecha"]
  },
  {
    canonical: "korach",
    hebrew: ["קורח","קרח","פרשת קרח"],
    variants: ["korach","korah"]
  },
  {
    canonical: "chukat",
    hebrew: ["חוקת","פרשת חקת"],
    variants: ["chukat","chukas","chukkas","chukkat"]
  },
  {
    canonical: "balak",
    hebrew: ["בלק","פרשת בלק"],
    variants: ["balak"]
  },
  {
    canonical: "pinchas",
    hebrew: ["פינחס","פנחס","פרשת פנחס"],
    variants: ["pinchas","pinchus","pinhas"]
  },
  {
    canonical: "matot",
    hebrew: ["מטות","פרשת מטות"],
    variants: ["matot","matos","mattot","mattos"]
  },
  {
    canonical: "masei",
    hebrew: ["מסעי","פרשת מסעי"],
    variants: ["masei","masey","mas'ei"]
  },
  {
    canonical: "devarim",
    hebrew: ["דברים","פרשת דברים"],
    variants: ["devarim","dvarim"]
  },
  {
    canonical: "vaetchanan",
    hebrew: ["ואתחנן","פרשת ואתחנן"],
    variants: ["vaetchanan","va'etchanan","veetchanan"]
  },
  {
    canonical: "eikev",
    hebrew: ["עקב","פרשת עקב"],
    variants: ["eikev","ekev"]
  },
  {
    canonical: "reeh",
    hebrew: ["ראה","פרשת ראה"],
    variants: ["reeh","re'eh","re-eh"]
  },
  {
    canonical: "shoftim",
    hebrew: ["שופטים","פרשת שופטים"],
    variants: ["shoftim"]
  },
  {
    canonical: "ki teitzei",
    hebrew: ["כי תצא","פרשת כי תצא"],
    variants: ["ki teitzei","ki tetzei","ki seitzei","ki setzei"]
  },
  {
    canonical: "ki tavo",
    hebrew: ["כי תבוא","פרשת כי תבא"],
    variants: ["ki tavo","ki savo","ki tabo"]
  },
  {
    canonical: "nitzavim",
    hebrew: ["נצבים","ניצבים","פרשת נצבים"],
    variants: ["nitzavim","netzavim"]
  },
  {
    canonical: "vayeilech",
    hebrew: ["וילך","פרשת וילך"],
    variants: ["vayeilech","vayelech"]
  },
  {
    canonical: "haazinu",
    hebrew: ["האזינו","פרשת האזינו"],
    variants: ["haazinu","ha'azinu"]
  },
  {
    canonical: "vezot haberachah",
    hebrew: ["וזאת הברכה","פרשת וזאת הברכה"],
    variants: ["vezot haberachah","vezos haberacha","v'zot haberachah","vezos habracha"]
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

  // 1. Try prefix of length 5 down to 1: e.g. "Rabbi Dr. Michael Rosensweig Shabbos", "Rabbi Hershel Schachter Yom Kippur", "Rosensweig Shabbos"
  for (let len = Math.min(words.length - 1, 5); len >= 1; len--) {
    const candidate = words.slice(0, len).join(' ');
    const spk = resolveSpeaker(candidate);
    if (spk) {
      return { speaker: spk, remainingQuery: words.slice(len).join(' ') };
    }
  }

  // 2. Try suffix of length 5 down to 1: e.g. "Shabbos Rabbi Dr. Michael Rosensweig", "Yom Kippur Rabbi Hershel Schachter", "Shabbos Rosensweig"
  for (let len = Math.min(words.length - 1, 5); len >= 1; len--) {
    const candidate = words.slice(-len).join(' ');
    const spk = resolveSpeaker(candidate);
    if (spk) {
      return { speaker: spk, remainingQuery: words.slice(0, -len).join(' ') };
    }
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

