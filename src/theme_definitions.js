/**
 * Complete Theme Definitions:
 * 27 Themes with Variant A and Variant B (plus Chanuka Days 1-8).
 * Color variables, motif badges, banners, watermarks, animations, and CSS rules.
 */

export const THEMES = {
  rosh_chodesh: {
    name: 'Rosh Chodesh',
    badge: 'Rosh Chodesh',
    variants: {
      a: {
        title: 'Variant A — Silver Crescent Moon',
        primary: '#3b5998',
        accent: '#7c98c1',
        bannerBg: '#edf2f9',
        icon: 'rosh_chodesh_a.svg',
        accentBorder: '#c3d5ee',
        tagline: 'Chodesh Tov',
        css: `
          .holiday-motif-wrap { background: #e8eef8; border-color: #7c98c1; }
          .timely-banner { border-bottom: 2px solid #7c98c1; }
        `
      },
      b: {
        title: 'Variant B — Celestial Shimmer',
        primary: '#243b68',
        accent: '#5a78a5',
        bannerBg: '#e6edf7',
        icon: 'rosh_chodesh_b.svg',
        accentBorder: '#a9c2e6',
        tagline: 'Chodesh Tov · Celestial Renewal',
        css: `
          .holiday-motif-wrap { background: #dce7f5; border-color: #5a78a5; }
          .holiday-motif-icon { animation: softPulse 4s ease-in-out infinite; }
          @keyframes softPulse { 0%, 100% { transform: scale(1); opacity: 0.9; } 50% { transform: scale(1.08); opacity: 1; } }
        `
      }
    }
  },

  rosh_chodesh_cheshvan: {
    name: 'Rosh Chodesh Mar Cheshvan',
    badge: 'Rosh Chodesh Cheshvan',
    variants: {
      a: {
        title: 'Variant A — Crescent Moon (Silver Slate)',
        primary: '#3b5998',
        accent: '#7c98c1',
        bannerBg: '#edf2f9',
        icon: 'rosh_chodesh_a.svg',
        accentBorder: '#c3d5ee',
        tagline: '',
        css: `
          .holiday-motif-wrap { background: #e8eef8; border-color: #7c98c1; }
          .timely-banner { border-bottom: 2px solid #7c98c1; }
        `
      },
      b: {
        title: 'Variant B — Celestial Shimmer (Midnight Blue)',
        primary: '#243b68',
        accent: '#5a78a5',
        bannerBg: '#e6edf7',
        icon: 'rosh_chodesh_b.svg',
        accentBorder: '#a9c2e6',
        tagline: '',
        css: `
          .holiday-motif-wrap { background: #dce7f5; border-color: #5a78a5; }
        `
      }
    }
  },

  elul: {
    name: 'Elul',
    badge: 'Chodesh Elul',
    variants: {
      a: {
        title: "Variant A — Classic Polished Ram's Horn Shofar",
        primary: '#2b4c7e',
        accent: '#c99a5b',
        bannerBg: '#fbf7f2',
        icon: 'elul_shofar_classic.svg',
        accentBorder: '#e6d3ba',
        tagline: 'אני לדודי ודודי לי · Season of Teshuva',
        css: `
          .holiday-motif-wrap { background: #fdf6ec; border-color: #c99a5b; }
          .sponsorship-banner { border-bottom: 2px solid #dfb987; }
        `
      },
      b: {
        title: 'Variant B — Bold Shofar Silhouette',
        primary: '#1f3d6b',
        accent: '#b88646',
        bannerBg: '#f8f4ec',
        icon: 'elul_shofar_silhouette.svg',
        accentBorder: '#dcbe97',
        tagline: 'קול שופר · Awakening the Heart',
        css: `
          .holiday-motif-wrap { background: #f7ede0; border-color: #b88646; }
          .holiday-motif-icon { filter: drop-shadow(0 2px 5px rgba(201, 154, 91, 0.4)); }
        `
      },
      c: {
        title: 'Variant C — Morning Dawn Shofar Emblem',
        primary: '#24446e',
        accent: '#d4a373',
        bannerBg: '#fef9f3',
        icon: 'elul_shofar_dawn.svg',
        accentBorder: '#eedbc5',
        tagline: 'יום יום ידרושון · Elul Reflection',
        css: `
          .holiday-motif-wrap { background: #fdf5ea; border-color: #d4a373; }
        `
      }
    }
  },

  rosh_hashanah: {
    name: 'Rosh Hashanah',
    badge: 'Rosh Hashanah',
    variants: {
      a: {
        title: 'Variant A — Apple, Pomegranate & Honey',
        primary: '#8e1b0f',
        accent: '#c0392b',
        bannerBg: '#fdf2f2',
        icon: 'rosh_hashanah_a.svg',
        accentBorder: '#f5b7b1',
        tagline: 'שנה טובה ומתוקה · A Sweet & Blessed New Year',
        css: `
          .holiday-motif-wrap { background: #fce8e6; border-color: #c0392b; }
          .brand span { background: #c0392b; }
        `
      },
      b: {
        title: 'Variant B — Golden Honeycomb Dipper',
        primary: '#7d6608',
        accent: '#d4af37',
        bannerBg: '#fefbf0',
        icon: 'rosh_hashanah_b.svg',
        accentBorder: '#f9e79f',
        tagline: 'תכתבו ותחתמו לאלתר לחיים טובים',
        css: `
          .holiday-motif-wrap { background: #fdf5d6; border-color: #d4af37; }
          .holiday-motif-icon { animation: gentleSway 5s ease-in-out infinite; }
          @keyframes gentleSway { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(5deg); } }
        `
      }
    }
  },

  teshuva: {
    name: 'Aseres Yemei Teshuva',
    badge: 'Aseres Yemei Teshuva',
    variants: {
      a: {
        title: 'Variant A — Contemplative Flame',
        primary: '#2c3e50',
        accent: '#f39c12',
        bannerBg: '#f4f6f7',
        icon: 'teshuva_a.svg',
        accentBorder: '#d5dbdb',
        tagline: 'דרשו ה׳ בהמצאו · Days of Return & Reflection',
        css: `
          .holiday-motif-wrap { background: #eaeded; border-color: #bdc3c7; }
          .holiday-motif-icon { animation: flameFlicker 2.5s ease-in-out infinite alternate; }
          @keyframes flameFlicker { 0% { opacity: 0.85; transform: scale(0.98); } 100% { opacity: 1; transform: scale(1.03); } }
        `
      },
      b: {
        title: 'Variant B — Open Book of Life',
        primary: '#1b2631',
        accent: '#e67e22',
        bannerBg: '#ebedef',
        icon: 'teshuva_b.svg',
        accentBorder: '#ccd1d1',
        tagline: 'בספר חיים ברכה ושלום נזכר ונכתב',
        css: `
          .holiday-motif-wrap { background: #d5dbdb; border-color: #99a3a4; }
        `
      }
    }
  },

  yom_kippur: {
    name: 'Yom Kippur',
    badge: 'Yom Kippur',
    variants: {
      a: {
        title: 'Variant A — Beis HaMikdash Heichal & Golden Cornice',
        primary: '#34495e',
        accent: '#8c7f70',
        bannerBg: '#faf7f2',
        icon: 'yom_kippur_mikdash_facade.svg',
        accentBorder: '#e8e1d5',
        tagline: 'גמר חתימה טובה · עבודת יום הכפורים במקדש',
        css: `
          .holiday-motif-wrap { background: #f7f3ec; border-color: #bfaea0; box-shadow: 0 0 10px rgba(0,0,0,0.04); }
          .sponsorship-banner { background: #faf7f2 !important; border-bottom: 1px solid #e0d8cc; }
        `
      },
      b: {
        title: 'Variant B — Beis HaMikdash Sanctuary & Menorah',
        primary: '#212f3d',
        accent: '#b0a290',
        bannerBg: '#f6f3ee',
        icon: 'yom_kippur_mikdash_menorah.svg',
        accentBorder: '#ddd5c7',
        tagline: 'לפני ה׳ תטהרו · כהן גדול ביום הכפורים',
        css: `
          .holiday-motif-wrap { background: #ede8df; border-color: #9c8e7e; }
        `
      }
    }
  },

  sukkos: {
    name: 'Sukkos',
    badge: 'Chag HaSukkos',
    variants: {
      a: {
        title: 'Variant A — Arba Minim (Lulav & Esrog)',
        primary: '#196f3d',
        accent: '#27ae60',
        bannerBg: '#f4fbf6',
        icon: 'sukkos_a.svg',
        accentBorder: '#c8eed5',
        tagline: 'זמן שמחתנו · Season of Our Joy',
        css: `
          .holiday-motif-wrap { background: #e8f8ef; border-color: #2ecc71; }
          .brand span { background: #27ae60; }
        `
      },
      b: {
        title: 'Variant B — Schach Greenery & Golden Citron',
        primary: '#145a32',
        accent: '#d4ac0d',
        bannerBg: '#fcfdf4',
        icon: 'sukkos_b.svg',
        accentBorder: '#e8f3c7',
        tagline: 'ושמחת בחגך והיית אך שמח',
        css: `
          .holiday-motif-wrap { background: #f2f9db; border-color: #9cb542; }
          .timely-banner { background: #f7faec !important; }
        `
      }
    }
  },

  hoshana_rabbah: {
    name: 'Hoshana Rabbah',
    badge: 'Hoshana Rabbah',
    variants: {
      a: {
        title: 'Variant A — Aravos Branches (Hebrew Badge)',
        primary: '#1e8449',
        accent: '#58d68d',
        bannerBg: '#f2fcf5',
        icon: 'hoshana_rabbah_b.svg',
        accentBorder: '#c1f3d4',
        tagline: 'הושע נא',
        css: `
          .holiday-motif-wrap { background: #e0f9e9; border-color: #58d68d; }
        `
      },
      b: {
        title: 'Variant B — Aravos Bouquet Seal',
        primary: '#117864',
        accent: '#48c9b0',
        bannerBg: '#f0fbf9',
        icon: 'hoshana_rabbah_b.svg',
        accentBorder: '#bbf0e5',
        tagline: 'פתקא טבא · Final Seal of Mercy',
        css: `
          .holiday-motif-wrap { background: #daf6f0; border-color: #48c9b0; }
        `
      }
    }
  },

  simchas_torah: {
    name: 'Shemini Atzeres / Simchas Torah',
    badge: 'Simchas Torah',
    variants: {
      a: {
        title: 'Variant A — Crowned Torah Scroll',
        primary: '#1b4f72',
        accent: '#b7950b',
        bannerBg: '#fefcf3',
        icon: 'simchas_torah_a.svg',
        accentBorder: '#faeec7',
        tagline: 'שישו ושמחו בשמחת תורה · Celebration of the Torah',
        css: `
          .holiday-motif-wrap { background: #fdf5d7; border-color: #d4ac0d; }
          .brand span { background: #b7950b; }
        `
      },
      b: {
        title: 'Variant B — Hakafos Celebratory Ribbon',
        primary: '#154360',
        accent: '#f39c12',
        bannerBg: '#fef8ea',
        icon: 'simchas_torah_b.svg',
        accentBorder: '#fcdcb0',
        tagline: 'תורת ה׳ תמימה משיבת נפש',
        css: `
          .holiday-motif-wrap { background: #fbeee1; border-color: #e67e22; }
          .holiday-motif-icon { animation: softBounce 3s ease-in-out infinite; }
          @keyframes softBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        `
      }
    }
  },

  chanukah: {
    name: 'Chanukah',
    badge: 'Chanukah',
    // Dynamic candle day resolver for days 1 to 8
    getDayVariant: (day) => {
      const d = Math.max(1, Math.min(8, day || 1));
      return {
        title: `Chanukah Night ${d} (${d} Candle${d > 1 ? 's' : ''} + Shamash)`,
        primary: '#1a5276',
        accent: '#d4af37',
        bannerBg: '#fbf8ea',
        icon: `chanukah_a_${d}.svg`,
        accentBorder: '#f6e4a8',
        tagline: `ליל ${d} דחנוכה · Festival of Lights (Night ${d})`,
        css: `
          .holiday-motif-wrap { background: #fdf5d6; border-color: #d4af37; box-shadow: 0 0 12px rgba(212, 175, 55, 0.35); }
          .holiday-motif-icon { animation: menorahGlow 2.5s ease-in-out infinite alternate; }
          @keyframes menorahGlow { 0% { filter: drop-shadow(0 0 2px rgba(241, 196, 15, 0.4)); } 100% { filter: drop-shadow(0 0 6px rgba(243, 156, 18, 0.85)); } }
        `
      };
    },
    variants: {
      a: {
        title: 'Variant A — 9-Branch Menorah Lights',
        primary: '#1b4f72',
        accent: '#d4af37',
        bannerBg: '#fbf8ea',
        icon: 'chanukah_a_1.svg',
        accentBorder: '#f6e4a8',
        tagline: 'הנרות הללו קודש הם · Festival of Lights',
        css: `
          .holiday-motif-wrap { background: #fdf5d6; border-color: #d4af37; }
        `
      },
      b: {
        title: 'Variant B — Spinning Dreidel & Pure Olive Oil',
        primary: '#2471a3',
        accent: '#f39c12',
        bannerBg: '#fcf6ec',
        icon: 'chanukah_b.svg',
        accentBorder: '#fae3c3',
        tagline: 'נס גדול היה שם · Miracle of the Oil',
        css: `
          .holiday-motif-wrap { background: #faeada; border-color: #f39c12; }
          .holiday-motif-icon { animation: dreidelSpin 6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
          @keyframes dreidelSpin { 0% { transform: rotate(0deg); } 40% { transform: rotate(15deg); } 60% { transform: rotate(-15deg); } 100% { transform: rotate(0deg); } }
        `
      }
    }
  },

  tubshevat: {
    name: "Tu B'Shevat",
    badge: "Tu B'Shevat",
    variants: {
      a: {
        title: 'Variant A — Flowering Fruit Tree & Pomegranates',
        primary: '#1e8449',
        accent: '#2ecc71',
        bannerBg: '#f2fcf5',
        icon: 'tubshevat_tree_lush.svg',
        accentBorder: '#c1f3d4',
        tagline: 'ראש השנה לאילנות · New Year for the Trees',
        css: `
          .holiday-motif-wrap { background: #e0f9e9; border-color: #2ecc71; }
        `
      },
      b: {
        title: 'Variant B — Ancient Jerusalem Olive Tree',
        primary: '#196f3d',
        accent: '#558b2f',
        bannerBg: '#f6fbf2',
        icon: 'tubshevat_tree_olive.svg',
        accentBorder: '#d4ebd0',
        tagline: 'ארץ זית שמן ודבש',
        css: `
          .holiday-motif-wrap { background: #eaf5e6; border-color: #558b2f; }
        `
      }
    }
  },

  adar_buildup: {
    name: 'Rosh Chodesh Adar → Purim',
    badge: 'Chodesh Adar',
    variants: {
      a: {
        title: 'Variant A — Comedy Mask & Purple Velvet',
        primary: '#5b2c6f',
        accent: '#9b59b6',
        bannerBg: '#f9f2fc',
        icon: 'adar_buildup_a.svg',
        accentBorder: '#e6c8f2',
        tagline: 'משנכנס אדר מרבים בשמחה · Joy of Adar',
        css: `
          .holiday-motif-wrap { background: #f2dbfa; border-color: #9b59b6; }
        `
      },
      b: {
        title: 'Variant B — Festive Golden Masquerade',
        primary: '#6c3483',
        accent: '#f39c12',
        bannerBg: '#fdf7ee',
        icon: 'adar_buildup_b.svg',
        accentBorder: '#fae3c3',
        tagline: 'ליהודים היתה אורה ושמחה וששון ויקר',
        css: `
          .holiday-motif-wrap { background: #faeada; border-color: #f39c12; }
        `
      }
    }
  },

  taanis_esther: {
    name: "Ta'anis Esther",
    badge: "Ta'anis Esther",
    variants: {
      a: {
        title: 'Variant A — Royal Megillah Scroll',
        primary: '#4a235a',
        accent: '#7d3c98',
        bannerBg: '#f7f2f9',
        icon: 'taanis_esther_a.svg',
        accentBorder: '#dfc7e7',
        tagline: 'צומו עלי ואל תאכלו ואל תשתו · Fast of Esther',
        css: `
          .holiday-motif-wrap { background: #ecddef; border-color: #7d3c98; }
        `
      },
      b: {
        title: 'Variant B — Queen Esther Royal Seal',
        primary: '#512e5f',
        accent: '#a569bd',
        bannerBg: '#f9f5fa',
        icon: 'taanis_esther_b.svg',
        accentBorder: '#e9d6ef',
        tagline: 'וכאשר אבדתי אבדתי · Royal Intercession',
        css: `
          .holiday-motif-wrap { background: #f1e2f6; border-color: #a569bd; }
        `
      }
    }
  },

  purim: {
    name: 'Purim',
    badge: 'Purim Sameach',
    variants: {
      a: {
        title: 'Variant A — Royal Shushan Crown & Megillah',
        primary: '#7d3c98',
        accent: '#f1c40f',
        bannerBg: '#fbf4ff',
        icon: 'purim_a.svg',
        accentBorder: '#f5d3ff',
        tagline: 'משתה ושמחה ויום טוב ומשלוח מנות · Purim Sameach!',
        css: `
          .holiday-motif-wrap { background: #fae6ff; border-color: #d2527f; }
          .holiday-motif-icon { animation: jesterWiggle 3s ease-in-out infinite; }
          @keyframes jesterWiggle { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-8deg); } 75% { transform: rotate(8deg); } }
        `
      },
      b: {
        title: 'Variant B — Poppyseed Hamantaschen Treat',
        primary: '#ba4a00',
        accent: '#e67e22',
        bannerBg: '#fef7ee',
        icon: 'purim_b.svg',
        accentBorder: '#fae0c2',
        tagline: 'ונהפוך הוא אשר ישלטו היהודים המה בשנאיהם',
        css: `
          .holiday-motif-wrap { background: #fae6d3; border-color: #e67e22; }
        `
      }
    }
  },

  nissan_buildup: {
    name: 'Rosh Chodesh Nissan → Pesach',
    badge: 'Chodesh HaAviv',
    variants: {
      a: {
        title: 'Variant A — Golden Spring Wheat Sheaf',
        primary: '#2b4c7e',
        accent: '#b7950b',
        bannerBg: '#fdfbf2',
        icon: 'nissan_buildup_a.svg',
        accentBorder: '#f8eec4',
        tagline: 'החודש הזה לכם ראש חדשים · Month of Redemption',
        css: `
          .holiday-motif-wrap { background: #fcf4d7; border-color: #d4ac0d; }
        `
      },
      b: {
        title: 'Variant B — Round Shmurah Matzah Preview',
        primary: '#7e5109',
        accent: '#af601a',
        bannerBg: '#faf4ee',
        icon: 'nissan_buildup_b.svg',
        accentBorder: '#eed8c3',
        tagline: 'הכנות לפסח · Preparing for Pesach',
        css: `
          .holiday-motif-wrap { background: #f6e6d7; border-color: #af601a; }
        `
      }
    }
  },

  pesach: {
    name: 'Pesach',
    badge: 'Chag HaPesach',
    variants: {
      a: {
        title: 'Variant A — Silver Kiddush Wine Goblet',
        primary: '#641e16',
        accent: '#922b21',
        bannerBg: '#fcf2f2',
        icon: 'pesach_a.svg',
        accentBorder: '#f7c8c8',
        tagline: 'זמן חירותנו · Season of Our Liberation',
        css: `
          .holiday-motif-wrap { background: #fae2e2; border-color: #c0392b; }
          .brand span { background: #922b21; }
        `
      },
      b: {
        title: 'Variant B — Seder Plate (Ka’arah)',
        primary: '#1b4f72',
        accent: '#2980b9',
        bannerBg: '#f2f8fc',
        icon: 'pesach_b.svg',
        accentBorder: '#cce5f6',
        tagline: 'והגדת לבנך ביום ההוא · The Seder Night',
        css: `
          .holiday-motif-wrap { background: #e1f0fa; border-color: #2980b9; }
        `
      }
    }
  },

  omer: {
    name: 'Sefiras HaOmer',
    badge: 'Sefiras HaOmer',
    getDayVariant: (day) => {
      const d = Math.max(1, Math.min(49, day || 1));
      return {
        title: `Omer Day ${d} (Page-Turn Animation)`,
        primary: '#b9770e',
        accent: '#e67e22',
        bannerBg: '#fef9ee',
        icon: 'omer_a.svg',
        accentBorder: '#f8e4bf',
        tagline: `היום ${d} ימים לעומר · Count: Day ${d} of 49`,
        css: `
          .holiday-motif-wrap { background: #faebd2; border-color: #e67e22; position: relative; perspective: 400px; }
          .holiday-motif-icon { animation: calendarFlip 4s ease-in-out infinite; transform-origin: top center; }
          @keyframes calendarFlip {
            0%, 70%, 100% { transform: rotateX(0deg); }
            80% { transform: rotateX(-30deg); }
            90% { transform: rotateX(10deg); }
          }
        `
      };
    },
    variants: {
      a: {
        title: 'Variant A — Interactive Omer Day Flip Calendar',
        primary: '#b9770e',
        accent: '#e67e22',
        bannerBg: '#fef9ee',
        icon: 'omer_a.svg',
        accentBorder: '#f8e4bf',
        tagline: 'וספרתם לכם ממחרת השבת · Omer Count',
        css: `
          .holiday-motif-wrap { background: #faebd2; border-color: #e67e22; }
          .holiday-motif-icon { animation: calendarFlip 4s ease-in-out infinite; transform-origin: top center; }
          @keyframes calendarFlip {
            0%, 70%, 100% { transform: rotateX(0deg); }
            80% { transform: rotateX(-30deg); }
            90% { transform: rotateX(10deg); }
          }
        `
      },
      b: {
        title: 'Variant B — Golden Parchment Omer Scroll',
        primary: '#7d6608',
        accent: '#b7950b',
        bannerBg: '#fcf9ea',
        icon: 'omer_b.svg',
        accentBorder: '#f5eab5',
        tagline: 'תמימות תהיינה · Spiritual Elevation',
        css: `
          .holiday-motif-wrap { background: #f8f1c8; border-color: #b7950b; }
        `
      }
    }
  },

  yom_hazikaron: {
    name: 'Yom HaZikaron',
    badge: 'Yom HaZikaron',
    variants: {
      a: {
        title: 'Variant A — Memorial Flame in Stillness',
        primary: '#17202a',
        accent: '#2c3e50',
        bannerBg: '#f2f4f4',
        icon: 'yom_hazikaron_a.svg',
        accentBorder: '#d5dbdb',
        tagline: 'יזכור · In Reverent Memory of Israel’s Fallen',
        css: `
          .holiday-motif-wrap { background: #e5e8e8; border-color: #7f8c8d; }
          .sponsorship-banner { background: #f2f4f4 !important; border-bottom: 2px solid #bdc3c7; }
        `
      },
      b: {
        title: 'Variant B — Ribbon of Remembrance',
        primary: '#1b4f72',
        accent: '#2980b9',
        bannerBg: '#f4f6f7',
        icon: 'yom_hazikaron_b.svg',
        accentBorder: '#d4e6f1',
        tagline: 'במותם ציוו לנו את החיים · Memorial Day',
        css: `
          .holiday-motif-wrap { background: #eaecee; border-color: #aed6f1; }
        `
      }
    }
  },

  yom_haatzmaut: {
    name: 'Yom HaAtzmaut',
    badge: 'Yom HaAtzmaut',
    variants: {
      a: {
        title: 'Variant A — Azure Blue & White Magen David',
        primary: '#0038b8',
        accent: '#2980b9',
        bannerBg: '#f0f5ff',
        icon: 'yom_haatzmaut_a.svg',
        accentBorder: '#c2d6ff',
        tagline: 'חג עצמאות שמח · Israel Independence Day',
        css: `
          .holiday-motif-wrap { background: #e0ecff; border-color: #0038b8; box-shadow: 0 0 10px rgba(0, 56, 184, 0.2); }
          .brand span { background: #0038b8; }
        `
      },
      b: {
        title: 'Variant B — Waving Flag & Celebration',
        primary: '#0e3a8c',
        accent: '#3b82f6',
        bannerBg: '#f0f7ff',
        icon: 'yom_haatzmaut_b.svg',
        accentBorder: '#bfdbfe',
        tagline: 'עם ישראל חי',
        css: `
          .holiday-motif-wrap { background: #dbeafe; border-color: #3b82f6; }
          .holiday-motif-icon { animation: flagWave 3s ease-in-out infinite alternate; }
          @keyframes flagWave { 0% { transform: scale(1); } 100% { transform: scale(1.08) rotate(2deg); } }
        `
      }
    }
  },

  lag_baomer: {
    name: 'Lag BaOmer',
    badge: 'Lag BaOmer',
    variants: {
      a: {
        title: 'Variant A — Glowing Bonfire & Embers',
        primary: '#b9770e',
        accent: '#e67e22',
        bannerBg: '#fef7ee',
        icon: 'lag_baomer_a.svg',
        accentBorder: '#f9dfbe',
        tagline: '',
        css: `
          .holiday-motif-wrap { background: #fae4c8; border-color: #e67e22; box-shadow: 0 0 12px rgba(230, 126, 34, 0.35); }
          .holiday-motif-icon { animation: bonfireFlicker 2s ease-in-out infinite alternate; }
          @keyframes bonfireFlicker { 0% { filter: drop-shadow(0 0 2px #e67e22); transform: scale(1); } 100% { filter: drop-shadow(0 0 6px #f39c12); transform: scale(1.06); } }
        `
      },
      b: {
        title: 'Variant B — Radiant Sparks & Warmth',
        primary: '#900c3f',
        accent: '#d35400',
        bannerBg: '#fdf4ee',
        icon: 'lag_baomer_b.svg',
        accentBorder: '#f8d2b9',
        tagline: '',
        css: `
          .holiday-motif-wrap { background: #f7d8c0; border-color: #d35400; }
        `
      }
    }
  },

  yom_yerushalayim: {
    name: 'Yom Yerushalayim',
    badge: 'Yom Yerushalayim',
    variants: {
      a: {
        title: 'Variant A — Golden Jerusalem Stone Kotel',
        primary: '#7d6608',
        accent: '#b7950b',
        bannerBg: '#fefbf0',
        icon: 'yom_yerushalayim_a.svg',
        accentBorder: '#f9e9a9',
        tagline: 'ירושלים של זהב ושל נחשת ושל אור',
        css: `
          .holiday-motif-wrap { background: #fdf4c6; border-color: #b7950b; }
          .brand span { background: #b7950b; }
        `
      },
      b: {
        title: 'Variant B — Golden Old City Skyline',
        primary: '#6e2c00',
        accent: '#d4ac0d',
        bannerBg: '#fefaf0',
        icon: 'yom_yerushalayim_b.svg',
        accentBorder: '#fae6a6',
        tagline: 'ירושלים של זהב ושל נחשת ושל אור',
        css: `
          .holiday-motif-wrap { background: #fceea4; border-color: #d4ac0d; }
          .holiday-motif-icon { filter: drop-shadow(0 2px 6px rgba(212, 172, 13, 0.45)); }
        `
      }
    }
  },

  shavuos: {
    name: 'Shavuos',
    badge: 'Chag HaShavuos',
    variants: {
      a: {
        title: 'Variant A — Luchos HaBris & Mountain Greens',
        primary: '#1e8449',
        accent: '#27ae60',
        bannerBg: '#f2fcf5',
        icon: 'shavuos_a.svg',
        accentBorder: '#c1f3d4',
        tagline: 'זמן מתן תורתנו · Season of the Giving of the Torah',
        css: `
          .holiday-motif-wrap { background: #e0f9e9; border-color: #27ae60; }
          .brand span { background: #1e8449; }
        `
      },
      b: {
        title: 'Variant B — Har Sinai Floral Bloom',
        primary: '#145a32',
        accent: '#52be80',
        bannerBg: '#f3fbf6',
        icon: 'shavuos_b.svg',
        accentBorder: '#c4f0d6',
        tagline: 'נעשה ונשמע · Torah & Blossoms',
        css: `
          .holiday-motif-wrap { background: #d7f5e3; border-color: #52be80; }
        `
      }
    }
  },

  july4: {
    name: 'July 4th',
    badge: 'July 4th',
    variants: {
      a: {
        title: 'Variant A — American Flag (Old Glory)',
        primary: '#b03a2e',
        accent: '#2980b9',
        bannerBg: '#f9f9fb',
        icon: 'july4_a.svg',
        accentBorder: '#d6dbdf',
        tagline: 'Happy Birthday America',
        css: `
          .holiday-motif-wrap { background: #edf2f7; border-color: #b03a2e; }
          .brand span { background: #b03a2e; }
        `
      },
      b: {
        title: 'Variant B — Independence Star Sparkler',
        primary: '#1b4f72',
        accent: '#cb4335',
        bannerBg: '#f4f6f9',
        icon: 'july4_b.svg',
        accentBorder: '#eaeded',
        tagline: 'Red, White & Blue · Independence Day',
        css: `
          .holiday-motif-wrap { background: #eaf2f8; border-color: #2980b9; }
          .holiday-motif-icon { animation: starSparkle 3s ease-in-out infinite alternate; }
          @keyframes starSparkle { 0% { transform: scale(1); filter: drop-shadow(0 0 2px #cb4335); } 100% { transform: scale(1.1); filter: drop-shadow(0 0 5px #2980b9); } }
        `
      }
    }
  },

  three_weeks: {
    name: 'The Three Weeks',
    badge: 'Bein HaMetzarim',
    variants: {
      a: {
        title: 'Variant A — Somber Sandstone Candle',
        primary: '#34495e',
        accent: '#7f8c8d',
        bannerBg: '#f4f6f7',
        icon: 'three_weeks_a.svg',
        accentBorder: '#d5dbdb',
        tagline: 'על אלה אני בוכיה · Days of Mourning',
        css: `
          .holiday-motif-wrap { background: #eaeded; border-color: #7f8c8d; }
          .sponsorship-banner { border-bottom: 2px solid #bdc3c7; }
        `
      },
      b: {
        title: 'Variant B — Ancient Masonry Reflection',
        primary: '#2c3e50',
        accent: '#5d6d7e',
        bannerBg: '#f2f4f4',
        icon: 'three_weeks_b.svg',
        accentBorder: '#ccd1d1',
        tagline: 'על אלה אני בוכיה · Days of Mourning',
        css: `
          .holiday-motif-wrap { background: #e5e8e8; border-color: #5d6d7e; }
        `
      }
    }
  },

  nine_days: {
    name: 'The Nine Days',
    badge: 'The Nine Days',
    variants: {
      a: {
        title: 'Variant A — Ash & Charcoal Reverence',
        primary: '#212f3d',
        accent: '#566573',
        bannerBg: '#ebedef',
        icon: 'nine_days_a.svg',
        accentBorder: '#ccd1d1',
        tagline: 'משנכנס אב ממעטין בשמחה · The Nine Days',
        css: `
          .holiday-motif-wrap { background: #d5dbdb; border-color: #566573; }
          .sponsorship-banner { background: #ebedef !important; border-bottom: 2px solid #99a3a4; }
        `
      },
      b: {
        title: 'Variant B — Low Flame & Solemnity',
        primary: '#1c2833',
        accent: '#475569',
        bannerBg: '#e8eaec',
        icon: 'nine_days_a.svg',
        accentBorder: '#cbd5e1',
        tagline: 'נחמו נחמו עמי',
        css: `
          .holiday-motif-wrap { background: #cbd5e1; border-color: #475569; }
        `
      }
    }
  },

  tisha_bav: {
    name: "Tisha B'Av",
    badge: "Tisha B'Av",
    variants: {
      a: {
        title: 'Variant A — Solitary Flame on Broken Kotel Stones',
        primary: '#17202a',
        accent: '#2c3e50',
        bannerBg: '#e5e7e9',
        icon: 'tisha_bav_a.svg',
        accentBorder: '#bdc3c7',
        tagline: 'איכה ישבה בדד · Fast of the Ninth of Av',
        css: `
          .holiday-motif-wrap { background: #d7dbdd; border-color: #2c3e50; }
          .sponsorship-banner { background: #e5e7e9 !important; border-bottom: 2px solid #7f8c8d; }
        `
      },
      b: {
        title: 'Variant B — Stark Ash & Solitary Ruin',
        primary: '#111827',
        accent: '#374151',
        bannerBg: '#e2e5e8',
        icon: 'tisha_bav_b.svg',
        accentBorder: '#9ca3af',
        tagline: 'שמם הר ציון שועלים הלכו בו',
        css: `
          .holiday-motif-wrap { background: #ced2d6; border-color: #374151; }
        `
      }
    }
  },

  tubav: {
    name: "Tu B'Av",
    badge: "Tu B'Av",
    variants: {
      a: {
        title: 'Variant A — Delicate Vine Blossom & Heart',
        primary: '#922b21',
        accent: '#c0392b',
        bannerBg: '#fef4f4',
        icon: 'tubav_a.svg',
        accentBorder: '#fbd0ce',
        tagline: 'לא היו ימים טובים לישראל כחמשה עשר באב',
        css: `
          .holiday-motif-wrap { background: #fae4e3; border-color: #c0392b; }
          .brand span { background: #c0392b; }
        `
      },
      b: {
        title: 'Variant B — Rose Quartz Blossom Garland',
        primary: '#78281f',
        accent: '#e74c3c',
        bannerBg: '#fff5f5',
        icon: 'tubav_b.svg',
        accentBorder: '#fed7d7',
        tagline: 'צאנה וראינה בנות ציון · Day of Joy & Reconciliation',
        css: `
          .holiday-motif-wrap { background: #fee2e2; border-color: #e74c3c; }
        `
      }
    }
  }
};
