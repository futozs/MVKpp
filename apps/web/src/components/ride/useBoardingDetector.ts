import { useEffect, useRef, useState } from "react";
import type { LiveVehicle } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { distM } from "./useTripLive";

/** két minta között legalább ennyi idő teljen el (a GPS másodpercenként jelezhet) */
const SAMPLE_MS = 10_000;
/** ennyi közös, mozgó minta és ennyi idő kell a kérdéshez */
const HITS = 3;
const MIN_SPAN_MS = 40_000;
/** a telefon és a busz távolsága (m), a GPS pontatlanságával megnövelve */
const NEAR_M = 50;
const FAR_M = 150;
/** a minták között legalább ennyit mozdult a telefon (m) — álló buszra nem kérdezünk */
const MOVED_M = 30;
/** „Nem” után ennyi ideig nem kérdezünk újra ugyanarra a buszra */
const SNOOZE_MS = 30 * 60_000;

export type BoardingCandidate = LiveVehicle;

/**
 * Felszállás-felismerés: ha a telefon több mintán át együtt mozog egy busszal,
 * megkérdezzük, hogy azon utazik-e. Csak akkor fut, ha a térkép nyitva van,
 * a helymeghatározás engedélyezve, és épp nincs folyamatban utazás.
 */
export function useBoardingDetector(enabled: boolean, position: GeoPosition | null, vehicles: LiveVehicle[]) {
  const [candidate, setCandidate] = useState<BoardingCandidate | null>(null);
  const last = useRef<{ at: number; lat: number; lon: number } | null>(null);
  const hits = useRef(new Map<string, { n: number; first: number }>());
  const snoozed = useRef(new Map<string, number>());
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;

  useEffect(() => {
    if (!enabled || !position || candidate) return;
    const prev = last.current;
    if (prev && position.at - prev.at < SAMPLE_MS) return;
    last.current = { at: position.at, lat: position.lat, lon: position.lon };
    const moved = prev ? distM(prev, position) >= MOVED_M : false;
    const near = Math.max(NEAR_M, Math.min(120, position.accuracyM ?? NEAR_M));
    const now = Date.now();

    for (const v of vehiclesRef.current) {
      if (v.lat == null || v.lon == null || !v.tripId) continue;
      if ((snoozed.current.get(v.id) ?? 0) > now) continue;
      const d = distM(position, { lat: v.lat, lon: v.lon });
      const h = hits.current.get(v.id);
      if (d > FAR_M) {
        if (h) hits.current.delete(v.id);
        continue;
      }
      if (d > near || !moved) continue;
      const next = h ? { n: h.n + 1, first: h.first } : { n: 1, first: position.at };
      hits.current.set(v.id, next);
      if (next.n >= HITS && position.at - next.first >= MIN_SPAN_MS) {
        hits.current.clear();
        setCandidate(v);
        return;
      }
    }
  }, [enabled, position, candidate]);

  return {
    candidate,
    /** „Nem” — erre a buszra egy ideig nem kérdezünk újra */
    dismiss: () => {
      if (candidate) snoozed.current.set(candidate.id, Date.now() + SNOOZE_MS);
      setCandidate(null);
    },
    clear: () => setCandidate(null),
  };
}

/**
 * Utazás közben: ha a telefon tartósan eltávolodik a busztól, leszállt.
 * `onLeft` akkor hívódik, ha legalább 2 percen át 300 m-nél messzebb van.
 */
export function useAlightingDetector(enabled: boolean, position: GeoPosition | null, vehicle: { lat: number; lon: number } | null, onLeft: () => void) {
  const since = useRef<number | null>(null);
  const cb = useRef(onLeft);
  cb.current = onLeft;
  useEffect(() => {
    if (!enabled || !position || !vehicle) {
      since.current = null;
      return;
    }
    if (distM(position, vehicle) <= 300) {
      since.current = null;
      return;
    }
    since.current ??= position.at;
    if (position.at - since.current >= 120_000) {
      since.current = null;
      cb.current();
    }
  }, [enabled, position, vehicle]);
}
