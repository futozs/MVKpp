import type { ReactNode } from "react";
import { Footprints } from "lucide-react";
import type {
  JourneyMode,
  JourneyTransitLeg,
  JourneyTrip,
  JourneyWalkLeg,
} from "@/services/api";
import { RouteTile } from "@/components/transit/RouteTile";
import { cn } from "@/lib/utils";
import {
  MODE_NOUN,
  ON_TIME_SEC,
  TONE_TEXT,
  hm,
  hms,
  isTransit,
  minutes,
  toneOf,
} from "./format";
import { LegInsight } from "./LegInsight";
import { TransferBadge } from "./TransferBadge";
import { transferMeasured } from "./proof";

type Rail = { kind: "solid"; color: string } | { kind: "dashed" } | null;
const DASHED: Rail = { kind: "dashed" };
const MUTED_DOT = "hsl(var(--muted-foreground))";
const GRID = "grid grid-cols-[3.75rem_1rem_minmax(0,1fr)] gap-x-2.5";

function RailLine({ rail, className }: { rail: Rail; className: string }) {
  if (!rail) return null;
  if (rail.kind === "dashed") {
    return (
      <span
        aria-hidden
        className={cn("absolute left-1/2 -translate-x-1/2 border-l-2 border-dotted border-muted-foreground/40", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("absolute left-1/2 w-[3px] -translate-x-1/2", className)}
      style={{ backgroundColor: rail.color }}
    />
  );
}

type Sub = { text: string; sec: number | null; title: string } | null;

function StopRow(props: {
  time: string;
  sub?: Sub;
  name: string;
  top: Rail;
  bottom: Rail;
  dot: string;
  isEndpoint?: boolean;
}) {
  const { time, sub, name, top, bottom, dot, isEndpoint } = props;
  return (
    <li className={GRID}>
      <div className="pb-1 text-right">
        <p className="font-mono text-[13px] font-semibold leading-5 tabular-nums">{time}</p>
        {sub ? (
          <p title={sub.title} className={cn("font-mono text-[10.5px] leading-4 tabular-nums", TONE_TEXT[toneOf(sub.sec)])}>
            {sub.text}
          </p>
        ) : null}
      </div>
      <div className="relative">
        <RailLine rail={top} className="top-0 h-[10px]" />
        <RailLine rail={bottom} className="bottom-0 top-[10px]" />
        <span
          aria-hidden
          className={cn(
            "absolute left-1/2 top-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] bg-card",
            isEndpoint ? "h-3.5 w-3.5" : "h-3 w-3",
          )}
          style={{ borderColor: dot }}
        />
      </div>
      <p className={cn("min-w-0 pb-1 leading-5 [overflow-wrap:anywhere]", isEndpoint ? "text-sm font-bold" : "text-[13px] font-semibold")}>
        {name}
      </p>
    </li>
  );
}

function SegmentRow({ rail, children }: { rail: Rail; children: ReactNode }) {
  return (
    <li className={GRID}>
      <span aria-hidden />
      <div className="relative">
        <RailLine rail={rail} className="inset-y-0" />
      </div>
      <div className="min-w-0 pb-3 pt-1.5">{children}</div>
    </li>
  );
}

function boardSub(leg: JourneyTransitLeg, mode: JourneyMode): Sub {
  if (mode === "past") {
    const a = leg.actual;
    return a?.depTs != null ? { text: hms(a.depTs), sec: a.depDelayS, title: "Mért indulás" } : null;
  }
  const d = leg.prediction?.depDelayS;
  return d != null && Math.abs(d) >= ON_TIME_SEC
    ? { text: `~${hm(leg.schedDep + d)}`, sec: d, title: "Várható indulás" }
    : null;
}

function alightSub(leg: JourneyTransitLeg, mode: JourneyMode): Sub {
  if (mode === "past") {
    const a = leg.actual;
    if (a?.arrTs == null) return null;
    return {
      text: `${a.estimated ? "≈" : ""}${hms(a.arrTs)}`,
      sec: a.arrDelayS,
      title: a.estimated ? "Becsült érkezés" : "Mért érkezés",
    };
  }
  const d = leg.prediction?.arrDelayS;
  return d != null && Math.abs(d) >= ON_TIME_SEC
    ? { text: `~${hm(leg.schedArr + d)}`, sec: d, title: "Várható érkezés" }
    : null;
}

function distance(m: number): string {
  return m < 1000 ? `${m} m` : `${(m / 1000).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} km`;
}

function RideBody({ leg, mode }: { leg: JourneyTransitLeg; mode: JourneyMode }) {
  const hops = leg.intermediateStopNames.length + 1;
  const meta = `${minutes(leg.durationSec)} · ${hops} megálló`;
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <RouteTile short={leg.routeShortName} color={leg.routeColor} text={leg.routeTextColor} size="sm" />
        <p className="min-w-0 truncate text-xs">
          <span className="font-semibold">{MODE_NOUN[leg.mode]}</span>
          {leg.headsign ? <span className="text-muted-foreground"> · {leg.headsign}</span> : null}
        </p>
      </div>
      {leg.intermediateStopNames.length ? (
        <details className="group text-[11px] text-muted-foreground">
          <summary className="cursor-pointer list-none tabular-nums transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            {meta} <span className="underline decoration-dotted underline-offset-2">útközben</span>
          </summary>
          <ol className="mt-1 space-y-0.5 border-l border-border pl-2">
            {leg.intermediateStopNames.map((n, i) => (
              <li key={`${i}-${n}`}>{n}</li>
            ))}
          </ol>
        </details>
      ) : (
        <p className="text-[11px] tabular-nums text-muted-foreground">{meta}</p>
      )}
      <LegInsight leg={leg} mode={mode} />
    </div>
  );
}

function WalkBody({ leg, isTransfer, children }: { leg: JourneyWalkLeg | null; isTransfer: boolean; children?: ReactNode }) {
  const what = leg ? `gyalog ${minutes(leg.durationSec)} · ${distance(leg.distanceMeter)}` : "ugyanennél a megállónál";
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Footprints aria-hidden className="h-3 w-3 shrink-0" />
        {isTransfer ? `Átszállás: ${what}` : what.charAt(0).toUpperCase() + what.slice(1)}
      </p>
      {children}
    </div>
  );
}

/** Függőleges idővonal: megállók, járatszakaszok, gyaloglás és átszállások. */
export function TripTimeline({ trip, mode }: { trip: JourneyTrip; mode: JourneyMode }) {
  const legs = trip.legs;
  const rows: ReactNode[] = [];
  let ride = -1;

  const transferBadge = (k: number) => {
    const check = trip.transferChecks[k];
    return check ? <TransferBadge check={check} mode={mode} measured={transferMeasured(trip, k)} /> : null;
  };

  legs.forEach((leg, i) => {
    const prev = legs[i - 1];
    const next = legs[i + 1];
    if (isTransit(leg)) {
      ride += 1;
      const color = `#${leg.routeColor || "1FB574"}`;
      const solid: Rail = { kind: "solid", color };
      rows.push(
        <StopRow key={`b${i}`} time={hm(leg.start)} sub={boardSub(leg, mode)} name={leg.fromName} top={prev ? DASHED : null} bottom={solid} dot={color} isEndpoint={!prev} />,
        <SegmentRow key={`r${i}`} rail={solid}>
          <RideBody leg={leg} mode={mode} />
        </SegmentRow>,
        <StopRow key={`a${i}`} time={hm(leg.end)} sub={alightSub(leg, mode)} name={leg.toName} top={solid} bottom={next ? DASHED : null} dot={color} isEndpoint={!next} />,
      );
      if (next && isTransit(next)) {
        rows.push(
          <SegmentRow key={`t${i}`} rail={DASHED}>
            <WalkBody leg={null} isTransfer>{transferBadge(ride)}</WalkBody>
          </SegmentRow>,
        );
      }
      return;
    }
    if (!prev) {
      rows.push(<StopRow key="origin" time={hm(leg.start)} name={leg.fromName} top={null} bottom={DASHED} dot={MUTED_DOT} isEndpoint />);
    }
    const isTransfer = Boolean(prev && next && isTransit(prev) && isTransit(next));
    rows.push(
      <SegmentRow key={`w${i}`} rail={DASHED}>
        <WalkBody leg={leg} isTransfer={isTransfer}>{isTransfer ? transferBadge(ride) : null}</WalkBody>
      </SegmentRow>,
    );
    if (!next) {
      rows.push(<StopRow key="dest" time={hm(leg.end)} name={leg.toName} top={DASHED} bottom={null} dot={MUTED_DOT} isEndpoint />);
    }
  });

  return <ol aria-label="Az utazás lépései">{rows}</ol>;
}
