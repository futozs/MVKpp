import { useEffect, useState } from "react";
import { nearestDelayS, rideStopIdx, stopTimes, type RideStopEvent } from "@mvk/core/rides";
import { API_BASE } from "@/lib/apiBase";
import { patchRides, type Ride } from "@/lib/rides";
import { tripDetailUrl, type TripDetail } from "./useTripLive";

/** a már megpróbált (pótolt vagy mérés nélküli) utazások  nem kérdezzük le őket újra */
const TRIED_KEY = "mvk_ride_delay_tried";
/** egy megnyitáskor legfeljebb ennyi menetet kérdezünk le */
const PER_VISIT = 40;

function readTried(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRIED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function writeTried(ids: Set<string>) {
  try {
    localStorage.setItem(TRIED_KEY, JSON.stringify([...ids].slice(-3000)));
  } catch {
    /* privát mód / megtelt */
  }
}

const missingDelay = (r: Ride) => r.delayAtBoardS == null || r.delayAtAlightS == null;

/**
 * A késés pótlása: a régebbi (főleg utólag felvett) utazásoknál, ahol a fel- vagy
 * leszálláskor nem volt mért esemény, a menet tény-adataiból (a legközelebbi mért
 * megálló késésével) utólag kiszámoljuk. Csak a hiányzó mezőt tölti ki.
 */
export function useDelayBackfill(rides: readonly Ride[]) {
  const todo = rides.filter((r) => missingDelay(r) && r.tripId && (r.fromStopId || r.toStopId));
  const key = todo.map((r) => r.id).join(",");
  useEffect(() => {
    if (!todo.length) return;
    const tried = readTried();
    const batch = todo.filter((r) => !tried.has(r.id)).slice(0, PER_VISIT);
    if (!batch.length) return;
    const ctl = new AbortController();
    void (async () => {
      const patches: Record<string, Partial<Ride>> = {};
      for (const r of batch) {
        const res = await fetch(tripDetailUrl(r.tripId, r.serviceDate), { signal: ctl.signal }).catch(() => null);
        if (ctl.signal.aborted) return;
        // hálózati hiba: legközelebb újra próbáljuk; a többi (nincs adat) eldőlt
        if (!res) continue;
        tried.add(r.id);
        const d = res.ok ? ((await res.json().catch(() => null)) as (TripDetail & { events?: RideStopEvent[] }) | null) : null;
        if (!d?.stops?.length || !d.events?.length) continue;
        const times = stopTimes(d.events);
        const { from, to } = rideStopIdx(d.stops, r.fromStopId, r.toStopId);
        const patch: Partial<Ride> = {};
        if (r.delayAtBoardS == null && from != null) {
          const v = times.get(from)?.delayS ?? nearestDelayS(times, from);
          if (v != null) patch.delayAtBoardS = v;
        }
        if (r.delayAtAlightS == null && to != null) {
          const v = times.get(to)?.delayS ?? nearestDelayS(times, to);
          if (v != null) patch.delayAtAlightS = v;
        }
        if (r.loopEnd == null && d.loopEnd != null) patch.loopEnd = d.loopEnd;
        if (Object.keys(patch).length) patches[r.id] = patch;
      }
      writeTried(tried);
      if (Object.keys(patches).length) patchRides(patches);
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

let loopRoutesCache: Promise<Set<string>> | null = null;

function loadLoopRoutes(): Promise<Set<string>> {
  loopRoutesCache ??= fetch(`${API_BASE}/engine/ridelog/loops`)
    .then((r) => (r.ok ? (r.json() as Promise<{ routes?: string[] }>) : null))
    .then((b) => new Set(b?.routes ?? []))
    .catch(() => {
      loopRoutesCache = null;
      return new Set<string>();
    });
  return loopRoutesCache;
}

/** A vonalak, amelyeken körbe lehet utazni (fordulóhurkos végállomásuk van). */
export function useLoopRoutes(): ReadonlySet<string> {
  const [routes, setRoutes] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    void loadLoopRoutes().then((s) => alive && setRoutes(s));
    return () => {
      alive = false;
    };
  }, []);
  return routes;
}
