import type {
  JourneyLeg,
  JourneyTransitLeg,
  JourneyTrip,
} from "@/services/api";
import { withHungarianSuffix } from "@/lib/utils";
import { serverNow } from "@/lib/realtime";

/** Ennél kisebb eltérést „pontos”-nak mondunk. */
export const ON_TIME_SEC = 60;


/* ------------------------------------------------------------ idő ----- */

/* Minden idő Budapest szerint (a menetrenddel egyezően), a készülék időzónájától függetlenül. */
const TZ = "Europe/Budapest";
const HM_FMT = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const HMS_FMT = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const DATE_FMT = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** A backend UTC-ben küldi az időket — budapesti idő szerint írjuk ki. */
export function hm(input: string | number): string {
  const d = typeof input === "number" ? new Date(input * 1000) : new Date(input);
  return HM_FMT.format(d);
}

export function hms(unix: number): string {
  return HMS_FMT.format(new Date(unix * 1000));
}

export function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export function minutes(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))} perc`;
}

/** Budapesti naptári nap (YYYY-MM-DD); unix másodpercből vagy ISO-ból, vagy ma (a szerver órája szerint). */
export function localIsoDate(input?: number | string): string {
  const d =
    input == null
      ? new Date(serverNow() * 1000)
      : typeof input === "number"
        ? new Date(input * 1000)
        : new Date(input);
  return DATE_FMT.format(d);
}

export function todayLocalIso(): string {
  return localIsoDate();
}

export function nowLocalTime(): string {
  return HM_FMT.format(new Date(serverNow() * 1000));
}

/** „2026. október 20., kedd” */
export function longDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("hu-HU", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

/** Napnév -i képzős alakja: 1-jei, 2-ai, 12-ei, 28-ai … */
function daySuffix(day: number): string {
  if (day === 1) return "jei";
  if (day === 2) return "ai";
  if (day % 10 === 0) return day === 10 ? "ei" : "ai";
  return [3, 6, 8].includes(day % 10) ? "ai" : "ei";
}

/** „a 2026. október 28-ai” — névelővel együtt, mondatba illesztéshez. */
export function dateAdjective(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  const month = d.toLocaleDateString("hu-HU", { month: "long" });
  return `a ${d.getFullYear()}. ${month} ${d.getDate()}-${daySuffix(d.getDate())}`;
}

/* --------------------------------------------------------- késés ----- */

export type Tone = "late" | "early" | "ontime" | "unknown";

export function toneOf(sec: number | null | undefined): Tone {
  if (sec == null) return "unknown";
  if (Math.abs(sec) < ON_TIME_SEC) return "ontime";
  return sec > 0 ? "late" : "early";
}

export const TONE_TEXT: Record<Tone, string> = {
  late: "text-late",
  early: "text-early",
  ontime: "text-ontime",
  unknown: "text-muted-foreground",
};

/** Előrejelzéshez: „+2 p késés” / „pontos” / „−1 p korábban”. */
export function delayForecast(sec: number): string {
  const tone = toneOf(sec);
  if (tone === "ontime") return "pontos";
  const m = Math.round(Math.abs(sec) / 60);
  return tone === "late" ? `+${m} p késés` : `−${m} p korábban`;
}

/** Rövid előjeles eltérés: „+4 p”, „−58 mp”, „±0”. */
export function delayShort(sec: number): string {
  if (sec === 0) return "±0";
  const sign = sec > 0 ? "+" : "−";
  const abs = Math.abs(sec);
  return abs < 60 ? `${sign}${abs} mp` : `${sign}${Math.round(abs / 60)} p`;
}

/** Másodpercre pontos hossz: „4 p 41 mp”, „58 mp”. */
export function spanExact(sec: number): string {
  const abs = Math.abs(Math.round(sec));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  if (!m) return `${s} mp`;
  return s ? `${m} p ${s} mp` : `${m} p`;
}

/** Igazoláshoz: „+4 p 41 mp”, „−58 mp”, „pontosan”. */
export function delayExact(sec: number): string {
  if (sec === 0) return "pontosan";
  return `${sec > 0 ? "+" : "−"}${spanExact(sec)}`;
}

/** Átszállási tartalék percben (lefelé kerekítve), 1 perc alatt mp-ben. */
export function marginText(sec: number): string {
  const abs = Math.abs(sec);
  return abs < 60 ? `${abs} mp` : `${Math.floor(abs / 60)} p`;
}

/* ----------------------------------------------------- nyelvtan ----- */

/** Számjeggyel írt szó elé „a” vagy „az” (egy, öt, ezer → az). */
function articleFor(numeric: string): "a" | "az" {
  const first = numeric[0];
  if (first === "5") return "az";
  if (first === "1" && [1, 4, 7].includes(numeric.length)) return "az";
  return "a";
}

export const MODE_NOUN: Record<JourneyTransitLeg["mode"], string> = {
  BUS: "busz",
  TRAM: "villamos",
};

const MODE_INSTRUMENTAL: Record<JourneyTransitLeg["mode"], string> = {
  BUS: "busszal",
  TRAM: "villamossal",
};

/** „az 1653-as busszal” / „a 608-as villamossal” */
export function vehiclePhrase(
  id: string,
  mode: JourneyTransitLeg["mode"],
): string {
  if (/^[1-9]\d*$/.test(id)) {
    return `${articleFor(id)} ${withHungarianSuffix(id)} ${MODE_INSTRUMENTAL[mode]}`;
  }
  return `a(z) ${id} jelű ${MODE_INSTRUMENTAL[mode]}`;
}

/* ------------------------------------------------------ itiner ----- */

export function isTransit(leg: JourneyLeg): leg is JourneyTransitLeg {
  return leg.mode !== "WALK";
}

export function transitLegs(trip: JourneyTrip): JourneyTransitLeg[] {
  return trip.legs.filter(isTransit);
}

/** Az utolsó járműről leszállás utáni gyaloglás hossza (mp). */
export function trailingWalkSec(trip: JourneyTrip): number {
  let sum = 0;
  for (let i = trip.legs.length - 1; i >= 0; i--) {
    const leg = trip.legs[i];
    if (isTransit(leg)) break;
    sum += leg.durationSec;
  }
  return sum;
}

export function walkTotalSec(trip: JourneyTrip): number {
  return trip.legs.reduce(
    (s, l) => (isTransit(l) ? s : s + l.durationSec),
    0,
  );
}

export function transfersLabel(n: number): string {
  return n === 0 ? "átszállás nélkül" : `${n} átszállás`;
}
