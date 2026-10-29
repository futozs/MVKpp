import { useMemo, useRef, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { hourTicks, type ServiceDayRange } from "./historyTime";

/** Minden harmadik óra felirata keskeny sávon is kifér. */
const MAJOR_EVERY = 3;

interface TimelineSliderProps {
  range: ServiceDayRange;
  value: number;
  /** A ma még el nem jött rész nem húzható (a mai napon). */
  maxValue: number;
  valueText: string;
  compact: boolean;
  onScrub: (t: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function TimelineSlider({
  range,
  value,
  maxValue,
  valueText,
  compact,
  onScrub,
  onScrubStart,
  onScrubEnd,
}: TimelineSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const span = range.end - range.start;
  const ticks = useMemo(() => hourTicks(range), [range]);

  const pct = clamp01((value - range.start) / span);
  const availablePct = clamp01((maxValue - range.start) / span);

  const timeAt = (clientX: number): number => {
    const rect = rectRef.current;
    if (!rect || rect.width === 0) return value;
    const f = clamp01((clientX - rect.left) / rect.width);
    return Math.min(maxValue, Math.round(range.start + f * span));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = trackRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    // Húzás közben egyszer mérünk, nem minden mozdulatnál.
    rectRef.current = el.getBoundingClientRect();
    onScrubStart();
    onScrub(timeAt(e.clientX));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!trackRef.current?.hasPointerCapture(e.pointerId)) return;
    onScrub(timeAt(e.clientX));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!rectRef.current) return;
    if (trackRef.current?.hasPointerCapture(e.pointerId)) {
      trackRef.current.releasePointerCapture(e.pointerId);
    }
    rectRef.current = null;
    onScrubEnd();
  };

  return (
    // A teljes szélességű, eltolt fogantyú-réteg ne lógjon ki a sávból.
    <div className="overflow-hidden px-4">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Időpont a forgalmi napon"
        aria-valuemin={range.start}
        aria-valuemax={range.end}
        aria-valuenow={Math.round(value)}
        aria-valuetext={valueText}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="group relative h-12 cursor-pointer touch-none select-none focus-visible:outline-none"
      >
        <div className="absolute inset-x-0 top-[13px] h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full w-full origin-left bg-primary/75"
            style={{ transform: `scaleX(${pct})` }}
          />
          {availablePct < 1 ? (
            <div
              className="absolute inset-y-0 right-0 bg-background/70"
              style={{ width: `${(1 - availablePct) * 100}%` }}
            />
          ) : null}
        </div>

        {ticks.map((tick, i) => {
          const left = `${((tick.t - range.start) / span) * 100}%`;
          const major = i % MAJOR_EVERY === 0;
          return (
            <span key={tick.t} aria-hidden>
              <span
                className={cn(
                  "absolute top-[23px] w-px -translate-x-1/2",
                  major ? "h-2 bg-muted-foreground/60" : "h-1.5 bg-border",
                )}
                style={{ left }}
              />
              {major || !compact ? (
                <span
                  className={cn(
                    "absolute top-[32px] -translate-x-1/2 font-mono text-[10px] leading-none tabular-nums",
                    major ? "text-muted-foreground" : "text-muted-foreground/60",
                  )}
                  style={{ left }}
                >
                  {tick.label}
                </span>
              ) : null}
            </span>
          );
        })}

        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-full"
          style={{ transform: `translateX(${pct * 100}%)` }}
        >
          <span
            className={cn(
              "absolute left-0 top-4 block h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full",
              "border-2 border-card bg-primary shadow-md transition-shadow duration-fast",
              "group-hover:ring-4 group-hover:ring-primary/20 group-focus-visible:ring-4 group-focus-visible:ring-ring/50",
              "group-active:ring-4 group-active:ring-primary/30",
            )}
          />
        </div>
      </div>
    </div>
  );
}
