import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/apiBase";

export type StopActual = { arr: number; dep: number | null; delay: number; estimated: boolean };

/**
 * Egy menet tényleges megálló-eseményei (mikor ért oda a busz, mennyit
 * késett). A `refreshKey` változásakor (pl. új esemény a WebSocket-naplóban)
 * újratölt, így a futó menetnél megállóról megállóra frissül.
 */
const EMPTY = new Map<string, StopActual>();

export function useTripActuals(dateYmd: string, tripId: string, enabled: boolean, refreshKey: unknown) {
  // A tény-időpontok a menethez (és naphoz) kötöttek: másik menet kiválasztásakor
  // az előző menet „mért érkezései” nem látszanak az új megállói mellett.
  const key = `${dateYmd}|${tripId}`;
  const [state, setState] = useState<{ key: string; byStop: Map<string, StopActual> } | null>(null);
  const byStop = enabled && state?.key === key ? state.byStop : EMPTY;
  const setByStop = (m: Map<string, StopActual>) => setState({ key, byStop: m });
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    fetch(`${API_BASE}/engine/trip?date=${dateYmd}&trip=${encodeURIComponent(tripId)}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { events?: { stop_id: string; arr: number; dep: number | null; delay_s: number; src: number }[] } | null) => {
        const m = new Map<string, StopActual>();
        for (const e of d?.events ?? []) if (!m.has(e.stop_id)) m.set(e.stop_id, { arr: e.arr, dep: e.dep, delay: e.delay_s, estimated: e.src === 3 });
        setByStop(m);
      })
      .catch(() => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateYmd, tripId, enabled, refreshKey]);
  return byStop;
}
