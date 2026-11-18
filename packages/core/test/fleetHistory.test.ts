import { describe, expect, it } from "vitest";
import { breakdowns, dayBuckets, dayRecords, mergeRecords, routeLanes, runStateAt, stillFor, type RunEvent } from "../src/fleetHistory.ts";

const T0 = 1_800_000_000;
const ev = (idx: number, atS: number, delayS: number, dwell = 20, isLast = false): RunEvent => ({ idx, stopId: `S${idx}`, ts: T0 + atS, depTs: isLast ? null : T0 + atS + dwell, delayS, isLast });

describe("a menet egy múltbeli pillanatban", () => {
  // S0 indul 0-kor, S1-be 120-kor ér, S2-be 900-kor (ott elakadt: +600 mp késés), S3 a vége
  const run = [ev(0, 0, 30), ev(1, 120, 40), ev(2, 900, 640), ev(3, 1020, 650, 0, true)];

  it("még el sem indult, illetve már beért: nincs úton", () => {
    expect(runStateAt(run, T0 - 10)).toBeNull();
    expect(runStateAt(run, T0 + 1100)).toBeNull();
  });

  it("megállóban állva az ottani késés", () => {
    expect(runStateAt(run, T0 + 130)).toMatchObject({ delayS: 40, lastIdx: 1, frac: 0 });
  });

  it("két megálló között a késés átvezetve: az elakadás közben is nő", () => {
    const s = runStateAt(run, T0 + 140 + 380)!;
    expect(s.lastIdx).toBe(1);
    expect(s.frac).toBeCloseTo(0.5, 2);
    expect(s.delayS).toBe(340);
    expect(s.trail.map((p) => p.idx)).toEqual([0, 1]);
    expect(s.startDelayS).toBe(30);
  });

  it("ha az adat elfogy, egy darabig még az utolsó késés, aztán elveszett", () => {
    const cut = run.slice(0, 2);
    expect(runStateAt(cut, T0 + 600)).toMatchObject({ delayS: 40, lastIdx: 1 });
    expect(runStateAt(cut, T0 + 140 + 21 * 60)).toBeNull();
  });
});

describe("áll-e a jármű (GPS)", () => {
  const at = (s: number, dLatM: number) => ({ ts: T0 + s, lat: 48.1 + dLatM / 111_000, lon: 20.78 });

  it("az araszolás is állás, a valódi haladás nem", () => {
    const creeping = [at(0, 0), at(60, 400), at(120, 420), at(240, 450), at(360, 480), at(420, 500)];
    expect(stillFor(creeping, T0 + 420)).toBe(360);
    const moving = [at(0, 0), at(60, 400), at(120, 800)];
    expect(stillFor(moving, T0 + 120)).toBeNull();
  });

  it("régi jelből nem állítunk semmit", () => {
    expect(stillFor([at(0, 0)], T0 + 600)).toBeNull();
  });
});

describe("a nap görbéje és az összeomlások", () => {
  const tramRun = (start: number, delay: number) => ({ tram: true, events: [ev(0, start, delay), ev(1, start + 1200, delay), ev(2, start + 2400, delay, 0, true)] });
  const busRun = (start: number, delay: number) => ({ tram: false, events: [ev(0, start, delay), ev(1, start + 1800, delay, 0, true)] });

  it("lépésenként megszámolja az úton lévő és a késő járműveket", () => {
    const b = dayBuckets([tramRun(0, 700), tramRun(0, 100), busRun(0, 400)], T0, T0 + 3600);
    expect(b).toHaveLength(12);
    expect(b[1]).toMatchObject({ tram: 2, tramLate: 1, tramSevere: 1, tramMaxS: 700, bus: 1, busLate: 1 });
    expect(b[11]).toMatchObject({ tram: 0, bus: 0 });
  });

  it("a villamos összeomlását időszakként adja vissza, a csúcsával", () => {
    const runs = [tramRun(0, 100), tramRun(1800, 700), tramRun(1800, 800), tramRun(1800, 900), tramRun(1800, 50)];
    const out = breakdowns(dayBuckets(runs, T0, T0 + 7200));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "tram", start: T0 + 1800, vehicles: 3, maxDelayS: 900 });
    expect(out[0].end).toBeGreaterThan(out[0].start);
  });

  it("rendes napon nincs összeomlás", () => {
    expect(breakdowns(dayBuckets([tramRun(0, 60), tramRun(600, 90), busRun(0, 120)], T0, T0 + 3600))).toEqual([]);
  });
});

describe("késési rekordok", () => {
  const peak = (route: string, tram: boolean, hiS: number, loS = 0, date = "2026-11-18") => ({
    date,
    tripId: `${route}-${hiS}`,
    vehicleId: route === "1V" ? "609" : "2203",
    route,
    color: "FDEA00",
    text: "000000",
    headsign: "x",
    tram,
    startDelayS: 0,
    hiS,
    hiTs: T0,
    hiStop: "Villanyrendőr",
    loS,
    loTs: T0 + 60,
    loStop: "Selyemrét",
  });

  it("a nap rangsora: buszok és villamosok külön is megmaradnak, a vonalak számlálva", () => {
    const buses = Array.from({ length: 40 }, (_, i) => peak("23", false, 2000 - i * 10));
    const d = dayRecords("2026-11-18", [...buses, peak("1V", true, 1700), peak("1V", true, 100, -240)]);
    expect(d.runs).toBe(42);
    expect(d.late.filter((r) => r.tram).map((r) => r.delayS)).toEqual([1700, 100]);
    expect(d.late.filter((r) => !r.tram)).toHaveLength(25);
    expect(d.routes.find((r) => r.route === "1V")).toMatchObject({ color: "FDEA00", text: "000000", runs: 2, late5: 1, late10: 1, maxS: 1700 });
  });

  it("időszakra összefésülve: típus szerint szűrve, a legnagyobbtól", () => {
    const a = dayRecords("2026-11-17", [peak("23", false, 900, 0, "2026-11-17"), peak("1V", true, 3050, 0, "2026-11-17")]);
    const b = dayRecords("2026-11-18", [peak("23", false, 1200), peak("1V", true, 1700)]);
    expect(mergeRecords([a, b], { mode: "all", kind: "late", limit: 3 }).items.map((r) => r.delayS)).toEqual([3050, 1700, 1200]);
    expect(mergeRecords([a, b], { mode: "bus", kind: "late", limit: 5 }).items.map((r) => r.date)).toEqual(["2026-11-18", "2026-11-17"]);
    const m = mergeRecords([a, b], { mode: "tram", kind: "late", limit: 5 });
    expect(m).toMatchObject({ days: 2, runs: 2, late5: 2, late10: 2 });
  });

  it("a legnagyobb sietés a legkorábbtól", () => {
    const d = dayRecords("2026-11-18", [peak("23", false, 100, -400), peak("14", false, 50, -90)]);
    expect(mergeRecords([d], { mode: "all", kind: "early", limit: 2 }).items.map((r) => r.delayS)).toEqual([-400, -90]);
  });

  it("a vonalak rangsora csak elég menetből, a késő menetek aránya szerint", () => {
    const runs = [...Array.from({ length: 12 }, () => peak("23", false, 400)), ...Array.from({ length: 12 }, (_, i) => peak("14", false, i < 3 ? 400 : 60)), peak("ZOO", false, 900)];
    const m = mergeRecords([dayRecords("2026-11-18", runs)], { mode: "all", kind: "late", limit: 5 });
    expect(m.routes.map((r) => r.route)).toEqual(["23", "14"]);
    // a vonal színe a rangsorral együtt jön, akkor is, ha nincs a rekordlistában
    expect(m.routes.every((r) => r.color === "FDEA00")).toBe(true);
  });
});

describe("vonalra szűrve", () => {
  const peak = (route: string, hiS: number, loS = 0) => ({
    date: "2026-11-18",
    tripId: `${route}-${hiS}-${loS}`,
    vehicleId: "1641",
    route,
    color: "3D3F8E",
    text: "FFFFFF",
    headsign: "x",
    tram: false,
    startDelayS: 0,
    hiS,
    hiTs: T0,
    hiStop: "Villanyrendőr",
    loS,
    loTs: T0,
    loStop: "Selyemrét",
  });

  it("a 14-es rekordjai akkor is megvannak, ha a teljes napi első 25-be nem kerülnének", () => {
    const others = Array.from({ length: 40 }, (_, i) => peak("23", 3000 - i * 10));
    const d = dayRecords("2026-11-18", [...others, peak("14", 500), peak("14", 300, -120), peak("14", 60)]);
    const m = mergeRecords([d], { mode: "all", kind: "late", limit: 10, routes: ["14"] });
    expect(m.items.map((r) => r.delayS)).toEqual([500, 300, 60]);
    expect(m).toMatchObject({ runs: 3, late5: 2 });
    expect(m.routes.map((r) => r.route)).toEqual(["14"]);
    expect(mergeRecords([d], { mode: "all", kind: "early", limit: 10, routes: ["14"] }).items[0].delayS).toBe(-120);
  });

  it("a vonalak görbéje: vonalanként úton lévő és késő menetek; összegük a flotta görbéje", () => {
    const run = (route: string, tram: boolean, delay: number) => ({ route, tram, events: [ev(0, 0, delay), ev(1, 1800, delay, 0, true)] });
    const lanes = routeLanes([run("14", false, 400), run("14", false, 30), run("1V", true, 700)], T0, T0 + 3600);
    const l14 = lanes.find((l) => l.route === "14")!;
    expect(l14.n[1]).toBe(2);
    expect(l14.late[1]).toBe(1);
    expect(lanes.find((l) => l.route === "1V")!.severe[1]).toBe(1);
    const b = dayBuckets([run("14", false, 400), run("14", false, 30), run("1V", true, 700)], T0, T0 + 3600);
    expect(b[1]).toMatchObject({ bus: 2, busLate: 1, tram: 1, tramSevere: 1 });
  });
});

