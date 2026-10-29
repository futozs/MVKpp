/**
 * A késés-modell jellemzői — UGYANEZ a kód számolja a tanításkor (múltbeli
 * megálló-eseményekből) és élesben (a worker élő eseményeiből), így a kettő
 * nem csúszhat szét. A cél: a busz késése egy későbbi megállóban, a mostani
 * késéséhez képest (mennyit szed még fel / hoz be odáig).
 */

export const DELAY_FEATURES = [
  "d0", // mostani késés (mp)
  "ahead", // hány megállóval előre
  "schedAhead", // menetrend szerinti idő odáig (mp)
  "gain", // a szakaszok múltbeli többletidejének összege odáig (mp)
  "spread", // a szakaszok szórása odáig (mp)
  "baseline", // a képletes előrejelzés késésváltozása (mp)
  "hour", // napszak (tört óra, 24+ éjfél után)
  "daytype", // 0 munkanap · 1 szombat · 2 vasár- és ünnepnap
  "school", // tanítási nap
  "trend", // a busz késésének változása az utolsó ~3 megállón (mp)
  "leaderGain", // az előtte járó busz késésváltozása ugyanezen a szakaszon (mp)
  "leaderCover", // … a szakasz mekkora részén mérve (0–1)
  "leaderAge", // hány perce járt itt az előtte járó busz
  "recentExcess", // az elmúlt 30 percben a következő szakaszokon mért többletidő (mp/szakasz, bármely vonal)
  "recentN", // hány mérésből
  "precip", // 0 száraz · 1 eső · 2 hó
  "temp", // hőmérséklet (°C)
  "progress", // a menet hányadánál jár (0–1)
] as const;

export type DelayFeature = (typeof DELAY_FEATURES)[number];

export type DelayInput = {
  d0: number;
  ahead: number;
  schedAhead: number;
  gain: number;
  spread: number;
  baseline: number;
  hour: number;
  daytype: number;
  school: boolean;
  trend: number | null;
  leader: { gain: number; cover: number; ageMin: number } | null;
  recent: { excess: number; n: number } | null;
  precip: number | null;
  temp: number | null;
  progress: number;
};

const nz = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? NaN : v);

/** A jellemzővektor a `DELAY_FEATURES` sorrendjében (NaN = hiányzó). */
export function delayFeatureVector(inp: DelayInput, out = new Float32Array(DELAY_FEATURES.length)): Float32Array {
  out[0] = inp.d0;
  out[1] = inp.ahead;
  out[2] = inp.schedAhead;
  out[3] = inp.gain;
  out[4] = inp.spread;
  out[5] = inp.baseline;
  out[6] = inp.hour;
  out[7] = inp.daytype;
  out[8] = inp.school ? 1 : 0;
  out[9] = nz(inp.trend);
  out[10] = nz(inp.leader?.gain);
  out[11] = inp.leader ? inp.leader.cover : 0;
  out[12] = nz(inp.leader?.ageMin);
  out[13] = nz(inp.recent?.excess);
  out[14] = inp.recent?.n ?? 0;
  out[15] = nz(inp.precip);
  out[16] = nz(inp.temp);
  out[17] = inp.progress;
  return out;
}

/** WMO időjárás-kód → 0 száraz, 1 eső (szitálás, zápor, zivatar), 2 hó. */
export function precipClass(wmo: number | null | undefined): number | null {
  if (wmo == null || wmo < 0) return null;
  if ((wmo >= 71 && wmo <= 77) || wmo === 85 || wmo === 86) return 2;
  if ((wmo >= 51 && wmo <= 67) || (wmo >= 80 && wmo <= 82) || wmo >= 95) return 1;
  return 0;
}

/** Szakaszprofil-lekérdező: (honnan, hova, óra) → múltbeli menetidő medián / 85%. */
export type ProfileFn = (fromStop: string, toStop: string, hour: number) => { p50: number; p85: number } | undefined;

type StopLike = { stopId: string; arr: number; dep: number };

/**
 * A menet megállóin előre haladva a szakaszprofilokból összegzett többletidő
 * (medián − menetrend) és szórás: `gain[k]`, `spread[k]` a `fromIdx + k + 1`.
 * megállóig.
 */
export function profileAhead(stops: readonly StopLike[], fromIdx: number, profile: ProfileFn): { gain: number[]; spread: number[] } {
  const gain: number[] = [];
  const spread: number[] = [];
  let g = 0;
  let v = 0;
  for (let j = Math.max(0, fromIdx); j < stops.length - 1; j++) {
    const a = stops[j];
    const b = stops[j + 1];
    const hour = Math.floor((((a.dep % 86_400) + 86_400) % 86_400) / 3600);
    const p = profile(a.stopId, b.stopId, hour);
    if (p) {
      g += p.p50 - (b.arr - a.dep);
      v += (p.p85 - p.p50) ** 2;
    }
    gain.push(g);
    spread.push(Math.sqrt(v));
  }
  return { gain, spread };
}

/**
 * A nap menetei megállónként (idő, késés) — az előtte járó busz és a busz
 * saját késés-trendje innen jön. Tanításkor az egész nap előre betöltve, és
 * a lekérdezés csak a `atTs` előtti eseményeket látja; élesben folyamatosan töltődik.
 */
export class RunHistory {
  private runs = new Map<string, { pattern: string; at: Map<number, { ts: number; delay: number }> }>();
  private byPattern = new Map<string, string[]>();

  add(pattern: string, runKey: string, stopIdx: number, ts: number, delayS: number): void {
    let r = this.runs.get(runKey);
    if (!r) {
      r = { pattern, at: new Map() };
      this.runs.set(runKey, r);
      const list = this.byPattern.get(pattern) ?? [];
      list.push(runKey);
      this.byPattern.set(pattern, list);
    }
    r.at.set(stopIdx, { ts, delay: delayS });
  }

  clear(): void {
    this.runs.clear();
    this.byPattern.clear();
  }

  get size(): number {
    return this.runs.size;
  }

  /** A busz saját késésének változása az utolsó ~3 megállón (a `stopIdx` megállóig). */
  trend(runKey: string, stopIdx: number): number | null {
    const r = this.runs.get(runKey);
    const cur = r?.at.get(stopIdx);
    if (!r || !cur) return null;
    for (const back of [3, 4, 2, 1]) {
      const prev = r.at.get(stopIdx - back);
      if (prev && prev.ts <= cur.ts) return cur.delay - prev.delay;
    }
    return null;
  }

  /**
   * Az előtte járó busz (ugyanazon a nyomvonalon, legfeljebb `maxAgeS` mp-cel
   * korábban hagyta el a `fromIdx` megállót): mennyit változott a késése a
   * `fromIdx` és `toIdx` között — addig, ameddig `atTs`-ig eljutott.
   */
  leader(pattern: string, runKey: string, fromIdx: number, toIdx: number, atTs: number, maxAgeS = 2400): { gain: number; cover: number; ageMin: number } | null {
    let best: { from: { ts: number; delay: number }; at: Map<number, { ts: number; delay: number }> } | null = null;
    for (const key of this.byPattern.get(pattern) ?? []) {
      if (key === runKey) continue;
      const r = this.runs.get(key)!;
      const from = r.at.get(fromIdx);
      if (!from || from.ts > atTs || atTs - from.ts > maxAgeS) continue;
      if (!best || from.ts > best.from.ts) best = { from, at: r.at };
    }
    if (!best) return null;
    let reach = -1;
    let delay = best.from.delay;
    for (let k = toIdx; k > fromIdx; k--) {
      const e = best.at.get(k);
      if (e && e.ts <= atTs) {
        reach = k;
        delay = e.delay;
        break;
      }
    }
    if (reach < 0) return { gain: NaN, cover: 0, ageMin: (atTs - best.from.ts) / 60 };
    return { gain: delay - best.from.delay, cover: (reach - fromIdx) / Math.max(1, toIdx - fromIdx), ageMin: (atTs - best.from.ts) / 60 };
  }
}

/**
 * A közelmúlt forgalma: szakaszonként (honnan|hova) a frissen mért menetidők
 * többlete a szokásoshoz képest. Bármely vonal mérése számít — a dugó mindenkit lassít.
 */
export class RecentTraffic {
  private bySeg = new Map<string, { ts: number[]; excess: number[] }>();
  private sorted = true;

  add(fromStop: string, toStop: string, endTs: number, excessS: number): void {
    const k = `${fromStop}|${toStop}`;
    let s = this.bySeg.get(k);
    if (!s) this.bySeg.set(k, (s = { ts: [], excess: [] }));
    if (s.ts.length && endTs < s.ts[s.ts.length - 1]) this.sorted = false;
    s.ts.push(endTs);
    s.excess.push(excessS);
  }

  /** Tanításkor az egész nap betöltése után egyszer. */
  finalize(): void {
    if (this.sorted) return;
    for (const s of this.bySeg.values()) {
      const idx = s.ts.map((_, i) => i).sort((a, b) => s.ts[a] - s.ts[b]);
      s.ts = idx.map((i) => s.ts[i]);
      s.excess = idx.map((i) => s.excess[i]);
    }
    this.sorted = true;
  }

  /** Élesben: a régi mérések eldobása. */
  prune(beforeTs: number): void {
    for (const [k, s] of this.bySeg) {
      let i = 0;
      while (i < s.ts.length && s.ts[i] < beforeTs) i++;
      if (i === s.ts.length) this.bySeg.delete(k);
      else if (i) {
        s.ts = s.ts.slice(i);
        s.excess = s.excess.slice(i);
      }
    }
  }

  clear(): void {
    this.bySeg.clear();
  }

  /** Az adott szakaszokon az `atTs` előtti `windowS` mp mérései: átlagos többlet / szakasz. */
  query(segments: readonly (readonly [string, string])[], atTs: number, windowS = 1800): { excess: number; n: number } | null {
    let sum = 0;
    let n = 0;
    for (const [a, b] of segments) {
      const s = this.bySeg.get(`${a}|${b}`);
      if (!s) continue;
      // az utolsó atTs-nél nem későbbi mérés (bináris kereséssel)
      let lo = 0;
      let hi = s.ts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.ts[mid] <= atTs) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo - 1; i >= 0 && s.ts[i] >= atTs - windowS; i--) {
        sum += s.excess[i];
        n++;
      }
    }
    return n ? { excess: sum / n, n } : null;
  }
}

/** Ennyi szakaszt nézünk előre a „közelmúlt forgalma” jellemzőhöz. */
export const RECENT_SEGMENTS = 6;

/** A horizontok, amikre a modellt kiértékeljük és a kaput nyitjuk (megálló előre). */
export const HORIZON_BUCKETS = [
  { id: "1-3", from: 1, to: 3 },
  { id: "4-6", from: 4, to: 6 },
  { id: "7-10", from: 7, to: 10 },
  { id: "11-15", from: 11, to: 15 },
  { id: "16+", from: 16, to: 999 },
] as const;

export function horizonBucket(ahead: number): (typeof HORIZON_BUCKETS)[number]["id"] {
  for (const b of HORIZON_BUCKETS) if (ahead >= b.from && ahead <= b.to) return b.id;
  return "16+";
}

/** Napszakok (a modell-kapu horizont × napszak cellánként dönt). */
export const DAY_PERIODS = [
  { id: "hajnal", to: 6 },
  { id: "reggeli csúcs", to: 9 },
  { id: "napközben", to: 14 },
  { id: "délutáni csúcs", to: 18 },
  { id: "este", to: 99 },
] as const;

/** `hour`: a szolgáltatási nap kezdete óta (tört óra; 24+ éjfél után). */
export function dayPeriod(hour: number): (typeof DAY_PERIODS)[number]["id"] {
  const h = hour >= 24 ? hour - 24 : hour;
  for (const p of DAY_PERIODS) if (h < p.to) return p.id;
  return "este";
}

/** A kapu cellakulcsa: horizont | napszak. */
export const gateCell = (ahead: number, hour: number) => `${horizonBucket(ahead)}|${dayPeriod(hour)}`;
