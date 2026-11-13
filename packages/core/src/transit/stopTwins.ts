/**
 * Közös megállók: ugyanott álló MVK- és Volán-megálló egy megállóként.
 *
 * Az OTP2 a Volán megállóinak egy részét eleve az MVK azonosítójával adja (a Tiszai
 * pályaudvaron a Volán is az SP388-on áll meg)  ezek maguktól közösek. A többi Volán-
 * megálló külön azonosítóval, pár méterre áll az MVK-étól („Miskolc (Hejőcsaba),
 * cementgyár” ↔ „Cementgyár”). Ezeket párosítjuk: közel vannak, és a nevük ugyanaz
 * (a „Miskolc,” / „Miskolc (Hejőcsaba),” előtag, a zárójeles kiegészítés és az
 * „utca / út / tér” nélkül). Csak a biztos párok: ha a név más, külön marad.
 *
 * Minden Volán-oszlop a legközelebbi egyező nevű MVK-oszlophoz tartozik  így az
 * útnak ugyanazon az oldalán álló, egy irányba induló oszlopok kerülnek egy táblára.
 */
import type { Feed } from "../gtfs/feed.ts";
import { fastDistM } from "../geo.ts";
import { feedOfId, isMvkId, modeOfRoute, type TransitMode } from "./modes.ts";

/** Közös megállóknál mi látszik: minden, csak az MVK, csak a Volán, vagy külön (nincs összevonás). */
export type StopMerge = "all" | "mvk" | "coach" | "off";

export const STOP_MERGES: readonly StopMerge[] = ["all", "mvk", "coach", "off"];

export function parseStopMerge(raw: string | null | undefined): StopMerge {
  const v = (raw ?? "").trim().toLowerCase();
  return (STOP_MERGES as readonly string[]).includes(v) ? (v as StopMerge) : "off";
}

/** ennél messzebb két megálló nem „ugyanott” van (m) */
export const TWIN_MAX_M = 220;

/** a megálló nevében semmit nem jelentő szavak */
const GENERIC = new Set(["utca", "u", "ut", "utja", "ter", "tere", "varosresz", "megallo", "mh"]);

type NameParts = { core: string[]; extra: string[] };

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const words = (s: string) =>
  s
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w === "pu" ? "palyaudvar" : w));

/**
 * Egy megállónév szavai: a lényeg (core) és a kiegészítés (extra: település / városrész
 * a vessző előtt, zárójelben vagy szögletes zárójelben)  ez egyezhet, de nem kell.
 */
export function stopNameParts(name: string): NameParts {
  let n = fold(name);
  const extra: string[] = [];
  const comma = n.indexOf(",");
  if (comma >= 0) {
    extra.push(...words(n.slice(0, comma)));
    n = n.slice(comma + 1);
  }
  n = n.replace(/[([]([^)\]]*)[)\]]/g, (_, inner: string) => {
    extra.push(...words(inner));
    return " ";
  });
  return { core: words(n).filter((w) => !GENERIC.has(w)), extra };
}

/** Két szó ugyanaz-e: egyezés, vagy a rövidebb a hosszabb eleje / vége („ujmassa” ↔ „ujmassai”). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return min >= 6 && (a.endsWith(b) || b.endsWith(a));
}

const covered = (xs: string[], ys: string[]) => xs.every((x) => ys.some((y) => sameWord(x, y)));

/** Ugyanannak a megállónak a neve-e (az egyik lényege benne van a másikban). */
export function sameStopName(a: string, b: string): boolean {
  const pa = stopNameParts(a);
  const pb = stopNameParts(b);
  if (!pa.core.length || !pb.core.length) return false;
  return covered(pa.core, [...pb.core, ...pb.extra]) || covered(pb.core, [...pa.core, ...pa.extra]);
}

export type StopTwins = {
  /** Volán-megálló → az MVK-oszlop, amelyhez tartozik */
  toMvk: Map<string, string>;
  /** MVK-oszlop → a hozzá tartozó Volán-megállók */
  fromMvk: Map<string, string[]>;
  /** MVK-oszlopok, ahol (a párjával együtt) MVK és Volán is megáll */
  shared: Set<string>;
};

/** rácsosztás a közelség-kereséshez (~0,3 km) */
const CELL = 0.003;
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / CELL)}|${Math.floor(lon / CELL)}`;

/** Egy (kompozit) feed közös megállói. Feedenként egyszer számoljuk (lásd `stopTwinsOf`). */
export function findStopTwins(feed: Feed): StopTwins {
  const grid = new Map<string, { id: string; lat: number; lon: number; name: string }[]>();
  for (const s of feed.stops.values()) {
    if (!isMvkId(s.id)) continue;
    const k = cellKey(s.lat, s.lon);
    const list = grid.get(k);
    if (list) list.push(s);
    else grid.set(k, [s]);
  }
  const toMvk = new Map<string, string>();
  const fromMvk = new Map<string, string[]>();
  for (const s of feed.stops.values()) {
    // az autóbusz-állomás és a kocsiállásai külön hely (a saját táblájával)
    if (feedOfId(s.id) !== "hkir" || s.station || s.parent) continue;
    const ci = Math.floor(s.lat / CELL);
    const cj = Math.floor(s.lon / CELL);
    let best: { id: string; d: number } | null = null;
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (const m of grid.get(`${i}|${j}`) ?? []) {
          const d = fastDistM(s.lat, s.lon, m.lat, m.lon);
          if (d > TWIN_MAX_M || (best && d >= best.d) || !sameStopName(s.name, m.name)) continue;
          best = { id: m.id, d };
        }
    if (!best) continue;
    toMvk.set(s.id, best.id);
    const list = fromMvk.get(best.id);
    if (list) list.push(s.id);
    else fromMvk.set(best.id, [s.id]);
  }
  // Közös hely: MVK és Volán is megáll rajta (a pár, vagy az MVK-azonosítón megálló Volán).
  const shared = new Set<string>();
  const serves = (stopId: string) => {
    let mvk = false;
    let coach = false;
    for (const { trip } of feed.stopSched.get(stopId) ?? []) {
      const t = feed.trips.get(trip);
      const r = t ? feed.routes.get(t.routeId) : undefined;
      if (!r) continue;
      if (modeOfRoute(r.id, r.type) === "coach") coach = true;
      else mvk = true;
      if (mvk && coach) break;
    }
    return { mvk, coach };
  };
  for (const s of feed.stops.values()) {
    if (!isMvkId(s.id)) continue;
    const own = serves(s.id);
    if (own.mvk && (own.coach || (fromMvk.get(s.id) ?? []).some((t) => serves(t).coach))) shared.add(s.id);
  }
  return { toMvk, fromMvk, shared };
}

const cache = new WeakMap<Feed, StopTwins>();

/** A feed közös megállói (gyorsítótárazva: a kompozit feed naponta egyszer áll össze). */
export function stopTwinsOf(feed: Feed): StopTwins {
  let t = cache.get(feed);
  if (!t) cache.set(feed, (t = findStopTwins(feed)));
  return t;
}

/**
 * Egy megálló táblája az összevonás szerint: mely megállók indulásai (az MVK-oszlop
 * és a párjai), és milyen módokkal. Közös helyen a „csak MVK” / „csak Volán” szűr;
 * máshol (csak MVK vagy csak Volán áll meg) a módok maradnak, hogy a tábla ne legyen üres.
 */
export function mergedBoard(
  twins: StopTwins,
  stopId: string,
  merge: StopMerge,
  modes: ReadonlySet<TransitMode>,
): { primary: string; stopIds: string[]; modes: ReadonlySet<TransitMode>; merged: boolean } {
  if (merge === "off") return { primary: stopId, stopIds: [stopId], modes, merged: false };
  const primary = twins.toMvk.get(stopId) ?? stopId;
  const mates = twins.fromMvk.get(primary) ?? [];
  // a Volán-párok csak akkor kellenek, ha a Volán látszik
  const stopIds = modes.has("coach") ? [primary, ...mates] : [primary];
  if (merge === "all" || !twins.shared.has(primary)) return { primary, stopIds, modes, merged: stopIds.length > 1 };
  const keep = new Set([...modes].filter((m) => (merge === "coach" ? m === "coach" : m === "tram" || m === "bus")));
  return { primary, stopIds: merge === "mvk" ? [primary] : stopIds, modes: keep.size ? keep : modes, merged: stopIds.length > 1 };
}
