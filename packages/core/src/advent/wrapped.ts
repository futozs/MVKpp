/**
 * A Wrapped-összegző lapjai: a nap (vagy az évad) számaiból rövid, kártyára
 * tehető tények. Itt csak a tartalom készül (szám, mértékegység, egy sor), a
 * kinézet a nézeté; így egy későbbi külön oldal is ugyanezt kapja.
 */
import { hmOfUnix } from "../time.ts";
import type { AdventDay } from "./day.ts";
import type { SeasonSummary } from "./seasonStats.ts";
import { END_LABEL, type AdventSeason } from "./season.ts";

export type WrappedCard = {
  id: string;
  /** a nagy szám vagy szó */
  big: string;
  unit: string | null;
  title: string;
  /** egy sor magyarázat vagy összevetés */
  line: string | null;
  tone: "gold" | "ok" | "warn" | "bad";
};

const fmt = (n: number, d = 0) => n.toLocaleString("hu-HU", { maximumFractionDigits: d, minimumFractionDigits: d });
const mins = (s: number) => Math.round(s / 60);

/** a vonal hossza (km): ennyiszer tett meg egy teljes menetet */
const LINE_KM = 10.6;

export function dayCards(season: AdventSeason, day: AdventDay, dayNo: number | null): WrappedCard[] {
  const s = day.stats;
  const cards: WrappedCard[] = [];
  const km = s.serviceDistM / 1000;
  cards.push({
    id: "cover",
    big: day.verdict === "perfect" ? "Hibátlan" : day.verdict === "down" ? "Lerobbant" : day.verdict === "partial" ? "Félbemaradt" : day.verdict === "late" ? "Késős" : day.verdict === "nodata" ? "Nincs adat" : "Megvolt",
    unit: null,
    title: `${dayNo ? `${dayNo}. nap · ` : ""}${day.dayType}`,
    line: day.note,
    tone: day.verdict === "down" || day.verdict === "partial" ? "bad" : day.verdict === "late" ? "warn" : "gold",
  });
  cards.push({ id: "trips", big: `${s.doneTrips}/${s.plannedTrips}`, unit: "menet", title: "Végigment", line: s.missedTrips ? `${s.missedTrips} elmaradt` : s.noDataTrips ? `${s.noDataTrips} jel nélkül` : "Mind lement", tone: s.missedTrips ? "bad" : "gold" });
  if (km > 0) cards.push({ id: "km", big: fmt(km, 1), unit: "km", title: "Megtett út", line: `${fmt(km / LINE_KM, 1)}× végig a vonalon`, tone: "gold" });
  if (s.stopsServed) cards.push({ id: "stops", big: fmt(s.stopsServed), unit: "megállás", title: "Megállóban", line: s.longestDwell ? `A leghosszabb: ${season.stops[s.longestDwell.stop].name}, ${mins(s.longestDwell.s) || 1} perc` : null, tone: "gold" });
  if (s.measuredDeps)
    cards.push({
      id: "punctual",
      big: `${s.onTimeDeps}/${s.measuredDeps}`,
      unit: "pontos indulás",
      title: "Pontosság",
      line: s.maxLate && s.maxLate.s >= 120 ? `A legtöbb: +${mins(s.maxLate.s)} perc, ${season.stops[s.maxLate.stop].name}, ${hmOfUnix(s.maxLate.ts)}` : "Végig tartotta a menetrendet",
      tone: s.onTimeDeps === s.measuredDeps ? "ok" : "warn",
    });
  if (s.maxEarly && s.maxEarly.s <= -60) cards.push({ id: "early", big: `${mins(-s.maxEarly.s)}`, unit: "perccel korábban", title: "Sietett", line: `${season.stops[s.maxEarly.stop].name}, ${hmOfUnix(s.maxEarly.ts)}`, tone: "warn" });
  if (s.fastestTrip) {
    const t = day.trips.find((x) => x.key === s.fastestTrip!.key);
    cards.push({ id: "fastest", big: `${mins(s.fastestTrip.s)}`, unit: "perc", title: "A leggyorsabb kör", line: t ? `${hmOfUnix(t.sched.dep)}, ${END_LABEL[t.from]}ról` : null, tone: "gold" });
  }
  if (s.stallS >= 60) cards.push({ id: "stall", big: `${mins(s.stallS)}`, unit: "perc", title: "Állt a vonalon", line: s.longestStall ? `A leghosszabb: ${season.stops[s.longestStall.stop].name}, ${mins(s.longestStall.s)} perc` : null, tone: s.longestStall && s.longestStall.s >= 8 * 60 ? "bad" : "warn" });
  if (s.maxSpeedKmh) cards.push({ id: "speed", big: `${s.maxSpeedKmh}`, unit: "km/h", title: "Csúcssebesség", line: s.avgSpeedKmh ? `Átlagosan ${fmt(s.avgSpeedKmh, 1)} km/h` : null, tone: "gold" });
  if (s.firstDep && s.lastArr) cards.push({ id: "hours", big: `${hmOfUnix(s.firstDep)}–${hmOfUnix(s.lastArr)}`, unit: null, title: "Úton volt", line: `${fmt(s.minutesMoving)} percet gurult`, tone: "gold" });
  return cards;
}

export function seasonCards(season: AdventSeason, sum: SeasonSummary): WrappedCard[] {
  const t = sum.totals;
  const r = sum.records;
  const cards: WrappedCard[] = [
    { id: "cover", big: `${season.edition}.`, unit: "adventi villamos", title: `${season.title} · ${season.year}`, line: `${t.daysRun} nap, ${t.tripsDone} menet`, tone: "gold" },
    { id: "km", big: fmt(t.serviceKm, 0), unit: "km", title: "Az évad útja", line: `${fmt(t.serviceKm / LINE_KM, 0)}× végig a vonalon`, tone: "gold" },
    { id: "trips", big: `${t.tripsDone}/${t.tripsPlanned}`, unit: "menet", title: "Végigment", line: t.tripsMissed ? `${t.tripsMissed} elmaradt` : "Egy sem maradt el", tone: t.tripsMissed ? "warn" : "ok" },
    { id: "stops", big: fmt(t.stopsServed), unit: "megállás", title: "Megállóban", line: `${fmt(t.dwellMin)} percet állt megállókban`, tone: "gold" },
  ];
  if (t.measuredDeps) cards.push({ id: "punctual", big: `${Math.round((t.onTimeDeps / t.measuredDeps) * 100)}%`, unit: "pontos indulás", title: "Pontosság", line: r.maxLate ? `A legtöbb késés: +${mins(r.maxLate.s)} perc (${r.maxLate.iso.slice(5).replace("-", ".")}.)` : null, tone: "gold" });
  if (r.bestStreak) cards.push({ id: "streak", big: `${r.bestStreak.days}`, unit: "nap", title: "Hibátlan sorozat", line: `${r.bestStreak.from.slice(5).replace("-", ".")}.–${r.bestStreak.to.slice(5).replace("-", ".")}.`, tone: "ok" });
  if (t.breakdowns || t.tripsMissed) cards.push({ id: "trouble", big: `${t.breakdowns}`, unit: "valószínű hiba", title: "Zavarok", line: `${t.tripsMissed} elmaradt menet, ${fmt(t.stallMin)} perc állás`, tone: "bad" });
  if (r.fastestTrip) cards.push({ id: "fastest", big: `${mins(r.fastestTrip.s)}`, unit: "perc", title: "A leggyorsabb kör", line: `${r.fastestTrip.iso.slice(5).replace("-", ".")}.`, tone: "gold" });
  if (r.maxSpeed) cards.push({ id: "speed", big: `${r.maxSpeed.kmh}`, unit: "km/h", title: "Csúcssebesség", line: `${r.maxSpeed.iso.slice(5).replace("-", ".")}.`, tone: "gold" });
  return cards;
}
