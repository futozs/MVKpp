import { useState } from "react";
import { Crosshair, RefreshCw, TrainFront, Trash2 } from "lucide-react";
import type { TrainDetailResponse } from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DelayBar, delaySentence } from "@/components/transit/DelayBar";
import { LiveTag } from "@/components/transit/LiveDot";
import { RouteTile } from "@/components/transit/RouteTile";
import { NoticeList, PlatformBadge } from "@/components/transit/RegionalBits";
import { hmOf } from "@/components/transit/TripInsights";
import { describeApiError, type FriendlyError } from "@/lib/apiError";
import { cn, withHungarianSuffix } from "@/lib/utils";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";

const POLL_MS = 20_000;
/** a már elhagyott megállókból ennyi látszik (a „hol jár” értelmezéséhez) */
const PASSED_SHOWN = 1;

/**
 * Egy vonat vonatszám szerint, minden nap (pl. a 5139): a ma — ha már elment, a
 * holnap — közlekedő példány. Hol jár, mennyit késik és miért, és a hátralévő
 * megállók vágánnyal.
 */
export function TrainCard({
  trainNo,
  onRemove,
  onFocusTrip,
  className,
}: {
  trainNo: string;
  onRemove: () => void;
  onFocusTrip?: (tripId: string, vehicleId?: string) => void;
  className?: string;
}) {
  const [data, setData] = useState<TrainDetailResponse | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);

  useVisiblePoll(
    () => {
      api
        .getTrain(trainNo)
        .then((res) => {
          setData(res);
          setError(null);
        })
        .catch((e) => setError(describeApiError(e)));
    },
    POLL_MS,
    [trainNo],
  );

  const stops = data?.stops ?? [];
  const firstUpcoming = stops.findIndex((s) => !s.passed);
  const shown = firstUpcoming < 0 ? stops.slice(-1) : stops.slice(Math.max(0, firstUpcoming - PASSED_SHOWN));
  const delay = data?.officialDelaySec ?? data?.liveDelaySec ?? null;
  const live = Boolean(data?.vehicle);
  const lastPassed = firstUpcoming > 0 ? stops[firstUpcoming - 1] : null;
  const nextStop = firstUpcoming >= 0 ? stops[firstUpcoming] : null;
  const title = data?.found ? `${data.trainName ? `${data.trainName} → ` : ""}${data.headsign ?? ""}` : `${withHungarianSuffix(trainNo)} vonat`;
  const tile = data?.category ? `${data.category} ${trainNo}` : trainNo;
  const where =
    data?.cancelled
      ? null
      : live && lastPassed && nextStop
        ? `${lastPassed.name} és ${nextStop.name} között`
        : live && nextStop
          ? `${nextStop.name} felé`
          : null;
  const firstDep = stops[0];

  return (
    <Card className={cn("flex min-w-0 flex-col overflow-hidden shadow-lg", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <RouteTile short={tile} color={data?.route?.color ?? "1E5AA8"} text={data?.route?.text ?? "FFFFFF"} size="lg" className="rounded-full" />
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold tracking-tight" title={title}>
              {title}
            </h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <TrainFront aria-hidden className="h-3 w-3" />
              {data?.found ? (data.today ? (data.name ?? trainNo) : `holnap · ${data.name ?? trainNo}`) : "Vonatszám figyelése"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {data?.vehicle && data.tripId && onFocusTrip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onFocusTrip(data.tripId!, data.vehicle?.id)} aria-label="Követés a térképen">
                  <Crosshair />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Követés a térképen</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-destructive/15 hover:text-destructive" onClick={onRemove} aria-label={`A ${withHungarianSuffix(trainNo)} vonat levétele a figyelőről`}>
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Levétel a figyelőről</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="border-b border-border bg-muted/30 px-4 py-3.5">
        {error ? (
          <p role="status" className="mb-2.5 flex items-center gap-2 rounded-lg border border-late/30 bg-late/10 px-3 py-2 text-xs">
            <RefreshCw aria-hidden className="h-3.5 w-3.5 shrink-0 text-late motion-safe:animate-spin" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-foreground">Hiba, újrapróbálom…</span> <span className="text-muted-foreground">{error.reason}</span>
            </span>
          </p>
        ) : null}
        {!data ? (
          error ? null : <p className="py-6 text-center font-mono text-xs text-muted-foreground">A vonat lekérése…</p>
        ) : !data.found ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ma és holnap nem közlekedik {withHungarianSuffix(trainNo)} vonat a megyét érintve.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{live ? "Most" : data.today && firstDep && firstDep.depUnix > Date.now() / 1000 ? "Indul" : "Menetrend"}</span>
              {data.cancelled ? (
                <span className="rounded-md border border-destructive/50 bg-destructive/12 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive">Törölve</span>
              ) : (
                <LiveTag live={live || delay != null} />
              )}
            </div>
            <p className="text-sm font-semibold">
              {data.cancelled ? "Ma nem közlekedik." : where ?? (firstDep ? `${firstDep.name}, ${firstDep.schedDep}` : "")}
            </p>
            {!data.cancelled ? (
              <div className="mt-1.5 flex items-center gap-2">
                <DelayBar delaySec={delay} />
                <span className="text-[11px] text-muted-foreground">{delaySentence(delay)}</span>
                {data.vehicle?.speed != null ? <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{Math.round(data.vehicle.speed * 3.6)} km/h</span> : null}
              </div>
            ) : null}
            <NoticeList notices={data.notices?.map((n) => n.text)} className="mt-2.5" />
          </>
        )}
      </div>

      {data?.found && shown.length ? (
        <ol className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
          {shown.map((s) => {
            const late = s.delaySec != null && Math.abs(s.delaySec) >= 60;
            return (
              <li key={`${s.id}-${s.schedDep}`} className={cn("flex items-center gap-3 px-4 py-2", s.passed && "opacity-55")}>
                <span className={cn("h-2 w-2 shrink-0 rounded-full", s.passed ? "bg-muted-foreground/50" : "bg-primary")} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{s.name}</span>
                <PlatformBadge platform={s.platform} changed={s.platformChanged} predicted={s.platformPredicted} mode="rail" compact />
                <span className="shrink-0 text-right font-mono text-[11px] tabular-nums">
                  <span className={cn(late && "text-muted-foreground line-through decoration-1")}>{s.schedDep}</span>
                  {late ? <span className="ml-1 font-bold text-late">{hmOf(s.depUnix)}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </Card>
  );
}
