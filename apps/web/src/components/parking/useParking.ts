import { useCallback, useEffect, useRef, useState } from "react";
import { useFallbackPoll, useTopic } from "@/lib/realtime";
import { fetchParking, type ParkingSnapshot } from "@/services/parkingApi";

const POLL_MS = 15_000;
const TICK_MS = 15_000;

export interface ParkingState {
  data: ParkingSnapshot | null;
  error: string | null;
  /**
   * A szerver órája most (unix mp). A pillanatkép `at`-jából és a megérkezése
   * óta eltelt időből — így az eltelt idők akkor is helyesek, ha a böngésző
   * órája elcsúszott (vagy a szerver egy visszajátszott napon fut).
   */
  now: number;
}

/** A parkoló: első betöltés HTTP-n, utána a szerver küldi (WebSocket), tartalékként pollozás. */
export function useParking(): ParkingState {
  const [data, setData] = useState<ParkingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const received = useRef<{ at: number; local: number } | null>(null);
  const [, setTick] = useState(0);

  const apply = useCallback((snap: ParkingSnapshot | null) => {
    if (!snap) return;
    received.current = { at: snap.at, local: Date.now() / 1000 };
    setData(snap);
    setError(null);
  }, []);

  const load = useCallback(() => {
    const ctrl = new AbortController();
    fetchParking(ctrl.signal)
      .then(apply)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [apply]);

  useEffect(() => load(), [load]);
  useTopic("parking", (m) => apply(m.data as ParkingSnapshot | null));
  useFallbackPoll(load, POLL_MS);

  // Az „X perce” feliratok a két üzenet között is haladjanak.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const r = received.current;
  const now = r ? Math.round(r.at + (Date.now() / 1000 - r.local)) : Math.round(Date.now() / 1000);
  return { data, error, now };
}
