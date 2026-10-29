/**
 * Forda-tervező: a most kint lévő buszok következő meneteinek becslése.
 *
 * Minden jármű onnan folytatja, ahol a mostani (vagy épp befejezett) menete
 * véget ér: a múltban tanult forda-kapcsolattal (melyik menet után melyik jön
 * ugyanazzal a busszal), ennek híján a végállomásról legközelebb induló
 * menettel. A buszok a szabaddá válásuk sorrendjében választanak (FIFO a
 * végállomáson), egy menetet csak egy busz kaphat, és a lánc órákra előre
 * kiterjed — így a még messze lévő menetekre is van jóslat.
 */
import { fastDistM } from "./geo.ts";

/** Egy még el nem indult menet a mai menetrendből. */
export type RotationSlot = {
  tripId: string;
  /** mintakulcs (`pattern@schedStartS`) — ezen tanulunk napokon át */
  key: string;
  route: string;
  startS: number;
  endS: number;
  lat: number;
  lon: number;
  endLat: number;
  endLon: number;
};

/** Egy jármű kiinduló állapota: mikor és hol válik szabaddá. */
export type RotationSeed = {
  vehicle: string;
  availS: number;
  lat: number;
  lon: number;
  /** a mostani/utolsó menet mintakulcsa (a tanult folytatáshoz) */
  key: string | null;
  route: string | null;
  /** nincs mai menete (garázsból / várakozásból indul) */
  idle: boolean;
};

/** mintakulcs → (következő mintakulcs → súlyozott gyakoriság) */
export type RotationLinks = Map<string, Map<string, number>>;

export type RotationVia = "chain" | "turnaround" | "terminal";
export type Rotation = { vehicle: string; confidence: number; hops: number; via: RotationVia };
export type RotationPlan = { byTrip: Map<string, Rotation>; byVehicle: Map<string, RotationSlot[]> };

export const ROTATION = {
  maxHops: 8,
  minConfidence: 0.15,
  /** a végállomás érkező és induló kocsiállása ennyire lehet egymástól */
  terminusRadiusM: 350,
  idleRadiusM: 400,
  /** ennyivel később induló menetet még elvihet ugyanazon a vonalon */
  maxLayoverS: 50 * 60,
  /** másik vonalra csak ennyi várakozáson belül szokás átállni */
  otherRouteLayoverS: 30 * 60,
  /** késve beérő busz ennyivel korábbi menetet még elvihet (késve indul) */
  lateSlackS: 180,
  /** a tanult folytatásnál nagyobb késés is belefér */
  chainLateSlackS: 600,
  chainMaxGapS: 3 * 3600,
  /** ennél ritkább tanult folytatást nem követünk */
  minChainShare: 0.25,
  /** ennél erősebb tanult folytatást előre lefoglalunk a busznak */
  reserveShare: 0.5,
} as const;

type Cursor = RotationSeed & { conf: number; hops: number; reservedTrip?: string };
type Pick = { slot: RotationSlot; factor: number; via: RotationVia; share?: number };

export function planRotations(slots: RotationSlot[], seeds: RotationSeed[], next: RotationLinks): RotationPlan {
  const sorted = [...slots].sort((a, b) => a.startS - b.startS);
  const byKey = new Map(sorted.map((s) => [s.key, s]));
  const taken = new Set<string>();
  const reserved = new Map<string, string>();
  const byTrip = new Map<string, Rotation>();
  const byVehicle = new Map<string, RotationSlot[]>();
  const ctx = { sorted, byKey, taken, reserved, next };

  const queue: Cursor[] = [];
  const enqueue = (c: Cursor) => {
    insertSorted(queue, c);
    const res = learnedNext(c, ctx);
    if (res && (res.share ?? 0) >= ROTATION.reserveShare && !reserved.has(res.slot.tripId)) {
      reserved.set(res.slot.tripId, c.vehicle);
      c.reservedTrip = res.slot.tripId;
    }
  };
  for (const s of seeds) enqueue({ ...s, conf: 1, hops: 0 });

  while (queue.length) {
    const cur = queue.shift()!;
    // A saját foglalás felszabadul: ha a busz mégsem ezt viszi, másé lehet.
    if (cur.reservedTrip && reserved.get(cur.reservedTrip) === cur.vehicle) reserved.delete(cur.reservedTrip);
    const pick = (cur.key ? learnedNext(cur, ctx) : null) ?? nearestDeparture(cur, ctx);
    if (!pick) continue;
    const conf = cur.conf * pick.factor;
    if (conf < ROTATION.minConfidence) continue;
    const { slot } = pick;
    taken.add(slot.tripId);
    byTrip.set(slot.tripId, { vehicle: cur.vehicle, confidence: Math.round(conf * 100) / 100, hops: cur.hops + 1, via: pick.via });
    byVehicle.set(cur.vehicle, [...(byVehicle.get(cur.vehicle) ?? []), slot]);
    if (cur.hops + 1 >= ROTATION.maxHops) continue;
    // Ha késve indul, a késés a menet végére is átöröklődik.
    const lateS = Math.max(0, cur.availS - slot.startS);
    enqueue({
      vehicle: cur.vehicle,
      availS: slot.endS + lateS,
      lat: slot.endLat,
      lon: slot.endLon,
      key: slot.key,
      route: slot.route,
      idle: false,
      conf,
      hops: cur.hops + 1,
    });
  }
  return { byTrip, byVehicle };
}

type Ctx = {
  sorted: RotationSlot[];
  byKey: Map<string, RotationSlot>;
  taken: Set<string>;
  reserved: Map<string, string>;
  next: RotationLinks;
};

const freeFor = (slot: RotationSlot, vehicle: string, ctx: Ctx) => {
  if (ctx.taken.has(slot.tripId)) return false;
  const owner = ctx.reserved.get(slot.tripId);
  return !owner || owner === vehicle;
};

/** A múltban leggyakrabban ezután jövő, még szabad menet. */
function learnedNext(cur: Cursor, ctx: Ctx): Pick | null {
  const links = cur.key ? ctx.next.get(cur.key) : undefined;
  if (!links?.size) return null;
  let total = 0;
  for (const n of links.values()) total += n;
  const ranked = [...links.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, n] of ranked) {
    const share = n / total;
    if (share < ROTATION.minChainShare) break;
    const slot = ctx.byKey.get(key);
    if (!slot || !freeFor(slot, cur.vehicle, ctx)) continue;
    if (slot.startS < cur.availS - ROTATION.chainLateSlackS || slot.startS > cur.availS + ROTATION.chainMaxGapS) continue;
    return { slot, factor: 0.6 + 0.35 * share, via: "chain", share };
  }
  return null;
}

/** A busz helyéhez legközelebb, legkorábban induló szabad menet (azonos vonal előnyben). */
function nearestDeparture(cur: Cursor, ctx: Ctx): Pick | null {
  const radius = cur.idle ? ROTATION.idleRadiusM : ROTATION.terminusRadiusM;
  const from = cur.availS - ROTATION.lateSlackS;
  let same: RotationSlot | null = null;
  let other: RotationSlot | null = null;
  for (let i = lowerBound(ctx.sorted, from); i < ctx.sorted.length; i++) {
    const s = ctx.sorted[i];
    if (s.startS > cur.availS + ROTATION.maxLayoverS) break;
    if (!freeFor(s, cur.vehicle, ctx)) continue;
    if (fastDistM(cur.lat, cur.lon, s.lat, s.lon) > radius) continue;
    if (cur.route && s.route === cur.route) {
      same = s;
      break;
    }
    if (!other && s.startS <= cur.availS + ROTATION.otherRouteLayoverS) other = s;
  }
  if (same) return { slot: same, factor: cur.idle ? 0.6 : 0.8, via: cur.idle ? "terminal" : "turnaround" };
  if (other) return { slot: other, factor: cur.idle ? 0.45 : 0.55, via: cur.idle ? "terminal" : "turnaround" };
  return null;
}

function lowerBound(sorted: RotationSlot[], startS: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].startS < startS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(queue: Cursor[], c: Cursor) {
  let i = queue.length;
  while (i > 0 && queue[i - 1].availS > c.availS) i--;
  queue.splice(i, 0, c);
}
