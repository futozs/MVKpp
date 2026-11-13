import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/apiBase";

const POLL_MS = 60_000;

/**
 * Élő zavarok száma a fejléc-jelvényhez: az MVK mai hivatalos törlései +
 * a most valószínűleg kimaradó menetek (15+ perce esedékes, egyetlen jármű sem
 * vitte, miközben a vonalat követjük). A v2 itt a hamis detektor adatát mutatta.
 */
export interface LiveMissing {
  tripId: string;
  route: string;
  time: string;
  headsign: string;
  lateMin: number;
}

export interface LiveIncidents {
  date: string;
  /** az MVK mai hivatalos törléseinek száma */
  cancelled: number;
  /** most valószínűleg kimaradó menetek (ezt jelzi a piros jelvény) */
  missing: LiveMissing[];
}

/** Az élő zavarok részletei (percenként frissítve)  az Üzemzavarok panel tetejére. */
export function useLiveIncidentDetails(): LiveIncidents | null {
  const [data, setData] = useState<LiveIncidents | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/engine/incidents/live`)
        .then((r) => (r.ok ? (r.json() as Promise<LiveIncidents>) : null))
        .then((d) => alive && d && setData(d))
        .catch(() => {});
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return data;
}

export function useLiveIncidents(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`${API_BASE}/engine/incidents/live`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { missing?: unknown[] } | null) => {
          // Csak a „most kimaradó” menetek: a napi törlések száma (30+) jelvénynek túl zajos.
          if (alive && d) setCount(d.missing?.length ?? 0);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return count;
}
