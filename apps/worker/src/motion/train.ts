/**
 * A mozgás-modell tanítása és kiértékelése.
 *
 *  1. gradient boosting: hol lesz a busz H mp-cel a fix után (m)  a térkép
 *     költségével (core `motion/cost`): ahol a busz megállhat, az előreszaladás
 *     (a jelölő megáll és kivár) sokkal drágább a lemaradásnál, egyenesben a
 *     kettő egyforma (medián)
 *  2. a SOSEM LÁTOTT tesztnapokon a térkép szemszögéből mérve (rögzített
 *     késleltetésekkel): modell vs. profil-alapú tartalék vs. az élő modell
 *  3. kapu: csak az él, ami ezen a költségen a tartaléknál bizonyítottan jobb,
 *     és nem rosszabb a mostani modellnél  különben a régi marad (a rendszer
 *     nem romolhat el)
 */
import { displayCosts, isGbdtModel, isPackedProfile, MOTION_FEATURES, predictGbdt, rowCost, trainGbdt, type GbdtModel, type GbdtParams, type PackedProfile, type RowCosts } from "@mvk/core";
import type { MotionSampleSet } from "./dataset.ts";

export const MOTION_MODEL_NAME = "motion";
/**
 * Mire tanult a modell. A régi (felirat nélküli) a medián volt; ha a kód
 * célja ennél újabb, induláskor hamar újratanul (nem vár éjszakáig).
 */
export const MOTION_OBJECTIVE = "display-cost-v1";
/** a modell csak legalább ennyivel kisebb költségnél veszi át a tartaléktól */
const MIN_GAIN_VS_FALLBACK = 0.05;
/** az élő modellnél legfeljebb ennyivel lehet rosszabb (zaj) */
const MAX_LOSS_VS_CURRENT = 0.01;
const MIN_TEST_ROWS = 5000;
/** ennél jobban a valóság előtt: „előreszaladt” (m) */
const AHEAD_M = 20;

export const MOTION_GBDT: Partial<GbdtParams> = { trees: 500, depth: 7, lr: 0.08, minLeaf: 80, subsample: 0.6, earlyStop: 25 };

export type ErrorStats = {
  n: number;
  maeModel: number;
  maeFallback: number;
  maeStay: number;
  p90Model: number;
  p90Fallback: number;
  biasModel: number;
  /** a térkép költsége soronként (m·mp): a tanítás célja, ezen dől el a kapu */
  costModel: number;
  costFallback: number;
  /** a sorok hány %-ában szaladt a becslés AHEAD_M-nél jobban a busz elé */
  aheadModel: number;
  aheadFallback: number;
};

export type MotionModelBundle = {
  v: 1;
  name: typeof MOTION_MODEL_NAME;
  /** a tanítás célja (lásd MOTION_OBJECTIVE); a régi, medián modellnél hiányzik */
  objective?: string;
  trainedAt: string;
  features: string[];
  model: GbdtModel;
  /** a tanult útprofil (az összes felhasznált napból)  ebből számol élesben */
  profile: PackedProfile;
  report: {
    rows: { train: number; valid: number; test: number };
    days: { train: string[]; valid: string[]; test: string[] };
    /** késleltetésenként (pl. „L5”) és állapotonként („standing” / „moving”) */
    groups: Record<string, ErrorStats>;
    overall: ErrorStats & { maeCurrent: number | null; costCurrent: number | null; improvement: number };
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

const r1 = (x: number) => Math.round(x * 10) / 10;

/** átlagos költség soronként (m·mp) */
function meanCost(test: MotionSampleSet, costs: RowCosts, pred: ArrayLike<number>, idx: readonly number[]): number {
  let s = 0;
  for (const i of idx) s += rowCost(costs.over[i], costs.under[i], test.y[i], pred[i]);
  return idx.length ? s / idx.length : 0;
}

function stats(test: MotionSampleSet, costs: RowCosts, pred: Float32Array, idx: number[]): ErrorStats {
  const em: number[] = [];
  const ef: number[] = [];
  let sm = 0;
  let sf = 0;
  let ss = 0;
  let bias = 0;
  let am = 0;
  let af = 0;
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
    if (pred[i] - y > AHEAD_M) am++;
    if (test.fallback[i] - y > AHEAD_M) af++;
  }
  const n = Math.max(1, idx.length);
  return {
    n: idx.length,
    maeModel: r1(sm / n),
    maeFallback: r1(sf / n),
    maeStay: r1(ss / n),
    p90Model: Math.round(p90(em)),
    p90Fallback: Math.round(p90(ef)),
    biasModel: r1(bias / n),
    costModel: Math.round(meanCost(test, costs, pred, idx)),
    costFallback: Math.round(meanCost(test, costs, test.fallback, idx)),
    aheadModel: r1((100 * am) / n),
    aheadFallback: r1((100 * af) / n),
  };
}

/** A sorok költsége a térkép szemszögéből (lemaradás / kivárás, lásd core `motion/cost`). */
export const costsOf = (s: MotionSampleSet): RowCosts => displayCosts(s.lag, s.pass);

export function trainMotionModel(
  data: { train: MotionSampleSet; valid: MotionSampleSet; test: MotionSampleSet },
  profile: PackedProfile,
  current: MotionModelBundle | null,
  opts: TrainOptions = {},
): MotionModelBundle {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const features = [...MOTION_FEATURES];
  const model = trainGbdt(asMatrix(data.train), data.train.y, features, { ...MOTION_GBDT, ...opts.gbdt }, { m: asMatrix(data.valid), y: data.valid.y, costs: costsOf(data.valid) }, costsOf(data.train));
  log(`mozgás-modell: ${model.info.trees} fa, validációs költség ${model.info.validLoss?.toFixed(1)} m·mp`);

  const test = data.test;
  const costs = costsOf(test);
  const pred = predictRows(model, test);
  const all = Array.from({ length: test.rows }, (_, i) => i);
  const groups: Record<string, ErrorStats> = {};
  for (const L of [...new Set(test.L)].sort((a, b) => a - b)) groups[`L${L}`] = stats(test, costs, pred, all.filter((i) => test.L[i] === L));
  groups.standing = stats(test, costs, pred, all.filter((i) => test.standing[i] === 1));
  groups.moving = stats(test, costs, pred, all.filter((i) => test.standing[i] === 0));
  const overall = stats(test, costs, pred, all);

  // Az élő modell ugyanezeken a sorokon, ugyanezzel a költséggel (ha ugyanazokkal a jellemzőkkel tanult).
  let maeCurrent: number | null = null;
  let costCurrent: number | null = null;
  if (current && isMotionBundle(current)) {
    const cur = predictRows(current.model, test);
    let s = 0;
    for (let i = 0; i < test.rows; i++) s += Math.abs(cur[i] - test.y[i]);
    maeCurrent = r1(s / Math.max(1, test.rows));
    costCurrent = Math.round(meanCost(test, costs, cur, all));
  }
  let accepted = true;
  let reason = "jobb a tartaléknál";
  if (test.rows < MIN_TEST_ROWS) [accepted, reason] = [false, `kevés tesztsor (${test.rows})`];
  else if (overall.costModel > overall.costFallback * (1 - MIN_GAIN_VS_FALLBACK)) [accepted, reason] = [false, `nem jobb a profil-alapú tartaléknál (költség ${overall.costModel} vs ${overall.costFallback})`];
  else if (costCurrent != null && overall.costModel > costCurrent * (1 + MAX_LOSS_VS_CURRENT)) [accepted, reason] = [false, `rosszabb az élő modellnél (költség ${overall.costModel} vs ${costCurrent})`];
  else if (costCurrent != null) reason = `jobb a tartaléknál, és az élő modellnél sem rosszabb (költség ${overall.costModel} vs ${costCurrent})`;

  return {
    v: 1,
    name: MOTION_MODEL_NAME,
    objective: MOTION_OBJECTIVE,
    trainedAt: new Date().toISOString(),
    features,
    model,
    profile,
    report: {
      rows: { train: data.train.rows, valid: data.valid.rows, test: test.rows },
      days: { train: data.train.days, valid: data.valid.days, test: test.days },
      groups,
      overall: {
        ...overall,
        maeCurrent,
        costCurrent,
        improvement: overall.costFallback ? Math.round((1000 * (overall.costFallback - overall.costModel)) / overall.costFallback) / 10 : 0,
      },
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
    "csoport        n    költség (m·mp): modell tartalék | átlagos hiba (m): modell tartalék  áll | p90: modell tartalék | torzítás | előreszaladt >20 m: modell tartalék",
  ];
  for (const [k, s] of [...Object.entries(r.groups), ["összesen", r.overall] as const]) {
    lines.push(
      `${k.padEnd(10)} ${String(s.n).padStart(7)}              ${String(s.costModel ?? "-").padStart(6)} ${String(s.costFallback ?? "-").padStart(8)} |` +
        `                   ${s.maeModel.toFixed(1).padStart(6)} ${s.maeFallback.toFixed(1).padStart(8)} ${s.maeStay.toFixed(0).padStart(4)} |` +
        `      ${String(s.p90Model).padStart(5)} ${String(s.p90Fallback).padStart(8)} | ${s.biasModel.toFixed(1).padStart(8)} |` +
        `                ${String(s.aheadModel ?? "-").padStart(5)}% ${String(s.aheadFallback ?? "-").padStart(7)}%`,
    );
  }
  if (r.overall.costCurrent != null) lines.push(`az élő modell ugyanezen: költség ${r.overall.costCurrent}, átlagos hiba ${r.overall.maeCurrent} m`);
  lines.push(`${r.accepted ? "ELFOGADVA" : "ELUTASÍTVA"}: ${r.reason} (javulás a tartalékhoz képest: ${r.overall.improvement}%)`);
  return lines.join("\n");
}
