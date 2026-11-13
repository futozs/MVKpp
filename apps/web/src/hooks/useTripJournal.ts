import { useEffect, useMemo, useRef, useState } from "react";
import type { TripJournalEntry, TripJournalResponse } from "@/types";
import { api } from "@/services/api";
import { useFallbackPoll, useTopic } from "@/lib/realtime";

const FALLBACK_POLL_MS = 30_000;

const EMPTY = new Map<string, TripJournalEntry>();

/**
 * A nap menetnaplója (melyik jármű vitte, mikor indult/ért be, mennyit késett).
 *
 * A mai napra a szerver WebSocketen azonnal küld minden változást  az
 * „indult” időpont abban a pillanatban megjelenik, ahogy a busz elhagyja a
 * végállomást (a v2-ben ez a menet lezárásáig, akár egy óráig is váratott).
 * Múltbeli napra egyszeri lekérés.
 */
export function useTripJournal(ymd: string | null, pollMs = FALLBACK_POLL_MS): Map<string, TripJournalEntry> {
  const [trips, setTrips] = useState<Map<string, TripJournalEntry>>(EMPTY);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [liveDay, setLiveDay] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A legutóbb kért nap: egy előző napra szóló, későn visszaérő válasz ne írja felül.
  const wanted = useRef(ymd);
  wanted.current = ymd;
  const [retry, setRetry] = useState(0);

  const load = async () => {
    if (!ymd) return;
    const asked = ymd;
    try {
      const res: TripJournalResponse = await api.getTripJournal(asked);
      if (!mounted.current || wanted.current !== asked || res.date !== asked) return;
      setTrips(new Map(Object.entries(res.trips)));
      setLoadedFor(asked);
      // A szerver "live" forrással jelzi, hogy ez a mai nap  erre él a WebSocket-téma.
      if ((res as { source?: string }).source === "live") setLiveDay(asked);
    } catch {
      // Ha még semmi nincs betöltve erre a napra, pár másodperc múlva újra (különben üres maradna).
      if (mounted.current && wanted.current === asked) setTimeout(() => mounted.current && wanted.current === asked && setRetry((n) => n + 1), 5000);
    }
  };

  useEffect(() => {
    setTrips(EMPTY);
    setLoadedFor(null);
    setLiveDay(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ymd]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ymd, retry]);

  useTopic(liveDay ? `runs:${liveDay}` : null, (m) => {
    if (m.date !== ymd) return;
    if (m.full && typeof m.full === "object") {
      setTrips(new Map(Object.entries(m.full as Record<string, TripJournalEntry>)));
      return;
    }
    const upd = m.upd as Record<string, TripJournalEntry> | undefined;
    if (!upd) return;
    setTrips((prev) => {
      const next = new Map(prev);
      for (const [id, e] of Object.entries(upd)) next.set(id, e);
      return next;
    });
  });

  useFallbackPoll(load, pollMs, Boolean(liveDay) && pollMs > 0);

  return useMemo(() => (ymd && loadedFor === ymd ? trips : EMPTY), [ymd, loadedFor, trips]);
}
