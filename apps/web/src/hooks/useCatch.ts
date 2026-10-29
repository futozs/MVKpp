import { useCallback, useEffect, useState } from "react";
import { CATCH, catchVerdict, walkSecondsFor, type CatchVerdict } from "@mvk/core/catchBus";
import type { ArrivalItem } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { distanceKm } from "@/lib/geo";
import { serverNow } from "@/lib/realtime";

/** ennyi másodpercenként számoljuk újra (a séta és a busz is halad) */
const TICK_MS = 10_000;

/** A busz várható érkezése a megállóba (unix) és a 85%-os felső becslés. */
export function expectedArrival(a: ArrivalItem, now: number): { at: number; upper: number | null } {
  if (a.schedUnix != null) {
    // A kiinduló megállónál nincs szakasz-előrejelzés: ott a késve indulás jóslata számít.
    const delay = a.forecastDelaySec ?? a.startRisk?.expectedDelayS ?? a.delaySec ?? a.measuredDelaySec ?? 0;
    const upper = a.forecastUpperSec != null ? a.schedUnix + a.forecastUpperSec : null;
    return { at: a.schedUnix + delay, upper };
  }
  return { at: now + a.etaMin * 60, upper: null };
}

export type CatchFor = {
  /** séta a megállóig (mp), ha tudjuk, hol vagy és gyalogtávon belül vagy */
  walkS: number | null;
  verdict: (a: ArrivalItem) => CatchVerdict | null;
  now: number;
};

/**
 * „Elérem?” egy megálló indulásaira: a helyzetedből a séta ideje, és
 * indulásonként a verdikt (ráérsz / indulj most / fuss / lekésed).
 */
export function useCatchFor(stop: { lat?: number; lon?: number } | null | undefined): CatchFor {
  const geo = useGeo();
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const pos = geo.position;
  const distM = pos && stop?.lat != null && stop?.lon != null ? distanceKm(pos.lat, pos.lon, stop.lat, stop.lon) * 1000 : null;
  const walkS = distM != null && distM <= CATCH.MAX_WALK_M ? walkSecondsFor(distM) : null;

  const verdict = useCallback(
    (a: ArrivalItem) => {
      if (walkS == null || a.cancelled) return null;
      const { at, upper } = expectedArrival(a, now);
      return catchVerdict({ nowUnix: now, expectedUnix: at, upperUnix: upper, walkS });
    },
    [walkS, now],
  );
  return { walkS, verdict, now };
}
