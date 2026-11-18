import { useEffect, useRef, useState } from "react";
import type { BoardSnapshot } from "@mvk/core";
import { API_BASE } from "@/lib/apiBase";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import { fetchCached, roundAt, ttlFor } from "./fleetCache";

const POLL_MS = 15_000;
/** húzás közben ennyi szünet után kérjük le az új pillanatot (ms); a gyorsítótárban lévő azonnal jön */
const SCRUB_DEBOUNCE_MS = 150;

/**
 * A flotta-rangsor: `at` nélkül élőben (amíg a lap látható), `at`-tal az adott
 * múltbeli pillanatban (30 mp-re kerekítve). Hiba után a legutóbbi adat marad kint.
 */
export function useFleetBoard(at: number | null) {
  const [data, setData] = useState<BoardSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  useVisiblePoll(
    () => {
      if (at != null || busy.current) return;
      busy.current = true;
      fetch(`${API_BASE}/engine/fleet/live`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<BoardSnapshot>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          setData(d);
          setFailed(false);
        })
        .catch(() => setFailed(true))
        .finally(() => {
          busy.current = false;
        });
    },
    POLL_MS,
    [at == null],
  );

  const t = at == null ? null : roundAt(at);
  useEffect(() => {
    if (t == null) return;
    let alive = true;
    const timer = setTimeout(() => {
      setLoading(true);
      fetchCached<BoardSnapshot>(`/engine/fleet/at?t=${t}`, ttlFor(t))
        .then((d) => {
          if (!alive) return;
          setData(d);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true))
        .finally(() => alive && setLoading(false));
    }, SCRUB_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [t]);

  return { data, failed, loading };
}
