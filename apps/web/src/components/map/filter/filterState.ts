import type { FilterState, LiveVehicle, Route } from "@/types";
import { MODE_ITEMS, vehicleModeOf } from "@/lib/modes";

export const MAX_WATCHED = 12;

/**
 * Hány valódi szűrő él (ami a látható járműveket szűkíti). A megjelenítés
 * kapcsolói (megállók, nyomvonal, rendszám-felirat) nem szűrők.
 */
export function activeFilterCount(f: FilterState): number {
  return [
    f.routes.length > 0,
    f.watch.length > 0,
    f.modes.length > 0,
    f.operators.length > 0,
    f.railKinds.length > 0,
    f.delay !== "all",
    f.speed !== "all",
    f.nearMeKm != null,
  ].filter(Boolean).length;
}

/** késettnek számít ettől (mp)  mint a statisztikában (5 perc) */
export const LATE_S = 300;

/** A jármű késése: a hivatalos (MÁV+), különben a saját illesztőnk mérése. */
export const vehicleDelay = (v: LiveVehicle): number | null => v.delaySec ?? v.liveDelaySec ?? null;

/**
 * A mód / üzemeltető / vasúti kategória / késés szűrők (a térkép élő rétege és az
 * idővonal ugyanezt használja). A vonal típusa a `routes`-ból jön.
 */
export function matchesModeFilters(v: LiveVehicle, f: FilterState, routes: Record<string, Route>): boolean {
  const r = routes[v.routeId];
  const mode = vehicleModeOf(v, r?.type);
  if (f.modes.length && !f.modes.includes(mode)) return false;
  if (f.operators.length && mode === "coach" && !f.operators.includes(r?.operator ?? "")) return false;
  if (f.railKinds.length && mode === "rail" && !f.railKinds.includes(r?.short ?? v.routeShort)) return false;
  if (f.delay !== "all") {
    const d = vehicleDelay(v);
    if (d == null) return false;
    if (f.delay === "late" ? d < LATE_S : d >= LATE_S) return false;
  }
  return true;
}

const fmtRadius = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${String(km).replace(".", ",")} km`);

/** Rövid, egysoros összegzés a térkép tetejére (pl. „14, 34 · mozgó · 12 jármű”). */
export function filterSummary(f: FilterState, routes: Record<string, Route>, visible: number): string {
  if (f.watch.length) return `${f.watch.join(", ")} · ${visible} jármű`;
  const parts: string[] = [];
  if (f.routes.length) {
    const names = f.routes.map((id) => routes[id]?.short ?? id);
    parts.push(names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", "));
  }
  if (f.modes.length) parts.push(f.modes.map((m) => MODE_ITEMS.find((x) => x.id === m)?.short.toLowerCase() ?? m).join(", "));
  if (f.operators.length) parts.push(f.operators.length > 2 ? `${f.operators.length} Volán-egység` : f.operators.join(", "));
  if (f.railKinds.length) parts.push(f.railKinds.join(", "));
  if (f.delay !== "all") parts.push(f.delay === "late" ? "késik" : "pontos");
  if (f.speed !== "all") parts.push(f.speed === "moving" ? "mozgó" : "álló");
  if (f.nearMeKm != null) parts.push(`${fmtRadius(f.nearMeKm)}-en belül`);
  parts.push(`${visible} jármű`);
  return parts.join(" · ");
}
