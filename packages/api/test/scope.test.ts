import { describe, expect, it } from "vitest";
import { scopeOf, scopeSql } from "../src/http.ts";

const u = (q: string) => new URL(`http://x/stats/vehicles${q}`);

describe("statisztika: ?modes= szűrés", () => {
  it("paraméter nélkül csak az MVK (a v2 alapválasza)", () => {
    const s = scopeOf(u(""));
    expect(s).toEqual({ mvk: true, feeds: [], key: "mvk" });
    expect(scopeSql(s, "vehicle_id")).toBe("(vehicle_id NOT LIKE '%:%')");
  });

  it("módokból előtagok: Volán = hkir, vasút = 1", () => {
    expect(scopeOf(u("?modes=coach,rail"))).toEqual({ mvk: false, feeds: ["hkir", "1"], key: "hkir+1" });
    expect(scopeOf(u("?modes=tram,rail")).key).toBe("m1");
    expect(scopeSql(scopeOf(u("?modes=all")), "r.trip_id")).toBe("(r.trip_id NOT LIKE '%:%' OR split_part(r.trip_id, ':', 1) IN ('hkir', '1'))");
  });

  it("ismeretlen mód nem kerül az SQL-be (csak a fehérlista)", () => {
    const s = scopeOf(u("?modes=rail,x');DROP TABLE stop;--"));
    expect(s.feeds).toEqual(["1"]);
    expect(scopeSql(s, "trip_id")).not.toContain("DROP");
    // semmi ismert: üres halmaz → hamis feltétel, nem minden sor
    expect(scopeSql({ mvk: false, feeds: [], key: "none" }, "trip_id")).toBe("false");
  });
});
