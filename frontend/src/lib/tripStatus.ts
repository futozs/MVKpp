export type TripRunState =
  | "cancelled"
  | "live"
  | "running"
  | "finished"
  | "scheduled"
  | "unknown";

export type DayRelation = "past" | "today" | "future";

export function dayRelation(iso: string, todayIso: string): DayRelation {
  return iso < todayIso ? "past" : iso > todayIso ? "future" : "today";
}

export interface TripRunInput {
  cancelled: boolean;
  hasLiveVehicle: boolean;
  departureSec: number;
  arrivalSec: number;
  nowSec: number;
  day: DayRelation;
}

export function tripRunState({
  cancelled,
  hasLiveVehicle,
  departureSec,
  arrivalSec,
  nowSec,
  day,
}: TripRunInput): TripRunState {
  if (day === "past") return "finished";
  if (day === "future") return "scheduled";
  if (cancelled) return "cancelled";
  if (hasLiveVehicle) return "live";
  if (nowSec > arrivalSec) return "finished";
  if (nowSec >= departureSec) return "running";
  return "scheduled";
}

export function showsJournalVehicle(state: TripRunState): boolean {
  return state === "running" || state === "finished";
}

export function tripRunLabel(
  state: TripRunState,
  vehicleId?: string | null,
): string | null {
  switch (state) {
    case "cancelled":
      return "Törölve";
    case "live":
      return vehicleId ? `Úton · ${vehicleId}` : "Úton";
    case "running":
      return vehicleId ? `Úton · ${vehicleId}` : "Nincs élő jel";
    case "finished":
      return vehicleId ? `Menet vége · ${vehicleId}` : "Menet vége";
    case "scheduled":
      return "Még nem indult el";
    default:
      return null;
  }
}

export function delayPastSentence(
  sec: number | null | undefined,
  kind: "start" | "end",
): string | null {
  if (sec == null) return null;
  const verb = kind === "start" ? "indult" : "ért be";
  const min = Math.round(Math.abs(sec) / 60);
  if (min < 1) return `Menetrend szerint ${verb}`;
  return sec > 0
    ? `${min} percet késve ${verb}`
    : `${min} perccel korábban ${verb}`;
}
