import type { SeasonSummary, SeasonDay } from "@mvk/core/advent/seasonStats";
import { cn } from "@/lib/utils";
import type { SeasonMeta } from "./adventApi";
import { delayTone, dowShort, hm, shortDate, signedMin, slotTime, VERDICT } from "./adventText";

/**
 * Az évad naptára: hétfőtől vasárnapig, a nap ítéletének színével és a menetek
 * számával. Koppintásra az a nap nyílik meg.
 */
export function SeasonCalendar({ summary, today, selected, onSelect }: { summary: SeasonSummary; today: string; selected: string | null; onSelect: (iso: string | null) => void }) {
  const days = summary.days;
  if (!days.length) return null;
  const lead = (new Date(`${days[0].iso}T12:00:00Z`).getUTCDay() + 6) % 7;
  const legend = (["perfect", "ok", "late", "partial", "down", "nodata"] as const).filter((v) => days.some((d) => d.verdict === v));
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10.5px] font-semibold text-muted-foreground" aria-hidden>
        {["H", "K", "Sze", "Cs", "P", "Szo", "V"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <ol className="mt-1 grid grid-cols-7 gap-1" aria-label="Az évad napjai">
        {Array.from({ length: lead }, (_, i) => (
          <li key={`pad${i}`} aria-hidden />
        ))}
        {days.map((d) => (
          <li key={d.iso}>
            <DayCell day={d} today={d.iso === today} selected={selected === d.iso} onSelect={() => onSelect(d.iso === today || selected === d.iso ? null : d.iso)} />
          </li>
        ))}
      </ol>
      {legend.length ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="Jelmagyarázat">
          {legend.map((v) => (
            <li key={v} className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-full", VERDICT[v].dot)} aria-hidden />
              {VERDICT[v].label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DayCell({ day, today, selected, onSelect }: { day: SeasonDay; today: boolean; selected: boolean; onSelect: () => void }) {
  const v = VERDICT[today ? "live" : day.verdict];
  const done = day.stats?.doneTrips ?? 0;
  const future = day.verdict === "future";
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={future}
      title={`${shortDate(day.iso)} ${dowShort(day.iso)} · ${v.label}${day.note ? ` · ${day.note}` : ""}${day.planned ? ` · ${done}/${day.planned} menet` : ""}`}
      aria-label={`${shortDate(day.iso)}, ${v.label}${day.planned && !future ? `, ${done} / ${day.planned} menet` : ""}${day.note ? `, ${day.note}` : ""}`}
      aria-pressed={selected}
      className={cn(
        "relative flex h-10 w-full flex-col items-center justify-center rounded-md border text-[12px] font-bold tabular-nums transition-transform duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:scale-105 disabled:cursor-default",
        v.cell,
        selected && "ring-2 ring-foreground",
      )}
    >
      {Number(day.iso.slice(8))}
      {day.special ? <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-advent-gold" aria-hidden /> : null}
      {!future && day.planned ? (
        <span className="text-[8.5px] font-semibold leading-none opacity-75">
          {done}/{day.planned}
        </span>
      ) : null}
    </button>
  );
}

/** az évad számai és rekordjai */
export function SeasonTotals({ summary, season, onDay }: { summary: SeasonSummary; season: SeasonMeta; onDay: (iso: string) => void }) {
  const t = summary.totals;
  const r = summary.records;
  const stop = (i: number) => season.stops[i]?.name ?? "";
  const tiles = [
    {
      v: t.serviceKm.toLocaleString("hu-HU", { maximumFractionDigits: 0 }),
      u: "km",
    },
    { v: `${t.tripsDone}/${t.tripsPlanned}`, u: "menet" },
    { v: t.stopsServed.toLocaleString("hu-HU"), u: "megállás" },
    {
      v: t.measuredDeps ? `${Math.round((t.onTimeDeps / t.measuredDeps) * 100)}%` : "–",
      u: "pontos indulás",
    },
    { v: String(t.breakdowns), u: "valószínű hiba", bad: t.breakdowns > 0 },
    { v: String(r.streakNow), u: "napja hibátlan" },
  ];
  const recs: {
    label: string;
    value: string;
    iso: string | null;
    note?: string;
  }[] = [
    r.fastestTrip && {
      label: "Leggyorsabb kör",
      value: `${Math.round(r.fastestTrip.s / 60)} perc`,
      iso: r.fastestTrip.iso,
      note: slotTime(r.fastestTrip.key),
    },
    r.slowestTrip && {
      label: "Leglassabb kör",
      value: `${Math.round(r.slowestTrip.s / 60)} perc`,
      iso: r.slowestTrip.iso,
      note: slotTime(r.slowestTrip.key),
    },
    r.maxLate && {
      label: "Legtöbb késés",
      value: `${signedMin(r.maxLate.s)} perc`,
      iso: r.maxLate.iso,
      note: `${stop(r.maxLate.stop)}, ${hm(r.maxLate.ts)}`,
    },
    r.maxEarly &&
      r.maxEarly.s <= -60 && {
        label: "Legjobban sietett",
        value: `${Math.round(-r.maxEarly.s / 60)} perc`,
        iso: r.maxEarly.iso,
        note: stop(r.maxEarly.stop),
      },
    r.longestStall && {
      label: "Leghosszabb állás",
      value: `${Math.round(r.longestStall.s / 60)} perc`,
      iso: r.longestStall.iso,
      note: stop(r.longestStall.stop),
    },
    r.longestDwell && {
      label: "Leghosszabb megállás",
      value: `${Math.max(1, Math.round(r.longestDwell.s / 60))} perc`,
      iso: r.longestDwell.iso,
      note: stop(r.longestDwell.stop),
    },
    r.mostKm && {
      label: "Legtöbb km egy nap",
      value: `${r.mostKm.km.toLocaleString("hu-HU")} km`,
      iso: r.mostKm.iso,
    },
    r.maxSpeed && {
      label: "Csúcssebesség",
      value: `${r.maxSpeed.kmh} km/h`,
      iso: r.maxSpeed.iso,
    },
    r.bestStreak && {
      label: "Leghosszabb hibátlan sor",
      value: `${r.bestStreak.days} nap`,
      iso: r.bestStreak.from,
      note: `${shortDate(r.bestStreak.from)}–${shortDate(r.bestStreak.to)}`,
    },
  ].filter((x): x is { label: string; value: string; iso: string; note?: string } => Boolean(x));

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
        {tiles.map((x) => (
          <div key={x.u} className="bg-card px-2.5 py-2">
            <dd className={cn("font-mono text-[18px] font-bold tabular-nums", x.bad ? "text-late" : "text-foreground")}>{x.v}</dd>
            <dt className="text-[11px] font-semibold text-muted-foreground">{x.u}</dt>
          </div>
        ))}
      </dl>
      {recs.length ? (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {recs.map((x) => (
            <li key={x.label}>
              <button
                type="button"
                onClick={() => x.iso && onDay(x.iso)}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">{x.label}</span>
                  {x.note ? <span className="block truncate text-[11.5px] text-muted-foreground">{x.note}</span> : null}
                </span>
                <span className="font-mono text-[14px] font-bold tabular-nums text-advent-gold">{x.value}</span>
                <span className="w-14 shrink-0 text-right text-[11.5px] text-muted-foreground">{x.iso ? shortDate(x.iso) : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">Az első lezárt nap után itt lesznek a rekordok.</p>
      )}
    </div>
  );
}

/**
 * Megállónként az évad átlagos késése és megállási ideje, mindkét irányban. Táblázat:
 * az érték mindig ki van írva, a szín (piros késik, kék siet) csak kiemel.
 */
export function SeasonStops({ summary, season }: { summary: SeasonSummary; season: SeasonMeta }) {
  if (!summary.stops.length) return null;
  const row = (dir: "out" | "back", i: number) => summary.stops.find((s) => s.dir === dir && s.stop === i);
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-[12.5px]">
        <caption className="sr-only">Megállónkénti átlagos késés és megállási idő az évadban</caption>
        <thead className="bg-card text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-1.5 text-left font-semibold">
              Megálló
            </th>
            <th scope="col" className="px-1 py-1.5 text-right font-semibold">
              Majláth felé
            </th>
            <th scope="col" className="px-1 py-1.5 pr-3 text-right font-semibold">
              Tiszai felé
            </th>
          </tr>
        </thead>
        <tbody>
          {season.stops.map((s, i) => (
            <tr key={s.out} className="border-t border-border/60">
              <th scope="row" className="max-w-0 truncate px-3 py-1 text-left font-medium">
                {s.name}
              </th>
              {(["out", "back"] as const).map((dir) => {
                const r = row(dir, i);
                return (
                  <td key={dir} className={cn("w-[6.5rem] py-1 text-right", dir === "back" && "pr-3")}>
                    {r && r.avgDelayS != null ? (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className={cn("font-mono font-semibold tabular-nums", delayTone(r.avgDelayS))}>{signedMin(r.avgDelayS)}</span>
                        {r.avgDwellS != null ? <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{r.avgDwellS}s</span> : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border bg-card px-3 py-1.5 text-[10.5px] text-muted-foreground">Átlagos késés percben, mellette az átlagos megállási idő másodpercben.</p>
    </div>
  );
}

/** az indulások megbízhatósága: melyik időpont maradt el vagy késett legtöbbször */
export function SeasonSlots({ summary }: { summary: SeasonSummary }) {
  if (!summary.slots.length) return null;
  const cols = [
    { from: "T", title: "Tiszai pu.-ról" },
    { from: "M", title: "Felső-Majláthról" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {cols.map((c) => (
        <table key={c.from} className="w-full overflow-hidden rounded-xl border border-border bg-card text-[12px]">
          <caption className="px-2.5 pb-1 text-left text-[11px] font-semibold text-muted-foreground">{c.title}</caption>
          <tbody>
            {summary.slots
              .filter((x) => x.key[0] === c.from)
              .sort((a, b) => a.key.localeCompare(b.key))
              .map((x) => (
                <tr key={x.key} className={cn("border-t border-border/60 first:border-t-0", x.missed && "bg-late/[0.07]")}>
                  <th scope="row" className="py-1 pl-2.5 text-left font-mono font-bold tabular-nums">
                    {slotTime(x.key)}
                  </th>
                  <td className={cn("py-1 text-right font-mono tabular-nums", x.missed ? "text-late" : "text-muted-foreground")}>
                    {x.done}/{x.planned}
                  </td>
                  <td className={cn("w-11 py-1 pr-2.5 text-right font-mono font-semibold tabular-nums", delayTone(x.avgDepDelayS))}>{signedMin(x.avgDepDelayS)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
      <p className="col-span-2 text-[10.5px] text-muted-foreground">Lement / menetrend szerint, és az átlagos indulási késés percben.</p>
    </div>
  );
}
