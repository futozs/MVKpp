import { describe, expect, it } from "vitest";
import { bumpPlatform, feedFromFiles, LINE_PLATFORM, OWN_PLATFORM, pickPlatform, platformLineKey } from "../src/index.ts";

const counts = (o: Record<string, number>) => new Map(Object.entries(o));

describe("várható vágány", () => {
  it("a menet saját előzménye: legalább 2 nap és egyértelmű többség", () => {
    expect(pickPlatform(counts({ "6": 3 }), OWN_PLATFORM)).toBe("6");
    expect(pickPlatform(counts({ "6": 4, "7": 1 }), OWN_PLATFORM)).toBe("6");
    // egyetlen nap még nem elég
    expect(pickPlatform(counts({ "6": 1 }), OWN_PLATFORM)).toBeNull();
    // fele-fele: nem tippelünk
    expect(pickPlatform(counts({ "6": 2, "7": 2 }), OWN_PLATFORM)).toBeNull();
    expect(pickPlatform(undefined, OWN_PLATFORM)).toBeNull();
  });

  it("a vonal előzménye szigorúbb: legalább 3 menet, 70%-os többség", () => {
    expect(pickPlatform(counts({ "2": 3 }), LINE_PLATFORM)).toBe("2");
    expect(pickPlatform(counts({ "2": 2 }), LINE_PLATFORM)).toBeNull();
    expect(pickPlatform(counts({ "2": 3, "3": 2 }), LINE_PLATFORM)).toBeNull();
  });

  it("a vonal-kulcs: vonal, a végállomás (az irány) és az állomás", () => {
    const feed = feedFromFiles({
      "feed_info.txt": "feed_publisher_name,feed_version\nMÁV,R1\n",
      "stops.txt": "stop_id,stop_code,stop_name,stop_lat,stop_lon\n1:a_0,,Miskolc-Tiszai,48.09,20.81\n1:b_0,,Füzesabony,47.75,20.41\n",
      "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n1:E1,M,Sz,Miskolc – Füzesabony,2,00A0E3,FFFFFF\n",
      "trips.txt": "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n1:E1,S,1:5139,Füzesabony,5139 személyvonat,0,\n1:E1,S,1:5140,Miskolc-Tiszai,5140 személyvonat,1,\n",
      "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n1:5139,07:20:00,07:20:00,1:a_0,1\n1:5139,08:10:00,08:10:00,1:b_0,2\n1:5140,09:00:00,09:00:00,1:b_0,1\n1:5140,09:50:00,09:50:00,1:a_0,2\n",
      "calendar_dates.txt": "service_id,date,exception_type\nS,20261031,1\n",
    });
    // a két irány külön kulcs: a Füzesabony felé és a Tiszai felé induló vonat más vágányról mehet
    expect(platformLineKey(feed, "1:5139", "1:a")).toBe("1:E1|1:b|1:a");
    expect(platformLineKey(feed, "1:5140", "1:b")).toBe("1:E1|1:a|1:b");
    expect(platformLineKey(feed, "1:nincs", "1:a")).toBeNull();
  });

  it("a számláló összeadja a megfigyeléseket", () => {
    const m = new Map<string, Map<string, number>>();
    bumpPlatform(m, "k", "6");
    bumpPlatform(m, "k", "6", 2);
    bumpPlatform(m, "k", "7");
    expect([...m.get("k")!]).toEqual([
      ["6", 3],
      ["7", 1],
    ]);
  });
});
