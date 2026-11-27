import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fastDistM, ProjectedShape } from "../src/geo.ts";
import { buildAdventLine, END_RADIUS_M } from "../src/advent/line.ts";
import { REPLAY, replayAt, replayDay, type ReplayShapes } from "../src/advent/replay.ts";
import { seasonOf } from "../src/advent/season.ts";
import { trackDay, type AdventPing } from "../src/advent/track.ts";

// ugyanaz a valódi nap, mint az adventDay tesztben: a 203-as Tatra 16 menete
const fx = JSON.parse(readFileSync(new URL("./fixtures/advent-tram203-2026-11-26.json", import.meta.url), "utf8")) as {
  shape: [number, number][];
  stops: Record<string, [number, number]>;
  pings: [number, number, number][];
};
const season = seasonOf(2026)!;
const line = buildAdventLine(season, fx.shape, (id) => (fx.stops[id] ? { lat: fx.stops[id][0], lon: fx.stops[id][1] } : undefined))!;
const pings: AdventPing[] = fx.pings.map(([ts, lat, lon]) => ({ ts, lat, lon, speed: null }));
// a visszafelé nyomvonal itt az odafelé megfordítva (a feedben külön alakzat, a másik vágányon)
const shapes: ReplayShapes = { out: new ProjectedShape(fx.shape), back: new ProjectedShape([...fx.shape].reverse()) };
const track = trackDay(line, pings, Infinity);
const replay = replayDay(track, shapes);

describe("adventi villamos visszajátszása", () => {
  it("menetenként egy sor, a day.legs indexeivel", () => {
    expect(replay.legs).toHaveLength(track.legs.length);
    replay.legs.forEach((l, i) => expect(l.dir).toBe(track.legs[i].dir));
  });

  it("a menet pontjai időrendben, a hely sosem csökken, végállomástól végállomásig", () => {
    for (const l of replay.legs) {
      const shape = shapes[l.dir];
      const distTo = (m: number, end: "tiszai" | "majlath") => {
        const [lat, lon] = shape.pointAt(m);
        return fastDistM(lat, lon, line.ends[end].lat, line.ends[end].lon);
      };
      expect(l.pts.length).toBeGreaterThan(20);
      for (let i = 1; i < l.pts.length; i++) {
        expect(l.pts[i][0]).toBeGreaterThan(l.pts[i - 1][0]);
        expect(l.pts[i][1]).toBeGreaterThanOrEqual(l.pts[i - 1][1]);
      }
      expect(distTo(l.pts[0][1], l.from!)).toBeLessThan(END_RADIUS_M);
      expect(distTo(l.pts[l.pts.length - 1][1], l.to!)).toBeLessThan(END_RADIUS_M);
    }
  });

  it("másodpercenként lejátszva a jelölő menet közben sosem lép vissza és nem ugrik", () => {
    const from = replay.legs[0].pts[0][0] - 600;
    const to = replay.legs[replay.legs.length - 1].pts.at(-1)![0] + 600;
    let prev = replayAt(replay, shapes, from)!;
    let backward = 0;
    let jumps = 0;
    for (let t = from + 1; t <= to; t++) {
      const p = replayAt(replay, shapes, t)!;
      if (p.near === prev.near && p.m < prev.m - 1e-6) backward++;
      // menet közben legfeljebb 25 m/s (a menetek közti váltás a végállomáson más nyomvonalra lép)
      if (p.near === prev.near && Math.hypot((p.lat - prev.lat) * 111_320, (p.lon - prev.lon) * 74_400) > 25) jumps++;
      prev = p;
    }
    expect(backward).toBe(0);
    expect(jumps).toBe(0);
  });

  it("a menetek között az előző menet végén áll", () => {
    const a = replay.legs[2];
    const b = replay.legs[3];
    const mid = Math.round((a.pts.at(-1)![0] + b.pts[0][0]) / 2);
    const p = replayAt(replay, shapes, mid)!;
    expect(p.leg).toBeNull();
    expect(p.near).toBe(2);
    expect(p.m).toBe(a.pts.at(-1)![1]);
    const before = replayAt(replay, shapes, replay.legs[0].pts[0][0] - 3600)!;
    expect(before.near).toBe(0);
    expect(before.m).toBe(replay.legs[0].pts[0][1]);
  });

  it("a végállomáson hallgató villamos ott vár, és csak a jel előtt indul", () => {
    const firstLine = track.legs[5].fixes.find((f) => f.place === "line")!;
    // az indulás előtti 10 percben nem jött jel a végállomásról
    const r = replayDay(trackDay(line, pings.filter((p) => p.ts <= firstLine.ts - 600 || p.ts >= firstLine.ts), Infinity), shapes);
    const pts = r.legs[5].pts;
    expect(pts[1][1]).toBe(pts[0][1]);
    expect(pts[2][0]).toBe(firstLine.ts);
    expect(firstLine.ts - pts[1][0]).toBeLessThan(120);
    const mid = replayAt(r, shapes, Math.round((pts[0][0] + pts[1][0]) / 2))!;
    expect(mid.m).toBe(pts[0][1]);
    expect(mid.fresh).toBe(false);
  });

  it("GPS-tüske: a 300 m-rel előre ugró pont kiesik, a hely nem lép vissza", () => {
    const leg = track.legs[4];
    const f = leg.fixes[Math.floor(leg.fixes.length / 2)];
    const sign = leg.dir === "out" ? 1 : -1;
    const [lat, lon] = line.shape.pointAt(line.shape.project(f.lat, f.lon)!.alongM + sign * 300);
    const r = replayDay(trackDay(line, pings.map((p) => (p.ts === f.ts ? { ...p, lat, lon } : p)), Infinity), shapes);
    const pts = r.legs[4].pts;
    expect(pts.some((p) => p[0] === f.ts)).toBe(false);
    for (let k = 1; k < pts.length; k++) expect(pts[k][1]).toBeGreaterThanOrEqual(pts[k - 1][1]);
  });

  it("jel nélkül a hely becsült (nem friss)", () => {
    const quietFrom = replay.legs[6].pts[10][0];
    const r = replayDay(trackDay(line, pings.filter((p) => p.ts < quietFrom || p.ts > quietFrom + 600), Infinity), shapes);
    expect(replayAt(r, shapes, quietFrom + 300)!.fresh).toBe(false);
    expect(replayAt(r, shapes, quietFrom - 30)!.fresh).toBe(true);
  });
});
