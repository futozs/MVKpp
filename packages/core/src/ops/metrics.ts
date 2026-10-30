/**
 * Válaszidő-mérés kulcsonként (útvonal, MVK-végpont): percenkénti vödrök, az
 * utolsó egy óra memóriában. A rendszer-hub ebből mutat p50/p95/p99-et,
 * hibaarányt és percenkénti idősort — külön tároló nélkül, folyamatonként.
 */

/** hisztogram-határok (ms); az utolsó vödör a „lassabb mindennél” */
const EDGES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];
const KEEP_MIN = 60;
const MAX_KEYS = 300;
const OTHER_KEY = "(egyéb)";

type Minute = { t: number; n: number; err: number; sum: number; max: number; hist: number[] };
type Series = { minutes: Minute[]; last: { at: number; status: number; ms: number } | null; codes: Record<string, number> };

export type MetricStat = {
  key: string;
  count: number;
  errors: number;
  perMin: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  last: { at: number; status: number; ms: number } | null;
  /** állapotkód-osztályok az ablakban: 2xx / 3xx / 4xx / 5xx / err */
  codes: Record<string, number>;
  /** percenként: [perc kezdete (ms), kérések, átlag ms] — a hub idősorához */
  series: [number, number, number][];
};

const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60_000;
const codeClass = (status: number) => (status <= 0 ? "err" : `${Math.floor(status / 100)}xx`);

function quantile(hist: number[], total: number, q: number): number {
  if (total === 0) return 0;
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i];
    if (acc + n >= target) {
      const lo = i === 0 ? 0 : EDGES_MS[i - 1];
      const hi = EDGES_MS[i] ?? EDGES_MS[EDGES_MS.length - 1] * 2;
      const frac = n === 0 ? 0 : (target - acc) / n;
      return Math.round(lo + (hi - lo) * frac);
    }
    acc += n;
  }
  return EDGES_MS[EDGES_MS.length - 1];
}

export class RouteMetrics {
  private series = new Map<string, Series>();

  record(rawKey: string, ms: number, status: number): void {
    const key = this.series.has(rawKey) || this.series.size < MAX_KEYS ? rawKey : OTHER_KEY;
    let s = this.series.get(key);
    if (!s) {
      s = { minutes: [], last: null, codes: {} };
      this.series.set(key, s);
    }
    const now = Date.now();
    const t = minuteOf(now);
    let m = s.minutes[s.minutes.length - 1];
    if (!m || m.t !== t) {
      m = { t, n: 0, err: 0, sum: 0, max: 0, hist: new Array(EDGES_MS.length + 1).fill(0) };
      s.minutes.push(m);
      const cutoff = t - KEEP_MIN * 60_000;
      while (s.minutes.length && s.minutes[0].t < cutoff) s.minutes.shift();
    }
    const failed = status <= 0 || status >= 500;
    m.n++;
    if (failed) m.err++;
    m.sum += ms;
    m.max = Math.max(m.max, ms);
    const b = EDGES_MS.findIndex((e) => ms <= e);
    m.hist[b === -1 ? EDGES_MS.length : b]++;
    s.last = { at: now, status, ms: Math.round(ms) };
    const c = codeClass(status);
    s.codes[c] = (s.codes[c] ?? 0) + 1;
  }

  /** Az utolsó `windowMin` perc összesítése kulcsonként, a legtöbbet hívottal elöl. */
  snapshot(windowMin = 15): MetricStat[] {
    const from = minuteOf(Date.now()) - (windowMin - 1) * 60_000;
    const out: MetricStat[] = [];
    for (const [key, s] of this.series) {
      const mins = s.minutes.filter((m) => m.t >= from);
      if (!mins.length) continue;
      const hist = new Array(EDGES_MS.length + 1).fill(0);
      let n = 0;
      let err = 0;
      let sum = 0;
      let max = 0;
      for (const m of mins) {
        n += m.n;
        err += m.err;
        sum += m.sum;
        max = Math.max(max, m.max);
        m.hist.forEach((v, i) => (hist[i] += v));
      }
      out.push({
        key,
        count: n,
        errors: err,
        perMin: Math.round((n / windowMin) * 10) / 10,
        avgMs: n ? Math.round(sum / n) : 0,
        // a vödrön belüli becslés ne lépje túl a ténylegesen mért maximumot
        p50Ms: Math.min(quantile(hist, n, 0.5), Math.ceil(max)),
        p95Ms: Math.min(quantile(hist, n, 0.95), Math.ceil(max)),
        p99Ms: Math.min(quantile(hist, n, 0.99), Math.ceil(max)),
        maxMs: Math.round(max),
        last: s.last,
        codes: { ...s.codes },
        series: mins.map((m) => [m.t, m.n, m.n ? Math.round(m.sum / m.n) : 0]),
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }
}
