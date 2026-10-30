/**
 * Élő mozgásbecslés a térképnek: minden új jelnél a busz várható pályája
 * (`k`: [hely a nyomvonalon (m), idő a fix óta (mp)]) a tanított modellből.
 *
 * Folyamatosan önellenőriz: minden új fix „leosztályozza” az előző fixből
 * számolt pályát (a térkép szemszögéből: hol mutattuk volna, hol volt
 * valójában). A modell és a profil-alapú tartalék is számol (árnyékban), és ha
 * a modell élesben tartósan rosszabb, magától a tartalékra vált — amíg újra
 * jobb nem lesz. Éjszaka a friss napokból újratanul (lásd thread.ts).
 */
import {
  dayInfo,
  fallbackDisp,
  hourClassOf,
  isStanding,
  localMidnightUnix,
  MOTION_FEATURES,
  MOTION_GRID,
  motionAnchor,
  motionFeatures,
  motionTrajectory,
  predictGbdt,
  StretchTraffic,
  unpackProfile,
  type GbdtModel,
  type MotionFix,
  type MotionTrip,
  type RoadProfile,
  type VehicleMotion,
} from "@mvk/core";
import type { Engine } from "../engine.ts";
import { errMsg, log } from "../log.ts";
import { loadMotionBundle } from "./store.ts";
import type { MotionModelBundle } from "./train.ts";

type Path = [number, number][];
type RunState = { shapeId: string; fixes: MotionFix[]; lastAt: number };
/** egy fixből számolt pálya: a modellé és a tartaléké (árnyékban), a számításkori késleltetéssel */
type Computed = { t: number; L: number; model: Path; fallback: Path; standing: boolean };

/** menetenként ennyi fixet tartunk meg (a tempó ~2 percet néz vissza) */
const KEEP_FIXES = 16;
/** ennyi csend után a menetet elengedjük (mp) */
const RUN_IDLE_S = 30 * 60;
/** a pálya ennyi mp-ig tart (lásd MOTION_GRID); a térkép utána a végén marad */
const MAX_PATH_S = 90;
/** az élő pontszám ennyi legutóbbi mérésből */
const SCORE_WINDOW = 3000;
/** ennyi mérés kell a váltáshoz, és ennyi új mérésenként döntünk */
const GATE_MIN = 1000;
const GATE_EVERY = 200;
/** a modell ennyivel rosszabb élesben → tartalék; ennyivel jobb → vissza a modellre */
const DEGRADE_RATIO = 1.05;
const RESTORE_RATIO = 0.97;

/** Körpuffer az utolsó N hibához (m, előjeles). */
class Ring {
  private a = new Float32Array(SCORE_WINDOW);
  private i = 0;
  n = 0;
  push(v: number) {
    this.a[this.i] = v;
    this.i = (this.i + 1) % SCORE_WINDOW;
    this.n = Math.min(SCORE_WINDOW, this.n + 1);
  }
  mae(): number {
    let s = 0;
    for (let k = 0; k < this.n; k++) s += Math.abs(this.a[k]);
    return this.n ? s / this.n : NaN;
  }
  bias(): number {
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.a[k];
    return this.n ? s / this.n : NaN;
  }
  p90(): number {
    if (!this.n) return NaN;
    const s = Float32Array.from(this.a.subarray(0, this.n), Math.abs).sort();
    return s[Math.floor(0.9 * (this.n - 1))];
  }
}

/** A pálya helye `h` mp-cel a fix után. */
function pathAt(k: Path, h: number): number {
  const dt = Math.min(MAX_PATH_S, h);
  if (dt <= k[0][1]) return k[0][0];
  for (let i = 1; i < k.length; i++) {
    if (dt <= k[i][1]) {
      const [a0, t0] = k[i - 1];
      const [a1, t1] = k[i];
      return t1 > t0 ? a0 + ((a1 - a0) * (dt - t0)) / (t1 - t0) : a1;
    }
  }
  return k[k.length - 1][0];
}

const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

export class MotionPredictor {
  private engine: Engine;
  private model: GbdtModel | null = null;
  private profile: RoadProfile | null = null;
  private info: Pick<MotionModelBundle, "trainedAt" | "report"> | null = null;
  private runs = new Map<string, RunState>();
  private traffic = new StretchTraffic();
  /** menetenként a legutóbbi fixből számolt pálya */
  private computed = new Map<string, Computed>();
  /** … amíg a következő fix le nem pontozza (a térkép ezt mutatta) */
  private scorable = new Map<string, Computed>();
  private trips = new Map<string, MotionTrip>();
  private buf = new Float32Array(MOTION_FEATURES.length);
  private mode: "model" | "fallback" = "model";
  private sinceGate = 0;
  private score = { model: new Ring(), fallback: new Ring(), standing: new Ring(), moving: new Ring() };
  private switches: { at: string; to: "model" | "fallback"; maeModel: number; maeFallback: number }[] = [];
  stats = { trajectories: 0, scored: 0, errors: 0 };

  constructor(engine: Engine) {
    this.engine = engine;
    // Az indításkori visszajátszás fixei is ide futnak: újraindítás után a menetek előzménye és a forgalom is megvan.
    engine.on("fix", (vehicleId, ts, speed) => {
      try {
        this.onFix(vehicleId, ts, speed);
      } catch (e) {
        this.stats.errors++;
        if (this.stats.errors < 5) log.warn("motion", "fix-feldolgozási hiba", errMsg(e));
      }
    });
  }

  /** A legfrissebb elfogadott modell betöltése (hiba esetén a régi marad, vagy a hub saját becslése). */
  async load(): Promise<void> {
    try {
      const b = await loadMotionBundle();
      if (!b) {
        log.info("motion", "még nincs elfogadott mozgás-modell — a térkép a régi becsléssel megy");
        return;
      }
      this.model = b.model;
      this.profile = unpackProfile(b.profile);
      this.info = { trainedAt: b.trainedAt, report: b.report };
      this.computed.clear();
      log.info("motion", `mozgás-modell betöltve (${b.trainedAt}; teszten ${b.report.overall.maeModel} m átlagos hiba, a tartalék ${b.report.overall.maeFallback} m)`);
    } catch (e) {
      log.warn("motion", "a mozgás-modell nem töltődött be", errMsg(e));
    }
  }

  hasModel(): boolean {
    return this.model != null;
  }

  private onFix(vehicleId: string, ts: number, speed: number | null) {
    const m = this.engine.matcher.motion(vehicleId);
    // Csak az illesztő által a saját idején elfogadott jel fix (ugyanaz a szabály, mint a tanításkor).
    if (!m || m.ts !== ts) return;
    const key = `${m.tripId}|${vehicleId}`;
    const fix: MotionFix = [ts, m.alongM, speed ?? -1];
    this.scoreAgainst(key, fix);
    let r = this.runs.get(key);
    if (!r) this.runs.set(key, (r = { shapeId: m.shapeId, fixes: [], lastAt: ts }));
    r.fixes.push(fix);
    if (r.fixes.length > KEEP_FIXES) r.fixes.shift();
    r.lastAt = ts;
    const p = this.profile?.all.get(m.shapeId);
    if (p) this.traffic.addFix(m.shapeId, key, fix, p.pace.length);
  }

  /** Az előző fixből mutatott pálya pontozása az új fixszel. */
  private scoreAgainst(key: string, fix: MotionFix) {
    const s = this.scorable.get(key);
    if (!s || fix[0] <= s.t) return;
    this.scorable.delete(key);
    const h = fix[0] - s.t;
    // a térkép a fix megérkezése (t + L) után mutatta; a pálya vége után nem pontozunk
    if (h < s.L || h > MAX_PATH_S) return;
    const em = pathAt(s.model, h) - fix[1];
    const ef = pathAt(s.fallback, h) - fix[1];
    this.score.model.push(em);
    this.score.fallback.push(ef);
    (s.standing ? this.score.standing : this.score.moving).push(em);
    this.stats.scored++;
    if (++this.sinceGate >= GATE_EVERY) {
      this.sinceGate = 0;
      this.gate();
    }
  }

  /** Ha a modell élesben tartósan rosszabb a tartaléknál, átvált (és vissza, ha újra jobb). */
  private gate() {
    if (this.score.model.n < GATE_MIN) return;
    const mm = this.score.model.mae();
    const mf = this.score.fallback.mae();
    const to = this.mode === "model" && mm > mf * DEGRADE_RATIO ? "fallback" : this.mode === "fallback" && mm < mf * RESTORE_RATIO ? "model" : null;
    if (!to) return;
    this.mode = to;
    this.switches.push({ at: new Date().toISOString(), to, maeModel: Math.round(mm * 10) / 10, maeFallback: Math.round(mf * 10) / 10 });
    if (this.switches.length > 20) this.switches.shift();
    log.warn("motion", `élő pontszám: modell ${mm.toFixed(1)} m, tartalék ${mf.toFixed(1)} m → ${to === "fallback" ? "a TARTALÉK becsül" : "újra a modell becsül"}`);
  }

  private tripOf(serviceDate: string, tripId: string): MotionTrip | null {
    const key = `${serviceDate}|${tripId}`;
    let t = this.trips.get(key);
    if (!t) {
      const a = this.engine.feeds.cachedDay(serviceDate)?.feed.tripStopsAlong(tripId);
      if (!a?.length) return null;
      if (this.trips.size > 5000) this.trips.clear();
      this.trips.set(key, (t = { along: a.map((s) => s.alongM), arr: a.map((s) => s.arr), dep: a.map((s) => s.dep) }));
    }
    return t;
  }

  /**
   * A busz várható pályája a legutóbbi fixe óta. `now`: a szerver órája (a
   * térkép ennyivel később kapja meg a fixet → a modell ezt is figyelembe veszi).
   * `null`, ha nincs modell vagy előzmény — ekkor a hub a régi becslést adja.
   */
  trajectory(vehicleId: string, m: VehicleMotion, serviceDate: string, now: number): Path | null {
    try {
      return this.compute(vehicleId, m, serviceDate, now);
    } catch (e) {
      // a hub minden járműre hívja: egy hiba ne állítsa meg a többit (a régi becslés marad)
      this.stats.errors++;
      if (this.stats.errors < 5) log.warn("motion", "pálya-számítási hiba", errMsg(e));
      return null;
    }
  }

  private compute(vehicleId: string, m: VehicleMotion, serviceDate: string, now: number): Path | null {
    if (!this.model || !this.profile) return null;
    const key = `${m.tripId}|${vehicleId}`;
    const r = this.runs.get(key);
    const last = r?.fixes.length ? r.fixes.length - 1 : -1;
    if (!r || last < 0 || r.fixes[last][0] !== m.ts) return null;
    // Fixenként egyszer számolunk (amikor megérkezett): a később csatlakozó kliens ugyanazt a pályát kapja,
    // mint a többiek — és egy tömeges újracsatlakozás sem terheli a fő szálat.
    const hit = this.computed.get(key);
    if (hit && hit.t === m.ts) return this.mode === "model" ? hit.model : hit.fallback;
    const L = Math.max(0, now - m.ts);
    const trip = this.tripOf(serviceDate, m.tripId);
    if (!trip) return null;
    const a = motionAnchor(r.fixes, last, trip, localMidnightUnix(serviceDate), dayInfo(serviceDate).daytype);
    const p = this.profile.all.get(m.shapeId);
    const ph = this.profile.byClass[hourClassOf(a.hour)]?.get(m.shapeId);
    const q = this.traffic.query(m.shapeId, a.x, a.t, p, key);
    a.traffic = q.ratio;
    a.trafficAge = q.age;
    const end = trip.along[trip.along.length - 1];
    const model = this.model;
    const dm = MOTION_GRID.map((h) => (h === 0 ? 0 : predictGbdt(model, motionFeatures(a, h, L, p, ph, this.buf))));
    const df = MOTION_GRID.map((h) => fallbackDisp(a, h, p));
    if (dm.some((x) => !Number.isFinite(x))) return null;
    const c: Computed = { t: m.ts, L, model: motionTrajectory(m.alongM, dm, end), fallback: motionTrajectory(m.alongM, df, end), standing: isStanding(a.v) };
    this.computed.set(key, c);
    this.scorable.set(key, c);
    this.stats.trajectories++;
    return this.mode === "model" ? c.model : c.fallback;
  }

  /** Percenként: a régóta hallgató menetek elengedése. */
  prune(now: number): void {
    for (const [k, r] of this.runs) {
      if (now - r.lastAt <= RUN_IDLE_S) continue;
      this.runs.delete(k);
      this.computed.delete(k);
      this.scorable.delete(k);
    }
    this.traffic.prune(now);
  }

  status() {
    const s = this.score;
    return {
      model: this.info ? { trainedAt: this.info.trainedAt, test: this.info.report.overall, days: this.info.report.days } : null,
      mode: this.model ? this.mode : "legacy",
      live: {
        n: s.model.n,
        maeModel: r1(s.model.mae()),
        maeFallback: r1(s.fallback.mae()),
        p90Model: r1(s.model.p90()),
        p90Fallback: r1(s.fallback.p90()),
        biasModel: r1(s.model.bias()),
        standing: { n: s.standing.n, mae: r1(s.standing.mae()) },
        moving: { n: s.moving.n, mae: r1(s.moving.mae()) },
      },
      switches: this.switches,
      runs: this.runs.size,
      trafficRuns: this.traffic.size(),
      stats: this.stats,
    };
  }
}
