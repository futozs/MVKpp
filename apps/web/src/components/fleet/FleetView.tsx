import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, History, LoaderCircle, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { addDays, formatClockShort, serviceDayOf, serviceDayRange } from "@/components/map/historyTime";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePreference } from "@/hooks/usePreference";
import type { Route } from "@/types";
import { cn } from "@/lib/utils";
import { NetworkPanel } from "./NetworkPanel";
import { RankList, Segmented, useFleetMode, ON_TIME_S, inMode } from "./RankList";
import { StatusTiles } from "./StatusTiles";
import { TimePanel } from "./TimePanel";
import { RoutePicker } from "./RoutePicker";
import { RouteSummary } from "./RouteSummary";
import { useFleetBoard } from "./useFleetBoard";

type Panel = "list" | "network" | "time";

const nowUnix = () => Math.floor(Date.now() / 1000);

/**
 * Flotta: fent a két hálózat állapota és az idő; alatta három oszlop, mindegyik
 * külön görög: Hálózat (villamosvonal, busz-gerinc) · Rangsor · Idő (a nap
 * görbéje, rekordok, összeomlások). Keskenyebb kijelzőn a rangsor mellett egy
 * oszlop, telefonon fülek. Élőben, vagy visszanézve bármely pillanatra.
 */
export function FleetView({ routes: allRoutes, onFocusTrip }: { routes: Route[]; onFocusTrip?: (tripId: string, vehicleId?: string) => void }) {
  /** null: élő; különben a visszanézett pillanat (unix mp) */
  const [at, setAt] = useState<number | null>(null);
  const { data, failed, loading } = useFleetBoard(at);
  const [mode, setMode] = useFleetMode();
  /** az egész oldal vonalszűrője (üres: minden vonal) */
  const [routes, setRoutes] = usePreference<string[]>("mvk_fleet_routes", []);
  const known = new Set(allRoutes.map((r) => r.short));
  // a menetrendből azóta kikerült vonal ne szűrjön láthatatlanul
  const picked = allRoutes.length ? routes.filter((r) => known.has(r)) : routes;
  const [panel, setPanel] = useState<Panel>("list");
  const isLg = useMediaQuery("(min-width: 1024px)");
  const isXl = useMediaQuery("(min-width: 1280px)");
  const side: Panel = panel === "time" ? "time" : "network";
  const columns: Panel[] = isXl ? ["network", "list", "time"] : isLg ? ["list", side] : [panel];
  // telefonon a rekordból / összeomlásból ugrás a rangsort mutatja (ott látszik az akkori állapot)
  const scroller = useRef<HTMLDivElement>(null);
  const jump = (t: number) => {
    setAt(Math.min(t, nowUnix()));
    if (!isLg) {
      setPanel("list");
      scroller.current?.scrollTo({ top: 0 });
    }
  };

  const vehicles = data ? (picked.length ? data.vehicles.filter((v) => picked.includes(v.route)) : data.vehicles) : [];
  const late = data ? vehicles.filter((v) => inMode(v, mode) && v.delayS >= ON_TIME_S).length : undefined;

  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
      <header className="flex flex-col gap-2 border-b border-border bg-card/60 px-3 py-2.5 sm:px-4 lg:shrink-0 lg:flex-row lg:items-center">
        {data ? <StatusTiles data={data} onOpen={() => setPanel("network")} className="lg:w-[30rem] lg:shrink-0" /> : <div className="h-[58px] rounded-xl bg-muted/40 lg:w-[30rem]" />}
        <RoutePicker routes={allRoutes} value={picked} onChange={setRoutes} className="lg:order-none lg:min-w-[14rem] lg:flex-1" />
        <TimeControl at={at} onAt={setAt} onLive={() => setAt(null)} loading={loading} />
      </header>

      {!isXl ? (
        <div className="px-3 pt-3 sm:px-4">
          <Segmented
            label="Nézet"
            value={isLg ? side : panel}
            onChange={setPanel}
            options={
              isLg
                ? [
                    { id: "network", label: "Hálózat" },
                    { id: "time", label: "Idő és rekordok" },
                  ]
                : [
                    { id: "list", label: "Rangsor", count: late, tone: "text-late" },
                    { id: "network", label: "Hálózat" },
                    { id: "time", label: "Idő" },
                  ]
            }
            className={isLg ? "ml-auto max-w-[min(100%,28rem)]" : undefined}
          />
        </div>
      ) : null}

      {data ? (
        <div
          className={cn(
            "grid gap-4 px-3 py-3 sm:px-4 lg:min-h-0 lg:flex-1 lg:py-0",
            isXl ? "grid-cols-[minmax(320px,0.9fr)_minmax(0,1.4fr)_minmax(340px,1fr)]" : isLg ? "grid-cols-[minmax(0,1.4fr)_minmax(340px,1fr)]" : "grid-cols-1",
          )}
        >
          {columns.map((c) => (
            <div key={c} className={cn("min-w-0 transition-opacity duration-fast lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:py-3", loading && c !== "time" && "opacity-60")}>
              {c === "network" ? <NetworkPanel data={data} routes={picked} /> : null}
              {c === "list" && picked.length ? (
                <RouteSummary routes={picked} vehicles={data.vehicles} date={serviceDayOf(data.at)} past={at != null} allRoutes={allRoutes} />
              ) : null}
              {c === "list" ? (
                <RankList
                  vehicles={vehicles}
                  mode={mode}
                  onMode={setMode}
                  past={at != null ? { t: data.at, date: serviceDayOf(data.at) } : null}
                  onFocusTrip={onFocusTrip}
                  refreshKey={data.at}
                />
              ) : null}
              {c === "time" ? <TimePanel at={at} onAt={jump} routes={picked} allRoutes={allRoutes} /> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2 px-3 py-4 sm:px-4">
          {failed ? (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <CircleAlert className="h-4 w-4" aria-hidden /> A flotta adatai most nem érhetők el. Pár másodperc múlva újra próbálom.
            </p>
          ) : (
            [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[66px] animate-pulse rounded-xl bg-muted/40" />)
          )}
        </div>
      )}
    </div>
  );
}

/** Élő ↔ visszanézés: élőben egy jelzés és a gomb; visszanézéskor nap, idő és vissza élőre. */
function TimeControl({ at, onAt, onLive, loading }: { at: number | null; onAt: (t: number) => void; onLive: () => void; loading: boolean }) {
  if (at == null) {
    return (
      <div className="flex items-center gap-2 lg:ml-auto">
        <span className="flex h-9 items-center gap-2 rounded-lg border border-live/30 bg-live/10 px-3 text-xs font-bold text-live">
          <Radio className="h-3.5 w-3.5" aria-hidden /> Élő
        </span>
        <Button variant="outline" size="sm" className="h-9 flex-1 lg:flex-none" onClick={() => onAt(nowUnix() - 60)}>
          <History />
          Visszanézés
        </Button>
      </div>
    );
  }
  const date = serviceDayOf(at);
  const range = serviceDayRange(date);
  const today = serviceDayOf(nowUnix());
  // ugyanarra az órára a másik napon (a jövőbe nem)
  const goDay = (d: string) => onAt(Math.min(nowUnix(), serviceDayRange(d).start + (at - range.start)));
  return (
    <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Előző nap" onClick={() => goDay(addDays(date, -1))}>
          <ChevronLeft />
        </Button>
        <DateField value={date} onChange={goDay} max={today} today={today} aria-label="Nap" className="h-9 w-[10.5rem]" />
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Következő nap" disabled={date >= today} onClick={() => goDay(addDays(date, 1))}>
          <ChevronRight />
        </Button>
      </div>
      <p className="flex min-w-[4.5rem] items-center gap-1.5 text-[22px] font-extrabold leading-none tracking-tight tabular-nums" aria-live="polite">
        {loading ? <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Betöltés" /> : null}
        {formatClockShort(at)}
      </p>
      <Button size="sm" className="h-9 max-lg:ml-auto" onClick={onLive}>
        <Radio />
        Élőre
      </Button>
    </div>
  );
}
