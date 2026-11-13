/**
 * Várható vágány (kocsiállás), amíg a MÁV nem adta ki: a korábbi napok megfigyeléseiből.
 *
 * Két szint: (1) ugyanez a menet ezen az állomáson  a MÁV menetazonosítói naponta
 * ismétlődnek, így „az 5139-es Tiszain a 6-osról megy” közvetlenül kiolvasható; (2) ha erről
 * a menetről még nincs elég mérés, ugyanennek a vonalnak az ugyanabba az irányba (ugyanarra
 * a végállomásra) induló menetei ezen az állomáson, a mai nap kiadott vágányaival együtt.
 * Csak akkor jósol, ha a megfigyelések egyértelműek  egy bizonytalan tipp rosszabb a semminél.
 */
import type { Feed } from "../gtfs/feed.ts";
import { stationKeyOf } from "./modes.ts";

/** vágány → hány megfigyelés (napok vagy menetek) */
export type PlatformCounts = ReadonlyMap<string, number>;

/** A menet saját előzménye: legalább ennyi nap, ekkora többséggel. */
export const OWN_PLATFORM = { minN: 2, minShare: 0.6 } as const;
/** A vonal (irány) előzménye: legalább ennyi menet, ekkora többséggel. */
export const LINE_PLATFORM = { minN: 3, minShare: 0.7 } as const;

/** A leggyakoribb vágány, ha elég mérés van rá és elég nagy a többsége; különben nincs tipp. */
export function pickPlatform(counts: PlatformCounts | undefined, rule: { minN: number; minShare: number }): string | null {
  if (!counts?.size) return null;
  let total = 0;
  let best: [string, number] | null = null;
  for (const [p, n] of counts) {
    total += n;
    if (!best || n > best[1]) best = [p, n];
  }
  return best && best[1] >= rule.minN && best[1] / total >= rule.minShare ? best[0] : null;
}

/** A vonal-szintű kulcs: vonal, a menet végállomása (az irány) és az állomás. */
export function platformLineKey(feed: Feed, tripId: string, station: string): string | null {
  const t = feed.trips.get(tripId);
  const st = feed.tripStops.get(tripId);
  if (!t || !st?.length) return null;
  return `${t.routeId}|${stationKeyOf(st[st.length - 1].stopId)}|${station}`;
}

/** Számláló növelése egy `kulcs → vágány → db` táblában. */
export function bumpPlatform(map: Map<string, Map<string, number>>, key: string, platform: string, n = 1) {
  let m = map.get(key);
  if (!m) map.set(key, (m = new Map()));
  m.set(platform, (m.get(platform) ?? 0) + n);
}
