import { describe, expect, it } from "vitest";
import { segmentCongestion, TRAFFIC } from "../src/traffic.ts";

const NOW = 1_800_000_000;
const ob = (agoS: number, travelS: number, typicalS = 100) => ({ endTs: NOW - agoS, travelS, typicalS });

describe("élő forgalom szakaszonként", () => {
  it("szokásos tempónál nincs jelzés", () => {
    expect(segmentCongestion([ob(60, 105), ob(300, 110), ob(500, 95)], [], NOW)).toBeNull();
  });

  it("ha a legutóbbi buszok jóval lassabbak, beállt az út", () => {
    const c = segmentCongestion([ob(60, 220), ob(300, 260), ob(600, 240)], [], NOW)!;
    expect(c.ratio).toBeCloseTo(2.4, 1);
    expect(c.excessS).toBe(140);
    expect(c.level).toBeGreaterThan(0.5);
  });

  it("egyetlen enyhén lassú busz nem dugó, egy nagyon lassú már az", () => {
    expect(segmentCongestion([ob(60, 150)], [], NOW)).toBeNull();
    expect(segmentCongestion([ob(60, 260)], [], NOW)).not.toBeNull();
  });

  it("rövid szakaszon a nagy arány kis többletidővel nem dugó", () => {
    expect(segmentCongestion([ob(60, 50, 30), ob(120, 55, 30)], [], NOW)).toBeNull();
  });

  it("a feloldódott dugó eltűnik: a friss áthaladások számítanak, a régiek kiesnek", () => {
    const cleared = [ob(30, 100), ob(90, 105), ob(200, 98), ob(400, 102), ob(700, 300), ob(800, 320)];
    expect(segmentCongestion(cleared, [], NOW)).toBeNull();
    expect(segmentCongestion([ob(TRAFFIC.WINDOW_S + 60, 400), ob(TRAFFIC.WINDOW_S + 120, 400)], [], NOW)).toBeNull();
  });

  it("a most bent ragadt busz azonnal jelez, még mielőtt átérne", () => {
    const c = segmentCongestion([ob(600, 105)], [{ elapsedS: 280, typicalS: 100 }], NOW)!;
    expect(c.stuck).toBe(1);
    expect(c.ratio).toBeCloseTo(2.8, 1);
    expect(segmentCongestion([], [{ elapsedS: 160, typicalS: 100 }], NOW)).toBeNull(); // csak 60 mp-cel lassabb
  });

  it("a szín-szint 0 (citrom) és 1 (sötétvörös) között", () => {
    expect(segmentCongestion([ob(60, 140), ob(120, 140)], [], NOW)!.level).toBeLessThan(0.1);
    expect(segmentCongestion([ob(60, 400), ob(120, 450)], [], NOW)!.level).toBe(1);
  });
});
