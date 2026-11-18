import { describe, expect, it } from "vitest";
import { analyzeTramLines, type TramLineDef, type TramOnLine } from "../src/tramLine.ts";

const NAMES = ["Tiszai", "Selyemrét", "Soltész", "Szinvapark", "Villanyrendőr", "Városház tér", "Malomszög", "Szent Anna", "Thököly", "Balázs Győző", "Gyula", "Károly", "Újgyőri főtér", "Újgyőri piac", "DVTK", "Bulgárföld", "Diósgyőri Gimn.", "LÁEV", "Zenta", "Diósgyőr vk.", "Bölcs", "Alsó-Majláth", "Felső-Majláth"];
// a két irány külön megálló-azonosítókat használ (két oldali peron)
const OUT: TramLineDef = { toward: "Felső-Majláth", stops: NAMES.map((name, i) => ({ id: `o${i}`, name })) };
const IN: TramLineDef = { toward: "Tiszai", stops: [...NAMES].reverse().map((name, i) => ({ id: `i${i}`, name })) };

const tram = (vehicleId: string, dir: "o" | "i", at: number, extra: Partial<TramOnLine> = {}): TramOnLine => ({
  vehicleId,
  route: "1V",
  delayS: 0,
  stallS: null,
  fromStopId: `${dir}${at}`,
  toStopId: `${dir}${at + 1}`,
  frac: 0.5,
  losingS: null,
  ...extra,
});

describe("villamosvonal-elemző", () => {
  it("rendben: senki nem áll", () => {
    const r = analyzeTramLines([OUT, IN], [tram("600", "o", 3), tram("601", "o", 12), tram("602", "i", 5)]);
    expect(r.verdict.kind).toBe("ok");
    expect(r.lines[0].trams.map((t) => t.vehicleId)).toEqual(["600", "601"]);
  });

  it("egy irányban sor: a legelöl álló a fej, a mögötte állók rekedtek, az előtte mozgó nem számít", () => {
    const r = analyzeTramLines(
      [OUT, IN],
      [
        tram("620", "o", 18), // elöl halad tovább
        tram("609", "o", 4, { stallS: 500, delayS: 1700 }),
        tram("630", "o", 3, { stallS: 420, delayS: 1300 }),
        tram("626", "o", 2, { losingS: 400, delayS: 1000 }),
        tram("605", "o", 0), // még mozog, megszakítja a sort
        tram("608", "i", 8),
      ],
    );
    const out = r.lines[0];
    expect(out.blockage).toMatchObject({ head: "609", behind: ["630", "626"], fromStop: "Villanyrendőr", toStop: "Városház tér", sinceS: 500 });
    expect(out.trams.find((t) => t.vehicleId === "620")?.role).toBeNull();
    expect(r.verdict).toMatchObject({ kind: "one-way", toward: "Felső-Majláth", head: "609", behind: 2, otherOk: true, otherToward: "Tiszai" });
  });

  it("araszoló, de nem álló sor: torlódás, nem leállás", () => {
    const r = analyzeTramLines([OUT, IN], [tram("609", "o", 6, { losingS: 300 }), tram("630", "o", 5, { losingS: 240 })]);
    expect(r.verdict.kind).toBe("queue");
  });

  it("egyetlen, régóta álló villamos is akadály; egy rövid ideig álló nem", () => {
    expect(analyzeTramLines([OUT, IN], [tram("609", "o", 6, { stallS: 7 * 60 })]).verdict.kind).toBe("one-way");
    expect(analyzeTramLines([OUT, IN], [tram("609", "o", 6, { stallS: 4 * 60 })]).verdict.kind).toBe("ok");
  });

  it("mindkét irány ugyanott áll: a pályát elzáró akadály", () => {
    const r = analyzeTramLines(
      [OUT, IN],
      [tram("609", "o", 4, { stallS: 400 }), tram("630", "o", 3, { stallS: 400 }), tram("608", "i", 17, { stallS: 400 }), tram("600", "i", 16, { stallS: 300 }), tram("601", "o", 15), tram("602", "i", 2)],
    );
    expect(r.verdict).toMatchObject({ kind: "both-ways", samePlace: true });
  });

  it("az egész vonalon állnak: áram- vagy felsővezeték-hiba", () => {
    const r = analyzeTramLines([OUT, IN], [tram("1", "o", 2, { stallS: 400 }), tram("2", "o", 10, { stallS: 400 }), tram("3", "i", 5, { stallS: 400 }), tram("4", "i", 15, { stallS: 400 }), tram("5", "o", 18)]);
    expect(r.verdict.kind).toBe("whole-line");
  });

  it("egymás nyakában haladó villamosok", () => {
    const r = analyzeTramLines([OUT, IN], [tram("1", "o", 10, { frac: 0.9 }), tram("2", "o", 10, { frac: 0.2 }), tram("3", "o", 9, { frac: 0.5 }), tram("4", "o", 2)]);
    expect(r.lines[0].bunches).toEqual([["1", "2", "3"]]);
  });

  it("a 2-es vasgyári hurkán járó villamos egyik irányra sem kerül", () => {
    const r = analyzeTramLines([OUT, IN], [{ ...tram("640", "o", 0), fromStopId: "vasgyar1", toStopId: "vasgyar2" }]);
    expect(r.lines.every((l) => l.trams.length === 0)).toBe(true);
  });
});
