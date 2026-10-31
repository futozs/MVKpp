import { describe, expect, it } from "vitest";
import {
  arrivalsForStop,
  feedFromFiles,
  findStopTwins,
  localMidnightUnix,
  mergedBoard,
  parseStopMerge,
  resolveServiceDay,
  sameStopName,
  type RealtimeSnapshot,
  type TransitMode,
} from "../src/index.ts";

const ISO = "2026-10-31";

/**
 * Hejőcsaba: két MVK-oszlop (Cementgyár, az út két oldalán), mellette a Volán „Miskolc
 * (Hejőcsaba), cementgyár” megállója; arrébb az Auchan (Volán) és a Keleti kapu (MVK)
 * ugyanott, de más névvel — az nem biztos pár.
 */
const feed = feedFromFiles({
  "feed_info.txt": "feed_publisher_name,feed_version\nMVK,20261031-1\n",
  "stops.txt": [
    "stop_id,stop_code,stop_name,stop_lat,stop_lon",
    "SP83,1,Cementgyár,48.07300,20.80000",
    "SP84,2,Cementgyár,48.07320,20.80060",
    'hkir:hkir_100_1,,"Miskolc (Hejőcsaba), cementgyár",48.07326,20.80068',
    "SP90,1,Keleti kapu,48.08000,20.81000",
    'hkir:hkir_200_1,,"Miskolc, Auchan Áruház",48.08010,20.81010',
    "SP99,1,Petőfi tér,48.09000,20.82000",
  ].join("\n"),
  "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n14,MVK,14,Hejőcsaba – Hősök tere,3,2F6DF6,FFFFFF\nhkir:R3743,V,3743,Miskolc – Mályi,3,F6AC00,152B32\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n14,S1,T14,Hősök tere,,0,\n14,S1,T14P,Hősök tere,,0,\nhkir:R3743,S1,hkir:T3743,Miskolc,,0,\n",
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    "T14,07:00:00,07:00:00,SP84,1",
    "T14,07:10:00,07:10:00,SP90,2",
    "T14P,07:05:00,07:05:00,SP99,1",
    "T14P,07:08:00,07:08:00,SP83,2",
    "hkir:T3743,07:02:00,07:02:00,hkir:hkir_100_1,1",
    "hkir:T3743,07:12:00,07:12:00,hkir:hkir_200_1,2",
  ].join("\n"),
  "calendar_dates.txt": "service_id,date,exception_type\nS1,20261031,1\n",
});

const ALL = new Set<TransitMode>(["tram", "bus", "coach", "rail"]);
const MVK = new Set<TransitMode>(["tram", "bus"]);

describe("ugyanaz a megálló-e a név szerint", () => {
  it("a valódi párok (a Volán-név előtaggal, városrésszel, zárójellel)", () => {
    const same: [string, string][] = [
      ["Miskolc (Hejőcsaba), cementgyár", "Cementgyár"],
      ["Miskolc, Tiszai pályaudvar", "Tiszai pályaudvar"],
      ["Miskolc, Baross Gábor utca", "Baross Gábor út"],
      ["Miskolc, Berzsenyi utca", "Berzsenyi Dániel utca"],
      ["Miskolc (Újmassa), Őskohó", "Újmassai őskohó"],
      ["Miskolc-Diósgyőr, Városközpont", "Diósgyőr városközpont"],
      ["Miskolc, Vasgyár (Gózon Lajos utca)", "Vasgyár"],
      ["Miskolc, Szondi György utca", "Szondi György utca (7)"],
      ["Miskolctapolcai elágazás [5]", "Tapolcai elágazás"],
      ["Miskolc (Lillafüred), Palotaszálló", "Palotaszálló (15)"],
      ["Miskolc, Szent Anna tér", "Szent Anna tér"],
    ];
    for (const [a, b] of same) expect(sameStopName(a, b), `${a} ↔ ${b}`).toBe(true);
  });

  it("más nevű, csak közeli megállók külön maradnak", () => {
    const apart: [string, string][] = [
      ["Miskolc, Auchan Áruház", "Keleti kapu"],
      ["Miskolc, Chinoin", "Kiss Ernő utca"],
      ["Miskolc, Corvin utca", "Vörösmarty Mihály utca"],
      ["Miskolc, autóbusz-állomás", "Búza tér"],
      ["Felsőzsolca, Szent István utca", "Hősök tere (7)"],
      ["Miskolc (Szirma), Erkel Ferenc utca", "Szirma Volán"],
    ];
    for (const [a, b] of apart) expect(sameStopName(a, b), `${a} ↔ ${b}`).toBe(false);
  });
});

describe("közös megállók a feedben", () => {
  const twins = findStopTwins(feed);

  it("a Volán-megálló a legközelebbi egyező nevű MVK-oszlophoz tartozik", () => {
    expect(twins.toMvk.get("hkir:hkir_100_1")).toBe("SP84");
    expect(twins.fromMvk.get("SP84")).toEqual(["hkir:hkir_100_1"]);
    // más név: nem pár, akármilyen közel van
    expect(twins.toMvk.has("hkir:hkir_200_1")).toBe(false);
  });

  it("közös hely csak ott, ahol MVK és Volán is megáll", () => {
    expect(twins.shared.has("SP84")).toBe(true);
    expect(twins.shared.has("SP83")).toBe(false);
    expect(twins.shared.has("SP99")).toBe(false);
  });

  it("a beállítás: összevonva, csak MVK, csak Volán, külön", () => {
    expect(mergedBoard(twins, "SP84", "all", ALL).stopIds).toEqual(["SP84", "hkir:hkir_100_1"]);
    // a Volán-pár azonosítójával kérve is az MVK-oszlop táblája
    expect(mergedBoard(twins, "hkir:hkir_100_1", "all", ALL).primary).toBe("SP84");

    const mvk = mergedBoard(twins, "SP84", "mvk", ALL);
    expect(mvk.stopIds).toEqual(["SP84"]);
    expect([...mvk.modes].sort()).toEqual(["bus", "tram"]);

    const coach = mergedBoard(twins, "SP84", "coach", ALL);
    expect(coach.stopIds).toEqual(["SP84", "hkir:hkir_100_1"]);
    expect([...coach.modes]).toEqual(["coach"]);

    expect(mergedBoard(twins, "hkir:hkir_100_1", "off", ALL).stopIds).toEqual(["hkir:hkir_100_1"]);
    // ahol csak az MVK áll meg, a „csak Volán” nem üríti ki a táblát
    expect([...mergedBoard(twins, "SP83", "coach", ALL).modes].sort()).toEqual(["bus", "coach", "rail", "tram"]);
    // kikapcsolt Volán mellett nincs mit összevonni
    expect(mergedBoard(twins, "SP84", "all", MVK).stopIds).toEqual(["SP84"]);
  });

  it("ismeretlen beállítás: nincs összevonás (a régi viselkedés)", () => {
    expect(parseStopMerge("all")).toBe("all");
    expect(parseStopMerge("xyz")).toBe("off");
    expect(parseStopMerge(null)).toBe("off");
  });
});

describe("összevont tábla", () => {
  const day = resolveServiceDay([feed], ISO)!;
  const days = [{ day, midnightUnix: localMidnightUnix(ISO) }];
  const at = localMidnightUnix(ISO) + 6.5 * 3600;
  const snap: RealtimeSnapshot = { fetchedAt: 0, header: { version: "", timestamp: 0 }, decoded: [], vehicles: [], predByStop: new Map(), updatesHeaderTs: 0, updatesCount: 0, rtError: null };

  it("az MVK-oszlop tábláján a Volán-pár indulásai is ott vannak", () => {
    const twins = findStopTwins(feed);
    const b = mergedBoard(twins, "SP84", "all", ALL);
    const board = arrivalsForStop("SP84", 10, snap, days, at, { modes: b.modes, rich: true, boardStops: b.stopIds });
    expect(board.arrivals.map((a) => a.tripId)).toEqual(["T14", "hkir:T3743"]);
    expect(board.merged).toEqual(["SP84", "hkir:hkir_100_1"]);
    expect(board.stop.name).toBe("Cementgyár");
  });

  it("összevonás nélkül a régi tábla (és nincs `merged` mező)", () => {
    const board = arrivalsForStop("SP84", 10, snap, days, at, { modes: ALL, rich: true });
    expect(board.arrivals.map((a) => a.tripId)).toEqual(["T14"]);
    expect(board.merged).toBeUndefined();
  });
});
