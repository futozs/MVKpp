import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/apiBase";

const POLL_MS = 60_000;

/**
 * Élő zavarok száma a fejléc-jelvényhez: az MVK mai hivatalos törlései +
 * a most valószínűleg kimaradó menetek (15+ perce esedékes, egyetlen jármű sem
 * vitte, miközben a vonalat követjük). A v2 itt a hamis detektor adatát mutatta.
 */
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
