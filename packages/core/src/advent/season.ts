/**
 * Az adventi villamos évadjai adatként: a jármű, a vonal megállói a
 * plakát menetidejével, a négy naptípus indulásai és a kivételnapok. Egy új
 * évad (2027, 2028) egy újabb bejegyzés a SEASONS listában, nem új kód.
 */
import { holidayName } from "../calendar.ts";
import { isoDow, localMidnightUnix, shiftIso } from "../time.ts";

/** a két végállomás: innen indul a menet */
export type AdventEnd = "tiszai" | "majlath";
export type AdventDayType = "school" | "break" | "saturday" | "sunday";

export type AdventStop = {
  /** a plakát neve */
  name: string;
  /** a GTFS megálló-azonosítója Tiszai pu. → Felső-Majláth irányban */
  out: string;
  /** … és Felső-Majláth → Tiszai pu. irányban */
  back: string;
  /** menetidő percben a Tiszai pu.-tól (oda) */
  outMin: number;
  /** menetidő percben a Felső-Majláthtól (vissza) */
  backMin: number;
};

type Departures = Record<AdventEnd, string[]>;

export type AdventDayRule = {
  type: AdventDayType;
  /** a naptípus indulásai helyett ezek (rövidített vagy csak délutáni nap) */
  only?: Departures;
  /** rövid magyarázat a napról (pl. „Régiségvásár, csak délután”) */
  note?: string;
};

export type AdventSeason = {
  /** az évad azonosítója: a kezdés éve */
  year: number;
  /** hányadik adventi villamos */
  edition: number;
  title: string;
  /** a szerelvény pályaszáma(i): ezeket mindig az évadhoz rögzítjük */
  vehicleIds: string[];
  /** az MVK GTFS-vonala (2026: „ADV”, a feedben buszként, route_type 704) */
  routeShorts: string[];
  /** a vonal GTFS-nyomvonalai: a valós idejű trip_id (<service>_<shape>_<HHMMSS>_<kód>) ebből is felismerhető, ha a menet még nincs a betöltött feedben */
  shapeIds: { out: string; back: string };
  start: string;
  end: string;
  /** a szerelvény jellemzői a nézethez */
  facts: { lowFloor: boolean; fare: string };
  stops: AdventStop[];
  timetables: Record<AdventDayType, Departures>;
  /** a naptípus a közönséges szabálytól eltérő napokra */
  days: Record<string, AdventDayRule>;
  /** a munkanapok közül ezek tanítási napok (a többi szünnap) */
  schoolSpans: [string, string][];
};

const STOPS_LINE_1: AdventStop[] = [
  { name: "Tiszai pályaudvar", out: "SP475", back: "SP476", outMin: 0, backMin: 33 },
  { name: "Selyemrét", out: "SP479", back: "SP480", outMin: 2, backMin: 32 },
  { name: "Soltész Nagy Kálmán utca", out: "SP481", back: "SP482", outMin: 4, backMin: 30 },
  { name: "Szinvapark / Centrum", out: "SP483", back: "SP484", outMin: 7, backMin: 28 },
  { name: "Villanyrendőr", out: "SP485", back: "SP486", outMin: 8, backMin: 25 },
  { name: "Városház tér", out: "SP487", back: "SP488", outMin: 10, backMin: 23 },
  { name: "Malomszög utca", out: "SP489", back: "SP490", outMin: 12, backMin: 21 },
  { name: "Szent Anna tér", out: "SP491", back: "SP492", outMin: 13, backMin: 20 },
  { name: "Thököly utca", out: "SP493", back: "SP494", outMin: 15, backMin: 19 },
  { name: "Balázs Győző tér", out: "SP495", back: "SP496", outMin: 16, backMin: 17 },
  { name: "Gyula utca", out: "SP497", back: "SP498", outMin: 17, backMin: 16 },
  { name: "Károly utca", out: "SP499", back: "SP500", outMin: 19, backMin: 15 },
  { name: "Újgyőri főtér", out: "SP501", back: "SP502", outMin: 20, backMin: 13 },
  { name: "Újgyőri piac", out: "SP504", back: "SP505", outMin: 22, backMin: 11 },
  { name: "DVTK Stadion", out: "SP507", back: "SP508", outMin: 23, backMin: 10 },
  { name: "Bulgárföld", out: "SP509", back: "SP510", outMin: 24, backMin: 9 },
  { name: "Diósgyőri Gimnázium", out: "SP511", back: "SP512", outMin: 26, backMin: 7 },
  { name: "LÁEV (kisvasút)", out: "SP513", back: "SP514", outMin: 27, backMin: 6 },
  { name: "Zenta utca", out: "SP515", back: "SP516", outMin: 28, backMin: 5 },
  { name: "Diósgyőr városközpont", out: "SP519", back: "SP624", outMin: 29, backMin: 4 },
  { name: "Bölcs utca", out: "SP619", back: "SP623", outMin: 31, backMin: 3 },
  { name: "Alsó-Majláth", out: "SP620", back: "SP622", outMin: 32, backMin: 2 },
  { name: "Felső-Majláth", out: "SP621", back: "SP3281", outMin: 33, backMin: 0 },
];

const AFTERNOON_ONLY: Departures = { tiszai: ["16:15", "17:45", "19:05"], majlath: ["17:00", "18:25", "19:50"] };

export const SEASONS: AdventSeason[] = [
  {
    year: 2026,
    edition: 15,
    title: "Advent Expressz",
    vehicleIds: ["202"],
    routeShorts: ["ADV"],
    shapeIds: { out: "1880", back: "1881" },
    start: "2026-11-29",
    end: "2027-01-06",
    facts: { lowFloor: false, fare: "normál díjszabás, vonaljeggyel vagy bérlettel" },
    stops: STOPS_LINE_1,
    timetables: {
      school: {
        tiszai: ["10:22", "11:47", "13:18", "14:45", "16:15", "17:45", "19:05"],
        majlath: ["11:05", "12:35", "14:03", "15:30", "17:00", "18:25", "19:50"],
      },
      break: {
        tiszai: ["10:26", "11:45", "13:15", "14:47", "16:17", "17:45", "19:05"],
        majlath: ["11:03", "12:30", "14:00", "15:30", "17:00", "18:26", "19:50"],
      },
      saturday: {
        tiszai: ["10:22", "11:45", "13:15", "14:45", "16:15", "17:45", "19:05"],
        majlath: ["11:05", "12:35", "14:05", "15:30", "17:00", "18:25", "19:50"],
      },
      sunday: {
        tiszai: ["10:22", "11:45", "13:15", "14:45", "16:15", "17:45", "19:05"],
        majlath: ["11:03", "12:30", "14:00", "15:30", "17:00", "18:25", "19:50"],
      },
    },
    days: {
      "2026-11-29": { type: "sunday", only: { tiszai: ["17:20", "18:50"], majlath: ["18:10", "19:30"] }, note: "Első nap" },
      "2026-12-06": { type: "sunday", only: AFTERNOON_ONLY, note: "Régiségvásár, csak délután" },
      "2026-12-24": { type: "sunday", only: { tiszai: ["10:22", "11:45"], majlath: ["11:03", "12:30"] }, note: "Szenteste, csak délelőtt" },
      "2026-12-25": { type: "sunday", note: "Karácsony" },
      "2026-12-26": { type: "sunday", note: "Karácsony" },
      "2026-12-31": { type: "break", only: { tiszai: ["10:26", "11:45"], majlath: ["11:03", "12:30"] }, note: "Szilveszter, csak délelőtt" },
      "2027-01-01": { type: "sunday", only: { tiszai: ["14:45", "16:15", "17:45", "19:05"], majlath: ["15:30", "17:00", "18:25", "19:50"] }, note: "Újév, csak délután" },
      "2027-01-03": { type: "sunday", only: AFTERNOON_ONLY, note: "Régiségvásár, csak délután" },
    },
    schoolSpans: [
      ["2026-11-30", "2026-12-18"],
      ["2027-01-04", "2027-01-06"],
    ],
  },
];

/** a valós idejű trip_id az évad egy menete-e (az ADV-nyomvonalak alapján, feed nélkül is) */
export function isAdventTripId(season: AdventSeason, rtTripId: string | null | undefined): boolean {
  if (!rtTripId) return false;
  const shape = rtTripId.split("_")[1];
  return shape === season.shapeIds.out || shape === season.shapeIds.back;
}

/** az évad járműve-e: a pályaszám, az ADV vonal vagy az ADV-nyomvonalú menet alapján */
export function isAdventVehicle(season: AdventSeason, v: { id: string; routeShort?: string | null; rtTripId?: string | null }): boolean {
  return season.vehicleIds.includes(v.id) || (v.routeShort != null && season.routeShorts.includes(v.routeShort)) || isAdventTripId(season, v.rtTripId);
}

/**
 * A szerelvényt a nézetek villamosként, az ADV jelvénnyel mutassák akkor is, ha az MVK
 * vonal nélkül vagy buszként küldi (a menete még nincs a betöltött feedben).
 */
export function markAdventVehicles(decoded: { id: string; routeId: string; routeShort: string; routeColor: string; routeText: string; tripId: string; rtTripId?: string; mode?: string }[], iso: string): void {
  const season = seasonOn(iso) ?? latestSeason(iso);
  for (const v of decoded) {
    if (!isAdventVehicle(season, { id: v.id, routeShort: v.routeShort, rtTripId: v.rtTripId ?? v.tripId })) continue;
    v.mode = "tram";
    // menetrendi kör nélkül (remízmenet, próbaút) a saját pályaszámán marad, vonal nélkül
    if (seasonOn(iso) && (!v.routeShort || isAdventTripId(season, v.rtTripId ?? v.tripId))) {
      v.routeShort = season.routeShorts[0];
      v.routeColor = ADVENT_COLORS.bg;
      v.routeText = ADVENT_COLORS.fg;
    }
  }
}

/** a jelvény színei (az ADV vonal GTFS-színe) */
export const ADVENT_COLORS = { bg: "FFDD00", fg: "000000" };

export function seasonOf(year: number): AdventSeason | null {
  return SEASONS.find((s) => s.year === year) ?? null;
}

/** az évad, amelyhez a nap tartozik (a szezonon kívül null) */
export function seasonOn(iso: string): AdventSeason | null {
  return SEASONS.find((s) => iso >= s.start && iso <= s.end) ?? null;
}

/** a legutóbbi évad, amely a napon már elkezdődött (szezonon kívül is: a nézet ezt mutatja) */
export function latestSeason(iso: string): AdventSeason {
  const started = SEASONS.filter((s) => s.start <= iso).sort((a, b) => b.year - a.year);
  return started[0] ?? [...SEASONS].sort((a, b) => a.year - b.year)[0];
}

export function seasonDays(season: AdventSeason): string[] {
  const out: string[] = [];
  for (let d = season.start; d <= season.end; d = shiftIso(d, 1)) out.push(d);
  return out;
}

export type AdventTripPlan = {
  /** a nap menetei sorban: 0, 1, 2… */
  n: number;
  from: AdventEnd;
  /** indulás a végállomásról, unix */
  dep: number;
  /** érkezés a másik végállomásra, unix */
  arr: number;
  /** megállónként a menetrend szerinti idő (unix), a menet sorrendjében */
  stopTimes: number[];
};

export type AdventDayPlan = {
  iso: string;
  type: AdventDayType;
  note: string | null;
  /** eltér a naptípus szokásos menetrendjétől */
  special: boolean;
  trips: AdventTripPlan[];
};

function hmToSec(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 3600 + m * 60;
}

export function dayTypeOf(season: AdventSeason, iso: string): AdventDayType {
  const rule = season.days[iso];
  if (rule) return rule.type;
  const dow = isoDow(iso);
  if (dow === 7 || holidayName(iso)) return "sunday";
  if (dow === 6) return "saturday";
  return season.schoolSpans.some(([a, b]) => iso >= a && iso <= b) ? "school" : "break";
}

/** A menet megállóinak sorrendje (indexek a season.stops-ban) az indulási végállomás szerint. */
export function stopOrder(season: AdventSeason, from: AdventEnd): number[] {
  const idx = season.stops.map((_, i) => i);
  return from === "tiszai" ? idx : idx.reverse();
}

/** A nap menetrendje; null, ha a nap nincs az évadban. */
export function dayPlan(season: AdventSeason, iso: string): AdventDayPlan | null {
  if (iso < season.start || iso > season.end) return null;
  const type = dayTypeOf(season, iso);
  const rule = season.days[iso];
  const deps = rule?.only ?? season.timetables[type];
  const midnight = localMidnightUnix(iso);
  const rows: { from: AdventEnd; s: number }[] = [];
  for (const from of ["tiszai", "majlath"] as const) for (const hm of deps[from]) rows.push({ from, s: hmToSec(hm) });
  rows.sort((a, b) => a.s - b.s);
  const trips = rows.map(({ from, s }, n) => {
    const dep = midnight + s;
    const order = stopOrder(season, from);
    const stopTimes = order.map((i) => dep + (from === "tiszai" ? season.stops[i].outMin : season.stops[i].backMin) * 60);
    return { n, from, dep, arr: stopTimes[stopTimes.length - 1], stopTimes };
  });
  return { iso, type, note: rule?.note ?? null, special: Boolean(rule?.only), trips };
}

export const DAY_TYPE_LABEL: Record<AdventDayType, string> = {
  school: "Tanítási munkanap",
  break: "Tanszüneti munkanap",
  saturday: "Szombat",
  sunday: "Vasárnap, ünnep",
};

export const END_LABEL: Record<AdventEnd, string> = { tiszai: "Tiszai pályaudvar", majlath: "Felső-Majláth" };
