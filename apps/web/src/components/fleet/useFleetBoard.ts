import { useEffect, useRef, useState } from "react";
import type { BoardSnapshot } from "@mvk/core";
import { API_BASE } from "@/lib/apiBase";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";

const POLL_MS = 15_000;
/** húzás közben ennyi szünet után kérjük le az új pillanatot (ms) */
const SCRUB_DEBOUNCE_MS = 220;

/**
 * A flotta-rangsor: `at` nélkül élőben (amíg a lap látható), `at`-tal az adott
 * múltbeli pillanatban. Hiba után a legutóbbi adat marad kint.
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

  useEffect(() => {
    if (at == null) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`${API_BASE}/engine/fleet/at?t=${Math.round(at)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<BoardSnapshot>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          setData(d);
          setFailed(false);
        })
        .catch((e: unknown) => {
          if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
        })
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false);
        });
    }, SCRUB_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [at]);

  return { data, failed, loading };
}
