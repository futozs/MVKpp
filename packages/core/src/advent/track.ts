/**
 * A GPS-pontokból a megtett menetek: végállomástól végállomásig, megállónként
 * az érkezéssel, az indulással és azzal, hogy megállt-e ott, plusz az állások
 * és a jelkiesések. Csak a pontokból dolgozik, a menetrendet nem nézi (azt a
 * day.ts illeszti rá), így bármikor újraszámolható a tárolt pontokból.
 */
import { fastDistM } from "../geo.ts";
import { nearestStop, placeFix, stopsM, type AdventLine, type LineFix } from "./line.ts";
import type { AdventEnd } from "./season.ts";

export type AdventPing = { ts: number; lat: number; lon: number; speed: number | null };

export const TRACK = {
  /** a megálló körüli sáv (± m): ezen belül a megállóban van */
  stopZoneM: 35,
  /** ennyi idő a megálló sávjában már megállás (mp) */
  servedS: 12,
  /** ennél lassabb GPS-sebesség megállásnak számít (m/s) */
  stopSpeed: 1.5,
  /** ennyi visszagurulás után a menet visszafordult (m) */
  reverseM: 400,
  /** a végállomástól ennél kevesebbet eltávolodó kitérő csak tolatás (m) */
  shuntM: 600,
  /** egy menet közben ekkora jelkiesés után a menet megszakadt (mp) */
  lostS: 20 * 60,
  /** ennyi jel nélküli idő menet közben már jelkiesés (mp) */
  gapS: 120,
  /** ekkora körön belül maradva állónak számít (m) */
  stillM: 60,
  /** ennyi egy helyben a vonalon: állás (mp) */
  stallS: 4 * 60,
};

export type StopPass = {
  /** index a season.stops-ban */
  stop: number;
  /** érkezés a megálló sávjába (unix); a kiinduló végállomásnál null */
  arr: number | null;
  /** kilépés a sávból (unix); a cél-végállomásnál null */
  dep: number | null;
  /** megállt (nem csak áthaladt) */
  served: boolean;
  /** a sávban töltött idő (mp) */
  dwellS: number | null;
};

export type Stall = {
  from: number;
  to: number;
  m: number;
  lat: number;
  lon: number;
  /** a legközelebbi megálló indexe, és hogy a megállóban állt-e */
  nearStop: number;
  atStop: boolean;
  /** még tart (az utolsó pontig) */
  open: boolean;
};

export type LegEnd = "arrived" | "turned" | "lost" | "running";

export type Leg = {
  /** "out": Tiszai → Felső-Majláth, "back": vissza */
  dir: "out" | "back";
  /** honnan indult (null: vonal közben kezdődött az adat, vagy visszafordulás után) */
  from: AdventEnd | null;
  to: AdventEnd | null;
  /** indulás: a kiinduló megálló elhagyása, vagy az első pont (unix) */
  dep: number;
  /** érkezés a cél-végállomás megállójába (unix) */
  arr: number | null;
  end: LegEnd;
  passes: StopPass[];
  stalls: Stall[];
  /** jelkiesések menet közben [tól, ig] */
  gaps: [number, number][];
  distM: number;
  maxSpeed: number | null;
  fixes: LineFix[];
};

export type Track = {
  fixes: LineFix[];
  legs: Leg[];
  /** állások a végállomáson kívül, menet nélkül (pl. egy vonalon ragadt, menetnek nem induló jármű) */
  looseStalls: Stall[];
  /** a teljes megtett út a GPS szerint (m), a 15 m alatti remegés nélkül */
  distM: number;
};

/** sorba rendez, a duplikált és az ugró (lehetetlen sebességű) pontokat kiszűri */
export function cleanPings(pings: AdventPing[]): AdventPing[] {
  const sorted = [...pings].sort((a, b) => a.ts - b.ts);
  const out: AdventPing[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && p.ts <= prev.ts) continue;
    if (prev && fastDistM(prev.lat, prev.lon, p.lat, p.lon) / Math.max(1, p.ts - prev.ts) > 30) continue;
    out.push(p);
  }
  return out;
}

/** az idő, amikor a pontsor a `target` helyet átlépte a menet irányában (lineárisan a két pont között) */
function crossTime(fixes: LineFix[], target: number, sign: 1 | -1, fromIdx = 0): { ts: number; idx: number } | null {
  for (let i = Math.max(1, fromIdx); i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    const da = (a.m - target) * sign;
    const db = (b.m - target) * sign;
    if (da < 0 && db >= 0) {
      const f = b.m === a.m ? 1 : (target - a.m) / (b.m - a.m);
      return { ts: Math.round(a.ts + (b.ts - a.ts) * f), idx: i };
    }
  }
  return null;
}

function passesOf(line: AdventLine, leg: { dir: "out" | "back"; from: AdventEnd | null; to: AdventEnd | null }, fixes: LineFix[]): StopPass[] {
  const sign = leg.dir === "out" ? 1 : -1;
  const stopM = stopsM(line, leg.dir);
  const n = stopM.length;
  const order = leg.dir === "out" ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  const out: StopPass[] = [];
  let cursor = 1;
  for (const [k, stop] of order.entries()) {
    const s = stopM[stop];
    const first = k === 0;
    const last = k === n - 1;
    const z = TRACK.stopZoneM;
    if (first && leg.from) {
      const exit = crossTime(fixes, s + sign * z, sign);
      if (!exit) break;
      out.push({ stop, arr: null, dep: exit.ts, served: true, dwellS: null });
      cursor = exit.idx;
      continue;
    }
    const entry = crossTime(fixes, s - sign * z, sign, cursor);
    if (!entry) break;
    if (last && leg.to) {
      out.push({ stop, arr: entry.ts, dep: null, served: true, dwellS: null });
      break;
    }
    const exit = crossTime(fixes, s + sign * z, sign, entry.idx);
    const dwellS = exit ? exit.ts - entry.ts : null;
    // a sávban (vagy közvetlenül előtte–utána) állva látott pont: megállt
    const inZone = fixes.slice(Math.max(0, entry.idx - 1), (exit?.idx ?? fixes.length) + 1).some(
      (f) => Math.abs(f.m - s) <= z + 15 && f.speed != null && f.speed <= TRACK.stopSpeed,
    );
    out.push({ stop, arr: entry.ts, dep: exit?.ts ?? null, served: inZone || (dwellS ?? 0) >= TRACK.servedS, dwellS });
    if (!exit) break;
    cursor = exit.idx;
  }
  return out;
}

/** az egy helyben töltött szakaszok (legalább stallS hosszúak) a végállomásokon kívül */
export function stallsOf(line: AdventLine, fixes: LineFix[], open: boolean): Stall[] {
  const out: Stall[] = [];
  let i = 0;
  while (i < fixes.length) {
    const a = fixes[i];
    if (a.place === "tiszai" || a.place === "majlath") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < fixes.length && fixes[j + 1].place !== "tiszai" && fixes[j + 1].place !== "majlath" && fastDistM(a.lat, a.lon, fixes[j + 1].lat, fixes[j + 1].lon) <= TRACK.stillM) j++;
    const b = fixes[j];
    if (b.ts - a.ts >= TRACK.stallS) {
      const near = nearestStop(line, a.m);
      out.push({
        from: a.ts,
        to: b.ts,
        m: a.m,
        lat: a.lat,
        lon: a.lon,
        nearStop: near.idx,
        atStop: near.distM <= TRACK.stopZoneM + 25,
        open: open && j === fixes.length - 1,
      });
      i = j + 1;
    } else i++;
  }
  return out;
}

function gapsOf(fixes: LineFix[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < fixes.length; i++) if (fixes[i].ts - fixes[i - 1].ts >= TRACK.gapS) out.push([fixes[i - 1].ts, fixes[i].ts]);
  return out;
}

function pathM(fixes: { lat: number; lon: number }[]): number {
  let d = 0;
  let anchor = fixes[0];
  for (let i = 1; i < fixes.length; i++) {
    const step = fastDistM(anchor.lat, anchor.lon, fixes[i].lat, fixes[i].lon);
    if (step >= 15) {
      d += step;
      anchor = fixes[i];
    }
  }
  return d;
}

function finishLeg(line: AdventLine, raw: Omit<Leg, "passes" | "stalls" | "gaps" | "distM" | "maxSpeed">, open: boolean): Leg {
  const passes = passesOf(line, raw, raw.fixes.filter((f) => f.place !== "off"));
  const dep = raw.from && passes[0]?.dep != null ? passes[0].dep : raw.dep;
  const lastPass = passes[passes.length - 1];
  const arr = raw.to && lastPass?.dep === null && lastPass.arr != null ? lastPass.arr : raw.arr;
  // a GPS-sebesség, ha küld; különben a két jel közti út (10–60 mp-es közökből, a remegés nélkül)
  let speeds = raw.fixes.map((f) => f.speed).filter((s): s is number => s != null && s > 0);
  if (!speeds.length)
    for (let i = 1; i < raw.fixes.length; i++) {
      const a = raw.fixes[i - 1];
      const b = raw.fixes[i];
      const dt = b.ts - a.ts;
      if (dt >= 10 && dt <= 60) speeds.push(Math.min(25, fastDistM(a.lat, a.lon, b.lat, b.lon) / dt));
    }
  speeds = speeds.filter((v) => v < 30);
  return {
    ...raw,
    dep,
    arr,
    passes,
    stalls: stallsOf(line, raw.fixes, open),
    gaps: gapsOf(raw.fixes),
    distM: pathM(raw.fixes),
    maxSpeed: speeds.length ? Math.max(...speeds) : null,
  };
}

/**
 * A menetek a pontokból. `now`: az élő nézetben az utolsó, még tartó menet
 * „running”, ha a jel friss; a lezárt napon „lost”.
 */
export function trackDay(line: AdventLine, pings: AdventPing[], now: number): Track {
  const fixes = cleanPings(pings).map((p) => placeFix(line, p));
  const legs: Leg[] = [];
  const looseFixes: LineFix[] = [];
  let lastEnd: { end: AdventEnd; fix: LineFix } | null = null;
  let cur: { dir: "out" | "back" | null; from: AdventEnd | null; fixes: LineFix[]; best: number } | null = null;

  const close = (end: LegEnd, to: AdventEnd | null, arr: number | null, extra: LineFix[] = []) => {
    if (!cur) return;
    const fixesOfLeg = [...cur.fixes, ...extra];
    const dir = cur.dir ?? (to === "majlath" ? "out" : to === "tiszai" ? "back" : null);
    if (dir) legs.push(finishLeg(line, { dir, from: cur.from, to, dep: fixesOfLeg[0].ts, arr, end, fixes: fixesOfLeg }, end === "running"));
    else looseFixes.push(...cur.fixes);
    cur = null;
  };

  for (const f of fixes) {
    const prev: LineFix | undefined = cur?.fixes[cur.fixes.length - 1];
    if (cur && prev && f.ts - prev.ts > TRACK.lostS) close("lost", null, null);

    if (f.place === "tiszai" || f.place === "majlath") {
      if (cur) {
        if (cur.from !== f.place) close("arrived", f.place, f.ts, [f]);
        else {
          // visszaért oda, ahonnan indult: tolatás, ha közel maradt; különben visszafordult
          const far = cur.fixes.some((x) => Math.abs(x.m - f.m) >= TRACK.shuntM);
          if (far) close("turned", null, null, [f]);
          else cur = null;
        }
      }
      lastEnd = { end: f.place, fix: f };
      continue;
    }
    if (f.place === "off" && !cur) continue;

    if (!cur) {
      const from: AdventEnd | null = lastEnd && f.ts - lastEnd.fix.ts <= TRACK.lostS ? lastEnd.end : null;
      const dir: "out" | "back" | null = from === "tiszai" ? "out" : from === "majlath" ? "back" : null;
      cur = { dir, from, fixes: from && lastEnd ? [lastEnd.fix, f] : [f], best: f.m };
      lastEnd = null;
      continue;
    }

    cur.fixes.push(f);
    if (f.place !== "line") continue;
    if (!cur.dir) {
      const first = cur.fixes[0];
      if (Math.abs(f.m - first.m) >= 150) {
        cur.dir = f.m > first.m ? "out" : "back";
        cur.best = f.m;
      }
      continue;
    }
    const sign: 1 | -1 = cur.dir === "out" ? 1 : -1;
    if ((f.m - cur.best) * sign > 0) cur.best = f.m;
    else if ((cur.best - f.m) * sign >= TRACK.reverseM) {
      // visszafordult a vonal közben (pl. a Diósgyőri Gimnáziumnál): a menet itt véget ér, az új ellenkező irányú
      const turnAt = cur.fixes.findIndex((x) => x.m === cur!.best);
      const head = cur.fixes.slice(0, turnAt + 1);
      const tail = cur.fixes.slice(turnAt);
      cur.fixes = head;
      close("turned", null, null);
      cur = { dir: sign === 1 ? "back" : "out", from: null, fixes: tail, best: f.m };
    }
  }
  if (cur) {
    const lastTs = cur.fixes[cur.fixes.length - 1].ts;
    close(now - lastTs <= TRACK.lostS ? "running" : "lost", null, null);
  }
  return { fixes, legs, looseStalls: stallsOf(line, looseFixes, false), distM: fixes.length ? pathM(fixes) : 0 };
}
