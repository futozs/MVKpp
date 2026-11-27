/**
 * Az adventi villamos egy napja: a megtett menetek (track.ts) a menetrendre
 * illesztve, indulásonként ítélettel, az élő állapot 1–2 szóban, a megállónkénti
 * várható érkezés, az üzemzavarok és a nap számai. Tiszta függvény a pontokból,
 * a menetrendből és a pillanatból: a lezárt nap bármikor újraszámolható.
 */
import { fastDistM } from "../geo.ts";
import { hmOfUnix } from "../time.ts";
import { nearestStop, stopsM, type AdventLine } from "./line.ts";
import { DAY_TYPE_LABEL, END_LABEL, stopOrder, type AdventDayPlan, type AdventEnd, type AdventSeason, type AdventTripPlan } from "./season.ts";
import { TRACK, trackDay, type AdventPing, type Leg, type Stall, type Track } from "./track.ts";

export const ADVENT = {
  /** a menet illesztése a menetrendhez: ennyivel korábban / később indulhat (mp) */
  matchEarlyS: 20 * 60,
  matchLateS: 75 * 60,
  /** fordulóidő a végállomáson: a következő indulás legkorábban az érkezés után ennyivel (mp) */
  layoverS: 3 * 60,
  /** a várható indulás után: késik az indulás / nem indult / elmaradt (mp); a zsúfolt villamos 15–20 percet is késhet */
  lateDepS: 4 * 60,
  notDepartedS: 8 * 60,
  missedS: 30 * 60,
  /** a nap első indulásánál (kiállás, nyitóünnepség) ennyi türelem jár (mp) */
  firstNotDepartedS: 20 * 60,
  firstMissedS: 40 * 60,
  /** ennél régebbi jel már „nincs jel” (mp) */
  signalS: 150,
  /** a végállomáson álló villamos jele sokszor percekig hallgat: eddig nem gond (mp a várható indulás után) */
  terminusQuietS: 4 * 60,
  /** a vonalon ennyi állás után valószínű hiba, és ennyi után még inkább (mp) */
  breakdownS: 8 * 60,
  breakdownSureS: 20 * 60,
  /** az első indulás előtt ennyivel már kiállhat (mp) */
  pullOutS: 45 * 60,
  /** az utolsó érkezés után ennyi idővel a nap lezárható (mp) */
  closeAfterS: 30 * 60,
  /** a pontos indulás sávja (mp) */
  onTimeEarlyS: -60,
  onTimeLateS: 300,
  /** sorban áll: előtte ennyin belül álló villamos (m) */
  queueAheadM: 450,
  /** mögötte ennyin belül álló villamosokat tart fel (m) */
  heldBehindM: 900,
};

/**
 * done: beért · running: úton · turned: visszafordult · lost: menet közben elveszett a jele ·
 * upcoming / due / late_dep / not_departed: még nem indult · missed: elmaradt ·
 * no_data: nem jött róla jel (jel nélkül járt, vagy nem tudjuk) · cancelled: az MVK törölte
 */
export type TripVerdict = "done" | "running" | "turned" | "lost" | "upcoming" | "due" | "late_dep" | "not_departed" | "missed" | "no_data" | "cancelled";

export type TripStop = {
  stop: number;
  sched: number;
  arr: number | null;
  dep: number | null;
  /** az első megállónál indulási, máshol érkezési késés (mp) */
  delayS: number | null;
  served: boolean | null;
  dwellS: number | null;
};

export type AdventTrip = {
  n: number;
  /** stabil kulcs a napon belül: T1022 / M1105 */
  key: string;
  from: AdventEnd;
  to: AdventEnd;
  sched: { dep: number; arr: number };
  /** a várható indulás: a menetrend, vagy ha a villamos későn ért be, az érkezése + fordulóidő */
  expectedDep: number;
  verdict: TripVerdict;
  /** index a day.legs-ben */
  leg: number | null;
  dep: number | null;
  arr: number | null;
  depDelayS: number | null;
  arrDelayS: number | null;
  durS: number | null;
  stops: TripStop[];
  servedStops: number;
  maxLateS: number | null;
  maxEarlyS: number | null;
  stallS: number;
  distM: number | null;
};

export type IncidentKind = "late_dep" | "not_departed" | "missed" | "cancelled" | "stall" | "breakdown" | "turned" | "signal_lost" | "early_dep" | "not_seen" | "off_plan";

export type AdventIncident = {
  kind: IncidentKind;
  from: number;
  to: number | null;
  /** a menet kulcsa, ha menethez tartozik */
  trip: string | null;
  stop: number | null;
  lat: number | null;
  lon: number | null;
  /** rövid tény (1 sor) */
  text: string;
  severity: "info" | "warn" | "bad";
};

export type StateCode =
  | "off_season"
  | "no_service"
  | "before"
  | "pull_out"
  | "terminus"
  | "running"
  | "at_stop"
  | "stalled"
  | "held"
  | "line_down"
  | "late_dep"
  | "not_departed"
  | "breakdown"
  | "turned"
  | "depot"
  | "dropped"
  | "cancelled"
  | "arriving"
  | "no_signal"
  | "not_seen"
  | "no_data"
  | "done";

export type Confidence = "biztos" | "valószínű" | "lehet";

export type AdventPosition = {
  ts: number;
  ageS: number;
  lat: number;
  lon: number;
  m: number;
  place: string;
  dir: "out" | "back" | null;
  /** a legutóbb elhagyott / most kiszolgált megálló és a következő (index a season.stops-ban) */
  prevStop: number | null;
  nextStop: number | null;
  speed: number | null;
};

export type AdventNow = {
  code: StateCode;
  /** 1–2 szó */
  label: string;
  tone: "ok" | "warn" | "bad" | "off" | "live";
  confidence: Confidence | null;
  /** egy tény a címke alá */
  detail: string | null;
  chips: string[];
  since: number | null;
  delayS: number | null;
  position: AdventPosition | null;
  trip: string | null;
  next: { key: string; from: AdventEnd; sched: number; expected: number } | null;
};

/** a többi villamos a vonalon (a worker vetíti ugyanerre a vonalra) */
export type LineTram = { id: string; m: number; dir: "out" | "back" | null; stillS: number; ageS: number };

export type DayContext = {
  /** az MVK-adat most rendben jön (élő nézetben); a lezárt napon null */
  feedOk: boolean | null;
  /** a vonalon lévő többi villamos (csak élő nézetben) */
  trams?: LineTram[];
  /** az MVK által törölt menetek kulcsai (T1022 / M1105), a hivatalos törlés-listából */
  cancelled?: Set<string>;
};

export type StopEta = {
  stop: number;
  dir: "out" | "back";
  trip: string;
  sched: number;
  eta: number;
  /** a mostani helyzetből számolt (nem csak menetrend) */
  live: boolean;
  /** bizonytalan: áll, nincs jel, vagy hiba valószínű */
  uncertain: boolean;
};

export type DayStats = {
  plannedTrips: number;
  doneTrips: number;
  partialTrips: number;
  missedTrips: number;
  /** jel nélkül, de valószínűleg lement */
  noDataTrips: number;
  /** az MVK törölte */
  cancelledTrips: number;
  /** a GPS szerinti teljes út (m) és ebből a menetek alatt */
  distM: number;
  serviceDistM: number;
  stopsServed: number;
  stopsPassed: number;
  dwellS: number;
  longestDwell: { stop: number; s: number; ts: number; trip: string } | null;
  avgDelayS: number | null;
  maxLate: { s: number; stop: number; ts: number; trip: string } | null;
  maxEarly: { s: number; stop: number; ts: number; trip: string } | null;
  onTimeDeps: number;
  measuredDeps: number;
  stallS: number;
  stalls: number;
  longestStall: { s: number; stop: number; from: number; atStop: boolean } | null;
  maxSpeedKmh: number | null;
  avgSpeedKmh: number | null;
  fastestTrip: { key: string; s: number } | null;
  slowestTrip: { key: string; s: number } | null;
  firstDep: number | null;
  lastArr: number | null;
  /** fixek száma és a menetek alatti medián jelköz (adatminőség) */
  fixes: number;
  medianGapS: number | null;
  minutesMoving: number;
};

export type DayVerdict = "future" | "none" | "live" | "perfect" | "ok" | "late" | "partial" | "down" | "nodata";

export type AdventDay = {
  iso: string;
  dayType: string;
  note: string | null;
  special: boolean;
  trips: AdventTrip[];
  legs: Leg[];
  /** a menetrendhez nem illő menetek (próbaút, remízmenet, soron kívüli kör) */
  extraLegs: number[];
  incidents: AdventIncident[];
  stats: DayStats;
  verdict: DayVerdict;
  now: AdventNow;
  etas: StopEta[];
  /** a nap lezárható (az utolsó menet után eltelt elég idő) */
  closed: boolean;
};

const tripKey = (t: AdventTripPlan) => `${t.from === "tiszai" ? "T" : "M"}${hmOfUnix(t.dep).replace(":", "")}`;
const other = (e: AdventEnd): AdventEnd => (e === "tiszai" ? "majlath" : "tiszai");
const dirOf = (from: AdventEnd): "out" | "back" => (from === "tiszai" ? "out" : "back");
const minutes = (s: number) => Math.round(s / 60);
const signedMin = (s: number) => (s >= 0 ? `+${minutes(s)}` : `${minutes(s)}`);

/** A menetek illesztése a menetrendhez: irányonként időrendben, a legközelebbi indulásra. */
function matchLegs(plan: AdventDayPlan | null, legs: Leg[]): Map<number, number> {
  const byTrip = new Map<number, number>();
  if (!plan) return byTrip;
  const used = new Set<number>();
  legs.forEach((leg, li) => {
    if (leg.end === "turned" && leg.from === null) return; // visszafordulás utáni csonka szakasz
    let best: { n: number; d: number } | null = null;
    for (const t of plan.trips) {
      if (used.has(t.n) || dirOf(t.from) !== leg.dir) continue;
      const d = leg.dep - t.dep;
      if (d < -ADVENT.matchEarlyS || d > ADVENT.matchLateS) continue;
      // a már illesztettnél korábbi menetrendi indulást nem vesszük el (a sorrend marad)
      const lastSameDir = [...byTrip.entries()].filter(([n]) => dirOf(plan.trips[n].from) === leg.dir).map(([n]) => plan.trips[n].dep);
      if (lastSameDir.some((dep) => dep > t.dep)) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { n: t.n, d };
    }
    if (best) {
      used.add(best.n);
      byTrip.set(best.n, li);
    }
  });
  return byTrip;
}

function tripStops(season: AdventSeason, t: AdventTripPlan, leg: Leg | null): TripStop[] {
  const order = stopOrder(season, t.from);
  return order.map((stop, k) => {
    const p = leg?.passes.find((x) => x.stop === stop) ?? null;
    const sched = t.stopTimes[k];
    const at = k === 0 ? (p?.dep ?? null) : (p?.arr ?? null);
    return { stop, sched, arr: p?.arr ?? null, dep: p?.dep ?? null, delayS: at != null ? at - sched : null, served: p ? p.served : null, dwellS: p?.dwellS ?? null };
  });
}

function stallLabel(season: AdventSeason, s: Stall) {
  return `${season.stops[s.nearStop].name}${s.atStop ? "" : " közelében"}`;
}

function buildTrips(season: AdventSeason, plan: AdventDayPlan | null, track: Track, match: Map<number, number>, now: number, cancelled: Set<string>): AdventTrip[] {
  if (!plan) return [];
  const out: AdventTrip[] = [];
  // a villamos várható érkezése végállomásonként: ebből a következő indulás legkorábbi ideje
  let lastArrAt: Partial<Record<AdventEnd, number>> = {};
  // hosszú állás a vonalon, ami után nem vitt menetet: az utána következők valóban elmaradtak
  const stalls = track.legs.flatMap((l) => l.stalls).filter((x) => !x.atStop && x.to - x.from >= ADVENT.breakdownS);
  const lastLegDep = track.legs.reduce((a, l) => Math.max(a, l.dep), 0);
  const brokeAt = stalls.find((x) => x.from >= lastLegDep - 3600 && !track.legs.some((l) => l.dep > x.to))?.from ?? null;
  for (const t of plan.trips) {
    const li = match.get(t.n) ?? null;
    const leg = li != null ? track.legs[li] : null;
    const stops = tripStops(season, t, leg);
    const prevArr = lastArrAt[t.from];
    const expectedDep = Math.max(t.dep, prevArr != null ? prevArr + ADVENT.layoverS : t.dep);
    const key = tripKey(t);
    const first = t.n === 0;
    let verdict: TripVerdict;
    if (leg) verdict = leg.end === "arrived" ? "done" : leg.end === "running" ? "running" : leg.end === "turned" ? "turned" : "lost";
    else if (cancelled.has(key)) verdict = "cancelled";
    else {
      const late = now - expectedDep;
      const notDep = first ? ADVENT.firstNotDepartedS : ADVENT.notDepartedS;
      const missedAt = first ? ADVENT.firstMissedS : ADVENT.missedS;
      verdict = late < 0 ? "upcoming" : late < ADVENT.lateDepS ? "due" : late < notDep ? "late_dep" : late < missedAt ? "not_departed" : "missed";
      // elmaradt csak akkor, ha az indulás után láttuk is (nem indult el), vagy előtte lerobbant; csendben nem tudjuk
      if (verdict === "missed") {
        const seenAfter = track.fixes.some((f) => f.ts >= expectedDep && f.ts <= expectedDep + missedAt + 30 * 60);
        if (!seenAfter && !(brokeAt != null && brokeAt <= expectedDep)) verdict = "no_data";
      }
    }
    const delays = stops.map((s) => s.delayS).filter((d): d is number => d != null);
    const dep = leg ? (leg.from ? leg.dep : null) : null;
    const arr = leg?.end === "arrived" ? leg.arr : null;
    const trip: AdventTrip = {
      n: t.n,
      key,
      from: t.from,
      to: other(t.from),
      sched: { dep: t.dep, arr: t.arr },
      expectedDep,
      verdict,
      leg: li,
      dep,
      arr,
      depDelayS: dep != null ? dep - t.dep : null,
      arrDelayS: arr != null ? arr - t.arr : null,
      durS: dep != null && arr != null ? arr - dep : null,
      stops,
      servedStops: stops.filter((s) => s.served).length,
      maxLateS: delays.length ? Math.max(...delays) : null,
      maxEarlyS: delays.length ? Math.min(...delays) : null,
      stallS: leg ? leg.stalls.reduce((a, s) => a + (s.to - s.from), 0) : 0,
      distM: leg ? leg.distM : null,
    };
    out.push(trip);
    // a menet érkezése a másik végállomásra: a mért, vagy (jel nélkül) a menetrend + a legutóbbi késés
    const to = other(t.from);
    const lastDelay = Math.max(0, [...stops].reverse().find((s) => s.delayS != null)?.delayS ?? 0);
    if (arr != null) lastArrAt = { ...lastArrAt, [to]: arr };
    else if (verdict === "running" || verdict === "done") lastArrAt = { ...lastArrAt, [to]: t.arr + lastDelay };
    else if (verdict === "upcoming" || verdict === "due" || verdict === "late_dep") lastArrAt = { ...lastArrAt, [to]: t.arr + (expectedDep - t.dep) };
  }
  return out;
}

/**
 * Az elmaradtnak látszó menet, amely alatt egyetlen jel sem jött, de a villamos egy
 * későbbi menetet már vitt: valószínűleg jel nélkül járt (az OBU néha hallgat), nem
 * maradt el. Ha a jel után sem jött vissza, elmaradt marad.
 */
function creditSilent(trips: AdventTrip[], track: Track): AdventTrip[] {
  // egész nap egyetlen jel sem: nem tudjuk, járt-e (az OBU is hallgathatott)
  if (!track.fixes.length) return trips.map((t) => (t.verdict === "missed" ? { ...t, verdict: "no_data" } : t));
  const lastMatched = trips.reduce((a, t) => (t.leg != null ? t.n : a), -1);
  return trips.map((t) => {
    if (t.verdict !== "missed" || t.n > lastMatched) return t;
    const quiet = !track.fixes.some((f) => f.ts >= t.sched.dep - 5 * 60 && f.ts <= t.sched.arr + 5 * 60);
    return quiet ? { ...t, verdict: "no_data" } : t;
  });
}

function incidentsOf(season: AdventSeason, line: AdventLine, trips: AdventTrip[], track: Track, extra: number[], now: number, seenAny: boolean): AdventIncident[] {
  const out: AdventIncident[] = [];
  const stopName = (i: number) => season.stops[i].name;
  // az egymás utáni elmaradt menetek egy sorba
  for (let i = 0; i < trips.length; i++) {
    if (trips[i].verdict !== "missed") continue;
    let j = i;
    while (j + 1 < trips.length && trips[j + 1].verdict === "missed") j++;
    const a = trips[i];
    const b = trips[j];
    const text = i === j ? `${hmOfUnix(a.sched.dep)} ${END_LABEL[a.from]}: elmaradt` : `${hmOfUnix(a.sched.dep)}–${hmOfUnix(b.sched.dep)}: ${j - i + 1} menet elmaradt`;
    out.push({ kind: "missed", from: a.sched.dep, to: b.sched.arr, trip: a.key, stop: null, lat: null, lon: null, text, severity: "bad" });
    i = j;
  }
  for (const t of trips) {
    const fromName = END_LABEL[t.from];
    if (t.verdict === "cancelled")
      out.push({ kind: "cancelled", from: t.sched.dep, to: null, trip: t.key, stop: null, lat: null, lon: null, text: `${hmOfUnix(t.sched.dep)} ${fromName}: az MVK törölte`, severity: "warn" });
    if (t.verdict === "not_departed")
      out.push({ kind: "not_departed", from: t.expectedDep, to: null, trip: t.key, stop: null, lat: null, lon: null, text: `${hmOfUnix(t.sched.dep)} ${fromName}: nem indult el`, severity: "bad" });
    if (t.depDelayS != null && t.depDelayS >= ADVENT.lateDepS)
      out.push({ kind: "late_dep", from: t.sched.dep, to: t.dep, trip: t.key, stop: null, lat: null, lon: null, text: `${hmOfUnix(t.sched.dep)} ${fromName}: ${signedMin(t.depDelayS)} perccel indult`, severity: "warn" });
    if (t.depDelayS != null && t.depDelayS <= -60)
      out.push({ kind: "early_dep", from: t.dep!, to: null, trip: t.key, stop: null, lat: null, lon: null, text: `${hmOfUnix(t.sched.dep)} ${fromName}: ${Math.abs(minutes(t.depDelayS))} perccel korábban indult`, severity: "info" });
    const leg = t.leg != null ? track.legs[t.leg] : null;
    if (!leg) continue;
    for (const s of leg.stalls) {
      const dur = s.to - s.from;
      const sev = dur >= ADVENT.breakdownS && !s.atStop ? "bad" : "warn";
      out.push({
        kind: dur >= ADVENT.breakdownS && !s.atStop ? "breakdown" : "stall",
        from: s.from,
        to: s.open ? null : s.to,
        trip: t.key,
        stop: s.nearStop,
        lat: s.lat,
        lon: s.lon,
        text: `${minutes(dur)} percet állt: ${stallLabel(season, s)}`,
        severity: sev,
      });
    }
    if (leg.end === "turned") {
      const lastPass = leg.passes[leg.passes.length - 1];
      out.push({ kind: "turned", from: lastPass?.arr ?? leg.dep, to: null, trip: t.key, stop: lastPass?.stop ?? null, lat: null, lon: null, text: `Visszafordult${lastPass ? `: ${stopName(lastPass.stop)}` : ""}`, severity: "bad" });
    }
    for (const [a, b] of leg.gaps)
      if (b - a >= 10 * 60) {
        const at = leg.fixes.find((f) => f.ts === a);
        const near = at ? nearestStop(line, at.m).idx : null;
        out.push({ kind: "signal_lost", from: a, to: b, trip: t.key, stop: near, lat: at?.lat ?? null, lon: at?.lon ?? null, text: `${minutes(b - a)} percig nem jött jel${near != null ? ` (${stopName(near)} után)` : ""}`, severity: "info" });
      }
  }
  for (const li of extra) {
    const l = track.legs[li];
    if (l.end === "running" || l.distM < 1500) continue;
    out.push({ kind: "off_plan", from: l.dep, to: l.arr, trip: null, stop: null, lat: null, lon: null, text: `Menetrenden kívüli út ${hmOfUnix(l.dep)}-kor (${(l.distM / 1000).toFixed(1)} km)`, severity: "info" });
  }
  // egy elmaradt indulás utáni elmaradások egy hibához tartoznak: a legelsőhöz kötjük az okát
  const firstMiss = trips.find((t) => t.verdict === "missed" || t.verdict === "not_departed");
  if (firstMiss && !seenAny && now > firstMiss.expectedDep)
    out.push({ kind: "not_seen", from: firstMiss.sched.dep, to: null, trip: null, stop: null, lat: null, lon: null, text: "Ma még nem láttuk a villamost", severity: "warn" });
  return out.sort((a, b) => a.from - b.from);
}

function statsOf(trips: AdventTrip[], track: Track): DayStats {
  let maxLate: DayStats["maxLate"] = null;
  let maxEarly: DayStats["maxEarly"] = null;
  let longestDwell: DayStats["longestDwell"] = null;
  let stopsServed = 0;
  let stopsPassed = 0;
  let dwellS = 0;
  const delays: number[] = [];
  for (const t of trips)
    t.stops.forEach((s, k) => {
      if (s.served === true) stopsServed++;
      if (s.served === false) stopsPassed++;
      if (s.dwellS != null && s.served) {
        dwellS += s.dwellS;
        if (!longestDwell || s.dwellS > longestDwell.s) longestDwell = { stop: s.stop, s: s.dwellS, ts: s.arr ?? s.sched, trip: t.key };
      }
      // a cél-végállomás érkezése is beleszámít; a kiinduló indulása is
      if (s.delayS == null) return;
      delays.push(s.delayS);
      const ts = (k === 0 ? s.dep : s.arr) ?? s.sched;
      if (!maxLate || s.delayS > maxLate.s) maxLate = { s: s.delayS, stop: s.stop, ts, trip: t.key };
      if (!maxEarly || s.delayS < maxEarly.s) maxEarly = { s: s.delayS, stop: s.stop, ts, trip: t.key };
    });
  const legs = trips.map((t) => (t.leg != null ? track.legs[t.leg] : null)).filter((l): l is Leg => l != null);
  const stalls = legs.flatMap((l) => l.stalls);
  const longest = stalls.reduce<Stall | null>((a, s) => (!a || s.to - s.from > a.to - a.from ? s : a), null);
  const speeds = legs.map((l) => l.maxSpeed).filter((s): s is number => s != null);
  const timed = trips.filter((t) => t.durS != null) as (AdventTrip & { durS: number })[];
  const fastest = timed.reduce<AdventTrip | null>((a, t) => (!a || t.durS! < a.durS! ? t : a), null);
  const slowest = timed.reduce<AdventTrip | null>((a, t) => (!a || t.durS! > a.durS! ? t : a), null);
  const deps = trips.filter((t) => t.depDelayS != null);
  const serviceDistM = legs.reduce((a, l) => a + l.distM, 0);
  const legTime = timed.reduce((a, t) => a + t.durS, 0);
  const gaps: number[] = [];
  for (const l of legs) for (let i = 1; i < l.fixes.length; i++) gaps.push(l.fixes[i].ts - l.fixes[i - 1].ts);
  gaps.sort((a, b) => a - b);
  let moving = 0;
  for (const l of legs)
    for (let i = 1; i < l.fixes.length; i++) {
      const a = l.fixes[i - 1];
      const b = l.fixes[i];
      if (b.ts - a.ts <= 120 && fastDistM(a.lat, a.lon, b.lat, b.lon) / Math.max(1, b.ts - a.ts) > 1) moving += b.ts - a.ts;
    }
  const firstDep = trips.find((t) => t.dep != null)?.dep ?? null;
  const lastArr = [...trips].reverse().find((t) => t.arr != null)?.arr ?? null;
  return {
    plannedTrips: trips.length,
    doneTrips: trips.filter((t) => t.verdict === "done").length,
    partialTrips: trips.filter((t) => t.verdict === "turned" || t.verdict === "lost").length,
    missedTrips: trips.filter((t) => t.verdict === "missed").length,
    noDataTrips: trips.filter((t) => t.verdict === "no_data").length,
    cancelledTrips: trips.filter((t) => t.verdict === "cancelled").length,
    distM: Math.round(track.distM),
    serviceDistM: Math.round(serviceDistM),
    stopsServed,
    stopsPassed,
    dwellS,
    longestDwell,
    avgDelayS: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
    maxLate,
    maxEarly,
    onTimeDeps: deps.filter((t) => t.depDelayS! >= ADVENT.onTimeEarlyS && t.depDelayS! <= ADVENT.onTimeLateS).length,
    measuredDeps: deps.length,
    stallS: stalls.reduce((a, s) => a + (s.to - s.from), 0),
    stalls: stalls.length,
    longestStall: longest ? { s: longest.to - longest.from, stop: longest.nearStop, from: longest.from, atStop: longest.atStop } : null,
    maxSpeedKmh: speeds.length ? Math.round(Math.max(...speeds) * 3.6) : null,
    avgSpeedKmh: legTime > 0 ? Math.round((serviceDistM / legTime) * 3.6 * 10) / 10 : null,
    fastestTrip: fastest ? { key: fastest.key, s: fastest.durS! } : null,
    slowestTrip: slowest ? { key: slowest.key, s: slowest.durS! } : null,
    firstDep,
    lastArr,
    fixes: track.fixes.length,
    medianGapS: gaps.length ? gaps[gaps.length >> 1] : null,
    minutesMoving: Math.round(moving / 60),
  };
}

function positionOf(line: AdventLine, track: Track, now: number): AdventPosition | null {
  const f = track.fixes[track.fixes.length - 1];
  if (!f) return null;
  const running = track.legs.find((l) => l.end === "running");
  const dir = running?.dir ?? null;
  let prevStop: number | null = null;
  let nextStop: number | null = null;
  if (running && f.place === "line") {
    const stopM = stopsM(line, running.dir);
    const sign = running.dir === "out" ? 1 : -1;
    const order = running.dir === "out" ? [...stopM.keys()] : [...stopM.keys()].reverse();
    for (const i of order) {
      if ((f.m - stopM[i]) * sign >= -TRACK.stopZoneM) prevStop = i;
      else {
        nextStop = i;
        break;
      }
    }
  } else if (f.place === "line") prevStop = nearestStop(line, f.m).idx;
  else if (f.place === "tiszai") prevStop = 0;
  else if (f.place === "majlath") prevStop = line.stopOut.length - 1;
  return { ts: f.ts, ageS: Math.max(0, now - f.ts), lat: f.lat, lon: f.lon, m: f.m, place: f.place, dir, prevStop, nextStop, speed: f.speed };
}

/** a vonal többi villamosa: előtte álló (sorban áll), mögötte álló (feltartja), mindkét irányban álló (áll a vonal) */
function lineContext(pos: AdventPosition, trams: LineTram[]) {
  const sign = pos.dir === "back" ? -1 : 1;
  const stuck = trams.filter((t) => t.ageS <= 120 && t.stillS >= 120);
  const sameDir = stuck.filter((t) => t.dir === pos.dir);
  const ahead = sameDir.filter((t) => (t.m - pos.m) * sign > 20 && (t.m - pos.m) * sign <= ADVENT.queueAheadM);
  const behind = sameDir.filter((t) => (pos.m - t.m) * sign > 20 && (pos.m - t.m) * sign <= ADVENT.heldBehindM);
  const otherDir = stuck.filter((t) => t.dir && t.dir !== pos.dir);
  return { ahead: ahead.length, behind: behind.length, wholeLine: stuck.length >= 4 && otherDir.length >= 2 };
}

function nowState(
  season: AdventSeason,
  plan: AdventDayPlan | null,
  line: AdventLine,
  trips: AdventTrip[],
  track: Track,
  pos: AdventPosition | null,
  ctx: DayContext,
  now: number,
): AdventNow {
  const base = { chips: [] as string[], since: null, delayS: null, position: pos, trip: null, next: null, confidence: null, detail: null };
  if (!plan) return { ...base, code: "off_season", label: "Nem jár", tone: "off", detail: `Évad: ${season.start.slice(5).replace("-", ".")}.–${season.end.slice(5).replace("-", ".")}.` };
  if (!plan.trips.length) return { ...base, code: "no_service", label: "Ma nem jár", tone: "off" };

  const nextTrip = trips.find((t) => t.verdict === "upcoming" || t.verdict === "due" || t.verdict === "late_dep" || t.verdict === "not_departed");
  const next = nextTrip ? { key: nextTrip.key, from: nextTrip.from, sched: nextTrip.sched.dep, expected: nextTrip.expectedDep } : null;
  const running = trips.find((t) => t.verdict === "running");
  const runningLeg = running?.leg != null ? track.legs[running.leg] : track.legs.find((l) => l.end === "running") ?? null;
  const ageS = pos?.ageS ?? Infinity;
  const fresh = ageS <= ADVENT.signalS;
  const feedDown = ctx.feedOk === false;
  const lastTrip = trips[trips.length - 1];
  const after = (t: number) => `${hmOfUnix(t)}`;

  // vége a napnak (vagy az MVK a hátralévő meneteket törölte)
  if (trips.every((t) => !["upcoming", "due", "late_dep", "not_departed", "running"].includes(t.verdict))) {
    const firstCancelled = trips.findIndex((t) => t.verdict === "cancelled");
    if (firstCancelled >= 0 && trips.slice(firstCancelled).every((t) => t.verdict === "cancelled") && now < lastTrip.sched.arr)
      return { ...base, code: "cancelled", label: "Ma már nem jár", tone: "warn", confidence: "biztos", detail: "Az MVK törölte a hátralévő meneteket", chips: [`${trips.length - firstCancelled} menet törölve`] };
    const missed = trips.filter((t) => t.verdict === "missed").length;
    const chips = missed ? [`${missed} menet elmaradt`] : [];
    return { ...base, code: "done", label: "Mára végzett", tone: missed ? "warn" : "off", chips, since: lastTrip.arr ?? lastTrip.sched.arr, next: null, detail: lastTrip.arr ? `Beért ${after(lastTrip.arr)}` : null };
  }
  const cancelledSoon = trips.filter((t) => t.verdict === "cancelled" && t.sched.dep >= now - 3600 && (!nextTrip || t.sched.dep <= nextTrip.sched.dep)).length;
  const officialChip = cancelledSoon ? [`${cancelledSoon} menet törölve (MVK)`] : [];

  // menet közben
  if (runningLeg && pos && pos.place !== "tiszai" && pos.place !== "majlath") {
    const lastStop = running ? [...running.stops].reverse().find((s) => s.delayS != null) : null;
    let delayS = lastStop?.delayS ?? null;
    // ha a következő megálló menetrendi ideje már elmúlt, a késés legalább ennyi
    if (running && pos.nextStop != null) {
      const ns = running.stops.find((s) => s.stop === pos.nextStop);
      if (ns && now - ns.sched > (delayS ?? -Infinity)) delayS = now - ns.sched;
    }
    const stall = runningLeg.stalls.find((s) => s.open) ?? null;
    const where = pos.nextStop != null ? `→ ${season.stops[pos.nextStop].name}` : pos.prevStop != null ? season.stops[pos.prevStop].name : null;
    const common = { ...base, delayS, trip: running?.key ?? null, next };
    if (!fresh) {
      if (feedDown) return { ...common, code: "no_data", label: "Nincs adat", tone: "warn", detail: "Most nem jön adat az MVK-tól", chips: [`utoljára ${after(pos.ts)}`] };
      const before = runningLeg.stalls[runningLeg.stalls.length - 1];
      if (before && !before.atStop && pos.ts - before.to <= 60 && before.to - before.from >= ADVENT.breakdownS)
        return { ...common, code: "breakdown", label: "Valószínű hiba", tone: "bad", confidence: "valószínű", since: before.from, detail: stallLabel(season, before), chips: [`${minutes(before.to - before.from)} percig állt`, "azóta nincs jel"] };
      // a végállomás előtti utolsó szakaszon a villamosok jele rendszeresen percekre elhallgat
      const order = stopOrder(season, runningLeg.dir === "out" ? "tiszai" : "majlath");
      const left = pos.nextStop != null ? order.length - order.indexOf(pos.nextStop) : 0;
      if (left > 0 && left <= 5 && ageS <= 25 * 60)
        return { ...common, code: "arriving", label: "Beérkezőben", tone: "live", detail: `${END_LABEL[runningLeg.dir === "out" ? "majlath" : "tiszai"]} felé`, chips: ["jel nélkül, becsült"] };
      return { ...common, code: "no_signal", label: "Nincs jel", tone: "warn", since: pos.ts, detail: pos.prevStop != null ? `Utoljára: ${season.stops[pos.prevStop].name}` : null, chips: [`${minutes(ageS)} perce`] };
    }
    if (stall) {
      const dur = now - stall.from;
      const ctxLine = ctx.trams ? lineContext(pos, ctx.trams) : null;
      const chips = [`${minutes(dur)} perce áll`];
      if (ctxLine?.behind) chips.push(`mögötte ${ctxLine.behind} villamos`);
      const place = stallLabel(season, stall);
      if (ctxLine?.wholeLine) return { ...common, code: "line_down", label: "Áll a vonal", tone: "warn", since: stall.from, detail: place, chips: [...chips, "nem csak ő áll"] };
      if (ctxLine?.ahead) return { ...common, code: "held", label: "Sorban áll", tone: "warn", since: stall.from, detail: place, chips: [...chips, "előtte is áll villamos"] };
      if (dur >= ADVENT.breakdownS && !stall.atStop) {
        const confidence: Confidence = dur >= ADVENT.breakdownSureS || (ctxLine?.behind ?? 0) >= 2 ? "valószínű" : "lehet";
        return { ...common, code: "breakdown", label: "Valószínű hiba", tone: "bad", confidence, since: stall.from, detail: place, chips };
      }
      return { ...common, code: "stalled", label: "Áll", tone: "warn", since: stall.from, detail: place, chips };
    }
    const atStop = pos.prevStop != null && Math.abs(stopsM(line, runningLeg.dir)[pos.prevStop] - pos.m) <= TRACK.stopZoneM + 10 && (pos.speed ?? 0) <= TRACK.stopSpeed;
    const late = delayS != null && delayS >= 180;
    const early = delayS != null && delayS <= -90;
    const label = late ? `+${minutes(delayS!)} perc` : early ? "Siet" : "Úton";
    return {
      ...common,
      code: atStop ? "at_stop" : "running",
      label: atStop ? "Megállóban" : label,
      tone: late && delayS! >= 600 ? "bad" : late ? "warn" : "live",
      detail: atStop && pos.prevStop != null ? season.stops[pos.prevStop].name : where,
      chips: atStop && (late || early) ? [label] : [],
    };
  }

  // nem menet közben: végállomáson, remízben, vonalon menet nélkül, vagy nem látjuk
  if (feedDown && !fresh) return { ...base, code: "no_data", label: "Nincs adat", tone: "warn", next, detail: "Most nem jön adat az MVK-tól" };
  const nt = nextTrip!;
  const lateBy = now - nt.expectedDep;
  const minsLate = minutes(lateBy);
  const atEnd = pos && (pos.place === "tiszai" || pos.place === "majlath") ? (pos.place as AdventEnd) : null;
  const firstTrip = trips[0];
  const seenToday = track.fixes.length > 0;
  const departs = `Indul ${after(nt.expectedDep)}`;
  const firstPending = nt.n === firstTrip.n;
  const notDepS = firstPending ? ADVENT.firstNotDepartedS : ADVENT.notDepartedS;
  // a közvetlenül előtte lévő, egymás utáni elmaradt indulások (csak ami bizonyítottan elmaradt)
  let missedRun = 0;
  for (let i = nt.n - 1; i >= 0 && trips[i].verdict === "missed"; i--) missedRun++;
  const lostNow = missedRun + (lateBy >= notDepS ? 1 : 0);
  const lastLeg = track.legs[track.legs.length - 1];
  const longStall = track.legs.flatMap((l) => l.stalls).find((x) => !x.atStop && x.to - x.from >= ADVENT.breakdownS && (!lastLeg || x.from >= lastLeg.dep)) ?? null;
  const midLine = Boolean(pos && (pos.place === "line" || pos.place === "off"));
  const lastSeen = pos ? `utoljára ${after(pos.ts)}${pos.prevStop != null ? `, ${season.stops[pos.prevStop].name}` : ""}` : "ma még nincs jel";

  // a vonalon hosszan állt, aztán elhallgatott vagy nem indult tovább: ez a legerősebb jel
  if (longStall && (lostNow >= 1 || (midLine && !fresh)))
    return {
      ...base,
      code: "breakdown",
      label: "Valószínű hiba",
      tone: "bad",
      confidence: lostNow >= 2 || !fresh ? "valószínű" : "lehet",
      next,
      since: longStall.from,
      detail: stallLabel(season, longStall),
      chips: [`${minutes(longStall.to - longStall.from)} percig állt`, lostNow ? `${lostNow} indulás maradt el` : "azóta nincs jel", "pótlás nincs"],
    };
  // látjuk, de nem indul: két kimaradt indulás után már kiesett (az ok lehet hiba vagy lezárás is)
  if (fresh && lostNow >= 2)
    return { ...base, code: "dropped", label: "Kiesett", tone: "bad", confidence: "valószínű", next, since: trips[nt.n - missedRun]?.sched.dep ?? nt.sched.dep, detail: atEnd ? `${END_LABEL[atEnd]}nál áll` : lastSeen, chips: [`${lostNow} indulás maradt el`, "hiba vagy lezárás?", "pótlás nincs", ...officialChip] };
  // jel nélkül: soha nem piros, mert a végállomáson és beérkezés előtt percekig hallgathat
  // (ha a végállomáson hallgat el, de a következő indulás a másik végről lenne, nem tudjuk, hol jár)
  const lostTrack = (midLine && lastLeg?.end === "lost") || (atEnd != null && atEnd !== nt.from) || trips[nt.n - 1]?.verdict === "no_data";
  if (!fresh && seenToday && (lateBy >= notDepS || lostTrack))
    return { ...base, code: "no_signal", label: "Nincs jel", tone: "warn", next, since: pos?.ts ?? null, detail: lateBy >= notDepS ? `${after(nt.sched.dep)}-kor indulnia kellett` : lastSeen, chips: [lastSeen, ...officialChip] };

  if (lateBy < 0) {
    const chips = [...(missedRun ? [`${missedRun} menet elmaradt`] : []), ...officialChip];
    if (firstPending && !seenToday) return { ...base, code: "before", label: `Ma ${after(firstTrip.sched.dep)}`, tone: "off", next, detail: `${END_LABEL[firstTrip.from]}ról indul`, chips };
    if (atEnd === "tiszai" && (now < nt.expectedDep - 40 * 60 || nt.from !== "tiszai")) return { ...base, code: "depot", label: "Remízben", tone: "off", next, detail: departs, chips };
    if (atEnd) return { ...base, code: "terminus", label: "Végállomáson", tone: "ok", next, detail: departs, chips };
    if (pos && pos.place === "line" && fresh) return { ...base, code: "pull_out", label: "Úton", tone: "live", next, detail: `a végállomásra · ${departs.toLowerCase()}`, chips };
    return { ...base, code: "terminus", label: "Fordulóban", tone: "ok", next, detail: departs, chips: [...chips, ...(fresh ? [] : ["jel nélkül"])] };
  }

  // a várható indulás elmúlt, de még nem indult el: pár percig ez rendes (beszállás, ünnepség)
  if (lateBy < ADVENT.lateDepS)
    return { ...base, code: "terminus", label: "Végállomáson", tone: "ok", next, detail: "Indul most", chips: !seenToday ? ["még nincs jel"] : fresh ? officialChip : ["jel nélkül", ...officialChip] };
  if (!seenToday && ctx.feedOk !== false && lateBy >= 10 * 60)
    return { ...base, code: "not_seen", label: "Nem látjuk", tone: "warn", confidence: "lehet", next, detail: "Lehet, hogy jár, csak nem küld jelet", chips: [`${after(nt.sched.dep)} indulás`, ...officialChip] };
  if (lateBy < notDepS) return { ...base, code: "late_dep", label: "Késik az indulás", tone: "warn", next, since: nt.expectedDep, detail: `${after(nt.sched.dep)} helyett`, chips: [`${minsLate} perce`, ...officialChip] };
  // friss jellel áll, és nem indul: ez már nem csend, hanem tény
  return {
    ...base,
    code: "not_departed",
    label: "Nem indult",
    tone: "bad",
    confidence: lateBy >= (firstPending ? ADVENT.firstMissedS : ADVENT.missedS) ? "valószínű" : "lehet",
    next,
    since: nt.expectedDep,
    detail: `${after(nt.sched.dep)} · ${END_LABEL[nt.from]}`,
    chips: [`${minsLate} perce`, atEnd ? `${END_LABEL[atEnd]}nál áll` : "jel van", ...officialChip],
  };
}

/** megállónként a következő áthaladások (élő helyzet + menetrend, fordulóidővel) */
function etasOf(trips: AdventTrip[], now: AdventNow, nowTs: number): StopEta[] {
  const out: StopEta[] = [];
  const uncertain = ["stalled", "breakdown", "no_signal", "not_departed", "not_seen", "no_data", "line_down", "depot"].includes(now.code);
  let arrAt: Partial<Record<AdventEnd, number>> = {};
  for (const t of trips) {
    // a törölt menet nem jön; a jel nélküli már fél órája elindult volna, a mostra tolt ideje kitalált lenne
    if (t.verdict === "done" || t.verdict === "missed" || t.verdict === "turned" || t.verdict === "lost" || t.verdict === "cancelled" || t.verdict === "no_data") continue;
    const dir = dirOf(t.from);
    if (t.verdict === "running") {
      const delay = Math.max(0, now.delayS ?? 0);
      for (const s of t.stops) {
        if (s.arr != null || s.dep != null) continue;
        out.push({ stop: s.stop, dir, trip: t.key, sched: s.sched, eta: Math.max(nowTs, s.sched + delay), live: true, uncertain });
      }
      arrAt = { ...arrAt, [t.to]: Math.max(nowTs, t.sched.arr + delay) };
      continue;
    }
    const prev = arrAt[t.from];
    const dep = Math.max(t.expectedDep, prev != null ? prev + ADVENT.layoverS : 0, t.verdict === "upcoming" ? 0 : nowTs);
    const shift = dep - t.sched.dep;
    for (const s of t.stops) out.push({ stop: s.stop, dir, trip: t.key, sched: s.sched, eta: s.sched + shift, live: shift > 0, uncertain: uncertain || t.verdict === "not_departed" });
    arrAt = { ...arrAt, [t.to]: t.sched.arr + shift };
  }
  return out;
}

function verdictOf(plan: AdventDayPlan | null, trips: AdventTrip[], stats: DayStats, incidents: AdventIncident[], closed: boolean, now: number): DayVerdict {
  if (!plan || !plan.trips.length) return "none";
  if (now < plan.trips[0].dep - ADVENT.pullOutS) return "future";
  if (!closed) return "live";
  if (!stats.fixes) return "nodata";
  const lost = stats.missedTrips + stats.partialTrips;
  if (lost * 2 >= trips.length || incidents.some((i) => i.kind === "breakdown")) return "down";
  if (lost) return "partial";
  const late = trips.some((t) => (t.maxLateS ?? 0) >= 10 * 60);
  if (late) return "late";
  return stats.onTimeDeps === stats.measuredDeps && !incidents.some((i) => i.severity !== "info") ? "perfect" : "ok";
}

export function adventDay(season: AdventSeason, plan: AdventDayPlan | null, iso: string, line: AdventLine, pings: AdventPing[], now: number, ctx: DayContext = { feedOk: null }): AdventDay {
  const track = trackDay(line, pings, now);
  const match = matchLegs(plan, track.legs);
  const trips = creditSilent(buildTrips(season, plan, track, match, now, ctx.cancelled ?? new Set()), track);
  const matchedLegs = new Set(match.values());
  const extraLegs = track.legs.map((_, i) => i).filter((i) => !matchedLegs.has(i));
  const lastSched = plan?.trips.length ? plan.trips[plan.trips.length - 1].arr : null;
  const closed = lastSched != null ? now >= lastSched + ADVENT.closeAfterS && !trips.some((t) => t.verdict === "running") : now > 0;
  const incidents = incidentsOf(season, line, trips, track, extraLegs, now, track.fixes.length > 0);
  const stats = statsOf(trips, track);
  const pos = positionOf(line, track, now);
  const state = nowState(season, plan, line, trips, track, pos, ctx, now);
  return {
    iso,
    dayType: plan ? DAY_TYPE_LABEL[plan.type] : "",
    note: plan?.note ?? null,
    special: plan?.special ?? false,
    trips,
    legs: track.legs,
    extraLegs,
    incidents,
    stats,
    verdict: verdictOf(plan, trips, stats, incidents, closed, now),
    now: state,
    etas: etasOf(trips, state, now),
    closed,
  };
}
