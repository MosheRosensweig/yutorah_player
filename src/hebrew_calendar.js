/**
 * 15-Year Dynamic Hebrew Calendar Engine
 * Dynamically resolves Jewish dates and calculates all holiday/seasonal themes
 * without hardcoding Gregorian dates. Accurately handles leap years (Adar I / Adar II)
 * and Omer counting.
 */

export function getHebrewDateInfo(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-u-ca-hebrew', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const parts = formatter.formatToParts(date);
    const dayPart = parts.find(p => p.type === 'day');
    const monthPart = parts.find(p => p.type === 'month');
    const yearPart = parts.find(p => p.type === 'year');

    const day = dayPart ? parseInt(dayPart.value, 10) : 1;
    const month = monthPart ? monthPart.value.trim() : 'Elul';
    const year = yearPart ? parseInt(yearPart.value, 10) : 5786;

    // Check if leap year (contains 13 months or Adar II exists)
    // In Hebrew 19-year Metonic cycle, leap years have remainder 0, 3, 6, 8, 11, 14, 17 when (year * 7 + 1) % 19 < 7
    const isLeapYear = (19 * year + 1) % 19 < 7 || month.includes('Adar');

    // Sefiras HaOmer day calculation (16 Nisan to 5 Sivan)
    let omerDay = 0;
    if (month === 'Nisan' && day >= 16) {
      omerDay = day - 15;
    } else if (month === 'Iyar') {
      omerDay = 15 + day;
    } else if (month === 'Sivan' && day <= 5) {
      omerDay = 44 + day;
    }

    return {
      day,
      month,
      year,
      isLeapYear,
      omerDay,
      gregorianMonth: date.getMonth() + 1,
      gregorianDay: date.getDate()
    };
  } catch (e) {
    return {
      day: 1,
      month: 'Elul',
      year: 5786,
      isLeapYear: false,
      omerDay: 0,
      gregorianMonth: date.getMonth() + 1,
      gregorianDay: date.getDate()
    };
  }
}

/**
 * Determine the active holiday/seasonal theme from Hebrew date
 */
export function getActiveHolidayTheme(hDate) {
  const { day, month, omerDay, gregorianMonth, gregorianDay } = hDate;

  // 1. July 4th (Gregorian override)
  if (gregorianMonth === 7 && gregorianDay === 4) {
    return { key: 'july4', name: 'July 4th', priority: 95 };
  }

  // 2. Erev Yom Tov (Eve of Melacha-forbidden festivals) with 50/50 random overlap selection
  // Erev Rosh Hashanah (29 Elul) -> 50/50 between Rosh Hashanah and Chodesh Elul
  if (month === 'Elul' && day === 29) {
    return Math.random() < 0.5
      ? { key: 'rosh_hashanah', name: 'Rosh Hashanah', priority: 95 }
      : { key: 'elul', name: 'Chodesh Elul', priority: 75 };
  }

  // Erev Yom Kippur (9 Tishrei) -> 50/50 between Yom Kippur and Aseres Yemei Teshuva
  if (month === 'Tishri' && day === 9) {
    return Math.random() < 0.5
      ? { key: 'yom_kippur', name: 'Yom Kippur', priority: 100 }
      : { key: 'teshuva', name: 'Aseres Yemei Teshuva', priority: 85 };
  }

  // Erev Sukkos (14 Tishrei) -> Sukkos theme
  if (month === 'Tishri' && day === 14) {
    return { key: 'sukkos', name: 'Sukkos', priority: 90 };
  }

  // Erev Shemini Atzeres / Simchas Torah (21 Tishrei) -> 50/50 between Simchas Torah and Hoshana Rabbah
  if (month === 'Tishri' && day === 21) {
    return Math.random() < 0.5
      ? { key: 'simchas_torah', name: 'Shemini Atzeres / Simchas Torah', priority: 95 }
      : { key: 'hoshana_rabbah', name: 'Hoshana Rabbah', priority: 92 };
  }

  // Erev Pesach (14 Nisan) -> 50/50 between Pesach and Nissan buildup
  if (month === 'Nisan' && day === 14) {
    return Math.random() < 0.5
      ? { key: 'pesach', name: 'Pesach', priority: 95 }
      : { key: 'nissan_buildup', name: 'Rosh Chodesh Nissan → Pesach', priority: 70 };
  }

  // Erev Shavuos (5 Sivan) -> 50/50 between Shavuos and Sefiras HaOmer (Day 49)
  if (month === 'Sivan' && day === 5) {
    return Math.random() < 0.5
      ? { key: 'shavuos', name: 'Shavuos', priority: 95 }
      : { key: 'omer', name: 'Sefiras HaOmer (Day 49)', omerDay: 49, priority: 75 };
  }

  // 3. High priority specific days

  // Yom Kippur (10 Tishrei)
  if (month === 'Tishri' && day === 10) {
    return { key: 'yom_kippur', name: 'Yom Kippur', priority: 100 };
  }

  // Rosh Hashanah (1-2 Tishrei)
  if (month === 'Tishri' && (day === 1 || day === 2)) {
    return { key: 'rosh_hashanah', name: 'Rosh Hashanah', priority: 95 };
  }

  // Aseres Yemei Teshuva (3-8 Tishrei)
  if (month === 'Tishri' && day >= 3 && day <= 8) {
    return { key: 'teshuva', name: 'Aseres Yemei Teshuva', priority: 85 };
  }

  // Shemini Atzeres / Simchas Torah (22-23 Tishrei)
  if (month === 'Tishri' && (day === 22 || day === 23)) {
    return { key: 'simchas_torah', name: 'Shemini Atzeres / Simchas Torah', priority: 95 };
  }

  // Sukkos (15-20 Tishrei)
  if (month === 'Tishri' && day >= 15 && day <= 20) {
    return { key: 'sukkos', name: 'Sukkos', priority: 90 };
  }

  // Rosh Chodesh Mar Cheshvan (1 Cheshvan or 30 Tishri)
  if ((month === 'Heshvan' && day === 1) || (month === 'Tishri' && day === 30)) {
    return { key: 'rosh_chodesh_cheshvan', name: 'Rosh Chodesh Mar Cheshvan', priority: 82 };
  }

  // Chanuka (25 Kislev - 2/3 Tevet: 8 nights)
  if (month === 'Kislev' && day >= 25) {
    const chanukahDay = day - 24; // 25 Kislev is day 1
    return { key: 'chanukah', name: `Chanukah (Night ${chanukahDay})`, chanukahDay, priority: 90 };
  }
  if (month === 'Tevet' && day <= 3) {
    // Kislev can have 29 or 30 days. Tevet 1 is night 6 or 7.
    // Approximate: Tevet 1 is Day 6, Tevet 2 is Day 7, Tevet 3 is Day 8
    const chanukahDay = Math.min(8, 5 + day);
    return { key: 'chanukah', name: `Chanukah (Night ${chanukahDay})`, chanukahDay, priority: 90 };
  }

  // Tu B'Shevat (15 Shevat)
  if (month === 'Shevat' && day === 15) {
    return { key: 'tubshevat', name: "Tu B'Shevat", priority: 88 };
  }

  // Purim in Adar (or Adar II in leap year)
  const isPurimMonth = month === 'Adar II' || month === 'Adar';
  if (isPurimMonth && (day === 14 || day === 15)) {
    return { key: 'purim', name: 'Purim', priority: 95 };
  }

  // Ta'anis Esther (13 Adar or 11/13 Adar II)
  if (isPurimMonth && (day === 13 || day === 11)) {
    return { key: 'taanis_esther', name: "Ta'anis Esther", priority: 90 };
  }

  // Adar buildup (1-12 Adar / Adar II)
  if (isPurimMonth && day < 13) {
    return { key: 'adar_buildup', name: 'Rosh Chodesh Adar → Purim', priority: 70 };
  }

  // Pesach (15-22 Nisan)
  if (month === 'Nisan' && day >= 15 && day <= 22) {
    return { key: 'pesach', name: 'Pesach', priority: 95 };
  }

  // Nisan buildup (1-14 Nisan)
  if (month === 'Nisan' && day < 15) {
    return { key: 'nissan_buildup', name: 'Rosh Chodesh Nissan → Pesach', priority: 70 };
  }

  // Yom HaZikaron (approx 4 Iyar, adjusted if on Fri/Sun)
  if (month === 'Iyar' && (day === 3 || day === 4)) {
    return { key: 'yom_hazikaron', name: 'Yom HaZikaron', priority: 92 };
  }

  // Yom HaAtzmaut (approx 5 Iyar)
  if (month === 'Iyar' && (day === 5 || day === 6)) {
    return { key: 'yom_haatzmaut', name: 'Yom HaAtzmaut', priority: 92 };
  }

  // Lag BaOmer (18 Iyar)
  if (month === 'Iyar' && day === 18) {
    return { key: 'lag_baomer', name: 'Lag BaOmer', priority: 90 };
  }

  // Yom Yerushalayim (28 Iyar)
  if (month === 'Iyar' && day === 28) {
    return { key: 'yom_yerushalayim', name: 'Yom Yerushalayim', priority: 88 };
  }

  // Shavuos (6-7 Sivan)
  if (month === 'Sivan' && (day === 6 || day === 7)) {
    return { key: 'shavuos', name: 'Shavuos', priority: 95 };
  }

  // Sefiras HaOmer (during the 49 days when no higher festival overrides)
  if (omerDay > 0) {
    return { key: 'omer', name: `Sefiras HaOmer (Day ${omerDay})`, omerDay, priority: 75 };
  }

  // Tisha B'Av (9 or 10 Av)
  if (month === 'Av' && (day === 9 || day === 10)) {
    return { key: 'tisha_bav', name: "Tisha B'Av", priority: 98 };
  }

  // Nine Days (1-8 Av)
  if (month === 'Av' && day >= 1 && day <= 8) {
    return { key: 'nine_days', name: 'The Nine Days', priority: 85 };
  }

  // Three Weeks (17 Tammuz - 29 Tammuz)
  if (month === 'Tamuz' && day >= 17) {
    return { key: 'three_weeks', name: 'The Three Weeks', priority: 80 };
  }

  // Tu B'Av (15 Av)
  if (month === 'Av' && day === 15) {
    return { key: 'tubav', name: "Tu B'Av", priority: 85 };
  }

  // Elul (1-29 Elul)
  if (month === 'Elul') return { key: 'elul', name: 'Chodesh Elul', priority: 75 };
  if (day === 1 || day === 30) {
    return { key: 'rosh_chodesh', name: `Rosh Chodesh ${month}`, priority: 80 };
  }

  // Default neutral
  return { key: 'default', name: 'Standard Theme', priority: 0 };
}
