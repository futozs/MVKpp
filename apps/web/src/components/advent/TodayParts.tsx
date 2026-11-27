import { AlertTriangle, ArrowLeft, ArrowRight, ChevronDown, CircleSlash, Info, Wrench } from "lucide-react";
import type { AdventIncident, AdventTrip } from "@mvk/core/advent/day";
import { END_LABEL } from "@mvk/core/advent/season";
import { cn } from "@/lib/utils";
import type { PublicDay, SeasonMeta } from "./adventApi";
import { delayTone, hm, km, signedMin, TRIP_LABEL } from "./adventText";

/** A nap indulásai egy sorban: kész (késéssel), úton, következő, elmaradt. */
export function DeparturePills({ day, selected, onSelect }: { day: PublicDay; selected: string | null; onSelect: (key: string | null) => void }) {
  const next = day.trips.find((t) => ["upcoming", "due", "late_dep", "not_departed"].includes(t.verdict));
  return (
    <ul className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden" aria-label="A nap indulásai">
      {day.trips.map((t) => {
        const bad = t.verdict === "missed" || t.verdict === "not_departed";
        const running = t.verdict === "running";
        const isNext = t === next;
        const done = t.verdict === "done";
        const delay = t.arrDelayS ?? t.depDelayS;
        return (
          <li key={t.key} className="shrink-0">
            <button
              type="button"
              onClick={() => onSelect(selected === t.key ? null : t.key)}
              aria-pressed={selected === t.key}
              className={cn(
                "flex h-11 flex-col items-start justify-center rounded-lg border px-2.5 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                running
                  ? "border-advent-gold bg-advent-gold/15"
                  : done
                    ? "border-advent-gold/35 bg-card"
                    : bad
                      ? "border-late/50 bg-late/10"
                      : isNext
                        ? "border-foreground/40 bg-card"
                        : "border-border bg-card/40",
                selected === t.key && "ring-2 ring-foreground/60",
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1 font-mono text-[13px] font-bold tabular-nums",
                  bad && "line-through decoration-2",
                  t.verdict === "upcoming" && !isNext && "text-muted-foreground",
                )}
              >
                {t.from === "tiszai" ? <ArrowLeft className="h-3 w-3" aria-label="Felső-Majláth felé" /> : <ArrowRight className="h-3 w-3" aria-label="Tiszai felé" />}
                {hm(t.sched.dep)}
              </span>
              <span
                className={cn("text-[10.5px] font-semibold leading-none", bad ? "text-late" : running ? "text-advent-gold" : done ? delayTone(delay) : "text-muted-foreground")}
              >
                {done ? `${signedMin(delay)} p` : isNext && !TRIP_LABEL[t.verdict] ? "következő" : TRIP_LABEL[t.verdict] || " "}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** a nap számai: menet, km, megállás, legtöbb késés, állás, csúcssebesség */
export function DayCounters({ day, season }: { day: PublicDay; season: SeasonMeta }) {
  const s = day.stats;
  const items: {
    v: string;
    unit: string;
    sub: string | null;
    tone?: string;
  }[] = [
    {
      v: `${s.doneTrips}/${s.plannedTrips}`,
      unit: "menet",
      sub: s.missedTrips ? `${s.missedTrips} elmaradt` : s.partialTrips ? `${s.partialTrips} félbe` : null,
      tone: s.missedTrips ? "text-late" : undefined,
    },
    {
      v: km(s.serviceDistM),
      unit: "km",
      sub: s.distM > s.serviceDistM + 500 ? `${km(s.distM)} km összesen` : null,
    },
    {
      v: String(s.stopsServed),
      unit: "megállás",
      sub: s.longestDwell ? `${season.stops[s.longestDwell.stop].name}: ${Math.max(1, Math.round(s.longestDwell.s / 60))} p` : null,
    },
    {
      v: s.maxLate ? signedMin(s.maxLate.s) : "–",
      unit: "legtöbb késés",
      sub: s.maxLate ? `${season.stops[s.maxLate.stop].name}, ${hm(s.maxLate.ts)}` : null,
      tone: s.maxLate ? delayTone(s.maxLate.s) : undefined,
    },
    {
      v: String(Math.round(s.stallS / 60)),
      unit: "perc állás",
      sub: s.longestStall ? `${season.stops[s.longestStall.stop].name}` : s.stalls ? null : "nem akadt el",
      tone: s.longestStall && s.longestStall.s >= 480 ? "text-late" : undefined,
    },
    {
      v: s.maxSpeedKmh != null ? String(s.maxSpeedKmh) : "–",
      unit: "km/h csúcs",
      sub: s.avgSpeedKmh ? `átlag ${s.avgSpeedKmh.toLocaleString("hu-HU")}` : null,
    },
  ];
  return (
    <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
      {items.map((it) => (
        <div key={it.unit} className="min-w-0 bg-card px-2.5 py-2">
          <dd className={cn("font-mono text-[19px] font-bold leading-tight tabular-nums", it.tone ?? "text-foreground")}>{it.v}</dd>
          <dt className="text-[11px] font-semibold text-muted-foreground">{it.unit}</dt>
          {it.sub ? <dd className="truncate text-[10.5px] text-muted-foreground/80">{it.sub}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** A menetlap: menetenként indulás, érkezés, késés; kinyitva megállónként. */
export function TripList({ day, season, open, onOpen }: { day: PublicDay; season: SeasonMeta; open: string | null; onOpen: (key: string | null) => void }) {
  const shown = day.trips.filter((t) => t.verdict !== "upcoming" || t.key === open);
  if (!shown.length) return <p className="py-3 text-[13px] text-muted-foreground">Még egy menet sem indult el.</p>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {[...shown].reverse().map((t) => (
        <li key={t.key}>
          <button
            type="button"
            onClick={() => onOpen(open === t.key ? null : t.key)}
            aria-expanded={open === t.key}
            className="grid w-full grid-cols-[3.25rem_1fr_auto_1rem] items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
          >
            <span className="font-mono text-[14px] font-bold tabular-nums">{hm(t.sched.dep)}</span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold">{t.from === "tiszai" ? "Tiszai → Felső-Majláth" : "Felső-Majláth → Tiszai"}</span>
              <span className="block truncate text-[11.5px] text-muted-foreground">{tripLine(t)}</span>
            </span>
            <span className={cn("font-mono text-[13px] font-bold tabular-nums", t.verdict === "missed" ? "text-late" : delayTone(t.arrDelayS ?? t.depDelayS))}>
              {t.verdict === "missed" ? "elmaradt" : t.verdict === "running" ? "úton" : signedMin(t.arrDelayS ?? t.depDelayS)}
            </span>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-fast", open === t.key && "rotate-180")} aria-hidden />
          </button>
          {open === t.key ? <StopTable trip={t} season={season} /> : null}
        </li>
      ))}
    </ul>
  );
}

function tripLine(t: AdventTrip): string {
  if (t.verdict === "missed" || t.verdict === "not_departed") return `nem indult el ${END_LABEL[t.from]}ról`;
  if (t.verdict === "no_data") return "nem jött jel, valószínűleg jel nélkül járt";
  const parts: string[] = [];
  if (t.dep != null) parts.push(`indult ${hm(t.dep)} (${signedMin(t.depDelayS)})`);
  if (t.arr != null) parts.push(`beért ${hm(t.arr)}`);
  if (t.durS != null) parts.push(`${Math.round(t.durS / 60)} perc`);
  if (t.servedStops) parts.push(`${t.servedStops} megállás`);
  if (t.stallS >= 120) parts.push(`${Math.round(t.stallS / 60)} p állás`);
  return parts.join(" · ") || TRIP_LABEL[t.verdict];
}

function StopTable({ trip, season }: { trip: AdventTrip; season: SeasonMeta }) {
  return (
    <table className="w-full border-t border-border text-[12.5px]">
      <thead className="sr-only">
        <tr>
          <th>Megálló</th>
          <th>Menetrend</th>
          <th>Tény</th>
          <th>Késés</th>
        </tr>
      </thead>
      <tbody>
        {trip.stops.map((s, k) => {
          const at = k === 0 ? s.dep : s.arr;
          return (
            <tr key={s.stop} className="odd:bg-background/40">
              <td className="max-w-0 truncate py-1 pl-3 pr-2">
                <span
                  className={cn(
                    "mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle",
                    s.served ? "bg-advent-gold" : s.served === false ? "border border-muted-foreground" : "bg-border",
                  )}
                  aria-label={s.served ? "megállt" : s.served === false ? "áthaladt" : undefined}
                />
                {season.stops[s.stop].name}
              </td>
              <td className="w-12 py-1 text-right font-mono tabular-nums text-muted-foreground">{hm(s.sched)}</td>
              <td className="w-12 py-1 text-right font-mono tabular-nums">{at != null ? hm(at) : "–"}</td>
              <td className={cn("w-14 py-1 pr-3 text-right font-mono font-semibold tabular-nums", delayTone(s.delayS))}>
                {signedMin(s.delayS)}
                {s.dwellS != null && s.dwellS >= 60 ? <span className="ml-1 text-[10.5px] font-normal text-muted-foreground">{Math.round(s.dwellS / 60)}p</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const KIND_ICON = { bad: AlertTriangle, warn: Wrench, info: Info } as const;

/** a nap eseményei egy-egy sorban (az elmaradások összevonva) */
export function IncidentLog({ incidents }: { incidents: AdventIncident[] }) {
  if (!incidents.length)
    return (
      <p className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-[13px] text-muted-foreground">
        <CircleSlash className="h-4 w-4" aria-hidden /> Nem volt zavar.
      </p>
    );
  return (
    <ul className="space-y-1.5">
      {incidents.map((i) => {
        const Icon = KIND_ICON[i.severity];
        return (
          <li
            key={`${i.kind}-${i.from}`}
            className={cn(
              "flex items-start gap-2.5 rounded-xl border px-3 py-2",
              i.severity === "bad" ? "border-late/45 bg-late/[0.07]" : i.severity === "warn" ? "border-nosignal/35 bg-nosignal/[0.06]" : "border-border bg-card",
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", i.severity === "bad" ? "text-late" : i.severity === "warn" ? "text-nosignal" : "text-muted-foreground")} aria-hidden />
            <span className="min-w-0 flex-1 text-[13px] leading-snug">{i.text}</span>
            <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
              {hm(i.from)}
              {i.to ? `–${hm(i.to)}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
