import { describe, expect, it } from "vitest";
import { tripVariants, untilName } from "../src/index.ts";

const names: Record<string, string> = {
  C: "Centrum", I: "Ifjúság útja", V: "Avas városközpont", K: "Avas kilátó", S: "Szondi György utca",
  M: "Miskolctapolca", T: "Tanulmányi épületek", E: "Egyetemváros", R: "Repülőtér / Bosch", B: "Búza tér",
};
const nameOf = (id: string) => names[id] ?? id;
const trip = (id: string, headsign: string, stops: string) => ({ tripId: id, headsign, stops: stops.split("") });

describe("útvonal-változatok a menetrendben", () => {
  it("a 35-ös: Avas városközpont érintésével, és a kocsiszín felől induló menet", () => {
    const r = tripVariants(
      [
        trip("a1", "Centrum - Avas kilátó", "CBK"),
        trip("a2", "Centrum - Avas kilátó", "CBK"),
        trip("a3", "Centrum - Avas kilátó", "CBK"),
        trip("v1", "Centrum - Avas vk. - Avas kilátó", "CBIVK"),
        trip("v2", "Centrum - Avas vk. - Avas kilátó", "CBIVK"),
        trip("s1", "Szondi Gy. u. - Centrum - Avas kilátó", "SCBK"),
      ],
      nameOf,
    );
    expect(r.variants).toEqual([
      { code: "A", label: "Avas városközpont érintésével (+2 megálló)", trips: 2 },
      { code: "S", label: "Szondi György utca felől indul", trips: 1 },
    ]);
    expect(r.codeOf.get("v1")).toBe("A");
    expect(r.codeOf.has("a1")).toBe(false);
  });

  it("kihagyott megálló, rövidebb és továbbmenő menet", () => {
    const r = tripVariants(
      [
        trip("m1", "Miskolctapolca - Repülőtér/Bosch (Egyetem)", "MTER"),
        trip("m2", "Miskolctapolca - Repülőtér/Bosch (Egyetem)", "MTER"),
        trip("m3", "Miskolctapolca - Repülőtér/Bosch (Egyetem)", "MTER"),
        trip("x1", "Miskolctapolca - Repülőtér/Bosch", "MR"),
        trip("x2", "Miskolctapolca - Egyetemváros", "MTE"),
        trip("x3", "Miskolctapolca - Búza tér", "MTERB"),
      ],
      nameOf,
    );
    const byCode = Object.fromEntries(r.variants.map((v) => [v.code, v.label]));
    expect(Object.values(byCode)).toContain("Tanulmányi épületek nélkül (+0)".replace(" (+0)", "").replace("Tanulmányi épületek", "Tanulmányi épületek"));
    expect(r.variants.find((v) => v.trips === 1 && v.label.startsWith("csak"))?.label).toBe("csak Egyetemvárosig");
    expect(r.variants.find((v) => v.label.startsWith("tovább"))?.label).toBe("tovább Búza térig");
    // minden betűjel egyedi
    expect(new Set(r.variants.map((v) => v.code)).size).toBe(r.variants.length);
  });

  it("egyetlen útvonalnál nincs betűjel", () => {
    const r = tripVariants([trip("a", "X", "CBK"), trip("b", "X", "CBK")], nameOf);
    expect(r.variants).toEqual([]);
  });

  it("a toldalék a magyar szabály szerint", () => {
    expect(untilName("Szondi György utca")).toBe("Szondi György utcáig");
    expect(untilName("Hejőpark")).toBe("Hejőparkig");
    expect(untilName("Búza tér")).toBe("Búza térig");
    expect(untilName("Szinvapark 2.")).toBe("Szinvapark 2.-ig");
  });
});
