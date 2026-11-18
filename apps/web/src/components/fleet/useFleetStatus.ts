import { useState } from "react";
import type { BusState, TramState } from "@mvk/core";
import { API_BASE } from "@/lib/apiBase";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";

const POLL_MS = 60_000;
const TRAM_ALERT: TramState[] = ["collapsed", "halted", "replaced"];
const BUS_ALERT: BusState[] = ["jammed", "collapsed"];

/** Bajban van-e most a villamos vagy a buszhálózat: a Flotta gombjának piros pöttye. */
export function useFleetAlert(): boolean {
  const [alert, setAlert] = useState(false);
  useVisiblePoll(
    () => {
      fetch(`${API_BASE}/engine/fleet/status`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ tram: TramState; bus: BusState }>) : null))
        .then((s) => {
          if (s) setAlert(TRAM_ALERT.includes(s.tram) || BUS_ALERT.includes(s.bus));
        })
        .catch(() => {});
    },
    POLL_MS,
    [],
  );
  return alert;
}
