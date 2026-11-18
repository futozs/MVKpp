import { describe, expect, it } from "vitest";
import { breakdowns, dayBuckets, runStateAt, stillFor, type RunEvent } from "../src/fleetHistory.ts";

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
