import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "@/lib/apiBase";
import type { TripStop } from "./useTripLive";

const POLL_MS = 30_000;

type LiveSegment = { fromId: string; toId: string; excessS: number; level: number };

/** Torlódó szakasz a menet hátralévő részén: `fromIdx` → `fromIdx + 1` megálló között. */
export interface TrafficAhead {
  fromIdx: number;
  excessS: number;
  level: number;
}

/**
 * Utazás közben: hol áll be a forgalom a busz előtt (a `fromIdx` megállótól a
 * `toIdx`-ig) — ugyanaz az élő réteg, ami a térképen a dugókat rajzolja.
 */
export function useTrafficAhead(stops: TripStop[] | null, fromIdx: number, toIdx: number, enabled: boolean): TrafficAhead[] {
  const [segments, setSegments] = useState<LiveSegment[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/engine/traffic/live`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ segments?: LiveSegment[] }>) : null))
        .then((d) => alive && d?.segments && setSegments(d.segments))
        .catch(() => {
          /* a következő kör újrapróbálja */
        });
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);

  return useMemo(() => {
    if (!enabled || !stops?.length || !segments.length) return [];
    const byLink = new Map(segments.map((s) => [`${s.fromId}|${s.toId}`, s]));
    const out: TrafficAhead[] = [];
    for (let i = Math.max(0, fromIdx); i < Math.min(toIdx, stops.length - 1); i++) {
      const s = byLink.get(`${stops[i].id}|${stops[i + 1].id}`);
      if (s) out.push({ fromIdx: i, excessS: s.excessS, level: s.level });
    }
    return out;
  }, [enabled, stops, segments, fromIdx, toIdx]);
}
