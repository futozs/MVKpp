/**
 * A mozgás-modell jellemzői  UGYANEZ a kód számol a tanításkor (visszajátszott
 * napokból) és élesben (a worker élő fixeiből), így a kettő nem csúszhat szét.
 *
 * A cél: hol lesz a busz `H` másodperccel a legutóbbi fixe után (elmozdulás a
 * nyomvonalon, m), ha a térkép `L` másodperccel a fix után kapja meg az adatot.
 * Az `L` azért kell, mert a térkép addig mutatja a becslést, amíg a következő
 * fix meg nem érkezik: ha sokáig nem jön új jel, az maga is hír (az álló busz
 * ritkábban jelez).
 */
import { MOTION_BIN_M, STANDSTILL_MOVE_M, isStanding, typicalDisp, typicalTime, type MotionFix, type ShapeProfile } from "./profile.ts";

export const MOTION_FEATURES = [
  "H", // a fix óta eltelt idő, erre becslünk (mp)
  "L", // a fix ennyi idős volt, amikor a térkép megkapta (mp)
  "v", // GPS-sebesség a fixnél (m/s)
  "vPrev", // GPS-sebesség az előző fixnél
  "vAlong", // a nyomvonalon mért sebesség az előző fix óta (m/s)
  "vAlong2", // … az azt megelőző két fix között
  "dtPrev", // az előző fix óta eltelt idő (mp)
  "stoppedFor", // mióta áll (mp; 0, ha halad)
  "prior", // a profil szerinti elmozdulás H alatt (m)
  "priorHour", // … ugyanez a napszak profiljával
  "priorSpd100", // a profil sebessége a következő 100 m-en (m/s)
  "priorSpd400", // … a következő 400 m-en
  "stopHere", // itt a menetek hányad része áll meg (0–1)
  "dwellHere", // itt jellemzően meddig állnak (mp)
  "stopDist", // a következő megálló távolsága (m; a 30 m-en belül elhagyott még számít)
  "stopAhead200", // a következő 200 m legjellemzőbb megállási aránya
  "hotDist", // a következő gyakori megállási pont (lámpa, megálló) távolsága (m)
  "hour", // napszak (tört óra, 24+ éjfél után)
  "daytype", // 0 munkanap · 1 szombat · 2 vasár- és ünnepnap
  "endDist", // a végállomásig hátralévő út (m)
  "pace", // a busz tempója az utolsó ~2 percben a profilhoz képest (>1 = gyorsabb)
  "delay", // késés a menetrendhez képest (mp; a korán járó busz a megállókban várakozhat)
  "traffic", // az előtte járó buszok a következő 300 m-en: menetidő / profil (az utóbbi 20 percben)
  "trafficAge", // … a legfrissebb mérés kora (mp)
] as const;

/** a menet megállói a nyomvonalon, menetrendi időkkel (a szolgáltatási nap mp-e) */
export type MotionTrip = { along: readonly number[]; arr: readonly number[]; dep: readonly number[] };

export type MotionAnchor = {
  t: number;
  x: number;
  v: number;
  vPrev: number;
  vAlong: number;
  vAlong2: number;
  dtPrev: number;
  stoppedFor: number;
  hour: number;
  daytype: number;
  stopDist: number;
  endDist: number;
  /** a tempóhoz: ~2 perccel korábbi hely és az azóta eltelt idő */
  paceX: number;
  paceDt: number;
  delay: number;
  traffic: number;
  trafficAge: number;
};

const PACE_BACK_S = 120;
/** ennél nagyobb hézag után az előző fixek sebessége már nem a mostani mozgásról szól (mp) */
const MAX_GAP_S = 90;
/** a már elhagyott megálló ennyi méterig még „itt” van */
const STOP_BEHIND_M = 30;
/** ennyitől „gyakori megállási pont” egy rekesz */
const HOT_STOP_SHARE = 0.3;

const speed = (v: number) => (v >= 0 ? v : NaN);

/**
 * A busz állapota a menet `i`-edik fixénél (csak a korábbi fixekből).
 * `midnight`: a szolgáltatási nap helyi éjfele (unix).
 */
export function motionAnchor(f: readonly MotionFix[], i: number, trip: MotionTrip, midnight: number, daytype: number): MotionAnchor {
  const [t, x, v] = f[i];
  const p1 = i > 0 ? f[i - 1] : null;
  const p2 = i > 1 ? f[i - 2] : null;
  const dtPrev = p1 ? t - p1[0] : NaN;
  const vAlong = p1 && dtPrev > 0 && dtPrev <= MAX_GAP_S ? (x - p1[1]) / dtPrev : NaN;
  const vAlong2 = p1 && p2 && p1[0] - p2[0] > 0 && p1[0] - p2[0] <= MAX_GAP_S ? (p1[1] - p2[1]) / (p1[0] - p2[0]) : NaN;
  let stoppedFor = v < 0 ? NaN : 0;
  if (isStanding(v)) {
    let k = i;
    while (k > 0 && isStanding(f[k - 1][2]) && x - f[k - 1][1] < STANDSTILL_MOVE_M && f[k][0] - f[k - 1][0] <= 120) k--;
    stoppedFor = t - f[k][0];
  }
  let k = i;
  while (k > 0 && t - f[k - 1][0] <= PACE_BACK_S) k--;
  const stops = trip.along;
  let s = 0;
  while (s < stops.length && stops[s] < x - STOP_BEHIND_M) s++;
  // menetrend szerinti hely most (mint az illesztő liveDelay-e): a két szomszédos megálló között arányosan
  let delay = NaN;
  let j = 0;
  while (j < stops.length - 1 && stops[j + 1] <= x) j++;
  if (j < stops.length - 1) {
    const frac = stops[j + 1] > stops[j] ? Math.min(1, Math.max(0, (x - stops[j]) / (stops[j + 1] - stops[j]))) : 0;
    delay = t - (midnight + trip.dep[j] + (trip.arr[j + 1] - trip.dep[j]) * frac);
  }
  return {
    t,
    x,
    v: speed(v),
    vPrev: p1 ? speed(p1[2]) : NaN,
    vAlong,
    vAlong2,
    dtPrev,
    stoppedFor,
    hour: (t - midnight) / 3600,
    daytype,
    stopDist: s < stops.length ? stops[s] - x : NaN,
    endDist: stops.length ? stops[stops.length - 1] - x : NaN,
    paceX: k < i ? f[k][1] : NaN,
    paceDt: k < i ? t - f[k][0] : NaN,
    delay,
    traffic: NaN,
    trafficAge: NaN,
  };
}

/** Jellemzővektor egy (állapot, H, L) hármasra; `p` az egész napos, `ph` a napszak profilja (ha van). */
export function motionFeatures(a: MotionAnchor, H: number, L: number, p: ShapeProfile | undefined, ph: ShapeProfile | undefined, out: Float32Array): Float32Array {
  out[0] = H;
  out[1] = L;
  out[2] = a.v;
  out[3] = a.vPrev;
  out[4] = a.vAlong;
  out[5] = a.vAlong2;
  out[6] = a.dtPrev;
  out[7] = a.stoppedFor;
  out.fill(NaN, 8, 17);
  if (p) {
    out[8] = typicalDisp(p, a.x, H);
    out[10] = 100 / Math.max(1, typicalTime(p, a.x, a.x + 100));
    out[11] = 400 / Math.max(1, typicalTime(p, a.x, a.x + 400));
    const b = Math.floor(a.x / MOTION_BIN_M);
    const nb = p.stop.length;
    let here = 0;
    for (let k = -1; k <= 1; k++) if (b + k >= 0 && b + k < nb) here = Math.max(here, p.stop[b + k]);
    out[12] = here;
    out[13] = b < nb ? p.dwell[b] : NaN;
    let ahead = 0;
    let hot = NaN;
    for (let k = 1; k <= 30 && b + k < nb; k++) {
      const s = p.stop[b + k];
      if (k <= 10) ahead = Math.max(ahead, s);
      if (Number.isNaN(hot) && s >= HOT_STOP_SHARE) hot = (b + k + 0.5) * MOTION_BIN_M - a.x;
    }
    out[15] = ahead;
    out[16] = hot;
  }
  if (ph) out[9] = typicalDisp(ph, a.x, H);
  out[14] = a.stopDist;
  out[17] = a.hour;
  out[18] = a.daytype;
  out[19] = a.endDist;
  out[20] = p && a.paceDt > 0 && a.x - a.paceX >= 30 ? typicalTime(p, a.paceX, a.x) / a.paceDt : NaN;
  out[21] = a.delay;
  out[22] = a.traffic;
  out[23] = a.trafficAge;
  return out;
}
