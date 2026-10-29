import { useEffect, useRef, useState } from "react";
import type { TripPathResponse } from "@/types";
import { api } from "@/services/api";

const DEFAULT_POLL_MS = 4000;

export interface TripPathState {
  data: TripPathResponse | null;
  lost: boolean;
}

export function useTripPath(
  tripId: string | null,
  vehicleId?: string | null,
  pollMs = DEFAULT_POLL_MS,
): TripPathState {
  const [data, setData] = useState<TripPathResponse | null>(null);
  const [lost, setLost] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!tripId) {
      setData(null);
      setLost(false);
      return;
    }

    let alive = true;
    // Másik menet: a régi nyomvonal ne maradjon kint, amíg az új betölt.
    setData(null);
    setLost(false);
    const load = async () => {
      try {
        const res = await api.getTripPath(tripId, vehicleId ?? undefined);
        if (!alive || !mounted.current) return;
        setData(res);
        setLost(!res.vehicle);
      } catch {
        if (alive && mounted.current) setLost(true);
      }
    };

    load();
    const timer = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tripId, vehicleId, pollMs]);

  return { data, lost };
}
