/**
 * Az app közös chartjai (saját SVG, könyvtár nélkül).
 *
 * Szabályok: vékony jelek (oszlop legfeljebb 24 px, felül 4 px-es kerekítés,
 * a tövénél szögletes; vonal 2 px), tömör hajszálrács, kerek tengelyértékek,
 * a szövegek szövegszínben (a jel hordozza a színt), és minden chartnak van
 * saját lebegő súgója  érték elöl, felirat utána. A súgó kiegészít, nem
 * kapuőr: a lényeg a tengelyről és a feliratokból is leolvasható.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatServiceHour } from "@/services/statsApi";

/**
 * A diagram szélessége. Visszahívó ref: ha a diagram üres állapotban jelenik meg
 * először (nincs még elem), az adat megérkezésekor is felcsatol a figyelő, és a
 * diagram nem ragad 240 px-en.
 */
export function useMeasure<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
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
    <section className={cn("rounded-2xl border border-border bg-card p-4 sm:p-5", className)}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {hint ? <p className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function EmptyChart({ children = "Ehhez még nincs elég mérés." }: { children?: ReactNode }) {
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
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{label}</p>
      {/* Nagy önálló számnál arányos számjegyek (a tabuláris „121” lazán áll). */}
      <p className={cn("mt-1.5 text-xl font-bold leading-none tracking-tight [overflow-wrap:anywhere] sm:text-[26px]", toneClass)}>{value}</p>
      {sub ? <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/* ── közös segédek ───────────────────────────────────────────────────────── */

const COMPACT = new Intl.NumberFormat("hu-HU", { notation: "compact", maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });

/** tengelyérték: 1000 fölött tömören (1,2 E), alatta egészre kerekítve */
function tick(v: number): string {
  return Math.abs(v) >= 1000 ? COMPACT.format(v) : PLAIN.format(Math.round(v * 10) / 10);
}

/** a legközelebbi „kerek” felső határ (1, 2, 2,5, 5 × 10^n) */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** kerek lépésköz (1, 2, 5 × 10^n) */
function niceStep(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** oszlop: az adat-végén 4 px-es kerekítés, a nullvonalnál szögletes (lefelé is) */
function columnPath(x: number, y: number, w: number, h: number, down = false): string {
  const r = Math.min(4, w / 2, h);
  if (down) return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** „late” → „fill-late”; a teljes osztálynevet változatlanul hagyja */
const fillOf = (tone: string | undefined) => (!tone ? "fill-primary" : tone.startsWith("fill-") ? tone : `fill-${tone}`);

/** Lebegő súgó a chart fölött: érték erősen, felirat halványan; a széleken belül marad. */
function Tip({ x, y, width, value, label }: { x: number; y: number; width: number; value: ReactNode; label?: ReactNode }) {
  const left = Math.min(Math.max(x, 70), Math.max(70, width - 70));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[12px] shadow-lg"
      style={{ left, top: Math.max(0, y - 8) }}
    >
      <span className="block font-semibold tabular-nums text-foreground">{value}</span>
      {label ? <span className="block text-[11px] text-muted-foreground">{label}</span> : null}
    </div>
  );
}

/* ── oszlopdiagram ──────────────────────────────────────────────────────── */

export type BarDatum = {
  label: string;
  value: number | null;
  /** jelentést hordozó szín: "late" / "early" / "ontime" vagy egy fill-osztály */
  tone?: string;
  /** teljes súgószöveg (ha megadják, ez jelenik meg) */
  title?: string;
};

export function BarChart({
  data,
  height = 176,
  unit = "",
  maxValue,
  labelEvery,
}: {
  data: BarDatum[];
  height?: number;
  unit?: string;
  maxValue?: number;
  /** minden hányadik felirat látsszon (alapból a szélességhez igazodik) */
  labelEvery?: number;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <EmptyChart />;

  const padL = 36;
  const padR = 6;
  const padT = 12;
  const padB = 24;
  const w = Math.max(width, 240);
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const max = niceCeil(maxValue ?? Math.max(0, ...data.map((d) => d.value ?? 0)));
  // Negatív érték (pl. sietés) a nullvonal alá kerül.
  const minRaw = Math.min(0, ...data.map((d) => d.value ?? 0));
  const min = minRaw < 0 ? -niceCeil(-minRaw) : 0;
  const step = innerW / data.length;
  const barW = Math.max(2, Math.min(24, step - 2));
  // Feliratok legalább ~34 px-enként, hogy ne torlódjanak.
  const every = Math.max(labelEvery ?? 1, Math.ceil(34 / step));
  const yOf = (v: number) => padT + innerH - ((v - min) / (max - min)) * innerH;
  const base = yOf(0);
  const hOf = (v: number | null) => (v == null || v === 0 ? 0 : Math.max(3, (Math.abs(v) / (max - min)) * innerH));
  const tipY = (v: number | null) => (v != null && v < 0 ? base : base - hOf(v));
  const ticks = min < 0 ? [min, 0, max] : [0, max / 2, max];
  const h = hover != null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full" onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={`Oszlopdiagram, ${data.length} érték`} className="block">
        {ticks.map((t) => {
          const y = yOf(t);
          return (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y} y2={y} className={t === 0 ? "stroke-muted-foreground/50" : "stroke-border/50"} strokeWidth={1} />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {tick(t)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const bh = hOf(d.value);
          const x = padL + i * step + (step - barW) / 2;
          return (
            <g key={`${d.label}-${i}`}>
              {bh > 0 ? (
                <path
                  d={(d.value ?? 0) < 0 ? columnPath(x, base, barW, bh, true) : columnPath(x, base - bh, barW, bh)}
                  className={cn("transition-opacity duration-fast", fillOf(d.tone), hover != null && hover !== i && "opacity-40")}
                />
              ) : null}
              {i % every === 0 ? (
                <text x={padL + i * step + step / 2} y={height - 7} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">
                  {d.label}
                </text>
              ) : null}
              {/* A célpont a teljes sáv, nem csak a festett oszlop. */}
              <rect x={padL + i * step} y={padT} width={step} height={innerH} fill="transparent" onPointerEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {h && hover != null ? (
        <Tip
          x={padL + hover * step + step / 2}
          y={tipY(h.value)}
          width={w}
          value={h.title ?? (h.value == null ? "nincs adat" : `${PLAIN.format(h.value)}${unit}`)}
          label={h.title ? undefined : h.label}
        />
      ) : null}
    </div>
  );
}

/* ── vonaldiagram ───────────────────────────────────────────────────────── */

export function LineChart({
  data,
  height = 180,
  unit = "",
  zeroLine = false,
}: {
  data: { label: string; value: number | null }[];
  height?: number;
  unit?: string;
  zeroLine?: boolean;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const points = data.filter((d) => d.value != null);
  if (points.length < 2) return <EmptyChart>Legalább két nap adata kell a trendhez.</EmptyChart>;

  const padL = 38;
  const padR = 34;
  const padT = 14;
  const padB = 24;
  const w = Math.max(width, 240);
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;

  const vals = points.map((d) => d.value as number);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (zeroLine) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  // Kerek tengelyhatárok: kerek lépésköz, a határok annak többszörösei (2–4 sáv).
  const stepV = niceStep((hi - lo || Math.abs(hi) || 1) / 3);
  lo = Math.floor(lo / stepV) * stepV;
  hi = Math.ceil(hi / stepV) * stepV;
  if (hi === lo) hi = lo + stepV;
  const x = (i: number) => padL + (i / (data.length - 1 || 1)) * innerW;
  const y = (v: number) => padT + innerH - ((v - lo) / (hi - lo)) * innerH;

  const segs: string[] = [];
  data.forEach((d, i) => {
    if (d.value == null) return;
    const prevNull = i === 0 || data[i - 1].value == null;
    segs.push(`${prevNull ? "M" : "L"}${x(i)},${y(d.value)}`);
  });
  const path = segs.join(" ");
  const firstI = data.findIndex((d) => d.value != null);
  let lastI = data.length - 1;
  while (lastI > 0 && data[lastI].value == null) lastI--;
  const baseY = zeroLine && lo < 0 && hi > 0 ? y(0) : padT + innerH;
  const area = `${path} L${x(lastI)},${baseY} L${x(firstI)},${baseY} Z`;
  const last = data[lastI];
  const ticks: number[] = [];
  for (let t = lo; t <= hi + stepV / 1000; t += stepV) ticks.push(Math.round(t * 1000) / 1000);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let i = Math.round(((px - padL) / innerW) * (data.length - 1));
    i = Math.max(0, Math.min(data.length - 1, i));
    setHover(data[i].value == null ? null : i);
  };
  const hv = hover != null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full" onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={`Vonaldiagram, ${points.length} pont`} className="block" onPointerMove={onMove}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} className="stroke-border/50" strokeWidth={1} />
            <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
              {tick(t)}
            </text>
          </g>
        ))}
        {zeroLine && lo < 0 && hi > 0 ? <line x1={padL} x2={w - padR} y1={y(0)} y2={y(0)} className="stroke-muted-foreground/60" strokeWidth={1} /> : null}
        <path d={area} className="fill-primary/10" />
        <path d={path} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hv?.value != null && hover != null ? (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} className="stroke-muted-foreground/50" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(hv.value)} r={4.5} className="fill-primary stroke-card" strokeWidth={2} />
          </>
        ) : null}
        {last?.value != null ? (
          <>
            <circle cx={x(lastI)} cy={y(last.value)} r={4} className="fill-primary stroke-card" strokeWidth={2} />
            <text x={x(lastI) + 7} y={y(last.value) + 3.5} className="fill-foreground text-[10.5px] font-semibold tabular-nums">
              {tick(last.value)}
            </text>
          </>
        ) : null}
        <text x={padL} y={height - 7} className="fill-muted-foreground text-[10px]">
          {data[0]?.label}
        </text>
        {data.length > 4 ? (
          <text x={x(Math.floor((data.length - 1) / 2))} y={height - 7} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {data[Math.floor((data.length - 1) / 2)]?.label}
          </text>
        ) : null}
        <text x={w - padR} y={height - 7} textAnchor="end" className="fill-muted-foreground text-[10px]">
          {data[data.length - 1]?.label}
        </text>
      </svg>
      {hv?.value != null && hover != null ? <Tip x={x(hover)} y={y(hv.value)} width={w} value={`${PLAIN.format(hv.value)}${unit}`} label={hv.label} /> : null}
    </div>
  );
}

/* ── késés-eloszlás ─────────────────────────────────────────────────────── */

export function DelayHistogram({ buckets, height = 160 }: { buckets: { min: number; n: number }[]; height?: number }) {
  if (!buckets.some((b) => b.n > 0)) return <EmptyChart />;
  return (
    <BarChart
      height={height}
      data={buckets.map((b) => ({
        label: b.min === 0 ? "0" : `${b.min > 0 ? "+" : ""}${b.min}`,
        value: b.n,
        // Jelentést hordozó szín: siet / pontos / késik.
        tone: b.min < -1 ? "fill-early" : b.min > 5 ? "fill-late" : "fill-ontime",
        title: `${b.n} érkezés · ${b.min > 0 ? "+" : ""}${b.min}…${b.min + 1} perc`,
      }))}
    />
  );
}

/* ── fánk (rész az egészhez) ────────────────────────────────────────────── */

export function Donut({
  slices,
  size = 150,
  centerLabel,
  centerSub,
}: {
  slices: { label: string; value: number; color?: string | null }[];
  size?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (!total) return <EmptyChart />;

  const stroke = 14;
  const r = size / 2 - stroke / 2 - 2;
  const c = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0;
  const colorOf = (s: { color?: string | null }) => (s.color ? `#${s.color}` : "hsl(var(--primary))");
  const pct = (v: number) => Math.round((v / total) * 100);
  let offset = 0;
  const hs = hover != null ? slices[hover] : null;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="Megoszlás" className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} className="fill-none stroke-muted" strokeWidth={stroke} />
          {slices.map((s, i) => {
            const len = Math.max(0, (s.value / total) * c - gap);
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={colorOf(s)}
                strokeWidth={stroke}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                className={cn("transition-opacity duration-fast", hover != null && hover !== i && "opacity-35")}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            );
            offset += (s.value / total) * c;
            return el;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-bold leading-none">{hs ? `${pct(hs.value)}%` : centerLabel}</span>
          {hs ? <span className="mt-1 max-w-[80%] truncate text-[10.5px] text-muted-foreground">{hs.label}</span> : null}
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {slices.slice(0, 6).map((s, i) => (
          <li
            key={i}
            className={cn("flex items-center gap-2 rounded-md px-1 text-xs transition-colors", hover === i && "bg-accent")}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(s) }} />
            <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{pct(s.value)}%</span>
          </li>
        ))}
        {slices.length > 6 ? <li className="px-1 text-[11px] text-muted-foreground">+ {slices.length - 6} további</li> : null}
        {centerSub ? <li className="px-1 pt-1 text-[11px] text-muted-foreground">{centerSub}</li> : null}
      </ul>
    </div>
  );
}

/* ── órás hőtérkép ──────────────────────────────────────────────────────── */

export function HourHeat({ cells, legend }: { cells: { hour: number; value: number | null; title: string }[]; legend?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const withData = cells.filter((c) => c.value != null);
  if (!withData.length) return <EmptyChart />;
  const max = Math.max(...withData.map((c) => c.value as number));
  const min = Math.min(...withData.map((c) => c.value as number));
  // Egyszínű skála: halványtól a telített zöldig.
  const alpha = (v: number) => 0.14 + (max === min ? 0.5 : (v - min) / (max - min)) * 0.8;
  const hv = hover != null ? cells[hover] : null;

  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <div className="grid grid-cols-12 gap-1 sm:grid-cols-[repeat(24,minmax(0,1fr))]">
        {cells.map((c, i) => {
          const a = c.value == null ? 0 : alpha(c.value);
          return (
            <div
              key={c.hour}
              onPointerEnter={() => setHover(i)}
              className={cn(
                "flex aspect-square items-center justify-center rounded-[5px] text-[9.5px] font-semibold tabular-nums transition-[outline-color] duration-fast",
                c.value == null ? "border border-dashed border-border/60 text-muted-foreground/50" : "outline outline-2 outline-transparent",
                hover === i && c.value != null && "outline-foreground/60",
              )}
              style={c.value == null ? undefined : { background: `hsl(var(--primary) / ${a})`, color: a > 0.6 ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))" }}
            >
              {formatServiceHour(c.hour)}
            </div>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="tabular-nums">{tick(min)}</span>
          <span className="h-2 w-20 rounded-full" style={{ background: "linear-gradient(90deg, hsl(var(--primary) / 0.14), hsl(var(--primary) / 0.94))" }} />
          <span className="tabular-nums">{tick(max)}</span>
        </span>
        {legend ? <span>{legend}</span> : null}
      </div>
      {hv ? (
        <div className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[12px] font-medium shadow-lg">
          {hv.title}
        </div>
      ) : null}
    </div>
  );
}

/* ── rangsor ────────────────────────────────────────────────────────────── */

export function RankBars({
  rows,
  unit = "",
}: {
  /** barClass: a sáv színe, ha nem késést mutat (alapból „late”) */
  rows: { label: ReactNode; sub?: ReactNode; value: number; display?: string; barClass?: string }[];
  unit?: string;
}) {
  if (!rows.length) return <EmptyChart />;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <ol className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={i} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1">
          <span className="row-span-2 self-start pt-px text-right font-mono text-[11px] text-muted-foreground">{i + 1}.</span>
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium">{r.label}</p>
            {r.sub ? <p className="truncate text-[11px] text-muted-foreground">{r.sub}</p> : null}
          </div>
          {/* Az érték szövegszínű; a színt a sáv viseli. */}
          <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-foreground">{r.display ?? `${r.value}${unit}`}</span>
          <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full", r.barClass ?? "bg-late/80")} style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
