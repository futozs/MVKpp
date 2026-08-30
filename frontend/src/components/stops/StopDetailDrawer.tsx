import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
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
import { cn } from "@/lib/utils";

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
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduce = useReducedMotion();
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

    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await api.getArrivals(stopId, 16);
        if (!mounted.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (mounted.current) setError((err as Error).message);
      } finally {
        if (mounted.current && !silent) setLoading(false);
      }
    };

    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [stopId]);

  useEffect(() => {
    if (!stopId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopId, onClose]);

  const stop = stops.find((s) => s.id === stopId);
  if (!stopId || !stop) return null;

  const monitored = monitoredStopIds.includes(stop.id);
  const arrivals = data?.arrivals ?? [];

  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      aria-label={`${stop.name} indulásai`}
      className={cn(
        "absolute inset-x-0 bottom-0 z-drawer flex max-h-[70vh] flex-col overflow-hidden",
        "border-t border-border bg-card shadow-xl",
        "md:inset-x-auto md:bottom-4 md:right-4 md:w-[380px] md:rounded-xl md:border",
      )}
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold tracking-tight">
            {stop.name}
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span>{stop.code || stop.id}</span>
            <span aria-hidden>·</span>
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
              const focusable = arr.live && Boolean(arr.tripId);
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
                      "flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast",
                      focusable &&
                        "cursor-pointer hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <RouteTile
                      short={arr.route}
                      color={arr.color}
                      text={arr.text}
                    />

                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                        <span className="truncate">{arr.headsign}</span>
                        {arr.live ? <LiveDot /> : null}
                      </p>

                      <div className="mt-1 flex items-center gap-2">
                        {}
                        {arr.vehicle ? (
                          <span className="rounded bg-primary/12 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary">
                            {arr.vehicle.id}
                          </span>
                        ) : null}
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {arr.time}
                        </span>
                        <DelayBar delaySec={arr.delaySec} showLabel={false} />
                      </div>

                      {arr.progressDesc ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {arr.progressDesc}
                        </p>
                      ) : null}
                    </div>

                    <span className="shrink-0 font-mono text-base font-bold tabular-nums">
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
