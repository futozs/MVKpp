/**
 * A szokásos utazás felismerése az utazásnaplóból: ugyanaz a vonal, ugyanarról
 * a megállóról, nagyjából ugyanakkor (munkanapon vagy hétvégén) — legalább
 * három külön napon az elmúlt hat hétben. Beállítani nem kell semmit: a
 * Figyelő ebből tudja, mire vagy kíváncsi reggel.
 */
import { dayInfo } from "./calendar.ts";
import { budapestOffsetSec } from "./time.ts";

export const COMMUTE = {
  /** ennyi napra visszamenőleg nézzük a naplót */
  LOOKBACK_DAYS: 42,
  /** legalább ennyi utazás… */
  MIN_RIDES: 3,
  /** …legalább ennyi különböző napon */
  MIN_DAYS: 3,
  /** ennyi percen belüli felszállások egy szokásnak számítanak */
  GAP_MIN: 25,
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

export function detectCommutes(rides: readonly CommuteRide[], nowUnix: number): Commute[] {
  const since = nowUnix - COMMUTE.LOOKBACK_DAYS * 86_400;
  const groups = new Map<string, (CommuteRide & { minute: number })[]>();
  for (const r of rides) {
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
        out.push({
          key: `${key}|${mins[mins.length >> 1]}`,
          route: latest.route,
          headsign: mostCommon(cluster.map((r) => r.headsign)),
          color: latest.color ?? "1FB574",
          text: latest.text ?? "FFFFFF",
          fromStopId: latest.fromStopId!,
          fromStopName: latest.fromStopName ?? latest.fromStopId!,
          toStopName: mostCommon(cluster.map((r) => r.toStopName)),
          dayKind: dayKindOf(latest.serviceDate),
          minute: mins[mins.length >> 1],
          spreadMin: mins[mins.length - 1] - mins[0],
          rides: cluster.length,
          days,
          lastAt: latest.boardedAt,
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

/**
 * Melyik szokásos utazás aktuális most (a mai naptípuson, a szokásos idő előtt
 * legfeljebb másfél órával, utána negyed óráig) — a legközelebbi.
 */
export function upcomingCommute(commutes: readonly Commute[], nowUnix: number, todayIso: string): Commute | null {
  const kind = dayKindOf(todayIso);
  const now = budapestMinute(nowUnix);
  let best: Commute | null = null;
  let bestD = Infinity;
  for (const c of commutes) {
    if (c.dayKind !== kind) continue;
    const d = c.minute - now;
    if (d > COMMUTE.SHOW_BEFORE_MIN || d < -COMMUTE.SHOW_AFTER_MIN) continue;
    if (Math.abs(d) < bestD) {
      best = c;
      bestD = Math.abs(d);
    }
  }
  return best;
}
