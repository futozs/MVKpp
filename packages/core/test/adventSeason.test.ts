import { describe, expect, it } from "vitest";
import { dayPlan, dayTypeOf, seasonOf, seasonOn } from "../src/advent/season.ts";
import { hmOfUnix } from "../src/time.ts";

const s2026 = seasonOf(2026)!;
const deps = (iso: string) => dayPlan(s2026, iso)!.trips.map((t) => `${t.from === "tiszai" ? "T" : "M"}${hmOfUnix(t.dep)}`);

describe("adventi villamos menetrendje (2026)", () => {
  it("a nyitónap csak a két esti kör", () => {
    expect(deps("2026-11-29")).toEqual(["T17:20", "M18:10", "T18:50", "M19:30"]);
  });

  it("naptípusok: tanítási, tanszüneti, szombat, vasárnap", () => {
    expect(dayTypeOf(s2026, "2026-11-30")).toBe("school");
    expect(dayTypeOf(s2026, "2026-12-18")).toBe("school");
    expect(dayTypeOf(s2026, "2026-12-19")).toBe("saturday");
    expect(dayTypeOf(s2026, "2026-12-20")).toBe("sunday");
    expect(dayTypeOf(s2026, "2026-12-21")).toBe("break");
    expect(dayTypeOf(s2026, "2026-12-28")).toBe("break");
    expect(dayTypeOf(s2026, "2027-01-02")).toBe("saturday");
    expect(dayTypeOf(s2026, "2027-01-04")).toBe("school");
    expect(dayTypeOf(s2026, "2027-01-06")).toBe("school");
  });

  it("tanítási munkanap: 14 menet, Tiszai 10:22-kor kezd, Felső-Majláthról 19:50-kor zár", () => {
    const d = deps("2026-12-01");
    expect(d).toHaveLength(14);
    expect(d[0]).toBe("T10:22");
    expect(d.at(-1)).toBe("M19:50");
    expect(d).toContain("M14:03");
  });

  it("tanszünet: 18:26 Felső-Majláthról", () => {
    expect(deps("2026-12-22")).toContain("M18:26");
  });

  it("rövidített és délutáni napok", () => {
    expect(deps("2026-12-06")).toEqual(["T16:15", "M17:00", "T17:45", "M18:25", "T19:05", "M19:50"]);
    expect(deps("2026-12-24")).toEqual(["T10:22", "M11:03", "T11:45", "M12:30"]);
    expect(deps("2026-12-31")).toEqual(["T10:26", "M11:03", "T11:45", "M12:30"]);
    expect(deps("2027-01-01")).toEqual(["T14:45", "M15:30", "T16:15", "M17:00", "T17:45", "M18:25", "T19:05", "M19:50"]);
    expect(deps("2027-01-03")).toEqual(deps("2026-12-06"));
    expect(dayPlan(s2026, "2026-12-25")!.type).toBe("sunday");
  });

  it("a menet 33 perc, a megállók a plakát menetidejével", () => {
    const t = dayPlan(s2026, "2026-12-01")!.trips[0];
    expect(t.arr - t.dep).toBe(33 * 60);
    expect(t.stopTimes).toHaveLength(23);
    expect(hmOfUnix(t.stopTimes[12])).toBe("10:42");
    const back = dayPlan(s2026, "2026-12-01")!.trips[1];
    expect(back.from).toBe("majlath");
    expect(hmOfUnix(back.stopTimes[1])).toBe("11:07");
    expect(hmOfUnix(back.stopTimes[22])).toBe("11:38");
  });

  it("az évadon kívül nincs menet", () => {
    expect(dayPlan(s2026, "2026-11-28")).toBeNull();
    expect(dayPlan(s2026, "2027-01-07")).toBeNull();
    expect(seasonOn("2026-11-28")).toBeNull();
    expect(seasonOn("2026-12-10")?.year).toBe(2026);
  });
});
