import type { FleetKind, ParkingSnapshot } from "@/services/parkingApi";

/** Kedvenc parkolók: localStorage-ban, így a felhős szinkron minden eszközre viszi. */
export const PREF_PARKING_FAVORITES = "mvk_parking_favorites";
export const terminalKey = (name: string) => `t:${name}`;
export const depotKey = (id: FleetKind) => `d:${id}`;

/**
 * Kedvencek elöl (a felvétel sorrendjében), a többi marad a szerver sorrendjében
 * (legtöbb jármű elöl). A kedvenc végállomás akkor is látszik, ha épp üres —
 * kivéve keresés közben.
 */
export function withFavorites(s: ParkingSnapshot, favorites: string[], query: string): ParkingSnapshot {
  if (!favorites.length) return s;
  const rank = (key: string) => {
    const i = favorites.indexOf(key);
    return i < 0 ? Infinity : i;
  };
  const present = new Set(s.terminals.map((t) => t.name));
  const empty = query.trim()
    ? []
    : favorites
        .filter((k) => k.startsWith("t:") && !present.has(k.slice(2)))
        .map((k) => ({ name: k.slice(2), lat: 0, lon: 0, vehicles: [] }));
  const byRank = <T,>(key: (x: T) => string) => (a: T, b: T) => rank(key(a)) - rank(key(b));
  return {
    ...s,
    terminals: [...s.terminals, ...empty].sort(byRank((t) => terminalKey(t.name))),
    depots: [...s.depots].sort(byRank((d) => depotKey(d.id))),
  };
}
