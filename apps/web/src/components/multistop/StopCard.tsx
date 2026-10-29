import { useEffect, useRef, useState } from "react";
import { Bell, BellRing, ChevronLeft, ChevronRight, Crosshair, Trash2 } from "lucide-react";
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
import { formatDistance } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { checkAndNotify, getWatch } from "@/lib/notifications";
import { StopNotifyDialog } from "./StopNotifyDialog";
import { useFallbackPoll, useTopic } from "@/lib/realtime";
import { PREF_PREDICTED_VEHICLE, usePreference } from "@/hooks/usePreference";
import { describeApiError, type FriendlyError } from "@/lib/apiError";
import { ForecastLine } from "@/components/transit/ForecastLine";
import { RefreshCw } from "lucide-react";

/** hiba után ennyi idő múlva próbáljuk újra (duplázva, legfeljebb 30 mp-ig) */
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;

const POLL_MS = 4000;

function predictedTitle(p: { confidence: number; method?: string }): string {
  if (p.method === "matched") return "Már úton van — a GPS-nyomvonal alapján ez a busz viszi";
  return `Előrejelzés a korábbi fordák alapján, ${Math.round(p.confidence * 100)}% bizonyossággal`;
}

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
  distanceKm?: number | null;
  isNearest?: boolean;
};

export function StopCard({
  stop,
  onRemove,
  onFocusMap,
  className,
  reorder,
  distanceKm,
  isNearest,
}: StopCardProps) {
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const retryRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; delay: number }>({ timer: null, delay: RETRY_BASE_MS });
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [isWatching, setIsWatching] = useState(() => Boolean(getWatch(stop.id)));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [showPredicted] = usePreference(PREF_PREDICTED_VEHICLE, true);

  const apply = (res: StopArrivalsResponse) => {
    if (!mounted.current) return;
    setData(res);
    setError(null);
    retryRef.current.delay = RETRY_BASE_MS;
    checkAndNotify(stop.id, stop.name, res.arrivals);
  };

  // Hiba esetén nem a nyers hibaszöveg: rövid ok a kódból, és magától újrapróbálja.
  const load = async () => {
    try {
      apply(await api.getArrivals(stop.id, 8));
    } catch (err) {
      if (!mounted.current) return;
      setError(describeApiError(err));
      const r = retryRef.current;
      if (r.timer) clearTimeout(r.timer);
      r.timer = setTimeout(() => {
        r.timer = null;
        void load();
      }, r.delay);
      r.delay = Math.min(RETRY_MAX_MS, r.delay * 2);
    }
  };

  useEffect(
    () => () => {
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer);
    },
    [],
  );

  // A szerver magától küldi, amint a tábla változik (busz beért, elindult,
  // új késés) — nincs 4 mp-es várakozás. Pollozás csak kapcsolat nélkül.
  useTopic(`stop:${stop.id}`, (m) => apply(m.data as StopArrivalsResponse));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop.id]);
  useFallbackPoll(load, POLL_MS);

  const arrivals = data?.arrivals ?? [];
  const next: ArrivalItem | undefined = arrivals[0];
  const rest = arrivals.slice(1, 6);

  return (
    <Card
      className={cn(
        "flex min-w-0 flex-col overflow-hidden shadow-lg",
        isNearest && "border-2 border-primary",
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
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {distanceKm != null ? (
              <span className="font-semibold text-foreground">
                {formatDistance(distanceKm)}
              </span>
            ) : null}
            {stop.id}
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
                className={cn(
                  "h-8 w-8",
                  isWatching && "text-primary hover:text-primary",
                )}
                onClick={() => setNotifyOpen(true)}
                aria-label={`Értesítés beállítása — ${stop.name}`}
              >
                {isWatching ? <BellRing /> : <Bell />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isWatching ? "Értesítés beállítva" : "Értesítés beállítása"}
            </TooltipContent>
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

      <StopNotifyDialog
        open={notifyOpen}
        onOpenChange={setNotifyOpen}
        stopId={stop.id}
        stopName={stop.name}
        arrivals={arrivals}
        onChanged={setIsWatching}
      />

      {}
      <div className="border-b border-border bg-muted/30 px-4 py-3.5">
        {error ? (
          <p role="status" className="mb-2.5 flex items-center gap-2 rounded-lg border border-late/30 bg-late/10 px-3 py-2 text-xs">
            <RefreshCw aria-hidden className="h-3.5 w-3.5 shrink-0 text-late motion-safe:animate-spin" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-foreground">Hiba, újracsatlakozás…</span>{" "}
              <span className="text-muted-foreground">{error.reason}</span>
            </span>
            {error.code ? <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">{error.code}</span> : null}
          </p>
        ) : null}
        {!data ? (
          error ? null : (
          <p className="py-6 text-center font-mono text-xs text-muted-foreground">
            Indulások lekérése…
          </p>
          )
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
              {next.cancelled ? (
                <span className="rounded-md border border-destructive/50 bg-destructive/12 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive">
                  Törölve
                </span>
              ) : (
                <LiveTag live={next.live} />
              )}
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
                    <span className={cn("font-mono text-xs tabular-nums text-muted-foreground", next.cancelled && "line-through decoration-destructive/70 decoration-2")}>
                      {next.time}
                    </span>
                    {next.cancelled ? null : <DelayBar delaySec={next.delaySec ?? next.measuredDelaySec ?? null} />}
                  </div>
                </div>
              </div>

              {/* Az MVK kihúzta: nem jön, nincs mit visszaszámolni. */}
              {next.cancelled ? (
                <span className="shrink-0 pt-1 text-xs font-semibold text-destructive">nem jön</span>
              ) : (
                <Countdown etaMin={next.etaMin} />
              )}
            </div>

            {}
            {!next.vehicle && next.predictedVehicle && showPredicted && !next.cancelled ? (
              <p
                className="mt-3 text-[11px] text-muted-foreground"
                title={predictedTitle(next.predictedVehicle)}
              >
                Várhatóan a{" "}
                <span className="rounded border border-dashed border-primary/50 px-1.5 py-px font-mono font-bold tabular-nums text-primary">
                  {next.predictedVehicle.id}
                </span>{" "}
                jön
              </p>
            ) : null}
            <ForecastLine className="mt-2.5" mode="worst" delayS={next.forecastDelaySec} upperS={next.forecastUpperSec} />
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
                        ) : bus.predictedVehicle && showPredicted ? (
                          <span
                            className="rounded border border-dashed border-primary/40 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary/80"
                            title={predictedTitle(bus.predictedVehicle)}
                          >
                            ~{bus.predictedVehicle.id}
                          </span>
                        ) : null}
                        {bus.cancelled ? (
                          <span className="rounded bg-destructive/15 px-1.5 py-px text-[10px] font-bold uppercase text-destructive">
                            törölve
                          </span>
                        ) : null}
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {bus.time}
                        </span>
                        <DelayBar delaySec={bus.delaySec ?? bus.measuredDelaySec ?? null} showLabel={false} />
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
Nincs több ismert indulás.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
