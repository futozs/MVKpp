/**
 * Körbeutazás: a végállomáson a busz ugyanabból a megállóból indul vissza
 * (fordulóhurok), így aki ülve marad, a következő menettel továbbutazik.
 *
 * A menetrendből derül ki, hol lehetséges: ahol egy vonal érkező menetének
 * utolsó megállója egy induló menetének első megállója (ugyanaz a megálló 
 * pl. 14 Hejőpark, 34 Bodótető, 35 Centrum). Ahol az érkező és az induló
 * kocsiállás különböző (Búza tér, Tiszai pu., Repülőtér), ott a busz
 * átáll, és ott le kell szállni.
 *
 * Két hónap GPS-adata szerint a fordulóhurkos végállomásokon a busz
 * 0–6 perc múlva ugyanonnan indul tovább; a többin 6–25 percet áll, és
 * másik megállóból indul.
 */
import { fastDistM } from "./geo.ts";
import type { Feed } from "./gtfs/feed.ts";

/** ennyire lehet az érkező és az induló azonos nevű megálló (m) */
export const NEARBY_TERMINUS_M = 120;

/**
 * Hogyan folytatja a busz a végállomásról:
 *  · loop    ugyanabból a megállóból indul tovább (ülve maradhatsz)
 *  · nearby  az azonos nevű, szomszédos kocsiállásból indul (átáll)
 */
export type TerminusKind = "loop" | "nearby";

export function terminusKind(feed: Feed, endStopId: string, nextFirstStopId: string): TerminusKind | null {
  if (endStopId === nextFirstStopId) return "loop";
  const a = feed.stops.get(endStopId);
  const b = feed.stops.get(nextFirstStopId);
  if (!a || !b || a.name !== b.name) return null;
  return fastDistM(a.lat, a.lon, b.lat, b.lon) <= NEARBY_TERMINUS_M ? "nearby" : null;
}

export type LoopTerminus = { stopId: string; name: string; routes: string[] };

const loopCache = new WeakMap<Feed, Map<string, LoopTerminus>>();

/**
 * A feed fordulóhurkos végállomásai (megálló → mely vonalak fordulnak ott):
 * ahol egy vonal menete véget ér, és ugyanonnan indul egy menete.
 */
export function loopTermini(feed: Feed): Map<string, LoopTerminus> {
  const hit = loopCache.get(feed);
  if (hit) return hit;
  const ends = new Map<string, Set<string>>();
  const starts = new Map<string, Set<string>>();
  for (const t of feed.trips.values()) {
    const st = feed.tripStops.get(t.id);
    if (!st || st.length < 2) continue;
    const route = feed.routes.get(t.routeId)?.short ?? t.routeId;
    const first = st[0].stopId;
    const last = st[st.length - 1].stopId;
    // Körjárat (43, 44): a menet maga ér vissza a kiindulásba  az nem forduló.
    if (first === last) continue;
    (ends.get(route) ?? ends.set(route, new Set()).get(route)!).add(last);
    (starts.get(route) ?? starts.set(route, new Set()).get(route)!).add(first);
  }
  const out = new Map<string, LoopTerminus>();
  for (const [route, endSet] of ends) {
    const startSet = starts.get(route);
    if (!startSet) continue;
    for (const stopId of endSet) {
      if (!startSet.has(stopId)) continue;
      const cur = out.get(stopId) ?? { stopId, name: feed.stops.get(stopId)?.name ?? stopId, routes: [] };
      cur.routes.push(route);
      out.set(stopId, cur);
    }
  }
  for (const t of out.values()) t.routes.sort((a, b) => a.localeCompare(b, "hu", { numeric: true }));
  loopCache.set(feed, out);
  return out;
}

/** Fordulóhurkos-e a menet végállomása (ülve maradva körbe lehet-e utazni). */
export function endsAtLoop(feed: Feed, tripId: string): boolean {
  const st = feed.tripStops.get(tripId);
  return Boolean(st?.length && loopTermini(feed).has(st[st.length - 1].stopId));
}

export const TURN = {
  /** ha a busz következő menete ennyi idő alatt sem derül ki, a végállomáson ért véget az út (mp) */
  FIND_S: 20 * 60,
  /** ha a következő menet ennyi idő alatt sem indul el, a végállomáson ért véget az út (mp) */
  DEPART_S: 45 * 60,
} as const;

export type TurnContinuation = {
  /** a végállomás fordulóhurok */
  loop: boolean;
  next: { kind: TerminusKind | null; cancelled: boolean; departed: boolean } | null;
};

export type TurnDecision = "wait" | "alight" | "continue";

/**
 * Előre bejelentett körbeutazás a végállomáson: az utas megmondta, hogy a buszon
 * marad  itt már nem a telefon helye dönt (zsebben, lezárva is körbemegy vele).
 *  · a busz következő menete ugyaninnen / a szomszédos kocsiállásból elindult → folytatjuk
 *  · még nem indult → várunk (legfeljebb DEPART_S-ig)
 *  · nincs (még) következő menet, máshonnan indul, vagy törölték → várunk FIND_S-ig, utána itt ért véget
 *  · amíg a folytatásról nincs adat, várunk (a hívó dönt, meddig)
 */
export function plannedTurnDecision(arrivedAt: number, cont: TurnContinuation | null, now: number): TurnDecision {
  // Még nincs válasz a szervertől (órákkal később megnyitott app, rossz hálózat): ebből nem zárunk le.
  if (!cont) return "wait";
  const next = cont.next;
  if (next && next.kind != null && !next.cancelled) {
    if (next.departed) return "continue";
    return now - arrivedAt > TURN.DEPART_S ? "alight" : "wait";
  }
  return now - arrivedAt > TURN.FIND_S ? "alight" : "wait";
}
