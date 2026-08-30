import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ArrivalItem, Stop, StopArrivalsResponse } from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Countdown } from "@/components/transit/Countdown";
import { DelayBar } from "@/components/transit/DelayBar";
import { LiveTag } from "@/components/transit/LiveDot";
import { RouteTile } from "@/components/transit/RouteTile";
import { VehicleTrack } from "@/components/transit/VehicleTrack";
import { cn } from "@/lib/utils";

const POLL_MS = 4000;

export type StopCardReorder = {
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
};

type StopCardProps = {
  stop: Stop;
  onRemove: (stopId: string) => void;
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void;
  className?: string;
  reorder?: StopCardReorder;
};

export function StopCard({
  stop,
  onRemove,
  onFocusMap,
  className,
  reorder,
}: StopCardProps) {
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.getArrivals(stop.id, 8);
      if (!mounted.current) return;
      setData(res);
      setError(null);
      setLastFetch(new Date());
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  };

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [stop.id]);

  const arrivals = data?.arrivals ?? [];
  const next: ArrivalItem | undefined = arrivals[0];
  const rest = arrivals.slice(1, 6);

  return (
    <Card
      className={cn(
        "flex min-w-0 flex-col overflow-hidden shadow-lg",
        className,
      )}
    >
      {}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3
            className="truncate text-base font-bold tracking-tight"
            title={stop.name}
          >
            {stop.name}
          </h3>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {stop.id}
            {lastFetch
              ? ` · ${lastFetch.toLocaleTimeString("hu-HU", {
                  minute: "2-digit",
                  second: "2-digit",
                })}`
              : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {}
          {reorder ? (
            <>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={reorder.onMoveEarlier}
                disabled={!reorder.canMoveEarlier}
                aria-label={`${stop.name} előrébb helyezése`}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={reorder.onMoveLater}
                disabled={!reorder.canMoveLater}
                aria-label={`${stop.name} hátrébb helyezése`}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => load(false)}
                disabled={loading}
                aria-label={`${stop.name} indulásainak újralekérése`}
              >
                <RefreshCw
                  className={cn(loading && "animate-spin text-primary")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Indulások újralekérése</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onFocusMap(stop)}
                aria-label={`${stop.name} megjelenítése a térképen`}
              >
                <Crosshair />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Megjelenítés a térképen</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-destructive/15 hover:text-destructive"
                onClick={() => onRemove(stop.id)}
                aria-label={`${stop.name} levétele a figyelőről`}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Levétel a figyelőről</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {}
      <div className="border-b border-border bg-muted/30 px-4 py-3.5">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : !data ? (
          <p className="py-6 text-center font-mono text-xs text-muted-foreground">
            Indulások lekérése…
          </p>
        ) : !next ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Ebben az órában nincs több indulás.
          </p>
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Következő
              </span>
              <LiveTag live={next.live} />
            </div>

            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <RouteTile
                  short={next.route}
                  color={next.color}
                  text={next.text}
                  size="lg"
                />
                <div className="min-w-0 pt-0.5">
                  <p
                    className="truncate text-sm font-semibold"
                    title={next.headsign}
                  >
                    {next.headsign}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {next.time}
                    </span>
                    <DelayBar delaySec={next.delaySec} />
                  </div>
                </div>
              </div>

              <Countdown etaMin={next.etaMin} />
            </div>

            {}
            <VehicleTrack
              className="mt-3"
              vehicle={next.vehicle}
              progressDesc={next.progressDesc}
              onTrack={
                next.vehicle
                  ? () => onFocusMap(stop, next.tripId, next.vehicle?.id)
                  : undefined
              }
            />
          </>
        )}
      </div>

      {}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rest.length > 0 ? (
          <ul className="divide-y divide-border/60">
            {rest.map((bus, i) => {
              const focusable = bus.live && Boolean(bus.tripId);
              return (
                <li key={`${bus.tripId}-${i}`}>
                  <div
                    role={focusable ? "button" : undefined}
                    tabIndex={focusable ? 0 : undefined}
                    onClick={
                      focusable
                        ? () => onFocusMap(stop, bus.tripId, bus.vehicle?.id)
                        : undefined
                    }
                    onKeyDown={
                      focusable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onFocusMap(stop, bus.tripId, bus.vehicle?.id);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast",
                      focusable &&
                        "cursor-pointer hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <RouteTile
                      short={bus.route}
                      color={bus.color}
                      text={bus.text}
                    />

                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-xs font-medium"
                        title={bus.headsign}
                      >
                        {bus.headsign}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        {}
                        {bus.vehicle ? (
                          <span className="rounded bg-primary/12 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary">
                            {bus.vehicle.id}
                          </span>
                        ) : null}
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {bus.time}
                        </span>
                        <DelayBar delaySec={bus.delaySec} showLabel={false} />
                      </div>
                      {bus.progressDesc ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {bus.progressDesc}
                        </p>
                      ) : null}
                    </div>

                    <span className="shrink-0 font-mono text-base font-bold tabular-nums">
                      {bus.etaMin <= 0 ? (
                        <span className="text-live">most</span>
                      ) : (
                        <>
                          {bus.etaMin}
                          <span className="ml-0.5 font-sans text-[11px] font-semibold text-muted-foreground">
                            p
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : data && next ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            Ez az utolsó ismert indulás ebben az időablakban.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
