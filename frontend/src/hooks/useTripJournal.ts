import { useEffect, useMemo, useRef, useState } from "react";
import type { TripJournalEntry, TripJournalResponse } from "@/types";
import { api } from "@/services/api";

const DEFAULT_POLL_MS = 60000;

const EMPTY = new Map<string, TripJournalEntry>();

export function useTripJournal(
  ymd: string | null,
  pollMs = DEFAULT_POLL_MS,
): Map<string, TripJournalEntry> {
  const [data, setData] = useState<TripJournalResponse | null>(null);
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
      return;
    }

    const load = async () => {
      try {
        const res = await api.getTripJournal(ymd);
        if (mounted.current) setData(res);
      } catch {
      }
    };

    load();
    if (pollMs <= 0) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [ymd, pollMs]);

  return useMemo(() => {
    if (!ymd || !data || data.date !== ymd) return EMPTY;
    return new Map(Object.entries(data.trips));
  }, [ymd, data]);
}
