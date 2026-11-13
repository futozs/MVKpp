import { describe, expect, it } from "vitest";
import {
  CATCH_S,
  costQuantile,
  displayCosts,
  fallbackDisp,
  finalizeProfile,
  isotonic,
  lagSeconds,
  MOTION_FEATURES,
  MOTION_GRID,
  motionAnchor,
  motionFeatures,
  motionTrajectory,
  packProfile,
  PASS_CAP_S,
  passTimes,
  predictGbdt,
  profileSumsOf,
  StretchTraffic,
  sumProfiles,
  trainGbdt,
  typicalDisp,
  typicalTime,
  unpackProfile,
  type MotionFix,
  type MotionRun,
} from "../src/index.ts";

const MIDNIGHT = 1_800_000_000;
const T0 = MIDNIGHT + 8 * 3600;

/**
 * Egy 1 km-es nyomvonal: 10 m/s-mal megy, a 400. méternél (lámpa) 30 mp-et áll.
 * 15 mp-enként jelez, mint a valódi buszok.
 */
function run(start: number, standS = 30): MotionRun {
  const fixes: MotionFix[] = [];
  for (let t = 0; t <= 225; t += 15) {
    const moving = t < 40 ? t * 10 : t < 40 + standS ? 400 : 400 + (t - 40 - standS) * 10;
    const x = Math.min(1000, moving);
    const standing = t >= 40 && t < 40 + standS;
    fixes.push([start + t, x, standing ? 0 : 10]);
  }
  return { shapeId: "S1", fixes };
}

describe("tanult útprofil", () => {
  const runs = [0, 600, 1200, 1800, 2400].map((k) => run(T0 + k));
  const prof = finalizeProfile(profileSumsOf(runs, MIDNIGHT));
  const p = prof.all.get("S1")!;

  it("megtanulja, hol állnak a buszok (a lámpát senki nem vitte fel)", () => {
    const at = (x: number) => p.stop[Math.floor(x / 20)];
    expect(at(400)).toBeGreaterThan(0.5);
    expect(at(200)).toBe(0);
    expect(p.dwell[Math.floor(400 / 20)]).toBeGreaterThan(20);
  });

  it("a jellemző idő és az elmozdulás egymás inverze", () => {
    const t = typicalTime(p, 100, 300);
    expect(t).toBeGreaterThan(15);
    expect(t).toBeLessThan(25);
    expect(typicalDisp(p, 100, t)).toBeCloseTo(200, 0);
    // a lámpán át lassabb: több idő kell ugyanannyi úthoz
    expect(typicalTime(p, 300, 500)).toBeGreaterThan(typicalTime(p, 100, 300) + 10);
  });

  it("egy nap kivonása visszaadja a többi napot (a tanítás nem lát előre)", () => {
    const a = profileSumsOf(runs.slice(0, 3), MIDNIGHT);
    const b = profileSumsOf(runs.slice(3), MIDNIGHT);
    const both = sumProfiles([a, b]);
    const onlyA = finalizeProfile(sumProfiles([both], b)).all.get("S1")!;
    const direct = finalizeProfile(a).all.get("S1")!;
    expect(Array.from(onlyA.pace).map((x) => x.toFixed(3))).toEqual(Array.from(direct.pace).map((x) => x.toFixed(3)));
  });

  it("tárolás után ugyanaz (tized mp pontossággal)", () => {
    const back = unpackProfile(JSON.parse(JSON.stringify(packProfile(prof))));
    const q = back.all.get("S1")!;
    for (let b = 0; b < p.pace.length; b++) expect(Math.abs(q.pace[b] - p.pace[b])).toBeLessThan(0.051);
    expect(back.byClass.length).toBe(prof.byClass.length);
    expect(typicalTime(q, 0, 900)).toBeCloseTo(typicalTime(p, 0, 900), 0);
  });
});

describe("a modell bemenete", () => {
  const trip = { along: [0, 400, 1000], arr: [8 * 3600, 8 * 3600 + 40, 8 * 3600 + 130], dep: [8 * 3600, 8 * 3600 + 45, 8 * 3600 + 130] };

  it("tudja, mióta áll a busz és milyen messze a következő megálló", () => {
    const f = run(T0).fixes;
    const i = f.findIndex((x) => x[0] === T0 + 60);
    const a = motionAnchor(f, i, trip, MIDNIGHT, 0);
    expect(a.v).toBe(0);
    expect(a.stoppedFor).toBe(15); // 45. és 60. mp-es fix is áll
    expect(a.stopDist).toBe(0); // a 400 m-es megállóban
    expect(a.endDist).toBe(600);
    expect(a.delay).toBeGreaterThan(0); // menetrend szerint már indulnia kellett volna
  });

  it("a jellemzővektor a listázott sorrendben, a profil-előzménnyel együtt", () => {
    const f = run(T0).fixes;
    const prof = finalizeProfile(profileSumsOf([run(T0 + 600), run(T0 + 1200)], MIDNIGHT)).all.get("S1");
    const a = motionAnchor(f, 2, trip, MIDNIGHT, 0);
    const out = motionFeatures(a, 10, 5, prof, undefined, new Float32Array(MOTION_FEATURES.length));
    expect(out[MOTION_FEATURES.indexOf("H")]).toBe(10);
    expect(out[MOTION_FEATURES.indexOf("L")]).toBe(5);
    expect(out[MOTION_FEATURES.indexOf("prior")]).toBeGreaterThan(50);
    expect(Number.isNaN(out[MOTION_FEATURES.indexOf("priorHour")])).toBe(true);
  });
});

describe("élő forgalom a szakaszon", () => {
  const prof = finalizeProfile(profileSumsOf([run(T0), run(T0 + 600)], MIDNIGHT)).all.get("S1")!;

  it("csak a már kiderült áthaladásokat látja, és a lassú buszt lassulásnak méri", () => {
    const tr = new StretchTraffic();
    const slow = run(T0 + 1000, 90).fixes; // 90 mp-et állt a lámpánál
    tr.addRun("S1", "slow", slow, prof.pace.length);
    const passEnd = T0 + 1000 + 40 + 90 + 10; // a 400+ m-en túl
    expect(Number.isNaN(tr.query("S1", 200, T0 + 1000 + 60, prof, "me").ratio)).toBe(true); // még nem ért át
    const q = tr.query("S1", 200, passEnd + 60, prof, "me");
    expect(q.ratio).toBeGreaterThan(1.2);
    expect(Number.isNaN(tr.query("S1", 200, passEnd + 60, prof, "slow").ratio)).toBe(true); // saját magát nem
  });

  it("az egész napot ismerő index sem lát többet, mint ami az adott pillanatig kiderült (a tanítás nem lát előre)", () => {
    const runs = [0, 120, 300, 480, 700].map((k, i) => ({ key: `r${i}`, fixes: run(T0 + k, i % 2 ? 60 : 20).fixes }));
    const full = new StretchTraffic();
    for (const r of runs) full.addRun("S1", r.key, r.fixes, prof.pace.length);
    let seen = 0;
    for (let t = T0; t <= T0 + 1000; t += 37) {
      const partial = new StretchTraffic();
      for (const r of runs) partial.addRun("S1", r.key, r.fixes.filter((f) => f[0] <= t), prof.pace.length);
      for (const x of [0, 150, 380, 600]) {
        const a = full.query("S1", x, t, prof, "me");
        const b = partial.query("S1", x, t, prof, "me");
        expect([a.ratio, a.age]).toEqual([b.ratio, b.age]);
        if (Number.isFinite(a.ratio)) seen++;
      }
    }
    expect(seen).toBeGreaterThan(10); // tényleg volt mit összevetni
  });

  it("a 20 percnél régebbi áthaladás kiesik", () => {
    const tr = new StretchTraffic();
    tr.addRun("S1", "a", run(T0 + 1000).fixes, prof.pace.length);
    expect(Number.isNaN(tr.query("S1", 200, T0 + 1000 + 3600, prof, "me").ratio)).toBe(true);
  });
});

describe("a térkép pályája", () => {
  it("isotonic: a legközelebbi nem csökkenő sor", () => {
    expect(isotonic([0, 5, 3, 8])).toEqual([0, 4, 4, 8]);
    expect(isotonic([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("a pálya a fixből indul, sosem megy vissza, és a végállomásnál megáll", () => {
    const disp = MOTION_GRID.map((h) => (h === 30 ? 50 : h * 12)); // egy kiugró visszaesés
    const k = motionTrajectory(500, disp, 1200);
    expect(k[0]).toEqual([500, 0]);
    for (let i = 1; i < k.length; i++) expect(k[i][0]).toBeGreaterThanOrEqual(k[i - 1][0]);
    expect(k[k.length - 1][0]).toBe(1200);
    expect(k.map((x) => x[1])).toEqual([...MOTION_GRID]);
  });

  it("a kivárás ideje: álló busznál a hátralévő állás, haladónál egy pillanat", () => {
    const f = run(T0).fixes; // 0–40 mp halad, 40–70 áll a 400. méteren, utána megy tovább
    const pass = passTimes(f);
    const at = (t: number) => pass[f.findIndex((x) => x[0] === T0 + t)];
    expect(at(15)).toBeCloseTo(1.5, 5); // 10 m/s-mal 15 m
    // 45. és 60. mp: áll a 400. méteren; 75. mp: 450 m  a kettő között egyenletesen, így a 415. métert a 64,5. mp-ben éri el
    expect(at(45)).toBeCloseTo(19.5, 5);
    // a menet végén már nincs mire várni: legfeljebb a menet végéig
    expect(pass[f.length - 1]).toBe(0);
    expect(Math.max(...pass)).toBeLessThanOrEqual(PASS_CAP_S);
  });

  it("a túllövés sosem olcsóbb a lemaradásnál, egy álló busz előtt sokkal drágább", () => {
    const lag = Float32Array.from([lagSeconds(100, 108), lagSeconds(100, 108)]);
    expect(lag[0]).toBe(8 + CATCH_S);
    const c = displayCosts(lag, Float32Array.from([1.5, 40]));
    expect([c.under[0], c.over[0]]).toEqual([lag[0], lag[0]]);
    expect(c.over[1]).toBe(40);
  });

  it("tartalék: az álló busz kivárja a hely szokásos állásidejét", () => {
    const prof = finalizeProfile(profileSumsOf([run(T0), run(T0 + 600), run(T0 + 1200)], MIDNIGHT)).all.get("S1")!;
    const trip = { along: [0, 1000], arr: [0, 200], dep: [0, 200] };
    const f = run(T0).fixes;
    const i = f.findIndex((x) => x[0] === T0 + 45);
    const a = motionAnchor(f, i, trip, MIDNIGHT, 0);
    expect(fallbackDisp(a, 5, prof)).toBe(0);
    expect(fallbackDisp(a, 60, prof)).toBeGreaterThan(50);
    // haladó busz modell nélkül sem áll meg
    const moving = motionAnchor(f, 1, trip, MIDNIGHT, 0);
    expect(fallbackDisp(moving, 10, prof)).toBeGreaterThan(60);
  });
});

describe("költséges tanítás (a térkép költségével)", () => {
  it("egyforma költséggel a medián; ha a fölé lövés drága, a drága sorok felé húz", () => {
    const y = [0, 0, 0, 0, 100, 100, 100, 100, 100, 100];
    const one = y.map(() => 1);
    expect(costQuantile(y, one, one)).toBe(100);
    // a 0-n álló sorok (a busz a megállóban vár) túllövése 30-szor drágább
    const over = y.map((v) => (v === 0 ? 30 : 1));
    expect(costQuantile(y, over, one)).toBe(0);
  });

  it("a gyorskiválasztás ugyanazt adja, mint a rendezés (ismétlődő értékekkel is)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const reference = (v: number[], o: number[], u: number[]) => {
      const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
      let above = u.reduce((s, x) => s + x, 0);
      let below = 0;
      for (const i of idx) {
        below += o[i];
        above -= u[i];
        if (below >= above) return v[i];
      }
      return v[idx[idx.length - 1]];
    };
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rnd() * 60);
      const v = Array.from({ length: n }, () => Math.round(rnd() * 20) - 5);
      const o = Array.from({ length: n }, () => (rnd() < 0.2 ? 0 : rnd() * 40));
      const u = Array.from({ length: n }, () => rnd() * 10);
      expect(costQuantile(v, o, u)).toBe(reference(v, o, u));
    }
  });

  it("a fa a megálló előtt kivár, egyenesben a mediánt adja", () => {
    // x=1: a buszok 40%-a megáll (0 m), 60%-a továbbmegy (100 m); x=0: egyenes, 45–55 m
    const rows = 4000;
    const x = new Float32Array(rows);
    const y = new Float32Array(rows);
    const over = new Float32Array(rows);
    const under = new Float32Array(rows);
    for (let i = 0; i < rows; i++) {
      const stopZone = i % 2 === 1;
      x[i] = stopZone ? 1 : 0;
      const stops = stopZone && i % 5 < 2;
      y[i] = stopZone ? (stops ? 0 : 100) : 45 + (i % 11);
      under[i] = 6;
      over[i] = stops ? 30 : 6;
    }
    const m = trainGbdt({ x, rows, cols: 1 }, y, ["stop"], { trees: 60, depth: 2, minLeaf: 20, lr: 0.3, subsample: 1 }, undefined, { over, under });
    expect(predictGbdt(m, [1])).toBeLessThan(5);
    expect(predictGbdt(m, [0])).toBeCloseTo(50, 0);
    // ugyanez költség nélkül (medián): a megálló-zónában továbbszaladna
    const median = trainGbdt({ x, rows, cols: 1 }, y, ["stop"], { trees: 60, depth: 2, minLeaf: 20, lr: 0.3, subsample: 1 });
    expect(predictGbdt(median, [1])).toBeGreaterThan(90);
  });
});
