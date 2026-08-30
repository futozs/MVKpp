import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Gauge, Navigation, X } from "lucide-react";
import type { TripPathResponse } from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import { LiveDot } from "@/components/transit/LiveDot";
import { cn } from "@/lib/utils";

const POLL_MS = 4000;

type VehicleFocusCardProps = {
  tripId: string;
  vehicleId: string | null;
  onClose: () => void;
};

export function VehicleFocusCard({
  tripId,
  vehicleId,
  onClose,
}: VehicleFocusCardProps) {
  const [data, setData] = useState<TripPathResponse | null>(null);
  const [lost, setLost] = useState(false);
  const reduce = useReducedMotion();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.getTripPath(tripId, vehicleId ?? undefined);
        if (!mounted.current) return;
        setData(res);
        setLost(!res.vehicle);
      } catch {
        if (mounted.current) setLost(true);
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [tripId, vehicleId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vehicle = data?.vehicle ?? null;
  const speedKmh =
    vehicle?.speed != null ? Math.round(vehicle.speed * 3.6) : null;
  const moving = speedKmh != null && speedKmh > 2;
  const shownId = vehicle?.id ?? vehicleId;

  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Követett jármű"
      className={cn(
        "absolute inset-x-0 bottom-0 z-drawer overflow-hidden",
        "border-t border-border bg-card shadow-xl",
        "md:inset-x-auto md:bottom-4 md:right-4 md:w-[380px] md:rounded-xl md:border",
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <RouteTile
          short={data?.route ?? "…"}
          color={data?.color}
          text={data?.text}
          size="lg"
        />

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-bold tracking-tight">
            <span className="truncate">
              {data?.headsign ?? "Menet betöltése…"}
            </span>
            {vehicle ? <LiveDot /> : null}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {shownId ? (
              <span className="rounded bg-primary/12 px-1.5 py-0.5 font-mono text-sm font-bold tabular-nums text-primary">
                {shownId}
              </span>
            ) : null}

            {speedKmh != null ? (
              <span
                className={cn(
                  "flex items-center gap-1 font-mono text-xs font-semibold tabular-nums",
                  moving ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Gauge aria-hidden className="h-3.5 w-3.5" />
                {speedKmh} km/h
              </span>
            ) : null}

            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Navigation aria-hidden className="h-3 w-3 text-primary" />
              {lost ? "A jármű kiesett a jelentésből" : "A térkép követi"}
            </span>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onClose}
          aria-label="Menetkövetés vége"
        >
          <X />
        </Button>
      </div>
    </motion.aside>
  );
}
