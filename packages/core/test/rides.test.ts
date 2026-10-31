import { describe, expect, it } from "vitest";
import { alightAt, boardAt, currentStopIdx, guessAlightIdx, guessBoardIdx, pathLengthM, rideStopIdx, stopTimes, type RideStop } from "../src/rides.ts";

// Egy egyenes utca: a megállók ~445 m-enként északra (0,004 fok szélesség).
const LAT0 = 48.1;
const LON = 20.78;
const latOf = (i: number) => LAT0 + i * 0.004;
const stop = (i: number, id = `S${i}`): RideStop => ({ idx: i, id, name: `Megálló ${i}`, lat: latOf(i), lon: LON, schedTs: 1_000_000 + i * 120 });
const line = (n: number) => Array.from({ length: n }, (_, i) => stop(i));
/** a megállótól `m` méterre északra */
const near = (i: number, m = 0) => ({ lat: latOf(i) + m / 111_320, lon: LON });

describe("hol tart most a busz", () => {
  const stops = line(8);

  it("amíg a megállóban áll, a motor még az előzőt mutatja — a hely szerint már ott van", () => {
    expect(currentStopIdx(stops, 2, near(3, 15))).toBe(3);
  });

  it("menet közben (két megálló között) az utolsó elhagyott megálló", () => {
    expect(currentStopIdx(stops, 2, near(2, 220))).toBe(2);
  });

  it("indulás előtt az első megállónál", () => {
    expect(currentStopIdx(stops, -1, near(0))).toBe(0);
    expect(currentStopIdx(stops, -1, null)).toBe(0);
  });
});

describe("felszállás megállója a GPS-ből", () => {
  const stops = line(8);

  it("a megállóban, a busz mellett nyomva: az a megálló, nem az előző", () => {
    expect(guessBoardIdx(stops, 2, near(3, 10), near(3, 5))).toBe(3);
  });

  it("felismerés: ahol a busz mellett állt, mielőtt együtt elindultak — akkor is, ha a busz azóta továbbment", () => {
    expect(guessBoardIdx(stops, 5, near(3, 20), near(5, 200))).toBe(3);
  });

  it("késve nyomva, két megálló között: az utolsó elhagyott (a következőnél még nem járt a busz)", () => {
    expect(guessBoardIdx(stops, 4, near(4, 300), near(4, 310))).toBe(4);
  });

  it("telefonhely nélkül: ahol a busz most tart", () => {
    expect(guessBoardIdx(stops, 2, null, near(3, 20))).toBe(3);
    expect(guessBoardIdx(stops, 2, null, null)).toBe(2);
  });

  it("a végállomáson nem lehet felszállni", () => {
    expect(guessBoardIdx(stops, 6, near(7), near(7))).toBe(6);
  });

  it("messze minden megállótól (rossz GPS): ahol a busz tart", () => {
    expect(guessBoardIdx(stops, 3, { lat: latOf(3), lon: LON + 0.02 }, null)).toBe(3);
  });

  it("körjárat: ugyanaz a megálló az elején és a végén — a busz előrehaladása dönt", () => {
    const loop = [...line(5), stop(0, "S0")].map((s, i) => ({ ...s, idx: i }));
    expect(guessBoardIdx(loop, -1, near(0), near(0))).toBe(0);
  });
});

describe("leszállás megállója, ha a telefon már nincs a buszon", () => {
  const stops = line(10);

  it("a telefonhoz legközelebbi elhagyott megálló (a felszállás után)", () => {
    expect(guessAlightIdx(stops, 1, 7, near(4, 60), 3)).toBe(4);
  });

  it("nem korábbi annál, ahol utoljára a busszal volt", () => {
    expect(guessAlightIdx(stops, 1, 7, near(2, 10), 5)).toBe(5);
  });

  it("ha a telefon messze van mindentől: ahol utoljára a busszal volt", () => {
    expect(guessAlightIdx(stops, 1, 7, { lat: latOf(4), lon: LON + 0.03 }, 3)).toBe(3);
  });

  it("semmi nyom: ahol a busz most tart", () => {
    expect(guessAlightIdx(stops, 1, 7, null, null)).toBe(7);
  });

  it("legalább a felszállás utáni megálló", () => {
    expect(guessAlightIdx(stops, 4, 4, near(4), null)).toBe(5);
  });
});

describe("javítás: mezők a menet eseményeiből", () => {
  const stops = line(6);
  const times = stopTimes([
    { stop_idx: 1, arr: 1_000_130, dep: 1_000_150, delay_s: 10 },
    { stop_idx: 2, arr: 1_000_300, dep: 1_000_320, delay_s: 60 },
    { stop_idx: 4, arr: 1_000_600, dep: null, delay_s: 120 },
  ]);

  it("felszállás: a tényleges indulás onnan és az ottani késés", () => {
    expect(boardAt(stops, times, 2, { at: 1, delayS: 0 })).toEqual({ fromStopId: "S2", fromStopName: "Megálló 2", boardedAt: 1_000_320, delayAtBoardS: 60 });
  });

  it("leszállás: az érkezés oda", () => {
    expect(alightAt(stops, times, 4, { at: 1, delayS: null })).toMatchObject({ toStopId: "S4", alightedAt: 1_000_600, delayAtAlightS: 120 });
  });

  it("esemény nélkül (a busz még ott áll): a megadott időpont, ennek híján a menetrend és az ismert késés", () => {
    expect(alightAt(stops, times, 5, { at: 77, delayS: null })?.alightedAt).toBe(77);
    expect(boardAt(stops, times, 3, { at: null, delayS: 30 })).toMatchObject({ boardedAt: stops[3].schedTs + 30, delayAtBoardS: 30 });
    expect(boardAt(stops, times, 9, { at: 1, delayS: 0 })).toBeNull();
  });

  it("az út hossza megállóról megállóra", () => {
    expect(pathLengthM(stops, 1, 4)).toBeGreaterThan(1300);
    expect(pathLengthM(stops, 1, 4)).toBeLessThan(1360);
    expect(pathLengthM(stops, 2, 2)).toBe(0);
  });

  it("a mentett utazás megállói a menetben (körjáratnál a leszállás a felszállás utáni)", () => {
    const loop = [...line(5), stop(0, "S0")].map((s, i) => ({ ...s, idx: i }));
    expect(rideStopIdx(loop, "S0", "S0")).toEqual({ from: 0, to: 5 });
    expect(rideStopIdx(loop, "S2", "S4")).toEqual({ from: 2, to: 4 });
    expect(rideStopIdx(loop, "X", "S4")).toEqual({ from: null, to: 4 });
  });
});
