import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/apiBase";
import { useFallbackPoll, useTopic } from "@/lib/realtime";

export interface TripStop {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  dep: number;
  schedTime: string;
  schedTs: number;
  idx: number;
}

export interface ForecastStop {
  idx: number;
  stopId: string;
  schedS: number;
  delayS: number;
  upperS: number;
}

export interface TripRun {
  serviceDate: string;
  vehicleId: string;
  status: string;
  lastStopIdx: number | null;
  lastDelayS: number | null;
  stopsTotal: number;
  closeReason: string | null;
  /** beérkezés a végállomásra (unix) */
  actualEnd?: number | null;
}

export interface TripLive {
  tripId: string;
  /** a végállomás fordulóhurok (ülve maradva körbe lehet utazni) */
  loopEnd: boolean;
  stops: TripStop[];
  run: TripRun | null;
  delayS: number | null;
  forecast: Map<number, ForecastStop>;
  vehicle: { id: string; lat: number; lon: number; speed: number | null } | null;
}

type TripDetail = { stops: TripStop[]; loopEnd?: boolean; run: TripRun | null; liveDelaySec: number | null; forecast: { stops: ForecastStop[] } | null };
type TripMsg = { vehicle: TripLive["vehicle"]; run: TripRun | null; measuredDelaySec: number | null; forecast: { stops: ForecastStop[] } | null };

/** Egy menet élőben: megállók (egyszer), helyzet, késés és előrejelzés (WebSocket). */
type LiveState = Omit<TripLive, "stops" | "loopEnd">;

export function useTripLive(tripId: string): TripLive | null {
  // Az állapot a menethez kötött: menetváltáskor (körbeutazás) az előző
  // menet adata egy pillanatra sem keveredhet az újéval.
  const [meta, setMeta] = useState<{ tripId: string; stops: TripStop[]; loopEnd: boolean } | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const current = useRef(tripId);
  current.current = tripId;

  const apply = useCallback(
    (m: TripMsg | TripDetail) => {
      const fc = m.forecast?.stops ?? [];
      setLive((p) => {
        const prev = p?.tripId === tripId ? p : null;
        return {
          tripId,
          run: m.run ?? prev?.run ?? null,
          delayS: ("measuredDelaySec" in m ? m.measuredDelaySec : m.liveDelaySec) ?? m.run?.lastDelayS ?? prev?.delayS ?? null,
          forecast: fc.length ? new Map(fc.map((s) => [s.idx, s])) : (prev?.forecast ?? new Map()),
          vehicle: "vehicle" in m ? m.vehicle : (prev?.vehicle ?? null),
        };
      });
    },
    [tripId],
  );

  const load = useCallback(() => {
    fetch(`${API_BASE}/engine/trip?trip=${encodeURIComponent(tripId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<TripDetail>) : null))
      .then((d) => {
        // Egy lassan visszaérő, előző menetre szóló válasz ne írja felül az újat.
        if (!d || current.current !== tripId) return;
        setMeta({ tripId, stops: d.stops, loopEnd: Boolean(d.loopEnd) });
        apply(d);
      })
      .catch(() => {});
  }, [tripId, apply]);

  useEffect(load, [load]);
  useTopic(`trip:${tripId}`, (m) => apply(m.data as TripMsg));
  useFallbackPoll(load, 15_000);

  if (meta?.tripId !== tripId || live?.tripId !== tripId) return null;
  return { ...live, stops: meta.stops, loopEnd: meta.loopEnd };
}

/** légvonalbeli távolság (m) */
export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A menet megállói közötti út (légvonalban, megállóról megállóra összegezve). */
export function pathLengthM(stops: TripStop[], from: number, to: number): number | null {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(to, stops.length - 1); i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
    sum += distM({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
  }
  return Math.round(sum);
}
