/**
 * Egy menetrendi menet aktuális állapota.
 *
 * A menetrendkönyv korábban binárisan gondolkodott: van élő jármű → „elindult",
 * nincs → „nem indult el". Ez a délelőtti, RÉG LEFUTOTT menetekre is azt
 * állította, hogy el sem indultak. Az indulási és érkezési idő ismeretében
 * ennél pontosabban lehet fogalmazni.
 */
export type TripRunState =
  /** Az MVK kihúzta: ma nem közlekedik. */
  | "cancelled"
  /** Éppen úton van, élő járműjellel. */
  | "live"
  /** A menetrendi ablakában jár, de nincs (már) élő jele. */
  | "running"
  /** A végállomáson befejeződött — ez a menet ma már lefutott. */
  | "finished"
  /** Még nem indult el. */
  | "scheduled"
  /** Nem eldönthető (hiányzó menetrendi idő). */
  | "unknown";

/** A nézett nap viszonya a maihoz — enélkül a múltbeli napokat is „jövőnek" néznénk. */
export type DayRelation = "past" | "today" | "future";

export function dayRelation(iso: string, todayIso: string): DayRelation {
  return iso < todayIso ? "past" : iso > todayIso ? "future" : "today";
}

export interface TripRunInput {
  cancelled: boolean;
  hasLiveVehicle: boolean;
  departureSec: number;
  arrivalSec: number;
  /** Másodperc éjfél óta (csak a mai napra értelmezett). */
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
  // Egy elmúlt nap minden menete lefutott, egy jövőbeli napé egyik sem indult el.
  if (day === "past") return "finished";
  if (day === "future") return "scheduled";
  if (cancelled) return "cancelled";
  if (hasLiveVehicle) return "live";
  if (nowSec > arrivalSec) return "finished";
  if (nowSec >= departureSec) return "running";
  return "scheduled";
}

/** A naplózott jármű csak akkor releváns, ha a menet már el is indult. */
export function showsJournalVehicle(state: TripRunState): boolean {
  return state === "running" || state === "finished";
}

/** Rövid, a felületre kiírható állapotfelirat. */
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

/**
 * Egy LEZÁRT menet eltérése múlt időben. A `delaySentence` jelen idejű
 * („késik") — egy tegnapi menetnél az félrevezető lenne.
 */
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
