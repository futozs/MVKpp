import { localMidnightUnix } from "@mvk/core";
import type { AdventRun } from "@mvk/core/advent/runs";
import { seasonOf } from "@mvk/core/advent/season";
import { describe, expect, it } from "vitest";
import { CATCH_PLAN, catchOptions, feedAdventTrips } from "../src/adventPlan.ts";
import { endpoints, finishNet, MAX_ACCESS_M, search, trace, withAdventRuns, type Net, type PStop, type PTrip } from "../src/planner.ts";

const season = seasonOf(2026)!;
const iso = "2026-12-01";
const midnight = localMidnightUnix(iso);
const MIN = 60;
const T0 = 15 * 3600;
const now = midnight + T0;

/** az 1-es vonal első öt megállója kelet → nyugat, ~600 m-enként; a két irány oszlopa 20 m-re egymástól */
const LINE = season.stops.slice(0, 5);
const lonOf = (i: number) => 20.8 - i * 0.008;
const stops: PStop[] = [
  ...LINE.flatMap((s, i) => [
    { id: s.out, name: s.name, lat: 48.1, lon: lonOf(i) },
    { id: s.back, name: s.name, lat: 48.1002, lon: lonOf(i) },
  ]),
  // egy távoli buszmegálló a vonaltól északra (~2,2 km)
  { id: "B1", name: "Messzi utca", lat: 48.12, lon: lonOf(3) },
];

function trip(id: string, short: string, mode: "tram" | "bus", times: number[]): PTrip {
  return { id, routeId: short, short, key: short, mode, long: "", color: "888888", text: "FFFFFF", type: mode === "tram" ? "0" : "3", headsign: "", dep: times, arr: times };
}

/** `times`: a nap mp-e az első megállónál, onnan megállónként +2 perc */
const along = (start: number, n: number, stepS = 2 * MIN) => Array.from({ length: n }, (_, k) => start + k * stepS);

function baseNet(extra: { stops: string[]; trips: PTrip[] }[] = []): Net {
  const stopIdx = new Map(stops.map((s, i) => [s.id, i]));
  const ids = (list: string[]) => list.map((id) => stopIdx.get(id)!);
  const out = LINE.map((s) => s.out);
  const back = LINE.map((s) => s.back).reverse();
  return finishNet({
    iso,
    feedVersion: "test",
    source: "feed",
    fallback: null,
    stops,
    stopIdx,
    day: null,
    patterns: [
      // a rendes 1-es: félóránként mindkét irányba
      { stops: ids(out), trips: [0, 30, 60, 90].map((m) => trip(`1o${m}`, "1", "tram", along(T0 + 10 * MIN + m * MIN, 5))), shapeId: null },
      { stops: ids(back), trips: [0, 30, 60, 90].map((m) => trip(`1b${m}`, "1", "tram", along(T0 + 25 * MIN + m * MIN, 5))), shapeId: null },
      // busz a távoli megállóból a Centrumhoz (8 perc), tízpercenként
      { stops: ids(["B1", LINE[3].out]), trips: [2, 12, 22, 32].map((m) => trip(`b${m}`, "21", "bus", [T0 + m * MIN, T0 + (m + 8) * MIN])), shapeId: null },
      ...extra.map((e) => ({ stops: ids(e.stops), trips: e.trips, shapeId: null })),
    ],
  });
}

/** egy adventi menet: `first` a nap mp-e az első (megadott) megállónál */
function run(key: string, dir: "out" | "back", first: number, from = 0, stepS = 2 * MIN): AdventRun {
  const order = dir === "out" ? LINE.map((_, i) => i) : LINE.map((_, i) => LINE.length - 1 - i);
  return {
    key,
    tripId: `advent:${iso}:${key}`,
    dir,
    headsign: dir === "out" ? "Felső-Majláth" : "Tiszai pályaudvar",
    live: false,
    uncertain: false,
    stops: order.slice(from).map((stop, k) => ({ stop, stopId: dir === "out" ? LINE[stop].out : LINE[stop].back, sched: midnight + first + k * stepS, t: midnight + first + k * stepS })),
  };
}

const place = (id: string) => (id === season.stops[5].out ? { name: season.stops[5].name, lat: 48.1, lon: lonOf(4) - 0.0012 } : null);

function planFrom(net: Net, runs: AdventRun[], at: { lat: number; lon: number }) {
  const injected = withAdventRuns(net, runs, season, place);
  const origin = endpoints(injected.net, `${at.lat},${at.lon}`, MAX_ACCESS_M, () => null)!;
  return catchOptions({ net: injected.net, runs, adventTrips: injected.tripIds, season, origin, now });
}

describe("adventi menetek a RAPTOR-hálózatban", () => {
  it("új mintát kap, a feed ADV-menete kiesik, az alaphálózat érintetlen marad", () => {
    const feedAdv = trip("C1_1880_150000_1", "ADV", "tram", along(T0, 5));
    const net = baseNet([{ stops: LINE.map((s) => s.out), trips: [feedAdv] }]);
    const before = { patterns: net.patterns.length, sp: net.stopPatterns.map((a) => a.length), trips: net.patterns[3].trips.length };
    expect(feedAdventTrips(net, season)).toEqual([{ id: feedAdv.id, stops: LINE.map((s, i) => ({ stopId: s.out, dep: midnight + T0 + i * 2 * MIN })) }]);

    const r = run("T1500", "out", T0 + 5 * MIN);
    const { net: adv, tripIds } = withAdventRuns(net, [r], season, place);
    expect([...tripIds]).toEqual([r.tripId]);
    expect(adv.patterns[3].trips).toHaveLength(0);
    const added = adv.patterns.at(-1)!;
    expect(added.trips[0]).toMatchObject({ id: r.tripId, short: "ADV", mode: "tram", color: "FFDD00" });
    expect(added.trips[0].dep).toEqual(along(T0 + 5 * MIN, 5));
    expect(adv.stopPatterns[net.stopIdx.get(LINE[0].out)!]).toContainEqual({ p: adv.patterns.length - 1, pos: 0 });

    expect(net.patterns.length).toBe(before.patterns);
    expect(net.patterns[3].trips).toHaveLength(before.trips);
    expect(net.stopPatterns.map((a) => a.length)).toEqual(before.sp);
  });

  it("a hálózatban nem lévő megállót a helyével, gyalogos kapcsolattal fűzi be", () => {
    const net = baseNet();
    const r = run("T1500", "out", T0, 0);
    r.stops.push({ stop: 5, stopId: season.stops[5].out, sched: r.stops[4].t + 2 * MIN, t: r.stops[4].t + 2 * MIN });
    const { net: adv } = withAdventRuns(net, [r], season, place);
    const i = adv.stopIdx.get(season.stops[5].out)!;
    expect(i).toBe(net.stops.length);
    const near = adv.stopIdx.get(LINE[4].out)!;
    expect(adv.foot[i].some((f) => f.to === near)).toBe(true);
    expect(adv.foot[near].some((f) => f.to === i)).toBe(true);
    expect(net.foot[near].some((f) => f.to === i)).toBe(false);
  });

  it("a keresés fel tud szállni a befűzött menetre", () => {
    const net = baseNet();
    const r = run("T1503", "out", T0 + 3 * MIN);
    const { net: adv } = withAdventRuns(net, [r], season, place);
    const from = adv.stopIdx.get(LINE[0].out)!;
    const to = adv.stopIdx.get(LINE[4].out)!;
    const sr = search(adv, [{ stop: from, walk: 0 }], [{ stop: to, walk: 0 }], T0);
    expect(sr.tau[1][to]).toBe(T0 + 3 * MIN + 8 * MIN);
    const path = trace(sr, 1, to)!;
    const ride = path.legs.find((l) => l.t === "ride");
    expect(ride && ride.t === "ride" ? ride.trip.id : null).toBe(r.tripId);
  });
});

describe("Elkapó: hol és hogyan éred el", () => {
  it("közelről gyalog, a legkésőbbi indulással", () => {
    const r = run("T1510", "out", T0 + 14 * MIN);
    const at = { lat: 48.0987, lon: lonOf(3) };
    const [o] = planFrom(baseNet(), [r], at);
    expect(o).toMatchObject({ run: "T1510", stop: 3, walkOnly: true, chase: false, at: midnight + T0 + 20 * MIN });
    expect(o.slackS).toBe(CATCH_PLAN.walkMarginS);
    expect(o.legs).toHaveLength(1);
    expect(o.legs[0]).toMatchObject({ kind: "walk", to: LINE[3].name, arr: o.arrive });
  });

  it("messziről busszal, a legkésőbbi még elég korai busszal", () => {
    const r = run("T1525", "out", T0 + 29 * MIN);
    const [o] = planFrom(baseNet(), [r], { lat: 48.1203, lon: lonOf(3) });
    // a Centrumban 15:35-kor: a 15:22-es busz 15:30-ra ér oda, a 15:32-es már késő
    expect(o).toMatchObject({ stop: 3, walkOnly: false, at: midnight + T0 + 35 * MIN, arrive: midnight + T0 + 30 * MIN });
    const ride = o.legs.find((l) => l.kind === "ride");
    expect(ride).toMatchObject({ route: "21", dep: midnight + T0 + 22 * MIN });
    expect(o.leave).toBeLessThan(ride!.dep);
  });

  it("az előtte haladó adventit egy rendes villamossal nem lehet utolérni", () => {
    // a T1458 már túl van a Selyemréten; a rendes 1-es (menetrend szerint) gyorsabb lenne, de mögötte jár
    const ahead = run("T1458", "out", T0 + 1 * MIN, 2, 4 * MIN);
    const fast = trip("1fast", "1", "tram", [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN, T0 + 5 * MIN]);
    const net = baseNet([{ stops: LINE.slice(1).map((s) => s.out), trips: [fast] }]);
    const opts = planFrom(net, [ahead], { lat: 48.1, lon: lonOf(1) });
    expect(opts.some((o) => o.legs.some((l) => l.kind === "ride" && l.route === "1"))).toBe(false);
  });

  it("ha elébe menve jóval korábban elkapod, az is külön lehetőség", () => {
    // a villamos a Tiszaitól jön: a Centrumban 15:38-kor (busszal 15:22-től), vagy a lassú 22-essel elébe a Tiszaira 15:20-ra
    const r = run("T1520", "out", T0 + 20 * MIN, 0, 6 * MIN);
    const slow = trip("b22", "22", "bus", [T0 + 1 * MIN, T0 + 16 * MIN]);
    const net = baseNet([{ stops: ["B1", LINE[0].out], trips: [slow] }]);
    const opts = planFrom(net, [r], { lat: 48.1203, lon: lonOf(3) });
    expect(opts.map((o) => [o.stop, o.chase])).toEqual([
      [3, false],
      [0, true],
    ]);
    expect(opts[1].legs.find((l) => l.kind === "ride")).toMatchObject({ route: "22" });
    expect(opts[0].at - opts[1].at).toBeGreaterThanOrEqual(CATCH_PLAN.chaseS);
  });

  it("felszállsz pár megállóra: hol vagy, és mivel jössz vissza (az adventivel is)", () => {
    const out = run("T1510", "out", T0 + 14 * MIN);
    // visszafelé az adventi a rendes 1-es előtt ér a Centrumba
    const back = run("M1524", "back", T0 + 24 * MIN);
    const [o] = planFrom(baseNet(), [out, back], { lat: 48.0987, lon: lonOf(3) });
    expect(o.stop).toBe(3);
    expect(o.rides).toHaveLength(1);
    const [r1] = o.rides;
    expect(r1).toMatchObject({ n: 1, stop: 4, at: midnight + T0 + 22 * MIN });
    // átmész a túloldali megállóba, és a 15:24-es adventi 15:26-ra visz vissza (a rendes 1-es csak 15:27-re)
    expect(r1.back).toMatchObject({ advent: true, route: "ADV", dep: midnight + T0 + 24 * MIN, arr: midnight + T0 + 26 * MIN });
  });
});
