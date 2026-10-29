import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchHistoryDays,
  fetchHistoryWindow,
  type HistoryDays,
  type HistoryWindow,
} from "./historyData";

/** Egy 2 órás ablak ~1 MB JSON; ennyi fér el kényelmesen a memóriában. */
const MAX_CACHED_WINDOWS = 8;
/** Hibás kérés után magától újrapróbáljuk, egyre ritkábban (2, 4, 8 … 30 mp). */
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30_000;
/** A még zajló (mai) ablakot ennyi idő után kérjük újra. */
const PARTIAL_TTL_MS = 60_000;
/** Ennyivel a vége után számít lezártnak egy ablak (késve beérkező jelek). */
const COMPLETE_GRACE_SEC = 180;

interface CacheEntry {
  win: HistoryWindow;
  fetchedAt: number;
  complete: boolean;
}

export interface HistoryFramesState {
  /** Minden beérkezett ablaknál nő — a megjelenítés ebből tudja, hogy újrarajzoljon. */
  version: number;
  pending: number[];
  error: string | null;
}

export interface HistoryFrames extends HistoryFramesState {
  get: (start: number) => HistoryWindow | undefined;
  ensure: (starts: number[]) => void;
  retry: () => void;
}

interface Failure {
  at: number;
  count: number;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : "Ismeretlen hiba";

const retryDelay = (count: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, count - 1));

/**
 * Igény szerint betöltött, gyorsítótárazott 2 órás GPS-ablakok. Az `ensure`
 * a kurzor körüli ablakokat kéri; ami már nem kell, annak a kérése megszakad.
 */
export function useHistoryFrames(): HistoryFrames {
  const cacheRef = useRef(new Map<number, CacheEntry>());
  const inflightRef = useRef(new Map<number, AbortController>());
  const failedRef = useRef(new Map<number, Failure>());
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [state, setState] = useState<HistoryFramesState>({
    version: 0,
    pending: [],
    error: null,
  });

  const sync = useCallback((error?: string | null) => {
    setState((prev) => ({
      version: prev.version + 1,
      pending: [...inflightRef.current.keys()],
      error: error === undefined ? prev.error : error,
    }));
  }, []);

  const evict = useCallback((keep: Set<number>) => {
    const cache = cacheRef.current;
    // A Map beszúrási sorrendje a legrégebben használt elemmel kezdődik.
    for (const start of cache.keys()) {
      if (cache.size <= MAX_CACHED_WINDOWS) break;
      if (!keep.has(start)) cache.delete(start);
    }
  }, []);

  const load = useCallback(
    (start: number, wanted: Set<number>) => {
      const ctrl = new AbortController();
      inflightRef.current.set(start, ctrl);

      fetchHistoryWindow(start, ctrl.signal)
        .then((win) => {
          if (inflightRef.current.get(start) !== ctrl) return;
          inflightRef.current.delete(start);
          failedRef.current.delete(start);
          cacheRef.current.delete(start);
          cacheRef.current.set(start, {
            win,
            fetchedAt: Date.now(),
            complete: win.end + COMPLETE_GRACE_SEC < Date.now() / 1000,
          });
          evict(wanted);
          sync(null);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (inflightRef.current.get(start) === ctrl) {
            inflightRef.current.delete(start);
          }
          const count = (failedRef.current.get(start)?.count ?? 0) + 1;
          failedRef.current.set(start, { at: Date.now(), count });
          sync(`Nem sikerült betölteni az előzményt. ${errorText(err)}`);
          // A version-léptetés újrafuttatja a hívó ensure-ét, így az ablak
          // akkor is újra jön, ha közben semmi sem mozdult (pl. szünetel).
          const timer = setTimeout(() => {
            timersRef.current.delete(timer);
            sync();
          }, retryDelay(count) + 50);
          timersRef.current.add(timer);
        });
    },
    [evict, sync],
  );

  const ensure = useCallback(
    (starts: number[]) => {
      const wanted = new Set(starts);
      const inflight = inflightRef.current;
      const cache = cacheRef.current;
      let changed = false;

      for (const [start, ctrl] of inflight) {
        if (wanted.has(start)) continue;
        ctrl.abort();
        inflight.delete(start);
        changed = true;
      }

      const now = Date.now();
      for (const start of wanted) {
        const entry = cache.get(start);
        if (entry) {
          cache.delete(start);
          cache.set(start, entry);
          if (entry.complete || now - entry.fetchedAt < PARTIAL_TTL_MS) continue;
        }
        if (inflight.has(start)) continue;
        const failed = failedRef.current.get(start);
        if (failed && now - failed.at < retryDelay(failed.count)) continue;
        load(start, wanted);
        changed = true;
      }

      if (changed) sync();
    },
    [load, sync],
  );

  const retry = useCallback(() => {
    failedRef.current.clear();
    sync(null);
  }, [sync]);

  const get = useCallback(
    (start: number) => cacheRef.current.get(start)?.win,
    [],
  );

  useEffect(() => {
    const inflight = inflightRef.current;
    const timers = timersRef.current;
    return () => {
      inflight.forEach((ctrl) => ctrl.abort());
      inflight.clear();
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return useMemo(
    () => ({ ...state, get, ensure, retry }),
    [state, get, ensure, retry],
  );
}

/** A napok listája ritkán változik (naponta egyszer), elég ennyi ideig tartani. */
const DAYS_TTL_MS = 10 * 60_000;
let daysCache: { at: number; request: Promise<HistoryDays> } | null = null;

export interface HistoryDaysState {
  days: HistoryDays | null;
  error: string | null;
  reload: () => void;
}

/** A rögzített GPS-napok köre. Egy munkameneten belül egyszer kérjük le. */
export function useHistoryDays(): HistoryDaysState {
  const [days, setDays] = useState<HistoryDays | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!daysCache || Date.now() - daysCache.at > DAYS_TTL_MS) {
      daysCache = { at: Date.now(), request: fetchHistoryDays() };
    }
    const { request } = daysCache;
    request
      .then((res) => {
        if (alive) {
          setDays(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        daysCache = null;
        if (alive) setError(`Az előzmények most nem érhetők el. ${errorText(err)}`);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { days, error, reload };
}
