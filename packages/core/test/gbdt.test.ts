import { describe, expect, it } from "vitest";
import { isGbdtModel, pinball, predictGbdt, quantileOf, trainGbdt, type Matrix } from "../src/ml/gbdt.ts";

/** y = 3·x0 + (x1 > 0,5 ? 20 : 0) + zaj, ahol a zaj szórása x2-vel nő (heteroszkedasztikus). */
function synth(n: number, seed: number, missingShare = 0) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const cols = 3;
  const x = new Float32Array(n * cols);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x0 = rnd() * 10;
    const x1 = rnd();
    const x2 = rnd();
    x[i * cols] = x0;
    x[i * cols + 1] = rnd() < missingShare ? NaN : x1;
    x[i * cols + 2] = x2;
    y[i] = 3 * x0 + (x1 > 0.5 ? 20 : 0) + gauss() * (1 + 6 * x2);
  }
  return { m: { x, rows: n, cols } satisfies Matrix, y };
}

const FEATURES = ["x0", "x1", "x2"];

describe("kvantilis gradient boosting", () => {
  const train = synth(20_000, 1);
  const valid = synth(5_000, 2);
  const test = synth(5_000, 3);

  it("a medián-modell sokkal jobb a konstans becslésnél, és nem tanul túl", () => {
    const model = trainGbdt(train.m, train.y, FEATURES, { alpha: 0.5, trees: 200 }, { m: valid.m, y: valid.y });
    const constQ = quantileOf(train.y, 0.5);
    let lossModel = 0;
    let lossConst = 0;
    for (let i = 0; i < test.m.rows; i++) {
      const q = predictGbdt(model, test.m.x.subarray(i * 3, i * 3 + 3));
      lossModel += pinball(0.5, test.y[i], q);
      lossConst += pinball(0.5, test.y[i], constQ);
    }
    expect(lossModel).toBeLessThan(lossConst * 0.3);
    expect(model.info.validLoss).not.toBeNull();
  });

  it("a 85%-os modell a tesztsorok kb. 85%-át lefedi", () => {
    const model = trainGbdt(train.m, train.y, FEATURES, { alpha: 0.85, trees: 200 }, { m: valid.m, y: valid.y });
    let covered = 0;
    for (let i = 0; i < test.m.rows; i++) if (test.y[i] <= predictGbdt(model, test.m.x.subarray(i * 3, i * 3 + 3))) covered++;
    const share = covered / test.m.rows;
    expect(share).toBeGreaterThan(0.8);
    expect(share).toBeLessThan(0.9);
  });

  it("a felső kvantilis ott tágabb, ahol nagyobb a szórás", () => {
    const model = trainGbdt(train.m, train.y, FEATURES, { alpha: 0.85, trees: 200 }, { m: valid.m, y: valid.y });
    const median = trainGbdt(train.m, train.y, FEATURES, { alpha: 0.5, trees: 200 }, { m: valid.m, y: valid.y });
    const width = (x2: number) => {
      const row = Float32Array.from([5, 0.2, x2]);
      return predictGbdt(model, row) - predictGbdt(median, row);
    };
    expect(width(0.9)).toBeGreaterThan(width(0.1) * 2);
  });

  it("a hiányzó értékkel is tanul és jósol", () => {
    const tm = synth(20_000, 4, 0.3);
    const model = trainGbdt(tm.m, tm.y, FEATURES, { alpha: 0.5, trees: 120 });
    const withMissing = predictGbdt(model, Float32Array.from([5, NaN, 0.5]));
    expect(Number.isFinite(withMissing)).toBe(true);
    // ismert x1 mellett a +20-as lépcsőt megtalálja
    const hi = predictGbdt(model, Float32Array.from([5, 0.9, 0.5]));
    const lo = predictGbdt(model, Float32Array.from([5, 0.1, 0.5]));
    expect(hi - lo).toBeGreaterThan(15);
  });

  it("JSON-on át visszatöltve ugyanazt adja, és a sérült modellt felismeri", () => {
    const model = trainGbdt(train.m, train.y, FEATURES, { alpha: 0.5, trees: 30 });
    const back = JSON.parse(JSON.stringify(model));
    expect(isGbdtModel(back)).toBe(true);
    const row = Float32Array.from([2, 0.7, 0.3]);
    expect(predictGbdt(back, row)).toBeCloseTo(predictGbdt(model, row), 6);
    back.trees[0].left[0] = 0;
    expect(isGbdtModel(back)).toBe(false);
    expect(isGbdtModel({ v: 2 })).toBe(false);
  });
});
