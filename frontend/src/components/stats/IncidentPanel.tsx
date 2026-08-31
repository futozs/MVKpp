import { useCallback, useState } from "react";
import {
  AlertOctagon,
  Clock4,
  PauseOctagon,
  Undo2,
  Wrench,
} from "lucide-react";
import {
  fmtClock,
  fmtDuration,
  serviceToday,
  shiftDate,
  statsApi,
  type Incident,
  type IncidentSummary,
} from "@/services/statsApi";
import {
  BarChart,
  ChartFrame,
  EmptyChart,
  RankBars,
  StatTile,
} from "@/components/charts/Charts";
import { QueryBoundary, PillPicker } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";
import { cn } from "@/lib/utils";

const KIND_META: Record<
  Incident["kind"],
  { label: string; short: string; icon: typeof Wrench }
> = {
  mid_trip_stop: {
    label: "Menet közben elnémult",
    short: "Elnémult",
    icon: AlertOctagon,
  },
  stuck: {
    label: "Helyben állt",
    short: "Elakadt",
    icon: PauseOctagon,
  },
  early_end: {
    label: "Korai bevonás",
    short: "Korai vég",
    icon: Clock4,
  },
  absence: {
    label: "Kiesett a flottából",
    short: "Kiesés",
    icon: Wrench,
  },
};

const FILTERS = [
  { id: "all", label: "Mind" },
  { id: "mid_trip_stop", label: "Elnémult" },
  { id: "stuck", label: "Elakadt" },
  { id: "absence", label: "Kiesés" },
] as const;

const CONF = [
  { id: "70", label: "Csak biztos", sub: "70%+" },
  { id: "50", label: "Valószínű", sub: "50%+" },
  { id: "0", label: "Minden jel", sub: "0%+" },
] as const;

function ConfidenceDot({ value }: { value: number }) {
  const tone =
    value >= 70
      ? "bg-late"
      : value >= 50
        ? "bg-primary"
        : "bg-muted-foreground/50";
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", tone)}
      title={`Konfidencia: ${value}%`}
      aria-label={`Konfidencia ${value} százalék`}
    />
  );
}

function IncidentRow({ inc }: { inc: Incident }) {
  const meta = KIND_META[inc.kind];
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-2.5 py-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold">
          <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
            {inc.vehicle_id}
          </span>
          {inc.route_short ? (
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{
                background: inc.color ? `#${inc.color}` : "hsl(var(--primary))",
                color: "hsl(var(--background))",
              }}
            >
              {inc.route_short}
            </span>
          ) : null}
          <span className="font-medium text-muted-foreground">
            {meta.label}
          </span>
          <ConfidenceDot value={inc.confidence} />
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {inc.note}
          {inc.peers_stuck > 0 ? null : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] font-semibold tabular-nums">
          {inc.kind === "absence" && inc.absent_days != null
            ? `${inc.absent_days} nap`
            : fmtDuration(inc.duration_s)}
        </p>
        <p className="text-[10px] tabular-nums text-muted-foreground">
          {inc.service_date.slice(5)} {fmtClock(inc.started_ts)}
        </p>
      </div>
    </li>
  );
}

export function IncidentPanel() {
  const [kind, setKind] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [conf, setConf] = useState<(typeof CONF)[number]["id"]>("50");

  const to = serviceToday();
  const from = shiftDate(to, -29);
  const minConf = Number(conf);

  const listQ = useStatsQuery(
    useCallback(
      () =>
        statsApi.incidents(
          from,
          to,
          kind === "all" ? undefined : kind,
          minConf,
        ),
      [from, to, kind, minConf],
    ),
    [from, to, kind, minConf],
  );
  const sumQ = useStatsQuery<IncidentSummary>(
    useCallback(
      () => statsApi.incidentSummary(from, to, minConf),
      [from, to, minConf],
    ),
    [from, to, minConf],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">
          Üzemzavarok
        </h2>
        <p className="text-xs text-muted-foreground">
          Lerobbant és megszakadt járatok, flottából kiesett járművek és
          visszatérésük.
        </p>
      </div>

      <div className="space-y-2">
        <PillPicker
          ariaLabel="Esemény típusa"
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          items={FILTERS.map((f) => ({ id: f.id, label: f.label }))}
        />
        <PillPicker
          ariaLabel="Konfidencia-küszöb"
          value={conf}
          onChange={(v) => setConf(v as typeof conf)}
          items={CONF.map((cf) => ({
            id: cf.id,
            label: cf.label,
            sub: cf.sub,
          }))}
        />
      </div>

      {}
      <QueryBoundary query={sumQ}>
        {(s) => {
          const totals = s.byKind.reduce((a, k) => a + k.n, 0);
          const absentNow = s.fleet.filter((f) => f.absent_since).length;
          const worst = s.fleet.filter((f) => f.incidents > 0).slice(0, 12);
          const avgRepair = s.repairs.length
            ? Math.round(
                s.repairs.reduce((a, r) => a + r.absent_days, 0) /
                  s.repairs.length,
              )
            : null;

          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                <StatTile
                  label="Észlelés összesen"
                  value={totals}
                  sub={`${s.from} – ${s.to}`}
                />
                <StatTile
                  label="Most kiesve"
                  value={absentNow}
                  sub="jármű nincs forgalomban"
                  tone={absentNow > 0 ? "late" : "ontime"}
                />
                <StatTile
                  label="Érintett jármű"
                  value={s.fleet.filter((f) => f.incidents > 0).length}
                  sub={`${s.fleet.length} aktívból`}
                />
                <StatTile
                  label="Átlagos kiesés"
                  value={avgRepair != null ? `${avgRepair} nap` : "—"}
                  sub={
                    s.repairs.length
                      ? `${s.repairs.length} visszatérésből`
                      : "még nincs visszatérés"
                  }
                />
              </div>

              {s.byKind.length ? (
                <ChartFrame
                  title="Események típusonként"
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    {s.byKind.map((k) => {
                      const meta = KIND_META[k.kind as Incident["kind"]];
                      const Icon = meta?.icon ?? AlertOctagon;
                      return (
                        <div
                          key={k.kind}
                          className="flex items-start gap-2.5 rounded-xl border border-border px-3 py-2.5"
                        >
                          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold">
                              {meta?.label ?? k.kind}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-lg font-bold tabular-nums">
                              {k.n}
                            </p>
                            <p className="text-[10px] tabular-nums text-muted-foreground">
                              átlag {k.avg_conf}%
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ChartFrame>
              ) : null}

              {s.daily.length > 1 ? (
                <ChartFrame title="Események naponta">
                  <BarChart
                    labelEvery={Math.max(1, Math.ceil(s.daily.length / 8))}
                    data={s.daily.map((d) => ({
                      label: d.service_date.slice(5),
                      value: d.n,
                      tone: "fill-late",
                      title: `${d.service_date}: ${d.n} esemény`,
                    }))}
                  />
                </ChartFrame>
              ) : null}

              <ChartFrame
                title="Legtöbbet érintett járművek"
              >
                {worst.length ? (
                  <RankBars
                    rows={worst.map((f) => ({
                      label: `${f.vehicle_id}${f.absent_since ? " · most kiesve" : ""}`,
                      sub:
                        `${f.incidents} esemény · ${f.service_h} üzemóra · ${f.days_active} aktív nap` +
                        (f.absences
                          ? ` · ${f.absences} kiesés (${f.absent_days} nap)`
                          : ""),
                      value: f.per_hour,
                      display: `${f.per_hour}/óra`,
                    }))}
                  />
                ) : (
                  <EmptyChart>
                    Egyetlen járműhöz sem tartozik esemény ebben az időszakban.
                  </EmptyChart>
                )}
              </ChartFrame>

              {s.repairs.length ? (
                <ChartFrame
                  title="Visszatérések forgalomba"
                >
                  <ul className="divide-y divide-border">
                    {s.repairs.slice(0, 10).map((r, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2.5 py-2 text-xs"
                      >
                        <Undo2 className="h-3.5 w-3.5 shrink-0 text-ontime" />
                        <span className="rounded bg-muted px-1.5 py-0.5 font-semibold tabular-nums">
                          {r.vehicle_id}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {r.service_date} óta kiesve
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-ontime">
                          {r.absent_days} nap
                        </span>
                      </li>
                    ))}
                  </ul>
                </ChartFrame>
              ) : null}
            </div>
          );
        }}
      </QueryBoundary>

      {}
      <QueryBoundary query={listQ}>
        {(d) => (
          <ChartFrame
            title="Eseménynapló"
            hint={`${d.incidents.length} esemény · ${minConf}% konfidencia felett`}
          >
            {d.incidents.length ? (
              <ul className="divide-y divide-border">
                {d.incidents.map((inc) => (
                  <IncidentRow key={inc.incident_id} inc={inc} />
                ))}
              </ul>
            ) : (
              <EmptyChart>
                Ezen a küszöbön nincs esemény. Próbáld lejjebb venni a
                konfidencia-szűrőt.
              </EmptyChart>
            )}
          </ChartFrame>
        )}
      </QueryBoundary>
    </div>
  );
}
