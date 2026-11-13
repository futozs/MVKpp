"use client";
/** Útvonalankénti válaszidő-táblázat (worker, web, MVK API)  rendezhető, percenkénti mini-görbével. */
import { useState } from "react";
import { ms, num, num1 } from "@/lib/format";
import type { MetricStat } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Sparkline } from "../charts/charts";
import { Empty } from "../ui/primitives";

type SortKey = "count" | "p95Ms" | "errors" | "avgMs";
const COLS: { key: SortKey; label: string }[] = [
  { key: "count", label: "hívás" },
  { key: "avgMs", label: "átlag" },
  { key: "p95Ms", label: "p95" },
  { key: "errors", label: "hiba" },
];

const latencyTone = (v: number) => (v >= 2000 ? "text-late" : v >= 500 ? "text-nosignal" : "text-foreground");

export function RouteTable({ rows, windowMin, empty = "Ebben az ablakban nem volt hívás." }: { rows: MetricStat[]; windowMin: number; empty?: string }) {
  const [sort, setSort] = useState<SortKey>("count");
  if (!rows.length) return <Empty>{empty}</Empty>;
  const sorted = [...rows].sort((a, b) => b[sort] - a[sort]);
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[720px] text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            <th className="px-4 py-2 font-medium sm:px-5">végpont</th>
            {COLS.map((c) => (
              <th key={c.key} className="px-2 py-2 text-right font-medium">
                <button onClick={() => setSort(c.key)} className={cn("uppercase tracking-[0.08em] hover:text-foreground", sort === c.key && "text-foreground")} aria-pressed={sort === c.key}>
                  {c.label}
                  {sort === c.key ? " ↓" : ""}
                </button>
              </th>
            ))}
            <th className="px-2 py-2 text-right font-medium">p50 / p99</th>
            <th className="w-32 px-4 py-2 font-medium sm:px-5">percenként (ms)</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const errPct = r.count ? (r.errors / r.count) * 100 : 0;
            const [method, ...path] = r.key.split(" ");
            return (
              <tr key={r.key} className="border-b border-border/60 last:border-0 hover:bg-accent/30">
                <td className="max-w-[340px] px-4 py-2 sm:px-5">
                  <span className="mr-2 font-mono text-[10.5px] font-semibold text-muted-foreground">{method}</span>
                  <span className="break-all font-mono">{path.join(" ")}</span>
                </td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">
                  {num(r.count)}
                  <span className="block text-[10.5px] text-muted-foreground">{num1(r.perMin)}/perc</span>
                </td>
                <td className={cn("px-2 py-2 text-right font-mono tabular-nums", latencyTone(r.avgMs))}>{ms(r.avgMs)}</td>
                <td className={cn("px-2 py-2 text-right font-mono tabular-nums", latencyTone(r.p95Ms))}>{ms(r.p95Ms)}</td>
                <td className={cn("px-2 py-2 text-right font-mono tabular-nums", r.errors ? "text-late" : "text-muted-foreground")}>
                  {r.errors ? `${num(r.errors)} (${num1(errPct)}%)` : "0"}
                </td>
                <td className="px-2 py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {ms(r.p50Ms)} / {ms(r.p99Ms)}
                </td>
                <td className="px-4 py-2 sm:px-5">
                  <Sparkline values={fillMinutes(r.series, windowMin)} height={22} label={`${r.key} percenkénti átlag`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A percenkénti sor kiegészítése: a csendes percek üresek (nem nullák  az átlagidő ott nem létezik). */
function fillMinutes(series: [number, number, number][], windowMin: number): (number | null)[] {
  const end = Math.floor(Date.now() / 60_000) * 60_000;
  const byT = new Map(series.map(([t, , avg]) => [t, avg]));
  return Array.from({ length: windowMin }, (_, i) => byT.get(end - (windowMin - 1 - i) * 60_000) ?? null);
}
