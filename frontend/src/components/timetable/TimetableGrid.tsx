import { useEffect, useMemo, useRef } from "react";
import { Clock } from "lucide-react";
import type { LiveVehicle, TimetableTrip, TripJournalEntry } from "@/types";
import {
  showsJournalVehicle,
  tripRunLabel,
  tripRunState,
  type DayRelation,
} from "@/lib/tripStatus";
import { cn } from "@/lib/utils";

export interface HourRow {
  hour: number;
  trips: TimetableTrip[];
}

export function groupByHour(trips: TimetableTrip[]): HourRow[] {
  const map = new Map<number, TimetableTrip[]>();
  for (const t of trips) {
    const h = Math.floor(t.departureSec / 3600);
    let arr = map.get(h);
    if (!arr) map.set(h, (arr = []));
    arr.push(t);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, list]) => ({
      hour,
      trips: list.sort((a, b) => a.departureSec - b.departureSec),
    }));
}

interface TimetableGridProps {
  trips: TimetableTrip[];
  vehicleByTrip: Map<string, LiveVehicle>;
  /** A mai napra kihúzott menetek — ezek az indulások nem lesznek megtartva. */
  cancelledTripIds: Set<string>;
  /** A gateway naplója: melyik jármű teljesítette az adott menetet. */
  journal: Map<string, TripJournalEntry>;
  selectedTripId: string | null;
  onSelectTrip: (trip: TimetableTrip) => void;
  nowSec: number;
  /** A nézett nap viszonya a maihoz. */
  day: DayRelation;
  /** A viszonylat szokásos (leggyakoribb) célállomása — a jelmagyarázathoz. */
  directionHeadsign: string;
}

export function TimetableGrid({
  trips,
  vehicleByTrip,
  cancelledTripIds,
  journal,
  selectedTripId,
  onSelectTrip,
  nowSec,
  day,
  directionHeadsign,
}: TimetableGridProps) {
  const rows = useMemo(() => groupByHour(trips), [trips]);

  // A „következő” jelölés a legközelebbi MEGTARTOTT indulásra kerül: egy kihúzott
  // menet kiemelése azt sugallná, hogy arra még érdemes várni.
  const nextTripId = useMemo(() => {
    if (day !== "today") return null;
    let best: TimetableTrip | null = null;
    for (const t of trips) {
      if (t.departureSec < nowSec) continue;
      if (cancelledTripIds.has(t.tripId)) continue;
      if (!best || t.departureSec < best.departureSec) best = t;
    }
    return best?.tripId ?? null;
  }, [trips, nowSec, cancelledTripIds, day]);

  // Az „aktuális óra" és a halványítás csak a mai napon jelent bármit.
  const currentHour = day === "today" ? Math.floor(nowSec / 3600) : -1;

  // Belépéskor arra a menetre görgetünk, amelyik épp fut (van hozzá élő
  // jármű), ha nincs ilyen, a legközelebbi induló menetre.
  const activeTripId = useMemo(() => {
    if (day !== "today") return null;
    let best: TimetableTrip | null = null;
    for (const t of trips) {
      if (cancelledTripIds.has(t.tripId)) continue;
      if (!vehicleByTrip.has(t.tripId)) continue;
      if (!best || t.departureSec > best.departureSec) best = t;
    }
    return best?.tripId ?? nextTripId;
  }, [trips, vehicleByTrip, cancelledTripIds, day, nextTripId]);

  const tripButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrolledForTripsRef = useRef<TimetableTrip[] | null>(null);

  useEffect(() => {
    if (scrolledForTripsRef.current !== trips) {
      scrolledForTripsRef.current = trips;
      if (activeTripId) {
        const el = tripButtonRefs.current.get(activeTripId);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }, [trips, activeTripId]);

  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row, rowIndex) => {
        const isCurrentHour = row.hour === currentHour;
        return (
          <li
            key={row.hour}
            className={cn(
              "flex items-stretch gap-3 px-3 py-2 sm:px-4",
              rowIndex % 2 === 1 && "bg-muted/25",
              isCurrentHour && "bg-primary/[0.07]",
            )}
          >
            {}
            <span
              className={cn(
                "flex w-[68px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5",
                "font-mono text-base font-bold tabular-nums shadow-sm sm:w-[76px] sm:text-lg",
                isCurrentHour
                  ? "bg-primary text-primary-foreground"
                  : "bg-primary/85 text-primary-foreground",
              )}
            >
              <Clock aria-hidden className="h-3.5 w-3.5 opacity-80" />
              {String(row.hour % 24).padStart(2, "0")}
            </span>

            {}
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {row.trips.map((trip) => {
                const isCancelled = cancelledTripIds.has(trip.tripId);
                const vehicle = isCancelled
                  ? null
                  : (vehicleByTrip.get(trip.tripId) ?? null);
                // Az élő GPS-jelzés napfüggetlenül a tripId alapján érkezik, ezért
                // csak a mai napon jelentheti azt, hogy EZ a menet fut éppen.
                const isLive = day === "today" && vehicle !== null;
                const isNext = trip.tripId === nextTripId;
                const isSelected = trip.tripId === selectedTripId;
                const isPast =
                  day === "today" && trip.departureSec < nowSec && !isLive;
                const minute = Math.floor((trip.departureSec % 3600) / 60);

                return (
                  <button
                    key={trip.tripId}
                    ref={(el) => {
                      if (el) tripButtonRefs.current.set(trip.tripId, el);
                      else tripButtonRefs.current.delete(trip.tripId);
                    }}
                    type="button"
                    onClick={() => onSelectTrip(trip)}
                    aria-pressed={isSelected}
                    title={buildTitle({
                      trip,
                      isCancelled,
                      liveVehicleId: vehicle?.id ?? null,
                      journal,
                      nowSec,
                      day,
                      directionHeadsign,
                    })}
                    className={cn(
                      "relative flex h-9 min-w-[46px] items-center justify-center rounded-lg border px-2.5",
                      "font-mono text-sm font-semibold tabular-nums transition-all duration-fast",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      isCancelled
                        ? "border-destructive/60 bg-destructive/12 text-destructive line-through decoration-2"
                        : isLive
                          ? "border-primary bg-primary text-primary-foreground"
                          : isSelected
                            ? "border-primary bg-primary/15 text-foreground"
                            : isNext
                              ? "border-primary bg-card text-foreground shadow-sm"
                              : isPast
                                ? "border-transparent bg-muted/60 text-muted-foreground"
                                : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent",
                      isCancelled && isSelected && "ring-1 ring-destructive",
                    )}
                  >
                    {String(minute).padStart(2, "0")}

                    {}
                    {isCancelled ? (
                      <span className="sr-only"> — törölve</span>
                    ) : null}

                    {}
                    {trip.deviates && !isLive && !isCancelled ? (
                      <span
                        aria-hidden
                        className="absolute bottom-1 right-1 h-1 w-1 rounded-full bg-muted-foreground"
                      />
                    ) : null}

                    {}
                    {trip.headsignDiffers && !isCancelled ? (
                      <span
                        aria-hidden
                        className={cn(
                          "absolute right-1 top-1 h-1.5 w-1.5 rounded-full",
                          isLive ? "bg-primary-foreground" : "bg-early",
                        )}
                      />
                    ) : null}
                  </button>
                );
              })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A gomb tooltipje: cél, érkezés, és hogy hol tart most ez a menet. */
function buildTitle({
  trip,
  isCancelled,
  liveVehicleId,
  journal,
  nowSec,
  day,
  directionHeadsign,
}: {
  trip: TimetableTrip;
  isCancelled: boolean;
  liveVehicleId: string | null;
  journal: Map<string, TripJournalEntry>;
  nowSec: number;
  day: DayRelation;
  directionHeadsign: string;
}): string {
  if (isCancelled) {
    return `${trip.destinationName} — TÖRÖLVE, ez a menet nem indul el`;
  }
  const state = tripRunState({
    cancelled: false,
    hasLiveVehicle: liveVehicleId !== null,
    departureSec: trip.departureSec,
    arrivalSec: trip.arrivalSec,
    nowSec,
    day,
  });
  const vehicleId =
    liveVehicleId ??
    (showsJournalVehicle(state)
      ? (journal.get(trip.tripId)?.vehicleId ?? null)
      : null);
  return [
    `${trip.destinationName} — érkezés ${trip.arrival}`,
    trip.headsignDiffers
      ? `eltér a szokásos iránytól (${directionHeadsign} helyett ${trip.headsign} felé)`
      : "",
    tripRunLabel(state, vehicleId),
  ]
    .filter(Boolean)
    .join(" · ");
}
