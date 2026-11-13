import { useCallback, useEffect, useRef, useState } from "react";
import type { RideStopEvent } from "@mvk/core/rides";
import { API_BASE } from "@/lib/apiBase";
import { useFallbackPoll, useTopic } from "@/lib/realtime";
import { serviceNow } from "@/lib/serviceDay";

export { pathLengthM } from "@mvk/core/rides";

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
  /** a busz tényleges érkezései és indulásai megállónként */
  events: RideStopEvent[];
  run: TripRun | null;
  delayS: number | null;
  forecast: Map<number, ForecastStop>;
  vehicle: { id: string; lat: number; lon: number; speed: number | null } | null;
  /** a menet rövid neve (vasút: „5169 személyvonat”, Volán: „4001/748”) */
  tripShort: string | null;
}

export type TripDetail = {
  stops: TripStop[];
  loopEnd?: boolean;
  tripShort?: string;
  run: TripRun | null;
  liveDelaySec: number | null;
  forecast: { stops: ForecastStop[] } | null;
  events?: RideStopEvent[];
};
type TripMsg = { vehicle: TripLive["vehicle"]; run: TripRun | null; measuredDelaySec: number | null; forecast: { stops: ForecastStop[] } | null };

/** Egy menet élőben: megállók, tény-idők, helyzet, késés és előrejelzés (WebSocket). */
type LiveState = Omit<TripLive, "stops" | "loopEnd" | "events" | "tripShort">;

export const tripDetailUrl = (tripId: string, date?: string) =>
  `${API_BASE}/engine/trip?trip=${encodeURIComponent(tripId)}${date ? `&date=${encodeURIComponent(date)}` : ""}`;

/**
 * `date` (szolgáltatási nap): a menet arra a napra. Egy korábbi napi menetnek
 * (bezárt app, másnap nyitva) nincs élő adatfolyama  az egyszeri lekérés a végleges állapotát adja.
 */
export function useTripLive(tripId: string, date?: string): TripLive | null {
  // Az állapot a menethez kötött: menetváltáskor (körbeutazás) az előző
  // menet adata egy pillanatra sem keveredhet az újéval.
  const [meta, setMeta] = useState<{ tripId: string; stops: TripStop[]; loopEnd: boolean; events: RideStopEvent[]; tripShort: string | null } | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const current = useRef(tripId);
  current.current = tripId;
  const isToday = !date || date === serviceNow().iso;

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
    fetch(tripDetailUrl(tripId, date), { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<TripDetail>) : null))
      .then((d) => {
        // Egy lassan visszaérő, előző menetre szóló válasz ne írja felül az újat.
        if (!d || current.current !== tripId) return;
        setMeta({ tripId, stops: d.stops, loopEnd: Boolean(d.loopEnd), events: d.events ?? [], tripShort: d.tripShort ?? null });
        apply(d);
      })
      .catch(() => {});
  }, [tripId, date, apply]);

  useEffect(load, [load]);
  // Más napon ugyanez a menetazonosító egy másik menet: annak az élő adata nem keveredhet ide.
  useTopic(`trip:${tripId}`, (m) => isToday && apply(m.data as TripMsg));
  useFallbackPoll(load, 15_000);

  // Új megálló-esemény (a busz elhagyott egy megállót): a tény-idők frissítése.
  const passed = live?.tripId === tripId ? live.run?.lastStopIdx : undefined;
  const loaded = meta?.tripId === tripId;
  useEffect(() => {
    if (loaded && passed != null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passed]);

  if (meta?.tripId !== tripId || live?.tripId !== tripId) return null;
  return { ...live, stops: meta.stops, loopEnd: meta.loopEnd, events: meta.events, tripShort: meta.tripShort };
}

/** légvonalbeli távolság (m) */
export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
