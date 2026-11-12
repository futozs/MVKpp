import { describe, expect, it } from "vitest";
import { journeyDelay, rideStats, type StatRide } from "../src/rideStats.ts";

// 2026-11-10 kedd 06:52 (Budapest, CET)
const T = Date.UTC(2026, 10, 10, 5, 52) / 1000;

const ride = (p: Partial<StatRide>): StatRide => ({
  id: p.id ?? Math.random().toString(36),
  route: "14",
  color: "123456",
  text: "FFFFFF",
  vehicleId: "MVK-101",
  boardedAt: T,
  alightedAt: T + 600,
  fromStopId: "A",
  fromStopName: "Cementgyár",
  toStopId: "B",
  toStopName: "Hősök tere",
  stops: 5,
  distanceM: 2000,
  delayAtBoardS: 60,
  delayAtAlightS: 240,
  ...p,
});

describe("egy út késése", () => {
  it("a plusz idő a buszon a leszállási és felszállási késés különbsége", () => {
    expect(journeyDelay([ride({})])).toEqual({ boardS: 60, alightS: 240, extraS: 180 });
  });

  it("körbeutazásnál az első menet felszállása és az utolsó leszállása számít", () => {
    const legs = [ride({ delayAtBoardS: 30, delayAtAlightS: 400 }), ride({ delayAtBoardS: 0, delayAtAlightS: 330 })];
    expect(journeyDelay(legs).extraS).toBe(300);
  });

  it("ha a busz behozott a késésből, nincs negatív plusz idő", () => {
    expect(journeyDelay([ride({ delayAtBoardS: 300, delayAtAlightS: 120 })]).extraS).toBe(0);
  });

  it("ismeretlen késésnél nincs plusz idő", () => {
    expect(journeyDelay([ride({ delayAtAlightS: null })]).extraS).toBeNull();
  });
});

describe("Utazásaim összesítés", () => {
  const journeys = [
    [ride({ id: "a" })],
    [ride({ id: "b", boardedAt: T + 86_400, alightedAt: T + 86_400 + 1200, delayAtBoardS: 0, delayAtAlightS: 600, distanceM: 5000 })],
    [
      ride({ id: "c1", fromStopName: "Petneházy-bérházak", fromStopId: "P", toStopName: "Cementgyár", toStopId: "A", delayAtBoardS: 420, delayAtAlightS: 500 }),
      ride({ id: "c2", fromStopName: "Cementgyár", fromStopId: "A", toStopName: "Hejőpark", toStopId: "H", delayAtBoardS: 0, delayAtAlightS: 480 }),
    ],
  ];
  const s = rideStats(journeys);

  it("a körbeutazás egy útnak számít", () => {
    expect(s.journeys).toBe(3);
    expect(s.loops).toBe(1);
  });

  it("összegzi a késések miatt a buszon töltött plusz időt és a várakozást", () => {
    // 180 + 600 + (480 − 420)
    expect(s.extraOnboardS).toBe(840);
    expect(s.lateWaitS).toBe(60 + 0 + 420);
    expect(s.delayMeasured).toBe(3);
  });

  it("megszámolja a fel- és leszállások helyét és a begyűjtött megállókat", () => {
    expect(s.boardStops[0]).toMatchObject({ name: "Cementgyár", n: 2 });
    expect(s.alightStops.map((x) => x.name)).toEqual(["Hősök tere", "Hejőpark"]);
    expect(s.stopsCollected.map((x) => x.name).sort()).toEqual(["Cementgyár", "Hejőpark", "Hősök tere", "Petneházy-bérházak"]);
    expect(s.pairs[0]).toEqual({ from: "Cementgyár", to: "Hősök tere", n: 2 });
  });

  it("budapesti idő szerint számolja az órát és a hét napját", () => {
    expect(s.hours[6]).toBe(3);
    expect(s.weekdays[1]).toBe(2); // kedd
    expect(s.weekdays[2]).toBe(1); // szerda
  });

  it("a rekordok az egész útra vonatkoznak", () => {
    expect(s.longest?.legs[0].id).toBe("b");
    expect(s.mostDelayed?.value).toBe(600);
    expect(s.routes[0]).toMatchObject({ route: "14", n: 4 });
  });
});
