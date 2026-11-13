import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { serverNow, useFallbackPoll, useTopic } from "@/lib/realtime";
import type { StopArrivalsResponse } from "@/types";
import { useBoardKey } from "@/lib/modes";

const LIMIT = 10;
const POLL_MS = 10_000;

/**
 * Egy megálló induló járatai: a szerver küldi (WebSocket), kapcsolat nélkül pollozunk.
 * A bekapcsolt módok szerint (Volán, vonat is, ha be vannak kapcsolva).
 */
export function useStopBoard(stopId: string) {
  const modesKey = useBoardKey();
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((res: StopArrivalsResponse) => {
    if (!alive.current) return;
    setData(res);
    setError(null);
  }, []);

  const load = useCallback(() => {
    api
      .getArrivals(stopId, LIMIT, modesKey)
      .then(apply)
      .catch((e: Error) => alive.current && setError(e.message));
  }, [stopId, modesKey, apply]);

  useEffect(load, [load]);
  useTopic(`stop:${stopId}@${modesKey}`, (m) => apply(m.data as StopArrivalsResponse));
  useFallbackPoll(load, POLL_MS);

  return { data, error };
}

/** Az aktuális idő, másodpercenként  a nagy órához és a visszaszámlálásokhoz. */
export function useClock(): Date {
  // a szerver órája: egy rossz órájú kijelző-gépen se térjen el az indulásoktól
  const [now, setNow] = useState(() => new Date(serverNow() * 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(serverNow() * 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** A kijelző ne aludjon el (Screen Wake Lock), és a visszatéréskor újra kérjük. */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = () => {
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (cancelled) void l.release();
          else lock = l;
        })
        .catch(() => {
          /* a böngésző megtagadta (pl. energiatakarékos mód)  a kijelző ettől még működik */
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [enabled]);
}
