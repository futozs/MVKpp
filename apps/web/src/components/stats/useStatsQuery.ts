import { useCallback, useEffect, useState } from "react";
import { StatsUnavailableError } from "@/services/statsApi";

export type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  reload: () => void;
};

export function useStatsQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  enabled = true,
): QueryState<T> {
  // Az adat a lekérdezés kulcsához kötött: másik jármű / megálló / időszak
  // választásakor a régi számok nem maradnak kint az új cím alatt (amíg az új
  // betölt, a töltésjelző látszik); ugyanarra a kulcsra frissítéskor viszont igen.
  const key = JSON.stringify(deps);
  const [stored, setStored] = useState<{ key: string; data: T } | null>(null);
  const data = stored?.key === key ? stored.data : null;
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => {
        if (!alive) return;
        setStored({ key, data: d });
        setUnavailable(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof StatsUnavailableError) {
          setUnavailable(true);
          setError(null);
        } else {
          setError((e as Error).message);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  return { data, loading, error, unavailable, reload };
}
