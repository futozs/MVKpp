/**
 * Közlekedési módok: MVK villamos, MVK busz, Volán (helyközi busz) és vasút.
 *
 * Minden mód külön kapcsoló a Beállításokban (`mvk_pref_mode_*` a localStorage-ban),
 * így a felhős szinkron kulcsonként viszi, és minden nyitott lap azonnal látja.
 * Alapból mind be van kapcsolva; az első indításkor egy kártya kérdezi meg, kell-e.
 *
 * Az azonosítók: az MVK-é előtag nélküli (SP388), a regionálisaké a MÁV+ előtagjával
 * jön (`hkir:` Volán, `1:` vasút) — a megálló / jármű / menet forrása ebből olvasható.
 */
import { useMemo } from "react";
import { inRegion } from "@mvk/core/transit/region";
import { usePreference } from "@/hooks/usePreference";
import type { TransitMode } from "@/types";

export type { TransitMode };

export const ALL_MODES: readonly TransitMode[] = ["tram", "bus", "coach", "rail"];

export type ModeItem = { id: TransitMode; key: string; label: string; short: string; hint: string };

export const MODE_ITEMS: readonly ModeItem[] = [
  { id: "tram", key: "mvk_pref_mode_tram", label: "Villamos (MVK)", short: "Villamos", hint: "Az MVK villamosai a térképen, a figyelőben, a menetrendben és a statisztikában." },
  { id: "bus", key: "mvk_pref_mode_bus", label: "Városi busz (MVK)", short: "Busz", hint: "Az MVK buszai — a városi járatok." },
  { id: "coach", key: "mvk_pref_mode_coach", label: "Helyközi busz (Volán)", short: "Volán", hint: "A MÁV-Volán buszai Borsod-Abaúj-Zemplénben, a Búza téri autóbusz-állomással és a kocsiállásokkal." },
  { id: "rail", key: "mvk_pref_mode_rail", label: "Vonat (MÁV)", short: "Vonat", hint: "A megyét érintő vonatok az egész útjukon: vágány, késés és oka, hol jár most." },
];

/** az első indítás bemutató-kártyája (szinkronizálódik: egy eszközön elég egyszer dönteni) */
export const REGIONAL_INTRO_KEY = "mvk_regional_intro";

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

/** A bekapcsolt módok most (a nem React kódnak, pl. az API-hívásoknak). Legalább egy mindig marad. */
export function enabledModesNow(): TransitMode[] {
  if (typeof window === "undefined") return [...ALL_MODES];
  const on = MODE_ITEMS.filter((m) => readBool(m.key)).map((m) => m.id);
  return on.length ? on : ["tram", "bus"];
}

/** `?modes=` értéke a bekapcsolt módokból. */
export function modesParam(modes: readonly TransitMode[] = enabledModesNow()): string {
  return ALL_MODES.filter((m) => modes.includes(m)).join(",");
}

/** A bekapcsolt módok (React). A tömb csak akkor új, ha a halmaz változott. */
export function useEnabledModes(): TransitMode[] {
  // A hookok sorrendje állandó: mindig mind a négy kapcsolót olvassuk.
  const tram = usePreference<boolean>(MODE_ITEMS[0].key, true)[0] !== false;
  const bus = usePreference<boolean>(MODE_ITEMS[1].key, true)[0] !== false;
  const coach = usePreference<boolean>(MODE_ITEMS[2].key, true)[0] !== false;
  const rail = usePreference<boolean>(MODE_ITEMS[3].key, true)[0] !== false;
  return useMemo(() => {
    const on = ALL_MODES.filter((_, i) => [tram, bus, coach, rail][i]);
    return on.length ? on : ["tram", "bus"];
  }, [tram, bus, coach, rail]);
}

/** Be van-e kapcsolva bármelyik regionális mód (Volán, vasút). */
export const hasRegional = (modes: readonly TransitMode[]) => modes.includes("coach") || modes.includes("rail");

/** Egy azonosító forrása: MVK (előtag nélkül), Volán (`hkir:`), vasút (`1:`). */
export function feedOfId(id: string): "mvk" | "coach" | "rail" {
  if (!id.includes(":")) return "mvk";
  return id.startsWith("1:") ? "rail" : "coach";
}

export const isRegionalId = (id: string) => id.includes(":");

/**
 * Keresési sorrend: a megyén belüli megállók elöl. A megyét érintő járatok teljes útjukkal
 * jönnek, ezért Debrecen vagy Békéscsaba autóbusz-állomása is a listában van — de hátul.
 */
export const regionRank = (s: { id: string; lat: number; lon: number }) => (!isRegionalId(s.id) || inRegion(s.lat, s.lon) ? 0 : 1);

/**
 * A választható megállók: az állomás peronjai (vágányok, kocsiállások) nem külön
 * tételek — az állomást kell felvenni, az mutatja mindet.
 */
export function pickableStops<T extends { id: string; parent?: string | null }>(stops: T[]): T[] {
  const ids = new Set(stops.map((s) => s.id));
  return stops.filter((s) => !(s.parent && ids.has(s.parent)));
}

/** Egy jármű módja (a natív MVK-jármű nem hordozza: a vonal típusából). */
export function vehicleModeOf(v: { id: string; mode?: TransitMode; label?: string; routeId?: string }, routeType?: string): TransitMode {
  if (v.mode) return v.mode;
  const f = feedOfId(v.id);
  if (f !== "mvk") return f;
  return routeType === "900" || routeType === "0" || v.label === "TRAM" ? "tram" : "bus";
}

/** Egy vonal módja (a v3-lista hozza; a régi listán a GTFS-típus dönt). */
export function routeModeOf(r: { id: string; type: string; mode?: TransitMode }): TransitMode {
  if (r.mode) return r.mode;
  const f = feedOfId(r.id);
  if (f !== "mvk") return f;
  return r.type === "900" || r.type === "0" ? "tram" : "bus";
}

/**
 * Megjeleníthető rendszám: a Volán-azonosító előtag nélkül (`hkir:hkir_LWA387` → `LWA387`),
 * a vasúti jármű 12 jegyű UIC-száma tagolva (`1:925504183227` → `92 55 0418 322-7`).
 */
export function displayVehicleId(id: string, plate?: string | null): string {
  if (!isRegionalId(id)) return id;
  if (plate) return plate;
  const raw = id.replace(/^hkir:hkir_/, "").replace(/^1:/, "");
  const uic = /^(\d{2})(\d{2})(\d{4})(\d{3})(\d)$/.exec(raw);
  return uic && id.startsWith("1:") ? `${uic[1]} ${uic[2]} ${uic[3]} ${uic[4]}-${uic[5]}` : raw;
}

/** Mód szerinti főnév: „busz”, „villamos”, „vonat” (a Volán is busz). */
export function vehicleNoun(mode: TransitMode | undefined): string {
  return mode === "rail" ? "vonat" : mode === "tram" ? "villamos" : "busz";
}

/**
 * A telefon és a jármű „együtt” távolságai módonként (m). A busz pontja a jármű, a vonaté
 * egy 100–200 m-es szerelvény egyik vége, és a jele 10–40 mp-cel késik — ott tágabb.
 * near/far: felszállás-felismerés; withBus/away: utazás közben; atStop: a megállóban áll.
 */
export const RIDE_PROXIMITY: Record<TransitMode, { near: number; far: number; withBus: number; away: number; atStop: number }> = {
  tram: { near: 50, far: 150, withBus: 200, away: 300, atStop: 70 },
  bus: { near: 50, far: 150, withBus: 200, away: 300, atStop: 70 },
  coach: { near: 80, far: 250, withBus: 300, away: 450, atStop: 90 },
  rail: { near: 220, far: 600, withBus: 500, away: 900, atStop: 300 },
};

/** A jármű vagy a menet módja az azonosítóiból (a vonal típusa nélkül: villamos/busz itt egy). */
export const rideModeOf = (vehicleId: string, tripId?: string): TransitMode => {
  const f = feedOfId(tripId || vehicleId);
  return f === "mvk" ? "bus" : f;
};

/** A jármű neve ragozva a mondatokhoz: „erre a buszra / vonatra”, „ezen a buszon / vonaton”. */
export const VEHICLE_WORDS: Record<TransitMode, { n: string; ra: string; on: string; om: string; val: string }> = {
  tram: { n: "villamos", ra: "villamosra", on: "villamoson", om: "villamosom", val: "villamossal" },
  bus: { n: "busz", ra: "buszra", on: "buszon", om: "buszom", val: "busszal" },
  coach: { n: "busz", ra: "buszra", on: "buszon", om: "buszom", val: "busszal" },
  rail: { n: "vonat", ra: "vonatra", on: "vonaton", om: "vonatom", val: "vonattal" },
};
