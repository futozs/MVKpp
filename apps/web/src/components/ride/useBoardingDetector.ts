import { useEffect, useRef, useState } from "react";
import type { LiveVehicle } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { distM } from "./useTripLive";
import { estimatePosition } from "@/components/map/liveMotion";
import { serverNow } from "@/lib/realtime";
import { RIDE_PROXIMITY, rideModeOf } from "@/lib/modes";

/** két minta között legalább ennyi idő teljen el (a GPS másodpercenként jelezhet) */
const SAMPLE_MS = 10_000;
/** ennyi közös, mozgó minta és ennyi idő kell a kérdéshez */
const HITS = 3;
const MIN_SPAN_MS = 40_000;
/** a telefon és a jármű távolsága (m), a GPS pontatlanságával megnövelve — módonként (lásd RIDE_PROXIMITY) */
/** a minták között legalább ennyit mozdult a telefon (m) — álló buszra nem kérdezünk */
const MOVED_M = 30;
/** „Nem” után ennyi ideig nem kérdezünk újra ugyanarra a buszra */
const SNOOZE_MS = 30 * 60_000;

/** a busz mellett az utolsó álló minta, mielőtt együtt elindultak: a felszállás helye és ideje (készülékidő, ms) */
export type BoardingSpot = { at: number; lat: number; lon: number };
export type BoardingCandidate = LiveVehicle & { since: BoardingSpot };

/**
 * Felszállás-felismerés: ha a telefon több mintán át együtt mozog egy busszal,
 * megkérdezzük, hogy azon utazik-e. Csak akkor fut, ha a térkép nyitva van,
 * a helymeghatározás engedélyezve, és épp nincs folyamatban utazás.
 */
export function useBoardingDetector(enabled: boolean, position: GeoPosition | null, vehicles: LiveVehicle[]) {
  const [candidate, setCandidate] = useState<BoardingCandidate | null>(null);
  const last = useRef<{ at: number; lat: number; lon: number } | null>(null);
  const hits = useRef(new Map<string, { n: number; first: number; spot: BoardingSpot }>());
  const snoozed = useRef(new Map<string, number>());
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;

  useEffect(() => {
    if (!enabled || !position || candidate) return;
    const prev = last.current;
    if (prev && position.at - prev.at < SAMPLE_MS) return;
    last.current = { at: position.at, lat: position.lat, lon: position.lon };
    const moved = prev ? distM(prev, position) >= MOVED_M : false;
    const now = Date.now();

    for (const v of vehiclesRef.current) {
      if (v.lat == null || v.lon == null || !v.tripId) continue;
      if ((snoozed.current.get(v.id) ?? 0) > now) continue;
      // A menetrendből becsült (nem GPS) helyzetű jármű mellől nem kérdezünk.
      if (v.estimated) continue;
      const px = RIDE_PROXIMITY[v.mode ?? rideModeOf(v.id, v.tripId)];
      const near = Math.max(px.near, Math.min(px.near + 70, position.accuracyM ?? px.near));
      const far = px.far;
      // A busz jele 0–15 mp-es (gyors szakaszon 150+ m lemaradás): a becsült mostani helyéhez mérünk.
      const est = estimatePosition(v.motion, serverNow(), undefined);
      const d = distM(position, est ? { lat: est.latlng[0], lon: est.latlng[1] } : { lat: v.lat, lon: v.lon });
      const h = hits.current.get(v.id);
      if (d > far) {
        if (h) hits.current.delete(v.id);
        continue;
      }
      if (d > near) continue;
      const here = { at: position.at, lat: position.lat, lon: position.lon };
      if (!moved) {
        // Együtt állnak (a megállóban, felszálláskor): amíg el nem indultak, ez a felszállás helye.
        hits.current.set(v.id, h?.n ? h : { n: 0, first: 0, spot: here });
        continue;
      }
      const next = h?.n ? { ...h, n: h.n + 1 } : { n: 1, first: position.at, spot: h?.spot ?? here };
      hits.current.set(v.id, next);
      if (next.n >= HITS && position.at - next.first >= MIN_SPAN_MS) {
        hits.current.clear();
        setCandidate({ ...v, since: next.spot });
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
