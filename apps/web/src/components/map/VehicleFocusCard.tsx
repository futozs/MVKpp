import { useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Gauge, Navigation, TicketCheck, X } from "lucide-react";
import type { Stop } from "@/types";
import { useTripPath } from "@/hooks/useTripPath";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import { LiveDot } from "@/components/transit/LiveDot";
import { ApproachStrip } from "@/components/transit/ApproachStrip";
import { cn } from "@/lib/utils";
import { boardVehicle } from "@/components/ride/RideLayer";

type VehicleFocusCardProps = {
  tripId: string;
  vehicleId: string | null;
  stops: Stop[];
  onClose: () => void;
};

export function VehicleFocusCard({
  tripId,
  vehicleId,
  stops,
  onClose,
}: VehicleFocusCardProps) {
  const { data, lost } = useTripPath(tripId, vehicleId);
  const reduce = useReducedMotion();

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

      {shownId && data ? (
        <div className="px-4 pb-3">
          <Button
            className="w-full"
            onClick={() =>
              boardVehicle(
                { tripId: data.trip ?? tripId, vehicleId: shownId, route: data.route, color: data.color, text: data.text, headsign: data.headsign },
                "manual",
              )
            }
          >
            <TicketCheck /> Felszálltam erre a buszra
          </Button>
        </div>
      ) : null}

      <ApproachStrip
        tripId={data?.trip ?? tripId}
        shape={data?.shape}
        vehicle={vehicle}
        stops={stops}
        deviationSec={data?.scheduleDeviationSec}
      />
    </motion.aside>
  );
}
