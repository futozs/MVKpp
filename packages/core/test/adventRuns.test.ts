import { describe, expect, it } from "vitest";
import type { StopEta } from "../src/advent/day.ts";
import { adventRuns, type FeedAdventTrip } from "../src/advent/runs.ts";
import { dayPlan, seasonOf } from "../src/advent/season.ts";

const season = seasonOf(2026)!;
const iso = "2026-12-01";
const plan = dayPlan(season, iso)!;
const [t1022, m1105] = plan.trips;
const MIN = 60;

/** a nap élő elemzésének várható idői egy menetre: megállónként a menetrend + eltolás */
function etasOf(trip: (typeof plan.trips)[number], key: string, shiftS: number, fromStop = 0): StopEta[] {
  const dir = trip.from === "tiszai" ? "out" : "back";
  const order = dir === "out" ? season.stops.map((_, i) => i) : season.stops.map((_, i) => season.stops.length - 1 - i);
  return order.slice(fromStop).map((stop, k) => ({ stop, dir, trip: key, sched: trip.stopTimes[k + fromStop], eta: trip.stopTimes[k + fromStop] + shiftS, live: shiftS > 0, uncertain: false }));
}

describe("adventi menetek a tervezőnek", () => {
  it("élő adat nélkül a plakát: minden menet, a GTFS-megállókkal és saját azonosítóval", () => {
    const runs = adventRuns(season, plan, null, t1022.dep - 3600);
    expect(runs).toHaveLength(plan.trips.length);
    expect(runs[0]).toMatchObject({ key: "T1022", tripId: `advent:${iso}:T1022`, dir: "out", headsign: "Felső-Majláth", live: false });
    expect(runs[0].stops).toHaveLength(23);
    expect(runs[0].stops[0]).toMatchObject({ stop: 0, stopId: "SP475", t: t1022.dep });
    expect(runs[1].stops[0]).toMatchObject({ stop: 22, stopId: "SP3281" });
    expect(runs[1].stops.at(-1)).toMatchObject({ stop: 0, stopId: "SP476", t: m1105.arr });
  });

  it("élő adat nélkül a már elhagyott megálló kiesik", () => {
    const now = t1022.dep + 10 * MIN;
    const run = adventRuns(season, plan, null, now)[0];
    expect(run.key).toBe("T1022");
    expect(run.stops[0].t).toBeGreaterThanOrEqual(now);
    expect(run.stops.some((s) => s.stop === 0)).toBe(false);
  });

  it("élő adattal: a késés eltolja, a lement / törölt (várható idő nélküli) menet kiesik", () => {
    const now = t1022.dep + 5 * MIN;
    // a T1022 8 perc késéssel úton, az első 6 megállón már túl; az M1105 a fordulóval késik
    const etas = [...etasOf(t1022, "T1022", 8 * MIN, 6), ...etasOf(m1105, "M1105", 4 * MIN)];
    const runs = adventRuns(season, plan, etas, now);
    expect(runs.map((r) => r.key)).toEqual(["T1022", "M1105"]);
    expect(runs[0].stops[0]).toMatchObject({ stop: 6, t: t1022.stopTimes[6] + 8 * MIN, sched: t1022.stopTimes[6] });
    expect(runs[0].live).toBe(true);
    expect(runs[1].stops[0].t).toBe(m1105.dep + 4 * MIN);
  });

  it("ha az úton lévő menet siet, a hátralévő megállóit a korábbi időre tesszük", () => {
    const now = t1022.dep + 5 * MIN;
    // a day.etas sietésnél a menetrendet adja (sosem korábbit)
    const etas = etasOf(t1022, "T1022", 0, 3);
    const [run] = adventRuns(season, plan, etas, now, [], { key: "T1022", delayS: -4 * MIN });
    expect(run.stops[0].t).toBe(Math.max(now, t1022.stopTimes[3] - 4 * MIN));
    expect(run.stops.at(-1)!.t).toBe(t1022.arr - 4 * MIN);
    // a másik menetre nem hat
    const [, next] = adventRuns(season, plan, [...etas, ...etasOf(m1105, "M1105", 0)], now, [], { key: "T1022", delayS: -4 * MIN });
    expect(next.stops[0].t).toBe(m1105.dep);
  });

  it("a feed valódi ADV-menetei az alap: az azonosítójuk marad, a kulcs a plakát indulása", () => {
    const midnight = t1022.dep - (10 * 3600 + 22 * MIN);
    // a feed egy perccel később indítja, és van benne egy ismeretlen megálló is
    const feed: FeedAdventTrip[] = [
      {
        id: "C1_1880_102300_1",
        stops: [
          { stopId: "SP475", dep: midnight + 10 * 3600 + 23 * MIN },
          { stopId: "SPXXX", dep: midnight + 10 * 3600 + 24 * MIN },
          { stopId: "SP479", dep: midnight + 10 * 3600 + 25 * MIN },
          { stopId: "SP481", dep: midnight + 10 * 3600 + 27 * MIN },
        ],
      },
    ];
    const etas = etasOf(t1022, "T1022", 3 * MIN);
    const runs = adventRuns(season, plan, etas, t1022.dep - 600, feed);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: "T1022", tripId: "C1_1880_102300_1", dir: "out" });
    expect(runs[0].stops.map((s) => s.stopId)).toEqual(["SP475", "SP479", "SP481"]);
    expect(runs[0].stops.map((s) => s.t - midnight)).toEqual([10 * 3600 + 26 * MIN, 10 * 3600 + 28 * MIN, 10 * 3600 + 30 * MIN]);
  });

  it("egy menetben az idő sosem lép vissza", () => {
    const etas = etasOf(t1022, "T1022", 0);
    // a második megállónál a becslés a mostnál korábbra esne
    etas[1] = { ...etas[1], eta: etas[0].eta - 2 * MIN };
    const now = t1022.dep - 60;
    const run = adventRuns(season, plan, etas, now)[0];
    for (let i = 1; i < run.stops.length; i++) expect(run.stops[i].t).toBeGreaterThanOrEqual(run.stops[i - 1].t);
    expect(run.stops[1].t).toBe(run.stops[0].t);
  });

  it("évadon kívüli napra nincs menet", () => {
    expect(adventRuns(season, dayPlan(season, "2026-11-20"), null, 0)).toEqual([]);
  });
});
