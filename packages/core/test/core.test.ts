import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  serviceClock,
  localMidnightUnix,
  hmOfUnix,
  secToHm,
  parseCsv,
  feedFromZip,
  feedFromFiles,
  resolveServiceDay,
  resolveTrip,
  parseMvkTripId,
  dayType,
  withHungarianSuffix,
  ProjectedShape,
} from "../src/index.ts";

const ZIP = join(import.meta.dirname, "../../../data/gtfs-cache/latest.zip");
const hasZip = existsSync(ZIP);
const feed = hasZip ? feedFromZip(new Uint8Array(readFileSync(ZIP))) : null;

describe("idő", () => {
  it("hajnali 1:30-kor még az előző szolgáltatási nap van", () => {
    // 2026-10-29 01:30 CET = 00:30 UTC
    const c = serviceClock(Date.UTC(2026, 9, 29, 0, 30) / 1000);
    expect(c.iso).toBe("2026-10-28");
    expect(c.calendarIso).toBe("2026-10-29");
    expect(c.secOfDay).toBe(25 * 3600 + 30 * 60);
  });

  it("délben a naptári nap a szolgáltatási nap", () => {
    const c = serviceClock(Date.UTC(2026, 9, 28, 11, 0) / 1000);
    expect(c.iso).toBe("2026-10-28");
    expect(c.secOfDay).toBe(12 * 3600);
    expect(hmOfUnix(c.unix)).toBe("12:00");
  });

  it("nyári időben is helyes a helyi idő", () => {
    expect(hmOfUnix(Date.UTC(2026, 6, 1, 6, 15) / 1000)).toBe("08:15");
  });

  it("óraátállítás napján a 08:00-s menet 08:00 helyi időben indul", () => {
    // 2026-10-25: visszaállítás (CEST → CET)
    const ref = localMidnightUnix("2026-10-25");
    expect(hmOfUnix(ref + 8 * 3600)).toBe("08:00");
    const spring = localMidnightUnix("2026-03-29");
    expect(hmOfUnix(spring + 8 * 3600)).toBe("08:00");
  });

  it("24 óra fölötti menetrendi idő körbefordul", () => {
    expect(secToHm(25 * 3600 + 10 * 60)).toBe("01:10");
  });
});

describe("naptár", () => {
  it("naptípusok", () => {
    expect(dayType("2026-10-28")).toBe(0); // szerda
    expect(dayType("2026-10-31")).toBe(1); // szombat
    expect(dayType("2026-11-01")).toBe(2); // vasárnap + Mindenszentek
    expect(dayType("2026-10-23")).toBe(2); // nemzeti ünnep (péntek)
  });
  it("magyar toldalék", () => {
    expect(withHungarianSuffix("14")).toBe("14-es");
    expect(withHungarianSuffix("5")).toBe("5-ös");
    expect(withHungarianSuffix("20")).toBe("20-as");
    expect(withHungarianSuffix("1V")).toBe("1V");
  });
});

describe("csv", () => {
  it("idézőjeles, vesszős mező", () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"Miskolctapolca, Barlangfürdő",3\n4,"say ""hi""",6\n');
    expect(rows).toEqual([
      { a: "1", b: "Miskolctapolca, Barlangfürdő", c: "3" },
      { a: "4", b: 'say "hi"', c: "6" },
    ]);
  });
});

describe("geo", () => {
  it("hurokjáratnál az első megálló a nyomvonal elejére esik", () => {
    // négyzet alakú hurok, ugyanoda ér vissza
    const pts: [number, number][] = [
      [48.1, 20.7],
      [48.1, 20.71],
      [48.11, 20.71],
      [48.11, 20.7],
      [48.1, 20.7],
    ];
    const s = new ProjectedShape(pts);
    const p = s.projectForward(48.1, 20.7, 0);
    expect(p?.alongM).toBeLessThan(5);
    const end = s.projectForward(48.1, 20.7, 2000);
    expect(end?.alongM).toBeGreaterThan(s.lengthM - 5);
  });
});

describe.skipIf(!hasZip)("valódi MVK feed", () => {
  it("érvényes és teljes", () => {
    const v = feed!.validate();
    expect(v.errors).toEqual([]);
    expect(v.counts.trips).toBeGreaterThan(1000);
    expect(v.counts.routes).toBeGreaterThan(30);
  });

  it("a menetek túlnyomó többsége nyomvonalra illeszthető", () => {
    let ok = 0;
    for (const id of feed!.trips.keys()) if (feed!.tripStopsAlong(id)) ok++;
    expect(ok / feed!.trips.size).toBeGreaterThan(0.95);
  });

  it("pontos napra a saját feedjét adja", () => {
    const d = resolveServiceDay([feed!], "2026-10-29")!;
    expect(d.fallback).toBeNull();
    expect(d.services.size).toBeGreaterThan(0);
  });

  it("lefedetlen napra fallback azonos naptípussal", () => {
    const d = resolveServiceDay([feed!], "2027-03-03")!; // szerda, a feeden kívül
    expect(d.fallback).not.toBeNull();
    expect(dayType(d.fallback!.templateIso)).toBe(0);
    expect(d.services.size).toBeGreaterThan(0);
  });

  it("üres feed nem érvényes, és a jó feed marad a nyerő", () => {
    const empty = feedFromFiles({ "feed_info.txt": "feed_version\n20261030-1\n", "stops.txt": "stop_id,stop_lat,stop_lon\n" });
    expect(empty.validate().ok).toBe(false);
    const d = resolveServiceDay([feed!], "2026-10-30")!;
    expect(d.feed).toBe(feed);
  });

  it("más service_id-vel érkező valós idejű trip_id is feloldható", () => {
    const d = resolveServiceDay([feed!], "2026-10-29")!;
    const anyTrip = [...feed!.trips.values()].find((t) => d.services.has(t.serviceId) && parseMvkTripId(t.id))!;
    const parsed = parseMvkTripId(anyTrip.id)!;
    const foreign = ["99999", parsed.shapeId, anyTrip.id.split("_")[2], "XYZ"].join("_");
    expect(resolveTrip(d, foreign)?.id).toBe(anyTrip.id);
  });
});
