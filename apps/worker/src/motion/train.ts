/**
 * A mozgás-modell tanítása és kiértékelése.
 *
 *  1. medián gradient boosting: hol lesz a busz H mp-cel a fix után (m)
 *  2. a SOSEM LÁTOTT tesztnapokon a térkép szemszögéből mérve (rögzített
 *     késleltetésekkel): modell vs. profil-alapú tartalék vs. az élő modell
 *  3. kapu: csak az él, ami a tartaléknál bizonyítottan jobb, és nem rosszabb
 *     a mostani modellnél — különben a régi marad (a rendszer nem romolhat el)
 */
import { isGbdtModel, isPackedProfile, MOTION_FEATURES, predictGbdt, trainGbdt, type GbdtModel, type GbdtParams, type PackedProfile } from "@mvk/core";
import type { MotionSampleSet } from "./dataset.ts";

export const MOTION_MODEL_NAME = "motion";
/** a modell csak legalább ennyivel kisebb átlagos hibánál veszi át a tartaléktól */
const MIN_GAIN_VS_FALLBACK = 0.05;
/** az élő modellnél legfeljebb ennyivel lehet rosszabb (zaj) */
const MAX_LOSS_VS_CURRENT = 0.01;
const MIN_TEST_ROWS = 5000;

export const MOTION_GBDT: Partial<GbdtParams> = { alpha: 0.5, trees: 500, depth: 7, lr: 0.08, minLeaf: 80, subsample: 0.6, earlyStop: 25 };

export type ErrorStats = { n: number; maeModel: number; maeFallback: number; maeStay: number; p90Model: number; p90Fallback: number; biasModel: number };

export type MotionModelBundle = {
  v: 1;
  name: typeof MOTION_MODEL_NAME;
  trainedAt: string;
  features: string[];
  model: GbdtModel;
  /** a tanult útprofil (az összes felhasznált napból) — ebből számol élesben */
  profile: PackedProfile;
  report: {
    rows: { train: number; valid: number; test: number };
    days: { train: string[]; valid: string[]; test: string[] };
    /** késleltetésenként (pl. „L5”) és állapotonként („standing” / „moving”) */
    groups: Record<string, ErrorStats>;
    overall: ErrorStats & { maeCurrent: number | null; improvement: number };
    accepted: boolean;
    reason: string;
    seconds: number;
  };
};

export type TrainOptions = { gbdt?: Partial<GbdtParams>; log?: (m: string) => void };

const asMatrix = (s: MotionSampleSet) => ({ x: s.x, rows: s.rows, cols: s.cols });

export function predictRows(model: GbdtModel, s: MotionSampleSet): Float32Array {
  const out = new Float32Array(s.rows);
  for (let i = 0; i < s.rows; i++) out[i] = predictGbdt(model, s.x.subarray(i * s.cols, (i + 1) * s.cols));
  return out;
}

function p90(a: number[]): number {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.floor(0.9 * (s.length - 1))];
}

function stats(test: MotionSampleSet, pred: Float32Array, idx: number[]): ErrorStats {
  const em: number[] = [];
  const ef: number[] = [];
  let sm = 0;
  let sf = 0;
  let ss = 0;
  let bias = 0;
  for (const i of idx) {
    const y = test.y[i];
    const m = Math.abs(pred[i] - y);
    const f = Math.abs(test.fallback[i] - y);
    em.push(m);
    ef.push(f);
    sm += m;
    sf += f;
    ss += Math.abs(y);
    bias += pred[i] - y;
  }
  const n = Math.max(1, idx.length);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { n: idx.length, maeModel: r1(sm / n), maeFallback: r1(sf / n), maeStay: r1(ss / n), p90Model: Math.round(p90(em)), p90Fallback: Math.round(p90(ef)), biasModel: r1(bias / n) };
}

export function trainMotionModel(
  data: { train: MotionSampleSet; valid: MotionSampleSet; test: MotionSampleSet },
  profile: PackedProfile,
  current: MotionModelBundle | null,
  opts: TrainOptions = {},
): MotionModelBundle {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const features = [...MOTION_FEATURES];
  const model = trainGbdt(asMatrix(data.train), data.train.y, features, { ...MOTION_GBDT, ...opts.gbdt }, { m: asMatrix(data.valid), y: data.valid.y });
  log(`mozgás-modell: ${model.info.trees} fa, validációs veszteség ${model.info.validLoss?.toFixed(2)}`);

  const test = data.test;
  const pred = predictRows(model, test);
  const all = Array.from({ length: test.rows }, (_, i) => i);
  const groups: Record<string, ErrorStats> = {};
  for (const L of [...new Set(test.L)].sort((a, b) => a - b)) groups[`L${L}`] = stats(test, pred, all.filter((i) => test.L[i] === L));
  groups.standing = stats(test, pred, all.filter((i) => test.standing[i] === 1));
  groups.moving = stats(test, pred, all.filter((i) => test.standing[i] === 0));
  const overall = stats(test, pred, all);

  // Az élő modell ugyanezeken a sorokon (ha ugyanazokkal a jellemzőkkel tanult).
  let maeCurrent: number | null = null;
  if (current && isMotionBundle(current)) {
    const cur = predictRows(current.model, test);
    let s = 0;
    for (let i = 0; i < test.rows; i++) s += Math.abs(cur[i] - test.y[i]);
    maeCurrent = Math.round((s / Math.max(1, test.rows)) * 10) / 10;
  }
  let accepted = true;
  let reason = "jobb a tartaléknál";
  if (test.rows < MIN_TEST_ROWS) [accepted, reason] = [false, `kevés tesztsor (${test.rows})`];
  else if (overall.maeModel > overall.maeFallback * (1 - MIN_GAIN_VS_FALLBACK)) [accepted, reason] = [false, `nem jobb a profil-alapú tartaléknál (${overall.maeModel} vs ${overall.maeFallback} m)`];
  else if (maeCurrent != null && overall.maeModel > maeCurrent * (1 + MAX_LOSS_VS_CURRENT)) [accepted, reason] = [false, `rosszabb az élő modellnél (${overall.maeModel} vs ${maeCurrent} m)`];
  else if (maeCurrent != null) reason = `jobb a tartaléknál, és az élő modellnél sem rosszabb (${overall.maeModel} vs ${maeCurrent} m)`;

  return {
    v: 1,
    name: MOTION_MODEL_NAME,
    trainedAt: new Date().toISOString(),
    features,
    model,
    profile,
    report: {
      rows: { train: data.train.rows, valid: data.valid.rows, test: test.rows },
      days: { train: data.train.days, valid: data.valid.days, test: test.days },
      groups,
      overall: { ...overall, maeCurrent, improvement: overall.maeFallback ? Math.round((1000 * (overall.maeFallback - overall.maeModel)) / overall.maeFallback) / 10 : 0 },
      accepted,
      reason,
      seconds: Math.round((Date.now() - t0) / 1000),
    },
  };
}

/** Adatbázisból visszatöltött csomag ellenőrzése: sérült vagy más jellemzőkkel tanított modellt nem használunk. */
export function isMotionBundle(x: unknown): x is MotionModelBundle {
  if (!x || typeof x !== "object") return false;
  const b = x as MotionModelBundle;
  return (
    b.v === 1 &&
    b.name === MOTION_MODEL_NAME &&
    Array.isArray(b.features) &&
    b.features.length === MOTION_FEATURES.length &&
    b.features.every((f, i) => f === MOTION_FEATURES[i]) &&
    isGbdtModel(b.model) &&
    isPackedProfile(b.profile) &&
    !!b.report?.overall
  );
}

/** Szöveges táblázat a naplóhoz / parancssorhoz. */
export function formatMotionReport(b: MotionModelBundle): string {
  const r = b.report;
  const lines = [
    `tanítás: ${r.rows.train} sor (${r.days.train.length} nap) · validáció ${r.rows.valid} · teszt ${r.rows.test} (${r.days.test.join(", ")}) · ${r.seconds} mp`,
    "csoport        n    átlagos hiba (m): modell  tartalék  áll   |  p90: modell tartalék | torzítás",
  ];
  for (const [k, s] of [...Object.entries(r.groups), ["összesen", r.overall] as const]) {
    lines.push(`${k.padEnd(10)} ${String(s.n).padStart(7)}          ${s.maeModel.toFixed(1).padStart(6)}  ${s.maeFallback.toFixed(1).padStart(8)}  ${s.maeStay.toFixed(0).padStart(5)} |      ${String(s.p90Model).padStart(5)} ${String(s.p90Fallback).padStart(8)} | ${s.biasModel.toFixed(1)}`);
  }
  if (r.overall.maeCurrent != null) lines.push(`az élő modell ugyanezen: ${r.overall.maeCurrent} m`);
  lines.push(`${r.accepted ? "ELFOGADVA" : "ELUTASÍTVA"}: ${r.reason} (javulás a tartalékhoz képest: ${r.overall.improvement}%)`);
  return lines.join("\n");
}
