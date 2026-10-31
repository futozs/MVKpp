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

/**
 * Közös megállók (ugyanott álló MVK-oszlop és Volán-megálló, pl. „Cementgyár” és
 * „Miskolc (Hejőcsaba), cementgyár”): egy megállóként, minden ott megálló járattal
 * („all”), csak az MVK vagy csak a Volán járataival, vagy külön, ahogy a forrás adja.
 * Minden megállótáblára érvényes (térkép, figyelő, kioszk, értesítések).
 */
export type StopMerge = "all" | "mvk" | "coach" | "off";
export const STOP_MERGE_KEY = "mvk_pref_stop_merge";
export const STOP_MERGE_ITEMS: readonly { id: StopMerge; label: string; hint: string }[] = [
  { id: "all", label: "Összevonva", hint: "Egy megálló, és minden járat, ami ott megáll — MVK és Volán együtt." },
  { id: "mvk", label: "Csak MVK", hint: "A közös megállókban csak az MVK járatai látszanak." },
  { id: "coach", label: "Csak Volán", hint: "A közös megállókban csak a Volán-buszok látszanak." },
  { id: "off", label: "Külön", hint: "Az MVK- és a Volán-megálló külön, ahogy a menetrendben szerepel." },
];
const MERGES = new Set<string>(STOP_MERGE_ITEMS.map((m) => m.id));

/** Az összevonás most (a nem React kódnak). */
export function stopMergeNow(): StopMerge {
  try {
    const v = JSON.parse(localStorage.getItem(STOP_MERGE_KEY) ?? "null");
    return MERGES.has(v) ? (v as StopMerge) : "all";
  } catch {
    return "all";
  }
}

export function useStopMerge(): StopMerge {
  const v = usePreference<StopMerge>(STOP_MERGE_KEY, "all")[0];
  return MERGES.has(v) ? v : "all";
}

/** Összevont nézetben a Volán-ikermegálló nem külön tétel (az MVK-oszlop mutatja). */
export const isMergedTwin = (s: { twinOf?: string }, merge: StopMerge) => Boolean(s.twinOf) && merge !== "off";

/**
 * A megállótáblák kulcsa: a módok és az összevonás (`tram,bus,coach,rail~all`) — ez megy a
 * `?modes=&merge=` paraméterekbe és a `stop:<id>@<kulcs>` WebSocket-témába.
 */
export const boardKey = (modes: readonly TransitMode[], merge: StopMerge) => `${modesParam(modes)}~${merge}`;
export const boardKeyNow = () => boardKey(enabledModesNow(), stopMergeNow());
export function useBoardKey(): string {
  const modes = useEnabledModes();
  const merge = useStopMerge();
  return boardKey(modes, merge);
}

/** A tábla-kulcs URL-paraméterei (a régi, csak módos kulcs is jó). */
export function boardQuery(key: string): string {
  const [modes, merge] = key.split("~");
  return `modes=${modes}${merge ? `&merge=${merge}` : ""}`;
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
 * A megyében járó vasúti járművek sorozata (a 12 jegyű UIC-szám 5–8. jegye) → a köznapi neve.
 * Ami nincs a listán, annak csak a sorozat- és pályaszáma látszik.
 */
const RAIL_CLASS: Record<string, string> = {
  "1815": "KISS",
  "1415": "FLIRT",
  "1416": "Desiro",
  "0117": "Bzmot",
  "0418": "M41",
  "0628": "M62",
  "0431": "V43",
  "0432": "V43",
  "0433": "V43",
  "0630": "V63",
  "0470": "Taurus",
  "0480": "TRAXX",
};
/** külföldi (német, osztrák) bejegyzésű mozdonyok a háromjegyű sorozatuk szerint (pl. 91 80 6193 / 7193) */
const FOREIGN_CLASS: Record<string, string> = { "182": "Taurus", "193": "Vectron" };

/**
 * Vasúti jármű a UIC-számából: a teljes, tagolt szám (`92 55 0418 322-7`), a megszokott
 * rövid alak — sorozat és pályaszám (`418 322`) — és a típus köznapi neve (`M41`), ha ismert.
 */
export function railVehicle(id: string): { full: string; short: string; model: string | null } | null {
  const uic = /^1:(\d{2})(\d{2})(\d{4})(\d{3})(\d)$/.exec(id);
  if (!uic) return null;
  const cls = uic[3].slice(1);
  const model = uic[2] === "55" ? RAIL_CLASS[uic[3]] : FOREIGN_CLASS[cls];
  return { full: `${uic[1]} ${uic[2]} ${uic[3]} ${uic[4]}-${uic[5]}`, short: `${cls} ${uic[4]}`, model: model ?? null };
}

/** Rendszám a magyar alakjában: `RWE771` → `RWE-771`, az új négybetűs `AAJB306` → `AA JB-306`. */
function plateText(raw: string): string {
  const now = /^([A-Z]{2})([A-Z]{2})(\d{3})$/.exec(raw);
  if (now) return `${now[1]} ${now[2]}-${now[3]}`;
  const old = /^([A-Z]{3})(\d{3})$/.exec(raw);
  return old ? `${old[1]}-${old[2]}` : raw;
}

/**
 * Megjeleníthető jármű-azonosító: az MVK-é a pályaszám (változatlan), a Volán-buszé a rendszáma
 * (`hkir:hkir_AAJB306` → `AA JB-306`), a vonaté a típusa, sorozata és pályaszáma
 * (`1:945518150384` → `KISS 815 038`). A teljes UIC-szám a `vehicleIdTitle`-ben.
 */
export function displayVehicleId(id: string, plate?: string | null): string {
  if (!isRegionalId(id)) return id;
  const rail = railVehicle(id);
  if (rail) return rail.model ? `${rail.model} ${rail.short}` : rail.short;
  return plateText((plate || id.replace(/^hkir:hkir_/, "").replace(/^1:/, "")).replace(/[\s-]/g, ""));
}

/** A jármű teljes azonosítója a buborékba: vonatnál a UIC-szám, másutt a megjelenített. */
export function vehicleIdTitle(id: string, plate?: string | null): string {
  const rail = railVehicle(id);
  return rail ? `${rail.model ? `${rail.model} · ` : ""}${rail.full}` : displayVehicleId(id, plate);
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
