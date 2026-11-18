import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "@mvk/core";
import { busTile, tramTile, vehicleRef, verdictText } from "../src/components/fleet/fleetText";

const tram: BoardSnapshot["tram"] = {
  state: "collapsed",
  scheduled: 11,
  running: 11,
  replacementRunning: 0,
  replacementPlanned: false,
  medianDelayS: 268,
  severe: 4,
  late: 5,
  maxDelayS: 1696,
  trouble: { from: "Városház tér", to: "Diósgyőri Gimnázium", toward: "Felső-Majláth", vehicles: 4 },
  stalled: [],
  analysis: { lines: [], verdict: { kind: "queue", toward: "Felső-Majláth", head: "609", behind: 2, fromStop: "Villanyrendőr", toStop: "Városház tér", sinceS: 0, otherOk: true, otherToward: "Tiszai pályaudvar" } },
};

describe("a villamos csempéje", () => {
  it("összeomláskor két szó és a szám", () => {
    expect(tramTile(tram)).toEqual({ tone: "bad", title: "Összeomlott", sub: "4 késik 10+ percet" });
  });

  it("ha már minden villamos halad, nem omlásnak, hanem megmaradt késésnek írja", () => {
    expect(tramTile({ ...tram, analysis: { lines: [], verdict: { kind: "ok" } } }).title).toBe("Nagy késések");
  });

  it("álló sornál a sor elejét nevezi meg", () => {
    const t = tramTile({
      ...tram,
      state: "halted",
      analysis: { lines: [], verdict: { kind: "one-way", toward: "Felső-Majláth", head: "630", behind: 1, fromStop: "Szinvapark / Centrum", toStop: "Villanyrendőr", sinceS: 300, otherOk: false, otherToward: null } },
    });
    expect(t).toEqual({ tone: "bad", title: "Áll", sub: "elöl a 630-as, Szinvapark / Centrum" });
  });
});

describe("a busz csempéje", () => {
  it("torlódásnál a legrosszabb folyosót mutatja", () => {
    const t = busTile({
      state: "jammed",
      running: 50,
      late: 9,
      early: 3,
      medianDelayS: 120,
      corridors: [{ from: "Búza tér", to: "Szinvapark", fromId: "a", toId: "b", links: 3, excessS: 400, level: 0.8, routes: ["1", "3"] }],
      otherJams: 0,
    });
    expect(t).toEqual({ tone: "bad", title: "Torlódik", sub: "Búza tér → Szinvapark" });
  });
});

describe("a vonal-elemző szövegei", () => {
  it("egy irányban álló sor: ki áll elöl, hány rekedt mögötte, és a másik irány halad", () => {
    const v = verdictText({ kind: "one-way", toward: "Felső-Majláth", head: "609", behind: 2, fromStop: "Villanyrendőr", toStop: "Városház tér", sinceS: 480, otherOk: true, otherToward: "Tiszai pályaudvar" });
    expect(v.title).toBe("Áll a sor Felső-Majláth felé");
    expect(v.text).toBe("Elöl a 609-es áll 8 perce, Villanyrendőr és Városház tér között, mögötte 2 villamos. Előtte akadály van, vagy ő hibásodott meg. A másik irány halad.");
  });

  it("névelő a pályaszám előtt", () => {
    expect(vehicleRef("609")).toBe("a 609-es");
    expect(vehicleRef("501")).toBe("az 501-es");
    expect(vehicleRef("1644")).toBe("az 1644-es");
  });
});
