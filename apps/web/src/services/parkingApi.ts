import { API_BASE } from "@/lib/apiBase";

/* ---------------------------------------------------------------------------
   Parkoló (/engine/parking, élőben a `parking` WebSocket-témán). A worker
   `computeParking` kimenete; az időbélyegek unix másodpercek, a tippek
   `startS`-e a szolgáltatási nap kezdetéhez (`midnight`) képest értendő.
   ------------------------------------------------------------------------- */

export type FleetKind = "bus" | "tram";
export type DepotReason = "pull-in" | "seen" | "timeout" | "not-today";

export interface TripTip {
  tripId: string;
  route: string;
  startS: number;
  confidence: number;
  /** az MVK már kiadta neki (nem tipp) */
  certain: boolean;
}

export interface FleetHistory {
  id: string;
  kind: FleetKind;
  lastDate: string | null;
  streakDays: number;
  outShare: number | null;
  usualOutS: number | null;
  /** utolsó 14 nap a legrégebbitől tegnapig: "1" kint volt, "0" nem */
  recent: string;
  topRoutes: string[];
}

export interface ParkedVehicle {
  id: string;
  kind: FleetKind;
  since: number | null;
  lastSeen: number | null;
  online: boolean;
  lastRoute: string | null;
  lastHeadsign: string | null;
  arrivalDelayS: number | null;
  next: TripTip | null;
}

export interface DepotVehicle extends ParkedVehicle {
  reason: DepotReason;
  outToday: boolean;
}

export interface ServiceVehicle {
  id: string;
  kind: FleetKind;
  route: string | null;
  headsign: string | null;
  tripId: string | null;
  delayS: number | null;
  deadhead: boolean;
}

export interface KindCounts {
  service: number;
  terminus: number;
  depot: number;
  nosignal: number;
  total: number;
}

export interface TerminalLot {
  name: string;
  lat: number;
  lon: number;
  vehicles: ParkedVehicle[];
}

export interface DepotLot {
  id: FleetKind;
  name: string;
  vehicles: DepotVehicle[];
}

export interface ParkingSnapshot {
  at: number;
  serviceDate: string;
  midnight: number;
  limitS: number;
  counts: Record<FleetKind, KindCounts>;
  terminals: TerminalLot[];
  depots: DepotLot[];
  nosignal: (ParkedVehicle & { place: string | null })[];
  service: ServiceVehicle[];
  fleet: Record<string, FleetHistory>;
  /** Volán és vasút a megyén belüli végállomásokon (a Parkoló kapcsolójával látszik) */
  regional?: { terminals: TerminalLot[] };
}

export async function fetchParking(signal?: AbortSignal): Promise<ParkingSnapshot> {
  const res = await fetch(`${API_BASE}/engine/parking`, { signal, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `A parkoló most nem érhető el (HTTP ${res.status}).`);
  }
  return (await res.json()) as ParkingSnapshot;
}
