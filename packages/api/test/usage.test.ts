import { describe, expect, it } from "vitest";
import { browserOf, cleanFavorites, cleanViews, platformOf } from "../src/usage.ts";

describe("usage beacon cleaning", () => {
  it("detects platform and browser from the user agent", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0";
    expect([platformOf(iphone), browserOf(iphone)]).toEqual(["ios", "safari"]);
    expect([platformOf(android), browserOf(android)]).toEqual(["android", "chrome"]);
    expect([platformOf(edge), browserOf(edge)]).toEqual(["windows", "edge"]);
    expect(platformOf("")).toBe("other");
  });

  it("keeps only well-formed favourites and caps every list", () => {
    const f = cleanFavorites({
      lines: [{ routeId: "R1", dir: "0" }, { routeId: "<script>", dir: "0" }, { routeId: "R2" }, "x"],
      stops: ["SP1", "SP1", "SP2", 42, "a".repeat(80)],
      vehicles: Array.from({ length: 100 }, (_, i) => `V${i}`),
      parking: ["t:Tiszai pu.", "d:bus"],
      evil: ["ignored"],
    });
    expect(f?.lines).toEqual([{ routeId: "R1", dir: "0" }]);
    expect(f?.stops).toEqual(["SP1", "SP2"]);
    expect(f?.vehicles.length).toBe(60);
    expect(f?.parking).toEqual(["d:bus"]);
    expect(f && "evil" in f).toBe(false);
    expect(cleanFavorites(null)).toBeNull();
  });

  it("accepts only known-shaped view counters", () => {
    expect(cleanViews({ map: 3, "Bad Key": 1, timetable: -1, stats: 9999, planner: "2" })).toEqual({ map: 3, stats: 500 });
  });
});
