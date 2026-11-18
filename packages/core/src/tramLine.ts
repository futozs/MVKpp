/**
 * Villamosvonal-elemző: a villamosok egy közös, irányonkénti vonalra vetítve
 * (Tiszai pu. ↔ Felső-Majláth; az 1A és a 2 ennek része). Ebből látszik,
 * melyik villamos áll, ki van elöl egy sorban (közvetlenül előtte van az
 * akadály, vagy ő maga hibásodott meg), kik rekedtek mögötte, és hogy a baj
 * egy irányt, mindkettőt vagy az egész vonalat érinti-e. Csak a mért
 * mozgásból és késésből következtet; az okot valószínűségként mondja ki.
 */

export type TramLineStop = { id: string; name: string };
/** egy irány megállói menetirány szerint; `toward` a végállomás */
export type TramLineDef = { toward: string; stops: TramLineStop[] };

export type TramOnLine = {
  vehicleId: string;
  route: string;
  delayS: number;
  /** ennyi ideje van egy kis körzetben (mp) */
  stallS: number | null;
  fromStopId: string | null;
  toStopId: string;
  /** hol tart a két megálló között (0–1) */
  frac: number;
  /** most éppen ennyi késést szed fel a futó szakaszon (mp) */
  losingS: number | null;
};

export type PlacedTram = TramOnLine & {
  /** hely a vonalon: megálló-index + tört rész */
  pos: number;
  state: "moving" | "slow" | "stopped";
  role: "head" | "stuck" | null;
};

export type Blockage = {
  /** a sor elején álló villamos */
  head: string;
  /** a mögötte rekedtek, a fejtől hátrafelé */
  behind: string[];
  /** az akadály valószínű helye: a fej és a következő megálló */
  fromStop: string;
  toStop: string;
  /** a fej ennyi ideje áll (mp) */
  sinceS: number;
};

export type TramLineView = {
  toward: string;
  stops: string[];
  trams: PlacedTram[];
  blockage: Blockage | null;
  /** egymás nyakában haladó villamosok (egy megállóközön belül, legalább három) */
  bunches: string[][];
};

/** a vonal egészére vonatkozó következtetés (a szöveget a felület rakja össze) */
export type TramVerdict =
  | { kind: "ok" }
  /** mindkét irányban áll a villamosok többsége: áram- vagy felsővezeték-hiba */
  | { kind: "whole-line" }
  /** mindkét irányban áll egy sor; `samePlace`: nagyjából ugyanott */
  | { kind: "both-ways"; samePlace: boolean; places: string[] }
  /** egy irányban áll (`one-way`: a fej áll) vagy araszol (`queue`) egy sor */
  | {
      kind: "one-way" | "queue";
      toward: string;
      head: string;
      behind: number;
      fromStop: string;
      toStop: string;
      sinceS: number;
      /** a másik irány rendben halad */
      otherOk: boolean;
      otherToward: string | null;
    };

export const TRAM_LINE = {
  /** ennyi ideje egy kis körzetben: áll (mp) */
  STOPPED_S: 3 * 60,
  /** ekkora késés-felszedés a futó szakaszon: araszol (mp) */
  SLOW_LOSING_S: 3 * 60,
  /** a fej egyedül is akadály, ha ennyi ideje áll (mp) */
  LONE_HEAD_S: 6 * 60,
  /** a két irány akadálya ennyi megállón belül „ugyanott” van */
  SAME_PLACE_STOPS: 2,
  /** a villamosok ekkora része áll: az egész vonal áll */
  WHOLE_LINE_SHARE: 0.6,
  /** és ennyi külön helyen állnak (egy-egy hely: néhány megállón belül) */
  WHOLE_LINE_SPOTS: 3,
  SPOT_STOPS: 2,
  BUNCH_STOPS: 1,
  BUNCH_MIN: 3,
} as const;

function stateOf(t: TramOnLine): PlacedTram["state"] {
  if ((t.stallS ?? 0) >= TRAM_LINE.STOPPED_S) return "stopped";
  if ((t.losingS ?? 0) >= TRAM_LINE.SLOW_LOSING_S) return "slow";
  return "moving";
}

/** Hol van a villamos ezen az irányon (null: nem ezen az irányon, vagy a 2-es vasgyári hurkán jár). */
function placeOn(line: TramLineDef, t: TramOnLine): number | null {
  const to = line.stops.findIndex((s) => s.id === t.toStopId);
  if (to < 0) return null;
  const from = t.fromStopId ? line.stops.findIndex((s) => s.id === t.fromStopId) : -1;
  if (from >= 0 && from === to - 1) return from + Math.min(1, Math.max(0, t.frac));
  // a menet első megállója felé (még nem indult) vagy más ág felől érkezik: a megállónál
  return to;
}

/**
 * Irányonként a sor: a vonal végétől visszafelé haladva az első álló vagy
 * araszoló villamos a fej, mögötte a megszakítás nélkül szintén álló /
 * araszoló villamosok a rekedtek. Mozgó villamos megszakítja a sort.
 */
function findBlockage(line: TramLineDef, placed: PlacedTram[]): Blockage | null {
  const ordered = [...placed].sort((a, b) => b.pos - a.pos);
  let best: { head: PlacedTram; behind: PlacedTram[] } | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const head = ordered[i];
    if (head.state === "moving") continue;
    const behind: PlacedTram[] = [];
    let j = i + 1;
    while (j < ordered.length && ordered[j].state !== "moving") behind.push(ordered[j++]);
    const counts = behind.length >= 1 || (head.state === "stopped" && (head.stallS ?? 0) >= TRAM_LINE.LONE_HEAD_S);
    // a nagyobb (több villamost megfogó) sor számít; egyenlőnél a régebben álló fej
    if (counts && (!best || behind.length > best.behind.length || (behind.length === best.behind.length && (head.stallS ?? 0) > (best.head.stallS ?? 0)))) best = { head, behind };
    i = j - 1;
  }
  if (!best) return null;
  const at = Math.floor(best.head.pos);
  return {
    head: best.head.vehicleId,
    behind: best.behind.map((t) => t.vehicleId),
    fromStop: line.stops[at]?.name ?? "",
    toStop: line.stops[Math.min(at + 1, line.stops.length - 1)]?.name ?? "",
    sinceS: best.head.stallS ?? 0,
  };
}

function findBunches(placed: PlacedTram[]): string[][] {
  const ordered = [...placed].sort((a, b) => b.pos - a.pos);
  const out: string[][] = [];
  let cur: PlacedTram[] = [];
  for (const t of ordered) {
    if (cur.length && cur[cur.length - 1].pos - t.pos > TRAM_LINE.BUNCH_STOPS) {
      if (cur.length >= TRAM_LINE.BUNCH_MIN) out.push(cur.map((x) => x.vehicleId));
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length >= TRAM_LINE.BUNCH_MIN) out.push(cur.map((x) => x.vehicleId));
  return out;
}

export function analyzeTramLines(lines: TramLineDef[], trams: TramOnLine[]): { lines: TramLineView[]; verdict: TramVerdict } {
  const views: TramLineView[] = lines.map((line) => {
    const placed: PlacedTram[] = [];
    for (const t of trams) {
      const pos = placeOn(line, t);
      if (pos != null) placed.push({ ...t, pos, state: stateOf(t), role: null });
    }
    const blockage = findBlockage(line, placed);
    if (blockage) {
      for (const p of placed) p.role = p.vehicleId === blockage.head ? "head" : blockage.behind.includes(p.vehicleId) ? "stuck" : null;
    }
    return { toward: line.toward, stops: line.stops.map((s) => s.name), trams: placed.sort((a, b) => a.pos - b.pos), blockage, bunches: findBunches(placed) };
  });
  return { lines: views, verdict: verdictOf(views) };
}

/** hány külön helyen vannak a pozíciók (néhány megállón belüliek egy helynek számítanak) */
function clusters(pos: number[]): number {
  const s = [...pos].sort((a, b) => a - b);
  return s.reduce((n, p, i) => (i === 0 || p - s[i - 1] > TRAM_LINE.SPOT_STOPS ? n + 1 : n), 0);
}

function verdictOf(views: TramLineView[]): TramVerdict {
  const all = views.flatMap((v) => v.trams);
  const stopped = all.filter((t) => t.state !== "moving").length;
  // Áramkimaradáskor ki-ki ott áll meg, ahol épp van: sok, egymástól távoli csomó.
  // Egy baleset körül viszont egy helyen torlódnak fel.
  const spots = views.reduce((n, v) => n + clusters(v.trams.filter((t) => t.state !== "moving").map((t) => t.pos)), 0);
  if (all.length >= 4 && stopped >= all.length * TRAM_LINE.WHOLE_LINE_SHARE && spots >= TRAM_LINE.WHOLE_LINE_SPOTS) {
    return { kind: "whole-line" };
  }
  const blocked = views.flatMap((v) => (v.blockage ? [{ view: v, bl: v.blockage }] : []));
  if (blocked.length >= 2) {
    const [a, b] = blocked;
    // a két irány ugyanazokat a megállókat járja, fordított sorrendben: név szerint párosítjuk
    const samePlace = Math.abs(a.view.stops.indexOf(a.bl.fromStop) - a.view.stops.indexOf(b.bl.toStop)) <= TRAM_LINE.SAME_PLACE_STOPS;
    return { kind: "both-ways", samePlace, places: [a.bl.fromStop, b.bl.fromStop] };
  }
  if (blocked.length === 1) {
    const { view, bl } = blocked[0];
    const other = views.find((x) => x !== view) ?? null;
    const head = view.trams.find((t) => t.vehicleId === bl.head);
    return {
      kind: head?.state === "stopped" ? "one-way" : "queue",
      toward: view.toward,
      head: bl.head,
      behind: bl.behind.length,
      fromStop: bl.fromStop,
      toStop: bl.toStop,
      sinceS: bl.sinceS,
      otherOk: other ? other.trams.every((t) => t.state === "moving") : false,
      otherToward: other?.toward ?? null,
    };
  }
  return { kind: "ok" };
}
