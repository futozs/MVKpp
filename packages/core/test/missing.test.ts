import { describe, expect, it } from "vitest";
import { findMissingTrips, isOnDemandTrip, type MissingCandidate, type MissingRun } from "../src/index.ts";

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
