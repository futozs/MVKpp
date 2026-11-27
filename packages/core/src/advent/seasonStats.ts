/**
 * Az évad összesítése a napokból: naptár, összesen, rekordok, megállónkénti és
 * indulásonkénti megbízhatóság, sorozatok. Az évadok közti összevetés ugyanebből
 * készül (évadonként egy összesítés).
 */
import type { AdventDay, DayStats, DayVerdict, TripVerdict } from "./day.ts";
import { DAY_TYPE_LABEL, dayPlan, seasonDays, type AdventSeason } from "./season.ts";

export type SeasonDay = {
  iso: string;
  verdict: DayVerdict;
  dayType: string;
  note: string | null;
  special: boolean;
  planned: number;
  stats: DayStats | null;
  incidents: number;
  badIncidents: number;
  trips: { key: string; verdict: TripVerdict; depDelayS: number | null; arrDelayS: number | null; durS: number | null; maxLateS: number | null }[];
};

type Rec<T = Record<string, never>> = ({ iso: string } & T) | null;

export type StopAgg = { stop: number; dir: "out" | "back"; n: number; avgDelayS: number | null; avgDwellS: number | null; served: number; passed: number };
export type SlotAgg = { key: string; planned: number; done: number; missed: number; avgDepDelayS: number | null; avgDurS: number | null };

export type SeasonSummary = {
  year: number;
  days: SeasonDay[];
  totals: {
    days: number;
    daysRun: number;
    perfectDays: number;
    tripsPlanned: number;
    tripsDone: number;
    tripsPartial: number;
    tripsMissed: number;
    tripsNoData: number;
    distKm: number;
    serviceKm: number;
    stopsServed: number;
    dwellMin: number;
    movingMin: number;
    stallMin: number;
    stalls: number;
    avgDelayS: number | null;
    onTimeDeps: number;
    measuredDeps: number;
    incidents: number;
    breakdowns: number;
  };
  records: {
    fastestTrip: Rec<{ key: string; s: number }>;
    slowestTrip: Rec<{ key: string; s: number }>;
    maxLate: Rec<{ s: number; stop: number; ts: number }>;
    maxEarly: Rec<{ s: number; stop: number; ts: number }>;
    longestStall: Rec<{ s: number; stop: number; from: number }>;
    longestDwell: Rec<{ s: number; stop: number; ts: number }>;
    mostKm: Rec<{ km: number }>;
    maxSpeed: Rec<{ kmh: number }>;
    /** a leghosszabb hibátlan sorozat (napok) és a mostani */
    bestStreak: { from: string; to: string; days: number } | null;
    streakNow: number;
  };
  stops: StopAgg[];
  slots: SlotAgg[];
};

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function seasonDayOf(day: AdventDay): SeasonDay {
  return {
    iso: day.iso,
    verdict: day.verdict,
    dayType: day.dayType,
    note: day.note,
    special: day.special,
    planned: day.trips.length,
    stats: day.stats,
    incidents: day.incidents.length,
    badIncidents: day.incidents.filter((i) => i.severity === "bad").length,
    trips: day.trips.map((t) => ({ key: t.key, verdict: t.verdict, depDelayS: t.depDelayS, arrDelayS: t.arrDelayS, durS: t.durS, maxLateS: t.maxLateS })),
  };
}

/** a hibátlan nap: lement minden menet, nem volt komoly zavar */
const clean = (d: SeasonDay) => d.verdict === "perfect" || d.verdict === "ok" || d.verdict === "late";

export function seasonSummary(season: AdventSeason, analysed: AdventDay[]): SeasonSummary {
  const byIso = new Map(analysed.map((d) => [d.iso, d]));
  const days: SeasonDay[] = seasonDays(season).map((iso) => {
    const d = byIso.get(iso);
    if (d) return seasonDayOf(d);
    const plan = dayPlan(season, iso);
    return { iso, verdict: "future", dayType: plan ? DAY_TYPE_LABEL[plan.type] : "", note: plan?.note ?? null, special: plan?.special ?? false, planned: plan?.trips.length ?? 0, stats: null, incidents: 0, badIncidents: 0, trips: [] };
  });
  const past = analysed.filter((d) => d.verdict !== "future" && d.verdict !== "none");
  const st = past.map((d) => d.stats);
  const sum = (f: (s: DayStats) => number) => st.reduce((a, s) => a + f(s), 0);

  const records: SeasonSummary["records"] = {
    fastestTrip: null,
    slowestTrip: null,
    maxLate: null,
    maxEarly: null,
    longestStall: null,
    longestDwell: null,
    mostKm: null,
    maxSpeed: null,
    bestStreak: null,
    streakNow: 0,
  };
  for (const d of past) {
    const s = d.stats;
    const fast = s.fastestTrip;
    const slow = s.slowestTrip;
    if (fast && (!records.fastestTrip || fast.s < records.fastestTrip.s)) records.fastestTrip = { iso: d.iso, key: fast.key, s: fast.s };
    if (slow && (!records.slowestTrip || slow.s > records.slowestTrip.s)) records.slowestTrip = { iso: d.iso, key: slow.key, s: slow.s };
    if (s.maxLate && (!records.maxLate || s.maxLate.s > records.maxLate.s)) records.maxLate = { iso: d.iso, s: s.maxLate.s, stop: s.maxLate.stop, ts: s.maxLate.ts };
    if (s.maxEarly && (!records.maxEarly || s.maxEarly.s < records.maxEarly.s)) records.maxEarly = { iso: d.iso, s: s.maxEarly.s, stop: s.maxEarly.stop, ts: s.maxEarly.ts };
    if (s.longestStall && (!records.longestStall || s.longestStall.s > records.longestStall.s)) records.longestStall = { iso: d.iso, s: s.longestStall.s, stop: s.longestStall.stop, from: s.longestStall.from };
    if (s.longestDwell && (!records.longestDwell || s.longestDwell.s > records.longestDwell.s)) records.longestDwell = { iso: d.iso, s: s.longestDwell.s, stop: s.longestDwell.stop, ts: s.longestDwell.ts };
    const km = Math.round(s.serviceDistM / 100) / 10;
    if (km > 0 && (!records.mostKm || km > records.mostKm.km)) records.mostKm = { iso: d.iso, km };
    if (s.maxSpeedKmh && (!records.maxSpeed || s.maxSpeedKmh > records.maxSpeed.kmh)) records.maxSpeed = { iso: d.iso, kmh: s.maxSpeedKmh };
  }
  // hibátlan sorozatok a lezárt napokon
  let runFrom = "";
  let runDays = 0;
  for (const d of days) {
    if (d.verdict === "future" || d.verdict === "live" || d.verdict === "none") continue;
    if (!clean(d)) {
      runDays = 0;
      continue;
    }
    if (!runDays) runFrom = d.iso;
    runDays++;
    if (!records.bestStreak || runDays > records.bestStreak.days) records.bestStreak = { from: runFrom, to: d.iso, days: runDays };
  }
  records.streakNow = runDays;

  const stopRows = new Map<string, { delays: number[]; dwells: number[]; served: number; passed: number; stop: number; dir: "out" | "back" }>();
  const slotRows = new Map<string, { planned: number; done: number; missed: number; deps: number[]; durs: number[] }>();
  for (const d of past)
    for (const t of d.trips) {
      const slot = slotRows.get(t.key) ?? { planned: 0, done: 0, missed: 0, deps: [], durs: [] };
      slot.planned++;
      if (t.verdict === "done") slot.done++;
      if (t.verdict === "missed") slot.missed++;
      if (t.depDelayS != null) slot.deps.push(t.depDelayS);
      if (t.durS != null) slot.durs.push(t.durS);
      slotRows.set(t.key, slot);
      const dir = t.from === "tiszai" ? "out" : "back";
      for (const s of t.stops) {
        const k = `${dir}|${s.stop}`;
        const row = stopRows.get(k) ?? { delays: [], dwells: [], served: 0, passed: 0, stop: s.stop, dir };
        if (s.delayS != null) row.delays.push(s.delayS);
        if (s.dwellS != null && s.served) row.dwells.push(s.dwellS);
        if (s.served === true) row.served++;
        if (s.served === false) row.passed++;
        stopRows.set(k, row);
      }
    }

  return {
    year: season.year,
    days,
    totals: {
      days: days.length,
      daysRun: past.filter((d) => d.stats.doneTrips + d.stats.partialTrips > 0).length,
      perfectDays: past.filter((d) => d.verdict === "perfect").length,
      tripsPlanned: sum((s) => s.plannedTrips),
      tripsDone: sum((s) => s.doneTrips),
      tripsPartial: sum((s) => s.partialTrips),
      tripsMissed: sum((s) => s.missedTrips),
      tripsNoData: sum((s) => s.noDataTrips),
      distKm: Math.round(sum((s) => s.distM) / 100) / 10,
      serviceKm: Math.round(sum((s) => s.serviceDistM) / 100) / 10,
      stopsServed: sum((s) => s.stopsServed),
      dwellMin: Math.round(sum((s) => s.dwellS) / 60),
      movingMin: sum((s) => s.minutesMoving),
      stallMin: Math.round(sum((s) => s.stallS) / 60),
      stalls: sum((s) => s.stalls),
      avgDelayS: avg(st.map((s) => s.avgDelayS).filter((x): x is number => x != null)),
      onTimeDeps: sum((s) => s.onTimeDeps),
      measuredDeps: sum((s) => s.measuredDeps),
      incidents: past.reduce((a, d) => a + d.incidents.filter((i) => i.severity !== "info").length, 0),
      breakdowns: past.reduce((a, d) => a + d.incidents.filter((i) => i.kind === "breakdown").length, 0),
    },
    records,
    stops: [...stopRows.values()]
      .map((r) => ({ stop: r.stop, dir: r.dir, n: r.delays.length, avgDelayS: avg(r.delays), avgDwellS: avg(r.dwells), served: r.served, passed: r.passed }))
      .sort((a, b) => (a.dir === b.dir ? a.stop - b.stop : a.dir === "out" ? -1 : 1)),
    slots: [...slotRows.entries()]
      .map(([key, r]) => ({ key, planned: r.planned, done: r.done, missed: r.missed, avgDepDelayS: avg(r.deps), avgDurS: avg(r.durs) }))
      .sort((a, b) => a.key.slice(1).localeCompare(b.key.slice(1)) || a.key.localeCompare(b.key)),
  };
}

/** „T1022” → „10:22 Tiszai” jellegű rövid felirat */
export function slotLabel(key: string): string {
  return `${key.slice(1, 3)}:${key.slice(3, 5)} ${key[0] === "T" ? "Tiszai" : "Majláth"}`;
}
