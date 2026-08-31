import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { ArrivalItem, Stop } from "@/types";
import { api } from "@/services/api";
import { Countdown } from "@/components/transit/Countdown";
import { RouteTile } from "@/components/transit/RouteTile";

const POLL_MS = 5000;

type NextAtStop = { stop: Stop; arrival: ArrivalItem };

/**
 * Két vagy több figyelt megálló esetén a kártyák közt kellene válogatni,
 * hogy melyikre kell most sietni. Ez a sáv ehelyett egyetlen lépésben
 * megmutatja az összes figyelt megálló közül a leghamarabb induló/érkező
 * járatot — egyetlen közös /live/multi-arrivals hívással, nem soronként.
 */
export function NextDepartureBanner({
  stops,
  onFocusMap,
}: {
  stops: Stop[];
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void;
}) {
  const [next, setNext] = useState<NextAtStop | null>(null);
  const mounted = useRef(true);
  const stopIds = stops.map((s) => s.id).join(",");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (stops.length < 2) {
      setNext(null);
      return;
    }
    const stopById = new Map(stops.map((s) => [s.id, s]));

    const load = async () => {
      try {
        const res = await api.getMultiArrivals(stops.map((s) => s.id), 1);
        if (!mounted.current) return;
        let best: NextAtStop | null = null;
        for (const r of res.results) {
          const stop = stopById.get(r.stop.id);
          const arrival = r.arrivals[0];
          if (!stop || !arrival || arrival.etaMin < 0) continue;
          if (!best || arrival.etaMin < best.arrival.etaMin) {
            best = { stop, arrival };
          }
        }
        setNext(best);
      } catch {
        // A sáv csak kényelmi összesítő — hiba esetén egyszerűen nem frissül.
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopIds]);

  if (!next) return null;

  return (
    <button
      type="button"
      onClick={() =>
        onFocusMap(next.stop, next.arrival.tripId, next.arrival.vehicle?.id)
      }
      className="flex w-full items-center gap-3 rounded-2xl border border-primary/30 bg-primary/8 px-4 py-3 text-left transition-colors hover:bg-primary/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <RouteTile
        short={next.arrival.route}
        color={next.arrival.color}
        text={next.arrival.text}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          Ezt kell most elkapni
        </p>
        <p className="truncate text-sm font-semibold">
          {next.arrival.headsign}
          <span className="font-normal text-muted-foreground">
            {" "}
            — {next.stop.name}
          </span>
        </p>
      </div>
      <Countdown etaMin={next.arrival.etaMin} />
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
