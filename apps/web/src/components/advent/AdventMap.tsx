import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, Crosshair, History, Layers, Maximize2, Radio } from "lucide-react";
import { replayAt, type ReplayPose } from "@mvk/core/advent/replay";
import type { LiveVehicle, Route, Stop } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { usePreference } from "@/hooks/usePreference";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { MapControl, MapCorner } from "@/components/map/controls/MapControl";
import { MAP_LOOKS } from "@/components/map/gl/looks";
import type { FocusSpec, LiveMapHandle } from "@/components/map/gl/LiveMap";
import { useTimelinePlayback } from "@/components/map/useTimelinePlayback";
import type { RenderResult } from "@/components/map/useHistoryMarkers";
import { useAdventReplay, type AdventMeta, type PublicDay, type SeasonMeta } from "./adventApi";
import { defaultCursor, REPLAY_SPEED, ReplayBar, replayMarks, replayRange, replayStatus, useReplayModel, type ReplayRequest } from "./AdventReplay";
import { LineStrip, type StripReplay } from "./LineStrip";

const LiveMap = lazy(() => import("@/components/map/gl/LiveMap").then((m) => ({ default: m.LiveMap })));

const GOLD = "E8C66A";
const NAVY = "0F1A3A";
const NONE: never[] = [];
const VIEW = { lat: 48.103, lon: 20.745, zoom: 12.2 };

/** a visszajátszott nap: melyik, ma van-e (akkor a jelenig tart), és hova ugorjon */
export type ReplayTarget = { iso: string; today: boolean; request: ReplayRequest | null };

/**
 * A térkép közepén a szerelvény: élőben követve (2D felülről, 3D mögüle), a vonal
 * aranyban, a többi villamos halványan. Jel nélkül az utolsó ismert helyén áll
 * (halvány jelvénnyel); menet nélkül az egész vonal látszik. Visszajátszáskor a
 * nap mozgása megy rajta gyorsítva (sosem lép vissza), alatta a lejátszó sávja;
 * legalul a megállósáv.
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
  replay,
  onReplay,
  onLive,
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
  /** null: élő nézet */
  replay: ReplayTarget | null;
  /** élőben: a mai nap visszanézése */
  onReplay: (() => void) | null;
  /** a mai visszajátszásból vissza az élőbe */
  onLive: (() => void) | null;
  className?: string;
}) {
  const geo = useGeo();
  const ref = useRef<LiveMapHandle>(null);
  const [lookId, setLookId] = usePreference<string>("mvk_advent_look", "dark");
  const [three, setThree] = usePreference<boolean>("mvk_advent_3d", false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<"webgl" | "tiles" | null>(null);
  const [paused, setPaused] = useState(false);
  const [looksOpen, setLooksOpen] = useState(false);

  const routeMap = useMemo(() => Object.fromEntries(routes.map((r) => [r.id, r])), [routes]);
  const line = meta.line?.out ?? null;
  const routeLines = useMemo(() => (line ? [{ color: GOLD, lines: [line] }] : []), [line]);

  // --- visszajátszás ---
  const { replay: data, failed: replayFailed } = useAdventReplay(replay?.iso ?? null, replay?.today ?? false);
  const model = useReplayModel(data, season);
  const range = useMemo(() => (model ? replayRange(day, model.data) : null), [model, day]);
  const limit = range ? (replay?.today ? Math.max(range.start, Math.min(range.end, Math.floor(serverNow()))) : range.end) : 0;
  const poseRef = useRef<ReplayPose | null>(null);
  const render = useCallback(
    (t: number): RenderResult => {
      if (!model) return { ready: false, visible: 0 };
      poseRef.current = replayAt(model.data, model.shapes, t);
      // a kamera követés nélkül is lássa a mozgást (a térkép magától ritkán rajzol)
      ref.current?.map()?.triggerRepaint();
      return { ready: true, visible: poseRef.current ? 1 : 0 };
    },
    [model],
  );
  const hasData = useCallback(() => model != null, [model]);
  const bounds = { start: range?.start ?? 0, limit };
  const playback = useTimelinePlayback(bounds.start, bounds, hasData, render, REPLAY_SPEED);
  const { invalidate, seek, togglePlay, playing } = playback;

  useEffect(() => {
    invalidate();
  }, [model, invalidate]);

  // új nap vagy új kérés (indulás, zavar): oda ugrik, és ha kérték, indul
  const seekKey = replay && model && range ? `${model.data.date}|${replay.request?.n ?? 0}` : null;
  const seeked = useRef<string | null>(null);
  useEffect(() => {
    if (!seekKey || !replay || !model || !range || seeked.current === seekKey) return;
    seeked.current = seekKey;
    const req = replay.request;
    seek(req ? req.t : defaultCursor(model.data, range, replay.today), { start: range.start, limit });
    if (Boolean(req?.play) !== playing) togglePlay();
  }, [seekKey, replay, model, range, limit, seek, playing, togglePlay]);

  // vissza az élőbe: a lejátszás megáll
  useEffect(() => {
    if (replay) return;
    seeked.current = null;
    poseRef.current = null;
    if (playing) togglePlay();
  }, [replay, playing, togglePlay]);

  const pose = replay && model ? replayAt(model.data, model.shapes, playback.cursor) : null;
  const replayOn = replay != null;
  const rDir = pose?.dir ?? null;
  const rInLeg = pose?.leg != null;
  const rFresh = pose?.fresh ?? false;
  const rHas = pose != null;

  // --- élő ---
  const running = day?.trips.find((t) => t.verdict === "running") ?? null;
  const liveDir = day?.now.position?.dir ?? (running ? (running.from === "tiszai" ? "out" : "back") : null);
  const dir = replayOn ? rDir : liveDir;
  const shape = useMemo(() => (line ? (liveDir === "back" ? [...line].reverse() : line) : null), [line, liveDir]);

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
  const liveFocus = useMemo<FocusSpec | null>(() => {
    if (!subject) return null;
    return {
      key: `advent|${day?.iso ?? ""}`,
      shape: inService ? shape : null,
      color: GOLD,
      badge: { text: season.routeShorts[0], bg: GOLD, fg: NAVY, mode: "tram", tracked: true, estimated: !tram },
      label: subject.id,
      vehicle: subject,
    };
  }, [subject, day?.iso, inService, shape, season.routeShorts, tram]);

  const replayFocus = useMemo<FocusSpec | null>(() => {
    if (!replay || !model?.home || !rHas) return null;
    const [lat, lon] = model.home;
    const id = season.vehicleIds[0];
    return {
      key: `advent-replay|${model.data.date}`,
      shape: rInLeg && rDir ? model.data.shapes[rDir] : null,
      color: GOLD,
      badge: { text: season.routeShorts[0], bg: GOLD, fg: NAVY, mode: "tram", tracked: true, estimated: !rFresh },
      label: id,
      vehicle: { id, lat, lon, motion: null },
      pose: () => poseRef.current,
    };
  }, [replay, model, rHas, rInLeg, rDir, rFresh, season.vehicleIds, season.routeShorts]);

  const focus = replayOn ? replayFocus : liveFocus;

  // a követés újraindul (élő ↔ visszajátszás, másik nap): a „Kövesd” gomb is
  const focusKey = focus?.key ?? null;
  useEffect(() => setPaused(false), [focusKey]);

  // menet nélkül az egész vonal (egyszer, amikor kész a térkép)
  useEffect(() => {
    if (!ready || focus || !line) return;
    ref.current?.fitBounds(line, 15, 36);
  }, [ready, focus, line]);

  const overview = () => {
    ref.current?.pauseFollow();
    if (line) ref.current?.fitBounds(line, 15, 36);
  };

  let strip: StripReplay | null = null;
  if (pose && model) {
    const along = model.stopsM[pose.dir];
    const passed = new Set<number>();
    let nextStop: number | null = null;
    if (pose.leg != null)
      along.forEach((m, i) => {
        if (m <= pose.m + 5) passed.add(i);
        else if (nextStop == null || m < along[nextStop]) nextStop = i;
      });
    strip = { lat: pose.lat, lon: pose.lon, dir: pose.dir, inLeg: pose.leg != null, passed, nextStop };
  }

  const status = model ? replayStatus(pose, model, day, season, playback.cursor) : { chip: null, text: "" };
  const marks = useMemo(() => (model ? replayMarks(day, model.data) : []), [model, day]);

  return (
    <>
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
              vehicles={replayOn ? NONE : others}
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

        {onLive || onReplay ? (
          <MapCorner corner="top-left">
            {onLive ? (
              <MapControl icon={Radio} label="Élő" showLabel="always" onClick={onLive} title="Vissza az élő nézetbe" />
            ) : onReplay ? (
              <MapControl icon={History} label="Visszanézés" showLabel="wide" onClick={onReplay} title="A mai nap visszajátszása" />
            ) : null}
          </MapCorner>
        ) : null}

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

        {focus ? (
          <MapCorner corner="bottom-right">
            {!paused ? (
              <MapControl icon={Maximize2} label="Az egész vonal" onClick={overview} />
            ) : (
              <MapControl icon={Crosshair} label="Kövesd" showLabel="always" active onClick={() => ref.current?.resumeFollow()} />
            )}
          </MapCorner>
        ) : null}
      </div>

      {replay ? (
        <ReplayBar
          playback={playback}
          range={range}
          limit={limit}
          marks={marks}
          status={status}
          state={model ? "ready" : replayFailed ? "failed" : "loading"}
          liveRef={ref}
        />
      ) : null}
      <LineStrip meta={meta} season={season} day={day} selected={selectedStop} onSelect={onSelectStop} replay={strip} />
    </>
  );
}
