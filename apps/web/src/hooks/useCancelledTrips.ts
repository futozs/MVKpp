import { useEffect, useMemo, useRef, useState } from "react";
import type { CancelledTrip, CancelledTripsResponse } from "@/types";
import { api } from "@/services/api";

const DEFAULT_POLL_MS = 30000;

export interface CancelledTripsState {
  ids: Set<string>;
  trips: CancelledTrip[];
  date: string | null;
  error: string | null;
}

const EMPTY: CancelledTripsState = {
  ids: new Set(),
  trips: [],
  date: null,
  error: null,
};

export function useCancelledTrips(
  ymd: string | null,
  isToday: boolean,
  pollMs = DEFAULT_POLL_MS,
): CancelledTripsState {
  const [data, setData] = useState<CancelledTripsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ymd) {
      setData(null);
      setError(null);
      return;
    }

    // Gyors napváltásnál egy előző napra szóló, későn visszaérő válasz ne írja felül a mostanit.
    let alive = true;
    const load = async () => {
      try {
        const res = await api.getCancelledTrips(isToday ? undefined : ymd);
        if (!alive || !mounted.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (alive && mounted.current) setError((err as Error).message);
      }
    };

    load();
    const timer = isToday ? setInterval(load, pollMs) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [ymd, isToday, pollMs]);

  return useMemo(() => {
    // Csak a kért nap adata számít (a válasz `date` mezője YYYYMMDD vagy ISO lehet).
    const matches = data && data.date.replace(/-/g, "") === ymd?.replace(/-/g, "");
    if (!ymd || !data || !matches) return error ? { ...EMPTY, error } : EMPTY;
    return {
      ids: new Set(data.tripIds),
      trips: data.trips,
      date: data.date,
      error,
    };
  }, [ymd, data, error]);
}
