import type { DepotReason, DepotVehicle, FleetHistory, TripTip } from "@/services/parkingApi";

const BUDAPEST_HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });

/** unix → „18:42” budapesti idő szerint */
export function clockOf(unix: number): string {
  return BUDAPEST_HM.format(new Date(unix * 1000));
}

/** a szolgáltatási nap másodperce → „18:42” (éjfél után is 0–23 óra) */
export function hmOfDaySec(sec: number): string {
  const s = ((sec % 86_400) + 86_400) % 86_400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** eltelt idő: „most”, „7 p”, „1 ó 12 p” */
export function durationText(sec: number): string {
  if (sec < 60) return "most";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} p`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ó ${m % 60} p` : `${h} ó`;
}

/** mennyi idő múlva indul a tipp szerinti menet (negatív: már indulnia kellett volna) */
export function untilStart(tip: TripTip, midnight: number, now: number): number {
  return midnight + tip.startS - now;
}

export function untilText(sec: number): string {
  if (sec <= -60) return `${Math.round(-sec / 60)} p késésben`;
  if (sec < 60) return "most indul";
  return `${durationText(sec)} múlva`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** két ISO-nap között eltelt napok */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000);
}

export const REASON_LABEL: Record<DepotReason, string> = {
  "pull-in": "Beállt ma",
  seen: "A telephelyen látszik",
  timeout: "Elnémult, beállt",
  "not-today": "Ma még nem volt kint",
};

/** Egy kocsiszínben álló jármű egysoros állapota. */
export function depotLine(v: DepotVehicle, history: FleetHistory | undefined, serviceDate: string): string {
  if (v.reason === "pull-in" && v.since) return `beállt ${clockOf(v.since)}`;
  if (v.reason === "seen") return "itt áll, élő jel";
  if (v.reason === "timeout" && v.lastSeen) return `${clockOf(v.lastSeen)} óta néma`;
  const last = history?.lastDate;
  if (!last) return "régóta nem volt kint";
  const d = daysBetween(last, serviceDate);
  // Tegnap kint volt → ma az 1. pihenőnap; azt nem írjuk ki külön.
  return d <= 1 ? "tegnap még kint volt" : `${d}. napja pihen`;
}
