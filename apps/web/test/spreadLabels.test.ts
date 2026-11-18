import { describe, expect, it } from "vitest";
import { spreadLabels } from "../src/components/fleet/spreadLabels";

describe("a villamos-címkék szétosztása", () => {
  it("a távoliak a helyükön maradnak", () => {
    expect(spreadLabels([20, 100, 300], 24, 0, 600)).toEqual([20, 100, 300]);
  });

  it("az egymásra csúszók a helyük átlaga köré, egymás alá kerülnek", () => {
    // a képernyőképen: 630 és 609 szinte ugyanott
    expect(spreadLabels([420, 426], 24, 0, 600)).toEqual([411, 435]);
  });

  it("a széthúzott csoport a következőt is elmozdítja, ha belelógna", () => {
    const out = spreadLabels([100, 102, 104, 125], 24, 0, 600);
    out.slice(1).forEach((y, i) => expect(y - out[i]).toBeGreaterThanOrEqual(24));
  });

  it("a sáv végén nem lóg ki", () => {
    const out = spreadLabels([590, 595], 24, 0, 600);
    expect(Math.max(...out)).toBeLessThanOrEqual(600);
    expect(out[1] - out[0]).toBe(24);
  });
});
