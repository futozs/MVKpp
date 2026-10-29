import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Clock3, History } from "lucide-react";
import type { JourneyMode, JourneyPlanResponse, JourneyTrip } from "@/services/api";
import { RouteTile } from "@/components/transit/RouteTile";
import { cn } from "@/lib/utils";
import {
  TONE_TEXT,
  delayForecast,
  delayShort,
  hm,
  hms,
  minutes,
  toneOf,
  transfersLabel,
  transitLegs,
  walkTotalSec,
} from "./format";
import { tripForecast, worstTransfer } from "./forecast";
import { outcomeHeadline, pastOutcome, transferMeasured } from "./proof";
import { ProofPanel } from "./ProofPanel";
import { TransferBadge } from "./TransferBadge";
import { TripTimeline } from "./TripTimeline";

/** Ennyi csúszás belefér az „érkezzek X-ig” célba. */
const ARRIVE_BY_SLACK_SEC = 59;

function RouteChain({ trip }: { trip: JourneyTrip }) {
  const rides = transitLegs(trip);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {rides.map((l, i) => (
        <span key={`${l.tripId}-${i}`} className="inline-flex items-center gap-1">
          {i ? <ChevronRight aria-hidden className="h-3 w-3 text-muted-foreground" /> : null}
          <RouteTile short={l.routeShortName} color={l.routeColor} text={l.routeTextColor} size="sm" />
        </span>
      ))}
    </div>
  );
}

function PastStatus({ trip }: { trip: JourneyTrip }) {
  const o = pastOutcome(trip);
  const tone = o.missedTransfer ? "late" : toneOf(o.arrivalDelayS);
  const rides = transitLegs(trip);
  const lastDep = rides[rides.length - 1]?.actual?.depDelayS ?? null;
  const detail = o.missedTransfer
    ? null
    : o.actualArrival != null
      ? `(${o.arrivalEstimated ? "becsült érkezés" : "valójában"} ${hms(o.actualArrival)})`
      : lastDep != null
        ? `(az utolsó járat ${delayShort(lastDep)} eltéréssel indult)`
        : null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <span className={cn("inline-flex items-center gap-1.5 font-semibold", TONE_TEXT[tone])}>
        <History aria-hidden className="h-3.5 w-3.5 shrink-0" />
        {outcomeHeadline(o)}
      </span>
      {detail ? <span className="tabular-nums text-muted-foreground">{detail}</span> : null}
      {o.partial && o.untrackedRoutes.length < o.rideCount ? (
        <span className="text-muted-foreground">— részleges mérés</span>
      ) : null}
    </p>
  );
}

function ArriveByWarning({ trip, target }: { trip: JourneyTrip; target: number }) {
  const f = tripForecast(trip);
  const expectedLate = f.expectedArrival != null && f.expectedArrival > target + ARRIVE_BY_SLACK_SEC;
  const worstLate = f.worstArrival != null && f.worstArrival > target + ARRIVE_BY_SLACK_SEC;
  if (!expectedLate && !worstLate) return null;
  return (
    <p className={cn("text-[11px] font-semibold", expectedLate ? "text-late" : "text-amber-300")}>
      {expectedLate
        ? `${hm(target)}-ig várhatóan nem érsz be — válassz korábbi indulást.`
        : `Rossz esetben ${hm(target)} után érsz be.`}
    </p>
  );
}

function ForecastStatus({ trip }: { trip: JourneyTrip }) {
  const f = tripForecast(trip);
  if (f.expectedArrival == null || f.arrDelayS == null) {
    return (
      <p className="text-xs text-muted-foreground">
        Nincs késési adat — a menetrend szerinti időket mutatjuk.
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <Clock3 aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        Várható érkezés <span className="font-semibold tabular-nums">{hm(f.expectedArrival)}</span>
        <span className={cn("font-semibold", TONE_TEXT[toneOf(f.arrDelayS)])}>
          ({delayForecast(f.arrDelayS)})
          {f.worstArrival != null ? <span className="font-normal text-muted-foreground">,</span> : null}
        </span>
      </span>
      {f.worstArrival != null ? (
        <span className="text-muted-foreground">
          rossz esetben <span className="font-semibold tabular-nums text-foreground">{hm(f.worstArrival)}</span>
        </span>
      ) : null}
    </p>
  );
}

type Props = {
  plan: JourneyPlanResponse;
  trip: JourneyTrip;
  defaultOpen?: boolean;
};

export function TripCard({ plan, trip, defaultOpen = false }: Props) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const bodyId = useId();
  const mode: JourneyMode = plan.mode;
  const worst = worstTransfer(trip);
  const showWorst =
    worst && worst.check.risk !== "safe" && (mode !== "past" || transferMeasured(trip, worst.index));
  const walk = walkTotalSec(trip);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border bg-card transition-colors duration-fast",
        isOpen ? "border-primary/35 shadow-md" : "border-border hover:border-primary/25",
      )}
    >
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        className="block w-full space-y-2 p-4 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-lg font-bold tabular-nums tracking-tight sm:text-xl">
            {hm(trip.start)}
            <span className="px-1.5 font-sans font-normal text-muted-foreground">→</span>
            {hm(trip.end)}
          </p>
          <p className="flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums">
            {minutes(trip.durationSec)}
            <ChevronDown
              aria-hidden
              className={cn("h-4 w-4 text-muted-foreground transition-transform duration-fast", isOpen && "rotate-180")}
            />
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <RouteChain trip={trip} />
          <p className="shrink-0 text-right text-[11px] text-muted-foreground">
            {transfersLabel(trip.transfers)}
            {walk >= 60 ? ` · ${minutes(walk)} gyalog` : ""}
          </p>
        </div>

        {mode === "past" ? <PastStatus trip={trip} /> : <ForecastStatus trip={trip} />}
        {mode !== "past" && plan.arriveBy ? <ArriveByWarning trip={trip} target={plan.at} /> : null}

        {showWorst && worst ? (
          <TransferBadge check={worst.check} mode={mode} measured={mode !== "past" || transferMeasured(trip, worst.index)} />
        ) : null}
      </button>

      {isOpen ? (
        <div id={bodyId} className="space-y-4 border-t border-border px-3 pb-4 pt-4 sm:px-4">
          <TripTimeline trip={trip} mode={mode} />
          {mode === "past" ? <ProofPanel plan={plan} trip={trip} /> : null}
        </div>
      ) : null}
    </article>
  );
}
