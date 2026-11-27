/**
 * Az adventi villamos ma még elérhető menetei a tervezőnek: megállónként a várható
 * idő (a menetrend az élő késéssel eltolva), a már elhagyott megállók nélkül.
 * Ha a betöltött feedben vannak valódi ADV-menetek, azok megállói és idői az
 * alap (és az azonosítójuk is megmarad), különben a plakát menetrendje.
 */
import { hmOfUnix } from "../time.ts";
import type { StopEta } from "./day.ts";
import { END_LABEL, type AdventDayPlan, type AdventSeason } from "./season.ts";

export type AdventRunStop = {
  /** index a season.stops-ban */
  stop: number;
  stopId: string;
  sched: number;
  /** várható áthaladás (unix): sosem korábbi az előző megállónál */
  t: number;
};

export type AdventRun = {
  /** a nap menetkulcsa: T1022 / M1105 */
  key: string;
  /** a feed menetazonosítója, vagy `advent:<nap>:<kulcs>` */
  tripId: string;
  dir: "out" | "back";
  headsign: string;
  stops: AdventRunStop[];
  /** élő helyzetből számolt idő */
  live: boolean;
  /** áll, nincs jele, vagy nem indult: lehet, hogy nem jön */
  uncertain: boolean;
};

/** a feed egy ADV-menete: megállók sorban, unix-idővel */
export type FeedAdventTrip = { id: string; stops: { stopId: string; dep: number }[] };

type Base = { key: string; tripId: string; dir: "out" | "back"; stops: { stop: number; stopId: string; sched: number }[] };

/** ennyin belül illesztjük a feed menetét a plakát egy indulásához (mp) */
const MATCH_S = 10 * 60;

const keyOf = (dir: "out" | "back", dep: number) => `${dir === "out" ? "T" : "M"}${hmOfUnix(dep).replace(":", "")}`;

function fromPlan(season: AdventSeason, plan: AdventDayPlan): Base[] {
  return plan.trips.map((t) => {
    const dir = t.from === "tiszai" ? "out" : "back";
    const key = keyOf(dir, t.dep);
    const order = dir === "out" ? season.stops.map((_, i) => i) : season.stops.map((_, i) => season.stops.length - 1 - i);
    return {
      key,
      tripId: `advent:${plan.iso}:${key}`,
      dir,
      stops: order.map((i, k) => ({ stop: i, stopId: dir === "out" ? season.stops[i].out : season.stops[i].back, sched: t.stopTimes[k] })),
    };
  });
}

/** a feed menetei: a megállóik az évad megállóira, a kulcsuk a plakát legközelebbi indulása */
function fromFeed(season: AdventSeason, plan: AdventDayPlan | null, trips: FeedAdventTrip[]): Base[] {
  const outIdx = new Map(season.stops.map((s, i) => [s.out, i]));
  const backIdx = new Map(season.stops.map((s, i) => [s.back, i]));
  const out: Base[] = [];
  for (const ft of trips) {
    if (ft.stops.length < 2) continue;
    const first = ft.stops[0].stopId;
    const dir = outIdx.has(first) && !backIdx.has(first) ? "out" : backIdx.has(first) ? "back" : null;
    if (!dir) continue;
    const idx = dir === "out" ? outIdx : backIdx;
    const stops = ft.stops.flatMap((s) => {
      const i = idx.get(s.stopId);
      return i == null ? [] : [{ stop: i, stopId: s.stopId, sched: s.dep }];
    });
    const dep = ft.stops[0].dep;
    const twin = plan?.trips
      .filter((t) => (t.from === "tiszai") === (dir === "out") && Math.abs(t.dep - dep) <= MATCH_S)
      .sort((a, b) => Math.abs(a.dep - dep) - Math.abs(b.dep - dep))[0];
    out.push({ key: keyOf(dir, twin?.dep ?? dep), tripId: ft.id, dir, stops });
  }
  return out;
}

/**
 * A ma még elérhető menetek. `etas` a nap élő elemzéséből (day.etas): ha megvan, csak
 * az abban szereplő menetek és megállók maradnak (a lement, elmaradt, törölt menet és
 * a már elhagyott megálló kiesik), az idő pedig a menetrend + a menet élő eltolása.
 * Nélküle (nincs még vonal) a menetrend, a mostani pillanat utáni megállókkal.
 * `running`: az úton lévő menet és a mért késése; ha siet, a hátralévő megállóit a korábbi
 * időre tesszük (a day.etas sosem megy a menetrend elé, de elkapni a korábbihoz kell odaérni).
 */
export function adventRuns(
  season: AdventSeason,
  plan: AdventDayPlan | null,
  etas: StopEta[] | null,
  now: number,
  feedTrips: FeedAdventTrip[] = [],
  running: { key: string; delayS: number | null } | null = null,
): AdventRun[] {
  const bases = feedTrips.length ? fromFeed(season, plan, feedTrips) : plan ? fromPlan(season, plan) : [];
  const byKey = new Map<string, Map<number, StopEta>>();
  for (const e of etas ?? []) {
    let m = byKey.get(e.trip);
    if (!m) byKey.set(e.trip, (m = new Map()));
    m.set(e.stop, e);
  }
  const runs: AdventRun[] = [];
  for (const b of bases) {
    const live = byKey.get(b.key);
    if (etas && !live) continue;
    const early = running?.key === b.key && running.delayS != null && running.delayS < 0 ? running.delayS : 0;
    const stops: AdventRunStop[] = [];
    let isLive = false;
    let uncertain = false;
    let floor = now;
    for (const s of b.stops) {
      let t: number;
      if (live) {
        const e = live.get(s.stop);
        if (!e) continue;
        t = early ? s.sched + early : s.sched + (e.eta - e.sched);
        isLive ||= e.live;
        uncertain ||= e.uncertain;
      } else {
        if (s.sched < now) continue;
        t = s.sched;
      }
      // egy menetben az idő nem léphet vissza: a feed és a plakát perce eltérhet
      floor = Math.max(floor, t);
      stops.push({ ...s, t: floor });
    }
    if (!stops.length) continue;
    runs.push({ key: b.key, tripId: b.tripId, dir: b.dir, headsign: END_LABEL[b.dir === "out" ? "majlath" : "tiszai"], stops, live: isLive, uncertain });
  }
  return runs.sort((a, b) => a.stops[0].t - b.stops[0].t);
}
