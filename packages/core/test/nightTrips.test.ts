import { describe, expect, it } from "vitest";
import {
  feedFromFiles,
  localMidnightUnix,
  parseMvkTripId,
  resolveServiceDay,
  resolveTrip,
  resolveTripNear,
  TripMatcher,
  type RunOut,
  type StopEventOut,
} from "../src/index.ts";

// Az MVK GTFS az éjfél utáni menetet 00:xx időkkel írja az előző esti menetek közé.
const LAT = 48.1;
const lonAt = (m: number) => 20.7 + m / (111_320 * Math.cos((LAT * Math.PI) / 180));
const NIGHT = "S_SH1_004200_X";
const LATE = "S_SH1_235500_X";
const files = {
  "feed_info.txt": "feed_version\n20261028-1\n",
  "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,${LAT},${lonAt(0)}\nB,Béta,${LAT},${lonAt(1490)}\nC,Céta,${LAT},${lonAt(2980)}\n`,
  "routes.txt": "route_id,route_short_name,route_type,route_color,route_text_color\n9,9,3,FF0000,FFFFFF\n",
  "trips.txt": `route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n9,S,${NIGHT},Céta,0,SH1\n9,S,${LATE},Céta,0,SH1\n`,
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    `${NIGHT},00:42:00,00:42:00,A,1`,
    `${NIGHT},00:45:00,00:45:00,B,2`,
    `${NIGHT},00:48:00,00:48:00,C,3`,
    `${LATE},23:55:00,23:55:00,A,1`,
    `${LATE},23:58:00,23:58:00,B,2`,
    `${LATE},00:01:00,00:01:00,C,3`,
  ].join("\n"),
  "calendar_dates.txt": "service_id,date,exception_type\nS,20261028,1\nS,20261029,1\n",
  "shapes.txt": ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", ...[0, 1, 2, 3, 4, 5, 6].map((i) => `SH1,${LAT},${lonAt(i * 500)},${i}`)].join("\n"),
};

const feed = feedFromFiles(files);
const tue = resolveServiceDay([feed], "2026-10-28")!;
const wed = resolveServiceDay([feed], "2026-10-29")!;
const midTue = localMidnightUnix("2026-10-28");
const midWed = localMidnightUnix("2026-10-29");
const H = 3600;

describe("éjfél utáni menetek", () => {
  it("a 03:00 előtt induló menet a szolgáltatási nap végére kerül (+24 óra)", () => {
    const st = feed.tripStops.get(NIGHT)!;
    expect(st.map((s) => s.dep)).toEqual([24 * H + 42 * 60, 24 * H + 45 * 60, 24 * H + 48 * 60]);
  });

  it("a menet közbeni éjféli átfordulás is kisimul", () => {
    const st = feed.tripStops.get(LATE)!;
    expect(st.map((s) => s.dep)).toEqual([23 * H + 55 * 60, 23 * H + 58 * 60, 24 * H + 60]);
  });

  it("a menetazonosító indulási ideje ugyanígy értendő (a nyomvonal+idő szerinti keresés megtalálja)", () => {
    expect(parseMvkTripId(NIGHT)?.startSec).toBe(24 * H + 42 * 60);
    expect(resolveTrip(tue, "S_SH1_004200_OTHER")?.id).toBe(NIGHT);
  });

  it("a pinghez időben közelebbi napot választja, ha a menet mindkét napon él", () => {
    const days = [
      { day: wed, midnightUnix: midWed },
      { day: tue, midnightUnix: midTue },
    ];
    // szerda 00:45 (naptár) = a keddi szolgáltatási nap éjszakája — a sorrendben a szerda az első
    expect(resolveTripNear(days, NIGHT, midWed + 45 * 60)?.dc.day.iso).toBe("2026-10-28");
    // szerda 03:00 után még futó késő menet is a keddi napé
    expect(resolveTripNear(days, NIGHT, midWed + 3 * H + 30)?.dc.day.iso).toBe("2026-10-28");
    // idő nélkül marad a régi sorrend
    expect(resolveTripNear(days, NIGHT, null)?.dc.day.iso).toBe("2026-10-29");
  });

  it("az illesztő az éjszakai menet megállóit valódi késéssel rögzíti", () => {
    const events: StopEventOut[] = [];
    const runs: RunOut[] = [];
    const mt = new TripMatcher(
      () => [
        { day: wed, midnightUnix: midWed },
        { day: tue, midnightUnix: midTue },
      ],
      { runOpened: (r) => runs.push(r), stopEvent: (e) => events.push(e) },
    );
    const at = (min: number, sec = 0) => midWed + min * 60 + sec;
    const pings = [
      { ts: at(38), m: 5, speed: 0 },
      { ts: at(41, 30), m: 5, speed: 0 },
      { ts: at(42, 45), m: 20, speed: 0 },
      { ts: at(43), m: 200, speed: 9 },
      { ts: at(44, 30), m: 1100, speed: 9 },
      { ts: at(45, 30), m: 1900, speed: 9 },
      { ts: at(47, 50), m: 2960, speed: 3 },
    ];
    for (const p of pings) mt.push({ vehicleId: "1641", ts: p.ts, lat: LAT, lon: lonAt(p.m), speed: p.speed, bearing: 90, rtTripId: NIGHT });
    expect(runs[0]?.serviceDate).toBe("2026-10-28");
    expect(events.map((e) => e.stopId).sort()).toEqual(["A", "B", "C"]);
    for (const e of events) expect(Math.abs(e.delayS)).toBeLessThan(120);
  });
});
