import { motion, useReducedMotion } from "framer-motion";
import { Bus, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import type { LiveVehicle } from "@/types";
import type { Ride } from "@/lib/rides";

/** „Éppen erre a buszra szálltál fel?” — a felismerő kérdése a térkép tetején. */
export function BoardingPrompt({ vehicle, onYes, onNo }: { vehicle: LiveVehicle; onYes: () => void; onNo: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="alertdialog"
      aria-label="Felszállás felismerve"
      initial={reduce ? false : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute inset-x-3 top-3 z-drawer mx-auto max-w-md rounded-2xl border border-primary/40 bg-card p-4 shadow-xl"
    >
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-primary">
        <Bus className="h-3.5 w-3.5" /> Együtt mozogsz egy busszal
      </p>
      <div className="mt-2 flex items-center gap-3">
        <RouteTile short={vehicle.routeShort} color={vehicle.routeColor} text={vehicle.routeText} size="lg" />
        <p className="min-w-0 flex-1 text-sm">
          Éppen erre a buszra szálltál fel? <span className="block truncate font-semibold">{vehicle.headsign}</span>
          <span className="font-mono text-xs text-muted-foreground">{vehicle.id}</span>
        </p>
      </div>
      <div className="mt-3 flex gap-2">
        <Button className="flex-1" onClick={onYes}>
          <Check /> Igen, felszálltam
        </Button>
        <Button variant="outline" onClick={onNo}>
          <X /> Nem
        </Button>
      </div>
    </motion.div>
  );
}

const fmtKm = (m: number | null) => (m == null ? null : `${(m / 1000).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} km`);

/** Utazás után: rövid összegzés, néhány másodpercig. */
export function RideSavedNote({ ride, onClose }: { ride: Ride; onClose: () => void }) {
  const mins = ride.alightedAt ? Math.max(1, Math.round((ride.alightedAt - ride.boardedAt) / 60)) : null;
  return (
    <div role="status" className="absolute inset-x-3 bottom-3 z-drawer mx-auto max-w-md rounded-2xl border border-border bg-card p-4 shadow-xl md:inset-x-auto md:right-4 md:w-[380px]">
      <div className="flex items-start gap-3">
        <RouteTile short={ride.route} color={ride.color} text={ride.text} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">Utazás elmentve</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {ride.fromStopName ?? "?"} → {ride.toStopName ?? "?"}
          </p>
          <p className="mt-1 font-mono text-xs">
            {[mins != null ? `${mins} perc` : null, ride.stops != null ? `${ride.stops} megálló` : null, fmtKm(ride.distanceM), ride.vehicleId].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Bezárás" className="rounded-md p-1 text-muted-foreground hover:bg-accent">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
