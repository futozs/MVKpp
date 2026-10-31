import type { Stop } from "@/types";
import { feedOfId } from "@/lib/modes";
import { cn } from "@/lib/utils";
import { TrainTimetable } from "./TrainTimetable";
import { VehicleFocusCard } from "./VehicleFocusCard";

/** Követett vonat: asztalon a jobb oldali oszlop teljes magasságát kapja (a menetrend miatt). */
export const isRailFocus = (tripId: string | null) => Boolean(tripId) && feedOfId(tripId!) === "rail";

/**
 * A követett jármű panelje a térkép fölött: telefonon alul teljes szélességben, asztalon
 * jobb oldalt. Vonatnál a követés-kártya fölött a menetrend is ott van — asztalon az
 * oszlop teljes magasságáig nőhet, telefonon összecsukva a következő állomásokkal.
 * A `data-map-cover` alapján tartja a térkép a követett járművet a látható rész közepén.
 */
export function FocusDock({
  tripId,
  vehicleId,
  stops,
  onClose,
  followPaused,
}: {
  tripId: string;
  vehicleId: string | null;
  stops: Stop[];
  onClose: () => void;
  followPaused: boolean;
}) {
  const rail = isRailFocus(tripId);
  return (
    <div
      data-map-cover=""
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-drawer flex flex-col",
        "md:inset-x-auto md:bottom-4 md:right-4 md:w-[380px] md:gap-3",
        rail && "md:top-4 md:justify-end",
      )}
    >
      {rail ? <TrainTimetable key={tripId} tripId={tripId} className="pointer-events-auto" /> : null}
      <VehicleFocusCard tripId={tripId} vehicleId={vehicleId} stops={stops} onClose={onClose} followPaused={followPaused} className="pointer-events-auto" />
    </div>
  );
}
