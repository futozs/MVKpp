import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { Route } from "@/types";
import { API_BASE } from "@/lib/apiBase";
import { cn } from "@/lib/utils";
import { ChartFrame } from "@/components/charts/Charts";
import { QueryBoundary, PillPicker, SearchablePicker } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";
import { RouteHeat, type RouteHeatData } from "./heat/RouteHeat";
import type { CityHeatData } from "./heat/CityHeat";

// A térkép (Leaflet) csak a Város nézethez töltődik be.
const CityHeat = lazy(() => import("./heat/CityHeat").then((m) => ({ default: m.CityHeat })));

const DAYTYPES = [
  { id: "0", label: "Munkanap" },
  { id: "1", label: "Szombat" },
  { id: "2", label: "Vasárnap, ünnep" },
] as const;

const RANGES = [
  { id: "14", label: "14 nap" },
  { id: "28", label: "4 hét" },
  { id: "60", label: "2 hónap" },
] as const;

const VIEWS = [
  { id: "route", label: "Vonal" },
  { id: "city", label: "Város" },
] as const;

const ROUTE_KEY = "mvk_heat_route";

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(r.status === 404 ? "Erre a vonalra nincs adat." : r.status === 503 ? "A menetrend még töltődik — próbáld újra pár másodperc múlva." : `Hiba (${r.status})`);
  return (await r.json()) as T;
}

function readRoute(): string | null {
  try {
    return localStorage.getItem(ROUTE_KEY);
  } catch {
    return null;
  }
}

/**
 * Hőtérkép: hol és mikor késnek a buszok.
 *  · Vonal — egy vonal megállói × a nap órái: mennyit késik, és hol szedi fel
 *  · Város — a teljes hálózat megállóközei a térképen, óráról órára lejátszva
 */
export function HeatPanel({ routes }: { routes: Route[] }) {
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("route");
  const [daytype, setDaytype] = useState<(typeof DAYTYPES)[number]["id"]>("0");
  const [days, setDays] = useState<(typeof RANGES)[number]["id"]>("28");
  const [route, setRoute] = useState<string | null>(() => readRoute());
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    if (!route && routes.length) setRoute(routes.find((r) => r.short === "14")?.short ?? routes[0].short);
  }, [route, routes]);

  const pickRoute = (short: string) => {
    setRoute(short);
    setDir(null);
    try {
      localStorage.setItem(ROUTE_KEY, short);
    } catch {
      /* privát mód */
    }
  };

  const routeQ = useStatsQuery<RouteHeatData>(
    useCallback(
      () => getJson(`/engine/heat/route?route=${encodeURIComponent(route ?? "")}${dir != null ? `&dir=${encodeURIComponent(dir)}` : ""}&days=${days}&daytype=${daytype}`),
      [route, dir, days, daytype],
    ),
    [route, dir, days, daytype],
    view === "route" && Boolean(route),
  );
  const cityQ = useStatsQuery<CityHeatData>(
    useCallback(() => getJson(`/engine/heat/city?days=${days}&daytype=${daytype}`), [days, daytype]),
    [days, daytype],
    view === "city",
  );

  const routeData = routeQ.data && routeQ.data.route === route ? routeQ.data : null;

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight sm:text-xl">Hőtérkép</h2>
            <p className="mt-0.5 max-w-2xl text-[12.5px] text-muted-foreground">
              Hol és mikor késnek a buszok — a lezárt napok mért megálló-időiből, mediánnal (egy-egy kiugró menet nem torzít).
            </p>
          </div>
          <div role="tablist" aria-label="Nézet" className="flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                onClick={() => setView(v.id)}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors",
                  view === v.id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <PillPicker ariaLabel="Naptípus" value={daytype} onChange={(v) => setDaytype(v as typeof daytype)} items={DAYTYPES.map((d) => ({ id: d.id, label: d.label }))} />
          <PillPicker ariaLabel="Időszak" value={days} onChange={(v) => setDays(v as typeof days)} items={RANGES.map((r) => ({ id: r.id, label: r.label }))} />
        </div>
      </header>

      {view === "route" ? (
        <>
          <SearchablePicker
            ariaLabel="Vonal"
            placeholder="Vonal keresése"
            value={route}
            onChange={pickRoute}
            items={routes.map((r) => ({ id: r.short, label: r.short, sub: r.long, color: r.color }))}
            limit={80}
          />
          <ChartFrame
            title={routeData ? `${routeData.route} — ${routeData.directions.find((d) => d.dir === routeData.dir)?.headsign ?? ""}` : "Vonal-hőtérkép"}
            hint="megállók menetirányban × a nap órái"
            action={
              routeData && routeData.directions.length > 1 ? (
                <div className="flex flex-wrap gap-1">
                  {routeData.directions.map((d) => (
                    <button
                      key={d.dir}
                      type="button"
                      onClick={() => setDir(d.dir)}
                      aria-pressed={d.dir === routeData.dir}
                      className={cn(
                        "max-w-[200px] truncate rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold",
                        d.dir === routeData.dir ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {d.headsign}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
          >
            <QueryBoundary query={routeQ} empty={(d) => d.cells.length === 0}>
              {() => (routeData ? <RouteHeat data={routeData} /> : null)}
            </QueryBoundary>
          </ChartFrame>
        </>
      ) : (
        <ChartFrame title="Városi hőtérkép" hint="megállóközönként: mennyi időt veszít a busz a menetrendhez képest">
          <QueryBoundary query={cityQ} empty={(d) => d.segments.length === 0}>
            {(d) => (
              <Suspense fallback={<p className="py-10 text-center font-mono text-xs text-muted-foreground">Térkép betöltése…</p>}>
                <CityHeat data={d} />
              </Suspense>
            )}
          </QueryBoundary>
        </ChartFrame>
      )}
    </div>
  );
}
