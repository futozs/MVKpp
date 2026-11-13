import { describe, expect, it } from "vitest";
import {
  findMissingTrips,
  isOnDemandTrip,
  isPullOut,
  type MissingCandidate,
  type MissingRun,
  quietTripIds,
  type ScheduledLeg,
  silentRuns,
} from "../src/index.ts";

const UJGYOR = { lat: 48.1036, lon: 20.6894 };
const TISZAI = { lat: 48.1029, lon: 20.8026 };
const H = 3600;
const NOW = 8 * H;

function cand(over: Partial<MissingCandidate> = {}): MissingCandidate {
  return { tripId: "t1", route: "1", headsign: "Tiszai pályaudvar", depS: NOW - 30 * 60, fromLat: UJGYOR.lat, fromLon: UJGYOR.lon, ...over };
}

function run(over: Partial<MissingRun> = {}): MissingRun {
  return { route: "1", schedStartS: NOW - 40 * 60, schedEndS: NOW - 10 * 60, running: false, toLat: null, toLon: null, ...over };
}

/** a vonal két szomszédos menete, amit láttunk */
const neighbours = [run({ schedStartS: NOW - 50 * 60 }), run({ schedStartS: NOW - 10 * 60 })];

describe("isOnDemandTrip", () => {
  it("recognises both MVK spellings of on-demand trips", () => {
    expect(isOnDemandTrip("Újgyőri főtér - Pereces (igény esetén)")).toBe(true);
    expect(isOnDemandTrip("Pereces - Újgyőri főtér igény esetén")).toBe(true);
    expect(isOnDemandTrip("Mechatronikai Park - Repülőtér/Bosch  (IGÉNY ESETÉN)")).toBe(true);
    expect(isOnDemandTrip("Tiszai pályaudvar")).toBe(false);
  });
});

describe("findMissingTrips", () => {
  it("flags a regular trip nobody started while the line's neighbours ran", () => {
    const out = findMissingTrips([cand()], neighbours, NOW);
    expect(out).toEqual([{ tripId: "t1", route: "1", headsign: "Tiszai pályaudvar", depS: NOW - 30 * 60, lateMin: 30 }]);
  });

  it("never flags on-demand trips", () => {
    const out = findMissingTrips([cand({ headsign: "Újgyőri főtér - Pereces (igény esetén)" })], neighbours, NOW);
    expect(out).toEqual([]);
  });

  it("stays quiet when the line's neighbouring trips were not seen", () => {
    expect(findMissingTrips([cand()], [run({ schedStartS: NOW - 3 * H })], NOW)).toEqual([]);
    expect(findMissingTrips([cand()], [neighbours[0]], NOW)).toEqual([]);
  });

  it("treats a late bus still heading to the start terminus as a delay", () => {
    const inbound = run({ route: "2", schedStartS: NOW - 80 * 60, schedEndS: NOW - 35 * 60, running: true, toLat: UJGYOR.lat + 0.001, toLon: UJGYOR.lon });
    expect(findMissingTrips([cand()], [...neighbours, inbound], NOW)).toEqual([]);
  });

  it("ignores running buses that end somewhere else or long before", () => {
    const elsewhere = run({ schedEndS: NOW - 35 * 60, running: true, toLat: TISZAI.lat, toLon: TISZAI.lon });
    const longBefore = run({ schedEndS: NOW - 2 * H, running: true, toLat: UJGYOR.lat, toLon: UJGYOR.lon });
    expect(findMissingTrips([cand()], [...neighbours, elsewhere, longBefore], NOW)).toHaveLength(1);
  });

  it("only looks 15–90 minutes back", () => {
    expect(findMissingTrips([cand({ depS: NOW - 10 * 60 })], neighbours, NOW)).toEqual([]);
    expect(findMissingTrips([cand({ depS: NOW - 100 * 60 })], neighbours, NOW)).toEqual([]);
  });
});

// A 2026-11-02-i hajnal mintái: a garázsból (Szondi Gy. u.) kiálló menet alatt az OBU
// néma, a busz csak a végállomáson, a következő menetén jelentkezik.
const SZONDI = { lat: 48.0951, lon: 20.7589 };
const AVAS = { lat: 48.0966, lon: 20.7871 };
const M = 60;

function leg(over: Partial<ScheduledLeg> & { tripId: string }): ScheduledLeg {
  return { serviceId: "10921", depS: 3 * H + 40 * M, arrS: 3 * H + 55 * M, fromLat: SZONDI.lat, fromLon: SZONDI.lon, toLat: UJGYOR.lat, toLon: UJGYOR.lon, ...over };
}

/** 1G 03:40 Szondi Gy. u. → Újgyőri főtér (érk. 03:55), és a forda következő menete: 6-os 03:55 Újgyőri főtérről */
const pullOut = leg({ tripId: "1G-0340" });
const next6 = leg({ tripId: "6-0355", depS: 3 * H + 55 * M, arrS: 4 * H + 10 * M, fromLat: UJGYOR.lat, fromLon: UJGYOR.lon, toLat: AVAS.lat, toLon: AVAS.lon });

describe("isPullOut", () => {
  it("treats a trip with no same-group trip arriving at its start shortly before as a pull-out", () => {
    expect(isPullOut(pullOut, [pullOut, next6])).toBe(true);
  });

  it("is not a pull-out when a trip of the same group ends at its start just before", () => {
    expect(isPullOut(next6, [pullOut, next6])).toBe(false);
  });

  it("only counts arrivals of the same group", () => {
    const otherGroup = { ...pullOut, tripId: "x", serviceId: "10999" };
    expect(isPullOut(next6, [otherGroup, next6])).toBe(true);
  });

  it("counts the first trip after a long break as a pull-out", () => {
    const longBefore = { ...pullOut, tripId: "early", depS: 1 * H, arrS: 1 * H + 15 * M };
    expect(isPullOut(next6, [longBefore, next6])).toBe(true);
  });
});

describe("silentRuns", () => {
  it("credits the bus that showed up at the end stop on time for the same group's next trip", () => {
    const out = silentRuns([pullOut], [{ ...next6, vehicleId: "1673" }]);
    expect([...out]).toEqual([["1G-0340", "1673"]]);
  });

  it("needs the same group, the same place and a plausible layover", () => {
    expect(silentRuns([pullOut], [{ ...next6, serviceId: "10999", vehicleId: "1673" }]).size).toBe(0);
    expect(silentRuns([pullOut], [{ ...next6, fromLat: TISZAI.lat, fromLon: TISZAI.lon, vehicleId: "1673" }]).size).toBe(0);
    expect(silentRuns([pullOut], [{ ...next6, depS: pullOut.arrS + 45 * M, arrS: pullOut.arrS + 60 * M, vehicleId: "1673" }]).size).toBe(0);
  });

  it("does not credit a bus that was seen on another trip at the same time", () => {
    const busy = leg({ tripId: "elsewhere", serviceId: "777", depS: 3 * H + 35 * M, arrS: 3 * H + 58 * M });
    expect(silentRuns([pullOut], [{ ...next6, vehicleId: "1673" }, { ...busy, vehicleId: "1673" }]).size).toBe(0);
  });

  it("credits a bus that went quiet between two seen trips (1615 on route 11)", () => {
    const BUZA = TISZAI;
    const out1 = leg({ tripId: "11-0420", serviceId: "10999", depS: 4 * H + 20 * M, arrS: 4 * H + 33 * M, fromLat: BUZA.lat, fromLon: BUZA.lon, toLat: UJGYOR.lat, toLon: UJGYOR.lon });
    const back = leg({ tripId: "11-0435", serviceId: "10999", depS: 4 * H + 35 * M, arrS: 4 * H + 44 * M, fromLat: UJGYOR.lat, fromLon: UJGYOR.lon, toLat: BUZA.lat, toLon: BUZA.lon });
    const out2 = { ...out1, tripId: "11-0450", depS: 4 * H + 50 * M, arrS: 5 * H + 3 * M };
    const out = silentRuns([back], [{ ...out1, vehicleId: "1615" }, { ...out2, vehicleId: "1615" }]);
    expect(out.get("11-0435")).toBe("1615");
  });

  it("lets one sighting explain only one trip, the one closest in time", () => {
    const earlier = { ...pullOut, tripId: "1G-0320", depS: 3 * H + 20 * M, arrS: 3 * H + 35 * M };
    const out = silentRuns([earlier, pullOut], [{ ...next6, vehicleId: "1673" }]);
    expect([...out]).toEqual([["1G-0340", "1673"]]);
  });

  it("follows a chain of silent trips back from the sighting", () => {
    const out = leg({ tripId: "1-0400", serviceId: "10959", depS: 4 * H, arrS: 4 * H + 29 * M, fromLat: TISZAI.lat, fromLon: TISZAI.lon, toLat: AVAS.lat, toLon: AVAS.lon });
    const back = leg({ tripId: "1-0430", serviceId: "10959", depS: 4 * H + 30 * M, arrS: 4 * H + 58 * M, fromLat: AVAS.lat, fromLon: AVAS.lon, toLat: TISZAI.lat, toLon: TISZAI.lon });
    const seen = { ...out, tripId: "1-0505", depS: 5 * H + 5 * M, arrS: 5 * H + 34 * M, vehicleId: "1652" };
    expect(silentRuns([out, back], [seen])).toEqual(new Map([["1-0430", "1652"], ["1-0400", "1652"]]));
  });
});

describe("quietTripIds", () => {
  it("drops pull-outs and trips a bus ran without data, keeps the rest", () => {
    const realGap = leg({ tripId: "6-0410", depS: 4 * H + 10 * M, arrS: 4 * H + 25 * M, fromLat: AVAS.lat, fromLon: AVAS.lon, toLat: UJGYOR.lat, toLon: UJGYOR.lon });
    const legs = new Map([pullOut, next6, realGap].map((l) => [l.tripId, l]));
    // a 6-os 03:55 lement, utána a 04:10 a busz előző menetének végéről indulna  ott valódi hiány van
    const quiet = quietTripIds(["1G-0340", "6-0410"], legs, [{ tripId: "6-0355", vehicleId: "1673" }]);
    expect([...quiet]).toEqual(["1G-0340"]);
  });

  it("ignores sightings of trips that are not in today's schedule", () => {
    const legs = new Map([pullOut].map((l) => [l.tripId, l]));
    const quiet = quietTripIds(["1G-0340"], legs, [{ tripId: "unknown", vehicleId: "1673" }]);
    expect([...quiet]).toEqual(["1G-0340"]); // garázsmenet  ettől még csendes
  });
});
