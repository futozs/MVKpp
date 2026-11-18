import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "@mvk/core";
import { tramStatus, vehicleRef, verdictText } from "../src/components/fleet/fleetText";

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

describe("a villamos állapota szövegben", () => {
  it("összeomláskor kimondja, merre és hol szedték fel a késést", () => {
    const s = tramStatus(tram);
    expect(s.tone).toBe("bad");
    expect(s.title).toBe("Összeomlott a villamosközlekedés");
    expect(s.detail).toContain("4 villamos késik 10 percnél többet");
    expect(s.detail).toContain("A Felső-Majláth felé tartók Városház tér és Diósgyőri Gimnázium között szedték fel a késést.");
    expect(s.detail).toContain("+28 perc");
  });

  it("ha már minden villamos halad, nem omlásnak, hanem megmaradt késésnek írja", () => {
    const s = tramStatus({ ...tram, analysis: { lines: [], verdict: { kind: "ok" } } });
    expect(s.title).toBe("Nagy késésekkel jár a villamos");
    expect(s.detail).toContain("a késés a korábbi zavarból maradt");
  });

  it("magánhangzós végállomás elé „Az” kerül", () => {
    const s = tramStatus({ ...tram, trouble: { from: "Városház tér", to: "Diósgyőri Gimnázium", toward: "Újgyőri főtér", vehicles: 4 } });
    expect(s.detail).toContain("Az Újgyőri főtér felé tartók");
  });
});

describe("a vonal-elemző szövegei", () => {
  it("egy irányban álló sor: ki áll elöl, hány rekedt mögötte, és a másik irány halad", () => {
    const v = verdictText({ kind: "one-way", toward: "Felső-Majláth", head: "609", behind: 2, fromStop: "Villanyrendőr", toStop: "Városház tér", sinceS: 480, otherOk: true, otherToward: "Tiszai pályaudvar" });
    expect(v.title).toBe("Áll a sor Felső-Majláth felé");
    expect(v.text).toContain("A 609-es villamos áll elöl Villanyrendőr és Városház tér között, 8 perce; mögötte 2 villamos rekedt.");
    expect(v.text).toContain("a baj csak a Felső-Majláth felé tartó oldalon van");
  });

  it("áll a villamosforgalom: a kártya a sor elejét nevezi meg", () => {
    const s = tramStatus({
      ...tram,
      state: "halted",
      analysis: { lines: [], verdict: { kind: "one-way", toward: "Felső-Majláth", head: "630", behind: 1, fromStop: "Szinvapark / Centrum", toStop: "Szinvapark / Centrum", sinceS: 300, otherOk: false, otherToward: null } },
    });
    expect(s.detail).toBe("A 630-as villamos áll elöl Szinvapark / Centrum megállónál, mögötte 1 villamos, Felső-Majláth felé.");
  });

  it("névelő a pályaszám előtt", () => {
    expect(vehicleRef("609")).toBe("a 609-es");
    expect(vehicleRef("501")).toBe("az 501-es");
    expect(vehicleRef("1644")).toBe("az 1644-es");
  });
});
