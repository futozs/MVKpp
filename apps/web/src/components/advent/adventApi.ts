import { useEffect, useRef, useState } from "react";
import type { AdventDay } from "@mvk/core/advent/day";
import type { AdventSeason, AdventStop } from "@mvk/core/advent/season";
import type { SeasonSummary } from "@mvk/core/advent/seasonStats";
import type { Leg } from "@mvk/core/advent/track";
import type { WrappedCard } from "@mvk/core/advent/wrapped";
import type { LiveVehicle } from "@/types";
import { API_BASE } from "@/lib/apiBase";
import { useTopic } from "@/lib/realtime";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import { fetchCached } from "@/components/fleet/fleetCache";

export type StopGeo = { id: string; lat: number; lon: number };
export type SeasonMeta = Omit<AdventSeason, "stops"> & {
  stops: (AdventStop & { outAt: StopGeo | null; backAt: StopGeo | null })[];
};
export type AdventMeta = {
  today: string;
  current: number;
  inSeason: boolean;
  seasons: SeasonMeta[];
  line: { out: [number, number][]; lengthM: number } | null;
};
export type PublicLeg = Omit<Leg, "fixes" | "passes"> & {
  fixes: number;
  passes: number;
};
export type PublicDay = Omit<AdventDay, "legs"> & { legs: PublicLeg[] };
export type DayResp = { at: number; day: PublicDay; cards?: WrappedCard[] };
export type SeasonResp = {
  at: number;
  summary: SeasonSummary;
  cards: WrappedCard[];
};
export type TrackResp = {
  date: string;
  vehicles: string[];
  points: [number, number, number, number | null][];
};

/** az élő nap ennyi időnként frissül (ms): a szerver 5 mp-re kerekít */
const LIVE_MS = 5000;
const SEASON_MS = 60_000;
const TRACK_MS = 20_000;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function useAdventMeta() {
  const [meta, setMeta] = useState<AdventMeta | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchCached<AdventMeta>("/engine/advent", 300)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);
  return { meta, failed };
}

/**
 * Egy nap: `date` null → a mai élőben (5 mp-enként, amíg a lap látszik); különben a
 * tárolt nap (a lezárt múlt sokáig a gyorsítótárban).
 */
export function useAdventDay(date: string | null) {
  const [state, setState] = useState<{ key: string; resp: DayResp } | null>(null);
  const [failed, setFailed] = useState(false);
  const key = date ?? "live";
  const busy = useRef(false);
  useVisiblePoll(
    () => {
      if (date != null || busy.current) return;
      busy.current = true;
      getJson<DayResp>("/engine/advent/live")
        .then((resp) => {
          setState({ key: "live", resp });
          setFailed(false);
        })
        .catch(() => setFailed(true))
        .finally(() => {
          busy.current = false;
        });
    },
    LIVE_MS,
    [date == null],
  );
  useEffect(() => {
    if (date == null) return;
    let alive = true;
    fetchCached<DayResp>(`/engine/advent/day?date=${date}`, 120)
      .then((resp) => {
        if (!alive) return;
        setState({ key: date, resp });
        setFailed(false);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [date]);
  return { resp: state?.key === key ? state.resp : null, failed };
}

export function useAdventSeason(year: number | null) {
  const [resp, setResp] = useState<SeasonResp | null>(null);
  useVisiblePoll(
    () => {
      if (year == null) return;
      getJson<SeasonResp>(`/engine/advent/season?year=${year}`)
        .then(setResp)
        .catch(() => undefined);
    },
    SEASON_MS,
    [year],
  );
  return resp?.summary.year === year ? resp : null;
}

/** a nap GPS-nyoma (a térképre): ma 20 mp-enként frissül */
export function useAdventTrack(date: string, live: boolean) {
  const [track, setTrack] = useState<TrackResp | null>(null);
  useVisiblePoll(
    () => {
      getJson<TrackResp>(`/engine/advent/track?date=${date}`)
        .then(setTrack)
        .catch(() => undefined);
    },
    live ? TRACK_MS : 24 * 3600_000,
    [date],
  );
  return track?.date === date ? track : null;
}

/**
 * A villamosok élőben (a WebSocket villamos-témája): a szerelvény (a mozgásbecsléssel)
 * és a vonal többi villamosa külön.
 */
export function useLineTrams(isAdvent: (v: LiveVehicle) => boolean) {
  const map = useRef(new Map<string, LiveVehicle>());
  const [list, setList] = useState<LiveVehicle[]>([]);
  useTopic("vehicles@tram", (m) => {
    if (Array.isArray(m.full)) map.current = new Map((m.full as LiveVehicle[]).map((v) => [v.id, v]));
    else {
      for (const v of (m.upd as LiveVehicle[]) ?? []) map.current.set(v.id, v);
      for (const id of (m.del as string[]) ?? []) map.current.delete(id);
    }
    setList([...map.current.values()].filter((v) => v.lat != null && v.lon != null));
  });
  const tram = list.find(isAdvent) ?? null;
  return { tram, others: list.filter((v) => v !== tram) };
}
