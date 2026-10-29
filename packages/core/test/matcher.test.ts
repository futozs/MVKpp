import { describe, expect, it } from "vitest";
import { feedFromFiles, resolveServiceDay, localMidnightUnix, TripMatcher, type RunOut, type StopEventOut } from "../src/index.ts";

// Egyenes, kelet felé futó vonal: A (0 m) → B (~1490 m) → C (~2980 m), és vissza.
const LAT = 48.1;
const lonAt = (m: number) => 20.7 + m / (111_320 * Math.cos((LAT * Math.PI) / 180));
const files = {
  "feed_info.txt": "feed_version\n20261029-1\n",
  "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,${LAT},${lonAt(0)}\nB,Béta,${LAT},${lonAt(1490)}\nC,Céta,${LAT},${lonAt(2980)}\n`,
  "routes.txt": "route_id,route_short_name,route_type,route_color,route_text_color\n7,7,3,FF0000,FFFFFF\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n7,S,S_1_080000_X,Céta,0,SH1\n7,S,S_2_081000_X,Alfa,1,SH2\n",
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    "S_1_080000_X,08:00:00,08:00:00,A,1",
    "S_1_080000_X,08:03:00,08:03:00,B,2",
    "S_1_080000_X,08:06:00,08:06:00,C,3",
    "S_2_081000_X,08:10:00,08:10:00,C,1",
    "S_2_081000_X,08:13:00,08:13:00,B,2",
    "S_2_081000_X,08:16:00,08:16:00,A,3",
  ].join("\n"),
  "calendar_dates.txt": "service_id,date,exception_type\nS,20261029,1\n",
  "shapes.txt": [
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => `SH1,${LAT},${lonAt(i * 500)},${i}`),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => `SH2,${LAT},${lonAt(3000 - i * 500)},${i}`),
  ].join("\n"),
};

const feed = feedFromFiles(files);
const day = resolveServiceDay([feed], "2026-10-29")!;
const midnight = localMidnightUnix("2026-10-29");
const at = (hms: string) => {
  const [h, m, s] = hms.split(":").map(Number);
  return midnight + h * 3600 + m * 60 + (s ?? 0);
};

function run(pings: { t: string; m: number; speed: number; trip: string }[]) {
  const runs = new Map<string, RunOut>();
  const events: StopEventOut[] = [];
  const closed: RunOut[] = [];
  const mt = new TripMatcher(() => [{ day, midnightUnix: midnight }], {
    runOpened: (r) => runs.set(r.runKey, r),
    runUpdated: (r) => runs.set(r.runKey, r),
    runClosed: (r) => closed.push({ ...r }),
    stopEvent: (e) => events.push(e),
  });
  for (const p of pings) mt.push({ vehicleId: "1641", ts: at(p.t), lat: LAT, lon: lonAt(p.m), speed: p.speed, bearing: 90, rtTripId: p.trip });
  return { mt, runs, events, closed };
}

const T1 = "S_1_080000_X";
const T2 = "S_2_081000_X";

describe("illesztő", () => {
  it("indulás a végállomásról, áthaladás, beérkezés — a menet azonnal lezárul", () => {
    const { events, closed } = run([
      { t: "07:56:00", m: 5, speed: 0, trip: T1 },
      { t: "07:59:30", m: 5, speed: 0, trip: T1 },
      { t: "08:00:45", m: 20, speed: 0, trip: T1 },
      { t: "08:01:00", m: 200, speed: 9, trip: T1 }, // elhagyta a végállomást
      { t: "08:02:30", m: 1100, speed: 9, trip: T1 },
      { t: "08:03:30", m: 1900, speed: 9, trip: T1 }, // B-n átsuhant
      { t: "08:05:50", m: 2960, speed: 3, trip: T1 }, // beért C-be
    ]);
    const byStop = Object.fromEntries(events.map((e) => [e.stopId, e]));
    expect(Object.keys(byStop).sort()).toEqual(["A", "B", "C"]);
    // Az első megállónál az INDULÁS számít (a zóna 40 m-es határán, interpolálva).
    expect(byStop.A.depTs).toBeGreaterThanOrEqual(at("08:00:45"));
    expect(byStop.A.delayS).toBeGreaterThan(40);
    expect(byStop.A.delayS).toBeLessThan(65);
    expect(byStop.B.src).toBe("pass");
    expect(Math.abs(byStop.B.delayS)).toBeLessThan(60);
    expect(closed).toHaveLength(1);
    expect(closed[0].status).toBe("complete");
    expect(closed[0].closeReason).toBe("final-stop");
    expect(closed[0].actualStart).toBe(byStop.A.depTs);
  });

  it("korai menetváltás: az új menet csak a kiinduló megállóban indul el", () => {
    const { events, runs } = run([
      { t: "08:00:30", m: 0, speed: 0, trip: T1 },
      { t: "08:01:00", m: 200, speed: 9, trip: T1 },
      { t: "08:03:00", m: 1500, speed: 9, trip: T1 },
      // Az MVK már a visszautat küldi, miközben a busz még C felé tart:
      { t: "08:04:00", m: 2100, speed: 9, trip: T2 },
      { t: "08:05:00", m: 2600, speed: 9, trip: T2 },
      { t: "08:06:10", m: 2975, speed: 0, trip: T2 },
      { t: "08:09:50", m: 2985, speed: 0, trip: T2 },
      { t: "08:10:30", m: 2800, speed: 8, trip: T2 },
      { t: "08:12:30", m: 1600, speed: 9, trip: T2 },
      { t: "08:13:30", m: 1100, speed: 9, trip: T2 },
    ]);
    const t1 = events.filter((e) => e.tripId === T1).map((e) => e.stopId);
    const t2 = events.filter((e) => e.tripId === T2).map((e) => e.stopId);
    // A régi menet a hátralévő megállóit és a beérkezést is megkapta.
    expect(t1).toEqual(["A", "B", "C"]);
    // Az új menet C-ből indult (nem esett a nyomvonal végére), és B-n áthaladt.
    expect(t2).toEqual(["C", "B"]);
    const back = [...runs.values()].find((r) => r.tripId === T2)!;
    // A pontok szerint 08:10:00 körül hagyta el C-t (a zóna határán interpolálva) → pontos.
    expect(Math.abs(back.startDelayS!)).toBeLessThan(30);
  });

  it("a végállomás előtt elnémuló busz beérkezése becsült, és a menet teljes", () => {
    const { mt, closed, events } = run([
      { t: "08:00:30", m: 0, speed: 0, trip: T1 },
      { t: "08:01:00", m: 200, speed: 9, trip: T1 },
      { t: "08:03:00", m: 1600, speed: 9, trip: T1 },
      { t: "08:05:20", m: 2700, speed: 9, trip: T1 }, // utána nincs több pont
    ]);
    mt.sweep(at("08:09:00"));
    expect(closed[0]?.status).toBe("complete");
    const c = events.find((e) => e.stopId === "C")!;
    expect(c.src).toBe("final");
    expect(c.arrTs).toBeGreaterThan(at("08:05:20"));
    expect(c.arrTs).toBeLessThan(at("08:06:30"));
  });

  it("menet közben megadja, hol tart a nyomvonalon és melyik a következő megálló", () => {
    const { mt } = run([
      { t: "08:00:30", m: 0, speed: 0, trip: T1 },
      { t: "08:01:00", m: 200, speed: 9, trip: T1 },
      { t: "08:02:00", m: 900, speed: 9, trip: T1 },
    ]);
    const m = mt.motion("1641")!;
    expect(m.tripId).toBe(T1);
    expect(m.shapeId).toBe("SH1");
    expect(Math.abs(m.alongM - 900)).toBeLessThan(30);
    expect(m.toStopId).toBe("B");
    expect(m.toAlongM).toBeGreaterThan(m.alongM);
    expect(m.schedSegS).toBe(180);
  });

  it("újraküldött / régi pont nem okoz semmit", () => {
    const { events } = run([
      { t: "08:00:30", m: 0, speed: 0, trip: T1 },
      { t: "08:01:00", m: 200, speed: 9, trip: T1 },
      { t: "08:01:00", m: 200, speed: 9, trip: T1 },
      { t: "08:00:50", m: 100, speed: 9, trip: T1 },
    ]);
    expect(events.filter((e) => e.stopId === "A")).toHaveLength(1);
  });
});
