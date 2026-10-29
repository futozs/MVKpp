import { describe, expect, it } from "vitest";
import { forecastDelays, type SegmentProfile } from "../src/index.ts";

// Négy megálló, szakaszonként 120 mp menetrendi idővel, 8:00-tól.
const stops = [0, 1, 2, 3].map((i) => ({ stopId: `S${i}`, arr: 8 * 3600 + i * 120, dep: 8 * 3600 + i * 120 }));
const flat = (p50: number, p85 = p50 + 30) => (): SegmentProfile => ({ p50, p85 });

describe("késés-előrejelzés", () => {
  it("lassú szakaszokon a késés nő, a felső becslés a várható fölött van", () => {
    const f = forecastDelays(stops, 0, 60, flat(160));
    expect(f.map((x) => x.delayS)).toEqual([88, 116, 144]); // +40 mp × 0,7 szakaszonként
    for (const x of f) expect(x.upperS).toBeGreaterThan(x.delayS);
    expect(f[2].upperS - f[2].delayS).toBeGreaterThan(f[0].upperS - f[0].delayS);
  });

  it("a menetrendi tartalékkal a késő busz behoz, de 0 alá nem megy", () => {
    const f = forecastDelays(stops, 0, 90, flat(60));
    expect(f.map((x) => x.delayS)).toEqual([48, 6, 0]);
  });

  it("aki már előbb jár, nem kerül vissza a menetrendre (és nem siet tovább a tartalékkal sem)", () => {
    const f = forecastDelays(stops, 0, -60, flat(60));
    expect(f.every((x) => x.delayS === -60)).toBe(true);
  });

  it("profil nélküli szakaszon a késés marad, és csak a hátralévő megállókra jósol", () => {
    const f = forecastDelays(stops, 1, 120, () => undefined);
    expect(f.map((x) => [x.stopId, x.delayS, x.upperS])).toEqual([
      ["S2", 120, 120],
      ["S3", 120, 120],
    ]);
  });
});
