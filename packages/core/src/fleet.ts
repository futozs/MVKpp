/**
 * Élő flotta-rangsor: melyik jármű késik vagy siet a legtöbbet, hol szedte
 * fel a késést, és mi a helyzet a villamosvonalon és a buszhálózat gerincén.
 * Itt csak a tiszta döntések vannak; a worker `fleet.ts` gyűjti az adatot.
 */

import type { TramLineView, TramVerdict } from "./tramLine.ts";

/** ekkora késés-növekedéstől érdemes megnevezni, hol szedte fel (mp) */
const PICKUP_MIN_S = 60;
/** ennél kisebb lépés megállóról megállóra csak menetidő-ingadozás (mp) */
const NOISE_S = 30;

export type DelayPoint = { idx: number; stopId: string; delayS: number };

export type DelayPickup = {
  fromStopId: string;
  toStopId: string;
  fromIdx: number;
  toIdx: number;
  gainS: number;
  /** a szakasz a jármű mostani helyzetéig tart: most is ott veszít időt */
  ongoing: boolean;
};

/**
 * Hol szedte fel a késést: a megállók közötti egybefüggő szakasz, ahol a
 * késés a legtöbbet nőtt (legnagyobb összegű rész-sorozat). A `live` a
 * mostani, még be nem fejezett szakasz (az utolsó megálló és a következő
 * között), hogy a most beragadt busznál is látszódjon.
 */
export function delayPickup(points: DelayPoint[], live?: { toStopId: string; toIdx: number; delayS: number } | null): DelayPickup | null {
  const pts = [...points].sort((a, b) => a.idx - b.idx);
  const hasLive = Boolean(live && pts.length && live.toIdx > pts[pts.length - 1].idx);
  if (live && hasLive) pts.push({ idx: live.toIdx, stopId: live.toStopId, delayS: live.delayS });
  let best: { from: number; to: number; gain: number } | null = null;
  let runStart = 0;
  let runSum = 0;
  for (let i = 1; i < pts.length; i++) {
    if (runSum <= 0) {
      runStart = i - 1;
      runSum = 0;
    }
    runSum += pts[i].delayS - pts[i - 1].delayS;
    if (runSum > (best?.gain ?? 0)) best = { from: runStart, to: i, gain: runSum };
  }
  if (!best || best.gain < PICKUP_MIN_S) return null;
  // a szakasz széleiről a menetidő-ingadozást levágjuk: a valódi felszedés helye kell
  let { from, to } = best;
  while (to - from > 1 && pts[from + 1].delayS - pts[from].delayS < NOISE_S) from++;
  while (to - from > 1 && pts[to].delayS - pts[to - 1].delayS < NOISE_S) to--;
  const gainS = pts[to].delayS - pts[from].delayS;
  if (gainS < PICKUP_MIN_S) return null;
  return {
    fromStopId: pts[from].stopId,
    toStopId: pts[to].stopId,
    fromIdx: pts[from].idx,
    toIdx: pts[to].idx,
    gainS,
    ongoing: hasLive && to === pts.length - 1,
  };
}

export type TramState = "off" | "ok" | "late" | "thin" | "collapsed" | "halted" | "replaced";

export type TramInput = {
  /** most menetrend szerint úton lévő villamosmenetek */
  scheduled: number;
  /** most élőben úton lévő villamosok késése (mp) */
  delaysS: number[];
  /** ennyi ideje (mp) egy helyben álló villamosok, a megállóban várakozással együtt */
  stalledS: number[];
  /** most úton lévő villamospótló buszok */
  replacementRunning: number;
  /** a vonal-elemző következtetése (álló sor, araszoló sor) */
  line?: TramVerdict["kind"];
};

export const TRAM = {
  /** ennyi ideje egy helyben: elakadt (mp) */
  STALL_S: 5 * 60,
  /** egyetlen villamos ennyi álldogálás után már jelzés (mp) */
  SINGLE_STALL_S: 8 * 60,
  /** a miskolci villamos rendesen 0–3 percen belül jár: ennyi már rendkívüli (mp) */
  SEVERE_S: 10 * 60,
  LATE_S: 5 * 60,
  /** ennyi rendkívül késő villamos egyszerre: összeomlott a közlekedés */
  COLLAPSE_SEVERE: 3,
  /** vagy kettő, ha közben a villamosok ekkora része 5+ percet késik */
  COLLAPSE_LATE_SHARE: 0.4,
  /** a menetrend szerinti villamosoknak legalább ekkora része kell járjon */
  MIN_RUNNING_SHARE: 0.5,
} as const;

/** sok, egyszerre nagyon késő villamos: összeomlott a közlekedés (az élő állapot és a visszanézés közös mércéje) */
export function tramCollapsed(severe: number, late: number, running: number): boolean {
  return severe >= TRAM.COLLAPSE_SEVERE || (severe >= 2 && late >= running * TRAM.COLLAPSE_LATE_SHARE);
}

/**
 * A villamosvonal állapota. Miskolcon egy vonal (1, 1A, 2): ha egy szerelvény
 * elakad, a mögötte jövők is beállnak. Nem a medián késést nézzük: ha az egyik
 * irány összeomlik, a másik irány pontos villamosai a mediánt lent tartják.
 */
export function tramState(i: TramInput): TramState {
  const running = i.delaysS.length;
  const severe = i.delaysS.filter((d) => d >= TRAM.SEVERE_S).length;
  const late = i.delaysS.filter((d) => d >= TRAM.LATE_S).length;
  if (i.stalledS.filter((s) => s >= TRAM.STALL_S).length >= 2) return "halted";
  if (i.line === "one-way" || i.line === "both-ways" || i.line === "whole-line") return "halted";
  if (tramCollapsed(severe, late, running)) return "collapsed";
  if (i.replacementRunning > 0) return "replaced";
  if (i.scheduled === 0 && running === 0) return "off";
  if (i.scheduled >= 4 && running < i.scheduled * TRAM.MIN_RUNNING_SHARE) return "thin";
  if (severe >= 1 || late >= 2 || i.line === "queue" || i.stalledS.some((s) => s >= TRAM.SINGLE_STALL_S)) return "late";
  return "ok";
}

/**
 * Hol a baj: a késő járművek felszedési szakaszainak (megálló-azonosító
 * sorozatok) legtöbbjük által közösen érintett része, a `reference` menet
 * megállói mentén. Egyetlen jármű szakasza nem „közös baj”.
 */
export function troubleSpan(reference: string[], windows: string[][]): { fromIdx: number; toIdx: number; vehicles: number } | null {
  if (windows.length < 2) return null;
  const count = new Map<string, number>();
  for (const w of windows) {
    for (const k of new Set(w.slice(1).map((id, i) => `${w[i]}|${id}`))) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const pairs = reference.slice(1).map((id, i) => count.get(`${reference[i]}|${id}`) ?? 0);
  const top = Math.max(0, ...pairs);
  if (top < 2) return null;
  let best: { fromIdx: number; toIdx: number } | null = null;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i] !== top) continue;
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1] === top) j++;
    if (!best || j + 1 - i > best.toIdx - best.fromIdx) best = { fromIdx: i, toIdx: j + 1 };
    i = j;
  }
  return best && { ...best, vehicles: top };
}

export type JamSegment = { fromId: string; toId: string; from: string; to: string; routes: string[]; excessS: number; level: number };

export type Corridor = {
  /** a szakaszlánc első és utolsó megállója */
  from: string;
  to: string;
  fromId: string;
  toId: string;
  /** ennyi megállóközön át torlódik */
  links: number;
  /** a teljes többletidő a láncon (mp) */
  excessS: number;
  /** a legsúlyosabb szakasz szintje (0–1) */
  level: number;
  /** a láncon járó vonalak */
  routes: string[];
};

/**
 * A torlódó szakaszok összefűzve folyosókká (A→B, B→C → A→C): a térkép
 * szakaszonként mutatja, itt egy-egy útvonal kell, amit egy utas felismer.
 */
export function jamCorridors(segments: JamSegment[]): Corridor[] {
  const byFrom = new Map<string, JamSegment>();
  const hasPrev = new Set<string>();
  for (const s of segments) {
    if (!byFrom.has(s.fromId)) byFrom.set(s.fromId, s);
    hasPrev.add(s.toId);
  }
  const used = new Set<JamSegment>();
  const out: Corridor[] = [];
  const chain = (start: JamSegment) => {
    const parts: JamSegment[] = [];
    for (let s: JamSegment | undefined = start; s && !used.has(s); s = byFrom.get(s.toId)) {
      used.add(s);
      parts.push(s);
    }
    if (!parts.length) return;
    const last = parts[parts.length - 1];
    out.push({
      from: parts[0].from,
      to: last.to,
      fromId: parts[0].fromId,
      toId: last.toId,
      links: parts.length,
      excessS: parts.reduce((a, p) => a + p.excessS, 0),
      level: Math.max(...parts.map((p) => p.level)),
      routes: [...new Set(parts.flatMap((p) => p.routes))],
    });
  };
  // előbb a láncok elejéről indulunk, a maradék (kör) után
  for (const s of segments) if (!hasPrev.has(s.fromId)) chain(s);
  for (const s of segments) chain(s);
  return out.sort((a, b) => b.excessS - a.excessS);
}

export type BusState = "ok" | "slow" | "jammed" | "collapsed";

export const BUS = {
  /** ennyi késés felett „késik” egy busz (mp) */
  LATE_S: 5 * 60,
  /** gerinc: ennyi vonal közös szakasza */
  BACKBONE_ROUTES: 5,
  /** súlyos dugó egy folyosón */
  HEAVY_LEVEL: 0.6,
  /** ettől a szinttől már érezhető lassulás (az enyhébb szakasz csak listázva) */
  SLOW_LEVEL: 0.3,
  /** ennyi súlyos gerincfolyosó egyszerre: összeomlott */
  COLLAPSE_CORRIDORS: 3,
  /** a buszok ekkora része késik: összeomlott / torlódik / lassú */
  COLLAPSE_SHARE: 0.4,
  JAM_SHARE: 0.25,
  SLOW_SHARE: 0.12,
  /** ennyi busz alatt az arány nem mond semmit (éjszaka) */
  MIN_FLEET: 15,
} as const;

/** A buszhálózat állapota a gerincfolyosók dugóiból és a késő buszok arányából. */
export function busState(i: { running: number; late: number; backbone: Corridor[] }): BusState {
  const share = i.running >= BUS.MIN_FLEET ? i.late / i.running : 0;
  const heavy = i.backbone.filter((c) => c.level >= BUS.HEAVY_LEVEL).length;
  if (heavy >= BUS.COLLAPSE_CORRIDORS || share >= BUS.COLLAPSE_SHARE) return "collapsed";
  if (heavy >= 1 || share >= BUS.JAM_SHARE) return "jammed";
  if (i.backbone.some((c) => c.level >= BUS.SLOW_LEVEL) || share >= BUS.SLOW_SHARE) return "slow";
  return "ok";
}

export function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export type BoardVehicle = {
  vehicleId: string;
  label: string;
  plate: string | null;
  route: string;
  color: string;
  text: string;
  mode: "tram" | "bus";
  replacement: boolean;
  tripId: string;
  headsign: string;
  delayS: number;
  startDelayS: number | null;
  /** hol jár: a legutóbbi és a következő megálló; null = még a kiinduló megállóban vár */
  at: { from: string | null; to: string; stopped: boolean } | null;
  stopsDone: number;
  stopsTotal: number;
  /** hol szedte fel a késést: megállónevek és a menet megálló-indexei */
  pickup: { from: string; to: string; fromIdx: number; toIdx: number; gainS: number; ongoing: boolean; jam: boolean } | null;
  /** ennyi ideje áll egy helyben (mp), ha legalább egy perce */
  stallS: number | null;
};

export type BoardSnapshot = {
  at: number;
  vehicles: BoardVehicle[];
  tram: {
    state: TramState;
    scheduled: number;
    running: number;
    replacementRunning: number;
    /** a menetrend szerint most is jár villamospótló (tervezett vágányzár) */
    replacementPlanned: boolean;
    medianDelayS: number | null;
    /** 10+ / 5+ percet késő villamosok, és a legnagyobb késés (mp) */
    severe: number;
    late: number;
    maxDelayS: number | null;
    /** a késő villamosok közös baj-szakasza: honnan hová, melyik irányban, hány villamost érint */
    trouble: { from: string; to: string; toward: string; vehicles: number } | null;
    stalled: { vehicleId: string; route: string; at: string; stallS: number }[];
    /** a villamosvonal irányonként, és mire utal a helyzet */
    analysis: { lines: TramLineView[]; verdict: TramVerdict };
  };
  bus: {
    state: BusState;
    running: number;
    late: number;
    early: number;
    medianDelayS: number | null;
    corridors: Corridor[];
    /** a gerincen kívüli dugós szakaszok száma */
    otherJams: number;
  };
};
