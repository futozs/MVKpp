/**
 * Magyar naptár: munkaszüneti napok, tanítási napok és a „naptípus”.
 * A naptípus a menetrend-fallback és a késés-előrejelzés kulcsa: a hétfő
 * reggeli csúcs más, mint a szombati, és a tanítási nap más, mint a szünet.
 */
import { isoDow, isoOfUtcDate, shiftIso } from "./time.ts";

function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoOfUtcDate(new Date(Date.UTC(year, month - 1, day)));
}

const holidayCache = new Map<number, Map<string, string>>();

export function hungarianHolidays(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const e = easterSunday(year);
  const out = new Map<string, string>([
    [`${year}-01-01`, "Újév"],
    [`${year}-03-15`, "Nemzeti ünnep"],
    [`${year}-05-01`, "A munka ünnepe"],
    [`${year}-08-20`, "Államalapítás ünnepe"],
    [`${year}-10-23`, "Nemzeti ünnep"],
    [`${year}-11-01`, "Mindenszentek"],
    [`${year}-12-24`, "Szenteste"],
    [`${year}-12-25`, "Karácsony"],
    [`${year}-12-26`, "Karácsony másnapja"],
    [shiftIso(e, -2), "Nagypéntek"],
    [e, "Húsvétvasárnap"],
    [shiftIso(e, 1), "Húsvéthétfő"],
    [shiftIso(e, 49), "Pünkösdvasárnap"],
    [shiftIso(e, 50), "Pünkösdhétfő"],
  ]);
  holidayCache.set(year, out);
  return out;
}

export function holidayName(iso: string): string | null {
  return hungarianHolidays(Number(iso.slice(0, 4))).get(iso) ?? null;
}

/** Hozzávetőleges tanítási nap (őszi, téli, tavaszi szünet és nyári szünet nélkül). */
export function isSchoolDay(iso: string): boolean {
  const dow = isoDow(iso);
  if (dow >= 6 || holidayName(iso)) return false;
  const md = Number(iso.slice(5, 7)) * 100 + Number(iso.slice(8, 10));
  if (md > 615 && md < 901) return false; // nyári szünet
  if (md >= 1222 || md <= 102) return false; // téli szünet
  if (md >= 1026 && md <= 1103) return false; // őszi szünet (közelítés)
  const e = easterSunday(Number(iso.slice(0, 4)));
  if (iso >= shiftIso(e, -4) && iso <= shiftIso(e, 2)) return false; // tavaszi szünet
  return true;
}

/** 0 = munkanap, 1 = szombat, 2 = vasárnap / munkaszüneti nap */
export type DayType = 0 | 1 | 2;

export function dayType(iso: string): DayType {
  if (holidayName(iso)) return 2;
  const dow = isoDow(iso);
  return dow === 7 ? 2 : dow === 6 ? 1 : 0;
}

export type DayInfo = {
  iso: string;
  dow: number;
  daytype: DayType;
  school: boolean;
  holiday: string | null;
};

export function dayInfo(iso: string): DayInfo {
  return {
    iso,
    dow: isoDow(iso),
    daytype: dayType(iso),
    school: isSchoolDay(iso),
    holiday: holidayName(iso),
  };
}

/**
 * Mennyire hasonlít két nap menetrendi szempontból (kisebb = jobb).
 * A fallback ez alapján választ „sablon-napot” egy olyan napra, amelyre az
 * MVK nem adott ki menetrendet.
 */
export function daySimilarity(a: DayInfo, b: DayInfo): number {
  let score = 0;
  if (a.daytype !== b.daytype) score += 100;
  if (a.school !== b.school) score += 10;
  if (a.dow !== b.dow) score += 1;
  return score;
}
