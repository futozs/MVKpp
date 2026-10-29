export type TripRunState =
  | "cancelled"
  | "live"
  | "waiting"
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
  /**
   * Az élő jármű még a kiinduló megállóban áll: az MVK percekkel az indulás
   * előtt kiosztja a menetet, de attól még nem indult el.
   */
  waitingAtStart?: boolean;
}

export function tripRunState({
  cancelled,
  hasLiveVehicle,
  departureSec,
  arrivalSec,
  nowSec,
  day,
  waitingAtStart = false,
}: TripRunInput): TripRunState {
  if (day === "past") return "finished";
  if (day === "future") return "scheduled";
  if (cancelled) return "cancelled";
  if (hasLiveVehicle) return waitingAtStart ? "waiting" : "live";
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
    case "waiting":
      return vehicleId ? `Beállt · ${vehicleId}, indulásra vár` : "Beállt, indulásra vár";
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
