import { useEffect, useRef, useState } from "react";
import { Bell, BellRing, ChevronLeft, ChevronRight, Crosshair, Trash2 } from "lucide-react";
import type { ArrivalItem, Stop, StopArrivalsResponse } from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Countdown } from "@/components/transit/Countdown";
import { DelayBar } from "@/components/transit/DelayBar";
import { LiveTag } from "@/components/transit/LiveDot";
import { RouteTile } from "@/components/transit/RouteTile";
import { VehicleTrack } from "@/components/transit/VehicleTrack";
import { formatDistance } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { checkAndNotify, getWatch } from "@/lib/notifications";
import { StopNotifyDialog } from "./StopNotifyDialog";
import { useFallbackPoll, useTopic } from "@/lib/realtime";
import { describeApiError, type FriendlyError } from "@/lib/apiError";
import { ForecastLine } from "@/components/transit/ForecastLine";
import { CatchLine, CatchPill, ReplacementNote, replacementFor, StartRiskLine, TrafficLine } from "@/components/transit/TripInsights";
import { expectedArrival, useCatchFor } from "@/hooks/useCatch";
import { addAlert, noPushNote, notifyLocallyOnce, removeAlert, useAlerts } from "@/lib/alerts";
import { useWatchFeatures } from "@/lib/watchPrefs";
import { displayVehicleId, useBoardKey } from "@/lib/modes";
import { arrivalTileText, arrivalTitle, arrivalVehicleLabel, NoticeList, PlatformBadge, SharedStopTag, stopKindLabel } from "@/components/transit/RegionalBits";
import { RefreshCw } from "lucide-react";

/** hiba után ennyi idő múlva próbáljuk újra (duplázva, legfeljebb 30 mp-ig) */
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;

const POLL_MS = 4000;

/** Fordulóhurok: nem tipp  ugyanaz a busz fordul vissza, ami most odafelé jár. */
const isLoopVehicle = (p: { method?: string }) => p.method === "loop";

function predictedTitle(p: { confidence: number; method?: string }): string {
  if (p.method === "matched") return "Már úton van  a GPS-nyomvonal alapján ez a busz viszi";
  if (isLoopVehicle(p)) return "Ez a busz most a végállomás felé jár, és ugyanonnan fordul vissza  nem tipp";
  return `Előrejelzés a korábbi fordák alapján, ${Math.round(p.confidence * 100)}% bizonyossággal`;
}

export type StopCardReorder = {
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
};

type StopCardProps = {
  stop: Stop;
  onRemove: (stopId: string) => void;
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void;
  className?: string;
  reorder?: StopCardReorder;
  distanceKm?: number | null;
  isNearest?: boolean;
};

export function StopCard({
  stop,
  onRemove,
  onFocusMap,
  className,
  reorder,
  distanceKm,
  isNearest,
}: StopCardProps) {
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const retryRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; delay: number }>({ timer: null, delay: RETRY_BASE_MS });
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [isWatching, setIsWatching] = useState(() => Boolean(getWatch(stop.id)));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A Beállításokban egyenként kikapcsolható funkciók (felhőben szinkronizálva).
  const f = useWatchFeatures();
  // A bekapcsolt módok indulásai (a Tiszai pu. MVK-megállóján a Volán is megáll); az állomás táblája hosszabb.
  const modesKey = useBoardKey();
  const isStation = Boolean(stop.station || stop.feed === "rail");
  const listLimit = isStation ? 12 : 8;
  const showPredicted = f.predictedVehicle;

  const apply = (res: StopArrivalsResponse) => {
    if (!mounted.current) return;
    setData(res);
    setError(null);
    retryRef.current.delay = RETRY_BASE_MS;
    checkAndNotify(stop.id, stop.name, res.arrivals);
  };

  // Hiba esetén nem a nyers hibaszöveg: rövid ok a kódból, és magától újrapróbálja.
  const load = async () => {
    try {
      apply(await api.getArrivals(stop.id, listLimit, modesKey));
    } catch (err) {
      if (!mounted.current) return;
      setError(describeApiError(err));
      const r = retryRef.current;
      if (r.timer) clearTimeout(r.timer);
      r.timer = setTimeout(() => {
        r.timer = null;
        void load();
      }, r.delay);
      r.delay = Math.min(RETRY_MAX_MS, r.delay * 2);
    }
  };

  useEffect(
    () => () => {
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer);
    },
    [],
  );

  // A szerver magától küldi, amint a tábla változik (busz beért, elindult,
  // új késés)  nincs 4 mp-es várakozás. Pollozás csak kapcsolat nélkül.
  useTopic(`stop:${stop.id}@${modesKey}`, (m) => apply(m.data as StopArrivalsResponse));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop.id, modesKey]);
  useFallbackPoll(load, POLL_MS);

  const arrivals = data?.arrivals ?? [];
  const next: ArrivalItem | undefined = arrivals[0];
  const rest = arrivals.slice(1, isStation ? 11 : 6);

  // „Elérem?”: a helyzetedből a séta, indulásonként a verdikt; „szólj, ha indulni kell”.
  const catchFor = useCatchFor(stop);
  const nextVerdict = next ? catchFor.verdict(next) : null;
  const nextCatchable =
    next && nextVerdict?.state === "missed" ? arrivals.slice(1).find((a) => a.route === next.route && catchFor.verdict(a)?.state !== "missed") ?? null : null;
  // Ha a busza még az előző menetén késik, a visszaszámlálás a várható (késő) indulásig tart.
  const heroEtaMin =
    f.startRisk && next?.startRisk && next.schedUnix != null
      ? Math.max(next.etaMin, Math.round((expectedArrival(next, catchFor.now).at - catchFor.now) / 60))
      : (next?.etaMin ?? 0);
  const alerts = useAlerts();
  const leaveSlot = next ? `leave:${next.tripId}` : null;
  const leaveOn = Boolean(leaveSlot && alerts.some((a) => a.stopId === stop.id && a.slot === leaveSlot));
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveNote, setLeaveNote] = useState<string | null>(null);
  const toggleLeave = async () => {
    if (!next || !leaveSlot || catchFor.walkS == null) return;
    setLeaveBusy(true);
    setLeaveNote(null);
    try {
      if (leaveOn) await removeAlert(stop.id, leaveSlot);
      else {
        const r = await addAlert({ slot: leaveSlot, kind: "leave", stopId: stop.id, stopName: stop.name, tripId: next.tripId, params: { walkS: catchFor.walkS } });
        if (!r.ok) setLeaveNote(r.reason ?? "Nem sikerült bekapcsolni.");
        else if (!r.push) setLeaveNote(noPushNote(r));
      }
    } finally {
      setLeaveBusy(false);
    }
  };
  // Push nélkül (pl. iOS böngészőben) helyben szólunk, amíg az oldal nyitva van.
  useEffect(() => {
    if (!next || !leaveSlot || !leaveOn || !nextVerdict) return;
    if (nextVerdict.state !== "go" && nextVerdict.state !== "run") return;
    notifyLocallyOnce(stop.id, leaveSlot, next.tripId, nextVerdict.state === "run" ? `Siess! ${next.route} ${next.etaMin} perc múlva` : `Indulj most: ${next.route} ${next.etaMin} perc múlva`, `${stop.name}  ${Math.max(1, Math.round(nextVerdict.walkS / 60))} perc séta`);
  }, [next, leaveSlot, leaveOn, nextVerdict, stop.id, stop.name]);

  return (
    <Card
      data-stop-card={stop.id}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden shadow-lg",
        isNearest && "border-2 border-primary",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3
            className="truncate text-base font-bold tracking-tight"
            title={stop.name}
          >
            {stop.name}
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {distanceKm != null ? (
              <span className="font-semibold text-foreground">
                {formatDistance(distanceKm)}
              </span>
            ) : null}
            {stopKindLabel(stop)}
            {data?.merged ? (
              <>
                <span aria-hidden>·</span>
                <SharedStopTag merged={data.merged} />
              </>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {reorder ? (
            <>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={reorder.onMoveEarlier}
                disabled={!reorder.canMoveEarlier}
                aria-label={`${stop.name} előrébb helyezése`}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={reorder.onMoveLater}
                disabled={!reorder.canMoveLater}
                aria-label={`${stop.name} hátrébb helyezése`}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onFocusMap(stop)}
                aria-label={`${stop.name} megjelenítése a térképen`}
              >
                <Crosshair />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Megjelenítés a térképen</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-8 w-8",
                  isWatching && "text-primary hover:text-primary",
                )}
                onClick={() => setNotifyOpen(true)}
                aria-label={`Értesítés beállítása  ${stop.name}`}
              >
                {isWatching ? <BellRing /> : <Bell />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isWatching ? "Értesítés beállítva" : "Értesítés beállítása"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-destructive/15 hover:text-destructive"
                onClick={() => onRemove(stop.id)}
                aria-label={`${stop.name} levétele a figyelőről`}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Levétel a figyelőről</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <StopNotifyDialog
        open={notifyOpen}
        onOpenChange={setNotifyOpen}
        stopId={stop.id}
        stopName={stop.name}
        arrivals={arrivals}
        onChanged={setIsWatching}
      />

      <div className="border-b border-border bg-muted/30 px-4 py-3.5">
        {error ? (
          <p role="status" className="mb-2.5 flex items-center gap-2 rounded-lg border border-late/30 bg-late/10 px-3 py-2 text-xs">
            <RefreshCw aria-hidden className="h-3.5 w-3.5 shrink-0 text-late motion-safe:animate-spin" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-foreground">Hiba, újracsatlakozás…</span>{" "}
              <span className="text-muted-foreground">{error.reason}</span>
            </span>
            {error.code ? <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">{error.code}</span> : null}
          </p>
        ) : null}
        {!data ? (
          error ? null : (
          <p className="py-6 text-center font-mono text-xs text-muted-foreground">
            Indulások lekérése…
          </p>
          )
        ) : !next ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Ebben az órában nincs több indulás.
          </p>
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Következő
              </span>
              {next.cancelled ? (
                <span className="rounded-md border border-destructive/50 bg-destructive/12 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive">
                  Törölve
                </span>
              ) : (
                <LiveTag live={next.live} />
              )}
            </div>

            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <RouteTile
                  short={arrivalTileText(next)}
                  color={next.color}
                  text={next.text}
                  size="lg"
                />
                <div className="min-w-0 pt-0.5">
                  <p
                    className="truncate text-sm font-semibold"
                    title={arrivalTitle(next)}
                  >
                    {arrivalTitle(next)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn("font-mono text-xs tabular-nums text-muted-foreground", next.cancelled && "line-through decoration-destructive/70 decoration-2")}>
                      {next.time}
                    </span>
                    <PlatformBadge platform={next.platform} changed={next.platformChanged} predicted={next.platformPredicted} mode={next.mode} />
                    {next.cancelled ? null : <DelayBar delaySec={next.delaySec ?? next.measuredDelaySec ?? null} />}
                  </div>
                </div>
              </div>

              {/* Az MVK kihúzta: nem jön, nincs mit visszaszámolni. */}
              {next.cancelled ? (
                <span className="shrink-0 pt-1 text-xs font-semibold text-destructive">nem jön</span>
              ) : (
                <Countdown etaMin={heroEtaMin} />
              )}
            </div>

            <NoticeList notices={next.notices} className="mt-2.5" />
            {next.cancelled && f.replacement ? <ReplacementNote cancelled={next} instead={replacementFor(arrivals, next)} /> : null}
            {!next.vehicle && next.predictedVehicle && showPredicted && !next.cancelled && next.mode !== "rail" ? (
              <p
                className="mt-3 text-[11px] text-muted-foreground"
                title={predictedTitle(next.predictedVehicle)}
              >
                {isLoopVehicle(next.predictedVehicle) ? (
                  <>
                    A{" "}
                    <span className="rounded bg-primary/12 px-1.5 py-px font-mono font-bold tabular-nums text-primary">
                      {displayVehicleId(next.predictedVehicle.id)}
                    </span>{" "}
                    jön: most a végállomás felé tart, onnan fordul vissza
                  </>
                ) : (
                  <>
                    Várhatóan a{" "}
                    <span className="rounded border border-dashed border-primary/50 px-1.5 py-px font-mono font-bold tabular-nums text-primary">
                      {displayVehicleId(next.predictedVehicle.id)}
                    </span>{" "}
                    jön
                  </>
                )}
              </p>
            ) : null}
            {f.forecast ? <ForecastLine className="mt-2.5" mode="worst" delayS={next.forecastDelaySec} upperS={next.forecastUpperSec} /> : null}
            {f.startRisk ? <StartRiskLine risk={next.startRisk} className="mt-2" /> : null}
            {f.traffic ? <TrafficLine traffic={next.trafficAhead} className="mt-2" /> : null}
            <CatchLine
              className="mt-2.5"
              verdict={f.catch ? nextVerdict : null}
              next={nextCatchable}
              alertOn={leaveOn}
              alertBusy={leaveBusy}
              onToggleAlert={toggleLeave}
            />
            {leaveNote && f.catch ? <p className="mt-1 text-[10.5px] text-muted-foreground">{leaveNote}</p> : null}
            {f.vehicleTrack ? (
              <VehicleTrack
                className="mt-3"
                vehicle={next.vehicle}
                label={next.mode === "rail" ? arrivalTileText(next) : null}
                progressDesc={next.progressDesc}
                onTrack={
                  next.vehicle
                    ? () => onFocusMap(stop, next.tripId, next.vehicle?.id)
                    : undefined
                }
              />
            ) : null}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rest.length > 0 ? (
          <ul className="divide-y divide-border/60">
            {rest.map((bus, i) => {
              // Kihúzott menetnél csak akkor visz a térképre, ha mégis jár rajta busz.
              const focusable = bus.live && Boolean(bus.tripId) && (!bus.cancelled || bus.vehicle != null);
              return (
                <li key={`${bus.tripId}-${i}`}>
                  <div
                    role={focusable ? "button" : undefined}
                    tabIndex={focusable ? 0 : undefined}
                    onClick={
                      focusable
                        ? () => onFocusMap(stop, bus.tripId, bus.vehicle?.id)
                        : undefined
                    }
                    onKeyDown={
                      focusable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onFocusMap(stop, bus.tripId, bus.vehicle?.id);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast",
                      focusable &&
                        "cursor-pointer hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <RouteTile
                      short={arrivalTileText(bus)}
                      color={bus.color}
                      text={bus.text}
                    />

                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-xs font-medium"
                        title={arrivalTitle(bus)}
                      >
                        {arrivalTitle(bus)}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <PlatformBadge platform={bus.platform} changed={bus.platformChanged} predicted={bus.platformPredicted} mode={bus.mode} compact />
                        {arrivalVehicleLabel(bus) ? (
                          <span className="rounded bg-primary/12 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary">
                            {arrivalVehicleLabel(bus)}
                          </span>
                        ) : bus.predictedVehicle && showPredicted && !bus.cancelled && bus.mode !== "rail" ? (
                          isLoopVehicle(bus.predictedVehicle) ? (
                            <span
                              className="rounded bg-primary/12 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary"
                              title={predictedTitle(bus.predictedVehicle)}
                            >
                              {displayVehicleId(bus.predictedVehicle.id)}
                            </span>
                          ) : (
                            <span
                              className="rounded border border-dashed border-primary/40 px-1.5 py-px font-mono text-[11px] font-bold tabular-nums text-primary/80"
                              title={predictedTitle(bus.predictedVehicle)}
                            >
                              ~{displayVehicleId(bus.predictedVehicle.id)}
                            </span>
                          )
                        ) : null}
                        {bus.cancelled ? (
                          <span className="rounded bg-destructive/15 px-1.5 py-px text-[10px] font-bold uppercase text-destructive">
                            törölve
                          </span>
                        ) : null}
                        <span className={cn("font-mono text-[11px] tabular-nums text-muted-foreground", bus.cancelled && "line-through decoration-destructive/70")}>
                          {bus.time}
                        </span>
                        {bus.cancelled ? (
                          f.replacement ? <ReplacementNote compact cancelled={bus} instead={replacementFor(arrivals, bus)} /> : null
                        ) : (
                          <DelayBar delaySec={bus.delaySec ?? bus.measuredDelaySec ?? null} showLabel={false} />
                        )}
                        <CatchPill verdict={f.leaveTimes ? catchFor.verdict(bus) : null} />
                      </div>
                      {(f.startRisk && bus.startRisk) || (f.traffic && bus.trafficAhead) ? (
                        <div className="mt-1 flex flex-wrap gap-x-2.5">
                          {f.startRisk ? <StartRiskLine risk={bus.startRisk} compact /> : null}
                          {f.traffic ? <TrafficLine traffic={bus.trafficAhead} compact /> : null}
                        </div>
                      ) : null}
                      {bus.progressDesc ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {bus.progressDesc}
                        </p>
                      ) : null}
                      <NoticeList notices={bus.notices} compact className="mt-1" />
                    </div>

                    <span className="shrink-0 font-mono text-base font-bold tabular-nums">
                      {/* Az MVK kihúzta: nem jön, nincs mit visszaszámolni (mint a fő sorban). */}
                      {bus.cancelled ? (
                        <span className="font-sans text-xs font-semibold text-destructive">nem jön</span>
                      ) : bus.etaMin <= 0 ? (
                        <span className="text-live">most</span>
                      ) : (
                        <>
                          {bus.etaMin}
                          <span className="ml-0.5 font-sans text-[11px] font-semibold text-muted-foreground">
                            p
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : data && next ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
Nincs több ismert indulás.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
