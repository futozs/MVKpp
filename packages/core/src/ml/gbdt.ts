/**
 * Kvantilis gradient boosting (hisztogramos döntési fák), külső függőség nélkül.
 *
 * Pinball-veszteséget minimalizál a megadott `alpha` kvantilisre: alpha = 0,5
 * a medián (várható érték), 0,85 a „legrosszabb esetben” felső becslés.
 * A fák a negatív gradiensre illeszkednek (négyzetes hasítási nyereség), a
 * levelek értéke pedig a levélbe esett maradékok alpha-kvantilise (Friedman).
 *
 * Soronkénti költséggel (`RowCosts`) a veszteség aszimmetrikus és soronként
 * más: méterenként `over[i]`, ha a becslés a valóság fölé lő, `under[i]`, ha
 * alá. (A soronkénti alpha önmagában nem elég: egy levélen belül csak az
 * átlaga számítana  a két költség aránya és nagysága együtt viszi az infót.)
 *
 * Gyorsítás: a jellemzők legfeljebb 255 rekeszbe kerülnek (+1 a hiányzó
 * értéknek), a hisztogramot csak a kisebbik gyerekre építjük, a nagyobbikét
 * kivonással kapjuk. A hiányzó érték (NaN) mindkét irányba kipróbálva megy.
 */

export type GbdtParams = {
  /** a becsült kvantilis (0–1) */
  alpha: number;
  /** legfeljebb ennyi fa */
  trees: number;
  /** fa-mélység */
  depth: number;
  /** tanulási ráta */
  lr: number;
  /** egy levélbe legalább ennyi sor */
  minLeaf: number;
  /** soronkénti mintavétel fánként (0–1) */
  subsample: number;
  /** ennyi fa óta nem javult a validációs veszteség → leáll */
  earlyStop: number;
  /** rekeszek száma jellemzőnként (≤ 255) */
  bins: number;
  /** véletlenmag (a mintavétel ismételhető legyen) */
  seed: number;
};

export const GBDT_DEFAULTS: GbdtParams = {
  alpha: 0.5,
  trees: 400,
  depth: 6,
  lr: 0.08,
  minLeaf: 40,
  subsample: 0.7,
  earlyStop: 30,
  bins: 255,
  seed: 7,
};

/** Egy fa csúcsai lapos tömbökben: levélnél `feature` = -1. */
export type GbdtTree = { feature: number[]; threshold: number[]; missingLeft: boolean[]; left: number[]; right: number[]; value: number[] };

export type GbdtModel = {
  v: 1;
  alpha: number;
  base: number;
  features: string[];
  trees: GbdtTree[];
  /** tanítási napló: fák száma, tanító / validációs veszteség */
  info: { trees: number; trainLoss: number; validLoss: number | null; rows: number };
};

/** Sor-folytonos jellemzőmátrix: `x[i * cols + f]`. NaN = hiányzó. */
export type Matrix = { x: Float32Array; rows: number; cols: number };

export function pinball(alpha: number, y: number, q: number): number {
  const r = y - q;
  return r >= 0 ? alpha * r : (alpha - 1) * r;
}

/** Soronkénti költség méterenként: ha a becslés a valóság fölé (`over`) / alá (`under`) lő. */
export type RowCosts = { over: Float32Array; under: Float32Array };

/** A költséges veszteség egy sorra: `y` a valóság, `q` a becslés. */
export function rowCost(over: number, under: number, y: number, q: number): number {
  return q > y ? over * (q - y) : under * (y - q);
}

/**
 * A költségekkel súlyozott kvantilis: a sorba rendezett értékek közül az első,
 * ahol a fölé lövés határköltsége (az addigiak `over`-e) eléri az alá lövésé
 * (a többiek `under`-e). Rendezés nélkül, súlyozott gyorskiválasztással
 * (átlagosan O(n))  a fák minden levelénél lefut.
 */
export function costQuantile(values: ArrayLike<number>, over: ArrayLike<number>, under: ArrayLike<number>): number {
  const n = values.length;
  if (!n) return 0;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  let lo = 0;
  let hi = n;
  /** a tartománytól balra lévők `over`-e és a jobbra lévők `under`-e */
  let leftOver = 0;
  let rightUnder = 0;
  for (;;) {
    const p = values[idx[(lo + hi) >> 1]];
    // háromfelé osztás: [lo, lt) < p, [lt, gt) = p, [gt, hi) > p
    let lt = lo;
    let gt = hi;
    let k = lo;
    while (k < gt) {
      const v = values[idx[k]];
      if (v < p) {
        const t = idx[lt];
        idx[lt++] = idx[k];
        idx[k++] = t;
      } else if (v > p) {
        const t = idx[--gt];
        idx[gt] = idx[k];
        idx[k] = t;
      } else k++;
    }
    let oL = 0;
    let uE = 0;
    let oE = 0;
    let uG = 0;
    for (let j = lo; j < lt; j++) oL += over[idx[j]];
    for (let j = lt; j < gt; j++) {
      oE += over[idx[j]];
      uE += under[idx[j]];
    }
    for (let j = gt; j < hi; j++) uG += under[idx[j]];
    if (lt > lo && leftOver + oL >= uE + uG + rightUnder) {
      // a határ a kisebbek között van
      rightUnder += uE + uG;
      hi = lt;
    } else if (leftOver + oL + oE >= uG + rightUnder || gt === hi) return p;
    else {
      leftOver += oL + oE;
      lo = gt;
    }
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tömb alpha-kvantilise (helyben részlegesen rendez). */
export function quantileOf(values: Float64Array | Float32Array | number[], alpha: number): number {
  const n = values.length;
  if (!n) return 0;
  const a = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = alpha * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Jellemzőnkénti rekeszhatárok kvantilisek szerint (egy mintából). */
function binEdges(m: Matrix, bins: number, rnd: () => number): Float64Array[] {
  const sampleN = Math.min(m.rows, 200_000);
  const edges: Float64Array[] = [];
  for (let f = 0; f < m.cols; f++) {
    const vals: number[] = [];
    for (let k = 0; k < sampleN; k++) {
      const i = sampleN === m.rows ? k : Math.floor(rnd() * m.rows);
      const v = m.x[i * m.cols + f];
      if (!Number.isNaN(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (let q = 1; q < bins; q++) {
      if (!vals.length) break;
      const v = vals[Math.min(vals.length - 1, Math.floor((q * vals.length) / bins))];
      if (!uniq.length || v > uniq[uniq.length - 1]) uniq.push(v);
    }
    edges.push(Float64Array.from(uniq));
  }
  return edges;
}

/** Érték → rekesz: 0 = hiányzó, 1..k+1 (x ≤ edges[b-1] → b). */
function binOf(edges: Float64Array, v: number): number {
  if (Number.isNaN(v)) return 0;
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v <= edges[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

type Split = { gain: number; feature: number; bin: number; missingLeft: boolean };

/**
 * Tanítás. `valid` megadásával korai leállás: a legjobb validációs veszteségű
 * fa-számnál vágjuk el a modellt. `costs` megadásával (és a validációs sorok
 * `costs`-ával) a soronkénti költséges veszteséget minimalizálja  `alpha` ekkor
 * nem számít.
 */
export function trainGbdt(
  train: Matrix,
  y: Float32Array,
  features: string[],
  params: Partial<GbdtParams> = {},
  valid?: { m: Matrix; y: Float32Array; costs?: RowCosts },
  costs?: RowCosts,
): GbdtModel {
  const p = { ...GBDT_DEFAULTS, ...params };
  const { rows: n, cols } = train;
  if (cols !== features.length) throw new Error("a jellemzők száma nem egyezik");
  if (costs && (costs.over.length !== n || costs.under.length !== n)) throw new Error("a költségek száma nem egyezik a sorokéval");
  if (costs && valid && valid.costs?.over.length !== valid.m.rows) throw new Error("a validációs sorokhoz is kell költség");
  const lossOf = (c: RowCosts | undefined, i: number, yi: number, q: number) => (c ? rowCost(c.over[i], c.under[i], yi, q) : pinball(p.alpha, yi, q));
  const rnd = mulberry32(p.seed);
  const edges = binEdges(train, Math.min(255, p.bins), rnd);
  const nb = edges.map((e) => e.length + 2);
  const maxBins = Math.max(...nb);

  // Oszlop-folytonos rekeszek: a hisztogram-építés így gyorsítótár-barát.
  const binned: Uint8Array[] = [];
  for (let f = 0; f < cols; f++) {
    const col = new Uint8Array(n);
    const e = edges[f];
    for (let i = 0; i < n; i++) col[i] = binOf(e, train.x[i * cols + f]);
    binned.push(col);
  }

  const base = costs ? costQuantile(y, costs.over, costs.under) : quantileOf(y, p.alpha);
  const pred = new Float64Array(n).fill(base);
  const grad = new Float64Array(n);
  const resid = new Float64Array(n);
  const validPred = valid ? new Float64Array(valid.m.rows).fill(base) : null;
  const trees: GbdtTree[] = [];
  let best = { loss: Infinity, trees: 0 };
  /** fánként a tanító veszteség (a korai leállásnál a megtartott fa-számhoz) */
  const trainLosses: number[] = [];
  const rows = new Uint32Array(n);
  const histSum = (bins: number) => new Float64Array(cols * bins);

  for (let t = 0; t < p.trees; t++) {
    // Sormintavétel (sztochasztikus gradient boosting).
    let m = 0;
    for (let i = 0; i < n; i++) if (p.subsample >= 1 || rnd() < p.subsample) rows[m++] = i;
    for (let k = 0; k < m; k++) {
      const i = rows[k];
      resid[i] = y[i] - pred[i];
      // negatív gradiens (költségnél a pontosan eltalált sor nem húz sehova: sok álló busz pont 0 m-t tesz meg)
      if (costs) grad[i] = resid[i] > 0 ? costs.under[i] : resid[i] < 0 ? -costs.over[i] : 0;
      else grad[i] = resid[i] >= 0 ? p.alpha : p.alpha - 1;
    }

    const tree: GbdtTree = { feature: [], threshold: [], missingLeft: [], left: [], right: [], value: [] };
    const newNode = () => {
      tree.feature.push(-1);
      tree.threshold.push(0);
      tree.missingLeft.push(false);
      tree.left.push(-1);
      tree.right.push(-1);
      tree.value.push(0);
      return tree.feature.length - 1;
    };

    const buildHist = (start: number, end: number) => {
      const g = histSum(maxBins);
      const c = histSum(maxBins);
      for (let f = 0; f < cols; f++) {
        const col = binned[f];
        const off = f * maxBins;
        for (let k = start; k < end; k++) {
          const i = rows[k];
          const b = off + col[i];
          g[b] += grad[i];
          c[b] += 1;
        }
      }
      return { g, c };
    };

    const bestSplit = (h: { g: Float64Array; c: Float64Array }, total: number, gSum: number): Split | null => {
      let bestS: Split | null = null;
      const parentScore = (gSum * gSum) / total;
      for (let f = 0; f < cols; f++) {
        const off = f * maxBins;
        const gMiss = h.g[off];
        const cMiss = h.c[off];
        let gl = 0;
        let cl = 0;
        for (let b = 1; b < nb[f] - 1; b++) {
          gl += h.g[off + b];
          cl += h.c[off + b];
          for (const missLeft of [false, true]) {
            const GL = missLeft ? gl + gMiss : gl;
            const CL = missLeft ? cl + cMiss : cl;
            const CR = total - CL;
            if (CL < p.minLeaf || CR < p.minLeaf) continue;
            const GR = gSum - GL;
            const gain = (GL * GL) / CL + (GR * GR) / CR - parentScore;
            if (gain > 1e-9 && (!bestS || gain > bestS.gain)) bestS = { gain, feature: f, bin: b, missingLeft: missLeft };
            if (cMiss === 0) break; // hiányzó érték nélkül a két irány ugyanaz
          }
        }
      }
      return bestS;
    };

    const leafValue = (start: number, end: number) => {
      const r = new Float64Array(end - start);
      for (let k = start; k < end; k++) r[k - start] = resid[rows[k]];
      if (!costs) return p.lr * quantileOf(r, p.alpha);
      const over = new Float64Array(end - start);
      const under = new Float64Array(end - start);
      for (let k = start; k < end; k++) {
        over[k - start] = costs.over[rows[k]];
        under[k - start] = costs.under[rows[k]];
      }
      return p.lr * costQuantile(r, over, under);
    };

    const grow = (node: number, start: number, end: number, depth: number, h: { g: Float64Array; c: Float64Array }) => {
      const total = end - start;
      let gSum = 0;
      for (let k = start; k < end; k++) gSum += grad[rows[k]];
      const s = depth < p.depth && total >= 2 * p.minLeaf ? bestSplit(h, total, gSum) : null;
      if (!s) {
        tree.value[node] = leafValue(start, end);
        return;
      }
      // Helyben szétválogatás: balra a rekesz ≤ s.bin (+ hiányzó, ha balra megy).
      const col = binned[s.feature];
      let lo = start;
      let hi = end - 1;
      while (lo <= hi) {
        const b = col[rows[lo]];
        const goLeft = b === 0 ? s.missingLeft : b <= s.bin;
        if (goLeft) lo++;
        else {
          const tmp = rows[lo];
          rows[lo] = rows[hi];
          rows[hi] = tmp;
          hi--;
        }
      }
      const mid = lo;
      tree.feature[node] = s.feature;
      tree.threshold[node] = edges[s.feature][s.bin - 1] ?? Infinity;
      tree.missingLeft[node] = s.missingLeft;
      const l = newNode();
      const r = newNode();
      tree.left[node] = l;
      tree.right[node] = r;
      // A kisebbik gyerek hisztogramja épül, a nagyobbiké kivonással.
      const leftSmaller = mid - start <= end - mid;
      const small = leftSmaller ? buildHist(start, mid) : buildHist(mid, end);
      const big = { g: h.g.slice(), c: h.c.slice() };
      for (let k = 0; k < big.g.length; k++) {
        big.g[k] -= small.g[k];
        big.c[k] -= small.c[k];
      }
      grow(l, start, mid, depth + 1, leftSmaller ? small : big);
      grow(r, mid, end, depth + 1, leftSmaller ? big : small);
    };

    const root = newNode();
    grow(root, 0, m, 0, buildHist(0, m));
    trees.push(tree);

    // Előrejelzés frissítése minden soron (a nem mintavételezetteken is).
    let trainLoss = 0;
    for (let i = 0; i < n; i++) {
      pred[i] += treeValue(tree, train.x, i * cols);
      trainLoss += lossOf(costs, i, y[i], pred[i]);
    }
    trainLosses.push(trainLoss / n);
    if (valid && validPred) {
      let vl = 0;
      const vc = valid.m.cols;
      for (let i = 0; i < valid.m.rows; i++) {
        validPred[i] += treeValue(tree, valid.m.x, i * vc);
        vl += lossOf(costs ? valid.costs : undefined, i, valid.y[i], validPred[i]);
      }
      vl /= Math.max(1, valid.m.rows);
      if (vl < best.loss - 1e-6) best = { loss: vl, trees: trees.length };
      else if (trees.length - best.trees >= p.earlyStop) break;
    }
    if (!valid) best = { loss: trainLoss / n, trees: trees.length };
  }

  const kept = trees.slice(0, best.trees || trees.length);
  const trainLoss = trainLosses[kept.length - 1] ?? NaN;
  return {
    v: 1,
    alpha: p.alpha,
    base,
    features: [...features],
    trees: kept,
    info: { trees: kept.length, trainLoss, validLoss: valid ? best.loss : null, rows: n },
  };
}

function treeValue(tree: GbdtTree, x: ArrayLike<number>, off: number): number {
  let node = 0;
  for (;;) {
    const f = tree.feature[node];
    if (f < 0) return tree.value[node];
    const v = x[off + f];
    const left = Number.isNaN(v) ? tree.missingLeft[node] : v <= tree.threshold[node];
    node = left ? tree.left[node] : tree.right[node];
  }
}

function predictRow(model: Pick<GbdtModel, "base" | "trees">, x: ArrayLike<number>, off: number): number {
  let s = model.base;
  for (const t of model.trees) s += treeValue(t, x, off);
  return s;
}

/** Egy sor előrejelzése (a jellemzők a modell `features` sorrendjében, NaN = hiányzó). */
export function predictGbdt(model: GbdtModel, x: ArrayLike<number>): number {
  return predictRow(model, x, 0);
}

/** Egy JSON-ból visszatöltött modell szerkezeti ellenőrzése (sérült modellt nem használunk). */
export function isGbdtModel(m: unknown): m is GbdtModel {
  if (!m || typeof m !== "object") return false;
  const g = m as GbdtModel;
  if (g.v !== 1 || !Number.isFinite(g.base) || !Array.isArray(g.trees) || !Array.isArray(g.features)) return false;
  return g.trees.every((t) => {
    const n = t?.feature?.length ?? -1;
    if (n < 1 || [t.threshold, t.missingLeft, t.left, t.right, t.value].some((a) => !Array.isArray(a) || a.length !== n)) return false;
    for (let i = 0; i < n; i++) {
      if (t.feature[i] >= 0 && (t.left[i] <= i || t.right[i] <= i || t.left[i] >= n || t.right[i] >= n || t.feature[i] >= g.features.length)) return false;
    }
    return true;
  });
}
