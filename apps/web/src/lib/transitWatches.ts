/**
 * A figyelő vasúti (és bármilyen) kártyái a megállók mellett:
 *  - viszonylat: A → B közvetlenül (pl. Miskolc-Tiszai → Füzesabony);
 *  - vonatszám: egy konkrét vonat minden nap (pl. 5139).
 * Külön `mvk_*` kulcsok (nem a figyelt megállók listájában): a felhős szinkron
 * kulcsonként viszi őket, és a régi kliensek megállólistája érintetlen marad.
 */
import { usePreference } from "@/hooks/usePreference";

export type RelationWatch = { from: string; to: string };

const RELATIONS_KEY = "mvk_watch_relations";
const TRAINS_KEY = "mvk_watch_trains";
/** ennyi viszonylat és vonat fér a figyelőre (a kártyák pollozása miatt) */
export const MAX_RELATIONS = 6;
export const MAX_TRAINS = 6;

const validRelation = (x: unknown): x is RelationWatch =>
  Boolean(x && typeof x === "object" && typeof (x as RelationWatch).from === "string" && typeof (x as RelationWatch).to === "string");

export function useRelationWatches(): [RelationWatch[], (next: RelationWatch[]) => void] {
  const [raw, set] = usePreference<unknown>(RELATIONS_KEY, []);
  const list = Array.isArray(raw) ? raw.filter(validRelation) : [];
  return [list, (next) => set(next.slice(0, MAX_RELATIONS))];
}

export function useTrainWatches(): [string[], (next: string[]) => void] {
  const [raw, set] = usePreference<unknown>(TRAINS_KEY, []);
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && /^\d{1,6}$/.test(x)) : [];
  return [list, (next) => set([...new Set(next)].slice(0, MAX_TRAINS))];
}

export const relationKey = (r: RelationWatch) => `${r.from}>${r.to}`;
