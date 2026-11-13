import { useEffect, useState } from "react";
import { Bus, RefreshCw } from "lucide-react";
import type { WeatherResponse } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRealtimeConnected } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { HeaderPopover } from "./HeaderPopover";
import { FOCUS_RING_INSET } from "./headerStyles";
import { formatTemp, weatherExtras } from "./WeatherReadout";

/** Ennyi idő után az utolsó járműadatot „régi”-nek jelöljük. */
const STALE_AFTER_MS = 2 * 60_000;
/** A kor-kijelzés ennyi időnként frissül (nem kell másodpercre pontos). */
const CLOCK_TICK_MS = 15_000;
/**
 * Betöltéskor ennyi ideig semleges a „Kapcsolódás…”  a csatorna általában
 * egy pillanat alatt felépül, ne villanjon fel minden indításkor figyelmeztetés.
 */
const CONNECT_GRACE_MS = 3_000;

type LinkState = "live" | "connecting" | "reconnecting";

const STATE_COPY: Record<LinkState, { label: string; title: string; body: string }> = {
  live: {
    label: "Élő",
    title: "Élő kapcsolat",
    body: "A szerver azonnal küldi a járműpozíciókat, amint változnak  nem kell kézzel frissíteni.",
  },
  connecting: {
    label: "Kapcsolódás…",
    title: "Kapcsolódás…",
    body: "Épül a valós idejű csatorna. Addig néhány másodpercenként lekérdezéssel frissítünk.",
  },
  reconnecting: {
    label: "Újracsatlakozás…",
    title: "Újracsatlakozás…",
    body: "Megszakadt a valós idejű csatorna. Amíg helyreáll, néhány másodpercenként lekérdezéssel frissítünk, így a pozíciók kicsit késhetnek.",
  },
};

function formatClock(d: Date, withSeconds: boolean): string {
  return d.toLocaleTimeString("hu-HU", {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface LiveStatusModel {
  state: LinkState;
  isStale: boolean;
  ageMin: number | null;
}

/** Színek állapotonként: zöld = élő, semleges = épp kapcsolódik, borostyán = kiesés. */
const STATE_TONE: Record<LinkState, { text: string; dot: string; segment: string; pill: string }> = {
  live: {
    text: "text-live",
    dot: "bg-live",
    segment: "",
    pill: "border-border bg-background/70",
  },
  connecting: {
    text: "text-muted-foreground",
    dot: "bg-muted-foreground motion-safe:animate-pulse",
    segment: "",
    pill: "border-border bg-background/70",
  },
  reconnecting: {
    text: "text-amber-300",
    dot: "bg-amber-400 motion-safe:animate-pulse",
    segment: "bg-amber-400/10",
    pill: "border-amber-400/30 bg-amber-400/10",
  },
};

/**
 * Az igazat mondja: „Élő” csak akkor, ha a WebSocket-csatorna tényleg fent
 * van. Indításkor rövid ideig „Kapcsolódás…”; ha a csatorna ezalatt nem épül
 * fel, vagy később megszakad: „Újracsatlakozás…” (ilyenkor pollozó tartalék fut).
 */
function useLiveStatus(lastUpdated: Date | null): LiveStatusModel {
  const connected = useRealtimeConnected();
  const [hasConnected, setHasConnected] = useState(connected);
  if (connected && !hasConnected) setHasConnected(true);

  const [inGrace, setInGrace] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setInGrace(false), CONNECT_GRACE_MS);
    return () => clearTimeout(id);
  }, []);

  const now = useNow(CLOCK_TICK_MS);
  const ageMs = lastUpdated ? Math.max(0, now - lastUpdated.getTime()) : null;

  const state: LinkState = connected
    ? "live"
    : !hasConnected && inGrace
      ? "connecting"
      : "reconnecting";

  return {
    state,
    isStale: ageMs != null && ageMs > STALE_AFTER_MS,
    ageMin: ageMs == null ? null : Math.floor(ageMs / 60_000),
  };
}

function StatusDot({ state }: { state: LinkState }) {
  return (
    <span aria-hidden className="relative flex h-2 w-2 shrink-0">
      {state === "live" ? (
        <span className="absolute inset-0 rounded-full bg-live motion-safe:animate-live-pulse" />
      ) : null}
      <span className={cn("relative h-2 w-2 rounded-full", STATE_TONE[state].dot)} />
    </span>
  );
}

interface DetailsProps {
  status: LiveStatusModel;
  vehicleCount: number;
  lastUpdated: Date | null;
  weather?: WeatherResponse | null;
}

/** Magyarázat: mit jelent az állapot, és honnan jön a szám. */
function LiveStatusDetails({ status, vehicleCount, lastUpdated, weather }: DetailsProps) {
  const copy = STATE_COPY[status.state];
  return (
    <div className="space-y-2.5 text-left">
      <p
        className={cn(
          "flex items-center gap-2 text-[13px] font-semibold",
          status.state === "reconnecting" ? STATE_TONE.reconnecting.text : "text-foreground",
        )}
      >
        <StatusDot state={status.state} />
        {copy.title}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{copy.body}</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-t border-border pt-2.5 text-xs">
        <dt className="text-muted-foreground">Élő járművek</dt>
        <dd className="text-right font-mono font-semibold tabular-nums text-foreground">
          {vehicleCount}
        </dd>
        <dt className="text-muted-foreground">Utolsó adat</dt>
        <dd
          className={cn(
            "text-right font-mono font-semibold tabular-nums",
            status.isStale ? "text-amber-300" : "text-foreground",
          )}
        >
          {lastUpdated ? formatClock(lastUpdated, true) : ""}
          {status.isStale && status.ageMin != null ? (
            <span className="ml-1.5 font-sans font-medium">· {status.ageMin} perce</span>
          ) : null}
        </dd>
        {weather?.tempC != null ? (
          <>
            <dt className="text-muted-foreground">Időjárás</dt>
            <dd className="text-right text-foreground">
              <span className="font-mono font-semibold tabular-nums">
                {formatTemp(weather.tempC)}
              </span>
              <span className="ml-1.5 text-muted-foreground">{weather.text}</span>
            </dd>
          </>
        ) : null}
      </dl>
      {weather?.tempC != null && weatherExtras(weather) ? (
        <p className="text-right text-[11px] text-muted-foreground">
          Miskolc · {weatherExtras(weather)}
        </p>
      ) : null}
    </div>
  );
}

/** Képernyőolvasónak: „Élő kapcsolat. 88 jármű, utolsó adat 01:08:24” */
function summary(status: LiveStatusModel, vehicleCount: number, lastUpdated: Date | null): string {
  const time = lastUpdated ? `, utolsó adat ${formatClock(lastUpdated, true)}` : "";
  return `${STATE_COPY[status.state].title.replace("…", "")}. ${vehicleCount} jármű${time}`;
}

const DETAILS_TOOLTIP =
  "w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg";

interface LiveStatusProps {
  vehicleCount: number;
  lastUpdated: Date | null;
  isRefreshing: boolean;
  onManualRefresh: () => void;
}

/**
 * Asztali állapotsáv: [● Élő | busz 88 | 01:08:24 | ⟳]. A frissítés gomb
 * azért ül itt, mert az időbélyeghez tartozik  ugyanarról az adatról szól.
 */
export function LiveStatus({
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
}: LiveStatusProps) {
  const status = useLiveStatus(lastUpdated);
  const isLive = status.state === "live";

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-hidden rounded-md border border-border bg-background/70 text-xs">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="group"
            tabIndex={0}
            aria-label={summary(status, vehicleCount, lastUpdated)}
            className={cn("flex items-stretch", FOCUS_RING_INSET)}
          >
            <span
              className={cn(
                "flex items-center gap-2 whitespace-nowrap px-2 font-semibold lg:px-2.5",
                STATE_TONE[status.state].text,
                STATE_TONE[status.state].segment,
              )}
            >
              <StatusDot state={status.state} />
              {STATE_COPY[status.state].label}
            </span>
            <span
              className={cn(
                "items-center gap-1.5 whitespace-nowrap border-l border-border px-2 lg:px-2.5",
                isLive ? "flex" : "hidden lg:flex",
              )}
            >
              <Bus aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {vehicleCount}
              </span>
            </span>
            {lastUpdated ? (
              <span
                className={cn(
                  "hidden items-center border-l border-border px-2.5 font-mono tabular-nums",
                  isLive ? "lg:flex" : "xl:flex",
                  status.isStale ? "text-amber-300" : "text-muted-foreground",
                )}
              >
                <span className="xl:hidden">{formatClock(lastUpdated, false)}</span>
                <span className="hidden xl:inline">{formatClock(lastUpdated, true)}</span>
              </span>
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8} className={DETAILS_TOOLTIP}>
          <LiveStatusDetails
            status={status}
            vehicleCount={vehicleCount}
            lastUpdated={lastUpdated}
          />
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onManualRefresh}
            disabled={isRefreshing}
            aria-label="Járműpozíciók azonnali lekérése"
            className={cn(
              "flex w-8 items-center justify-center border-l border-border text-muted-foreground transition-colors duration-fast lg:w-9",
              "hover:bg-accent hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent",
              FOCUS_RING_INSET,
            )}
          >
            <RefreshCw
              aria-hidden
              className={cn(
                "h-3.5 w-3.5",
                isRefreshing && "text-primary motion-safe:animate-spin",
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Azonnali frissítés</TooltipContent>
      </Tooltip>
    </div>
  );
}

interface LiveStatusCompactProps extends LiveStatusProps {
  weather?: WeatherResponse | null;
}

/**
 * Mobil változat. Érintőképernyőn nincs tooltip, ezért koppintásra egy
 * panel nyílik a magyarázattal és a kézi frissítéssel.
 */
export function LiveStatusCompact({
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
  weather,
}: LiveStatusCompactProps) {
  const status = useLiveStatus(lastUpdated);
  const isLive = status.state === "live";

  return (
    <HeaderPopover
      label="Kapcsolat állapota"
      anchorToParent
      className="flex min-w-0"
      transformOrigin="top left"
      panelClassName="inset-x-2 top-[calc(100%+2px)] p-3.5"
      renderTrigger={(trigger) => (
        <button
          type="button"
          {...trigger}
          aria-label={`${summary(status, vehicleCount, lastUpdated)}. Részletek`}
          className="group flex h-11 min-w-0 shrink items-center rounded-md outline-none"
        >
          <span
            className={cn(
              "flex h-8 min-w-0 items-center gap-2 rounded-md border px-2 text-xs transition-colors duration-fast min-[375px]:px-2.5",
              "group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card",
              "group-active:bg-accent",
              STATE_TONE[status.state].pill,
            )}
          >
            <StatusDot state={status.state} />
            <span
              className={cn("truncate font-semibold", STATE_TONE[status.state].text)}
            >
              {STATE_COPY[status.state].label}
            </span>
            {isLive ? (
              <>
                <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
                <span className="flex shrink-0 items-center gap-1">
                  <Bus aria-hidden className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono font-semibold tabular-nums text-foreground">
                    {vehicleCount}
                  </span>
                </span>
              </>
            ) : null}
            {lastUpdated ? (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "h-3.5 w-px shrink-0 bg-border",
                    isLive ? "hidden min-[375px]:block" : "hidden min-[400px]:block",
                  )}
                />
                <span
                  className={cn(
                    "shrink-0 font-mono tabular-nums",
                    status.isStale ? "text-amber-300" : "text-muted-foreground",
                    // Nagyon keskeny kijelzőn az idő a panelen olvasható.
                    isLive ? "hidden min-[375px]:inline" : "hidden min-[400px]:inline",
                  )}
                >
                  {formatClock(lastUpdated, false)}
                </span>
              </>
            ) : null}
          </span>
        </button>
      )}
    >
      {() => (
        <>
          <LiveStatusDetails
            status={status}
            vehicleCount={vehicleCount}
            lastUpdated={lastUpdated}
            weather={weather}
          />
          <Button
            variant="outline"
            className="mt-3.5 h-11 w-full"
            onClick={onManualRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              aria-hidden
              className={cn(isRefreshing && "text-primary motion-safe:animate-spin")}
            />
            {isRefreshing ? "Frissítés…" : "Frissítés most"}
          </Button>
        </>
      )}
    </HeaderPopover>
  );
}
