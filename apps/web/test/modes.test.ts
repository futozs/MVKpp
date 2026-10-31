import { describe, expect, it } from "vitest";
import { boardKey, boardQuery, displayVehicleId, vehicleIdTitle, feedOfId, isMergedTwin, modesParam, pickableStops, regionRank, rideModeOf, routeModeOf, vehicleModeOf } from "../src/lib/modes.ts";
import { travelEmptyHint, travelSentence } from "../src/components/routeplanner/TravelModes.tsx";
import { arrivalTileText, arrivalTitle, arrivalVehicleLabel, stopKindLabel } from "../src/components/transit/RegionalBits.tsx";
import { legTileText, vehiclePhrase } from "../src/components/routeplanner/format.ts";
import { tripRunLabel } from "../src/lib/tripStatus.ts";

describe("azonosítók és módok", () => {
  it("az azonosító előtagjából a forrás", () => {
    expect(feedOfId("SP388")).toBe("mvk");
    expect(feedOfId("hkir:hkir_LWA387")).toBe("coach");
    expect(feedOfId("1:005510009")).toBe("rail");
  });

  it("a `?modes=` mindig a rögzített sorrendben", () => {
    expect(modesParam(["rail", "tram"])).toBe("tram,rail");
    expect(modesParam(["tram", "bus", "coach", "rail"])).toBe("tram,bus,coach,rail");
  });

  it("jármű és vonal módja: a megadott, különben a típusból / azonosítóból", () => {
    expect(vehicleModeOf({ id: "1641", label: "BUS" })).toBe("bus");
    expect(vehicleModeOf({ id: "608", label: "TRAM" })).toBe("tram");
    expect(vehicleModeOf({ id: "hkir:hkir_TDE321" })).toBe("coach");
    expect(vehicleModeOf({ id: "1:925504183227" })).toBe("rail");
    expect(routeModeOf({ id: "1", type: "900" })).toBe("tram");
    expect(routeModeOf({ id: "1:E1", type: "102" })).toBe("rail");
    expect(rideModeOf("1653")).toBe("bus");
    expect(rideModeOf("1:925504183227", "1:35051212")).toBe("rail");
  });
});

describe("megjelenítés", () => {
  it("rendszám: az MVK-é változatlan, a Volán magyar rendszám-alakban, a vonat típussal és pályaszámmal", () => {
    expect(displayVehicleId("1641")).toBe("1641");
    expect(displayVehicleId("hkir:hkir_LWA387")).toBe("LWA-387");
    expect(displayVehicleId("hkir:hkir_LWA387", "LWA-387")).toBe("LWA-387");
    // az új, négybetűs rendszám
    expect(displayVehicleId("hkir:hkir_AAJB306")).toBe("AA JB-306");
    // vonat: típus, sorozat és pályaszám; a teljes UIC-szám a buborékba
    expect(displayVehicleId("1:925504183227")).toBe("M41 418 322");
    expect(displayVehicleId("1:945518150384")).toBe("KISS 815 038");
    expect(displayVehicleId("1:945504140134")).toBe("414 013");
    // német bejegyzésű Vectron (91 80 6193 / 7193)
    expect(displayVehicleId("1:918071930252")).toBe("Vectron 193 025");
    expect(vehicleIdTitle("1:925504183227")).toBe("M41 · 92 55 0418 322-7");
    // nem 12 jegyű vasúti azonosító: csak az előtag megy le
    expect(displayVehicleId("1:ABC")).toBe("ABC");
  });

  it("az állomás peronjai nem külön tételek", () => {
    const stops = [{ id: "1:005510009" }, { id: "1:005510009_0", parent: "1:005510009" }, { id: "1:005510009_3", parent: "1:005510009" }, { id: "SP388" }, { id: "1:999_1", parent: "1:999" }];
    // a szülő nélküli peron (nincs betöltve az állomása) választható marad
    expect(pickableStops(stops).map((s) => s.id)).toEqual(["1:005510009", "SP388", "1:999_1"]);
  });

  it("keresésben a megyén belüli megállók elöl", () => {
    expect(regionRank({ id: "SP388", lat: 48.1, lon: 20.79 })).toBe(0);
    expect(regionRank({ id: "hkir:hkir_213938", lat: 48.1058, lon: 20.7915 })).toBe(0); // Miskolc, autóbusz-állomás
    expect(regionRank({ id: "hkir:hkir_1", lat: 47.5316, lon: 21.6273 })).toBe(1); // Debrecen
  });

  it("indulás-sor: vonatnál kategória + vonatszám és a név, Volánnál rendszám", () => {
    const train = { route: "IC", mode: "rail" as const, trainNo: "582", trainName: "TOKAJ", headsign: "Budapest-Keleti", vehicle: { id: "1:925504183227" } };
    expect(arrivalTileText(train)).toBe("IC 582");
    expect(arrivalTitle(train)).toBe("TOKAJ → Budapest-Keleti");
    expect(arrivalVehicleLabel(train as never)).toBeNull();
    const coach = { route: "4001", mode: "coach" as const, headsign: "Kazincbarcika", vehicle: { id: "hkir:hkir_TDE321" } };
    expect(arrivalTileText(coach)).toBe("4001");
    expect(arrivalVehicleLabel(coach as never)).toBe("TDE-321");
    expect(arrivalTitle({ headsign: "Diósgyőr" })).toBe("Diósgyőr");
  });

  it("a megálló fajtája a fejlécben", () => {
    expect(stopKindLabel({ id: "1:005510009" })).toBe("Vasútállomás");
    expect(stopKindLabel({ id: "hkir:123", station: true })).toBe("Autóbusz-állomás");
    expect(stopKindLabel({ id: "hkir:456" })).toBe("Volán-megálló");
    expect(stopKindLabel({ id: "SP388" })).toBe("SP388");
  });

  it("tervező: a vonat-szakasz csempéje és a jármű a mondatban", () => {
    expect(legTileText({ mode: "RAIL", routeShortName: "Sz", trainNo: "5139" })).toBe("Sz 5139");
    expect(legTileText({ mode: "BUS", routeShortName: "21" })).toBe("21");
    expect(vehiclePhrase("1653", "BUS")).toBe("az 1653-as busszal");
    expect(vehiclePhrase("hkir:hkir_TDE321", "COACH")).toBe("a(z) TDE-321 jelű busszal");
    expect(vehiclePhrase("1:925504183227", "RAIL")).toBe("a(z) M41 418 322 járművel");
  });

  it("menetállapot: a regionális jármű olvashatóan", () => {
    expect(tripRunLabel("live", "1641")).toBe("Úton · 1641");
    expect(tripRunLabel("live", "hkir:hkir_TDE321")).toBe("Úton · TDE-321");
  });
});

describe("közös megállók és a tábla kulcsa", () => {
  it("a kulcs a módokból és az összevonásból; a régi (csak módos) kulcs is jó", () => {
    expect(boardKey(["rail", "tram", "bus", "coach"], "all")).toBe("tram,bus,coach,rail~all");
    expect(boardQuery("tram,bus,coach~mvk")).toBe("modes=tram,bus,coach&merge=mvk");
    expect(boardQuery("tram,bus")).toBe("modes=tram,bus");
  });

  it("összevont nézetben a Volán-iker nem külön tétel, „Külön” módban igen", () => {
    expect(isMergedTwin({ twinOf: "SP84" }, "all")).toBe(true);
    expect(isMergedTwin({ twinOf: "SP84" }, "coach")).toBe(true);
    expect(isMergedTwin({ twinOf: "SP84" }, "off")).toBe(false);
    expect(isMergedTwin({}, "all")).toBe(false);
  });
});

describe("a tervező pipái", () => {
  it("a mondat és az üres eredmény tanácsa a pipák szerint", () => {
    expect(travelSentence({ coach: false, rail: false })).toMatch(/Csak az MVK/);
    expect(travelSentence({ coach: true, rail: true })).toMatch(/Teljes hálózat/);
    expect(travelEmptyHint({ coach: true, rail: true })).toBeNull();
    expect(travelEmptyHint({ coach: true, rail: false })).toMatch(/pipáld be a vonatot/);
    expect(travelEmptyHint({ coach: false, rail: false })).toMatch(/a Volánt vagy a vonatot/);
  });
});
