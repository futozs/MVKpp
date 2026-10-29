/**
 * Élő becslés a térképen: két GPS-jel (10–15 mp) között a busz a nyomvonalán
 * halad tovább a szakasz szokásos sebességével, legfeljebb a következő
 * megállóig — ott megvárja a következő jelet. Nem ír ki semmit, csak a
 * marker mozog folyamatosan, mint a valóságban.
 */
import type { LiveMotion } from "@/types";
import { API_BASE } from "@/lib/apiBase";

type Shape = { pts: [number, number][]; cum: number[] };

/** ennél régebbi jelnél nem találgatunk tovább */
const MAX_EXTRAPOLATE_S = 90;
/** kis visszaugrás (az új jel a becslés mögött van) helyett a busz megáll */
const HOLD_BACK_M = 40;
/** ekkora eltérésig a marker nem ugrik, hanem gyorsan odacsúszik (m) */
const EASE_MAX_M = 400;
/** egy rajzolási lépésben (250 ms) a hátralévő eltérés ekkora része */
const EASE_SHARE = 0.3;
/** ennyi eltérést egy lépésben lekövetünk — a sima haladás nem késik */
const EASE_MIN_STEP_M = 8;

const shapes = new Map<string, Shape | null>();
const loading = new Map<string, Promise<void>>();

/** sikertelen letöltés után ennyi idő múlva próbáljuk újra (ms) — egy hiba ne fagyassza le a buszokat */
const SHAPE_RETRY_MS = 30_000;
const retryAt = new Map<string, number>();

/** Nyomvonal betöltése (egyszer, gyorsítótárazva); `null`, amíg nincs meg. */
export function shapeFor(id: string): Shape | null {
  const hit = shapes.get(id);
  if (hit !== undefined) return hit;
  if (!loading.has(id) && (retryAt.get(id) ?? 0) <= Date.now()) {
    loading.set(
      id,
      fetch(`${API_BASE}/gtfs/shape?id=${encodeURIComponent(id)}`)
        .then((r) => {
          // 404: tényleg nincs ilyen nyomvonal (végleges); más hiba: később újra
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<Shape>;
        })
        .then((s) => void shapes.set(id, s && s.pts.length > 1 ? s : null))
        .catch(() => void retryAt.set(id, Date.now() + SHAPE_RETRY_MS))
        .finally(() => loading.delete(id)),
    );
  }
  return null;
}

function pointAt(shape: Shape, along: number): [number, number] {
  const { pts, cum } = shape;
  if (along <= 0) return pts[0];
  const last = cum.length - 1;
  if (along >= cum[last]) return pts[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const f = (along - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
}

/** az előzőleg kirajzolt hely; a pályakövetésnél a jelölő sebessége (m/s) és a rajzolás ideje is */
export type Shown = { shape: string; along: number; u?: number; at?: number };

/* Pályakövetés (a szerver `k` pályájával): a jelölő a várható pályát sima gyorsulással
   követi — a pálya sebessége előre, a hely-eltérés lágyan. A visszamérés szerint így
   nincs 90 km/h-s ugrás és tolatás (a régi utolérés a képkockák 4,5%-ában ugrott). */
/** a hely-eltérés ennyi idő alatt simul el (mp) */
const FOLLOW_TC_S = 2;
/** gyorsítás / fékezés korlátja (m/s²) — egy városi buszé */
const FOLLOW_ACC = 2;
const FOLLOW_DEC = 3;
const FOLLOW_VMAX = 22;
/** a pálya sebességét ennyivel előre nézzük, hogy időben fékezzen a megállóknál (mp) */
const FOLLOW_LEAD_S = 1;
/** ekkora eltérésnél (vagy hosszú szünet után) nem követünk, hanem odaugrunk */
const FOLLOW_SNAP_M = 300;
const FOLLOW_MAX_STEP_S = 5;

function trajAt(m: LiveMotion, k: [number, number][], nowServer: number): number {
  const dt = Math.min(MAX_EXTRAPOLATE_S, nowServer - m.t);
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

function follow(m: LiveMotion, k: [number, number][], nowServer: number, shown: Shown | undefined): Shown {
  const target = trajAt(m, k, nowServer);
  const vTraj = Math.max(0, trajAt(m, k, nowServer + FOLLOW_LEAD_S + 0.5) - trajAt(m, k, nowServer + FOLLOW_LEAD_S - 0.5));
  const step = shown?.at != null ? nowServer - shown.at : Infinity;
  if (!shown || shown.shape !== m.s || !(step > 0) || step > FOLLOW_MAX_STEP_S || Math.abs(target - shown.along) > FOLLOW_SNAP_M) {
    return { shape: m.s, along: target, u: vTraj, at: nowServer };
  }
  const want = Math.min(FOLLOW_VMAX, Math.max(0, vTraj + (target - shown.along) / FOLLOW_TC_S));
  const u0 = shown.u ?? vTraj;
  const u = Math.max(0, u0 + Math.min(FOLLOW_ACC * step, Math.max(-FOLLOW_DEC * step, want - u0)));
  return { shape: m.s, along: shown.along + u * step, u, at: nowServer };
}

/**
 * A busz becsült helye most. `shown` az előzőleg kirajzolt hely: a marker
 * nem ugrik vissza apró eltérésnél (a valóságban a busz nem tolat).
 */
export function estimatePosition(m: LiveMotion | null | undefined, nowServer: number, shown: Shown | undefined): { latlng: [number, number]; shown: Shown } | null {
  if (!m) return null;
  const shape = shapeFor(m.s);
  if (!shape) return null;
  if (m.k?.length) {
    const next = follow(m, m.k, nowServer, shown);
    return { latlng: pointAt(shape, next.along), shown: next };
  }
  const dt = Math.max(0, Math.min(MAX_EXTRAPOLATE_S, nowServer - m.t));
  let along = Math.min(m.a + m.v * dt, Math.max(m.a, m.e));
  if (shown && shown.shape === m.s) {
    const gap = along - shown.along;
    if (gap < 0 && -gap < HOLD_BACK_M) along = shown.along;
    // Új jelnél (előre vagy a becslés mögé) nem ugrik, hanem gyorsan odacsúszik.
    else if (Math.abs(gap) > EASE_MIN_STEP_M && Math.abs(gap) < EASE_MAX_M) along = shown.along + Math.sign(gap) * Math.max(EASE_MIN_STEP_M, Math.abs(gap) * EASE_SHARE);
  }
  return { latlng: pointAt(shape, along), shown: { shape: m.s, along } };
}
