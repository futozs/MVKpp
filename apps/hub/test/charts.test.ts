import { describe, expect, it } from "vitest";
import { niceScale } from "../src/components/charts/charts.tsx";

describe("niceScale", () => {
  it("never repeats a tick label for small counts", () => {
    expect(niceScale(1)).toEqual({ top: 1, step: 1 });
    expect(niceScale(3)).toEqual({ top: 3, step: 1 });
    expect(niceScale(0)).toEqual({ top: 1, step: 1 });
  });

  it("rounds larger maxima to 1-2-2.5-5 steps", () => {
    expect(niceScale(87)).toEqual({ top: 100, step: 25 });
    expect(niceScale(1234)).toEqual({ top: 1500, step: 500 });
  });

  it("allows fractional steps when asked", () => {
    expect(niceScale(0.8, 4, 0).step).toBeLessThan(1);
  });
});
