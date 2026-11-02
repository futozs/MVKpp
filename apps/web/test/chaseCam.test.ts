import { describe, expect, it } from "vitest";
import { angleDelta, approachAngle, arcDepth, bearingTo, easeInOutCubic, metersBetween } from "../src/components/map/map3d/chaseCam";

// Miskolc, Városház tér környéke
const A: [number, number] = [48.1035, 20.7905];

describe("bearingTo", () => {
  it("returns 0 for due north and 90 for due east", () => {
    expect(bearingTo(A, [A[0] + 0.001, A[1]])).toBeCloseTo(0, 5);
    expect(bearingTo(A, [A[0], A[1] + 0.001])).toBeCloseTo(90, 5);
  });

  it("returns values in 0..360 for westward headings", () => {
    expect(bearingTo(A, [A[0], A[1] - 0.001])).toBeCloseTo(270, 5);
    expect(bearingTo(A, [A[0] - 0.001, A[1] - 0.001])).toBeGreaterThan(180);
  });
});

describe("metersBetween", () => {
  it("measures 0.001° of latitude as about 110 m", () => {
    expect(metersBetween(A, [A[0] + 0.001, A[1]])).toBeCloseTo(110.5, 0);
  });
});

describe("angleDelta", () => {
  it("takes the short way across north", () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
  });

  it("maps a half turn to +180, never -180", () => {
    expect(angleDelta(0, 180)).toBe(180);
    expect(angleDelta(180, 0)).toBe(180);
  });
});

describe("approachAngle", () => {
  it("does not move without elapsed time", () => {
    expect(approachAngle(10, 90, 0)).toBe(10);
  });

  it("turns toward the target without overshooting", () => {
    const next = approachAngle(0, 40, 0.5);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(40);
  });

  it("caps the turn rate on a large swing", () => {
    // 180°-os fordulás egy 60 fps-es képkocka alatt: legfeljebb 75°/s
    const next = approachAngle(0, 179, 1 / 60, 0.01);
    expect(next).toBeCloseTo(75 / 60, 5);
  });

  it("wraps across north", () => {
    const next = approachAngle(350, 10, 10);
    expect(next).toBeCloseTo(10, 0);
  });
});

describe("easeInOutCubic", () => {
  it("is clamped to 0..1 at the ends and symmetric in the middle", () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });
});

describe("arcDepth", () => {
  it("adds no arc for a nearby bus", () => {
    expect(arcDepth(300)).toBe(0);
    expect(arcDepth(Number.NaN)).toBe(0);
  });

  it("zooms out more for farther targets, up to 4 levels", () => {
    expect(arcDepth(2400)).toBeCloseTo(2, 5);
    expect(arcDepth(1e7)).toBe(4);
  });
});
