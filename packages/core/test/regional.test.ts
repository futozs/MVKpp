import { describe, expect, it } from "vitest";
import {
  arrivalsForStop,
  buildSnapshot,
  decodePolyline,
  Feed,
  feedFromFiles,
  feedOfId,
  findTrains,
  findTrip,
  inRegion,
  isMvkId,
  localMidnightUnix,
  matchProfileFor,
  MATCH,
  MATCH_RAIL,
  modeOfRoute,
  operatorLabel,
  parseModes,
  railCategory,
  regionalGtfsForDay,
  resolveServiceDay,
  rtFromOtp,
  stationKeyOf,
  trainParts,
  TripMatcher,
  type OtpPattern,
  type RealtimeSnapshot,
  type RunOut,
} from "../src/index.ts";

const ISO = "2026-10-31";
const YMD = "20261031";

/** Egy kis MVK-feed: egy busz a Tiszai pu. (SP388) és a Búza tér (SP66) között. */
const mvkFeed = feedFromFiles({
  "feed_info.txt": "feed_publisher_name,feed_version\nMVK,20261031-1\n",
  "stops.txt": "stop_id,stop_code,stop_name,stop_lat,stop_lon\nSP388,1,Tiszai pályaudvar,48.0997,20.8155\nSP66,1,Búza tér,48.1040,20.7920\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n21,MVK,21,Tiszai – Búza,704,EAABC1,FFFFFF\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n21,S1,10836_2022_052000_AZE,Búza tér,21        ,0,2022\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n10836_2022_052000_AZE,07:00:00,07:00:00,SP388,1\n10836_2022_052000_AZE,07:08:00,07:08:00,SP66,2\n",
  "calendar_dates.txt": "service_id,date,exception_type\nS1,20261031,1\n",
  "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n2022,48.0997,20.8155,1\n2022,48.1040,20.7920,2\n",
});

const tiszai = { gtfsId: "1:005511387_0", name: "Miskolc-Tiszai", lat: 48.0997, lon: 20.8165, platformCode: null, parentStation: { gtfsId: "1:005511387", name: "Miskolc-Tiszai", lat: 48.0997, lon: 20.8165 } };
const fuzes = { gtfsId: "1:005511296_0", name: "Füzesabony", lat: 47.7491, lon: 20.4107, platformCode: null, parentStation: { gtfsId: "1:005511296", name: "Füzesabony", lat: 47.7491, lon: 20.4107 } };

const patterns = new Map<string, OtpPattern>([
  [
    "1:E1::01",
    {
      code: "1:E1::01",
      headsign: "Füzesabony",
      route: { gtfsId: "1:E1", shortName: '<span class="MNR2007">&#484;</span>', longName: "Sz 5139/5140", mode: "RAIL", type: 106, color: "FEFEFE", textColor: "00A0E3", agency: { gtfsId: "1:198", name: "MÁV Személyszállítási Zrt." } },
      stops: [tiszai, fuzes],
      points: null,
    },
  ],
  [
    "hkir:V-3738:0:01",
    {
      code: "hkir:V-3738:0:01",
      headsign: "Miskolc",
      route: { gtfsId: "hkir:hkir_V-R-200-3738", shortName: "3738", longName: "Miskolc – Sajószentpéter", mode: "COACH", type: 200, color: "0072BC", textColor: "FFFFFF", agency: { gtfsId: "hkir:hkir_V", name: "MÁV Személyszállítási Zrt. - Helyközi busz" } },
      // a Volán a Tiszai pu. MVK-megállóján is megáll
      stops: [{ gtfsId: "hkir:hkir_213938_11", name: "Miskolc, autóbusz-állomás", lat: 48.104, lon: 20.79, platformCode: "11", parentStation: { gtfsId: "hkir:hkir_213938", name: "Miskolc, autóbusz-állomás", lat: 48.104, lon: 20.79 } }, { gtfsId: "mvkzrt:SP388", name: "Miskolc, Tiszai pályaudvar", lat: 48.0997, lon: 20.8155 }],
      points: null,
    },
  ],
]);

const regionalFiles = regionalGtfsForDay(
  ISO,
  patterns,
  {
    ymd: YMD,
    byPattern: {
      "1:E1::01": [
        { gtfsId: "1:35051212", tripShortName: "5139 személyvonat", tripHeadsign: "Füzesabony", stoptimes: [{ scheduledArrival: 26400, scheduledDeparture: 26400 }, { scheduledArrival: 29280, scheduledDeparture: 29280 }] },
        // 02:10-es OTP-menet: a TEGNAPI szolgáltatási naphoz tartozik, ide nem kerül
        { gtfsId: "1:night-old", tripShortName: "5009 sebesvonat", stoptimes: [{ scheduledArrival: 7800, scheduledDeparture: 7800 }, { scheduledArrival: 9000, scheduledDeparture: 9000 }] },
      ],
      "hkir:V-3738:0:01": [{ gtfsId: "hkir:hkir_3738_366-5", tripShortName: "3738/366", stoptimes: [{ scheduledArrival: 25200, scheduledDeparture: 25200 }, { scheduledArrival: 25800, scheduledDeparture: 25800 }] }],
    },
  },
  {
    ymd: "20261101",
    byPattern: {
      // holnapi OTP-dátum 01:30-as menete: a MAI szolgáltatási nap végére (25:30)
      "1:E1::01": [{ gtfsId: "1:night-new", tripShortName: "5021 személyvonat", stoptimes: [{ scheduledArrival: 5400, scheduledDeparture: 5400 }, { scheduledArrival: 7200, scheduledDeparture: 7200 }] }],
    },
  },
);
const regional = feedFromFiles(regionalFiles.files);
const composite = Feed.compose([mvkFeed, regional]);

describe("azonosítók és módok", () => {
  it("az MVK-azonosító előtag nélküli, a többi feed szerint", () => {
    expect(isMvkId("SP388")).toBe(true);
    expect(feedOfId("hkir:hkir_213938")).toBe("hkir");
    expect(feedOfId("1:005511387")).toBe("rail");
    expect(modeOfRoute("1V", "900")).toBe("tram");
    expect(modeOfRoute("21", "704")).toBe("bus");
    expect(modeOfRoute("hkir:x", "3")).toBe("coach");
    expect(modeOfRoute("1:E1", "106")).toBe("rail");
  });

  it("a ?modes= paraméter: hiányzik → csak MVK, all → minden, szemét → alapérték", () => {
    expect([...parseModes(null)]).toEqual(["tram", "bus"]);
    expect([...parseModes("all")].sort()).toEqual(["bus", "coach", "rail", "tram"]);
    expect([...parseModes("rail,xyz")]).toEqual(["rail"]);
    expect([...parseModes("xyz")]).toEqual(["tram", "bus"]);
  });

  it("üzemeltető, vasúti kategória, vonatszám", () => {
    expect(operatorLabel("MÁV Személyszállítási Zrt. - Tiszaújváros")).toBe("Tiszaújváros");
    expect(operatorLabel("MÁV Személyszállítási Zrt.")).toBe("MÁV");
    expect(railCategory("IC TOKAJ")).toBe("IC");
    expect(railCategory("Sz 5112/5113")).toBe("Sz");
    expect(railCategory("", "5019 InterRégió")).toBe("IR");
    expect(trainParts("582 TOKAJ InterCity")).toEqual({ no: "582", name: "TOKAJ" });
    expect(trainParts("5139 személyvonat")).toEqual({ no: "5139", name: null });
  });

  it("a megyei sokszög: Ózd, Sátoraljaújhely, Füzesabony bent; Eger, Nyíregyháza kint", () => {
    expect(inRegion(48.218, 20.29)).toBe(true);
    expect(inRegion(48.395, 21.656)).toBe(true);
    expect(inRegion(47.749, 20.41)).toBe(true);
    expect(inRegion(47.902, 20.377)).toBe(false);
    expect(inRegion(47.955, 21.717)).toBe(false);
  });

  it("a polyline-dekódolás a Google-példára", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });
});

describe("regionális GTFS", () => {
  it("az OTP-menetekből GTFS lesz, az éjszakaiak a mi 03:00-s napunk szerint", () => {
    expect(regionalFiles.counts.trips).toBe(3);
    expect(regional.trips.has("1:35051212")).toBe(true);
    expect(regional.trips.has("1:night-old")).toBe(false);
    const night = regional.tripStops.get("1:night-new")!;
    expect(night[0].dep).toBe(86_400 + 5400);
    expect(regional.activeServices(YMD).size).toBe(1);
  });

  it("vasút: a vonal neve a kategória (HTML nélkül), a menet neve a vonatszám, a szín a MÁV-szín", () => {
    const r = regional.routes.get("1:E1")!;
    expect(r.short).toBe("Sz");
    expect(r.long).toBe("Miskolc-Tiszai – Füzesabony");
    expect(r.color).toBe("00A0E3");
    expect(r.key).toBe("1:E1");
    expect(regional.trips.get("1:35051212")!.shortName).toBe("5139 személyvonat");
  });

  it("a közös MVK-megálló az MVK azonosítóján, az állomás a vágányaival", () => {
    expect(regional.stops.has("SP388")).toBe(true);
    expect(regional.stops.has("mvkzrt:SP388")).toBe(false);
    expect(regional.stops.get("1:005511387")!.station).toBe(true);
    expect(regional.stationChildren.get("1:005511387")).toEqual(["1:005511387_0"]);
    expect(regional.stops.get("hkir:hkir_213938_11")!.platform).toBe("11");
  });

  it("a kompozit feed: az MVK megállója marad, a menetrend összefésülődik", () => {
    expect(composite.stops.get("SP388")!.name).toBe("Tiszai pályaudvar");
    const sched = composite.stopSched.get("SP388")!.map((x) => x.trip);
    expect(sched).toContain("10836_2022_052000_AZE");
    expect(sched).toContain("hkir:hkir_3738_366-5");
    expect(composite.activeServices(YMD)).toEqual(new Set(["S1", "R20261031"]));
    // a részek érintetlenek
    expect(mvkFeed.stopSched.get("SP388")!.length).toBe(1);
  });
});

const EMPTY: RealtimeSnapshot = { fetchedAt: 0, header: { version: "", timestamp: 0 }, decoded: [], vehicles: [], predByStop: new Map(), updatesHeaderTs: 0, updatesCount: 0, rtError: null };

describe("megállótábla több forrásból", () => {
  const day = resolveServiceDay([composite], ISO)!;
  const days = [{ day, midnightUnix: localMidnightUnix(ISO) }];
  const at = localMidnightUnix(ISO) + 6 * 3600;

  it("v2 (csak MVK): a közös megállón a Volán nem látszik", () => {
    const b = arrivalsForStop("SP388", 10, EMPTY, days, at, { modes: new Set(["tram", "bus"]) });
    expect(b.arrivals.map((a) => a.tripId)).toEqual(["10836_2022_052000_AZE"]);
    expect(b.arrivals[0].mode).toBeUndefined();
  });

  it("minden móddal a Volán is ott van, üzemeltetővel és kulccsal", () => {
    const b = arrivalsForStop("SP388", 10, EMPTY, days, at, { modes: new Set(["tram", "bus", "coach"]), rich: true });
    const volan = b.arrivals.find((a) => a.tripId === "hkir:hkir_3738_366-5")!;
    expect(volan.route).toBe("3738");
    expect(volan.mode).toBe("coach");
    expect(volan.operator).toBe("Helyközi busz");
    expect(b.arrivals.find((a) => a.tripId === "10836_2022_052000_AZE")!.mode).toBe("bus");
  });

  it("az állomás táblája a vágányaiból gyűl, élő vágánnyal és megjegyzéssel", () => {
    const b = arrivalsForStop("1:005511387", 10, EMPTY, days, at, {
      platform: (t) => (t === "1:35051212" ? "6" : null),
      notices: (t) => (t === "1:35051212" ? ["Pálya állapota miatti késés"] : null),
    });
    const train = b.arrivals.find((a) => a.tripId === "1:35051212")!;
    expect(train.trainNo).toBe("5139");
    expect(train.route).toBe("Sz");
    expect(train.platform).toBe("6");
    expect(train.notices).toEqual(["Pálya állapota miatti késés"]);
    expect(train.platformPredicted).toBeUndefined();
  });

  it("kiadott vágány nélkül a korábbi napok szerinti várható, megjelölve; a kiadott mindig felülírja", () => {
    const guess = { predictedPlatform: (t: string) => (t === "1:35051212" ? "5" : null) };
    const b = arrivalsForStop("1:005511387", 10, EMPTY, days, at, guess);
    const train = b.arrivals.find((a) => a.tripId === "1:35051212")!;
    expect(train.platform).toBe("5");
    expect(train.platformPredicted).toBe(true);
    const live = arrivalsForStop("1:005511387", 10, EMPTY, days, at, { ...guess, platform: () => "6" }).arrivals.find((a) => a.tripId === "1:35051212")!;
    expect(live.platform).toBe("6");
    expect(live.platformPredicted).toBeUndefined();
  });
});

describe("vonat vonatszám és menetazonosító szerint", () => {
  const day = resolveServiceDay([composite], ISO)!;
  const midnight = localMidnightUnix(ISO);
  const days = [{ day, midnightUnix: midnight }];

  it("a követett vonat menete azonosító szerint: a napja, az indulása és az érkezése", () => {
    const want = [{ tripId: "1:35051212", dayIndex: 0, firstDepUnix: midnight + 26400, lastArrUnix: midnight + 29280 }];
    expect(findTrip(days, "1:35051212")).toEqual(want);
    // ugyanaz, mint a vonatszám szerinti keresés
    expect(findTrains(days, "5139")).toEqual(want);
  });

  it("Volán-menet és ismeretlen azonosító: nincs találat", () => {
    expect(findTrip(days, "hkir:hkir_3738_366-5")).toEqual([]);
    expect(findTrip(days, "1:nincs-ilyen")).toEqual([]);
  });
});

describe("OTP2 járművek a snapshotban", () => {
  const day = resolveServiceDay([composite], ISO)!;
  const midnight = localMidnightUnix(ISO);
  const now = midnight + 7 * 3600 + 30 * 60;
  const train = rtFromOtp({
    vehicleId: "1:945514150834",
    label: "",
    lat: 47.9,
    lon: 20.6,
    heading: 210,
    speed: 27,
    lastUpdated: now - 20,
    nextStop: { arrivalDelay: 180, stop: { gtfsId: "1:005511296_0" } },
    trip: { gtfsId: "1:35051212", route: { gtfsId: "1:E1" } },
  })!;
  const mvkFromOtp = rtFromOtp({ vehicleId: "mvkzrt:1644", label: "NID044 (1644)", lat: 48.1, lon: 20.8, lastUpdated: now - 10, trip: { gtfsId: "mvkzrt:10836_2022_052000_AZE", route: { gtfsId: "mvkzrt:21" } } })!;
  const snap = buildSnapshot({ positions: null, updates: null, offset: 3600, days: [day], midnightUnix: midnight, now, extra: [train, mvkFromOtp] });

  it("a Volán járatszáma (3969/553) nem vonatszám", () => {
    const coach = rtFromOtp({ vehicleId: "hkir:hkir_RWZ502", label: "RWZ502", lat: 48.1, lon: 20.8, lastUpdated: now - 5, trip: { gtfsId: "hkir:hkir_3738_366-5", route: { gtfsId: "hkir:hkir_V-R-200-3738" } } })!;
    const s2 = buildSnapshot({ positions: null, updates: null, offset: 3600, days: [day], midnightUnix: midnight, now, extra: [coach] });
    const v = s2.decoded.find((x) => x.id === "hkir:hkir_RWZ502")!;
    expect(v.mode).toBe("coach");
    expect(v.trainNo).toBeUndefined();
    expect(v.plate).toBe("RWZ502");
  });

  it("az MVK-s jármű előtag nélkül, a régi label-lel, a rendszám külön", () => {
    const v = snap.decoded.find((x) => x.id === "1644")!;
    expect(v.tripId).toBe("10836_2022_052000_AZE");
    expect(v.label).toBe("BUS");
    expect(v.plate).toBe("NID044 (1644)");
    expect(v.timestamp).toBe(now - 10 + 3600);
  });

  it("az állomás kulcsa: a vágány-megálló és az állomásszintű ugyanaz az állomás", () => {
    expect(stationKeyOf("1:005511387_3")).toBe("1:005511387");
    expect(stationKeyOf("1:005511387_1Kih")).toBe("1:005511387");
    expect(stationKeyOf("hkir:hkir_213938_11")).toBe("hkir:hkir_213938");
    expect(stationKeyOf("SP388")).toBe("SP388");
  });

  it("a vágány-megállóra (…_3) jött késés az állomásszintű (…_0) menetrendi megállóra vetül", () => {
    const onPlatform = { ...train, id: "1:1111", nextStopId: "1:005511296_3", delayS: 240 };
    const s2 = buildSnapshot({ positions: null, updates: null, offset: 3600, days: [day], midnightUnix: midnight, now, extra: [onPlatform] });
    expect(s2.predByStop.get("1:005511296_0")!.get("1:35051212")!.delay).toBe(240);
    const s3 = buildSnapshot({ positions: null, updates: null, offset: 3600, days: [day], midnightUnix: midnight, now, extraPreds: [{ tripId: "1:35051212", stopId: "1:005511387_6", delay: 120, exact: true }] });
    expect(s3.predByStop.get("1:005511387_0")!.get("1:35051212")!.delay).toBe(120);
  });

  it("a vonat vonatszámmal, a késése a hátralévő megállókra vetítve", () => {
    const v = snap.decoded.find((x) => x.id === "1:945514150834")!;
    expect(v.trainNo).toBe("5139");
    expect(v.mode).toBe("rail");
    expect(v.delaySec).toBe(180);
    expect(snap.predByStop.get("1:005511296_0")!.get("1:35051212")!.unix).toBe(midnight + 29280 + 180);
  });
});

describe("illesztési profilok", () => {
  it("az MVK változatlan, a vasút tágabb", () => {
    expect(matchProfileFor("21")).toBe(MATCH);
    expect(matchProfileFor("1:E1")).toBe(MATCH_RAIL);
    expect(MATCH_RAIL.MAX_SPEED_MPS).toBeGreaterThan(MATCH.MAX_SPEED_MPS);
  });

  it("egy 100 km/h-s vonat menete végigillesztődik, a statisztika kulcsa a vonal-azonosító", () => {
    const day = resolveServiceDay([composite], ISO)!;
    const midnight = localMidnightUnix(ISO);
    const runs: RunOut[] = [];
    const m = new TripMatcher(() => [{ day, midnightUnix: midnight }], { runClosed: (r) => runs.push({ ...r }) });
    // Tiszai 07:20 → Füzesabony 08:08, ~45 km — 30 mp-enként egy pont a két állomás közti egyenesen.
    const t0 = midnight + 26400;
    const steps = 96;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      m.push({ vehicleId: "1:945514150834", ts: t0 + i * 30, lat: 48.0997 + (47.7491 - 48.0997) * f, lon: 20.8165 + (20.4107 - 20.8165) * f, speed: i === 0 || i === steps ? 0 : 28, bearing: 220, rtTripId: "1:35051212" });
    }
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("complete");
    expect(runs[0].routeShort).toBe("1:E1");
    expect(runs[0].stopsSeen).toBe(2);
  });
});
