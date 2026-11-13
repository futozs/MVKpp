"use client";
import { useState } from "react";
import { isErr } from "@/lib/api";
import { clock, dateTime, ms, num, pct } from "@/lib/format";
import { useHub } from "@/lib/hooks";
import type { Maybe, Probe, WebMetrics, WorkerMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TimeChart } from "../charts/charts";
import { PageHeader } from "../shell/Shell";
import { ErrorNote, Loading, Panel, Segmented, StatusDot } from "../ui/primitives";
import { RouteTable } from "./RouteTable";

type Metrics = {
  worker: Maybe<WorkerMetrics>;
  web: Maybe<WebMetrics>;
  probes: { targets: { id: string; label: string }[]; latest: Probe[]; uptime: Maybe<{ target: string; okPct: number; p50: number | null; p95: number | null; n: number }[]> };
};
type ProbeSeries = { hours: number; bucketMin: number; targets: { id: string; label: string }[]; series: { target: string; t: string; avg: number | null; max: number | null; fails: number; n: number }[] };

function ProbeCards({ m, hours }: { m: Metrics; hours: number }) {
  const { data } = useHub<ProbeSeries>(`/api/probes?hours=${hours}`, 60_000);
  const uptime = isErr(m.probes.uptime) ? [] : m.probes.uptime;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {m.probes.targets.map((t) => {
        const last = m.probes.latest.find((p) => p.id === t.id);
        const up = uptime.find((u) => u.target === t.id);
        const pts = (data?.series ?? []).filter((s) => s.target === t.id).map((s) => [Date.parse(s.t), s.avg] as [number, number | null]);
        return (
          <Panel
            key={t.id}
            title={
              <span className="flex items-center gap-2">
                <StatusDot tone={!last ? "idle" : last.ok ? "ok" : "crit"} />
                <span className="font-mono text-[12.5px]">{t.label}</span>
              </span>
            }
            hint={last ? `utoljára ${clock(last.at)} · ${last.ok ? ms(last.ms) : (last.error ?? `HTTP ${last.status}`)}` : "még nincs mérés"}
          >
            <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span className="whitespace-nowrap">
                <span className="text-muted-foreground">elérhető (24 ó) </span>
                <span className={cn("font-mono font-semibold", (up?.okPct ?? 100) < 99 ? "text-nosignal" : "text-foreground")}>{up ? pct(up.okPct) : "–"}</span>
              </span>
              <span className="whitespace-nowrap">
                <span className="text-muted-foreground">p50 / p95 </span>
                <span className="font-mono font-semibold">
                  {ms(up?.p50)} / {ms(up?.p95)}
                </span>
              </span>
            </div>
            <TimeChart series={[{ id: t.id, label: "átlagos válaszidő", points: pts }]} height={120} yFormat={(v) => `${Math.round(v)}`} xFormat={(x) => (hours > 24 ? dateTime(x) : clock(x).slice(0, 5))} />
          </Panel>
        );
      })}
    </div>
  );
}

export function MetricsPage() {
  const [windowMin, setWindow] = useState(15);
  const [hours, setHours] = useState(24);
  const { data, error, isLoading } = useHub<Metrics>(`/api/metrics?window=${windowMin}`, 10_000);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const w = isErr(data.worker) ? null : data.worker;
  const web = isErr(data.web) ? null : data.web;
  const totals = (rows: { count: number; errors: number }[]) => {
    const n = rows.reduce((a, r) => a + r.count, 0);
    const e = rows.reduce((a, r) => a + r.errors, 0);
    return `${num(n)} hívás · ${n ? pct((e / n) * 100) : "0%"} hiba`;
  };

  return (
    <>
      <PageHeader
        title="Válaszidők"
        lead="Kívülről (a hub 30 mp-enként megszólít minden szolgáltatást, a nyilvános címet is) és belülről (a worker és a web minden kérését méri, útvonalanként)."
        actions={<Segmented value={hours} onChange={setHours} options={[{ value: 6, label: "6 ó" }, { value: 24, label: "24 ó" }, { value: 72, label: "3 nap" }, { value: 168, label: "7 nap" }]} />}
      />
      <ProbeCards m={data} hours={hours} />

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight">Belülről mérve</h2>
        <Segmented value={windowMin} onChange={setWindow} options={[{ value: 5, label: "5 perc" }, { value: 15, label: "15 perc" }, { value: 60, label: "1 óra" }]} />
      </div>
      <div className="space-y-5">
        <Panel title="Worker végpontok" hint={w ? totals(w.http) : undefined}>
          {w ? <RouteTable rows={w.http} windowMin={windowMin} /> : <ErrorNote error={data.worker} />}
        </Panel>
        <Panel title="Web API végpontok" hint={web ? totals(web.http) : "a web /v3/admin/metrics végpontja kell hozzá (ADMIN_KEY a web konténerben)"}>
          {web ? <RouteTable rows={web.http} windowMin={windowMin} /> : <ErrorNote error={data.web} />}
        </Panel>
        <Panel title="MVK API (a worker hívásai)" hint={w ? totals(w.upstream) : undefined}>
          {w ? <RouteTable rows={w.upstream} windowMin={windowMin} /> : null}
        </Panel>
      </div>
    </>
  );
}
