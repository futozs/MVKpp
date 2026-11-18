import { describe, expect, it } from "vitest";
import { busState, delayPickup, jamCorridors, tramState, type JamSegment } from "../src/fleet.ts";

const pt = (idx: number, delayS: number) => ({ idx, stopId: `S${idx}`, delayS });

describe("hol szedte fel a késést", () => {
  it("a legnagyobb egybefüggő késés-növekedést adja, a közbeni kis behozással együtt", () => {
    const p = delayPickup([pt(0, 30), pt(1, 40), pt(2, 200), pt(3, 190), pt(4, 420), pt(5, 400)])!;
    expect(p).toMatchObject({ fromStopId: "S1", toStopId: "S4", gainS: 380, ongoing: false });
  });

  it("a késve indulás nem felszedett késés, és a kis ingadozás nem jelzés", () => {
    expect(delayPickup([pt(0, 400), pt(1, 410), pt(2, 430)])).toBeNull();
    // sok apró lépés összeadva sem helymegjelölés
    expect(delayPickup([pt(0, 0), pt(1, 25), pt(2, 50), pt(3, 70)])).toBeNull();
  });

  it("a most beragadt busznál a futó szakasz is számít", () => {
    const p = delayPickup([pt(0, 0), pt(1, 20), pt(2, 30)], { toStopId: "S3", toIdx: 3, delayS: 330 })!;
    expect(p).toMatchObject({ fromStopId: "S2", toStopId: "S3", gainS: 300, ongoing: true });
  });

  it("megálló-esemény nélkül nincs mit mondani", () => {
    expect(delayPickup([], { toStopId: "S3", toIdx: 3, delayS: 330 })).toBeNull();
  });
});

describe("villamosvonal állapota", () => {
  const base = { scheduled: 10, running: 10, stalledS: [], replacementRunning: 0, medianDelayS: 60 };

  it("rendben, ha mennek a villamosok", () => expect(tramState(base)).toBe("ok"));
  it("két álló villamos: leállt a vonal (a pótlóbusznál is ez az erősebb)", () => {
    expect(tramState({ ...base, stalledS: [400, 600, 30], replacementRunning: 3 })).toBe("halted");
  });
  it("pótlóbusz jár", () => expect(tramState({ ...base, running: 2, replacementRunning: 4 })).toBe("replaced"));
  it("a menetrendinél jóval kevesebb villamos", () => expect(tramState({ ...base, running: 4 })).toBe("thin"));
  it("egy sokáig álló villamos vagy nagy késés: akadozik", () => {
    expect(tramState({ ...base, stalledS: [9 * 60] })).toBe("late");
    expect(tramState({ ...base, medianDelayS: 300 })).toBe("late");
  });
  it("éjszaka nem jár", () => expect(tramState({ ...base, scheduled: 0, running: 0, medianDelayS: null })).toBe("off"));
});

const seg = (from: string, to: string, excessS: number, level: number): JamSegment => ({ fromId: from, toId: to, from, to, routes: ["1", "2"], excessS, level });

describe("dugófolyosók és a buszhálózat", () => {
  it("az egymásba érő szakaszokból egy folyosó lesz", () => {
    const c = jamCorridors([seg("B", "C", 60, 0.4), seg("X", "Y", 50, 0.3), seg("A", "B", 90, 0.8)]);
    expect(c[0]).toMatchObject({ from: "A", to: "C", links: 2, excessS: 150, level: 0.8 });
    expect(c[1]).toMatchObject({ from: "X", to: "Y", links: 1 });
  });

  it("körbe érő szakaszok sem akasztják meg", () => {
    expect(jamCorridors([seg("A", "B", 10, 0.2), seg("B", "A", 10, 0.2)])).toHaveLength(1);
  });

  it("három súlyos gerincfolyosó vagy sok késő busz: összeomlott", () => {
    const heavy = [seg("A", "B", 200, 0.7), seg("C", "D", 200, 0.7), seg("E", "F", 200, 0.9)].map((s) => jamCorridors([s])[0]);
    expect(busState({ running: 60, late: 3, backbone: heavy })).toBe("collapsed");
    expect(busState({ running: 60, late: 30, backbone: [] })).toBe("collapsed");
    expect(busState({ running: 60, late: 3, backbone: heavy.slice(0, 1) })).toBe("jammed");
    expect(busState({ running: 60, late: 3, backbone: [] })).toBe("ok");
    // egy enyhe, alig lassabb szakasz még nem lassulás
    expect(busState({ running: 60, late: 3, backbone: jamCorridors([seg("A", "B", 40, 0.1)]) })).toBe("ok");
    expect(busState({ running: 60, late: 3, backbone: jamCorridors([seg("A", "B", 90, 0.4)]) })).toBe("slow");
  });

  it("kevés busznál (éjszaka) az arány nem riaszt", () => {
    expect(busState({ running: 6, late: 4, backbone: [] })).toBe("ok");
  });
});
