import { useState, type ReactNode } from "react";
import { Clock, Hourglass, MapPin, Route as RouteIcon, Timer, Trophy } from "lucide-react";
import type { RideStats } from "@mvk/core/rideStats";
import { BarChart, ChartFrame, RankBars, StatTile } from "@/components/charts/Charts";
import { RouteTile } from "@/components/transit/RouteTile";
import { delayLabel, delayTone } from "@/components/transit/DelayBar";
import { displayVehicleId } from "@/lib/modes";
import { cn } from "@/lib/utils";
import type { Ride } from "@/lib/rides";

const nf = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", year: "numeric", month: "short", day: "numeric" });
const WEEKDAYS = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
const STOPS_FOLDED = 24;

/** perc → „2 ó 14 p” / „38 perc” */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} perc`;
  const h = Math.floor(minutes / 60);
  if (h >= 48) return `${nf.format(Math.round((minutes / 60 / 24) * 10) / 10)} nap`;
  return `${h} ó ${minutes % 60} p`;
}

const fmtS = (s: number) => formatMinutes(Math.round(s / 60));

/**
 * A késésekből összegyűlt idő: a buszon a menetrendhez képest plusz eltöltött
 * idő (az út végén ennyivel nagyobb volt a késés, mint az elején), és a megállóban
 * a késő buszra várva töltött.
 */
function DelayHero({ s }: { s: RideStats<Ride> }) {
  return (
    <section
      aria-label="Késések miatt elveszett idő"
      className="relative overflow-hidden rounded-2xl border border-late/30 bg-gradient-to-br from-late/[0.13] via-card to-card px-4 py-4 sm:px-6 sm:py-5"
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] sm:items-end">
        <div>
          <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-late">
            <Hourglass className="h-3.5 w-3.5" aria-hidden /> Késés miatt a buszon, pluszban
          </p>
          <p className="mt-2 text-4xl font-black leading-none tracking-tight sm:text-5xl">{fmtS(s.extraOnboardS)}</p>
          <p className="mt-2 max-w-md text-[12px] leading-snug text-muted-foreground">
            Ennyivel tovább ültél a buszon, mint a menetrend szerint kellett volna — az utak végén ennyivel nagyobb volt a késés, mint felszálláskor.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 border-t border-late/20 pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
          <div>
            <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Késő buszra várva</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums">{fmtS(s.lateWaitS)}</dd>
            <dd className="text-[11px] text-muted-foreground">a megállóban, a menetrendhez képest</dd>
          </div>
          <div>
            <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Összesen</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-late">{fmtS(s.extraOnboardS + s.lateWaitS)}</dd>
            <dd className="text-[11px] text-muted-foreground">
              {s.delayMeasured} / {s.journeys} út mért késéssel
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function StopChips({ stops }: { stops: RideStats<Ride>["stopsCollected"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? stops : stops.slice(0, STOPS_FOLDED);
  return (
    <>
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((x) => (
          <li key={x.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1 pl-2 pr-1.5 text-[12.5px] font-medium">
            {x.name}
            <span className="rounded bg-primary/15 px-1 font-mono text-[10.5px] font-bold text-primary">{x.n}×</span>
          </li>
        ))}
      </ul>
      {stops.length > STOPS_FOLDED ? (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-3 text-[12px] font-semibold text-primary hover:underline">
          {all ? "Kevesebb" : `Mind a ${stops.length} megálló`}
        </button>
      ) : null}
    </>
  );
}

function Record({ icon, label, value, legs }: { icon: ReactNode; label: string; value: string; legs: Ride[] | null }) {
  const first = legs?.[0];
  const last = legs?.[legs.length - 1];
  return (
    <div className="rounded-xl border border-border bg-background/50 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </p>
      {first && last ? (
        <>
          <p className="mt-1.5 text-lg font-bold leading-tight">{value}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <RouteTile short={first.route} color={first.color} text={first.text} size="sm" />
            <span className="min-w-0 truncate">
              {first.fromStopName ?? "?"} → {last.toStopName ?? "?"}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{DAY.format(new Date(first.boardedAt * 1000))}</p>
        </>
      ) : (
        <p className="mt-1.5 text-sm text-muted-foreground">Még nincs mérés</p>
      )}
    </div>
  );
}

/** Utazásaim: összesítés, késésből összegyűlt idő, gyűjtemények és rekordok. */
export function RideStatsView({ s, fleetSize }: { s: RideStats<Ride>; fleetSize: number | null }) {
  const busiestHour = s.hours.indexOf(Math.max(...s.hours));
  return (
    <div className="space-y-4">
      <DelayHero s={s} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Utazás" value={s.journeys} sub={s.loops ? `ebből ${s.loops} körbeutazás` : undefined} />
        <StatTile label="Megtett út" value={`${nf.format(s.km)} km`} sub="megállóról megállóra, légvonalban" />
        <StatTile label="Buszon töltött idő" value={formatMinutes(s.minutes)} />
        <StatTile label="Begyűjtött rendszám" value={s.vehicles.length} sub={fleetSize ? `a flotta ${fleetSize} járművéből` : undefined} tone="live" />
        <StatTile label="Begyűjtött megálló" value={s.stopsCollected.length} sub="ahol fel- vagy leszálltál" tone="live" />
        <StatTile
          label="Pontos busz"
          value={s.onTimePct != null ? `${s.onTimePct}%` : "—"}
          sub="felszálláskor ±1 percen belül"
          tone={s.onTimePct != null && s.onTimePct >= 70 ? "ontime" : "late"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartFrame title="Hol szállsz fel" hint="A felszállásaid helye">
          <RankBars rows={s.boardStops.slice(0, 7).map((x) => ({ label: x.name, value: x.n, display: `${x.n}×`, barClass: "bg-primary/70" }))} />
        </ChartFrame>
        <ChartFrame title="Hol szállsz le" hint="A leszállásaid helye">
          <RankBars rows={s.alightStops.slice(0, 7).map((x) => ({ label: x.name, value: x.n, display: `${x.n}×`, barClass: "bg-live/70" }))} />
        </ChartFrame>
        <ChartFrame title="Leggyakoribb útjaid" hint="Honnan hová">
          <RankBars rows={s.pairs.slice(0, 7).map((x) => ({ label: `${x.from} → ${x.to}`, value: x.n, display: `${x.n}×`, barClass: "bg-primary/45" }))} />
        </ChartFrame>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <ChartFrame title="Mikor utazol" hint={s.journeys ? `A legtöbbször ${busiestHour}–${busiestHour + 1} óra között szállsz fel` : undefined}>
          <BarChart
            height={150}
            labelEvery={3}
            data={s.hours.map((n, h) => ({ label: `${h}`, value: n, tone: "fill-primary/70", title: `${h}:00–${h + 1}:00 · ${n} utazás` }))}
          />
          <div className="mt-4 grid grid-cols-7 gap-1.5" aria-label="Utazások a hét napjain">
            {s.weekdays.map((n, i) => {
              const max = Math.max(...s.weekdays, 1);
              return (
                <div key={WEEKDAYS[i]} className="text-center" title={`${n} utazás`}>
                  <div className="flex h-12 items-end rounded-md bg-muted/60">
                    <div className="w-full rounded-md bg-primary/60" style={{ height: `${(100 * n) / max}%` }} />
                  </div>
                  <p className="mt-1 text-[10.5px] font-semibold text-muted-foreground">{WEEKDAYS[i]}</p>
                </div>
              );
            })}
          </div>
        </ChartFrame>
        <ChartFrame title="Kedvenc vonalaid" hint="Hányszor, és átlagosan mennyit késett felszálláskor">
          <ul className="space-y-2">
            {s.routes.slice(0, 8).map((r) => (
              <li key={r.route} className="grid grid-cols-[3rem_minmax(0,1fr)_2.5rem_4.5rem] items-center gap-2.5">
                <RouteTile short={r.route} color={r.color} text={r.text} className="justify-self-start" />
                <span className="h-2 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-primary/70" style={{ width: `${(100 * r.n) / (s.routes[0]?.n || 1)}%` }} />
                </span>
                <span className="text-right font-mono text-xs tabular-nums">{r.n}×</span>
                <span className={cn("text-right font-mono text-[11px] tabular-nums", delayTone(r.avgDelayS))}>{r.avgDelayS != null ? delayLabel(r.avgDelayS) : "—"}</span>
              </li>
            ))}
          </ul>
        </ChartFrame>
      </div>

      <ChartFrame title="Rekordjaid">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <Record icon={<RouteIcon className="h-3.5 w-3.5" aria-hidden />} label="Leghosszabb út" value={s.longest ? `${nf.format(s.longest.value / 1000)} km` : ""} legs={s.longest?.legs ?? null} />
          <Record icon={<Timer className="h-3.5 w-3.5" aria-hidden />} label="Legtöbb plusz idő a buszon" value={s.mostDelayed ? `+${fmtS(s.mostDelayed.value)}` : ""} legs={s.mostDelayed?.legs ?? null} />
          <Record icon={<Clock className="h-3.5 w-3.5" aria-hidden />} label="Leghosszabb ideig" value={s.longestTime ? formatMinutes(s.longestTime.value) : ""} legs={s.longestTime?.legs ?? null} />
        </div>
      </ChartFrame>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame title="Megállógyűjtemény" hint={`${s.stopsCollected.length} megálló, ahol már fel- vagy leszálltál`} action={<MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <StopChips stops={s.stopsCollected} />
        </ChartFrame>
        <ChartFrame title="Begyűjtött rendszámok" hint="Melyik buszon hányszor utaztál" action={<Trophy className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <ul className="flex flex-wrap gap-1.5">
            {s.vehicles.map(([id, n]) => (
              <li key={id} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1 pl-2 pr-1.5">
                <span className="font-mono text-[13px] font-bold tabular-nums">{displayVehicleId(id)}</span>
                <span className="rounded bg-primary/15 px-1 font-mono text-[10.5px] font-bold text-primary">{n}×</span>
              </li>
            ))}
          </ul>
        </ChartFrame>
      </div>
    </div>
  );
}
