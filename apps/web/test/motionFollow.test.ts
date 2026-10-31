import { describe, expect, it } from "vitest";
import { FOLLOW, followPath, type FollowParams, type MotionPath, type Shown } from "../src/components/map/motionFollow.ts";
import { onboardPath, projectOnShape, type ShapeLine } from "../src/components/map/onboard.ts";

const TICK = 0.25;

/** egyenletes pálya: `from`-ból `v` m/s-mal, `holdS` mp várakozás után */
function path(t: number, from: number, v: number, holdS = 0): MotionPath {
  const k: [number, number][] = [[from, 0]];
  if (holdS) k.push([from, holdS]);
  k.push([from + v * (90 - holdS), 90]);
  return { s: "S1", t, k };
}

function run(paths: { at: number; m: MotionPath }[], until: number, p: Readonly<FollowParams> = FOLLOW): Shown[] {
  const out: Shown[] = [];
  let shown: Shown | undefined;
  let i = 0;
  let cur: MotionPath | null = null;
  for (let T = paths[0].at; T <= until; T += TICK) {
    while (i < paths.length && paths[i].at <= T) cur = paths[i++].m;
    shown = followPath(cur!, T, shown, p);
    out.push(shown);
  }
  return out;
}

describe("a térkép jelölője", () => {
  it("sosem tolat: előreszaladva megáll és megvárja a buszt, utána vele megy tovább", () => {
    // 10 m/s-mal ment, de a következő fix szerint a busz a 120. méteren áll a megállóban (a jelölő ~150-nél jár)
    const out = run(
      [
        { at: 0, m: path(-5, 0, 10) },
        { at: 15, m: path(10, 120, 10, 20) },
      ],
      60,
    );
    for (let i = 1; i < out.length; i++) expect(out[i].along).toBeGreaterThanOrEqual(out[i - 1].along);
    const at = (T: number) => out[Math.round(T / TICK)].along;
    // vár: amíg a busz áll (a pálya mögötte), a jelölő egy helyben marad
    expect(at(25) - at(20)).toBeLessThan(0.5);
    // a busz elindult és utolérte: a jelölő ismét a pályán halad
    expect(at(60)).toBeCloseTo(120 + 10 * (50 - 20), 0);
  });

  it("lemaradásból rövid gyorsítással utoléri, de a pályán nem lő túl", () => {
    const out = run(
      [
        { at: 0, m: path(-5, 0, 5) },
        { at: 15, m: path(10, 200, 10) },
      ],
      40,
    );
    for (let i = 1; i < out.length; i++) {
      expect(out[i].along).toBeGreaterThanOrEqual(out[i - 1].along);
      expect((out[i].along - out[i - 1].along) / TICK).toBeLessThanOrEqual(FOLLOW.maxSpeed + 1e-9);
    }
    const target = (T: number) => 200 + 10 * (T - 10);
    expect(out[Math.round(40 / TICK)].along).toBeCloseTo(target(40), 0);
    for (const s of out.slice(Math.round(15 / TICK))) expect(s.along).toBeLessThanOrEqual(target(s.at!) + 1e-6);
  });

  it("akármilyen egymásnak ellentmondó pályákra sem mozdul soha visszafelé", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const paths: { at: number; m: MotionPath }[] = [];
    let x = 0;
    for (let t = 0; t < 1800; t += 5 + rnd() * 40) {
      x += rnd() * 150;
      const L = 2 + rnd() * 20;
      paths.push({ at: t + L, m: path(t, x - rnd() * 300, rnd() * 16, rnd() < 0.4 ? rnd() * 40 : 0) });
    }
    // a durva hibánál (snapM) visszaugró szabály nélkül: maga a követés sosem tolat
    const out = run(paths, 1900, { ...FOLLOW, snapM: Infinity });
    for (let i = 1; i < out.length; i++) expect(out[i].along).toBeGreaterThanOrEqual(out[i - 1].along);
  });

  it("csak durva illesztési hibánál (snapM-nél nagyobb eltérés) ugrik vissza", () => {
    const shown = { shape: "S1", along: 900, at: 10 };
    expect(followPath(path(0, 900 - FOLLOW.snapM + 50, 0), 10.25, shown).along).toBe(900);
    expect(followPath(path(0, 900 - FOLLOW.snapM - 50, 0), 10.25, shown).along).toBe(450);
  });

  it("hosszú szünet után (háttérbe tett lap) előre a buszhoz ugrik, vissza nem", () => {
    const m = path(0, 100, 0);
    expect(followPath(m, 30, { shape: "S1", along: 50, at: 10 }).along).toBe(100);
    expect(followPath(m, 30, { shape: "S1", along: 140, at: 10 }).along).toBe(140);
  });
});

describe("utazás közben a telefon GPS-e", () => {
  // egy 1 km-es, kelet felé futó egyenes (az Egyenlítőn: 1° hosszúság ≈ 111,3 km)
  const shape: ShapeLine = { pts: [[0, 0], [0, 1000 / 111_320]], cum: [0, 1000] };
  const lonAt = (m: number) => m / 111_320;
  const motion = { s: "S1", a: 300, t: 1000, e: 400, v: 8, k: null };
  const now = 1010;
  const nowMs = 5_000_000;
  const gps = (alongM: number, extra: Partial<{ at: number; accuracyM: number; speed: number | null; lat: number }> = {}) => ({
    lat: extra.lat ?? 0,
    lon: lonAt(alongM),
    accuracyM: extra.accuracyM ?? 8,
    at: extra.at ?? nowMs - 500,
    speed: extra.speed === undefined ? 9 : extra.speed,
  });

  it("a telefon helyét a nyomvonalra vetíti", () => {
    const hit = projectOnShape(shape, 20 / 110_540, lonAt(420), 400)!;
    expect(hit.along).toBeCloseTo(420, 0);
    expect(hit.dist).toBeCloseTo(20, 0);
  });

  it("a busz a telefonnal megy, a sebességével kicsit előre is viszi", () => {
    const p = onboardPath(gps(380), shape, motion, 360, now, nowMs)!;
    expect(p.k[0][0]).toBeCloseTo(380, 0);
    expect(p.t).toBeCloseTo(now - 0.5, 5);
    expect(p.k[1][0] - p.k[0][0]).toBeCloseTo(9 * p.k[1][1], 5);
  });

  it("nem használja, ha régi, pontatlan, a nyomvonal mellett van, vagy a busz már elhúzott (leszálltál)", () => {
    expect(onboardPath(gps(380, { at: nowMs - 9000 }), shape, motion, 360, now, nowMs)).toBeNull();
    expect(onboardPath(gps(380, { accuracyM: 80 }), shape, motion, 360, now, nowMs)).toBeNull();
    expect(onboardPath(gps(380, { lat: 90 / 110_540 }), shape, motion, 360, now, nowMs)).toBeNull();
    // a busz legutóbbi jele 300 m-nél volt: a telefon 200 m-nél már nem rajta ül
    expect(onboardPath(gps(200), shape, motion, 360, now, nowMs)).toBeNull();
    // 10 mp alatt nem juthatott 900 m-re
    expect(onboardPath(gps(900), shape, motion, 360, now, nowMs)).toBeNull();
  });

  it("sebesség nélkül csak a mért helyen áll", () => {
    const p = onboardPath(gps(380, { speed: null }), shape, motion, 360, now, nowMs)!;
    expect(p.k[1][0]).toBe(p.k[0][0]);
  });
});
