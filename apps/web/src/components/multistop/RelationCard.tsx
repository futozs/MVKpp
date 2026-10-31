import { useState } from "react";
import { ArrowRight, RefreshCw, Route as RouteIcon, Trash2 } from "lucide-react";
import type { RelationBoardResponse, RelationRow, Stop } from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Countdown } from "@/components/transit/Countdown";
import { DelayBar } from "@/components/transit/DelayBar";
import { LiveTag } from "@/components/transit/LiveDot";
import { RouteTile } from "@/components/transit/RouteTile";
import { NoticeList, PlatformBadge } from "@/components/transit/RegionalBits";
import { describeApiError, type FriendlyError } from "@/lib/apiError";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import type { RelationWatch } from "@/lib/transitWatches";

const POLL_MS = 20_000;
const ROWS = 8;

const tileText = (r: RelationRow) => (r.mode === "rail" && r.trainNo ? `${r.route} ${r.trainNo}` : r.route);
const titleOf = (r: RelationRow) => (r.trainName ? `${r.trainName} → ${r.headsign}` : r.headsign);

/**
 * Viszonylat: A-ból B-be közvetlenül (pl. Miskolc-Tiszai → Füzesabony). Csak azok a
 * menetek, amelyek mindkét helyen megállnak — indulás A-ból vágánnyal és késéssel,
 * érkezés B-be, menetidő, és a MÁV megjegyzései (késés oka).
 */
export function RelationCard({
  relation,
  stops,
  onRemove,
  onFocusTrip,
  className,
}: {
  relation: RelationWatch;
  stops: Stop[];
  onRemove: () => void;
  onFocusTrip?: (tripId: string, vehicleId?: string) => void;
  className?: string;
}) {
  const [data, setData] = useState<RelationBoardResponse | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const nameOf = (id: string, fallback: string | null) => stops.find((s) => s.id === id)?.name ?? fallback ?? id;
  const fromName = nameOf(relation.from, data?.from.name ?? null);
  const toName = nameOf(relation.to, data?.to.name ?? null);

  useVisiblePoll(
    () => {
      api
        .getRelation(relation.from, relation.to, ROWS)
        .then((res) => {
          setData(res);
          setError(null);
        })
        .catch((e) => setError(describeApiError(e)));
    },
    POLL_MS,
    [relation.from, relation.to],
  );

  const rows = data?.rows ?? [];
  const next = rows[0];
  const now = serverNow();

  return (
    <Card className={cn("flex min-w-0 flex-col overflow-hidden shadow-lg", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-base font-bold tracking-tight" title={`${fromName} → ${toName}`}>
            <span className="truncate">{fromName}</span>
            <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{toName}</span>
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <RouteIcon aria-hidden className="h-3 w-3" />
            Viszonylat · közvetlen járatok
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 hover:bg-destructive/15 hover:text-destructive" onClick={onRemove} aria-label={`${fromName} → ${toName} levétele a figyelőről`}>
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Levétel a figyelőről</TooltipContent>
        </Tooltip>
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
          error ? null : <p className="py-6 text-center font-mono text-xs text-muted-foreground">Járatok lekérése…</p>
        ) : !next ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ma és holnap nincs több közvetlen járat a kettő között.</p>
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Következő</span>
              {next.cancelled ? (
                <span className="rounded-md border border-destructive/50 bg-destructive/12 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive">Törölve</span>
              ) : (
                <LiveTag live={next.live} />
              )}
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <RouteTile short={tileText(next)} color={next.color} text={next.text} size="lg" />
                <div className="min-w-0 pt-0.5">
                  <p className="truncate text-sm font-semibold" title={titleOf(next)}>
                    {titleOf(next)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className={cn("font-mono text-xs tabular-nums text-muted-foreground", next.cancelled && "line-through decoration-destructive/70 decoration-2")}>
                      {next.depTime} → {next.arrTime}
                    </span>
                    <PlatformBadge platform={next.platform} mode={next.mode} />
                    {next.cancelled ? null : <DelayBar delaySec={next.depDelaySec} />}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {next.durationMin} perc · {next.stops - 2 > 0 ? `${next.stops - 2} megálló közben` : "megállás nélkül"}
                  </p>
                </div>
              </div>
              {next.cancelled ? <span className="shrink-0 pt-1 text-xs font-semibold text-destructive">nem jön</span> : <Countdown etaMin={Math.max(0, Math.round((next.depUnix - now) / 60))} />}
            </div>
            <NoticeList notices={next.notices} className="mt-2.5" />
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length > 1 ? (
          <ul className="divide-y divide-border/60">
            {rows.slice(1).map((r) => {
              const focusable = Boolean(onFocusTrip && r.live && !r.cancelled);
              const eta = Math.max(0, Math.round((r.depUnix - now) / 60));
              return (
                <li key={`${r.tripId}-${r.schedDepUnix}`}>
                  <div
                    role={focusable ? "button" : undefined}
                    tabIndex={focusable ? 0 : undefined}
                    onClick={focusable ? () => onFocusTrip?.(r.tripId, r.vehicle?.id) : undefined}
                    onKeyDown={
                      focusable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onFocusTrip?.(r.tripId, r.vehicle?.id);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast",
                      focusable && "cursor-pointer hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <RouteTile short={tileText(r)} color={r.color} text={r.text} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={titleOf(r)}>
                        {titleOf(r)}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <PlatformBadge platform={r.platform} mode={r.mode} compact />
                        {r.cancelled ? <span className="rounded bg-destructive/15 px-1.5 py-px text-[10px] font-bold uppercase text-destructive">törölve</span> : null}
                        <span className={cn("font-mono text-[11px] tabular-nums text-muted-foreground", r.cancelled && "line-through decoration-destructive/70")}>
                          {r.depTime} → {r.arrTime}
                        </span>
                        {r.cancelled ? null : <DelayBar delaySec={r.depDelaySec} showLabel={false} />}
                        {r.today ? null : <span className="text-[10px] font-semibold text-muted-foreground">holnap</span>}
                      </div>
                      <NoticeList notices={r.notices} compact className="mt-1" />
                    </div>
                    <span className="shrink-0 font-mono text-base font-bold tabular-nums">
                      {r.cancelled ? (
                        <span className="font-sans text-xs font-semibold text-destructive">nem jön</span>
                      ) : eta <= 0 ? (
                        <span className="text-live">most</span>
                      ) : (
                        <>
                          {eta}
                          <span className="ml-0.5 font-sans text-[11px] font-semibold text-muted-foreground">p</span>
                        </>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
