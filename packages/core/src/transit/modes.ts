/**
 * Közlekedési módok és forrás-azonosítók.
 *
 * Az MVK azonosítói (megálló, vonal, menet, jármű) előtag nélküliek, ahogy az
 * MVK GTFS-ben vannak. Minden más forrás az OTP2 `feed:` előtagjával jön
 * (`hkir:` Volán, `1:` vasút). Egy azonosító tehát akkor MVK-s, ha nincs
 * benne kettőspont  erre épül a v2-végpontok MVK-szűrése is (az iOS app
 * soha nem kap mást, mint eddig).
 */

/** A felhasználó szerint ki-be kapcsolható módok. */
export type TransitMode = "tram" | "bus" | "coach" | "rail";

export const ALL_MODES: readonly TransitMode[] = ["tram", "bus", "coach", "rail"];
/** A v2-végpontok alapértéke: ami eddig is volt. */
export const MVK_MODES: readonly TransitMode[] = ["tram", "bus"];

export type FeedId = "mvk" | "hkir" | "rail" | "other";

/** Az OTP2 feed-azonosítója → a mi forrásunk. */
const PREFIX_FEED: Record<string, FeedId> = { hkir: "hkir", "1": "rail" };

export function isMvkId(id: string): boolean {
  return !id.includes(":");
}

export function feedOfId(id: string): FeedId {
  const i = id.indexOf(":");
  if (i < 0) return "mvk";
  return PREFIX_FEED[id.slice(0, i)] ?? "other";
}

/** Egy vonal módja. Az MVK-n belül a GTFS route_type dönt (0, 900 = villamos). */
export function modeOfRoute(routeId: string, routeType: string): TransitMode {
  const f = feedOfId(routeId);
  if (f === "hkir") return "coach";
  if (f === "rail") return "rail";
  return routeType === "0" || routeType === "900" ? "tram" : "bus";
}

/**
 * `?modes=` paraméter → módok. Ismeretlen értéket eldob; `all` mindent ad;
 * üres vagy hiányzó paraméternél az alapérték (v2: csak MVK).
 */
export function parseModes(raw: string | null | undefined, fallback: readonly TransitMode[] = MVK_MODES): Set<TransitMode> {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return new Set(fallback);
  if (v === "all") return new Set(ALL_MODES);
  const out = new Set<TransitMode>();
  for (const p of v.split(",")) {
    const m = p.trim() as TransitMode;
    if ((ALL_MODES as readonly string[]).includes(m)) out.add(m);
  }
  return out.size ? out : new Set(fallback);
}

/** Csak MVK-módok vannak-e a halmazban (akkor a válasz bájtra a régi). */
export function onlyMvk(modes: ReadonlySet<TransitMode>): boolean {
  return !modes.has("coach") && !modes.has("rail");
}

/** Egy megálló melyik forrásé (a közös MVK-megállókon Volán is megáll: azt a menet módja dönti el). */
export function stopAllowed(stopId: string, modes: ReadonlySet<TransitMode>): boolean {
  const f = feedOfId(stopId);
  if (f === "mvk") return modes.has("bus") || modes.has("tram") || modes.has("coach");
  if (f === "hkir") return modes.has("coach");
  if (f === "rail") return modes.has("rail");
  return false;
}

/** Az üzemeltető rövid neve a táblára: „MÁV Személyszállítási Zrt. - Tiszaújváros” → „Tiszaújváros”. */
export function operatorLabel(agencyName: string | null | undefined): string | null {
  const n = (agencyName ?? "").trim();
  if (!n) return null;
  const m = /^MÁV Személyszállítási Zrt\.?\s*[-–]\s*(.+)$/.exec(n);
  if (m) return m[1].trim();
  if (/^MÁV Személyszállítási/.test(n)) return "MÁV";
  if (/^GYSEV/.test(n)) return "GYSEV";
  if (/^MVK/.test(n)) return "MVK";
  return n;
}

/**
 * Az állomás kulcsa egy regionális megállóhoz: a vágány / kocsiállás utótagja nélkül
 * (`1:005511387_3` → `1:005511387`, `hkir:hkir_213938_11` → `hkir:hkir_213938`).
 * A MÁV+ valós idejű adata a vágány-megállót adja, a menetrend az állomásszintűt
 * (`_0`)  ezen a kulcson párosítjuk őket. Az MVK-megállónál maga az azonosító.
 */
export function stationKeyOf(stopId: string): string {
  return isMvkId(stopId) ? stopId : stopId.replace(/_[^_:]+$/, "");
}
