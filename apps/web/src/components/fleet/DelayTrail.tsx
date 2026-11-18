import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/apiBase";
import { useMeasure } from "@/components/charts/Charts";
import { cn } from "@/lib/utils";
import { clockText } from "./fleetText";

type TripData = {
  stops: { id: string; name: string }[];
  events: { stop_idx: number; delay_s: number; src: number; arr: number }[];
  liveDelaySec: number | null;
  run: { lastStopIdx: number | null } | null;
};

type Point = { x: number; delayS: number; label: string; live: boolean };

/** a becsült (nem mért) beérkezés forrása az eseménytáblában */
const SRC_FINAL = 3;
const H = 132;
const PAD = { l: 34, r: 12, t: 10, b: 22 };

function niceStep(rangeMin: number): number {
  for (const s of [1, 2, 5, 10, 15, 30]) if (rangeMin / s <= 4) return s;
  return 60;
}

/**
 * A menet késése megállóról megállóra: hol szedte fel (pirosan kiemelve a
 * szakasz), és hol tart most (szaggatott vég). A nulla vonal a menetrend.
 */
export function DelayTrail({
  tripId,
  refreshKey,
  pickup,
  past,
}: {
  tripId: string;
  refreshKey: number;
  pickup: { fromIdx: number; toIdx: number } | null;
  /** visszanézéskor: a pillanat, a napja, és akkor mennyit késett, hol tartott */
  past: { t: number; date: string; delayS: number; lastIdx: number } | null;
}) {
  const [trip, setTrip] = useState<TripData | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width } = useMeasure<HTMLDivElement>();

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`${API_BASE}/engine/trip?trip=${encodeURIComponent(tripId)}${past ? `&date=${past.date}` : ""}`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<TripData>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        setTrip(d);
        setFailed(false);
      })
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      });
    return () => ctl.abort();
  }, [tripId, refreshKey, past?.date]);

  if (failed && !trip) return <p className="py-6 text-center text-xs text-muted-foreground">A menet megállónkénti adatai most nem érhetők el.</p>;
  if (!trip) return <div className="h-[132px] animate-pulse rounded-lg bg-muted/40" aria-label="Betöltés" />;

  const points: Point[] = trip.events
    // visszanézéskor csak az addig történt
    .filter((e) => e.src !== SRC_FINAL && (!past || e.arr <= past.t))
    .sort((a, b) => a.stop_idx - b.stop_idx)
    .map((e) => ({ x: e.stop_idx, delayS: e.delay_s, label: trip.stops[e.stop_idx]?.name ?? "", live: false }));
  const last = past ? past.lastIdx : trip.run?.lastStopIdx;
  const nowDelay = past ? past.delayS : trip.liveDelaySec;
  if (nowDelay != null && last != null && last >= 0 && last < trip.stops.length - 1) {
    points.push({ x: last + 0.5, delayS: nowDelay, label: `${past ? "Akkor" : "Most"}, ${trip.stops[last + 1]?.name ?? ""} felé`, live: true });
  }
  if (points.length < 2) return <p className="py-6 text-center text-xs text-muted-foreground">Még kevés megállón haladt át, nincs mit kirajzolni.</p>;

  const w = Math.max(width, 260);
  const n = Math.max(1, trip.stops.length - 1);
  const mins = points.map((p) => p.delayS / 60);
  const step = niceStep(Math.max(1, Math.max(0, ...mins) - Math.min(0, ...mins)));
  // alul nem kerekítünk egész lépésre: egy fél perc sietés miatt ne legyen fél diagramnyi üres sáv
  const hi = Math.max(step, Math.ceil(Math.max(0, ...mins) / step) * step);
  const lo = Math.min(0, ...mins) - (Math.min(0, ...mins) < 0 ? step * 0.25 : 0);
  const x = (i: number) => PAD.l + (i / n) * (w - PAD.l - PAD.r);
  const y = (sec: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (sec / 60 - lo) / (hi - lo));
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);

  const measured = points.filter((p) => !p.live);
  const path = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.delayS).toFixed(1)}`).join(" ");
  const inPickup = pickup ? points.filter((p) => p.x >= pickup.fromIdx - 0.5 && p.x <= pickup.toIdx) : [];
  const livePt = points.find((p) => p.live);
  const shown = hover != null ? points[hover] : (livePt ?? measured[measured.length - 1]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.x) - px) < Math.abs(x(points[best].x) - px)) best = i;
    });
    setHover(best);
  };

  return (
    <div ref={ref} className="w-full">
      <svg
        width={w}
        height={H}
        className="block touch-pan-y"
        role="img"
        aria-label={`A késés alakulása ${measured.length} megállón át`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {pickup ? (
          <rect x={x(pickup.fromIdx)} y={PAD.t} width={Math.max(3, x(pickup.toIdx) - x(pickup.fromIdx))} height={H - PAD.t - PAD.b} className="fill-late/10" rx={3} />
        ) : null}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(t * 60)} y2={y(t * 60)} className={t === 0 ? "stroke-muted-foreground/50" : "stroke-border/50"} strokeDasharray={t === 0 ? "3 3" : undefined} />
            <text x={PAD.l - 6} y={y(t * 60) + 3.5} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
              {t > 0 ? `+${t}` : t < 0 ? `−${-t}` : 0}
            </text>
          </g>
        ))}
        <path d={path(measured)} fill="none" className="stroke-foreground/70" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {inPickup.length > 1 ? <path d={path(inPickup)} fill="none" className="stroke-late" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {livePt && measured.length ? (
          <path d={path([measured[measured.length - 1], livePt])} fill="none" className={livePt.delayS > measured[measured.length - 1].delayS + 30 ? "stroke-late" : "stroke-foreground/70"} strokeWidth={2} strokeDasharray="3 3" />
        ) : null}
        {shown ? <circle cx={x(shown.x)} cy={y(shown.delayS)} r={4} className={cn(shown.live ? "fill-live" : "fill-foreground", "stroke-card")} strokeWidth={2} /> : null}
        <text x={PAD.l} y={H - 6} className="fill-muted-foreground text-[10px]">
          {trip.stops[0]?.name}
        </text>
        <text x={w - PAD.r} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
          {trip.stops[trip.stops.length - 1]?.name}
        </text>
      </svg>
      <p className="mt-1 flex items-baseline justify-between gap-3 text-xs" aria-live="polite">
        <span className="min-w-0 truncate text-muted-foreground">{shown?.label}</span>
        <span className={cn("shrink-0 font-bold tabular-nums", (shown?.delayS ?? 0) >= 60 ? "text-late" : (shown?.delayS ?? 0) <= -60 ? "text-early" : "text-ontime")}>
          {shown ? clockText(shown.delayS) : ""}
        </span>
      </p>
    </div>
  );
}
