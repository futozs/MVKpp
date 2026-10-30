"use client";
/**
 * A hub chartjai — saját SVG, könyvtár nélkül, a főapp szabályaival: vékony
 * jelek (2 px vonal, legfeljebb 18 px oszlop, 3 px kerekítés a végén),
 * hajszálrács, kerek tengelyértékek, a szöveg szövegszínben (a jel hordozza a
 * színt), minden chartnak saját lebegő súgója (érték elöl, felirat utána).
 * Egy sorozatnál nincs jelmagyarázat (a cím nevezi meg), kettőtől mindig van.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function useMeasure<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

/** „Szép” felső határ és osztások: 1, 2, 2.5, 5 × 10^n; darabszámnál (minStep 1) nincs tört osztás. */
export function niceScale(max: number, ticks = 4, minStep = 1): { top: number; step: number } {
  if (!(max > 0)) return { top: Math.max(1, minStep), step: Math.max(1, minStep) / (minStep ? 1 : 4) };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  return { top: Math.ceil(max / step) * step, step };
}

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"] as const;
export const SINGLE = "hsl(var(--sg-400))";

type Pt = [number, number | null];
export type Series = { id: string; label: string; color?: string; points: Pt[] };

function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), Math.max(70, width - 70));
  return (
    <div className="pointer-events-none absolute top-0 z-overlay -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-lg" style={{ left }}>
      {children}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {series.map((s, i) => (
        <span key={s.id} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color ?? SERIES[i % SERIES.length] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Idősor 1–3 vonallal, szálkereszttel és súgóval. */
export function TimeChart({
  series,
  height = 180,
  yFormat = (v) => String(Math.round(v)),
  xFormat,
  area = true,
  className,
}: {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat: (t: number) => string;
  area?: boolean;
  className?: string;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b), [series]);
  const maxV = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p[1] ?? 0)));
  const { top, step } = niceScale(maxV);
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const x0 = xs[0] ?? 0;
  const x1 = xs[xs.length - 1] ?? 1;
  const sx = (t: number) => pad.l + (x1 === x0 ? w / 2 : ((t - x0) / (x1 - x0)) * w);
  const sy = (v: number) => pad.t + h - (v / top) * h;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const xTicks = xs.length <= 1 ? xs : [0, 0.25, 0.5, 0.75, 1].map((f) => xs[Math.round(f * (xs.length - 1))]);

  const path = (pts: Pt[]) => {
    let d = "";
    let pen = false;
    for (const [t, v] of pts) {
      if (v == null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${sx(t).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(sx(xs[i]) - px) < Math.abs(sx(xs[best]) - px)) best = i;
    setHover(xs.length ? best : null);
  };

  const ht = hover != null ? xs[hover] : null;
  return (
    <div className={cn("relative", className)} ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} className="block touch-none select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(", ")}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={sy(v)} y2={sy(v)} stroke="hsl(var(--border))" strokeWidth={1} />
              <text x={pad.l - 6} y={sy(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
                {yFormat(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={`${t}-${i}`} x={sx(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} className="fill-muted-foreground font-mono text-[10px]">
              {xFormat(t)}
            </text>
          ))}
          {series.map((s, i) => {
            const color = s.color ?? SERIES[i % SERIES.length];
            const d = path(s.points);
            const valid = s.points.filter((p) => p[1] != null);
            const fill = area && series.length === 1 && valid.length > 1 ? `${d}L${sx(valid[valid.length - 1][0]).toFixed(1)},${sy(0)}L${sx(valid[0][0]).toFixed(1)},${sy(0)}Z` : null;
            return (
              <g key={s.id}>
                {fill ? <path d={fill} fill={color} opacity={0.12} /> : null}
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {ht != null ? (
            <g>
              <line x1={sx(ht)} x2={sx(ht)} y1={pad.t} y2={pad.t + h} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} strokeDasharray="3 3" />
              {series.map((s, i) => {
                const v = s.points.find((p) => p[0] === ht)?.[1];
                return v == null ? null : <circle key={s.id} cx={sx(ht)} cy={sy(v)} r={4} fill={s.color ?? SERIES[i % SERIES.length]} stroke="hsl(var(--card))" strokeWidth={2} />;
              })}
            </g>
          ) : null}
        </svg>
      )}
      {ht != null ? (
        <Tip x={sx(ht)} width={width}>
          <div className="mb-0.5 font-mono text-muted-foreground">{xFormat(ht)}</div>
          {series.map((s, i) => {
            const v = s.points.find((p) => p[0] === ht)?.[1];
            return (
              <div key={s.id} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color ?? SERIES[i % SERIES.length] }} />
                <span className="font-mono font-semibold">{v == null ? "–" : yFormat(v)}</span>
                <span className="text-muted-foreground">{s.label}</span>
              </div>
            );
          })}
        </Tip>
      ) : null}
      <Legend series={series} />
    </div>
  );
}

/** Oszlopok kategóriánként (pl. napok), súgóval. */
export function Bars({ data, height = 150, yFormat = (v) => String(Math.round(v)), color = SINGLE, className }: { data: { key: string; label: string; value: number; tone?: string }[]; height?: number; yFormat?: (v: number) => string; color?: string; className?: string }) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 4, t: 8, b: 20 };
  const { top, step } = niceScale(Math.max(0, ...data.map((d) => d.value)));
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const slot = data.length ? w / data.length : 0;
  const bw = Math.max(2, Math.min(18, slot - 2));
  const sy = (v: number) => pad.t + h - (v / top) * h;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(w / 52))));
  return (
    <div className={cn("relative", className)} ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} className="block select-none" onPointerLeave={() => setHover(null)} role="img">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={sy(v)} y2={sy(v)} stroke="hsl(var(--border))" />
              <text x={pad.l - 6} y={sy(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
                {yFormat(v)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + i * slot + (slot - bw) / 2;
            const y = sy(d.value);
            const bh = Math.max(d.value > 0 ? 1 : 0, pad.t + h - y);
            const r = Math.min(3, bw / 2, bh);
            return (
              <g key={d.key} onPointerEnter={() => setHover(i)}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={h} fill="transparent" />
                <path
                  d={`M${x},${pad.t + h}V${pad.t + h - bh + r}Q${x},${pad.t + h - bh} ${x + r},${pad.t + h - bh}H${x + bw - r}Q${x + bw},${pad.t + h - bh} ${x + bw},${pad.t + h - bh + r}V${pad.t + h}Z`}
                  fill={d.tone ?? color}
                  opacity={hover == null || hover === i ? 1 : 0.55}
                />
                {i % every === 0 ? (
                  <text x={x + bw / 2} y={height - 5} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">
                    {d.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
      {hover != null && data[hover] ? (
        <Tip x={pad.l + hover * slot + slot / 2} width={width}>
          <span className="font-mono font-semibold">{yFormat(data[hover].value)}</span> <span className="text-muted-foreground">{data[hover].label}</span>
        </Tip>
      ) : null}
    </div>
  );
}

/** Rangsor vízszintes sávokkal: a felirat és az érték szövegszínben, a sáv a nagyságot mutatja. */
export function RankList({ items, format = (v) => String(v), empty = "Nincs adat.", max: maxRows = 12 }: { items: { key: string; label: ReactNode; value: number; swatch?: ReactNode }[]; format?: (v: number) => string; empty?: string; max?: number }) {
  if (!items.length) return <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>;
  const top = Math.max(...items.map((i) => i.value), 1);
  return (
    <ol className="space-y-1.5">
      {items.slice(0, maxRows).map((it) => (
        <li key={it.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
            {it.swatch}
            <span className="truncate">{it.label}</span>
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{format(it.value)}</span>
          <span className="col-span-2 h-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full" style={{ width: `${(it.value / top) * 100}%`, background: SINGLE }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Kis vonal a kártyákba (tengely nélkül). Az utolsó érték pöttyel. */
export function Sparkline({ values, height = 32, color = SINGLE, className, label }: { values: (number | null)[]; height?: number; color?: string; className?: string; label?: string }) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const vals = values.map((v) => (v == null || !Number.isFinite(v) ? null : v));
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  const n = vals.length;
  const sx = (i: number) => (n <= 1 ? width / 2 : 2 + (i / (n - 1)) * (width - 4));
  const sy = (v: number) => 2 + (height - 4) - (v / max) * (height - 4);
  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
    pen = true;
  });
  const lastIdx = vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
  return (
    <div ref={ref} className={cn("w-full", className)} aria-label={label} role={label ? "img" : undefined}>
      {width > 0 && n > 0 ? (
        <svg width={width} height={height} className="block overflow-visible">
          <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          {lastIdx != null ? <circle cx={sx(lastIdx)} cy={sy(vals[lastIdx]!)} r={2.5} fill={color} /> : null}
        </svg>
      ) : null}
    </div>
  );
}

/** Egy 100%-os sáv állapotszínekkel (pl. push-kézbesítések), jelmagyarázattal. */
export function StatusBar({ parts }: { parts: { key: string; label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className="text-xs text-muted-foreground">Nincs adat.</p>;
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.key} title={`${p.value} ${p.label}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
          ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: p.color }} />
            <span className="font-mono font-semibold text-foreground">{p.value}</span> {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}
