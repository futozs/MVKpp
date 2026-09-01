import { useEffect, useMemo, useRef, useState } from "react";
import type { CancelledTrip, CancelledTripsResponse } from "@/types";
import { api } from "@/services/api";

/**
 * A kihúzott menetek listája percekben mérhető ütemben változik (a backend is
 * fél percig gyorsítótárazza), ezért ritkább lekérdezés bőven elég.
 */
const DEFAULT_POLL_MS = 30000;

export interface CancelledTripsState {
  /** Gyors tagsági kérdéshez: „ez a tripId törölve van-e?” */
  ids: Set<string>;
  trips: CancelledTrip[];
  /** Melyik napra vonatkozik a lista (YYYYMMDD) — az upstream csak a mait adja. */
  date: string | null;
  error: string | null;
}

const EMPTY: CancelledTripsState = {
  ids: new Set(),
  trips: [],
  date: null,
  error: null,
};

/**
 * Egy nap kihúzott menetei. `ymd=null` esetén nem kérdez le semmit. Mai napra
 * (`isToday=true`) rendszeresen újralekérdez, mert a lista élőben változik;
 * múltbeli napra egyszeri lekérdezés elég, mert az archívum onnantól fix.
 */
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

    const load = async () => {
      try {
        const res = await api.getCancelledTrips(isToday ? undefined : ymd);
        if (!mounted.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        // A korábbi lista megmarad: egy megbicsakló lekérdezés miatt ne
        // tűnjenek el a jelölések a menetrendből.
        if (mounted.current) setError((err as Error).message);
      }
    };

    load();
    if (!isToday) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [ymd, isToday, pollMs]);

  return useMemo(() => {
    if (!ymd || !data) return error ? { ...EMPTY, error } : EMPTY;
    return {
      ids: new Set(data.tripIds),
      trips: data.trips,
      date: data.date,
      error,
    };
  }, [ymd, data, error]);
}
