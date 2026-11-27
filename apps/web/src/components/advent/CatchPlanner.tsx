import { useMemo, useState } from "react";
import { ChevronRight, Footprints, LocateFixed, Minus, Plus, TriangleAlert } from "lucide-react";
import type { CatchLeg, CatchOption } from "@mvk/core/advent/catch";
import type { Stop } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { feedOfId, pickableStops } from "@/lib/modes";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { PlaceSelect } from "@/components/routeplanner/PlaceSelect";
import { RouteTile } from "@/components/transit/RouteTile";
import { useAdventPlan, type SeasonMeta } from "./adventApi";
import { hm } from "./adventText";

const minutes = (s: number) => Math.max(1, Math.round(s / 60));
const optionKey = (o: CatchOption) => `${o.run}:${o.stop}`;

/**
 * Elkapó: a helyzetedből (vagy egy megállóból) gyalog és bármelyik MVK-járattal
 * oda, ahol pár perccel a villamos előtt ott vagy. Menetenként a legkényelmesebb
 * megálló, és ha elébe mész, a korábbi is; felszállás után: hol vagy, mivel jössz vissza.
 */
export function CatchPlanner({ season, stops, onStop }: { season: SeasonMeta; stops: Stop[]; onStop: (i: number) => void }) {
  const geo = useGeo();
  const [placeId, setPlaceId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const places = useMemo(() => {
    const byName = new Map<string, Stop>();
    for (const s of pickableStops(stops)) if (feedOfId(s.id) === "mvk" && !byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "hu"));
  }, [stops]);

  const pos = geo.position;
  const usingGeo = !placeId;
  const from = placeId ? `stop:${placeId}` : pos ? `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}` : null;
  const key = placeId ? `stop:${placeId}` : pos ? `${pos.lat.toFixed(3)},${pos.lon.toFixed(3)}` : null;
  const res = useAdventPlan(from, key);
  const plan = res?.plan ?? null;
  const options = plan?.options ?? [];
  const openKey = options.some((o) => optionKey(o) === open) ? open : options[0] ? optionKey(options[0]) : null;
  const now = serverNow();

  const useHere = () => {
    setPlaceId("");
    if (!pos) geo.start();
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <PlaceSelect label="Honnan indulsz?" places={places} value={placeId} onChange={setPlaceId} />
        </div>
        <button
          type="button"
          onClick={useHere}
          aria-pressed={usingGeo && pos != null}
          className={cn(
            "flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            usingGeo && pos ? "border-advent-gold/60 text-advent-gold" : "border-border hover:bg-accent",
          )}
        >
          <LocateFixed className={cn("h-4 w-4", geo.status === "requesting" && "animate-pulse")} aria-hidden />
          Itt vagyok
        </button>
      </div>

      {!from ? (
        <p className="text-[13px] text-muted-foreground">
          {geo.status === "denied" || geo.status === "unavailable" || geo.status === "error"
            ? "A helyzeted nem érhető el: írd be, melyik megálló felől jössz."
            : "Írd be, honnan indulsz, vagy add meg a helyzeted."}
        </p>
      ) : !res ? (
        <div className="space-y-1.5" aria-busy="true" aria-label="Tervezés">
          <div className="h-[68px] animate-pulse rounded-xl bg-muted/40" />
          <div className="h-[52px] animate-pulse rounded-xl bg-muted/30" />
        </div>
      ) : res.error ? (
        <p className="text-[13px] text-muted-foreground">{res.error}</p>
      ) : !options.length ? (
        <p className="text-[13px] text-muted-foreground">{plan?.runsLeft ? "Innen ma már nem éred el időben." : "Ma már nem indul több menet."}</p>
      ) : (
        <ol className="space-y-1.5">
          {options.map((o) => {
            const k = optionKey(o);
            const calm = o.chase ? options.find((x) => x.run === o.run && !x.chase) : null;
            return (
              <OptionRow
                key={k}
                option={o}
                earlierBy={calm ? calm.at - o.at : null}
                live={plan?.live ?? false}
                open={k === openKey}
                now={now}
                onOpen={() => {
                  setOpen(k);
                  onStop(o.stop);
                }}
              />
            );
          })}
        </ol>
      )}

      {!season.facts.lowFloor ? <p className="text-[11.5px] text-muted-foreground">Lépcsős, nem alacsony padlós kocsi · {season.facts.fare}</p> : null}
    </div>
  );
}

function OptionRow({ option: o, earlierBy, live, open, now, onOpen }: { option: CatchOption; earlierBy: number | null; live: boolean; open: boolean; now: number; onOpen: () => void }) {
  const leaveNow = o.leave - now < 90;
  return (
    <li className={cn("rounded-xl border bg-card transition-colors duration-fast", open ? "border-advent-gold/45" : "border-border")}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex flex-col items-start leading-none">
          <span className="font-mono text-[22px] font-bold tabular-nums text-advent-gold">{hm(o.at)}</span>
          {o.at - o.sched >= 120 ? <span className="mt-1 text-[11px] font-semibold text-nosignal">{hm(o.sched)} helyett</span> : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold">{o.name}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
            {o.dir === "out" ? "Felső-Majláth felé" : "Tiszai pu. felé"}
            {earlierBy != null ? <span className="font-semibold text-advent-gold">· elébe mész, {minutes(earlierBy)} perccel hamarabb</span> : null}
            {!live ? <span>· menetrend szerint</span> : null}
          </span>
        </span>
        <span className="flex flex-col items-end text-right leading-tight">
          <span className={cn("text-[13px] font-bold tabular-nums", leaveNow ? "text-advent-gold" : "text-foreground")}>{leaveNow ? "Indulj most" : `Indulj ${hm(o.leave)}`}</span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{minutes(o.slackS)} perc tartalék</span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-3 pb-2 text-[12px]">
        {o.legs.map((l, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden /> : null}
            <LegChip leg={l} />
          </span>
        ))}
      </div>
      {o.uncertain ? (
        <p className="flex items-center gap-1 px-3 pb-2 text-[11.5px] text-nosignal">
          <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Bizonytalan: lehet, hogy nem jön
        </p>
      ) : null}
      {open && o.rides.length ? <RideAlong option={o} /> : null}
    </li>
  );
}

function LegChip({ leg }: { leg: CatchLeg }) {
  if (leg.kind === "walk")
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Footprints className="h-3.5 w-3.5" aria-hidden />
        <span className="tabular-nums">{minutes(leg.arr - leg.dep)} perc</span>
        <span className="sr-only">gyalog: {leg.to}</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <RouteTile short={leg.route} color={leg.color} text={leg.text} size="sm" />
      <span className="font-semibold tabular-nums">{hm(leg.dep)}</span>
      {leg.delayS != null && leg.delayS >= 120 ? <span className="font-semibold tabular-nums text-nosignal">+{minutes(leg.delayS)}</span> : null}
      <span className="max-w-[9rem] truncate text-muted-foreground">{leg.to}</span>
    </span>
  );
}

/** felszállsz és pár megállót utazol: hol szállsz le, és mivel érsz vissza a felszállás helyére */
function RideAlong({ option: o }: { option: CatchOption }) {
  const [want, setWant] = useState(4);
  const n = Math.min(want, o.rides.length);
  const r = o.rides[n - 1];
  return (
    <div className="mx-2 mb-2 flex items-center gap-3 rounded-lg border border-advent-gold/30 bg-advent-navy/60 px-2.5 py-2">
      <div className="flex shrink-0 items-center rounded-lg border border-border bg-background">
        <button
          type="button"
          aria-label="Kevesebb megálló"
          disabled={n <= 1}
          onClick={() => setWant(Math.max(1, n - 1))}
          className="flex h-9 w-8 items-center justify-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <Minus className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span className="w-6 text-center font-mono text-[14px] font-bold tabular-nums" aria-live="polite" aria-label={`${n} megálló`}>
          {n}
        </span>
        <button
          type="button"
          aria-label="Több megálló"
          disabled={n >= o.rides.length}
          onClick={() => setWant(Math.min(o.rides.length, n + 1))}
          className="flex h-9 w-8 items-center justify-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <p className="min-w-0 text-[12.5px] leading-snug text-advent-ink">
        Leszállsz: <span className="font-semibold">{r.name}</span> <span className="font-mono font-bold">{hm(r.at)}</span>.{" "}
        {r.back ? (
          <>
            Vissza <RouteTile short={r.back.route} color={r.back.color} text={r.back.text} size="sm" className="align-[-0.3em]" /> <span className="font-mono font-bold">{hm(r.back.dep)}</span>, {o.name}{" "}
            <span className="font-mono font-bold">{hm(r.back.arr)}</span>
          </>
        ) : (
          "Vissza ma már nincs közvetlen járat."
        )}
      </p>
    </div>
  );
}
