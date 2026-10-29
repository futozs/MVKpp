import { describe, expect, it } from "vitest";
import {
  CATCH,
  catchVerdict,
  chanceLevel,
  COMMUTE,
  detectCommutes,
  normCdf,
  normInv,
  spreadCdf,
  spreadOf,
  spreadQuantile,
  START_RISK,
  startRiskOf,
  trafficAhead,
  transferChance,
  upcomingCommute,
  walkSecondsFor,
  type CommuteRide,
} from "../src/index.ts";

const NOW = 1_793_170_000;

describe("Elérem?", () => {
  it("a séta ideje az utcai kerülővel", () => {
    expect(walkSecondsFor(400)).toBe(Math.round((400 * CATCH.DETOUR) / CATCH.WALK_MPS));
    expect(walkSecondsFor(-5)).toBe(0);
  });

  it("ráérsz, ha bőven van idő — és megmondja, mikor indulj", () => {
    const v = catchVerdict({ nowUnix: NOW, expectedUnix: NOW + 900, upperUnix: NOW + 1100, walkS: 240 });
    expect(v.state).toBe("relax");
    // legkorábban: 900 − 0,35·200 = 830 → indulás 830 − 240 − 30 = 560 mp múlva
    expect(v.earliestUnix).toBe(NOW + 830);
    expect(v.leaveAtUnix).toBe(NOW + 560);
  });

  it("indulj most, ha már csak a biztos idő fér bele", () => {
    expect(catchVerdict({ nowUnix: NOW, expectedUnix: NOW + 380, upperUnix: NOW + 500, walkS: 240 }).state).toBe("go");
  });

  it("futva még eléred, sétálva már nem; aztán lekésed", () => {
    expect(catchVerdict({ nowUnix: NOW, expectedUnix: NOW + 150, walkS: 240 }).state).toBe("run");
    expect(catchVerdict({ nowUnix: NOW, expectedUnix: NOW + 60, walkS: 240 }).state).toBe("missed");
  });
});

describe("átszállási esély", () => {
  it("a normális eloszlás és inverze", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.6449)).toBeCloseTo(0.95, 3);
    expect(normInv(0.975)).toBeCloseTo(1.96, 3);
    expect(normCdf(normInv(0.3))).toBeCloseTo(0.3, 6);
  });

  it("az eloszlás mediánja és 85%-os pontja a becsültekre esik", () => {
    const s = spreadOf(1000, 1180);
    expect(spreadCdf(s, 1000)).toBeCloseTo(0.5, 4);
    expect(spreadCdf(s, 1180)).toBeCloseTo(0.85, 4);
    expect(spreadQuantile(s, 0.5)).toBeCloseTo(1000, 2);
    expect(spreadQuantile(s, 0.1)).toBeLessThan(1000);
    // a korai oldal szűkebb: 15% kevesebb mint 180 mp-cel van a medián alatt
    expect(1000 - spreadQuantile(s, 0.15)).toBeLessThan(180);
  });

  it("bő tartaléknál biztos, ráhagyás nélkül kockázatos", () => {
    const arrive = spreadOf(NOW, NOW + 120);
    expect(transferChance(arrive, spreadOf(NOW + 900, NOW + 1000), 60)).toBeGreaterThan(0.99);
    // mediánban 30 mp tartalék: inkább eléred, de nem biztos
    const tight = transferChance(arrive, spreadOf(NOW + 120, NOW + 200), 60);
    expect(tight).toBeGreaterThan(0.5);
    expect(chanceLevel(tight)).toBe("tight");
    // mediánban 30 mp hiány: inkább lekésed
    const risky = transferChance(arrive, spreadOf(NOW + 60, NOW + 140), 60);
    expect(risky).toBeLessThan(0.5);
    expect(chanceLevel(risky)).toBe("risky");
  });

  it("több tartalék → nagyobb esély (monoton)", () => {
    const arrive = spreadOf(NOW, NOW + 150);
    let prev = 0;
    for (const gap of [0, 60, 120, 240, 480]) {
      const p = transferChance(arrive, spreadOf(NOW + gap, NOW + gap + 90), 30);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    expect(chanceLevel(prev)).toBe("safe");
  });
});

describe("szokásos utazás", () => {
  const day = (iso: string, hh: number, mm: number) => Math.floor(Date.parse(`${iso}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+01:00`) / 1000);
  const ride = (iso: string, hh: number, mm: number, route = "35", from = "SP190"): CommuteRide => ({
    route,
    headsign: "Centrum",
    fromStopId: from,
    fromStopName: "Ifjúság útja",
    toStopName: "Centrum",
    boardedAt: day(iso, hh, mm),
    serviceDate: iso,
  });
  const now = day("2026-11-03", 7, 0); // kedd

  it("három munkanapon ugyanakkor → szokás; ritka vagy szétszórt utazás nem", () => {
    const rides = [ride("2026-10-27", 7, 38), ride("2026-10-28", 7, 44), ride("2026-10-29", 7, 41), ride("2026-10-30", 17, 5), ride("2026-10-31", 7, 40)];
    const found = detectCommutes(rides, now);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ route: "35", fromStopId: "SP190", dayKind: "workday", rides: 3, days: 3 });
    expect(found[0].minute).toBe(7 * 60 + 41);
  });

  it("a túl régi utazások nem számítanak", () => {
    const old = ["2026-08-03", "2026-08-04", "2026-08-05"].map((d) => ride(d, 7, 40));
    expect(detectCommutes(old, now)).toHaveLength(0);
  });

  it("a kártya a szokásos idő előtt másfél órával jelenik meg, utána negyed óráig marad", () => {
    const rides = ["2026-10-27", "2026-10-28", "2026-10-29"].map((d) => ride(d, 7, 40));
    const cs = detectCommutes(rides, now);
    expect(upcomingCommute(cs, day("2026-11-03", 6, 15), "2026-11-03")?.route).toBe("35");
    expect(upcomingCommute(cs, day("2026-11-03", 7, 40 + COMMUTE.SHOW_AFTER_MIN + 1), "2026-11-03")).toBeNull();
    expect(upcomingCommute(cs, day("2026-11-03", 5, 0), "2026-11-03")).toBeNull();
    // hétvégén nem a munkanapi szokás jön elő
    expect(upcomingCommute(cs, day("2026-11-07", 7, 30), "2026-11-07")).toBeNull();
  });
});

describe("késve induló menet", () => {
  const sched = NOW + 600;

  it("ha a busza időben beér, nincs mit jelezni", () => {
    expect(startRiskOf({ vehicleId: "1649", schedStartUnix: sched, prevEndUnix: sched - 300, deadheadM: 0 })).toBeNull();
  });

  it("ha az előző menete később ér be, a mi menetünk is később indul", () => {
    const r = startRiskOf({ vehicleId: "1649", schedStartUnix: sched, prevEndUnix: sched + 240, deadheadM: 0, prevRoute: "36" })!;
    expect(r.expectedDelayS).toBe(240 + START_RISK.LAYOVER_S);
    expect(r.level).toBe("late");
    expect(r.prevRoute).toBe("36");
  });

  it("másik végállomásról az átállás is beleszámít; nagy késésnél valószínűleg kimarad", () => {
    const r = startRiskOf({ vehicleId: "1649", schedStartUnix: sched, prevEndUnix: sched + 600, deadheadM: 2100 })!;
    expect(r.expectedDelayS).toBe(600 + START_RISK.LAYOVER_S + 300);
    expect(r.level).toBe("likely-missed");
  });
});

describe("dugó a busz előtt", () => {
  it("összeadja a hátralévő torlódó szakaszokat, és megmondja a legrosszabbat", () => {
    const congested = new Map([
      ["B|C", { excessS: 90, level: 0.4 }],
      ["C|D", { excessS: 200, level: 0.9 }],
      ["X|Y", { excessS: 500, level: 1 }],
    ]);
    const r = trafficAhead([["A", "B"], ["B", "C"], ["C", "D"]], congested)!;
    expect(r.excessS).toBe(290);
    expect(r.worst).toMatchObject({ from: "C", to: "D", excessS: 200 });
    expect(trafficAhead([["A", "B"]], congested)).toBeNull();
  });
});
