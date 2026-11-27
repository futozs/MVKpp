import { useMemo, useRef } from "react";
import { Pause, Play } from "lucide-react";
import { ProjectedShape } from "@mvk/core/geo";
import type { ReplayDir, ReplayPose, ReplayShapes } from "@mvk/core/advent/replay";
import { END_LABEL, type AdventEnd } from "@mvk/core/advent/season";
import type { LiveMapHandle } from "@/components/map/gl/LiveMap";
import { formatClock, formatClockShort, type ServiceDayRange } from "@/components/map/historyTime";
import { TimelineSlider, type SliderMark } from "@/components/map/TimelineSlider";
import type { Playback } from "@/components/map/useTimelinePlayback";
import { useTimelineKeys } from "@/components/map/useTimelineKeys";
import { cn } from "@/lib/utils";
import type { PublicDay, ReplayResp, SeasonMeta } from "./adventApi";
import { hm } from "./adventText";

export const REPLAY_SPEEDS = [10, 30, 60];
export const REPLAY_SPEED = 30;

/** ide ugorjon a visszajátszás, és induljon-e el (`n`: ugyanarra újra koppintva is ugrik) */
export type ReplayRequest = { t: number; play: boolean; n: number };

export type ReplayModel = {
  data: ReplayResp;
  shapes: ReplayShapes;
  /** a megállók helye irányonként a menet nyomvonalán (m), a season.stops sorrendjében */
  stopsM: Record<ReplayDir, number[]>;
  /** ahol a villamos a nap első menete előtt áll */
  home: [number, number] | null;
};

export function useReplayModel(data: ReplayResp | null, season: SeasonMeta): ReplayModel | null {
  return useMemo(() => {
    if (!data) return null;
    const shapes: ReplayShapes = { out: new ProjectedShape(data.shapes.out), back: new ProjectedShape(data.shapes.back) };
    const along = (dir: ReplayDir) =>
      season.stops.map((s) => {
        const g = dir === "out" ? s.outAt : s.backAt;
        return g ? (shapes[dir].project(g.lat, g.lon)?.alongM ?? NaN) : NaN;
      });
    const first = data.legs.find((l) => l.pts.length);
    return { data, shapes, stopsM: { out: along("out"), back: along("back") }, home: first ? shapes[first.dir].pointAt(first.pts[0][1]) : null };
  }, [data, season]);
}

const HOUR = 3600;
/** a csúszka ennyivel tágabb a nap első és utolsó mozzanatánál (mp) */
const PAD_S = 10 * 60;

/** a csúszka: a menetrend és a ténylegesen megtett menetek köre, egész órákra kerekítve */
export function replayRange(day: PublicDay | null, data: ReplayResp): ServiceDayRange | null {
  const ts: number[] = [];
  for (const l of data.legs) if (l.pts.length) ts.push(l.pts[0][0], l.pts[l.pts.length - 1][0]);
  for (const t of day?.trips ?? []) ts.push(t.sched.dep, t.sched.arr);
  if (!ts.length) return null;
  return {
    day: data.date,
    start: Math.floor((Math.min(...ts) - PAD_S) / HOUR) * HOUR,
    end: Math.ceil((Math.max(...ts) + PAD_S) / HOUR) * HOUR,
  };
}

/** a csúszka jelölései: a menetek aranyban, az állások és a zavarok a súlyuk színével */
export function replayMarks(day: PublicDay | null, data: ReplayResp): SliderMark[] {
  const out: SliderMark[] = [];
  data.legs.forEach((l, i) => {
    if (l.pts.length > 1) out.push({ key: `leg${i}`, from: l.pts[0][0], to: l.pts[l.pts.length - 1][0], className: "bg-advent-gold/45" });
  });
  day?.legs.forEach((l, i) => l.stalls.forEach((s) => out.push({ key: `stall${i}-${s.from}`, from: s.from, to: s.to, className: "bg-nosignal" })));
  for (const inc of day?.incidents ?? []) {
    if (inc.severity === "info") continue;
    out.push({ key: `inc-${inc.kind}-${inc.from}`, from: inc.from, to: inc.to ?? inc.from, className: inc.severity === "bad" ? "bg-late" : "bg-nosignal" });
  }
  return out;
}

/** hova álljon a visszajátszás magától: ma a legutóbb indult menet, máskor a nap első menete előtt */
export function defaultCursor(data: ReplayResp, range: ServiceDayRange, today: boolean): number {
  const starts = data.legs.filter((l) => l.pts.length).map((l) => l.pts[0][0]);
  const pick = today ? starts[starts.length - 1] : starts[0];
  return pick != null ? Math.max(range.start, pick - 60) : range.start;
}

const TOWARDS: Record<AdventEnd, string> = { tiszai: "Tiszai pályaudvar felé", majlath: "Felső-Majláth felé" };
/** ennyin belül a megállóban áll (m) */
const AT_STOP_M = 35;

/** mi történik a kurzornál, egy sorban: merre megy, melyik megálló jön, áll-e */
export function replayStatus(pose: ReplayPose | null, model: ReplayModel, day: PublicDay | null, season: SeasonMeta, t: number): { chip: string | null; text: string } {
  const silent = pose && !pose.fresh ? " · nincs jel" : "";
  if (!pose) return { chip: null, text: "Ezen a napon nem látszott a villamos mozgása" };
  const leg = model.data.legs[pose.near];
  const nextTrip = day?.trips.find((x) => x.sched.dep > t && x.verdict !== "cancelled") ?? null;
  const then = nextTrip ? ` · indul ${hm(nextTrip.sched.dep)}` : "";
  if (pose.leg == null) {
    const before = t < leg.pts[0][0];
    const end = before ? leg.from : leg.to;
    if (before && pose.near === model.data.legs.findIndex((l) => l.pts.length)) return { chip: null, text: `Még nem indult${then}${silent}` };
    return { chip: null, text: `Áll: ${end ? END_LABEL[end] : stopName(model, season, pose)}${then}${silent}` };
  }
  const trip = day?.trips.find((x) => x.leg === pose.leg) ?? null;
  const chip = trip ? hm(trip.sched.dep) : "soron kívül";
  const towards = TOWARDS[pose.dir === "out" ? "majlath" : "tiszai"];
  const stall = day?.legs[pose.leg]?.stalls.find((s) => t >= s.from && t <= s.to);
  if (stall) return { chip, text: `Áll ${Math.max(1, Math.round((t - stall.from) / 60))} perce · ${season.stops[stall.nearStop].name} közelében${silent}` };
  const stops = model.stopsM[pose.dir];
  const order = stops.map((m, i) => ({ m, i })).filter((s) => Number.isFinite(s.m)).sort((a, b) => a.m - b.m);
  const at = order.find((s) => Math.abs(s.m - pose.m) <= AT_STOP_M);
  if (at) return { chip, text: `${towards} · megálló: ${season.stops[at.i].name}${silent}` };
  const next = order.find((s) => s.m > pose.m);
  return { chip, text: `${towards}${next ? ` · következő: ${season.stops[next.i].name}` : ""}${silent}` };
}

function stopName(model: ReplayModel, season: SeasonMeta, pose: ReplayPose): string {
  const stops = model.stopsM[pose.dir];
  let best = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - pose.m) < Math.abs(stops[best] - pose.m)) best = i;
  return season.stops[best].name;
}

/**
 * A visszajátszás sávja a térkép alatt: lejátszás, az idő és hogy mi történik, a
 * sebesség, és a nap csúszkája a menetekkel, állásokkal és zavarokkal.
 */
export function ReplayBar({
  playback,
  range,
  limit,
  marks,
  status,
  state,
  liveRef,
}: {
  playback: Playback;
  range: ServiceDayRange | null;
  limit: number;
  marks: SliderMark[];
  status: { chip: string | null; text: string };
  state: "ready" | "loading" | "failed";
  liveRef: React.RefObject<LiveMapHandle | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { cursor, playing, speed, togglePlay, step, seek } = playback;
  useTimelineKeys(rootRef, liveRef, togglePlay, step, false);

  if (state !== "ready" || !range)
    return (
      <div className="border-t border-border px-3 py-3 text-[13px] text-muted-foreground" role="status">
        {state === "failed" ? "A visszajátszás most nem jött le." : state === "loading" ? "A nap mozgása töltődik…" : "Erről a napról nincs mit visszajátszani."}
      </div>
    );

  const hours = (range.end - range.start) / HOUR;
  return (
    <div ref={rootRef} className="border-t border-border px-3 pb-1 pt-2.5" aria-label="Visszajátszás" role="group">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Szünet" : "Lejátszás"}
          aria-keyshortcuts="Space"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-advent-gold text-advent-navy shadow-sm transition-transform duration-fast hover:brightness-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          {playing ? <Pause className="h-5 w-5 fill-current" aria-hidden /> : <Play className="h-5 w-5 translate-x-px fill-current" aria-hidden />}
        </button>
        <p className="font-mono text-[24px] font-bold leading-none tracking-tight tabular-nums" aria-live="off">
          {formatClock(cursor)}
        </p>
        <p className="order-last flex min-w-0 basis-full items-center gap-1.5 text-[12.5px]">
          {status.chip ? (
            <span className="shrink-0 rounded border border-advent-gold/45 px-1 font-mono text-[11.5px] font-bold tabular-nums text-advent-gold">{status.chip}</span>
          ) : null}
          <span className="truncate text-muted-foreground">{status.text}</span>
        </p>
        <div role="group" aria-label="Lejátszási sebesség" className="ml-auto grid h-9 shrink-0 grid-cols-3 gap-0.5 rounded-lg border border-border bg-background/60 p-0.5">
          {REPLAY_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => playback.setSpeed(s)}
              aria-pressed={speed === s}
              className={cn(
                "min-w-[40px] rounded-md px-1.5 font-mono text-xs font-semibold tabular-nums transition-colors duration-fast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                speed === s ? "bg-advent-gold text-advent-navy shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <div className="-mx-4 mt-0.5">
        <TimelineSlider
          range={range}
          value={cursor}
          maxValue={limit}
          valueText={`${formatClockShort(cursor)}, ${status.text}`}
          compact
          majorEvery={hours <= 9 ? 1 : 3}
          marks={marks}
          accent="gold"
          onScrub={(t) => seek(t)}
          onScrubStart={playback.scrubStart}
          onScrubEnd={playback.scrubEnd}
        />
      </div>
    </div>
  );
}
