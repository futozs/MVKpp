import { useEffect, useRef } from "react";
import { RouteTile } from "@/components/transit/RouteTile";
import { displayVehicleId } from "@/lib/modes";
import { cn } from "@/lib/utils";
import type { PastTripRow } from "./rideLogApi";

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
export const hmOf = (unix: number) => HM.format(new Date(unix * 1000));

/**
 * A menetrend menetei választásra: indulás, merre, és melyik busz futott rajta
 * (ha a rendszer látta). `focusId`: ez a menet legyen szem előtt (a legutóbb elindult).
 */
export function PastTripList<T extends PastTripRow>({
  trips,
  focusId,
  badge,
  onPick,
  className,
}: {
  trips: T[];
  focusId?: string | null;
  /** megjegyzés a menet mellett (pl. „ez a busz”) */
  badge?: (t: T) => string | null;
  onPick: (t: T) => void;
  className?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[data-focus="true"]')?.scrollIntoView({ block: "center" });
  }, [focusId]);

  return (
    <ul ref={ref} className={cn("min-h-0 overflow-y-auto", className)}>
      {trips.map((t) => {
        const note = badge?.(t) ?? null;
        return (
          <li key={`${t.serviceDate}|${t.tripId}`}>
            <button
              type="button"
              data-focus={t.tripId === focusId}
              onClick={() => onPick(t)}
              className="grid w-full grid-cols-[3rem_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="font-mono text-[13px] font-bold tabular-nums">{hmOf(t.depTs)}</span>
              <RouteTile short={t.route} color={t.color} text={t.text} size="sm" />
              <span className="min-w-0" title={t.headsign}>
                <span className="block truncate text-[13px] font-semibold">{t.destinationName} felé</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t.originName} · érk. {hmOf(t.endTs)}
                </span>
              </span>
              <span className="flex flex-col items-end gap-0.5">
                {t.run ? (
                  <span className="rounded bg-primary/12 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary">{displayVehicleId(t.run.vehicleId)}</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground" title="Ezen a meneten a rendszer nem látta a buszt">
                    —
                  </span>
                )}
                {note ? <span className="text-[10px] font-semibold text-primary">{note}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
