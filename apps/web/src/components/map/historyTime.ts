/**
 * Időkezelés az idővonalhoz. Minden kijelzés Europe/Budapest szerint megy,
 * függetlenül a böngésző saját időzónájától. A forgalmi nap 03:00-tól a
 * következő nap 03:00-ig tart (GTFS 03:00–27:00).
 */

export const TZ = "Europe/Budapest";
export const SERVICE_DAY_START_HOUR = 3;
const HOUR = 3600;

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const clockFmt = new Intl.DateTimeFormat("hu-HU", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const clockShortFmt = new Intl.DateTimeFormat("hu-HU", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dayLabelFmt = new Intl.DateTimeFormat("hu-HU", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  weekday: "long",
});

const hourFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  hourCycle: "h23",
});

interface ZonedParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function zonedParts(unix: number): ZonedParts {
  const out: ZonedParts = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of partsFmt.formatToParts(unix * 1000)) {
    const n = Number(p.value);
    if (p.type === "year") out.y = n;
    else if (p.type === "month") out.mo = n;
    else if (p.type === "day") out.d = n;
    else if (p.type === "hour") out.h = n;
    else if (p.type === "minute") out.mi = n;
    else if (p.type === "second") out.s = n;
  }
  return out;
}

/** A budapesti falióra eltérése az UTC-től az adott pillanatban, másodpercben. */
function offsetAt(unix: number): number {
  const p = zonedParts(unix);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000 - unix;
}

function parseDay(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

/** Budapesti falióra (nap + óra) → unix másodperc, nyári időszámítással együtt. */
export function zonedUnix(day: string, hour: number): number {
  const [y, m, d] = parseDay(day);
  const wall = Date.UTC(y, m - 1, d, hour) / 1000;
  let t = wall - offsetAt(wall);
  const corrected = wall - offsetAt(t);
  if (corrected !== t) t = corrected;
  return t;
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export interface ServiceDayRange {
  day: string;
  start: number;
  end: number;
}

export function serviceDayRange(day: string): ServiceDayRange {
  return {
    day,
    start: zonedUnix(day, SERVICE_DAY_START_HOUR),
    end: zonedUnix(addDays(day, 1), SERVICE_DAY_START_HOUR),
  };
}

/** Melyik forgalmi napba esik a pillanat (03:00 előtt még az előző nap). */
export function serviceDayOf(unix: number): string {
  const p = zonedParts(unix - SERVICE_DAY_START_HOUR * HOUR);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Az összes nap a két határ között, a legújabbal kezdve. */
export function daysBetweenDesc(min: string, max: string): string[] {
  const out: string[] = [];
  let day = max;
  // Védőkorlát: egy hibás válasz se pörgethessen végtelen ciklust.
  for (let i = 0; i < 400 && day >= min; i++) {
    out.push(day);
    day = addDays(day, -1);
  }
  return out;
}

export const formatClock = (unix: number): string =>
  clockFmt.format(unix * 1000);

export const formatClockShort = (unix: number): string =>
  clockShortFmt.format(unix * 1000);

const dayLabelShortFmt = new Intl.DateTimeFormat("hu-HU", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  weekday: "short",
});

/** "okt. 20., kedd" (rövid: "okt. 20., K") — délben, hogy a DST ne csússzon bele. */
export const formatDayLabel = (day: string, short = false): string =>
  (short ? dayLabelShortFmt : dayLabelFmt).format(zonedUnix(day, 12) * 1000);

/** A pillanat naptári napja — éjfél után már a következő nap neve. */
export const formatDateOf = (unix: number): string =>
  dayLabelFmt.format(unix * 1000);

export interface HourTick {
  t: number;
  label: string;
}

/** Óránkénti jelölők a forgalmi napra (DST-napon 23 vagy 25 darab). */
export function hourTicks(range: ServiceDayRange): HourTick[] {
  const ticks: HourTick[] = [];
  for (let t = range.start; t <= range.end; t += HOUR) {
    ticks.push({ t, label: hourFmt.format(t * 1000) });
  }
  return ticks;
}
