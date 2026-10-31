/**
 * Élő becslés a térképen: két GPS-jel (10–20 mp) között a busz a szerver
 * pályáján (`k`) halad — ezt a tanított mozgás-modell adja (hol tart a busz a
 * jel óta eltelt idő múlva: megállók, lámpák, a mai forgalom). Nem ír ki
 * semmit, csak a marker mozog folyamatosan, mint a valóságban, és sosem tolat.
 * Amelyik buszon épp utazol, azt a telefonod GPS-e viszi (lásd `onboard`).
 */
import type { LiveMotion } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { API_BASE } from "@/lib/apiBase";
import { followPath, pathAt, type Shown } from "./motionFollow";
import { onboardPath, type ShapeLine } from "./onboard";

export type { Shown };

type Shape = ShapeLine;

/** ennél régebbi jelnél nem találgatunk tovább */
const MAX_EXTRAPOLATE_S = 90;
/** ekkora eltérésig a marker nem ugrik, hanem odacsúszik — vagy (ha előrébb jár) megvárja a buszt (m) */
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

/**
 * A busz becsült helye most. `shown` az előzőleg kirajzolt hely: új jelnél a
 * marker nem ugrik, hanem odasiklik, vagy ha előrébb jár, megvárja a buszt
 * (lásd `motionFollow`). `onboard`: a telefon helyzete, ha épp ezen a buszon utazol.
 */
export function estimatePosition(
  m: LiveMotion | null | undefined,
  nowServer: number,
  shown: Shown | undefined,
  onboard?: GeoPosition | null,
): { latlng: [number, number]; shown: Shown } | null {
  if (!m) return null;
  const shape = shapeFor(m.s);
  if (!shape) return null;
  const path = m.k?.length ? { s: m.s, t: m.t, k: m.k } : null;
  if (onboard) {
    const near = shown?.shape === m.s ? shown.along : path ? pathAt(path, nowServer) : m.a;
    const gps = onboardPath(onboard, shape, m, near, nowServer);
    if (gps) {
      const next = followPath(gps, nowServer, shown);
      return { latlng: pointAt(shape, next.along), shown: next };
    }
  }
  if (path) {
    const next = followPath(path, nowServer, shown);
    return { latlng: pointAt(shape, next.along), shown: next };
  }
  const dt = Math.max(0, Math.min(MAX_EXTRAPOLATE_S, nowServer - m.t));
  let along = Math.min(m.a + m.v * dt, Math.max(m.a, m.e));
  if (shown && shown.shape === m.s) {
    const gap = along - shown.along;
    // Nem tolat: ha az új jel a becslés mögött van, a busz megáll és kivárja (csak durva hibánál ugrik vissza).
    if (gap < 0 && -gap < EASE_MAX_M) along = shown.along;
    // Új jelnél előre nem ugrik, hanem gyorsan odacsúszik.
    else if (gap > EASE_MIN_STEP_M && gap < EASE_MAX_M) along = shown.along + Math.max(EASE_MIN_STEP_M, gap * EASE_SHARE);
  }
  return { latlng: pointAt(shape, along), shown: { shape: m.s, along } };
}
