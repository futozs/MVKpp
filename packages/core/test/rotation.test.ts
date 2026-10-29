import { describe, expect, it } from "vitest";
import { planRotations, type RotationSeed, type RotationSlot } from "../src/index.ts";

// Két végállomás ~3 km-re: A (nyugat) és B (kelet).
const A = { lat: 48.1, lon: 20.7 };
const B = { lat: 48.1, lon: 20.74 };
const hm = (h: number, m: number) => h * 3600 + m * 60;

const slot = (tripId: string, route: string, from: typeof A, to: typeof A, start: number, mins = 20): RotationSlot => ({
  tripId,
  key: `${tripId}-key`,
  route,
  tram: route.endsWith("V"),
  startS: start,
  endS: start + mins * 60,
  lat: from.lat,
  lon: from.lon,
  endLat: to.lat,
  endLon: to.lon,
});

const running = (vehicle: string, route: string, at: typeof A, availS: number, key: string | null = null): RotationSeed => ({
  vehicle,
  availS,
  lat: at.lat,
  lon: at.lon,
  key,
  route,
  tram: route.endsWith("V"),
  idle: false,
});

describe("forda-tervező", () => {
  it("a busz a végállomásról a következő menetet viszi, és a lánc órákra kiterjed", () => {
    const slots = [
      slot("t1", "7", B, A, hm(8, 10)),
      slot("t2", "7", A, B, hm(8, 40)),
      slot("t3", "7", B, A, hm(9, 10)),
      slot("t4", "7", A, B, hm(9, 40)),
    ];
    const plan = planRotations(slots, [running("1641", "7", B, hm(8, 5))], new Map());
    expect([...plan.byTrip.keys()]).toEqual(["t1", "t2", "t3", "t4"]);
    expect(plan.byTrip.get("t1")?.vehicle).toBe("1641");
    expect(plan.byTrip.get("t4")?.hops).toBe(4);
    // A bizonyosság a lánc hosszával csökken.
    expect(plan.byTrip.get("t4")!.confidence).toBeLessThan(plan.byTrip.get("t1")!.confidence);
  });

  it("egy menetet csak egy busz kaphat — a korábban szabaddá váló viszi el", () => {
    const slots = [slot("t1", "7", B, A, hm(8, 10)), slot("t2", "7", B, A, hm(8, 20))];
    const plan = planRotations(slots, [running("late", "7", B, hm(8, 8)), running("early", "7", B, hm(8, 2))], new Map());
    expect(plan.byTrip.get("t1")?.vehicle).toBe("early");
    expect(plan.byTrip.get("t2")?.vehicle).toBe("late");
  });

  it("a tanult forda-kapcsolat erősebb a puszta sorrendnél, és a menetet le is foglalja", () => {
    const slots = [slot("t1", "7", B, A, hm(8, 10)), slot("t2", "7", B, A, hm(8, 20))];
    // A „late" busz után a múltban mindig a t1 jött.
    const next = new Map([["prev-key", new Map([["t1-key", 10]])]]);
    const plan = planRotations(slots, [running("early", "7", B, hm(8, 2)), running("late", "7", B, hm(8, 8), "prev-key")], next);
    expect(plan.byTrip.get("t1")).toMatchObject({ vehicle: "late", via: "chain" });
    expect(plan.byTrip.get("t2")?.vehicle).toBe("early");
  });

  it("azonos vonal előnyben, másik vonalra csak rövid várakozással áll át", () => {
    const slots = [slot("x1", "20", B, A, hm(8, 12)), slot("t1", "7", B, A, hm(8, 30))];
    const plan = planRotations(slots, [running("1641", "7", B, hm(8, 5))], new Map());
    expect(plan.byTrip.get("t1")?.vehicle).toBe("1641");
    expect(plan.byTrip.has("x1")).toBe(false);
  });

  it("buszra sosem kerül villamosmenet a közös végállomáson (és fordítva)", () => {
    const slots = [slot("v1", "1V", B, A, hm(8, 8)), slot("b1", "7", B, A, hm(8, 20))];
    const plan = planRotations(slots, [running("1641", "7", B, hm(8, 5)), running("611", "1V", B, hm(8, 6))], new Map());
    expect(plan.byTrip.get("v1")?.vehicle).toBe("611");
    expect(plan.byTrip.get("b1")?.vehicle).toBe("1641");
  });

  it("messze lévő vagy túl késői menetet nem rendel hozzá", () => {
    const far = { lat: 48.2, lon: 20.9 };
    const slots = [slot("t1", "7", far, A, hm(8, 10)), slot("t2", "7", B, A, hm(10, 0))];
    const plan = planRotations(slots, [running("1641", "7", B, hm(8, 5))], new Map());
    expect(plan.byTrip.size).toBe(0);
  });
});
