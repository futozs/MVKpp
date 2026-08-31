import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  fmtDelay,
  serviceToday,
  shiftDate,
  statsApi,
  type RoutePrediction,
} from "@/services/statsApi";
import {
  BarChart,
  ChartFrame,
  EmptyChart,
  RankBars,
  StatTile,
} from "@/components/charts/Charts";
import { QueryBoundary, SearchablePicker } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";

function VehiclePredictionCard({ vehicleId }: { vehicleId: string }) {
  const q = useStatsQuery(
    useCallback(() => statsApi.predictRoute(vehicleId), [vehicleId]),
    [vehicleId],
  );

  return (
    <QueryBoundary query={q} empty={(d) => !d.candidates.length}>
      {(d) => (
        <ul className="space-y-2">
          {d.candidates.map((c: RoutePrediction) => (
            <li
              key={c.routeShort}
              className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
            >
              <span
                className="flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-[11px] font-bold"
                style={{
                  background: c.color ? `#${c.color}` : "hsl(var(--primary))",
                  color: "hsl(var(--background))",
                }}
              >
                {c.routeShort}
              </span>
              <div className="min-w-0 flex-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${c.probabilityPct}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  itt szokott késni: {fmtDelay(c.avgDelaySec)}
                </p>
              </div>
              <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">
                {c.probabilityPct}%
              </span>
            </li>
          ))}
          <li className="pt-1 text-[11px] text-muted-foreground">
            {d.samples} korábbi futás alapján, statisztikai becslés — nem
            valódi gépi tanulás.
          </li>
        </ul>
      )}
    </QueryBoundary>
  );
}

export function PredictionPanel() {
  const [vehicleId, setVehicleId] = useState<string | null>(null);

  const to = serviceToday();
  const from = shiftDate(to, -59);

  const listQ = useStatsQuery(
    useCallback(() => statsApi.vehicles(), []),
    [],
  );
  useEffect(() => {
    if (!vehicleId && listQ.data?.vehicles.length) {
      setVehicleId(listQ.data.vehicles[0].vehicle_id);
    }
  }, [listQ.data, vehicleId]);

  const accQ = useStatsQuery(
    useCallback(() => statsApi.predictionAccuracy(from, to), [from, to]),
    [from, to],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">
          Előrejelzés
        </h2>
        <p className="text-xs text-muted-foreground">
          A jármű korábbi hónapjainak futásgyakorisága alapján épített
          statisztikai becslés arra, melyik vonalon fog legközelebb
          közlekedni — és utólagos mérés arról, hányszor volt igaza.
        </p>
      </div>

      <QueryBoundary query={accQ} empty={(d) => d.total === 0}>
        {(d) => (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              <StatTile
                label="Találati arány"
                value={d.accuracyPct != null ? `${d.accuracyPct}%` : "—"}
                sub={`${d.from} – ${d.to}`}
                tone={
                  d.accuracyPct == null
                    ? "default"
                    : d.accuracyPct >= 70
                      ? "ontime"
                      : "late"
                }
              />
              <StatTile
                label="Kiértékelt jóslat"
                value={d.total.toLocaleString("hu-HU")}
                sub={`${d.correct} eltalálva`}
              />
              <StatTile
                label="Mért jármű"
                value={d.byVehicle.length}
                sub="legalább 3 jóslattal"
              />
            </div>

            <ChartFrame
              title="Találati arány naponta"
              hint="A napi jóslatok hány százaléka egyezett a tényleges beosztással."
            >
              {d.daily.length ? (
                <BarChart
                  data={d.daily.map((r) => ({
                    label: r.service_date.slice(8),
                    value: r.n ? Math.round((100 * r.correct) / r.n) : 0,
                    title: `${r.service_date} — ${r.correct}/${r.n} találat`,
                  }))}
                  unit="%"
                  maxValue={100}
                  labelEvery={Math.max(1, Math.ceil(d.daily.length / 15))}
                />
              ) : (
                <EmptyChart />
              )}
            </ChartFrame>

            <ChartFrame
              title="Legtöbbet mért járművek"
              hint="Találati arány jármű szerint, csökkenő minta-szám szerint."
            >
              {d.byVehicle.length ? (
                <RankBars
                  rows={d.byVehicle.slice(0, 12).map((v) => ({
                    label: v.vehicle_id,
                    sub: `${v.n} jóslat`,
                    value: v.n ? Math.round((100 * v.correct) / v.n) : 0,
                    display: `${v.n ? Math.round((100 * v.correct) / v.n) : 0}%`,
                  }))}
                />
              ) : (
                <EmptyChart />
              )}
            </ChartFrame>
          </div>
        )}
      </QueryBoundary>

      <ChartFrame
        title="Élő jóslat egy járműre"
        hint="Melyik vonalon a legvalószínűbb, hogy ez a jármű legközelebb feltűnik."
        action={<Sparkles className="h-4 w-4 text-muted-foreground" />}
      >
        <div className="space-y-3">
          <QueryBoundary query={listQ} empty={(d) => d.vehicles.length === 0}>
            {(d) => (
              <SearchablePicker
                ariaLabel="Jármű keresése"
                placeholder="Rendszám, pl. 1641"
                value={vehicleId}
                onChange={setVehicleId}
                items={d.vehicles.map((v) => ({
                  id: v.vehicle_id,
                  label: v.vehicle_id,
                }))}
              />
            )}
          </QueryBoundary>
          {vehicleId ? (
            <VehiclePredictionCard vehicleId={vehicleId} />
          ) : (
            <EmptyChart>Válassz járművet.</EmptyChart>
          )}
        </div>
      </ChartFrame>
    </div>
  );
}
