import { useMemo, useState } from "react";
import { Footprints, LocateFixed, Minus, Plus, TriangleAlert } from "lucide-react";
import { walkSecondsFor } from "@mvk/core/catchBus";
import type { StopEta } from "@mvk/core/advent/day";
import { useGeo } from "@/context/GeoContext";
import { distanceKm } from "@/lib/geo";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import type { PublicDay, SeasonMeta } from "./adventApi";
import { hm } from "./adventText";

/** ennyivel érj oda előbb (mp): a villamos a várhatónál korábban is jöhet */
const MARGIN_S = 120;

/**
 * Elkapó: melyik megállóban és mikor éred el, honnan és mikor indulj, és ha
 * felszállsz pár megállóra, hol szállj le és mikor jön vissza ugyanoda.
 */
export function CatchPlanner({ day, season, stop, onStop }: { day: PublicDay; season: SeasonMeta; stop: number | null; onStop: (i: number) => void }) {
  const geo = useGeo();
  const [ride, setRide] = useState(4);
  const pos = geo.position;
  const nearest = useMemo(() => {
    if (!pos) return null;
    let best: { i: number; m: number } | null = null;
    season.stops.forEach((s, i) => {
      for (const at of [s.outAt, s.backAt]) {
        if (!at) continue;
        const m = distanceKm(pos.lat, pos.lon, at.lat, at.lon) * 1000;
        if (!best || m < best.m) best = { i, m };
      }
    });
    return best as { i: number; m: number } | null;
  }, [pos, season]);
  const sel = stop ?? nearest?.i ?? null;
  const now = serverNow();

  const passes = (i: number, dir: "out" | "back") => day.etas.filter((e) => e.stop === i && e.dir === dir && e.eta >= now - 60).sort((a, b) => a.eta - b.eta);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="advent-stop">
          Megálló
        </label>
        <select
          id="advent-stop"
          value={sel ?? ""}
          onChange={(e) => onStop(Number(e.target.value))}
          className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-[14px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="" disabled>
            Válassz megállót
          </option>
          {season.stops.map((s, i) => (
            <option key={s.out} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => (nearest ? onStop(nearest.i) : geo.start())}
          className={cn(
            "flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            nearest && sel === nearest.i ? "border-advent-gold/60 text-advent-gold" : "border-border hover:bg-accent",
          )}
        >
          <LocateFixed className={cn("h-4 w-4", geo.status === "requesting" && "animate-pulse")} aria-hidden />
          Legközelebbi
        </button>
      </div>

      {sel == null ? (
        <p className="text-[13px] text-muted-foreground">Válaszd ki, hol néznéd meg vagy hol szállnál fel.</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["out", "back"] as const).map((dir) => (
              <PassCard
                key={dir}
                title={dir === "out" ? "Felső-Majláth felé" : "Tiszai pu. felé"}
                list={passes(sel, dir)}
                walkS={pos ? walkTo(pos, dir === "out" ? season.stops[sel].outAt : season.stops[sel].backAt) : null}
                now={now}
              />
            ))}
          </div>
          <RideAlong day={day} season={season} from={sel} ride={ride} onRide={setRide} now={now} />
          {!season.facts.lowFloor ? <p className="text-[11.5px] text-muted-foreground">Lépcsős, nem alacsony padlós kocsi · {season.facts.fare}</p> : null}
        </>
      )}
    </div>
  );
}

function walkTo(pos: { lat: number; lon: number }, at: { lat: number; lon: number } | null): number | null {
  if (!at) return null;
  return walkSecondsFor(distanceKm(pos.lat, pos.lon, at.lat, at.lon) * 1000);
}

function PassCard({ title, list, walkS, now }: { title: string; list: StopEta[]; walkS: number | null; now: number }) {
  const first = list[0];
  const leave = first && walkS != null ? first.eta - walkS - MARGIN_S : null;
  const late = leave != null && leave < now;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {first ? (
        <>
          <p className="mt-0.5 flex items-baseline gap-2">
            <span className="font-mono text-[22px] font-bold tabular-nums text-advent-gold">{hm(first.eta)}</span>
            {first.eta - first.sched >= 120 ? <span className="text-[12px] font-semibold text-nosignal">{hm(first.sched)} helyett</span> : null}
            <span className="ml-auto text-[12px] text-muted-foreground">{Math.max(0, Math.round((first.eta - now) / 60))} perc múlva</span>
          </p>
          {first.uncertain ? (
            <p className="mt-1 flex items-center gap-1 text-[11.5px] text-nosignal">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Bizonytalan: lehet, hogy nem jön
            </p>
          ) : null}
          {walkS != null ? (
            <p className={cn("mt-1 flex items-center gap-1 text-[12px]", late ? "text-late" : "text-foreground")}>
              <Footprints className="h-3.5 w-3.5" aria-hidden />
              {Math.max(1, Math.round(walkS / 60))} perc séta · {late ? "ezt már nem éred el gyalog" : leave! - now < 120 ? "indulj most" : `indulj ${hm(leave)}-kor`}
            </p>
          ) : null}
          {list.length > 1 ? (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Utána:{" "}
              {list
                .slice(1, 4)
                .map((e) => hm(e.eta))
                .join(", ")}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-[13px] text-muted-foreground">Ma erre már nem jön.</p>
      )}
    </div>
  );
}

/** felszállsz és pár megállót utazol: hol szállj le, és mikor jön vissza oda */
function RideAlong({ day, season, from, ride, onRide, now }: { day: PublicDay; season: SeasonMeta; from: number; ride: number; onRide: (n: number) => void; now: number }) {
  const n = season.stops.length;
  // a következő elérhető menet ebből a megállóból (bármelyik irányba)
  const board = day.etas.filter((e) => e.stop === from && e.eta >= now).sort((a, b) => a.eta - b.eta)[0];
  if (!board) return null;
  const step = board.dir === "out" ? 1 : -1;
  const to = Math.min(n - 1, Math.max(0, from + step * ride));
  if (to === from) return null;
  const arrive = day.etas.find((e) => e.trip === board.trip && e.stop === to);
  const back = arrive ? day.etas.filter((e) => e.stop === to && e.dir !== board.dir && e.eta > arrive.eta).sort((a, b) => a.eta - b.eta)[0] : null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-advent-gold/30 bg-advent-navy/60 px-3 py-2.5">
      <div className="flex shrink-0 items-center rounded-lg border border-border bg-background">
        <button
          type="button"
          aria-label="Kevesebb megálló"
          onClick={() => onRide(Math.max(1, ride - 1))}
          className="flex h-9 w-8 items-center justify-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Minus className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span className="w-6 text-center font-mono text-[14px] font-bold tabular-nums">{Math.abs(to - from)}</span>
        <button
          type="button"
          aria-label="Több megálló"
          onClick={() => onRide(Math.min(n - 1, ride + 1))}
          className="flex h-9 w-8 items-center justify-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <p className="min-w-0 text-[12.5px] leading-snug text-advent-ink">
        Felszállsz <span className="font-mono font-bold">{hm(board.eta)}</span>, leszállsz: <span className="font-semibold">{season.stops[to].name}</span>
        {arrive ? (
          <>
            {" "}
            <span className="font-mono font-bold">{hm(arrive.eta)}</span>
          </>
        ) : null}
        .{back ? ` Visszafelé ${hm(back.eta)}-kor jön újra arra.` : " Vissza bármelyik 1-es villamossal."}
      </p>
    </div>
  );
}
