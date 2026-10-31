import { describe, expect, it } from "vitest";
import { feedFromFiles } from "@mvk/core";
import { runLabel, tripLabel } from "../src/parking.ts";

/** Egy vonat (IC) és egy Volán-vonal: a menet `routeShort`-ja a vonal kulcsa, a felület a címkét kapja. */
const feed = feedFromFiles({
  "feed_info.txt": "feed_publisher_name,feed_version\nMÁV,R20261031-1\n",
  "stops.txt": "stop_id,stop_code,stop_name,stop_lat,stop_lon\n1:a,,Miskolc-Tiszai,48.09,20.81\n1:b,,Hidasnémeti,48.50,21.23\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n1:E1,M,IC,Budapest – Kassa,2,274F96,FFFFFF\nhkir:hkir_V-R-200-3765,V,3765,Miskolc – Kazincbarcika,3,F6AC00,152B32\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n1:E1,S,1:191,Kosice,191 HERNÁD InterCity,0,\nhkir:hkir_V-R-200-3765,S,hkir:t1,Kazincbarcika,3765/12,0,\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n1:191,10:00:00,10:00:00,1:a,1\n1:191,11:00:00,11:00:00,1:b,2\nhkir:t1,10:00:00,10:00:00,1:a,1\nhkir:t1,10:40:00,10:40:00,1:b,2\n",
  "calendar_dates.txt": "service_id,date,exception_type\nS,20261031,1\n",
});

describe("a regionális parkoló vonal-címkéje", () => {
  it("vonatnál kategória és vonatszám, Volánnál a vonalszám — nem a vonal kulcsa", () => {
    expect(runLabel(feed, { tripId: "1:191", routeId: "1:E1", routeShort: "1:E1" })).toBe("IC 191");
    expect(runLabel(feed, { tripId: "hkir:t1", routeId: "hkir:hkir_V-R-200-3765", routeShort: "hkir:hkir_V-R-200-3765" })).toBe("3765");
  });

  it("a tipp címkéje a menetrendből (még el nem indult menet)", () => {
    expect(tripLabel(feed, "1:191", "1:E1")).toBe("IC 191");
    expect(tripLabel(feed, "hkir:t1", "hkir:hkir_V-R-200-3765")).toBe("3765");
  });

  it("ismeretlen menetnél a meglévő érték marad", () => {
    expect(runLabel(feed, { tripId: "hkir:x", routeId: "hkir:y", routeShort: "hkir:y" })).toBe("hkir:y");
  });
});
