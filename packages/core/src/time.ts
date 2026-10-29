/**
 * Idő Miskolcon.
 *
 * Két dolgot kell mindenhol egyformán csinálni, különben a napok szétcsúsznak:
 *  1. Az időzóna mindig Europe/Budapest — soha nem a futtató gép TZ-je
 *     (a VPS UTC-ben fut, a régi kód ezt a folyamat TZ-jéből vette).
 *  2. A „szolgáltatási nap” hajnali 3:00-kor fordul, nem éjfélkor: a 24:30-as
 *     GTFS-idő az előző nap menete. A régi megállófigyelő éjfélkor fordult,
 *     ezért éjfél után eltűntek a 24:xx-es menetek.
 */

export const TZ = "Europe/Budapest";
export const SERVICE_DAY_CUTOFF_SEC = 3 * 3600;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** A Budapest–UTC eltérés másodpercben az adott pillanatban (nyári időben 7200). */
export function budapestOffsetSec(atUnix: number = nowUnix()): number {
  const p: Record<string, number> = {};
  for (const x of partsFormatter.formatToParts(new Date(atUnix * 1000))) {
    if (x.type !== "literal") p[x.type] = Number(x.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round(asUtc / 1000 - atUnix);
}

export const nowUnix = () => Math.floor(Date.now() / 1000);

/** "YYYYMMDD" ↔ "YYYY-MM-DD" */
export const ymdToIso = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
export const isoToYmd = (iso: string) => iso.slice(0, 10).replace(/-/g, "");

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Egy UTC-napként kezelt dátum (Date.UTC) → "YYYY-MM-DD". */
export const isoOfUtcDate = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** Naptári dátum eltolása napokkal ("YYYY-MM-DD"). */
export function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoOfUtcDate(d);
}

/**
 * Valódi naptári nap ("YYYY-MM-DD"), legfeljebb `maxDays` nappal a `today`-től
 * (a 2026-02-31-féle és a több évvel arrébb eső dátumok kiszűrésére az API-határon).
 */
export function isPlausibleIso(iso: string, today: string, maxDays = 400): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoOfUtcDate(d) !== iso) return false;
  const t = new Date(`${today}T12:00:00Z`).getTime();
  return Math.abs(d.getTime() - t) <= maxDays * 86_400_000;
}

/** A hét napja ISO szerint (hétfő = 1 … vasárnap = 7). */
export function isoDow(iso: string): number {
  const js = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * A szolgáltatási nap GTFS-referenciapontja unix mp-ben: „helyi dél − 12 óra”
 * (GTFS-szabvány). Hétköznap ez pontosan a helyi éjfél; az óraátállítás
 * napjain egy órával eltér, így a 08:00-s menet akkor is 08:00-kor indul.
 */
export function localMidnightUnix(iso: string): number {
  const utcNoon = Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);
  const noonUnix = utcNoon - budapestOffsetSec(utcNoon - 3600);
  return noonUnix - 43200;
}

export type ServiceClock = {
  unix: number;
  offset: number;
  /** szolgáltatási nap */
  iso: string;
  ymd: string;
  /** a szolgáltatási nap éjfele óta eltelt mp — 3:00 előtt 86400 fölötti */
  secOfDay: number;
  /** a szolgáltatási nap helyi éjfele (unix) */
  midnightUnix: number;
  /** naptári (falióra szerinti) nap */
  calendarIso: string;
};

export function serviceClock(atUnix: number = nowUnix()): ServiceClock {
  const offset = budapestOffsetSec(atUnix);
  const local = atUnix + offset;
  const calSec = ((local % 86400) + 86400) % 86400;
  const calendarIso = isoOfUtcDate(new Date((local - calSec) * 1000));
  const iso = calSec < SERVICE_DAY_CUTOFF_SEC ? shiftIso(calendarIso, -1) : calendarIso;
  const midnightUnix = localMidnightUnix(iso);
  return {
    unix: atUnix,
    offset,
    iso,
    ymd: isoToYmd(iso),
    secOfDay: atUnix - midnightUnix,
    midnightUnix,
    calendarIso,
  };
}

/** Szolgáltatási nap egy unix időpontra ("YYYY-MM-DD"). */
export const serviceDateOf = (unix: number) => serviceClock(unix).iso;

/** GTFS „HH:MM:SS” (24 óra fölötti is lehet) → mp */
export function hmsToSec(t: string): number | null {
  const p = (t || "").trim().split(":");
  if (p.length < 2) return null;
  const n = Number(p[0]) * 3600 + Number(p[1]) * 60 + (p[2] ? Number(p[2]) : 0);
  return Number.isFinite(n) ? n : null;
}

/** Menetrendi mp → "HH:MM" (24 fölött körbefordul, mint a régi API-ban). */
export function secToHm(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
}

/** Unix → helyi "HH:MM" (Budapest). */
export function hmOfUnix(unix: number): string {
  const local = unix + budapestOffsetSec(unix);
  const s = ((local % 86400) + 86400) % 86400;
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}

/** Unix → helyi "HH:MM:SS" (Budapest). */
export function hmsOfUnix(unix: number): string {
  const local = unix + budapestOffsetSec(unix);
  const s = ((local % 86400) + 86400) % 86400;
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** Negyedórás napszak-vödör (0–95) egy unix időpontra, helyi idő szerint. */
export function todBucket(unix: number): number {
  const local = unix + budapestOffsetSec(unix);
  return Math.floor((((local % 86400) + 86400) % 86400) / 900);
}
