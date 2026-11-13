import { Navigation, Radio } from "lucide-react";
import type { ArrivalVehicle } from "@/types";
import { displayVehicleId } from "@/lib/modes";
import { cn } from "@/lib/utils";

export function VehicleTrack({
  vehicle,
  label,
  progressDesc,
  onTrack,
  className,
}: {
  vehicle: ArrivalVehicle | null;
  /** a jármű felirata (vonatnál a vonatszám); alapból a rendszám (a Volán-azonosító előtag nélkül) */
  label?: string | null;
  progressDesc?: string | null;
  onTrack?: () => void;
  className?: string;
}) {
  if (!vehicle && !progressDesc) return null;
  const vehicleText = label ?? (vehicle ? displayVehicleId(vehicle.id) : "");

  const speedKmh =
    vehicle?.speed != null ? Math.round(vehicle.speed * 3.6) : null;
  const moving = speedKmh != null && speedKmh > 2;
  // Az egész sáv (hol tart a busz) a követésre visz, nem csak a kis ikon.
  const trackable = Boolean(onTrack && vehicle);

  return (
    <div
      role={trackable ? "button" : undefined}
      tabIndex={trackable ? 0 : undefined}
      aria-label={trackable ? `${vehicleText} követése a térképen` : undefined}
      onClick={trackable ? onTrack : undefined}
      onKeyDown={
        trackable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onTrack?.();
              }
            }
          : undefined
      }
      className={cn(
        "rounded-lg border border-primary/25 bg-primary/[0.07] p-2 shadow-xs sm:p-3",
        trackable &&
          "cursor-pointer transition-[background-color,transform] duration-fast hover:bg-primary/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]",
        className,
      )}
    >
      <div className="flex items-center gap-2 sm:hidden">
        <Radio aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
        {vehicle ? (
          <span className="font-mono text-base font-bold leading-none tabular-nums">
            {vehicleText}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">nincs jármű</span>
        )}
        {speedKmh != null ? (
          <span
            className={cn(
              "shrink-0 font-mono text-xs font-semibold tabular-nums",
              moving ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {speedKmh} km/h
          </span>
        ) : null}
        {progressDesc ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {progressDesc}
          </span>
        ) : null}
        {trackable ? (
          <span aria-hidden className="shrink-0 rounded-md bg-primary/15 p-1.5 text-primary">
            <Navigation className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>

      <div className="hidden sm:block">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Radio aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Jármű
              </p>
              {vehicle ? (
                <p className="font-mono text-xl font-bold leading-tight tabular-nums text-foreground">
                  {vehicleText}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nincs hozzárendelve
                </p>
              )}
            </div>
          </div>

          {speedKmh != null ? (
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Sebesség
              </p>
              <p
                className={cn(
                  "font-mono text-xl font-bold leading-tight tabular-nums",
                  moving ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {speedKmh}
                <span className="ml-1 font-sans text-xs font-semibold text-muted-foreground">
                  km/h
                </span>
              </p>
            </div>
          ) : null}
        </div>

        {progressDesc ? (
          <p className="mt-2.5 flex items-start gap-2 border-t border-primary/15 pt-2.5 text-sm leading-snug text-foreground">
            <Navigation
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
            />
            <span className="min-w-0">{progressDesc}</span>
          </p>
        ) : null}

        {trackable ? (
          <span aria-hidden className="mt-2.5 block w-full rounded-md bg-primary/12 py-1.5 text-center text-xs font-semibold text-primary">
            Követés a térképen
          </span>
        ) : null}
      </div>
    </div>
  );
}
