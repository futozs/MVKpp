import { describe, expect, it } from "vitest";
import { computeParking, PARKING, type FleetVehicle, type LiveSeen, type ParkingInput, type RunOut, type TripEnds } from "../src/index.ts";

const NOW = 1_800_000_000;
const TISZAI = { name: "Tiszai pályaudvar", lat: 48.1029, lon: 20.8026 };
const UJGYOR = { name: "Újgyőri főtér", lat: 48.1036, lon: 20.6894 };
const SZONDI = { name: "Szondi György utca", lat: 48.1057, lon: 20.8135 };

const ends: Record<string, TripEnds> = {
  t1: { first: TISZAI, last: UJGYOR },
  t2: { first: UJGYOR, last: TISZAI },
  g1: { first: UJGYOR, last: SZONDI },
  v1: { first: TISZAI, last: UJGYOR },
};

function run(over: Partial<RunOut> & { vehicleId: string; tripId: string }): RunOut {
  return {
    runKey: `${over.tripId}@${over.vehicleId}`,
    serviceDate: "2027-01-15",
    routeId: "1",
    routeShort: "1",
    dir: 0,
    pattern: "p",
    headsign: "Újgyőri főtér",
    feedVersion: "f",
    schedStartS: 8 * 3600,
    schedEndS: 8 * 3600 + 1800,
    stopsTotal: 20,
    stopsSeen: 20,
    openedTs: NOW - 3600,
    lastTs: NOW - 600,
    actualStart: NOW - 3500,
    actualEnd: NOW - 600,
    startDelayS: 0,
    endDelayS: 60,
    lastDelayS: 60,
    lastStopIdx: 19,
    distM: 9000,
    maxSpeed: 12,
    status: "complete",
    closeReason: "final-stop",
    ...over,
  };
}

const fleet = (id: string, kind: "bus" | "tram" = "bus"): FleetVehicle => ({
  id,
  kind,
  lastDate: "2027-01-14",
  streakDays: 3,
  outShare: 0.8,
  usualOutS: 5 * 3600,
  recent: "11011101110111",
  topRoutes: ["1"],
});

function input(runs: RunOut[], seen: Record<string, LiveSeen> = {}, extra: Partial<ParkingInput> = {}): ParkingInput {
  return {
    now: NOW,
    serviceDate: "2027-01-15",
    midnight: NOW - 18 * 3600,
    fleet: [fleet("1641"), fleet("1606"), fleet("36"), fleet("611", "tram")],
    runs,
    seen: new Map(Object.entries(seen)),
    tripEnds: (t) => ends[t] ?? null,
    terminals: [TISZAI, UJGYOR],
    busDepot: SZONDI,
    isDepotStop: (kind, name) => kind === "bus" && name.startsWith("Szondi"),
    isTramRoute: (r) => r.endsWith("V"),
    tipFor: () => null,
    ...extra,
  };
}

const where = (snap: ReturnType<typeof computeParking>, id: string) => {
  for (const t of snap.terminals) if (t.vehicles.some((v) => v.id === id)) return `terminus:${t.name}`;
  for (const d of snap.depots) {
    const v = d.vehicles.find((x) => x.id === id);
    if (v) return `depot:${d.id}:${v.reason}`;
  }
  if (snap.nosignal.some((v) => v.id === id)) return "nosignal";
  if (snap.service.some((v) => v.id === id)) return "service";
  return "?";
};

describe("parkoló", () => {
  it("a beért, néma busz a menete végállomásán parkol, amíg le nem telik az 1 óra", () => {
    const r = run({ vehicleId: "1641", tripId: "t1" });
    expect(where(computeParking(input([r])), "1641")).toBe("terminus:Újgyőri főtér");
    const old = run({ vehicleId: "1641", tripId: "t1", actualEnd: NOW - PARKING.limitS - 60, lastTs: NOW - PARKING.limitS - 60 });
    expect(where(computeParking(input([old])), "1641")).toBe("depot:bus:timeout");
  });

  it("a G-járattal beálló busz a kocsiszínbe kerül", () => {
    const r = run({ vehicleId: "1606", tripId: "g1", routeShort: "1G" });
    expect(where(computeParking(input([r])), "1606")).toBe("depot:bus:pull-in");
  });

  it("aki ma még nem volt kint, a kocsiszínben van", () => {
    const snap = computeParking(input([]));
    expect(where(snap, "36")).toBe("depot:bus:not-today");
    expect(where(snap, "611")).toBe("depot:tram:not-today");
    expect(snap.counts.tram.depot).toBe(1);
  });

  it("akinek már kiadták a menetét, a kiinduló végállomáson indulásra vár (biztos indulással)", () => {
    const r = run({ vehicleId: "1641", tripId: "t2", status: "running", actualStart: null, actualEnd: null, closeReason: null, schedStartS: 9 * 3600 });
    const snap = computeParking(input([r], { "1641": { ts: NOW - 20, lat: UJGYOR.lat, lon: UJGYOR.lon, speed: 0, route: "1" } }));
    const t = snap.terminals.find((x) => x.name === "Újgyőri főtér")!;
    expect(t.vehicles[0]).toMatchObject({ id: "1641", online: true, next: { tripId: "t2", certain: true, startS: 9 * 3600 } });
  });

  it("a menetet vivő busz bevetésen van; menet nélkül mozgó busz úton van", () => {
    const r = run({ vehicleId: "1641", tripId: "t1", status: "running", actualEnd: null, closeReason: null });
    const snap = computeParking(input([r], { "36": { ts: NOW - 10, lat: 48.0, lon: 20.75, speed: 10, route: null } }));
    expect(where(snap, "1641")).toBe("service");
    expect(snap.service.find((v) => v.id === "36")?.deadhead).toBe(true);
  });

  it("élőben a végállomásnál álló, menet nélküli busz ott parkol — időkorlát nélkül", () => {
    const snap = computeParking(input([], { "36": { ts: NOW - 30, lat: TISZAI.lat + 0.001, lon: TISZAI.lon, speed: 0, route: "1" } }));
    expect(where(snap, "36")).toBe("terminus:Tiszai pályaudvar");
  });

  it("élőben a telephelyen álló busz kocsiszínben van", () => {
    const snap = computeParking(input([], { "36": { ts: NOW - 30, lat: SZONDI.lat, lon: SZONDI.lon, speed: 0, route: null } }));
    expect(where(snap, "36")).toBe("depot:bus:seen");
  });

  it("menet közben elnémult busz „jel nélkül” — 1 óra után kocsiszín", () => {
    const r = run({ vehicleId: "1641", tripId: "t1", stopsSeen: 8, closeReason: "silence", actualEnd: null, lastTs: NOW - 900 });
    expect(where(computeParking(input([r])), "1641")).toBe("nosignal");
  });

  it("a villamos-menet alapján villamosnak számít, és a tipp a parkoló járműhöz kerül", () => {
    const r = run({ vehicleId: "611", tripId: "v1", routeShort: "1V" });
    const tip = { tripId: "t2", route: "1V", startS: 9 * 3600, confidence: 0.8, certain: false };
    const snap = computeParking(input([r], {}, { tipFor: (id) => (id === "611" ? tip : null) }));
    const v = snap.terminals[0].vehicles[0];
    expect(v).toMatchObject({ id: "611", kind: "tram", next: tip });
    expect(snap.counts.tram.terminus).toBe(1);
  });
});
