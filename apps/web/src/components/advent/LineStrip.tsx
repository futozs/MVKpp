import { useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AdventNow } from "@mvk/core/advent/day";
import { cn } from "@/lib/utils";
import type { AdventMeta, PublicDay, SeasonMeta } from "./adventApi";
import { hm } from "./adventText";

/** a vonal pontjai mentén mért hossz (m), és egy pont helye rajta */
function chainage(line: [number, number][]) {
  const cum = [0];
  const k = Math.cos((48.1 * Math.PI) / 180) * 111_320;
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot((line[i][0] - line[i - 1][0]) * 111_320, (line[i][1] - line[i - 1][1]) * k));
  const at = (lat: number, lon: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = Math.hypot((line[i][0] - lat) * 111_320, (line[i][1] - lon) * k);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return cum[best];
  };
  return { length: cum[cum.length - 1] || 1, at };
}

/**
 * A 23 megálló egy sávon, a térképpel egy irányban (nyugat balra: Felső-Majláth,
 * kelet jobbra: Tiszai). A villamos a nyomvonal szerinti helyén; a menet közben
 * megtett megállók aranyak. A jelölő egy menetben sosem lép vissza.
 */
/** visszajátszáskor a villamos a kurzornál (a térképpel egy ütemben) */
export type StripReplay = {
  lat: number;
  lon: number;
  dir: "out" | "back";
  /** menet közben (különben a végállomáson vagy egy menet végén áll) */
  inLeg: boolean;
  passed: Set<number>;
  nextStop: number | null;
};

export function LineStrip({
  meta,
  season,
  day,
  selected,
  onSelect,
  replay,
}: {
  meta: AdventMeta;
  season: SeasonMeta;
  day: PublicDay | null;
  selected: number | null;
  onSelect: (i: number) => void;
  replay: StripReplay | null;
}) {
  const geo = useMemo(() => {
    if (!meta.line) return null;
    const c = chainage(meta.line.out);
    const x = season.stops.map((s) => {
      const a = s.outAt;
      return a ? c.at(a.lat, a.lon) / c.length : 0;
    });
    return { length: c.length, x, at: c.at };
  }, [meta.line, season]);

  const now: AdventNow | null = day?.now ?? null;
  const pos = now?.position ?? null;
  const running = day?.trips.find((t) => t.verdict === "running") ?? null;
  const passed = replay ? replay.passed : new Set((running?.stops ?? []).filter((s) => s.arr != null || s.dep != null).map((s) => s.stop));
  const nextStop = replay ? replay.nextStop : (pos?.nextStop ?? null);
  const dir = replay ? replay.dir : (pos?.dir ?? null);
  /** a megtett rész iránya: Tiszairól indulva jobbról balra telik */
  const progressFrom = replay ? (replay.inLeg ? (replay.dir === "out" ? "tiszai" : "majlath") : null) : (running?.from ?? null);

  // a menet legjobb helye: a visszaugró jel nem viszi hátrébb a jelölőt (a visszajátszás eleve sosem lép vissza)
  const best = useRef<{ key: string; f: number } | null>(null);
  let frac: number | null = null;
  if (replay && geo) frac = Math.min(1, Math.max(0, geo.at(replay.lat, replay.lon) / geo.length));
  else if (pos && geo && pos.ageS < 15 * 60) {
    const f = Math.min(1, Math.max(0, pos.m / geo.length));
    const key = running?.key ?? `idle:${pos.place}`;
    const sign = pos.dir === "back" ? -1 : 1;
    const prev = best.current;
    frac = prev && prev.key === key && running && (prev.f - f) * sign > 0 ? prev.f : f;
    best.current = { key, f: frac };
  }

  if (!geo) return null;
  // nyugat balra: a Tiszai (a vonal eleje) a jobb szélen
  const left = (f: number) => `${(1 - f) * 100}%`;
  const towardWest = dir === "out";

  return (
    <div className="relative select-none px-4 pb-2 pt-3">
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-[13px] h-[3px] rounded-full bg-border" aria-hidden />
        {progressFrom && frac != null ? (
          <div
            aria-hidden
            className="absolute top-[13px] h-[3px] rounded-full bg-advent-gold/70"
            style={progressFrom === "tiszai" ? { left: left(frac), right: 0 } : { left: 0, right: `${frac * 100}%` }}
          />
        ) : null}
        {season.stops.map((s, i) => {
          const isPassed = passed.has(i);
          const isNext = nextStop === i;
          const isSel = selected === i;
          return (
            <button
              key={s.out}
              type="button"
              onClick={() => onSelect(i)}
              aria-label={`${s.name}${isNext ? ", a következő megálló" : ""}`}
              aria-pressed={isSel}
              className="group absolute top-0 flex h-8 w-5 -translate-x-1/2 items-start justify-center pt-[9px] focus-visible:outline-none"
              style={{ left: left(geo.x[i]) }}
            >
              <span
                className={cn(
                  "block h-[11px] w-[11px] rounded-full border-2 transition-transform duration-fast group-hover:scale-125 group-focus-visible:ring-2 group-focus-visible:ring-ring",
                  isPassed ? "border-advent-gold bg-advent-gold" : "border-muted-foreground/60 bg-background",
                  isNext && "border-advent-gold bg-background",
                  isSel && "scale-125 border-foreground bg-foreground",
                  (i === 0 || i === season.stops.length - 1) && "h-[13px] w-[13px] -mt-px",
                )}
              />
            </button>
          );
        })}
        {frac != null ? (
          <div
            className={cn(
              "pointer-events-none absolute top-[2px] -translate-x-1/2",
              !replay && "transition-[left] duration-700 ease-out motion-reduce:transition-none",
            )}
            style={{ left: left(frac) }}
          >
            <span className="flex h-[25px] items-center gap-0.5 rounded-md bg-advent-gold px-1.5 font-mono text-[10.5px] font-bold text-advent-navy shadow-md">
              {dir && towardWest ? <ChevronLeft className="h-3 w-3" strokeWidth={3} aria-hidden /> : null}
              {season.routeShorts[0]}
              {dir && !towardWest ? <ChevronRight className="h-3 w-3" strokeWidth={3} aria-hidden /> : null}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[11px] font-semibold text-muted-foreground">
        <span>{season.stops[season.stops.length - 1].name}</span>
        {selected != null ? (
          <SelectedEta day={day} stop={selected} name={season.stops[selected].name} />
        ) : nextStop != null ? (
          <span className="truncate text-advent-gold">→ {season.stops[nextStop].name}</span>
        ) : null}
        <span>Tiszai pu.</span>
      </div>
    </div>
  );
}

function SelectedEta({ day, stop, name }: { day: PublicDay | null; stop: number; name: string }) {
  const next = (day?.etas ?? []).filter((e) => e.stop === stop).sort((a, b) => a.eta - b.eta)[0];
  return (
    <span className="truncate text-foreground">
      {name}
      {next ? <span className="ml-1 font-mono text-advent-gold">{hm(next.eta)}</span> : null}
    </span>
  );
}
