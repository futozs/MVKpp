import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adventDay, type LineTram } from "../src/advent/day.ts";
import { buildAdventLine, placeFix } from "../src/advent/line.ts";
import { seasonOf, stopOrder, type AdventDayPlan, type AdventEnd } from "../src/advent/season.ts";
import { trackDay, type AdventPing } from "../src/advent/track.ts";

// Egy valódi nap: a 203-as Tatra az 1-es vonalon (16 menet), a 202 testvére
const fx = JSON.parse(readFileSync(new URL("./fixtures/advent-tram203-2026-11-26.json", import.meta.url), "utf8")) as {
  shape: [number, number][];
  stops: Record<string, [number, number]>;
  pings: [number, number, number][];
};
const season = seasonOf(2026)!;
const line = buildAdventLine(season, fx.shape, (id) => (fx.stops[id] ? { lat: fx.stops[id][0], lon: fx.stops[id][1] } : undefined))!;
const pings: AdventPing[] = fx.pings.map(([ts, lat, lon]) => ({ ts, lat, lon, speed: null }));
const legs = trackDay(line, pings, Infinity).legs;

/** a menetrend a valódi indulásokból, percre kerekítve, a plakát 33 perces menetidejével */
function planOf(): AdventDayPlan {
  const trips = legs.map((l, n) => {
    const from = l.from as AdventEnd;
    const dep = Math.round(l.dep / 60) * 60 - 60;
    const stopTimes = stopOrder(season, from).map((i) => dep + (from === "tiszai" ? season.stops[i].outMin : season.stops[i].backMin) * 60);
    return { n, from, dep, arr: stopTimes[stopTimes.length - 1], stopTimes };
  });
  return { iso: "2026-11-26", type: "school", note: null, special: false, trips };
}
const plan = planOf();
const at = (pp: AdventPing[], now: number, trams?: LineTram[]) => adventDay(season, plan, "2026-11-26", line, pp.filter((p) => p.ts <= now), now, { feedOk: true, trams });

describe("adventi villamos: menetek a GPS-ből (valódi nap)", () => {
  it("16 teljes menet, felváltva, végállomástól végállomásig", () => {
    expect(legs).toHaveLength(16);
    expect(legs.every((l) => l.end === "arrived")).toBe(true);
    expect(legs.map((l) => l.dir).join(",")).toBe(Array.from({ length: 8 }, () => "out,back").join(","));
    for (const l of legs) {
      expect(l.passes).toHaveLength(23);
      expect((l.arr! - l.dep) / 60).toBeGreaterThan(24);
      expect((l.arr! - l.dep) / 60).toBeLessThan(40);
      expect(l.passes.filter((p) => p.served).length).toBeGreaterThanOrEqual(17);
      expect(l.distM).toBeGreaterThan(9800);
      expect(l.distM).toBeLessThan(11200);
    }
  });

  it("a végállomás (és a mellette lévő remíz) körzet, nem vonalszakasz", () => {
    const depot = placeFix(line, { ts: 0, lat: 48.099575, lon: 20.810036, speed: null });
    expect(depot.place).toBe("tiszai");
  });

  it("a lezárt nap hibátlan, minden menet lement", () => {
    const end = plan.trips[plan.trips.length - 1].arr + 3600;
    const d = at(pings, end);
    expect(d.closed).toBe(true);
    expect(d.verdict).toBe("perfect");
    expect(d.stats.doneTrips).toBe(16);
    expect(d.now.code).toBe("done");
    expect(d.incidents.filter((i) => i.severity !== "info")).toHaveLength(0);
  });

  it("menet közben a következő megállót mutatja, és van várható érkezés", () => {
    const t = plan.trips[4];
    const d = at(pings, t.dep + 12 * 60);
    expect(["running", "at_stop"]).toContain(d.now.code);
    expect(d.now.trip).toBe(d.trips[4].key);
    expect(d.etas.some((e) => e.live && e.trip === d.trips[4].key)).toBe(true);
  });
});

describe("adventi villamos: hibák és csend", () => {
  // a 9. menet közepén megáll, és onnan nem mozdul
  const cut = plan.trips[8].dep + 14 * 60;
  const stopAt = pings.find((p) => p.ts >= cut)!;
  const stalled = [...pings.filter((p) => p.ts < cut), ...Array.from({ length: 200 }, (_, i) => ({ ts: cut + i * 15, lat: stopAt.lat, lon: stopAt.lon, speed: 0 }))];

  it("a vonalon álló villamos: Áll → valószínű hiba (lehet → valószínű)", () => {
    expect(at(stalled, cut + 5 * 60).now.code).toBe("stalled");
    const b8 = at(stalled, cut + 9 * 60).now;
    expect(b8.code).toBe("breakdown");
    expect(b8.confidence).toBe("lehet");
    expect(at(stalled, cut + 21 * 60).now.confidence).toBe("valószínű");
  });

  it("ha előtte is áll egy villamos, sorban áll (nem az ő hibája)", () => {
    const now = cut + 9 * 60;
    const pos = at(stalled, now).now.position!;
    const sign = pos.dir === "back" ? -1 : 1;
    const ahead: LineTram = { id: "620", m: pos.m + sign * 200, dir: pos.dir, stillS: 600, ageS: 10 };
    expect(at(stalled, now, [ahead]).now.code).toBe("held");
  });

  it("a hiba után elmaradó menetek egy sorban, a nap lerobbant", () => {
    const end = plan.trips[plan.trips.length - 1].arr + 3600;
    const d = at(stalled, end);
    expect(d.verdict).toBe("down");
    expect(d.trips.slice(9).every((t) => t.verdict === "missed")).toBe(true);
    const missed = d.incidents.filter((i) => i.kind === "missed");
    expect(missed).toHaveLength(1);
    expect(missed[0].text).toContain("7 menet elmaradt");
  });

  it("a végállomáson elhallgat: késik az indulás → nincs jel, de csendből soha nem piros", () => {
    const t = plan.trips[5];
    const quiet = pings.filter((p) => p.ts < t.dep - 300);
    expect(at(quiet, t.dep + 60).now.code).toBe("terminus");
    expect(at(quiet, t.dep + 5 * 60).now.code).toBe("late_dep");
    for (const m of [9, 16, 40, 90]) {
      const now = at(quiet, t.dep + m * 60).now;
      expect(now.code).toBe("no_signal");
      expect(now.tone).not.toBe("bad");
    }
    // csendben nem „elmaradt”, hanem „nincs adat”
    expect(at(quiet, t.dep + 90 * 60).trips[5].verdict).toBe("no_data");
  });

  it("látjuk a végállomáson, de nem indul: nem indult → két kimaradt indulás után kiesett", () => {
    const t = plan.trips[5];
    const last = pings.filter((p) => p.ts < t.dep - 300).at(-1)!;
    const standing = [...pings.filter((p) => p.ts < t.dep - 300), ...Array.from({ length: 400 }, (_, i) => ({ ts: t.dep - 300 + i * 20, lat: last.lat, lon: last.lon, speed: 0 }))];
    expect(at(standing, t.dep + 9 * 60).now.code).toBe("not_departed");
    expect(at(standing, t.dep + 9 * 60).now.tone).toBe("bad");
    const later = at(standing, plan.trips[6].dep + 9 * 60);
    expect(later.trips[5].verdict).toBe("missed");
    expect(later.now.code).toBe("dropped");
  });

  it("a beérkezés előtti hosszú csend után a célvégállomáson: beért, nem félbemaradt", () => {
    const t = plan.trips[3];
    const silentFrom = t.arr - 8 * 60;
    const holey = pings.filter((p) => p.ts < silentFrom || p.ts > t.arr + 16 * 60);
    const d = at(holey, plan.trips[plan.trips.length - 1].arr + 3600);
    expect(d.trips[3].verdict).toBe("done");
    expect(d.trips[3].arrDelayS).toBeNull();
    expect(d.stats.partialTrips).toBe(0);
  });

  it("ha később újra jön a jele, a csendes menetek nem elmaradtak, csak jel nélküliek", () => {
    const gapFrom = plan.trips[5].dep - 300;
    const gapTo = plan.trips[8].dep - 300;
    const holey = pings.filter((p) => p.ts < gapFrom || p.ts >= gapTo);
    const d = at(holey, plan.trips[plan.trips.length - 1].arr + 3600);
    expect(d.trips.slice(5, 8).map((t) => t.verdict)).toEqual(["no_data", "no_data", "no_data"]);
    expect(d.stats.missedTrips).toBe(0);
  });

  it("a törölt menetnek és a régóta jel nélkülinek nincs várható ideje", () => {
    const now = plan.trips[9].dep;
    const key = at(pings, now).trips[10].key;
    const d = adventDay(season, plan, "2026-11-26", line, pings.filter((p) => p.ts <= now), now, { feedOk: true, cancelled: new Set([key]) });
    expect(d.trips[10].verdict).toBe("cancelled");
    expect(d.etas.some((e) => e.trip === key)).toBe(false);
    const silent = at([], plan.trips[3].dep + 45 * 60);
    expect(silent.trips.slice(0, 3).every((x) => x.verdict === "no_data")).toBe(true);
    expect(silent.etas.some((e) => silent.trips.slice(0, 3).some((x) => x.key === e.trip))).toBe(false);
  });

  it("nem látjuk: a napon egy jel sem jött, az első indulás után 10 perccel", () => {
    expect(at([], plan.trips[0].dep - 3600).now.code).toBe("before");
    expect(at([], plan.trips[0].dep + 11 * 60).now.code).toBe("not_seen");
  });
});
