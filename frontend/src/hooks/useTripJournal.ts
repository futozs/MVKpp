import { useEffect, useMemo, useRef, useState } from "react";
import type { TripJournalEntry, TripJournalResponse } from "@/types";
import { api } from "@/services/api";

/** A napló lassan gyűlik; a menetrendnek percenkénti frissítés bőven elég. */
const DEFAULT_POLL_MS = 60000;

const EMPTY = new Map<string, TripJournalEntry>();

/**
 * Melyik jármű teljesítette az adott nap meneteit. A gateway 0–24-ben naplóz,
 * ezért a MÁR LEFUTOTT menetekhez is van válasz — az élő járműlista csak az
 * éppen közlekedőket ismeri.
 */
export function useTripJournal(
  /** YYYYMMDD; `null` esetén nem kérdez le semmit. */
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
        // A korábbi napló megmarad: egy sikertelen lekérdezés miatt ne
        // tűnjenek el a már megjelenített járműazonosítók.
      }
    };

    load();
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [ymd, pollMs]);

  return useMemo(() => {
    if (!ymd || !data || data.date !== ymd) return EMPTY;
    return new Map(Object.entries(data.trips));
  }, [ymd, data]);
}
