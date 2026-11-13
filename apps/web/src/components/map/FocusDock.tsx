import type { Route, Stop } from "@/types";
import { feedOfId } from "@/lib/modes";
import { cn } from "@/lib/utils";
import { TripTimetable } from "./TripTimetable";
import { VehicleFocusCard } from "./VehicleFocusCard";

/**
 * A követett jármű panelje a térkép fölött: telefonon alul teljes szélességben, asztalon
 * jobb oldalt az oszlop teljes magasságában, a követés-kártya fölött a menet menetrendjével
 * (hol tart, melyik a következő megálló). Telefonon csak vonatnál van menetrend, összecsukva
 * a következő állomásokkal  a buszé, villamosé, Voláné ott a kártya marad.
 * A `data-map-cover` alapján tartja a térkép a követett járművet a látható rész közepén.
 */
export function FocusDock({
  tripId,
  vehicleId,
  stops,
  routes,
  onClose,
  followPaused,
}: {
  tripId: string;
  vehicleId: string | null;
  stops: Stop[];
  routes: Record<string, Route>;
  onClose: () => void;
  followPaused: boolean;
}) {
  const rail = feedOfId(tripId) === "rail";
  return (
    <div
      data-map-cover=""
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-drawer flex flex-col",
        "md:inset-x-auto md:bottom-4 md:right-4 md:top-4 md:w-[380px] md:justify-end md:gap-3",
      )}
    >
      <TripTimetable key={tripId} tripId={tripId} className={cn("pointer-events-auto", !rail && "hidden md:flex")} />
      <VehicleFocusCard tripId={tripId} vehicleId={vehicleId} stops={stops} routes={routes} onClose={onClose} followPaused={followPaused} className="pointer-events-auto" />
    </div>
  );
}
