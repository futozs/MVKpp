import type { FilterState, Route } from "@/types";

export const MAX_WATCHED = 12;

/**
 * Hány valódi szűrő él (ami a látható járműveket szűkíti). A megjelenítés
 * kapcsolói (megállók, nyomvonal, rendszám-felirat) nem szűrők.
 */
export function activeFilterCount(f: FilterState): number {
  return [f.routes.length > 0, f.watch.length > 0, f.type !== "all", f.speed !== "all", f.nearMeKm != null].filter(Boolean).length;
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
  if (f.type !== "all") parts.push(f.type === "bus" ? "busz" : "villamos");
  if (f.speed !== "all") parts.push(f.speed === "moving" ? "mozgó" : "álló");
  if (f.nearMeKm != null) parts.push(`${fmtRadius(f.nearMeKm)}-en belül`);
  parts.push(`${visible} jármű`);
  return parts.join(" · ");
}
