import { describe, expect, it } from "vitest";
import { dayPeriod, DELAY_FEATURES, delayFeatureVector, gateCell, horizonBucket, precipClass, profileAhead, RecentTraffic, RunHistory } from "../src/index.ts";

describe("késés-modell jellemzői", () => {
  it("az előtte járó busz késésváltozását csak az addig ismert eseményekből adja", () => {
    const h = new RunHistory();
    // az előző busz 10 perccel korábban: 0. megálló +30 mp, 2. +90 mp, 4. +150 mp
    h.add("P", "leader", 0, 1000, 30);
    h.add("P", "leader", 2, 1200, 90);
    h.add("P", "leader", 4, 1500, 150);
    // a mi buszunk a 0. megállóban 1600-kor
    h.add("P", "me", 0, 1600, 10);
    const full = h.leader("P", "me", 0, 4, 1600);
    expect(full).toEqual({ gain: 120, cover: 1, ageMin: 10 });
    // 1300-kor az előző busz még csak a 2. megállóig jutott
    const part = h.leader("P", "me", 0, 4, 1300);
    expect(part?.gain).toBe(60);
    expect(part?.cover).toBe(0.5);
    // másik nyomvonal / túl régi előző busz nem számít
    expect(h.leader("Q", "me", 0, 4, 1600)).toBeNull();
    expect(h.leader("P", "me", 0, 4, 1000 + 2401)).toBeNull();
  });

  it("a saját késés-trend az utolsó ~3 megállón", () => {
    const h = new RunHistory();
    for (let i = 0; i <= 5; i++) h.add("P", "r", i, 100 * i, 20 * i);
    expect(h.trend("r", 5)).toBe(60); // 5. vs 2. megálló
    expect(h.trend("r", 1)).toBe(20); // csak 1-gyel korábbi van
    expect(h.trend("x", 1)).toBeNull();
  });

  it("a közelmúlt forgalma csak a kérdezett pillanat előtti ablakból számol", () => {
    const t = new RecentTraffic();
    t.add("A", "B", 1000, 30);
    t.add("A", "B", 2000, 60);
    t.add("B", "C", 1900, -10);
    t.add("A", "B", 1500, 90); // időrenden kívül érkezett
    t.finalize();
    expect(t.query([["A", "B"]], 2000, 600)).toEqual({ excess: 75, n: 2 });
    expect(t.query([["A", "B"], ["B", "C"]], 1950, 600)).toEqual({ excess: 40, n: 2 });
    expect(t.query([["C", "D"]], 2000)).toBeNull();
    t.prune(1800);
    expect(t.query([["A", "B"]], 3000, 5000)).toEqual({ excess: 60, n: 1 });
  });

  it("a szakaszprofilok összegzése a menetrendhez képest", () => {
    const stops = [0, 1, 2].map((i) => ({ stopId: `S${i}`, arr: 8 * 3600 + i * 100, dep: 8 * 3600 + i * 100 }));
    const r = profileAhead(stops, 0, () => ({ p50: 130, p85: 170 }));
    expect(r.gain).toEqual([30, 60]);
    expect(r.spread[1]).toBeCloseTo(Math.sqrt(2 * 40 * 40));
  });

  it("a jellemzővektor sorrendje és a hiányzó értékek", () => {
    const v = delayFeatureVector({ d0: 60, ahead: 3, schedAhead: 300, gain: 20, spread: 30, baseline: 14, hour: 7.5, daytype: 0, school: true, trend: null, leader: null, recent: null, precip: null, temp: 5, progress: 0.25 });
    expect(v.length).toBe(DELAY_FEATURES.length);
    expect(v[DELAY_FEATURES.indexOf("d0")]).toBe(60);
    expect(Number.isNaN(v[DELAY_FEATURES.indexOf("trend")])).toBe(true);
    expect(v[DELAY_FEATURES.indexOf("leaderCover")]).toBe(0);
    expect(v[DELAY_FEATURES.indexOf("school")]).toBe(1);
  });

  it("csapadék, napszak és a kapu cellái", () => {
    expect(precipClass(0)).toBe(0);
    expect(precipClass(61)).toBe(1);
    expect(precipClass(95)).toBe(1);
    expect(precipClass(73)).toBe(2);
    expect(precipClass(null)).toBeNull();
    expect(dayPeriod(7.2)).toBe("reggeli csúcs");
    expect(dayPeriod(16)).toBe("délutáni csúcs");
    expect(dayPeriod(24.5)).toBe("hajnal");
    expect(horizonBucket(12)).toBe("11-15");
    expect(gateCell(20, 8)).toBe("16+|reggeli csúcs");
  });
});
