import { useEffect, useState } from "react";
import type { BoardVehicle, RecordsResult } from "@mvk/core";
import type { Route } from "@/types";
import { RouteTile } from "@/components/transit/RouteTile";
import { formatDayLabel } from "@/components/map/historyTime";
import { cn } from "@/lib/utils";
import { fetchCached } from "./fleetCache";
import { minShort } from "./fleetText";
import { ON_TIME_S } from "./RankList";

/**
 * A kiválasztott vonalak egy pillantásra: most (vagy a visszanézett
 * pillanatban) hány jármű jár, hány késik, mennyi a legtöbb; és az egész
 * napon hány menet volt, ezek hány százaléka késett.
 */
export function RouteSummary({ routes, vehicles, date, past, allRoutes }: { routes: string[]; vehicles: BoardVehicle[]; date: string; past: boolean; allRoutes: Route[] }) {
  const [day, setDay] = useState<RecordsResult | null>(null);
  const key = routes.join(",");
  useEffect(() => {
    let alive = true;
    setDay(null);
    fetchCached<RecordsResult>(`/engine/fleet/records?date=${date}&period=day&kind=late&limit=1&routes=${encodeURIComponent(key)}`, 120)
      .then((r) => alive && setDay(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [date, key]);

  const now = vehicles.filter((v) => routes.includes(v.route));
  const late = now.filter((v) => v.delayS >= ON_TIME_S).length;
  const worst = now.length ? Math.max(...now.map((v) => v.delayS)) : null;
  const byShort = new Map(allRoutes.map((r) => [r.short, r]));
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

  return (
    <section aria-label="A kiválasztott vonalak" className="mb-3 rounded-xl border border-primary/30 bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {routes.map((r) => (
          <RouteTile key={r} short={r} color={byShort.get(r)?.color} text={byShort.get(r)?.text} size="sm" />
        ))}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-3">
        <dl>
          <dt className="text-[11px] font-semibold text-muted-foreground">{past ? "Akkor" : "Most"}</dt>
          <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 whitespace-nowrap text-[13px]">
            <span>
              <b className="text-[17px] tabular-nums">{now.length}</b> úton
            </span>
            <span className={cn(late && "text-late")}>
              <b className="text-[17px] tabular-nums">{late}</b> késik
            </span>
            {worst != null && worst >= ON_TIME_S ? <span className="font-bold tabular-nums text-late">{minShort(worst)}</span> : null}
          </dd>
        </dl>
        <dl>
          <dt className="text-[11px] font-semibold text-muted-foreground">{formatDayLabel(date, true)}, egész nap</dt>
          <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 whitespace-nowrap text-[13px]">
            {day ? (
              <>
                <span>
                  <b className="text-[17px] tabular-nums">{day.runs}</b> menet
                </span>
                <span className="text-late">
                  <b className="text-[17px] tabular-nums">{pct(day.late5, day.runs)}</b> késett
                </span>
                {day.items[0] ? <span className="font-bold tabular-nums text-late">{minShort(day.items[0].delayS)}</span> : null}
              </>
            ) : (
              <span className="h-5 w-32 animate-pulse rounded bg-muted/50" />
            )}
          </dd>
        </dl>
      </div>
    </section>
  );
}
