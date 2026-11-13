import { describe, expect, it } from "vitest";
import { calendarRoutes, calendarTrips, feedFromFiles, localMidnightUnix, nextLegChoices, resolveServiceDay } from "../src/index.ts";

const LAT = 48.1;
const lonAt = (m: number) => 20.7 + m / (111_320 * Math.cos((LAT * Math.PI) / 180));
const trips = [
  // 36: késő esti, éjfél utáni (a GTFS 00:xx-szel írja, a nap végén fut) és reggeli menet
  { id: "S_SH1_235500_X", route: "36", stops: [["A", "23:55"], ["C", "00:05"]] },
  { id: "S_SH1_004200_X", route: "36", stops: [["A", "00:42"], ["C", "00:52"]] },
  { id: "S_SH1_060000_X", route: "36", stops: [["A", "06:00"], ["C", "06:10"]] },
  // 14: a C fordulóhurok  ugyanonnan indul tovább; a D a C szomszédos kocsiállása
  { id: "S_SH2_070000_X", route: "14", stops: [["A", "07:00"], ["C", "07:20"]] },
  { id: "S_SH3_072500_X", route: "14", stops: [["C", "07:25"], ["A", "07:45"]] },
  { id: "S_SH3_073000_X", route: "14", stops: [["D", "07:30"], ["A", "07:50"]] },
  { id: "S_SH3_093000_X", route: "14", stops: [["C", "09:30"], ["A", "09:50"]] },
  { id: "S_SH4_072600_X", route: "14", stops: [["A", "07:26"], ["C", "07:46"]] },
];
const files = {
  "feed_info.txt": "feed_version\n20261028-1\n",
  "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,${LAT},${lonAt(0)}\nC,Céta,${LAT},${lonAt(3000)}\nD,Céta,${LAT},${lonAt(3030)}\n`,
  "routes.txt": "route_id,route_short_name,route_type,route_color,route_text_color\n36,36,3,FF0000,FFFFFF\n14,14,3,00AA00,FFFFFF\n",
  "trips.txt": ["route_id,service_id,trip_id,trip_headsign,direction_id,shape_id", ...trips.map((t) => `${t.route},S,${t.id},${t.stops[t.stops.length - 1][0] === "A" ? "Alfa" : "Céta"},0,SH1`)].join("\n"),
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    ...trips.flatMap((t) => t.stops.map(([stop, hm], i) => `${t.id},${hm}:00,${hm}:00,${stop},${i + 1}`)),
  ].join("\n"),
  "calendar_dates.txt": "service_id,date,exception_type\nS,20261028,1\nS,20261029,1\n",
  "shapes.txt": ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", ...[0, 1, 2, 3, 4, 5, 6].map((i) => `SH1,${LAT},${lonAt(i * 500)},${i}`)].join("\n"),
};

const feed = feedFromFiles(files);
const tue = resolveServiceDay([feed], "2026-10-28")!;
const wed = resolveServiceDay([feed], "2026-10-29")!;

describe("utólagos utazás: a naptári nap menetei", () => {
  it("a szerdai naptári napon a keddi éjfél utáni menet is ott van, a szerdai éjfél utáni nincs", () => {
    const list = calendarTrips(wed, tue, "36");
    expect(list.map((t) => [t.tripId, t.serviceDate])).toEqual([
      ["S_SH1_004200_X", "2026-10-28"],
      ["S_SH1_060000_X", "2026-10-29"],
      ["S_SH1_235500_X", "2026-10-29"],
    ]);
    // a 00:42-es a keddi szolgáltatási nap végén, szerda hajnalban fut
    expect(list[0].depTs).toBe(localMidnightUnix("2026-10-28") + 24 * 3600 + 42 * 60);
  });

  it("a menet adatai: honnan hová, mikor, és ér-e véget fordulóhurkon", () => {
    const [first] = calendarTrips(wed, tue, "14");
    expect(first).toMatchObject({ route: "14", originName: "Alfa", destinationName: "Céta", loopEnd: true, color: "00AA00" });
    expect(first.endTs - first.depTs).toBe(20 * 60);
  });

  it("csak a naptári napon közlekedő vonalak, vonalszám szerint", () => {
    expect(calendarRoutes(wed, tue).map((r) => r.short)).toEqual(["14", "36"]);
    expect(calendarTrips(wed, null, "99")).toEqual([]);
  });
});

describe("utólagos körbeutazás: hogyan folytatta a busz", () => {
  it("a végállomásról (és a szomszédos kocsiállásról) a beérkezés után induló menetek, sorrendben", () => {
    const next = nextLegChoices(wed, "S_SH2_070000_X");
    expect(next.map((t) => [t.tripId, t.kind])).toEqual([
      ["S_SH3_072500_X", "loop"],
      ["S_SH3_073000_X", "nearby"],
    ]);
  });

  it("a túl későn induló és a máshonnan induló menet nem folytatás", () => {
    const ids = nextLegChoices(wed, "S_SH2_070000_X").map((t) => t.tripId);
    expect(ids).not.toContain("S_SH3_093000_X");
    expect(ids).not.toContain("S_SH4_072600_X");
    expect(nextLegChoices(wed, "ismeretlen")).toEqual([]);
  });
});
