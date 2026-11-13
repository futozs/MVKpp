import { useEffect, useRef, useState } from "react";
import { motion, useDragControls, useReducedMotion } from "framer-motion";
import { Check, Plus, X } from "lucide-react";
import type { ArrivalItem, Stop, StopArrivalsResponse } from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DelayBar } from "@/components/transit/DelayBar";
import { LiveDot } from "@/components/transit/LiveDot";
import { RouteTile } from "@/components/transit/RouteTile";
import { CatchPill, ReplacementNote, replacementFor, StartRiskLine, TrafficLine } from "@/components/transit/TripInsights";
import { useCatchFor } from "@/hooks/useCatch";
import { useWatchFeatures } from "@/lib/watchPrefs";
import { cn } from "@/lib/utils";
import { arrivalTileText, arrivalTitle, arrivalVehicleLabel, NoticeList, PlatformBadge, SharedStopTag, stopKindLabel } from "@/components/transit/RegionalBits";
import { useBoardKey } from "@/lib/modes";

const POLL_MS = 4000;

interface StopDetailDrawerProps {
  stopId: string | null;
  stops: Stop[];
  onClose: () => void;
  onFocusTrip: (tripId: string, vehicleId?: string) => void;
  monitoredStopIds: string[];
  onToggleMonitorStop: (stopId: string) => void;
}

export function StopDetailDrawer({
  stopId,
  stops,
  onClose,
  onFocusTrip,
  monitoredStopIds,
  onToggleMonitorStop,
}: StopDetailDrawerProps) {
  // a bekapcsolt módok indulásai (a közös MVK-megállón a Volán is)
  const modesKey = useBoardKey();
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const dragControls = useDragControls();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!stopId) {
      setData(null);
      setError(null);
      return;
    }

    // Másik megálló: az előző indulásai egy pillanatig se látszódjanak az új neve alatt,
    // és egy lassan visszaérő régi válasz se írja felül az újat.
    let alive = true;
    setData(null);
    setError(null);
    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await api.getArrivals(stopId, 16, modesKey);
        if (!alive || !mounted.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (alive && mounted.current) setError((err as Error).message);
      } finally {
        if (alive && mounted.current && !silent) setLoading(false);
      }
    };

    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [stopId, modesKey]);

  useEffect(() => {
    if (!stopId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopId, onClose]);

  const stop = stops.find((s) => s.id === stopId);
  // (a korai visszatérés előtt: a hookok sorrendje minden renderben azonos)
  const catchFor = useCatchFor(stop);
  const f = useWatchFeatures();
  if (!stopId || !stop) return null;

  const monitored = monitoredStopIds.includes(stop.id);
  const arrivals = data?.arrivals ?? [];

  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.55 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 90 || info.velocity.y > 650) onClose();
      }}
      aria-label={`${stop.name} indulásai`}
      className={cn(
        "absolute inset-x-0 bottom-0 z-drawer flex max-h-[50dvh] flex-col overflow-hidden",
        "rounded-t-2xl border-t border-border bg-card shadow-2xl",
        "md:inset-x-auto md:bottom-4 md:right-4 md:max-h-[min(62vh,520px)] md:w-[340px] md:rounded-xl md:border",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label="Lehúzva bezárható"
        onPointerDown={(e) => dragControls.start(e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClose();
          }
        }}
        className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing md:hidden"
      >
        <span aria-hidden className="h-1 w-10 rounded-full bg-muted-foreground/40" />
      </div>

      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-3 pb-2.5 pt-1 md:pt-2.5">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold tracking-tight">
            {stop.name}
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span>{stopKindLabel(stop)}</span>
            <span aria-hidden>·</span>
            {data?.merged ? (
              <>
                <SharedStopTag merged={data.merged} />
                <span aria-hidden>·</span>
              </>
            ) : null}
            {data?.rtError ? (
              <span>menetrendi</span>
            ) : (
              <span className="flex items-center gap-1.5 font-sans font-semibold text-live">
                <LiveDot />
                valós idejű
              </span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={monitored ? "default" : "outline"}
                size="icon"
                className="h-8 w-8"
                onClick={() => onToggleMonitorStop(stop.id)}
                aria-pressed={monitored}
                aria-label={
                  monitored
                    ? `${stop.name} levétele a figyelőről`
                    : `${stop.name} felvétele a figyelőre`
                }
              >
                {monitored ? <Check /> : <Plus />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {monitored ? "Levétel a figyelőről" : "Felvétel a figyelőre"}
            </TooltipContent>
          </Tooltip>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            aria-label="Panel bezárása"
          >
            <X />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p
            role="alert"
            className="m-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : loading && !data ? (
          <p className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">
            Indulások lekérése…
          </p>
        ) : arrivals.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            Nincs közelgő indulás erről a megállóról.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {arrivals.map((arr: ArrivalItem, i) => {
              // Kihúzott menetnél csak akkor visz a térképre, ha mégis jár rajta busz.
              const focusable = arr.live && Boolean(arr.tripId) && (!arr.cancelled || arr.vehicle != null);
              return (
                <li key={`${arr.tripId}-${i}`}>
                  <div
                    role={focusable ? "button" : undefined}
                    tabIndex={focusable ? 0 : undefined}
                    onClick={
                      focusable
                        ? () => onFocusTrip(arr.tripId, arr.vehicle?.id)
                        : undefined
                    }
                    onKeyDown={
                      focusable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onFocusTrip(arr.tripId, arr.vehicle?.id);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 transition-colors duration-fast",
                      focusable &&
                        "cursor-pointer hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <RouteTile
                      short={arrivalTileText(arr)}
                      color={arr.color}
                      text={arr.text}
                    />

                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                        <span className="truncate">{arrivalTitle(arr)}</span>
                        {arr.live && (!arr.cancelled || arr.vehicle) ? <LiveDot /> : null}
                      </p>

                      <div className="mt-1 flex items-center gap-2">
                        <PlatformBadge platform={arr.platform} changed={arr.platformChanged} predicted={arr.platformPredicted} mode={arr.mode} compact />
                        {arrivalVehicleLabel(arr) ? (
                          <span className="rounded bg-primary/12 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary">
                            {arrivalVehicleLabel(arr)}
                          </span>
                        ) : null}
                        <span className={cn("font-mono text-[11px] tabular-nums text-muted-foreground", arr.cancelled && "line-through decoration-destructive/70")}>
                          {arr.time}
                        </span>
                        {arr.cancelled ? (
                          <>
                            <span className="text-[10.5px] font-bold uppercase tracking-wide text-destructive">törölve</span>
                            {f.replacement ? <ReplacementNote compact cancelled={arr} instead={replacementFor(arrivals, arr)} /> : null}
                          </>
                        ) : (
                          <DelayBar delaySec={arr.measuredDelaySec ?? arr.delaySec ?? null} showLabel={false} />
                        )}
                        <CatchPill verdict={f.leaveTimes ? catchFor.verdict(arr) : null} />
                      </div>
                      {(f.startRisk && arr.startRisk) || (f.traffic && arr.trafficAhead) ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-2.5">
                          {f.startRisk ? <StartRiskLine risk={arr.startRisk} compact /> : null}
                          {f.traffic ? <TrafficLine traffic={arr.trafficAhead} compact /> : null}
                        </div>
                      ) : null}

                      {arr.progressDesc ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {arr.progressDesc}
                        </p>
                      ) : null}
                      <NoticeList notices={arr.notices} compact className="mt-1" />
                    </div>

                    <span className={cn("shrink-0 font-mono text-sm font-bold tabular-nums", arr.cancelled && "opacity-40 line-through")}>
                      {arr.etaMin <= 0 ? (
                        <span className="text-live">most</span>
                      ) : (
                        <>
                          {arr.etaMin}
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
        )}
      </div>
    </motion.aside>
  );
}
