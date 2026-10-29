import { describe, expect, it } from "vitest";
import { commuteToday, detectCommutes, upcomingCommute, type CommuteRide } from "../src/index.ts";

// 2026 novembere: téli időszámítás (UTC+1), nincs ünnepnap a munkanapokon.
const at = (iso: string, hm: string) => Math.floor(Date.parse(`${iso}T${hm}:00+01:00`) / 1000);
const ride = (iso: string, hm: string, extra: Partial<CommuteRide> = {}): CommuteRide => ({
  route: "14",
  headsign: "Repülőtér/Bosch - Hejőpark",
  fromStopId: "SP85",
  fromStopName: "Cementgyár",
  toStopName: "Hejőpark",
  boardedAt: at(iso, hm),
  serviceDate: iso,
  ...extra,
});
/** Körbeutazás: felszáll Cementgyárnál, a végállomáson (Hejőpark) ülve marad a következő menetre. */
const loop = (iso: string, hm: string): CommuteRide[] => [
  ride(iso, hm, { chainId: `kor-${iso}` }),
  ride(iso, "06:45", { chainId: `kor-${iso}`, fromStopId: "SP414", fromStopName: "Hejőpark", toStopName: "Cementgyár", headsign: "Hejőpark - Repülőtér/Bosch" }),
];

const week1 = [ride("2026-11-02", "06:51"), ride("2026-11-03", "06:52"), ...loop("2026-11-04", "06:18"), ...loop("2026-11-05", "06:19"), ride("2026-11-06", "06:50")];
const week2 = [ride("2026-11-09", "06:51"), ride("2026-11-10", "06:51"), ...loop("2026-11-11", "06:18"), ...loop("2026-11-12", "06:18"), ride("2026-11-13", "06:52")];

describe("egy héten két különböző szokás", () => {
  it("egy hét után: a heti háromszori 6:51-es már megvan, a heti kétszeri 6:18-as még nem", () => {
    const cs = detectCommutes(week1, at("2026-11-08", "20:00"));
    expect(cs.map((c) => [c.minute, c.dows])).toEqual([[6 * 60 + 51, [1, 2, 5]]]);
  });

  it("két hét után mindkettő, és a körbeutazás második menete nem külön szokás", () => {
    const cs = detectCommutes([...week1, ...week2], at("2026-11-15", "20:00"));
    expect(cs).toHaveLength(2);
    const early = cs.find((c) => c.minute < 6 * 60 + 30)!;
    expect(early).toMatchObject({ minute: 6 * 60 + 18, dows: [3, 4], daily: false, loop: true, fromStopId: "SP85", toStopName: "Cementgyár" });
    expect(cs.some((c) => c.fromStopId === "SP414")).toBe(false);
  });

  it("hétfőn a 6:51-es jön elő, szerdán a 6:18-as — mindig az, ami aznap szokásos", () => {
    const cs = detectCommutes([...week1, ...week2], at("2026-11-15", "20:00"));
    expect(upcomingCommute(cs, at("2026-11-16", "06:00"), "2026-11-16")?.minute).toBe(6 * 60 + 51);
    expect(upcomingCommute(cs, at("2026-11-18", "06:00"), "2026-11-18")?.minute).toBe(6 * 60 + 18);
    // szerdán a 6:51-es nem szokás (azt hétfőn, kedden, pénteken szoktad)
    expect(cs.filter((c) => commuteToday(c, "2026-11-18")).map((c) => c.minute)).toEqual([6 * 60 + 18]);
  });

  it("aki minden munkanap ugyanakkor utazik, annál bármelyik munkanapon előjön", () => {
    const daily = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((d) => ride(d, "07:40"));
    const [c] = detectCommutes(daily, at("2026-11-06", "05:00"));
    expect(c.daily).toBe(true);
    expect(commuteToday(c, "2026-11-06")).toBe(true);
    expect(commuteToday(c, "2026-11-07")).toBe(false); // szombat
  });

  it("két különböző busz 15 percre egymástól két külön szokás", () => {
    const rides = ["2026-11-02", "2026-11-03", "2026-11-04"].flatMap((d) => [ride(d, "07:00"), ride(d, "07:15", { route: "14" })]);
    expect(detectCommutes(rides, at("2026-11-05", "05:00")).map((c) => c.minute).sort()).toEqual([420, 435]);
  });
});
