import { useRef, useState } from "react";
import type { BoardSnapshot } from "@mvk/core";
import { API_BASE } from "@/lib/apiBase";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";

const POLL_MS = 15_000;

/** Az élő flotta-rangsor, amíg a lap látható; hiba után a legutóbbi adat marad kint. */
export function useFleetBoard() {
  const [data, setData] = useState<BoardSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  useVisiblePoll(
    () => {
      if (busy.current) return;
      busy.current = true;
      fetch(`${API_BASE}/engine/fleet/live`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<BoardSnapshot>;
        })
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
    [],
  );
  return { data, failed };
}
