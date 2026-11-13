import { useMemo, useState } from "react";
import { Flame, Snail, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtSec, heatColor, hourLabel, LEGEND, type HeatMetric } from "./heatScale";

export interface RouteHeatData {
  route: string;
  dir: string;
  days: number;
  daytype: number;
  directions: { dir: string; headsign: string; trips: number }[];
  stops: { id: string; name: string }[];
  hours: { from: number; to: number };
  /** [megálló-index, óra, mérések, medián késés, 85% késés, medián késésnövekmény] */
  cells: [number, number, number, number, number, number | null][];
}

type Cell = { stop: number; h: number; n: number; p50: number; p85: number; gain: number | null };

/** ennyi mérés alatt a cella halványabb (kevés adat) */
const SOLID_N = 8;

/**
 * Vonal-hőtérkép: a vonal megállói (fentről le, menetirányban) × a nap órái.
 * „Késés”: mennyit késik ott a busz; „Hol szedi fel”: az előző megállóhoz
 * képest mennyivel nőtt a késése  ez mutatja meg, melyik szakasz a bűnös.
 */
export function RouteHeat({ data }: { data: RouteHeatData }) {
  const [metric, setMetric] = useState<Extract<HeatMetric, "delay" | "gain">>("delay");
  const [sel, setSel] = useState<{ stop: number; h: number } | null>(null);

  const { grid, hours, insights } = useMemo(() => {
    const g = new Map<string, Cell>();
    for (const [stop, h, n, p50, p85, gain] of data.cells) g.set(`${stop}|${h}`, { stop, h, n, p50, p85, gain });
    const hs = Array.from({ length: data.hours.to - data.hours.from + 1 }, (_, i) => data.hours.from + i);
    const solid = [...g.values()].filter((c) => c.n >= SOLID_N);
    const worst = solid.reduce<Cell | null>((a, c) => (!a || c.p50 > a.p50 ? c : a), null);
    const gainer = solid.filter((c) => c.gain != null && c.stop > 0).reduce<Cell | null>((a, c) => (!a || c.gain! > a.gain! ? c : a), null);
    // A legpontosabb óra: a megállók medián késésének súlyozott átlaga.
    const byH = new Map<number, { s: number; n: number }>();
    for (const c of solid) {
      const cur = byH.get(c.h) ?? { s: 0, n: 0 };
      byH.set(c.h, { s: cur.s + Math.abs(c.p50) * c.n, n: cur.n + c.n });
    }
    const best = [...byH.entries()].filter(([, v]) => v.n >= 40).sort((a, b) => a[1].s / a[1].n - b[1].s / b[1].n)[0];
    return { grid: g, hours: hs, insights: { worst, gainer, bestHour: best ? { h: best[0], avg: Math.round(best[1].s / best[1].n) } : null } };
  }, [data]);

  const selected = sel ? grid.get(`${sel.stop}|${sel.h}`) : undefined;
  const value = (c: Cell) => (metric === "delay" ? c.p50 : (c.gain ?? 0));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {insights.worst ? (
          <Insight icon={Flame} tone="text-late" title="Itt késik a legtöbbet">
            {data.stops[insights.worst.stop]?.name}, {hourLabel(insights.worst.h)} óra: <b className="font-mono">{fmtSec(insights.worst.p50)}</b> (medián)
          </Insight>
        ) : null}
        {insights.gainer && (insights.gainer.gain ?? 0) >= 30 ? (
          <Insight icon={Snail} tone="text-late" title="Itt szedi fel a késést">
            {data.stops[insights.gainer.stop - 1]?.name} → {data.stops[insights.gainer.stop]?.name}, {hourLabel(insights.gainer.h)}: <b className="font-mono">{fmtSec(insights.gainer.gain)}</b>
          </Insight>
        ) : null}
        {insights.bestHour ? (
          <Insight icon={Sparkles} tone="text-ontime" title="A legpontosabb napszak">
            {hourLabel(insights.bestHour.h)} óra  átlagosan <b className="font-mono">{fmtSec(insights.bestHour.avg)}</b> eltérés
          </Insight>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label="Mit mutasson" className="flex gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
          {(
            [
              ["delay", "Késés a megállóban"],
              ["gain", "Hol szedi fel"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={metric === id}
              onClick={() => setMetric(id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                metric === id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Legend metric={metric} />
      </div>

      <div
        className="grid gap-px overflow-hidden rounded-lg border border-border bg-border"
        style={{ gridTemplateColumns: `minmax(84px, 30%) repeat(${hours.length}, minmax(0, 1fr))` }}
        role="grid"
        aria-label={`${data.route} vonal hőtérképe`}
      >
        <div className="bg-card" />
        {hours.map((h) => (
          <div key={h} className="bg-card py-1 text-center font-mono text-[9px] tabular-nums text-muted-foreground">
            {h % 3 === 0 ? String(h % 24).padStart(2, "0") : ""}
          </div>
        ))}
        {data.stops.map((s, i) => (
          <Row key={`${s.id}-${i}`}>
            <div className="flex items-center bg-card pl-2 pr-1" title={s.name}>
              <span className="truncate text-[10.5px] leading-[18px] sm:text-[11.5px]">{s.name}</span>
            </div>
            {hours.map((h) => {
              const c = grid.get(`${i}|${h}`);
              const on = sel?.stop === i && sel.h === h;
              const empty = !c || (metric === "gain" && (c.gain == null || i === 0));
              return (
                <button
                  key={h}
                  type="button"
                  role="gridcell"
                  disabled={empty}
                  onClick={() => setSel(on ? null : { stop: i, h })}
                  aria-label={c ? `${s.name}, ${hourLabel(h)} óra: ${fmtSec(value(c))}` : `${s.name}, ${hourLabel(h)} óra: nincs adat`}
                  className={cn("h-[18px] min-w-0 transition-[outline] sm:h-5", empty ? "bg-muted/25" : "hover:outline hover:outline-1 hover:outline-foreground/60", on && "relative z-10 outline outline-2 outline-foreground")}
                  style={empty ? undefined : { backgroundColor: heatColor(metric, value(c!), c!.n >= SOLID_N ? 1 : 0.55) }}
                />
              );
            })}
          </Row>
        ))}
      </div>

      <p aria-live="polite" className="min-h-[2.5rem] rounded-lg bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
        {selected ? (
          <>
            <span className="font-semibold text-foreground">{data.stops[selected.stop]?.name}</span>, {hourLabel(selected.h)} óra · medián{" "}
            <b className="font-mono text-foreground">{fmtSec(selected.p50)}</b>, a buszok 85%-a legfeljebb <b className="font-mono text-foreground">{fmtSec(selected.p85)}</b>
            {selected.gain != null && selected.stop > 0 ? (
              <>
                {" "}
                · az előző megálló óta <b className="font-mono text-foreground">{fmtSec(selected.gain)}</b>
              </>
            ) : null}{" "}
            · {selected.n} áthaladás {data.days} napból
          </>
        ) : (
          "Koppints egy cellára a részletekért. Fentről lefelé menetirányban haladnak a megállók; a halvány cella kevés mérésből jön."
        )}
      </p>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div role="row" className="contents">
      {children}
    </div>
  );
}

function Insight({ icon: Icon, tone, title, children }: { icon: typeof Flame; tone: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-background/50 px-3 py-2">
      <p className={cn("flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide", tone)}>
        <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
      </p>
      <p className="mt-0.5 text-[12.5px] leading-snug">{children}</p>
    </div>
  );
}

export function Legend({ metric }: { metric: HeatMetric }) {
  const steps = LEGEND[metric];
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground" aria-hidden>
      <span>{metric === "delay" ? "korán" : "behoz"}</span>
      <span className="flex h-2.5 overflow-hidden rounded-full">
        {steps.map((s) => (
          <span key={s} className="w-5" style={{ backgroundColor: heatColor(metric, s) }} />
        ))}
      </span>
      <span>{metric === "delay" ? `${Math.round(steps[steps.length - 1] / 60)}+ perc késés` : `${Math.round(steps[steps.length - 1] / 60)}+ perc veszteség`}</span>
    </div>
  );
}
