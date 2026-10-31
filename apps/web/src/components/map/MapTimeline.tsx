import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type L from "leaflet";
import { Pause, Play, Radio } from "lucide-react";
import type { FilterState, Route } from "@/types";
import { Button } from "@/components/ui/button";
import { serverNow } from "@/lib/realtime";
import { cn, normalizeSearchText } from "@/lib/utils";
import { WINDOW_SEC, windowStartOf } from "./historyData";
import { MAX_GAP_SEC } from "./historySampler";
import {
  daysBetweenDesc,
  formatClock,
  formatClockShort,
  formatDateOf,
  serviceDayOf,
  serviceDayRange,
  type ServiceDayRange,
} from "./historyTime";
import { TimelineDayPicker } from "./TimelineDayPicker";
import { TimelineSlider } from "./TimelineSlider";
import { useHistoryDays, useHistoryFrames } from "./useHistoryFrames";
import { useHistoryMarkers } from "./useHistoryMarkers";
import { SPEEDS, useTimelinePlayback, type PlaybackBounds } from "./useTimelinePlayback";
import { vehicleModeOf } from "@/lib/modes";

/** Ennél keskenyebb térképen a vezérlők három sorba rendeződnek. */
const WIDE_MIN_PX = 720;
/** Ennyivel az ablak vége előtt már jön a következő ablak is. */
const PREFETCH_LEAD_SEC = 15 * 60;
/** A mai napon a jelenhez ennyinél közelebb nem enged a csúszka (még nincs adat). */
const LIVE_MARGIN_SEC = 60;
const MINUTE = 60;
const TEN_MINUTES = 600;
/** A sáv alja a térkép aljától (bottom-3). */
const BAR_BOTTOM_PX = 12;

const nowSec = () => Math.floor(serverNow());

function limitFor(range: ServiceDayRange): number {
  return Math.max(range.start, Math.min(range.end - 1, nowSec() - LIVE_MARGIN_SEC));
}

/** Alapból ugyanaz a napszak, mint most — "mi volt tegnap ilyenkor". */
function defaultCursor(day: string): number {
  const now = nowSec();
  const offset = now - serviceDayRange(serviceDayOf(now)).start;
  const range = serviceDayRange(day);
  return Math.min(limitFor(range), range.start + offset);
}

interface MapTimelineProps {
  mapRef: RefObject<L.Map | null>;
  routes: Record<string, Route>;
  filters: FilterState;
  onExit: () => void;
  /** A sáv által eltakart magasság (px), hogy a többi vezérlő fölé kerülhessen. */
  onInsetChange: (px: number) => void;
}

/**
 * Az idővonal: a térkép alján egy sáv, amellyel egy korábbi nap bármely
 * pillanata visszanézhető, vagy lejátszható gyorsítva.
 */
export function MapTimeline({ mapRef, routes, filters, onExit, onInsetChange }: MapTimelineProps) {
  const { days, error, reload } = useHistoryDays();
  const barRef = useRef<HTMLElement>(null);
  const insetCbRef = useRef(onInsetChange);
  const [wide, setWide] = useState(false);
  const [inset, setInset] = useState(0);

  useEffect(() => {
    insetCbRef.current = onInsetChange;
  });

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      const covered = Math.round(box.height) + BAR_BOTTOM_PX;
      setWide(box.width >= WIDE_MIN_PX);
      setInset(covered);
      insetCbRef.current(covered);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      insetCbRef.current(0);
    };
  }, []);

  const dayList = useMemo(
    () => (days?.gpsMin && days.gpsMax ? daysBetweenDesc(days.gpsMin, days.gpsMax) : []),
    [days],
  );

  let body: ReactNode;
  if (error) {
    body = (
      <StatusRow text={error} onExit={onExit}>
        <Button variant="outline" size="sm" onClick={reload}>
          Újra
        </Button>
      </StatusRow>
    );
  } else if (!days) {
    body = <StatusRow text="Rögzített napok betöltése…" onExit={onExit} />;
  } else if (dayList.length === 0) {
    body = <StatusRow text="Még egyetlen napról sincs rögzített GPS-adat." onExit={onExit} />;
  } else {
    body = (
      <TimelinePlayer
        days={dayList}
        wide={wide}
        inset={inset}
        mapRef={mapRef}
        routes={routes}
        filters={filters}
        onExit={onExit}
      />
    );
  }

  return (
    <section
      ref={barRef}
      aria-label="Idővonal"
      className="absolute inset-x-3 bottom-3 z-overlay mx-auto mb-[env(safe-area-inset-bottom)] max-w-[880px] rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur-sm"
    >
      {body}
    </section>
  );
}

function ExitButton({ onExit, compact }: { onExit: () => void; compact: boolean }) {
  return (
    <Button
      variant="secondary"
      onClick={onExit}
      className={cn("shrink-0", compact ? "h-11 px-3 text-xs" : "h-9")}
    >
      <Radio aria-hidden className={compact ? "hidden min-[400px]:block" : undefined} />
      Vissza élőbe
    </Button>
  );
}

function StatusRow({
  text,
  onExit,
  children,
}: {
  text: string;
  onExit: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
        {text}
      </p>
      {children}
      <ExitButton onExit={onExit} compact={false} />
    </div>
  );
}

interface TimelinePlayerProps {
  days: string[];
  wide: boolean;
  inset: number;
  mapRef: RefObject<L.Map | null>;
  routes: Record<string, Route>;
  filters: FilterState;
  onExit: () => void;
}

function TimelinePlayer({ days, wide, inset, mapRef, routes, filters, onExit }: TimelinePlayerProps) {
  const compact = !wide;
  const rootRef = useRef<HTMLDivElement>(null);
  const frames = useHistoryFrames();
  const [day, setDay] = useState(days[0]);
  const [initialCursor] = useState(() => defaultCursor(days[0]));
  const range = useMemo(() => serviceDayRange(day), [day]);
  const bounds: PlaybackBounds = { start: range.start, limit: limitFor(range) };

  // A visszajátszás a statisztikai kulccsal jön (MVK: a rövid név; Volán, vasút: a vonal-azonosító).
  const routeByShort = useMemo(() => {
    const map = new Map<string, Route>();
    for (const r of Object.values(routes)) {
      const k = r.key ?? r.short;
      if (!map.has(k)) map.set(k, r);
    }
    return map;
  }, [routes]);

  // Ugyanaz a szűrés, mint az élő rétegen: követett rendszám, típus, járatok.
  const isVisible = useMemo(() => {
    const targets = filters.watch.map((w) => normalizeSearchText(w));
    const q = normalizeSearchText(filters.vq.trim());
    if (q && !targets.includes(q)) targets.push(q);
    const shorts =
      filters.routes.length > 0
        ? new Set(filters.routes.map((id) => routes[id]?.key ?? routes[id]?.short).filter(Boolean))
        : null;
    const modes = filters.modes;
    return (id: string, short: string | null): boolean => {
      if (targets.length > 0) {
        const vid = id.toLowerCase();
        return targets.some((t) => vid.includes(t));
      }
      if (modes.length) {
        const r = short ? routeByShort.get(short) : undefined;
        if (!modes.includes(vehicleModeOf({ id }, r?.type))) return false;
      }
      return !shorts || (short != null && shorts.has(short));
    };
  }, [filters.watch, filters.vq, filters.routes, filters.modes, routes, routeByShort]);

  const isTracked = useMemo(() => {
    const watch = new Set(filters.watch.map((w) => w.toLowerCase()));
    const q = filters.vq.trim().toLowerCase();
    return (id: string) => {
      const vid = id.toLowerCase();
      return watch.has(vid) || (q ? vid.includes(q) : false);
    };
  }, [filters.watch, filters.vq]);

  const invalidateRef = useRef<() => void>(() => {});
  const render = useHistoryMarkers(
    mapRef,
    frames.get,
    { routeByShort, isVisible, isTracked, showIds: filters.labels, bottomInset: inset },
    () => invalidateRef.current(),
  );
  const playback = useTimelinePlayback(initialCursor, bounds, frames.get, render);
  const { cursor, playing, buffering, speed, stats, invalidate, togglePlay, step, seek } =
    playback;

  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate]);

  useEffect(() => {
    invalidate();
  }, [frames.version, isVisible, isTracked, routeByShort, filters.labels, invalidate]);

  // A kurzor körüli ablakok: az aktuális, lejátszáskor vagy a vége felé a
  // következő, az elején az előző (hogy az ablakhatáron is legyen mihez
  // interpolálni). Ami ezen kívül még töltődik, az megszakad.
  const here = windowStartOf(cursor);
  const offset = cursor - here;
  const wanted = [here];
  if (playing || offset > WINDOW_SEC - PREFETCH_LEAD_SEC) wanted.push(here + WINDOW_SEC);
  if (offset < MAX_GAP_SEC) wanted.push(here - WINDOW_SEC);
  const wantedKey = wanted.join(",");
  const { ensure } = frames;

  useEffect(() => {
    ensure(wantedKey.split(",").map(Number));
  }, [wantedKey, ensure, frames.version]);

  useKeyboardControls(rootRef, mapRef, togglePlay, step);

  const changeDay = (next: string) => {
    const dayOffset = playback.cursor - range.start;
    const nextRange = serviceDayRange(next);
    setDay(next);
    seek(nextRange.start + dayOffset, { start: nextRange.start, limit: limitFor(nextRange) });
  };

  const dateLabel = formatDateOf(cursor);
  const status = !stats.ready || buffering ? (
    frames.error ? (
      <button
        type="button"
        onClick={frames.retry}
        className="font-semibold text-destructive underline underline-offset-2"
      >
        Betöltési hiba — újra
      </button>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-primary">
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        Betöltés…
      </span>
    )
  ) : (
    <span className="font-mono tabular-nums">{stats.visible} jármű</span>
  );

  const playButton = (
    <Button
      size="icon"
      onClick={togglePlay}
      aria-label={playing ? "Szünet" : "Lejátszás"}
      aria-keyshortcuts="Space"
      className={cn("shrink-0 rounded-full", compact ? "h-11 w-11" : "h-10 w-10")}
    >
      {playing ? <Pause className="fill-current" /> : <Play className="translate-x-px fill-current" />}
    </Button>
  );

  const clock = (
    <div className="min-w-0 flex-1">
      <p
        className={cn(
          "font-mono font-bold leading-none tracking-tight tabular-nums text-foreground",
          compact ? "text-[26px]" : "text-[32px]",
        )}
      >
        {formatClock(cursor)}
      </p>
      <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{dateLabel}</span>
        <span aria-hidden>·</span>
        {status}
      </p>
    </div>
  );

  const speedControl = (
    <div
      role="group"
      aria-label="Lejátszási sebesség"
      className={cn(
        "grid shrink-0 grid-cols-4 gap-0.5 rounded-lg border border-border bg-background/60 p-0.5",
        compact ? "h-11" : "h-9",
      )}
    >
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => playback.setSpeed(s)}
          aria-pressed={speed === s}
          className={cn(
            "min-w-[38px] rounded-md px-1.5 font-mono text-xs font-semibold tabular-nums transition-colors duration-fast",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            speed === s
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {s}×
        </button>
      ))}
    </div>
  );

  const dayPicker = (
    <TimelineDayPicker
      days={days}
      value={day}
      today={serviceDayOf(nowSec())}
      compact={compact}
      onChange={changeDay}
    />
  );

  const slider = (
    <TimelineSlider
      range={range}
      value={cursor}
      maxValue={bounds.limit}
      valueText={`${formatClockShort(cursor)}, ${dateLabel}`}
      compact={compact}
      onScrub={(t) => seek(t)}
      onScrubStart={playback.scrubStart}
      onScrubEnd={playback.scrubEnd}
    />
  );

  return (
    <div ref={rootRef}>
      {compact ? (
        <>
          <div className="flex items-center gap-2.5">
            {playButton}
            {clock}
            <ExitButton onExit={onExit} compact />
          </div>
          <div className="-mx-1 mt-1.5">{slider}</div>
          <div className="mt-1 flex items-center gap-2">
            {dayPicker}
            {speedControl}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            {playButton}
            {clock}
            {dayPicker}
            {speedControl}
            <ExitButton onExit={onExit} compact={false} />
          </div>
          <div className="mt-2">{slider}</div>
        </>
      )}
    </div>
  );
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A"]);

/**
 * Szóköz = lejátszás/szünet, ←/→ = ±1 perc (Shifttel ±10 perc). Csak akkor
 * él, ha a fókusz a sávon, a térképen vagy sehol sincs — a szűrőpanel saját
 * nyílbillentyűit nem veszi el.
 */
function useKeyboardControls(
  rootRef: RefObject<HTMLElement | null>,
  mapRef: RefObject<L.Map | null>,
  togglePlay: () => void,
  step: (deltaSec: number) => void,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable)) return;
      if (target?.closest("[role='listbox'], [role='dialog']")) return;

      const inBar = Boolean(target && rootRef.current?.contains(target));
      const inMap = Boolean(target && mapRef.current?.getContainer().contains(target));
      const idle = !target || target === document.body || target === document.documentElement;
      if (!inBar && !inMap && !idle) return;

      if (e.key === " " || e.code === "Space") {
        // Fókuszált gombon a szóköz a gombot nyomja meg — azt nem duplázzuk.
        if (target && ACTIVATABLE_TAGS.has(target.tagName)) return;
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        // A térkép ne is mozduljon a nyíltól, amíg az idővonal él.
        e.stopPropagation();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        step(dir * (e.shiftKey ? TEN_MINUTES : MINUTE));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rootRef, mapRef, togglePlay, step]);
}
