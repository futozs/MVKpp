import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useMeasure } from "@/components/charts/Charts";
import { formatClockShort, hourTicks, type ServiceDayRange } from "@/components/map/historyTime";

/** egy sáv a görbén: a saját léptékében, hogy a sok busz ne nyomja el a villamost (vagy egy vonalat) */
export type CurveLane = {
  key: string;
  label: string;
  /** a lépésenkénti késő járművek */
  late: number[];
  /** halványan alatta: hány jármű volt úton (vonalszűrésnél) */
  running?: number[];
  /** a késők színe */
  fill: string;
  /** színezett háttér: összeomlás */
  bands?: { start: number; end: number }[];
  bandFill?: string;
};

const LANE = 38;
const GAP = 8;
const TOP = 4;
const AXIS = 18;
/** minden harmadik óra felirata */
const LABEL_EVERY = 3;

/**
 * A nap késésgörbéje sávonként, lépésenként (`from`, `step`). Rajta húzható
 * az időpont, amelynek az állapotát az oldal többi része mutatja.
 */
export function DayCurve({
  range,
  from,
  step,
  lanes,
  value,
  maxValue,
  onScrub,
  legend,
}: {
  range: ServiceDayRange;
  from: number;
  step: number;
  lanes: CurveLane[];
  value: number;
  maxValue: number;
  onScrub: (t: number) => void;
  legend: string;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const rectRef = useRef<DOMRect | null>(null);
  const w = Math.max(width, 260);
  const span = range.end - range.start;
  const x = (t: number) => ((t - range.start) / span) * w;
  const top = (i: number) => TOP + i * (LANE + GAP);
  const base = top(lanes.length) - GAP;
  const H = base + AXIS;
  const area = (laneTop: number, max: number, values: number[]) => {
    if (!values.length) return "";
    const yy = (n: number) => laneTop + LANE * (1 - n / max);
    const bottom = laneTop + LANE;
    const tx = (i: number) => x(from + i * step);
    return `M${tx(0)},${bottom} ${values.map((v, i) => `L${tx(i)},${yy(v)}`).join(" ")} L${tx(values.length - 1)},${bottom} Z`;
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
    const by = e.shiftKey ? 15 * 60 : 60;
    if (e.key === "ArrowLeft") onScrub(Math.max(range.start, value - by));
    else if (e.key === "ArrowRight") onScrub(Math.min(maxValue, value + by));
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
          {lanes.map((l, i) =>
            (l.bands ?? []).map((b) => <rect key={`${l.key}-${b.start}`} x={x(b.start)} y={top(i)} width={Math.max(3, x(b.end) - x(b.start))} height={LANE} className={l.bandFill} />),
          )}
          {ticks.map((tk) => (
            <g key={tk.t}>
              <line x1={x(tk.t)} x2={x(tk.t)} y1={TOP} y2={base} className="stroke-border/50" />
              <text x={x(tk.t) + 3} y={H - 5} className="fill-muted-foreground text-[10px] tabular-nums">
                {tk.label}
              </text>
            </g>
          ))}
          {lanes.map((l, i) => {
            const max = Math.max(3, ...(l.running ?? l.late));
            return (
              <g key={l.key}>
                <line x1={0} x2={w} y1={top(i) + LANE} y2={top(i) + LANE} className="stroke-border" />
                {l.running ? <path d={area(top(i), max, l.running)} className="fill-foreground/15" /> : null}
                <path d={area(top(i), max, l.late)} className={l.fill} />
                <text x={4} y={top(i) + 11} className="fill-muted-foreground text-[10px] font-semibold">
                  {l.label}
                </text>
              </g>
            );
          })}
          <line x1={x(value)} x2={x(value)} y1={0} y2={base} className="stroke-primary" strokeWidth={2} />
          <circle cx={x(value)} cy={base} r={4.5} className="fill-primary stroke-card" strokeWidth={2} />
        </svg>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{legend}</p>
    </div>
  );
}
