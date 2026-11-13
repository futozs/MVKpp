/**
 * Utazás közben a telefon GPS-e a pontos hely: annak a busznak a jelölője,
 * amelyiken utazol, nem a becslést követi, hanem a telefont (a nyomvonalra
 * vetítve)  a követés és a térkép többi része ugyanaz marad. Csak addig, amíg
 * a telefon tényleg a buszon van: friss és pontos a helyzete, a nyomvonalon
 * van, és a busz saját jeleivel is összeillik (leszállás után a busz elhúz,
 * a telefon lemarad → újra a becslés mozgatja). A helyzet a telefonon marad.
 */
import type { LiveMotion } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import type { MotionPath } from "./motionFollow";

export type ShapeLine = { pts: [number, number][]; cum: number[] };

/** ennél régebbi telefonos helyzetet nem használunk (ms) */
const GPS_MAX_AGE_MS = 6000;
/** ennél pontatlanabb GPS-t nem használunk (m) */
const GPS_MAX_ACCURACY_M = 40;
/** ennél messzebb a nyomvonaltól a telefon nem ezen a buszon van (m) */
const OFF_ROUTE_M = 45;
/** a busz legutóbbi jele mögött legfeljebb ennyivel lehet (m): leszállás után a busz elhúz */
const BEHIND_FIX_M = 40;
/** a busz legutóbbi jele óta legfeljebb ekkora tempóval juthatott előre (m/s), plusz tűrés (m) */
const AHEAD_MAX_SPEED = 25;
const AHEAD_SLACK_M = 80;
/** a nyomvonalon a várható hely körül ennyin belül keressük a telefont (m) */
const SEARCH_M = 600;
/** hurkos nyomvonalon: méterenként ennyit „büntet” a várható helytől való távolság (m/m) */
const ALONG_PENALTY = 0.1;
/** két GPS-helyzet között legfeljebb ennyi ideig visszük előre a telefon sebességével (mp) */
const EXTRAPOLATE_S = 2;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

function firstAtOrAfter(cum: number[], along: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < along) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A pont vetülete a nyomvonalra a `near` hely környékén: hol tart rajta (m), és milyen messze van tőle (m).
 * Ha a nyomvonal kétszer is elhalad ott (hurok), a várható helyhez közelebbi szakaszt választja.
 */
export function projectOnShape(shape: ShapeLine, lat: number, lon: number, near: number): { along: number; dist: number } | null {
  const { pts, cum } = shape;
  if (pts.length < 2) return null;
  const kx = M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180);
  const from = Math.max(0, firstAtOrAfter(cum, near - SEARCH_M) - 1);
  const to = Math.min(pts.length - 1, firstAtOrAfter(cum, near + SEARCH_M) + 1);
  let best: { along: number; dist: number } | null = null;
  let bestScore = Infinity;
  for (let i = from; i < to; i++) {
    const ax = (pts[i][1] - lon) * kx;
    const ay = (pts[i][0] - lat) * M_PER_DEG_LAT;
    const bx = (pts[i + 1][1] - lon) * kx;
    const by = (pts[i + 1][0] - lat) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const dist = Math.hypot(ax + f * dx, ay + f * dy);
    const along = cum[i] + f * (cum[i + 1] - cum[i]);
    const score = dist + ALONG_PENALTY * Math.abs(along - near);
    if (score < bestScore) {
      bestScore = score;
      best = { along, dist };
    }
  }
  return best;
}

/**
 * A telefon helyzetéből pálya a jelölőnek (ugyanaz a követő viszi, mint a
 * becslést  így a váltás sem ugrik), vagy `null`, ha most nem a telefon a
 * pontosabb. `near`: ahol a becslés szerint a busz most jár.
 */
export function onboardPath(gps: GeoPosition, shape: ShapeLine, m: LiveMotion, near: number, nowServer: number, nowMs = Date.now()): MotionPath | null {
  const ageMs = nowMs - gps.at;
  if (!(ageMs >= -1000 && ageMs <= GPS_MAX_AGE_MS) || !(gps.accuracyM <= GPS_MAX_ACCURACY_M)) return null;
  const hit = projectOnShape(shape, gps.lat, gps.lon, near);
  if (!hit || hit.dist > OFF_ROUTE_M) return null;
  const t = nowServer - Math.max(0, ageMs) / 1000;
  const sinceFix = Math.max(0, t - m.t);
  if (hit.along < m.a - BEHIND_FIX_M || hit.along > m.a + AHEAD_MAX_SPEED * sinceFix + AHEAD_SLACK_M) return null;
  const end = shape.cum[shape.cum.length - 1];
  const v = gps.speed != null && Number.isFinite(gps.speed) ? Math.min(AHEAD_MAX_SPEED, Math.max(0, gps.speed)) : 0;
  return { s: m.s, t, k: [[hit.along, 0], [Math.min(end, hit.along + v * EXTRAPOLATE_S), EXTRAPOLATE_S]] };
}
