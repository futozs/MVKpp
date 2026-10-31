import { describe, expect, it } from "vitest";
import { displayVehicleId, feedOfId, modesParam, pickableStops, regionRank, rideModeOf, routeModeOf, vehicleModeOf } from "../src/lib/modes.ts";
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
  it("rendszám: az MVK-é változatlan, a Volán előtag nélkül, a vasúti UIC tagolva", () => {
    expect(displayVehicleId("1641")).toBe("1641");
    expect(displayVehicleId("hkir:hkir_LWA387")).toBe("LWA387");
    expect(displayVehicleId("hkir:hkir_LWA387", "LWA-387")).toBe("LWA-387");
    expect(displayVehicleId("1:925504183227")).toBe("92 55 0418 322-7");
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
    expect(arrivalVehicleLabel(coach as never)).toBe("TDE321");
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
    expect(vehiclePhrase("hkir:hkir_TDE321", "COACH")).toBe("a(z) TDE321 jelű busszal");
    expect(vehiclePhrase("1:925504183227", "RAIL")).toBe("a 92 55 0418 322-7 pályaszámú járművel");
  });

  it("menetállapot: a regionális jármű olvashatóan", () => {
    expect(tripRunLabel("live", "1641")).toBe("Úton · 1641");
    expect(tripRunLabel("live", "hkir:hkir_TDE321")).toBe("Úton · TDE321");
  });
});
