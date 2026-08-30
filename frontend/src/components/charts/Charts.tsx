import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function ChartFrame({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-card p-4 sm:p-5",
        className,
      )}
    >
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {hint ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function EmptyChart({
  children = "Ehhez még nincs elég mérés.",
}: {
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "late" | "early" | "ontime" | "live";
}) {
  const toneClass = {
    default: "text-foreground",
    late: "text-late",
    early: "text-early",
    ontime: "text-ontime",
    live: "text-live",
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-lg font-bold tabular-nums tracking-tight [overflow-wrap:anywhere] sm:text-2xl",
          toneClass,
        )}
      >
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      ) : null}
    </div>
  );
}

export type BarDatum = {
  label: string;
  value: number | null;
  tone?: string;
  title?: string;
};

export function BarChart({
  data,
  height = 160,
  unit = "",
  maxValue,
  labelEvery = 1,
}: {
  data: BarDatum[];
  height?: number;
  unit?: string;
  maxValue?: number;
  labelEvery?: number;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  if (!data.length) return <EmptyChart />;

  const padL = 30;
  const padB = 20;
  const padT = 8;
  const w = Math.max(width, 240);
  const innerW = w - padL - 4;
  const innerH = height - padB - padT;
  const max = maxValue ?? Math.max(1, ...data.map((d) => d.value ?? 0));
  const step = innerW / data.length;
  const barW = Math.max(2, Math.min(28, step * 0.62));
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));

  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={height} role="img" className="overflow-visible">
        {ticks.map((t) => {
          const y = padT + innerH - (t / max) * innerH;
          return (
            <g key={t}>
              <line
                x1={padL}
                x2={w - 4}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[9px] tabular-nums"
              >
                {t}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const v = d.value ?? 0;
          const h =
            d.value == null ? 0 : Math.max(v > 0 ? 2 : 0, (v / max) * innerH);
          const x = padL + i * step + (step - barW) / 2;
          return (
            <g key={`${d.label}-${i}`}>
              <rect
                x={x}
                y={padT + innerH - h}
                width={barW}
                height={h}
                rx={2}
                className={cn(
                  "transition-opacity hover:opacity-80",
                  d.tone ?? "fill-primary",
                )}
              >
                <title>
                  {d.title ?? `${d.label}: ${d.value ?? "—"}${unit}`}
                </title>
              </rect>
              {i % labelEvery === 0 ? (
                <text
                  x={x + barW / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[9px] tabular-nums"
                >
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function LineChart({
  data,
  height = 170,
  unit = "",
  zeroLine = false,
}: {
  data: { label: string; value: number | null }[];
  height?: number;
  unit?: string;
  zeroLine?: boolean;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const points = data.filter((d) => d.value != null);
  if (points.length < 2)
    return <EmptyChart>Legalább két nap adata kell a trendhez.</EmptyChart>;

  const padL = 34;
  const padB = 20;
  const padT = 10;
  const w = Math.max(width, 240);
  const innerW = w - padL - 8;
  const innerH = height - padB - padT;

  const vals = points.map((d) => d.value as number);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (zeroLine) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const x = (i: number) => padL + (i / (data.length - 1 || 1)) * innerW;
  const y = (v: number) => padT + innerH - ((v - min) / (max - min)) * innerH;

  const path = data
    .map((d, i) =>
      d.value == null ? null : `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`,
    )
    .filter(Boolean)
    .join(" ");
  const area = `${path} L${x(data.length - 1)},${padT + innerH} L${x(0)},${padT + innerH} Z`;
  const last = data[data.length - 1];

  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={height} role="img" className="overflow-visible">
        <defs>
          <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              className="text-primary"
              stopColor="currentColor"
              stopOpacity="0.28"
            />
            <stop
              offset="100%"
              className="text-primary"
              stopColor="currentColor"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>
        {[min, (min + max) / 2, max].map((t, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={w - 8}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={padL - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px] tabular-nums"
            >
              {Math.round(t)}
            </text>
          </g>
        ))}
        {zeroLine && min < 0 && max > 0 ? (
          <line
            x1={padL}
            x2={w - 8}
            y1={y(0)}
            y2={y(0)}
            className="stroke-muted-foreground/50"
            strokeWidth={1}
          />
        ) : null}
        <path d={area} fill="url(#lineFill)" />
        <path
          d={path}
          fill="none"
          className="stroke-primary"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {data.map((d, i) =>
          d.value == null ? null : (
            <circle
              key={i}
              cx={x(i)}
              cy={y(d.value)}
              r={2.5}
              className="fill-primary"
            >
              <title>{`${d.label}: ${d.value}${unit}`}</title>
            </circle>
          ),
        )}
        {last?.value != null ? (
          <circle
            cx={x(data.length - 1)}
            cy={y(last.value)}
            r={4}
            className="fill-primary stroke-card"
            strokeWidth={2}
          />
        ) : null}
        <text
          x={padL}
          y={height - 5}
          className="fill-muted-foreground text-[9px]"
        >
          {data[0]?.label}
        </text>
        <text
          x={w - 8}
          y={height - 5}
          textAnchor="end"
          className="fill-muted-foreground text-[9px]"
        >
          {last?.label}
        </text>
      </svg>
    </div>
  );
}

export function DelayHistogram({
  buckets,
  height = 150,
}: {
  buckets: { min: number; n: number }[];
  height?: number;
}) {
  if (!buckets.some((b) => b.n > 0)) return <EmptyChart />;
  return (
    <BarChart
      height={height}
      data={buckets.map((b) => ({
        label: b.min === 0 ? "0" : `${b.min > 0 ? "+" : ""}${b.min}`,
        value: b.n,
        tone:
          b.min < -1 ? "fill-early" : b.min > 5 ? "fill-late" : "fill-ontime",
        title: `${b.min > 0 ? "+" : ""}${b.min}…${b.min + 1} perc: ${b.n} érkezés`,
      }))}
      labelEvery={2}
    />
  );
}

export function Donut({
  slices,
  size = 148,
  centerLabel,
  centerSub,
}: {
  slices: { label: string; value: number; color?: string | null }[];
  size?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (!total) return <EmptyChart />;

  const r = size / 2 - 10;
  const stroke = 18;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg
        width={size}
        height={size}
        role="img"
        className="shrink-0 -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="fill-none stroke-muted"
          strokeWidth={stroke}
        />
        {slices.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color ? `#${s.color}` : "hsl(var(--primary))"}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
            >
              <title>{`${s.label}: ${Math.round((s.value / total) * 100)}%`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        {centerLabel ? (
          <text
            x={size / 2}
            y={size / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            className="rotate-90 fill-foreground text-lg font-bold tabular-nums"
            style={{ transformOrigin: "center" }}
          >
            {centerLabel}
          </text>
        ) : null}
      </svg>

      <ul className="min-w-0 flex-1 space-y-1.5">
        {slices.slice(0, 6).map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{
                background: s.color ? `#${s.color}` : "hsl(var(--primary))",
              }}
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {s.label}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.round((s.value / total) * 100)}%
            </span>
          </li>
        ))}
        {centerSub ? (
          <li className="pt-1 text-[11px] text-muted-foreground">
            {centerSub}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function HourHeat({
  cells,
  legend,
}: {
  cells: { hour: number; value: number | null; title: string }[];
  legend?: string;
}) {
  const withData = cells.filter((c) => c.value != null);
  if (!withData.length) return <EmptyChart />;
  const max = Math.max(...withData.map((c) => c.value as number));
  const min = Math.min(...withData.map((c) => c.value as number));

  return (
    <div>
      <div className="grid grid-cols-12 gap-1 sm:grid-cols-[repeat(24,minmax(0,1fr))]">
        {cells.map((c) => {
          const t =
            c.value == null || max === min
              ? 0
              : ((c.value as number) - min) / (max - min);
          return (
            <div
              key={c.hour}
              title={c.title}
              className={cn(
                "flex aspect-square items-center justify-center rounded text-[9px] font-semibold tabular-nums",
                c.value == null &&
                  "border border-dashed border-border/60 text-muted-foreground/50",
              )}
              style={
                c.value == null
                  ? undefined
                  : {
                      background: `hsl(var(--primary) / ${0.15 + t * 0.75})`,
                      color:
                        t > 0.55
                          ? "hsl(var(--primary-foreground))"
                          : "hsl(var(--foreground))",
                    }
              }
            >
              {c.hour % 24}
            </div>
          );
        })}
      </div>
      {legend ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{legend}</p>
      ) : null}
    </div>
  );
}

export function RankBars({
  rows,
  unit = "",
}: {
  rows: { label: string; sub?: string; value: number; display?: string }[];
  unit?: string;
}) {
  if (!rows.length) return <EmptyChart />;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1"
        >
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{r.label}</p>
            {r.sub ? (
              <p className="truncate text-[11px] text-muted-foreground">
                {r.sub}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-late">
            {r.display ?? `${r.value}${unit}`}
          </span>
          <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-late"
              style={{ width: `${(Math.abs(r.value) / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
