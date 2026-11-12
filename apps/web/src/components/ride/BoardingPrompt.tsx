import { motion, useReducedMotion } from "framer-motion";
import { Bus, Check, CornerDownRight, Loader2, MapPin, Repeat, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import type { LiveVehicle } from "@/types";
import { journeyOf, useRides, type Ride } from "@/lib/rides";
import { displayVehicleId, rideModeOf, VEHICLE_WORDS } from "@/lib/modes";

/** „Éppen erre a buszra szálltál fel?” — a felismerő kérdése a térkép tetején. */
export function BoardingPrompt({ vehicle, onYes, onNo }: { vehicle: LiveVehicle; onYes: () => void; onNo: () => void }) {
  const reduce = useReducedMotion();
  const w = VEHICLE_WORDS[vehicle.mode ?? rideModeOf(vehicle.id, vehicle.tripId)];
  const rail = vehicle.mode === "rail";
  return (
    <motion.div
      role="alertdialog"
      aria-label="Felszállás felismerve"
      initial={reduce ? false : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute inset-x-3 top-3 z-drawer mx-auto max-w-md rounded-2xl border border-primary/40 bg-card p-4 shadow-xl"
    >
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-primary">
        <Bus className="h-3.5 w-3.5" /> Együtt mozogsz egy {w.val}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <RouteTile short={rail && vehicle.trainNo ? `${vehicle.routeShort} ${vehicle.trainNo}` : vehicle.routeShort} color={vehicle.routeColor} text={vehicle.routeText} size="lg" />
        <p className="min-w-0 flex-1 text-sm">
          Éppen erre a {w.ra} szálltál fel? <span className="block truncate font-semibold">{vehicle.headsign}</span>
          <span className="font-mono text-xs text-muted-foreground">{rail ? (vehicle.trainName ?? "") : displayVehicleId(vehicle.id, vehicle.plate)}</span>
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

/** Az app zárta le (nem az utas jelölte ki, hol száll le): ilyenkor megkérdezzük, jó-e így. */
export const endedOnItsOwn = (r: Ride) => r.endedBy === "terminus" || r.endedBy === "away";

/**
 * Utazás után: rövid összegzés (körbeutazásnál az egész útról). Fordulóhurkos
 * végállomáson innen indítható a körbeutazás (a busz következő menetével). Ha az
 * app maga zárta le, addig marad, amíg nem nyugtázod, és itt jelölheted ki, hol
 * szálltál le valójában.
 */
export function RideSavedNote({
  ride: last,
  onClose,
  onFix,
  onContinue,
  onLoop,
  looping,
}: {
  ride: Ride;
  onClose: () => void;
  onFix?: () => void;
  /** a végállomáson lezárt út: a buszon maradt, és tovább utazott (utólag, a menetrendből) */
  onContinue?: () => void;
  /** fordulóhurkos végállomáson ért véget: „Körbeutazok” — élőben folytatja a busz következő menetével */
  onLoop?: () => void;
  looping?: boolean;
}) {
  const all = useRides();
  const legs = journeyOf(all, last);
  const first = legs[0] ?? last;
  const sum = (pick: (r: Ride) => number | null) => (legs.some((r) => pick(r) != null) ? legs.reduce((a, r) => a + (pick(r) ?? 0), 0) : null);
  const ride = { ...last, fromStopName: first.fromStopName, stops: sum((r) => r.stops), distanceM: sum((r) => r.distanceM), boardedAt: first.boardedAt };
  const mins = ride.alightedAt ? Math.max(1, Math.round((ride.alightedAt - ride.boardedAt) / 60)) : null;
  const ask = endedOnItsOwn(last) && onFix;
  const title = ask
    ? last.endedBy === "terminus"
      ? "Lezártam az utazásod a végállomáson"
      : "Úgy láttam, leszálltál — lezártam"
    : legs.length > 1
      ? `Körbeutazás elmentve · ${legs.length} menet`
      : "Utazás elmentve";
  return (
    <div role="status" className="absolute inset-x-3 bottom-3 z-drawer mx-auto max-w-md rounded-2xl border border-border bg-card p-4 shadow-xl md:inset-x-auto md:right-4 md:w-[380px]">
      <div className="flex items-start gap-3">
        <RouteTile short={ride.route} color={ride.color} text={ride.text} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{title}</p>
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
      {ask ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="flex-1" onClick={onClose}>
            <Check /> Így jó
          </Button>
          <Button size="sm" variant="outline" className="flex-1" onClick={onFix}>
            <MapPin /> Hol szálltam le?
          </Button>
        </div>
      ) : null}
      {onLoop ? (
        <Button size="sm" variant={ask ? "ghost" : "outline"} className="mt-2.5 w-full border-primary/50" onClick={onLoop} disabled={looping}>
          {looping ? <Loader2 className="animate-spin" /> : <Repeat className="text-primary" />} Körbeutazok — a buszon maradtam
        </Button>
      ) : last.endedBy === "terminus" && onContinue ? (
        <Button size="sm" variant="ghost" className="mt-1.5 w-full" onClick={onContinue}>
          <CornerDownRight /> A buszon maradtam, tovább utaztam
        </Button>
      ) : null}
    </div>
  );
}
