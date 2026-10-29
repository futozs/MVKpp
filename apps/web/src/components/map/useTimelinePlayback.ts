import { useCallback, useEffect, useRef, useState } from "react";
import { windowStartOf, type HistoryWindow } from "./historyData";
import type { RenderResult } from "./useHistoryMarkers";

/** Egy elakadt (háttérbe tett) lap után se ugorjon nagyot a kurzor. */
const MAX_FRAME_DT_SEC = 0.25;
/** A felirat és a csúszka ennyi időnként frissül lejátszás közben. */
const UI_REFRESH_MS = 100;

export const SPEEDS = [1, 10, 60, 300] as const;
export type PlaybackSpeed = (typeof SPEEDS)[number];

export interface PlaybackBounds {
  start: number;
  /** A legkésőbbi elérhető pillanat (a mai napon a jelen). */
  limit: number;
}

export interface Playback {
  cursor: number;
  playing: boolean;
  /** Lejátszás közben az adatra vár (a következő ablak még töltődik). */
  buffering: boolean;
  speed: PlaybackSpeed;
  stats: RenderResult;
  /** `nextBounds`: napváltáskor az új nap határai, mielőtt a render utolérné. */
  seek: (t: number, nextBounds?: PlaybackBounds) => void;
  step: (deltaSec: number) => void;
  togglePlay: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  scrubStart: () => void;
  scrubEnd: () => void;
  /** Újrarajzolást kér a következő képkockára (pl. új adat vagy szűrő). */
  invalidate: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Lejátszás: a kurzor egy ref-ben él, és requestAnimationFrame lépteti. A
 * React-állapot csak ritkítva követi, így a szülő nem renderel képkockánként.
 * Ha a következő ablak még nincs meg, a kurzor az ablakhatáron megvárja.
 */
export function useTimelinePlayback(
  initial: number,
  bounds: PlaybackBounds,
  getWindow: (start: number) => HistoryWindow | undefined,
  render: (t: number) => RenderResult,
): Playback {
  const [cursor, setCursor] = useState(initial);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(60);
  const [stats, setStats] = useState<RenderResult>({ ready: false, visible: 0 });

  const cursorRef = useRef(initial);
  const playingRef = useRef(false);
  const speedRef = useRef<PlaybackSpeed>(60);
  const scrubbingRef = useRef(false);
  const boundsRef = useRef(bounds);
  const statsRef = useRef(stats);
  const bufferingRef = useRef(false);
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lastUiRef = useRef(0);
  const dirtyRef = useRef(true);
  const tickRef = useRef<(now: number) => void>(() => {});

  useEffect(() => {
    boundsRef.current = bounds;
  });

  const advance = useCallback(
    (t: number, delta: number): number => {
      const here = windowStartOf(t);
      if (!getWindow(here)) return t;
      let next = Math.min(t + delta, boundsRef.current.limit);
      const there = windowStartOf(next);
      if (there !== here && !getWindow(there)) next = Math.max(t, there - 0.001);
      return next;
    },
    [getWindow],
  );

  const tick = useCallback(
    (now: number) => {
      rafRef.current = 0;
      const dt = lastFrameRef.current
        ? Math.min(MAX_FRAME_DT_SEC, (now - lastFrameRef.current) / 1000)
        : 0;
      lastFrameRef.current = now;

      let t = cursorRef.current;
      let stalled = false;
      if (playingRef.current && !scrubbingRef.current && dt > 0) {
        const next = advance(t, dt * speedRef.current);
        stalled = next === t;
        if (!stalled) {
          t = next;
          cursorRef.current = t;
          dirtyRef.current = true;
        }
        if (t >= boundsRef.current.limit) {
          playingRef.current = false;
          stalled = false;
          setPlaying(false);
        }
      } else if (playingRef.current && scrubbingRef.current) {
        stalled = bufferingRef.current;
      }
      if (stalled !== bufferingRef.current) {
        bufferingRef.current = stalled;
        setBuffering(stalled);
      }

      if (dirtyRef.current) {
        dirtyRef.current = false;
        const res = render(t);
        const prev = statsRef.current;
        if (res.ready !== prev.ready || res.visible !== prev.visible) {
          statsRef.current = res;
          setStats(res);
        }
      }

      const isPlaying = playingRef.current;
      if (!isPlaying || now - lastUiRef.current >= UI_REFRESH_MS) {
        lastUiRef.current = now;
        setCursor(t);
      }
      if (isPlaying) {
        rafRef.current = requestAnimationFrame(tickRef.current);
      } else {
        lastFrameRef.current = 0;
      }
    },
    [advance, render],
  );

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const invalidate = useCallback(() => {
    dirtyRef.current = true;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tickRef.current);
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  const seek = useCallback(
    (t: number, nextBounds?: PlaybackBounds) => {
      if (nextBounds) boundsRef.current = nextBounds;
      const { start, limit } = boundsRef.current;
      const next = clamp(t, start, Math.max(start, limit));
      cursorRef.current = next;
      setCursor(next);
      invalidate();
    },
    [invalidate],
  );

  const step = useCallback(
    (deltaSec: number) => seek(cursorRef.current + deltaSec),
    [seek],
  );

  const togglePlay = useCallback(() => {
    const next = !playingRef.current;
    const { start, limit } = boundsRef.current;
    // A nap végén a lejátszás elölről indul.
    if (next && cursorRef.current >= limit - 1) {
      cursorRef.current = start;
      setCursor(start);
    }
    playingRef.current = next;
    setPlaying(next);
    if (!next && bufferingRef.current) {
      bufferingRef.current = false;
      setBuffering(false);
    }
    lastFrameRef.current = 0;
    invalidate();
  }, [invalidate]);

  const setSpeed = useCallback((value: PlaybackSpeed) => {
    speedRef.current = value;
    setSpeedState(value);
  }, []);

  const scrubStart = useCallback(() => {
    scrubbingRef.current = true;
  }, []);

  const scrubEnd = useCallback(() => {
    scrubbingRef.current = false;
    lastFrameRef.current = 0;
    invalidate();
  }, [invalidate]);

  return {
    cursor,
    playing,
    buffering,
    speed,
    stats,
    seek,
    step,
    togglePlay,
    setSpeed,
    scrubStart,
    scrubEnd,
    invalidate,
  };
}
