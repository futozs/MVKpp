/**
 * A késés-modell tanítása és kiértékelése.
 *
 *  1. két kvantilis gradient boosting: medián (várható) és 85% (legrosszabb eset)
 *  2. a felső becslést a validációs napokon kalibráljuk (konform korrekció
 *     horizontonként), hogy tényleg ~85%-ban tartson
 *  3. a SOSEM LÁTOTT tesztnapokon összevetjük a mostani képlettel
 *  4. kapu: horizontonként csak ott használjuk a modellt, ahol mérhetően jobb
 */
import {
  DELAY_FEATURES,
  gateCell,
  HORIZON_BUCKETS,
  horizonBucket,
  isGbdtModel,
  predictGbdt,
  quantileOf,
  trainGbdt,
  type GbdtModel,
  type GbdtParams,
} from "@mvk/core";
import type { SampleSet } from "./dataset.ts";

export const DELAY_MODEL_NAME = "delay";
/** a felső becslés célzott lefedettsége */
export const UPPER_ALPHA = 0.85;
/** a modell csak legalább ennyivel kisebb átlagos hibánál veszi át a horizontot */
const MIN_GAIN = 0.03;
const MIN_TEST_ROWS = 150;

export type BucketReport = {
  n: number;
  /** átlagos abszolút hiba (mp): mostani képlet / modell / „marad a késés” */
  maeBaseline: number;
  maeModel: number;
  maePersist: number;
  /** a felső becslés lefedettsége (0–1) és átlagos szélessége (mp) */
  coverBaseline: number;
  coverModel: number;
  widthBaseline: number;
  widthModel: number;
  useMedian: boolean;
  useUpper: boolean;
};

/** horizont × napszak cella: itt is csak bizonyított javulásnál él a modell */
export type CellReport = { n: number; maeBaseline: number; maeModel: number; useMedian: boolean };

export type DelayModelBundle = {
  v: 1;
  name: typeof DELAY_MODEL_NAME;
  trainedAt: string;
  features: string[];
  median: GbdtModel;
  upper: GbdtModel;
  /** horizontonként a felső becsléshez adandó korrekció (mp) */
  upperShift: Record<string, number>;
  report: {
    rows: { train: number; valid: number; test: number };
    days: { train: string[]; valid: string[]; test: string[] };
    buckets: Record<string, BucketReport>;
    /** horizont × napszak (pl. „16+|reggeli csúcs”)  a medián kapuja cellánként */
    cells: Record<string, CellReport>;
    overall: { maeBaseline: number; maeModel: number; improvement: number };
    seconds: number;
  };
};

export type TrainOptions = { median?: Partial<GbdtParams>; upper?: Partial<GbdtParams>; log?: (m: string) => void };

const asMatrix = (s: SampleSet) => ({ x: s.x, rows: s.rows, cols: s.cols });

function predictAll(model: GbdtModel, s: SampleSet): Float32Array {
  const out = new Float32Array(s.rows);
  for (let i = 0; i < s.rows; i++) out[i] = predictGbdt(model, s.x.subarray(i * s.cols, (i + 1) * s.cols));
  return out;
}

export function trainDelayModel(data: { train: SampleSet; valid: SampleSet; test: SampleSet }, opts: TrainOptions = {}): DelayModelBundle {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const features = [...DELAY_FEATURES];
  const valid = { m: asMatrix(data.valid), y: data.valid.y };

  const median = trainGbdt(asMatrix(data.train), data.train.y, features, { alpha: 0.5, ...opts.median }, valid);
  log(`medián-modell: ${median.info.trees} fa, validációs veszteség ${median.info.validLoss?.toFixed(2)}`);
  const upper = trainGbdt(asMatrix(data.train), data.train.y, features, { alpha: UPPER_ALPHA, ...opts.upper }, valid);
  log(`felső modell: ${upper.info.trees} fa, validációs veszteség ${upper.info.validLoss?.toFixed(2)}`);

  // Konform kalibráció a validációs napokon: a felső becslés horizontonként annyit tolódik,
  // hogy a validáción pontosan 85%-ot fedjen le.
  const vMed = predictAll(median, data.valid);
  const vUp = predictAll(upper, data.valid);
  const upperShift: Record<string, number> = {};
  for (const b of HORIZON_BUCKETS) {
    const r: number[] = [];
    for (let i = 0; i < data.valid.rows; i++) {
      if (horizonBucket(data.valid.ahead[i]) !== b.id) continue;
      r.push(data.valid.y[i] - Math.max(vUp[i], vMed[i]));
    }
    upperShift[b.id] = r.length >= 50 ? Math.round(quantileOf(r, UPPER_ALPHA)) : 0;
  }

  const tMed = predictAll(median, data.test);
  const tUp = predictAll(upper, data.test);
  const acc = new Map<string, { n: number; eb: number; em: number; ep: number; cb: number; cm: number; wb: number; wm: number }>();
  for (const b of HORIZON_BUCKETS) acc.set(b.id, { n: 0, eb: 0, em: 0, ep: 0, cb: 0, cm: 0, wb: 0, wm: 0 });
  for (let i = 0; i < data.test.rows; i++) {
    const a = acc.get(horizonBucket(data.test.ahead[i]))!;
    const y = data.test.y[i];
    const up = Math.max(tUp[i] + upperShift[horizonBucket(data.test.ahead[i])], tMed[i]);
    a.n++;
    a.eb += Math.abs(y - data.test.baseline[i]);
    a.em += Math.abs(y - tMed[i]);
    a.ep += Math.abs(y);
    if (y <= data.test.baselineUpper[i]) a.cb++;
    if (y <= up) a.cm++;
    a.wb += data.test.baselineUpper[i] - data.test.baseline[i];
    a.wm += up - tMed[i];
  }

  // Cellánként (horizont × napszak) is: egy napszakban gyengébb modell ott ne vegye át.
  const cellAcc = new Map<string, { n: number; eb: number; em: number }>();
  for (let i = 0; i < data.test.rows; i++) {
    const k = gateCell(data.test.ahead[i], data.test.x[i * data.test.cols + 6]);
    const c = cellAcc.get(k) ?? { n: 0, eb: 0, em: 0 };
    c.n++;
    c.eb += Math.abs(data.test.y[i] - data.test.baseline[i]);
    c.em += Math.abs(data.test.y[i] - tMed[i]);
    cellAcc.set(k, c);
  }
  const cells: Record<string, CellReport> = {};
  for (const [k, c] of cellAcc) {
    const n = Math.max(1, c.n);
    cells[k] = { n: c.n, maeBaseline: Math.round(c.eb / n), maeModel: Math.round(c.em / n), useMedian: c.n >= MIN_TEST_ROWS && c.em < c.eb * (1 - MIN_GAIN) };
  }

  const buckets: Record<string, BucketReport> = {};
  let sb = 0;
  let sm = 0;
  let sn = 0;
  for (const [id, a] of acc) {
    const n = Math.max(1, a.n);
    const r: BucketReport = {
      n: a.n,
      maeBaseline: Math.round(a.eb / n),
      maeModel: Math.round(a.em / n),
      maePersist: Math.round(a.ep / n),
      coverBaseline: Math.round((1000 * a.cb) / n) / 1000,
      coverModel: Math.round((1000 * a.cm) / n) / 1000,
      widthBaseline: Math.round(a.wb / n),
      widthModel: Math.round(a.wm / n),
      useMedian: false,
      useUpper: false,
    };
    // Kapu: csak bizonyítottan jobb helyen vesszük át; a felső becslésnél a
    // 85%-hoz közelebbi lefedettség számít (és nem lehet sokkal szélesebb).
    r.useMedian = a.n >= MIN_TEST_ROWS && a.em < a.eb * (1 - MIN_GAIN);
    // Felső becslés: átvesszük, ha a 85%-hoz legalább olyan közel van (és nem sokkal
    // szélesebb), vagy ha egyszerre fed le legalább annyit ÉS szűkebb (egyértelműen jobb).
    const closer = Math.abs(r.coverModel - UPPER_ALPHA) <= Math.max(0.03, Math.abs(r.coverBaseline - UPPER_ALPHA)) && (r.widthModel <= r.widthBaseline * 1.15 || r.coverBaseline < 0.8);
    const dominates = r.coverModel >= r.coverBaseline - 0.01 && r.widthModel <= r.widthBaseline;
    r.useUpper = a.n >= MIN_TEST_ROWS && r.coverModel >= 0.8 && (closer || dominates);
    buckets[id] = r;
    sb += a.eb;
    sm += a.em;
    sn += a.n;
  }
  const maeBaseline = sn ? sb / sn : 0;
  const maeModel = sn ? sm / sn : 0;
  return {
    v: 1,
    name: DELAY_MODEL_NAME,
    trainedAt: new Date().toISOString(),
    features,
    median,
    upper,
    upperShift,
    report: {
      rows: { train: data.train.rows, valid: data.valid.rows, test: data.test.rows },
      days: { train: data.train.days, valid: data.valid.days, test: data.test.days },
      buckets,
      cells,
      overall: { maeBaseline: Math.round(maeBaseline), maeModel: Math.round(maeModel), improvement: maeBaseline ? Math.round((1000 * (maeBaseline - maeModel)) / maeBaseline) / 10 : 0 },
      seconds: Math.round((Date.now() - t0) / 1000),
    },
  };
}

/** Elfogadható-e a modell egyáltalán (legalább egy horizonton jobb). */
export function bundleAccepted(b: DelayModelBundle): boolean {
  return Object.values(b.report.buckets).some((r) => r.useMedian || r.useUpper);
}

/** Adatbázisból visszatöltött csomag ellenőrzése: sérült vagy más jellemzőkkel tanított modellt nem használunk. */
export function isDelayBundle(x: unknown): x is DelayModelBundle {
  if (!x || typeof x !== "object") return false;
  const b = x as DelayModelBundle;
  return (
    b.v === 1 &&
    b.name === DELAY_MODEL_NAME &&
    Array.isArray(b.features) &&
    b.features.length === DELAY_FEATURES.length &&
    b.features.every((f, i) => f === DELAY_FEATURES[i]) &&
    isGbdtModel(b.median) &&
    isGbdtModel(b.upper) &&
    !!b.report?.buckets &&
    !!b.report?.cells &&
    !!b.upperShift
  );
}

/** Szöveges táblázat a naplóhoz / parancssorhoz. */
export function formatReport(b: DelayModelBundle): string {
  const lines = [
    `tanítás: ${b.report.rows.train} sor (${b.report.days.train.length} nap) · validáció ${b.report.rows.valid} · teszt ${b.report.rows.test} (${b.report.days.test.join(", ")}) · ${b.report.seconds} mp`,
    "horizont   n      hiba: képlet  modell  marad | felső lefedettség: képlet  modell | szélesség: képlet modell | használjuk",
  ];
  for (const [id, r] of Object.entries(b.report.buckets)) {
    lines.push(
      `${id.padEnd(8)} ${String(r.n).padStart(6)}     ${String(r.maeBaseline).padStart(5)}  ${String(r.maeModel).padStart(6)}  ${String(r.maePersist).padStart(5)} |              ${(r.coverBaseline * 100).toFixed(1).padStart(5)}%  ${(r.coverModel * 100).toFixed(1).padStart(5)}% |   ${String(r.widthBaseline).padStart(5)} ${String(r.widthModel).padStart(5)}  | ${r.useMedian ? "medián" : "-"} ${r.useUpper ? "felső" : "-"}`,
    );
  }
  const weak = Object.entries(b.report.cells).filter(([, c]) => !c.useMedian);
  if (weak.length) lines.push(`képlet marad: ${weak.map(([k, c]) => `${k} (${c.maeBaseline}→${c.maeModel} mp)`).join(", ")}`);
  lines.push(`összesen: képlet ${b.report.overall.maeBaseline} mp → modell ${b.report.overall.maeModel} mp (${b.report.overall.improvement}% javulás)`);
  return lines.join("\n");
}
