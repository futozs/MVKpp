import { useCallback } from "react";
import { ArrowRight, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { statsApi, type StatsHealth } from "@/services/statsApi";
import { ChartFrame, StatTile } from "@/components/charts/Charts";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";

const nf = new Intl.NumberFormat("hu-HU");

const JOB_LABELS: Record<string, string> = {
  janitor: "Partíciógondozás",
  profile: "Szakaszprofil",
  ghosts: "Szellemmenetek",
  "roll:route": "Vonal-összegzés",
  "roll:stop": "Megálló-összegzés",
  "roll:vehicle": "Jármű-összegzés",
  "roll:vehroute": "Jármű–vonal megoszlás",
};

export function OverviewPanel({
  onJumpToVehicles,
}: {
  onJumpToVehicles: () => void;
}) {
  const fetcher = useCallback(() => statsApi.health(), []);
  const q = useStatsQuery<StatsHealth>(fetcher, []);

  return (
    <QueryBoundary query={q}>
      {(d) => {
        const t = d.today;
        const dedup =
          t && t.pings_kept > 0
            ? (t.pings_dup / t.pings_kept + 1).toFixed(1)
            : null;
        const pollTotal = t ? t.polls_ok + t.polls_fail : 0;
        const uptime = pollTotal
          ? Math.round((t!.polls_ok / pollTotal) * 100)
          : null;

        return (
          <div className="space-y-4">
            <header className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold tracking-tight sm:text-xl">
                  Adatraktár
                </h2>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={q.reload}
                disabled={q.loading}
              >
                <RefreshCw className={q.loading ? "animate-spin" : undefined} />
                Frissítés
              </Button>
            </header>

            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
              <StatTile
                label="Megálló-esemény"
                value={nf.format(d.counts.events)}
                sub="a tények aranykészlete"
              />
              <StatTile
                label="Szakaszmérés"
                value={nf.format(d.counts.segments)}
                sub="ebből lesz az A→B becslés"
              />
              <StatTile
                label="Menet"
                value={nf.format(d.counts.runs)}
                sub="teljesített és megkezdett"
              />
              <StatTile
                label="Nyers GPS-pont"
                value={nf.format(d.counts.pings)}
                sub="14 napig őrizve"
              />
              <StatTile
                label="Szakaszprofil"
                value={nf.format(d.counts.profiles)}
                sub="napszakonként"
              />
              <StatTile
                label="Ismert jármű"
                value={nf.format(d.counts.vehicles)}
              />
            </div>

            {t ? (
              <ChartFrame
                title="Mai gyűjtés"
                hint={`Üzemi nap: ${t.service_date}`}
                action={
                  <Button variant="ghost" size="sm" onClick={onJumpToVehicles}>
                    Járművek
                    <ArrowRight />
                  </Button>
                }
              >
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
                  <StatTile
                    label="Feed elérhetőség"
                    value={uptime != null ? `${uptime}%` : "—"}
                    sub={`${nf.format(t.polls_ok)} sikeres, ${nf.format(t.polls_fail)} hibás`}
                    tone={uptime != null && uptime < 95 ? "late" : "ontime"}
                  />
                  <StatTile
                    label="Megtartott pont"
                    value={nf.format(t.pings_kept)}
                    sub={dedup ? `${dedup}× ismétlés kiszűrve` : undefined}
                  />
                  <StatTile
                    label="Csúcs járműszám"
                    value={t.vehicles_max}
                    sub="egyidejűleg"
                  />
                  <StatTile
                    label="Eldobott ismétlés"
                    value={nf.format(t.pings_dup)}
                    sub="kulcsütközésre, ingyen"
                  />
                </div>
              </ChartFrame>
            ) : null}

            <ChartFrame
              title="Feldolgozási feladatok"
            >
              {d.jobs.length ? (
                <ul className="divide-y divide-border">
                  {d.jobs.map((j, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2.5 py-2 text-xs"
                    >
                      {j.ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ontime" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-late" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {JOB_LABELS[j.job] ?? j.job}
                      </span>
                      {j.rows_out ? (
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {nf.format(j.rows_out)} sor
                        </span>
                      ) : null}
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {new Date(
                          j.started_at.replace(" ", "T"),
                        ).toLocaleTimeString("hu-HU", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Még nem futott feldolgozási feladat.
                </p>
              )}
            </ChartFrame>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
