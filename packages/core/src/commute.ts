/**
 * A szokásos utazás felismerése az utazásnaplóból: ugyanaz a vonal, ugyanarról
 * a megállóról, nagyjából ugyanakkor (munkanapon vagy hétvégén) — legalább
 * három külön napon az elmúlt hat hétben. Beállítani nem kell semmit: a
 * Figyelő ebből tudja, mire vagy kíváncsi reggel.
 *
 * Egy héten több szokás is lehet (pl. szerdán-csütörtökön 6:18, a többi
 * munkanapon 6:51): külön szokásként tanuljuk, és megjegyezzük, a hét mely
 * napjain fordult elő — azon a napon az jön elő, amelyik aznap szokásos.
 * A körbeutazás (ülve maradva a következő menetre) egy út: az első felszállás számít.
 */
import { dayInfo } from "./calendar.ts";
import { budapestOffsetSec, isoDow } from "./time.ts";

export const COMMUTE = {
  /** ennyi napra visszamenőleg nézzük a naplót */
  LOOKBACK_DAYS: 42,
  /** legalább ennyi utazás… */
  MIN_RIDES: 3,
  /** …legalább ennyi különböző napon */
  MIN_DAYS: 3,
  /** ennyi percen belül egymást követő felszállások egy szokásnak számítanak (a busz késése ±5 perc) */
  GAP_MIN: 12,
  /** ennyi különböző hétköznapon látott munkanapi szokás „minden munkanap” (nem csak bizonyos napokon) */
  DAILY_WORKDAYS: 4,
  /** ennyivel a szokásos idő előtt jelenik meg a kártya (perc) */
  SHOW_BEFORE_MIN: 90,
  /** és utána még ennyi ideig (perc) */
  SHOW_AFTER_MIN: 15,
} as const;

export type DayKind = "workday" | "weekend";

export type CommuteRide = {
  route: string;
  headsign: string;
  color?: string;
  text?: string;
  fromStopId: string | null;
  fromStopName: string | null;
  toStopName: string | null;
  boardedAt: number;
  serviceDate: string;
  /** körbeutazás: az egymás után, ülve maradva megtett menetek közös azonosítója */
  chainId?: string | null;
};

export type Commute = {
  key: string;
  route: string;
  headsign: string;
  color: string;
  text: string;
  fromStopId: string;
  fromStopName: string;
  toStopName: string | null;
  dayKind: DayKind;
  /** a szokásos felszállás ideje (budapesti perc, 0–1439) */
  minute: number;
  /** a felszállások szórása (legkorábbi–legkésőbbi, perc) */
  spreadMin: number;
  rides: number;
  days: number;
  lastAt: number;
  /** a hét mely napjain fordult elő (ISO: 1 = hétfő … 7 = vasárnap) */
  dows: number[];
  /** minden ilyen napon (munkanapon / hétvégén) szokásos, nem csak bizonyos napokon */
  daily: boolean;
  /** körbeutazás: a felszállás után a végállomáson ülve maradt a következő menetre */
  loop: boolean;
};

export function dayKindOf(iso: string): DayKind {
  return dayInfo(iso).daytype === 0 ? "workday" : "weekend";
}

export function budapestMinute(unix: number): number {
  return Math.floor(((((unix + budapestOffsetSec(unix)) % 86_400) + 86_400) % 86_400) / 60);
}

const mostCommon = <T>(xs: T[]): T => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/** A körbeutazás menetei egy útnak számítanak: az első felszállás, a legutolsó leszállás. */
function mergeChains(rides: readonly CommuteRide[]): (CommuteRide & { loop: boolean })[] {
  const chains = new Map<string, CommuteRide[]>();
  const out: (CommuteRide & { loop: boolean })[] = [];
  for (const r of rides) {
    if (!r.chainId) out.push({ ...r, loop: false });
    else chains.set(r.chainId, [...(chains.get(r.chainId) ?? []), r]);
  }
  for (const legs of chains.values()) {
    const sorted = [...legs].sort((a, b) => a.boardedAt - b.boardedAt);
    out.push({ ...sorted[0], toStopName: sorted[sorted.length - 1].toStopName, loop: sorted.length > 1 });
  }
  return out;
}

export function detectCommutes(rides: readonly CommuteRide[], nowUnix: number): Commute[] {
  const since = nowUnix - COMMUTE.LOOKBACK_DAYS * 86_400;
  const groups = new Map<string, (CommuteRide & { minute: number; loop: boolean })[]>();
  for (const r of mergeChains(rides)) {
    if (!r.fromStopId || r.boardedAt < since || r.boardedAt > nowUnix) continue;
    const key = `${r.route}|${r.fromStopId}|${dayKindOf(r.serviceDate)}`;
    const list = groups.get(key) ?? [];
    list.push({ ...r, minute: budapestMinute(r.boardedAt) });
    groups.set(key, list);
  }

  const out: Commute[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.minute - b.minute);
    let cluster: typeof list = [];
    const flush = () => {
      const days = new Set(cluster.map((r) => r.serviceDate)).size;
      if (cluster.length >= COMMUTE.MIN_RIDES && days >= COMMUTE.MIN_DAYS) {
        const mins = cluster.map((r) => r.minute);
        const latest = cluster.reduce((a, b) => (b.boardedAt > a.boardedAt ? b : a));
        const dows = [...new Set(cluster.map((r) => isoDow(r.serviceDate)))].sort((a, b) => a - b);
        const kind = dayKindOf(latest.serviceDate);
        out.push({
          key: `${key}|${mins[mins.length >> 1]}`,
          route: latest.route,
          headsign: mostCommon(cluster.map((r) => r.headsign)),
          color: latest.color ?? "1FB574",
          text: latest.text ?? "FFFFFF",
          fromStopId: latest.fromStopId!,
          fromStopName: latest.fromStopName ?? latest.fromStopId!,
          toStopName: mostCommon(cluster.map((r) => r.toStopName)),
          dayKind: kind,
          minute: mins[mins.length >> 1],
          spreadMin: mins[mins.length - 1] - mins[0],
          rides: cluster.length,
          days,
          lastAt: latest.boardedAt,
          dows,
          // hétvégén csak két nap van: ha mindkettőn láttuk, az „minden hétvégén”
          daily: kind === "workday" ? dows.length >= COMMUTE.DAILY_WORKDAYS : dows.length >= 2,
          loop: cluster.filter((r) => r.loop).length * 2 >= cluster.length,
        });
      }
      cluster = [];
    };
    for (const r of list) {
      if (cluster.length && r.minute - cluster[cluster.length - 1].minute > COMMUTE.GAP_MIN) flush();
      cluster.push(r);
    }
    flush();
  }
  return out.sort((a, b) => b.rides - a.rides || b.lastAt - a.lastAt);
}

/** Aznap szokásos-e: minden ilyen napon, vagy épp a hét ezen a napján láttuk. */
export function commuteToday(c: Commute, todayIso: string): boolean {
  return c.dayKind === dayKindOf(todayIso) && (c.daily || c.dows.includes(isoDow(todayIso)));
}

/**
 * Melyik szokásos utazás aktuális most (ami aznap szokásos, a szokásos idő előtt
 * legfeljebb másfél órával, utána negyed óráig) — a legközelebbi.
 */
export function upcomingCommute(commutes: readonly Commute[], nowUnix: number, todayIso: string): Commute | null {
  const now = budapestMinute(nowUnix);
  let best: Commute | null = null;
  let bestD = Infinity;
  for (const c of commutes) {
    if (!commuteToday(c, todayIso)) continue;
    const d = c.minute - now;
    if (d > COMMUTE.SHOW_BEFORE_MIN || d < -COMMUTE.SHOW_AFTER_MIN) continue;
    if (Math.abs(d) < bestD) {
      best = c;
      bestD = Math.abs(d);
    }
  }
  return best;
}
