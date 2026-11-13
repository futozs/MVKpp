import { useEffect, useRef, useState } from "react";
import { Bus } from "lucide-react";
import type { TimetableTrip, TripProgressResponse } from "@/types";
import { api } from "@/services/api";
import {
  DelayBar,
  delaySentence,
  delayState,
  delayTone,
} from "@/components/transit/DelayBar";
import { cn } from "@/lib/utils";
import { displayVehicleId } from "@/lib/modes";

const POLL_MS = 5000;
const ROW_HEIGHT = 34;

type TripProgressRailProps = {
  trip: TimetableTrip;
  vehicleId?: string | null;
  stopNames: string[];
};

export function TripProgressRail({
  trip,
  vehicleId,
  stopNames,
}: TripProgressRailProps) {
  const [data, setData] = useState<TripProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        const res = await api.getTripProgress(
          trip.tripId,
          vehicleId ?? undefined,
        );
        if (!mounted.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (mounted.current) setError((err as Error).message);
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [trip.tripId, vehicleId]);

  if (error) {
    return (
      <p role="alert" className="px-4 py-3 text-xs text-destructive">
        {error}
      </p>
    );
  }

  if (!data) {
    return (
      <p className="px-4 py-6 text-center font-mono text-xs text-muted-foreground">
        Haladás lekérése…
      </p>
    );
  }

  const stops = data.stops.length
    ? data.stops.map((s, i) => ({
        id: s.id,
        name: s.name,
        time: trip.times[i] ?? null,
      }))
    : stopNames.map((name, i) => ({
        id: `${i}`,
        name,
        time: trip.times[i] ?? null,
      }));

  const segment = data.segmentIndex;
  const fraction = data.segmentFraction ?? 0;

  const busTop =
    segment == null ? null : (segment + fraction) * ROW_HEIGHT + ROW_HEIGHT / 2;

  return (
    <div className="px-4 py-3">
      {data.live && data.vehicle ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          <span className="rounded bg-primary/12 px-1.5 py-0.5 font-mono text-xs font-bold tabular-nums text-primary">
            {displayVehicleId(data.vehicle.id)}
          </span>
          <span className="text-muted-foreground">
            {data.nextStop ? `következő: ${data.nextStop.name}` : "útközben"}
            {data.vehicle.speed != null
              ? ` · ${Math.round(data.vehicle.speed * 3.6)} km/h`
              : ""}
          </span>
          {delayState(data.scheduleDeviationSec) !== "unknown" ? (
            <span className="flex items-center gap-1.5">
              <DelayBar
                delaySec={data.scheduleDeviationSec}
                showLabel={false}
              />
              <span
                className={cn(
                  "font-semibold",
                  delayTone(data.scheduleDeviationSec),
                )}
              >
                {delaySentence(data.scheduleDeviationSec)}
              </span>
            </span>
          ) : null}
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">
          Erre a menetre még nem jelentkezett be jármű.
        </p>
      )}

      <div className="relative isolate">
        <span
          aria-hidden
          className="absolute left-[70px] top-0 w-0.5 rounded-full bg-border"
          style={{ height: stops.length * ROW_HEIGHT }}
        />

        {busTop != null ? (
          <span
            aria-hidden
            className="absolute left-[70px] top-0 w-0.5 rounded-full bg-primary"
            style={{ height: busTop }}
          />
        ) : null}

        {busTop != null && data.live ? (
          <span
            className="absolute z-10 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-md"
            style={{ left: 71, top: busTop }}
            title={
              data.nextStop
                ? `Következő megálló: ${data.nextStop.name}`
                : "A jármű útközben"
            }
          >
            <Bus className="h-4 w-4" />
          </span>
        ) : null}

        <ol>
          {stops.map((stop, i) => {
            const passed = segment != null && i <= segment;
            const isNext = segment != null && i === segment + 1;

            return (
              <li
                key={`${stop.id}-${i}`}
                className="relative flex items-center gap-3"
                style={{ height: ROW_HEIGHT }}
              >
                <span
                  className={cn(
                    "w-[52px] shrink-0 text-right font-mono text-xs tabular-nums",
                    passed
                      ? "text-muted-foreground/60"
                      : "text-muted-foreground",
                  )}
                >
                  {stop.time ?? "—"}
                </span>

                <span
                  aria-hidden
                  className={cn(
                    "absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2",
                    passed
                      ? "border-primary bg-primary"
                      : isNext
                        ? "border-primary bg-background"
                        : "border-border bg-background",
                  )}
                  style={{ left: 71 }}
                />

                <span
                  className={cn(
                    "ml-[26px] min-w-0 flex-1 truncate text-xs",
                    isNext
                      ? "font-semibold text-foreground"
                      : passed
                        ? "text-muted-foreground/60"
                        : "text-muted-foreground",
                  )}
                >
                  {stop.name}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
