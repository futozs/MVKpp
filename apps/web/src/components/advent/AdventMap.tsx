import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, Crosshair, Layers, Maximize2 } from "lucide-react";
import type { LiveVehicle, Route, Stop } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { usePreference } from "@/hooks/usePreference";
import { cn } from "@/lib/utils";
import { MapControl, MapCorner } from "@/components/map/controls/MapControl";
import { MAP_LOOKS } from "@/components/map/gl/looks";
import type { FocusSpec, LiveMapHandle } from "@/components/map/gl/LiveMap";
import type { AdventMeta, PublicDay, SeasonMeta } from "./adventApi";

const LiveMap = lazy(() => import("@/components/map/gl/LiveMap").then((m) => ({ default: m.LiveMap })));

const GOLD = "E8C66A";
const NAVY = "0F1A3A";
const NONE: never[] = [];
const VIEW = { lat: 48.103, lon: 20.745, zoom: 12.2 };

/**
 * A térkép közepén a szerelvény: élőben követve (2D felülről, 3D mögüle), a vonal
 * aranyban, a többi villamos halványan. Jel nélkül az utolsó ismert helyén áll
 * (halvány jelvénnyel); menet nélkül az egész vonal látszik.
 */
export function AdventMap({
  meta,
  season,
  day,
  tram,
  others,
  routes,
  selectedStop,
  onSelectStop,
  className,
}: {
  meta: AdventMeta;
  season: SeasonMeta;
  day: PublicDay | null;
  tram: LiveVehicle | null;
  others: LiveVehicle[];
  routes: Route[];
  selectedStop: number | null;
  onSelectStop: (i: number) => void;
  className?: string;
}) {
  const geo = useGeo();
  const ref = useRef<LiveMapHandle>(null);
  const [lookId, setLookId] = usePreference<string>("mvk_advent_look", "dark");
  const [three, setThree] = usePreference<boolean>("mvk_advent_3d", false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<"webgl" | "tiles" | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [looksOpen, setLooksOpen] = useState(false);

  const routeMap = useMemo(() => Object.fromEntries(routes.map((r) => [r.id, r])), [routes]);
  const line = meta.line?.out ?? null;
  const running = day?.trips.find((t) => t.verdict === "running") ?? null;
  const dir = day?.now.position?.dir ?? (running ? (running.from === "tiszai" ? "out" : "back") : null);
  const shape = useMemo(() => (line ? (dir === "back" ? [...line].reverse() : line) : null), [line, dir]);
  const routeLines = useMemo(() => (line ? [{ color: GOLD, lines: [line] }] : []), [line]);

  /** a térkép megállói: a menet irányának peronjai (menet nélkül az odafelé irányé) */
  const stops = useMemo<Stop[]>(
    () =>
      season.stops.flatMap((s) => {
        const at = dir === "back" ? s.backAt : s.outAt;
        return at ? [{ id: at.id, code: "", name: s.name, lat: at.lat, lon: at.lon }] : [];
      }),
    [season, dir],
  );
  const selectedId = selectedStop != null ? (stops[selectedStop]?.id ?? null) : null;

  const pos = day?.now.position ?? null;
  const ghost = !tram && pos ? { id: season.vehicleIds[0], lat: pos.lat, lon: pos.lon, motion: null } : null;
  const subject = tram ?? ghost;
  const inService = Boolean(tram) || day?.now.code === "running" || day?.now.code === "at_stop" || day?.now.code === "stalled" || day?.now.code === "breakdown";
  const focus = useMemo<FocusSpec | null>(() => {
    if (!subject || !follow) return null;
    return {
      key: `advent|${day?.iso ?? ""}`,
      shape: inService ? shape : null,
      color: GOLD,
      badge: {
        text: season.routeShorts[0],
        bg: GOLD,
        fg: NAVY,
        mode: "tram",
        tracked: true,
        estimated: !tram,
      },
      label: subject.id,
      vehicle: subject,
    };
  }, [subject, follow, day?.iso, inService, shape, season.routeShorts, tram]);

  // menet nélkül az egész vonal (egyszer, amikor kész a térkép)
  useEffect(() => {
    if (!ready || focus || !line) return;
    ref.current?.fitBounds(line, 15, 36);
  }, [ready, focus, line]);

  const overview = () => {
    setFollow(false);
    if (line) ref.current?.fitBounds(line, 15, 36);
  };
  const followAgain = () => {
    setFollow(true);
    setPaused(false);
    ref.current?.resumeFollow();
  };

  return (
    <div className={cn("relative isolate overflow-hidden rounded-2xl border border-border bg-background", className)}>
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
          {failed === "webgl" ? "Ez a böngésző nem tud térképet rajzolni (WebGL 2 kell)." : "A térkép alapja most nem jött le."}
        </div>
      ) : (
        <Suspense fallback={null}>
          <LiveMap
            ref={ref}
            lookId={lookId}
            three={three}
            initialView={VIEW}
            vehicles={others}
            routes={routeMap}
            watch={NONE}
            vq=""
            labels={false}
            dim
            focus={focus}
            stops={stops}
            watchedStopIds={NONE}
            selectedStopId={selectedId}
            routeLines={routeLines}
            traffic={NONE}
            position={geo.position}
            ridePosition={null}
            onSelectStop={(id) => {
              const i = stops.findIndex((s) => s.id === id);
              if (i >= 0) onSelectStop(i);
            }}
            onFocusTrip={() => undefined}
            onFollowPausedChange={setPaused}
            onViewChange={() => undefined}
            onReady={() => setReady(true)}
            onFail={setFailed}
          />
        </Suspense>
      )}

      <MapCorner corner="top-right">
        <div className="relative">
          <MapControl icon={Layers} label="Alaptérkép" aria-expanded={looksOpen} onClick={() => setLooksOpen((o) => !o)} />
          {looksOpen ? (
            <ul
              className="pointer-events-auto absolute right-0 top-12 z-overlay w-40 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg"
              role="listbox"
              aria-label="Alaptérkép"
            >
              {MAP_LOOKS.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={l.id === lookId}
                    onClick={() => {
                      setLookId(l.id);
                      setLooksOpen(false);
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] font-medium hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    {l.name}
                    {l.id === lookId ? <Check className="h-4 w-4 text-advent-gold" aria-hidden /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <MapControl
          icon={Box}
          label="3D"
          showLabel="always"
          active={three}
          onClick={() => setThree(!three)}
          title={three ? "Felülnézet" : "3D: épületek, domborzat, követés a villamos mögül"}
        />
      </MapCorner>

      {subject ? (
        <MapCorner corner="bottom-right">
          {follow && !paused ? (
            <MapControl icon={Maximize2} label="Az egész vonal" onClick={overview} />
          ) : (
            <MapControl icon={Crosshair} label="Kövesd" showLabel="always" active onClick={followAgain} />
          )}
        </MapCorner>
      ) : null}
    </div>
  );
}
