import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Breakdown, DayBucket } from "@mvk/core";
import { useMeasure } from "@/components/charts/Charts";
import { formatClockShort, hourTicks, type ServiceDayRange } from "@/components/map/historyTime";

/** két sáv: fent a villamos, lent a busz, mindkettő a saját léptékében (a sok busz ne nyomja el a villamost) */
const LANE = 40;
const GAP = 8;
const TOP = 4;
const H = TOP + LANE + GAP + LANE + 18;
/** minden harmadik óra felirata */
const LABEL_EVERY = 3;

/**
 * A nap késésgörbéje: hány villamos (piros terület) és hány busz (vonal)
 * késett legalább 5 percet. Fölötte sávban az összeomlások. Rajta húzható az
 * időpont, amelynek az állapotát lent a rangsor mutatja.
 */
export function DayCurve({
  range,
  buckets,
  breakdowns,
  value,
  maxValue,
  onScrub,
}: {
  range: ServiceDayRange;
  buckets: DayBucket[];
  breakdowns: Breakdown[];
  value: number;
  maxValue: number;
  onScrub: (t: number) => void;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const rectRef = useRef<DOMRect | null>(null);
  const w = Math.max(width, 260);
  const span = range.end - range.start;
  const x = (t: number) => ((t - range.start) / span) * w;
  const tramTop = TOP;
  const busTop = TOP + LANE + GAP;
  const base = busTop + LANE;
  const tramMax = Math.max(3, ...buckets.map((b) => b.tramLate));
  const busMax = Math.max(5, ...buckets.map((b) => b.busLate));
  const area = (laneTop: number, max: number, val: (b: DayBucket) => number) => {
    if (!buckets.length) return "";
    const yy = (n: number) => laneTop + LANE * (1 - n / max);
    const bottom = laneTop + LANE;
    return `M${x(buckets[0].t)},${bottom} ${buckets.map((b) => `L${x(b.t)},${yy(val(b))}`).join(" ")} L${x(buckets[buckets.length - 1].t)},${bottom} Z`;
  };
  const ticks = hourTicks(range).filter((_, i) => i % LABEL_EVERY === 0);

  const timeAt = (clientX: number) => {
    const rect = rectRef.current;
    if (!rect || rect.width === 0) return value;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(maxValue, Math.round(range.start + f * span));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    rectRef.current = e.currentTarget.getBoundingClientRect();
    onScrub(timeAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(timeAt(e.clientX));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 * 60 : 60;
    if (e.key === "ArrowLeft") onScrub(Math.max(range.start, value - step));
    else if (e.key === "ArrowRight") onScrub(Math.min(maxValue, value + step));
    else return;
    e.preventDefault();
  };

  return (
    <div ref={ref} className="w-full">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Időpont a napon"
        aria-valuemin={range.start}
        aria-valuemax={maxValue}
        aria-valuenow={value}
        aria-valuetext={formatClockShort(value)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (rectRef.current = null)}
        onKeyDown={onKey}
        className="relative cursor-ew-resize touch-none rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg width={w} height={H} className="block" aria-hidden>
          {/* a még el nem jött rész */}
          {maxValue < range.end ? <rect x={x(maxValue)} y={0} width={w - x(maxValue)} height={base} className="fill-muted/40" /> : null}
          {/* az összeomlások: a sáv háttere színeződik */}
          {breakdowns.map((b) => (
            <rect
              key={`${b.kind}-${b.start}`}
              x={x(b.start)}
              y={b.kind === "tram" ? tramTop : busTop}
              width={Math.max(3, x(b.end) - x(b.start))}
              height={LANE}
              className={b.kind === "tram" ? "fill-late/15" : "fill-nosignal/15"}
            />
          ))}
          {ticks.map((tk) => (
            <g key={tk.t}>
              <line x1={x(tk.t)} x2={x(tk.t)} y1={TOP} y2={base} className="stroke-border/50" />
              <text x={x(tk.t) + 3} y={H - 5} className="fill-muted-foreground text-[10px] tabular-nums">
                {tk.label}
              </text>
            </g>
          ))}
          <line x1={0} x2={w} y1={tramTop + LANE} y2={tramTop + LANE} className="stroke-border" />
          <line x1={0} x2={w} y1={base} y2={base} className="stroke-border" />
          <path d={area(tramTop, tramMax, (b) => b.tramLate)} className="fill-late/70" />
          <path d={area(busTop, busMax, (b) => b.busLate)} className="fill-foreground/35" />
          <text x={4} y={tramTop + 11} className="fill-muted-foreground text-[10px] font-semibold">Villamos</text>
          <text x={4} y={busTop + 11} className="fill-muted-foreground text-[10px] font-semibold">Busz</text>
          <line x1={x(value)} x2={x(value)} y1={0} y2={base} className="stroke-primary" strokeWidth={2} />
          <circle cx={x(value)} cy={base} r={4.5} className="fill-primary stroke-card" strokeWidth={2} />
        </svg>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        A sávok magassága: hány jármű késett legalább 5 percet. Színezett háttér: összeomlás. Húzd vagy koppints az időpontra.
      </p>
    </div>
  );
}
