import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NewsFeed } from "@mvk/core";
import { API_BASE } from "@/lib/apiBase";
import { usePreference } from "@/hooks/usePreference";

/** a háttérben ennyi időnként nézünk rá (a worker 10 percig tartja a listát) */
const REFRESH_MS = 10 * 60_000;
/** megnyitáskor ennél régebbi listát újrakérünk */
const REOPEN_STALE_MS = 2 * 60_000;
/** a látott hírek azonosítói (a felhős szinkron is viszi) */
const SEEN_KEY = "mvk_news_seen";
const SEEN_MAX = 80;

export function useNews() {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedAt = useRef(0);
  const [seen, setSeen] = usePreference<number[]>(SEEN_KEY, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/engine/news`);
      if (!r.ok) throw new Error(r.status === 503 ? "Az MVK hírei most nem érhetők el." : `Nem sikerült betölteni (${r.status}).`);
      setFeed((await r.json()) as NewsFeed);
      setError(null);
      loadedAt.current = Date.now();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Nem sikerült betölteni.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const seenSet = useMemo(() => new Set(seen), [seen]);
  const unseen = useMemo(() => (feed?.items ?? []).filter((it) => !seenSet.has(it.id)).map((it) => it.id), [feed, seenSet]);

  /** A lista megnyitásakor: ami most új, azt visszaadja, és mindet látottnak jelöli. */
  const markAllSeen = useCallback((): Set<number> => {
    const fresh = new Set(unseen);
    if (fresh.size && feed) setSeen([...new Set([...seen, ...feed.items.map((it) => it.id)])].slice(-SEEN_MAX));
    return fresh;
  }, [unseen, feed, seen, setSeen]);

  const refreshIfOld = useCallback(() => {
    if (Date.now() - loadedAt.current > REOPEN_STALE_MS) void load();
  }, [load]);

  return { feed, error, loading, unseenCount: unseen.length, markAllSeen, refreshIfOld, reload: load };
}
