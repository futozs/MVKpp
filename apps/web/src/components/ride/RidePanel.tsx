import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronUp, Flag, LogOut, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import { delayLabel, delayTone } from "@/components/transit/DelayBar";
import { cn } from "@/lib/utils";
import { cancelRide, finishRide, patchActiveRide, setDestination, type ActiveRide, type Ride } from "@/lib/rides";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { useAlightingDetector } from "./useBoardingDetector";
import { pathLengthM, useTripLive, type TripLive } from "./useTripLive";

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
const hm = (unix: number) => HM.format(new Date(unix * 1000));

/**
 * Felszállás után: hol jár a busz, mennyit késik, mennyit késhet, és mikor
 * melyik megállóban áll meg — a menet végéig, vagy amíg le nem szállsz.
 */
export function RidePanel({ ride, position, onFinished }: { ride: ActiveRide; position: GeoPosition | null; onFinished: (r: Ride) => void }) {
  const trip = useTripLive(ride.tripId);
  const reduce = useReducedMotion();
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const passed = trip?.run?.lastStopIdx ?? -1;

  // A felszállás helye és a késés az első adatból.
  useEffect(() => {
    if (!trip || ride.fromIdx != null) return;
    const idx = Math.max(0, trip.run?.lastStopIdx ?? 0);
    const s = trip.stops[idx];
    patchActiveRide({ fromIdx: idx, fromStopId: s?.id ?? null, fromStopName: s?.name ?? null, delayAtBoardS: trip.delayS, serviceDate: trip.run?.serviceDate ?? ride.serviceDate });
  }, [trip, ride.fromIdx, ride.serviceDate]);

  // Vége: a menet befejeződött, vagy a busz elhagyta a kijelölt leszállóhelyet.
  useEffect(() => {
    if (!trip?.run || ride.fromIdx == null) return;
    // Lezárt menetnél csak akkor, ha közben haladt is (épp véget ért menetre szállva ne zárjon azonnal).
    const done = trip.run.status !== "running" && passed > ride.fromIdx;
    const pastDest = ride.destIdx != null && passed >= ride.destIdx;
    if (!done && !pastDest) return;
    const at = pastDest ? ride.destIdx! : Math.max(passed, trip.stops.length - 1);
    const r = endRide(ride, trip, at);
    if (r) onFinished(r);
  }, [trip, passed, ride, onFinished]);

  // Ha a telefon tartósan eltávolodik a busztól: leszállt az utolsó elhagyott megállónál.
  useAlightingDetector(Boolean(trip), position, trip?.vehicle ?? null, () => {
    if (!trip) return;
    const r = endRide(ride, trip, Math.max(passed, ride.fromIdx ?? 0));
    if (r) onFinished(r);
  });

  // A következő megálló mindig látszódjon a listában.
  useEffect(() => {
    listRef.current?.querySelector('[data-next="1"]')?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [passed, reduce]);

  const dest = ride.destIdx != null ? trip?.stops[ride.destIdx] : undefined;
  const destFc = ride.destIdx != null ? trip?.forecast.get(ride.destIdx) : undefined;
  const remaining = useMemo(() => (trip && ride.destIdx != null ? Math.max(0, ride.destIdx - passed) : null), [trip, ride.destIdx, passed]);

  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      aria-label="Utazás"
      className="absolute inset-x-0 bottom-0 z-drawer flex max-h-[70dvh] flex-col overflow-hidden border-t border-border bg-card shadow-xl md:inset-x-auto md:bottom-4 md:right-4 md:max-h-[calc(100%-2rem)] md:w-[400px] md:rounded-xl md:border"
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <RouteTile short={ride.route} color={ride.color} text={ride.text} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold tracking-tight">{ride.headsign}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono font-bold text-primary">{ride.vehicleId}</span>
            <span className="text-muted-foreground">most</span>
            <span className={cn("font-mono font-semibold", delayTone(trip?.delayS))}>{trip ? delayLabel(trip.delayS) : "…"}</span>
            {trip?.vehicle?.speed != null ? <span className="font-mono text-muted-foreground">{Math.round(trip.vehicle.speed * 3.6)} km/h</span> : null}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Kinyitás" : "Összecsukás"}>
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </header>

      {dest ? (
        <div className="mx-4 mb-3 rounded-xl border border-primary/35 bg-primary/10 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            <Flag className="h-3.5 w-3.5" /> Leszállás
          </p>
          <p className="mt-0.5 truncate text-sm font-bold">{dest.name}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-muted-foreground">
            <span>
              várhatóan <span className="font-mono text-sm font-bold text-foreground">{hm(dest.schedTs + (destFc?.delayS ?? trip?.delayS ?? 0))}</span>
            </span>
            {destFc && destFc.upperS - destFc.delayS >= 60 ? (
              <span>
                legkésőbb <span className="font-mono font-semibold text-late">{hm(dest.schedTs + destFc.upperS)}</span>
              </span>
            ) : null}
            {remaining != null ? <span>még {remaining} megálló</span> : null}
          </p>
        </div>
      ) : (
        <p className="mx-4 mb-3 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          Koppints arra a megállóra, ahol leszállsz — megmutatom, mikorra érsz oda.
        </p>
      )}

      {collapsed || !trip ? null : (
        <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-border/70 px-2 py-2">
          {trip.stops.map((s) => (
            <StopRow key={s.idx} s={s} trip={trip} passed={passed} ride={ride} />
          ))}
        </ol>
      )}

      <footer className="flex gap-2 border-t border-border/70 px-4 py-3">
        <Button
          className="flex-1"
          onClick={() => {
            if (!trip) return;
            const r = endRide(ride, trip, Math.max(passed, ride.fromIdx ?? 0));
            if (r) onFinished(r);
          }}
        >
          <LogOut /> Leszálltam
        </Button>
        <Button variant="ghost" onClick={cancelRide} title="Mégsem ezen a buszon vagyok">
          <X /> Mégse
        </Button>
      </footer>
    </motion.aside>
  );
}

function StopRow({ s, trip, passed, ride }: { s: TripLive["stops"][number]; trip: TripLive; passed: number; ride: ActiveRide }) {
  const isPassed = s.idx <= passed;
  const isNext = s.idx === passed + 1;
  const fc = trip.forecast.get(s.idx);
  const isDest = ride.destIdx === s.idx;
  const expected = s.schedTs + (fc?.delayS ?? trip.delayS ?? 0);
  return (
    <li data-next={isNext ? "1" : undefined}>
      <button
        type="button"
        disabled={isPassed}
        onClick={() => setDestination(isDest ? null : s.idx)}
        className={cn(
          "grid w-full grid-cols-[3rem_1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left",
          isPassed ? "opacity-45" : "hover:bg-accent",
          isDest && "bg-primary/10 ring-1 ring-primary/40",
        )}
      >
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{s.schedTime}</span>
        <span className="flex justify-center">
          <span className={cn("h-2.5 w-2.5 rounded-full border-2", isPassed ? "border-muted-foreground bg-muted-foreground" : isNext ? "border-primary bg-primary motion-safe:animate-live-pulse" : "border-muted-foreground/60")} />
        </span>
        <span className={cn("truncate text-[13px]", isNext && "font-semibold")}>
          {s.name}
          {isDest ? <span className="ml-1.5 text-[11px] font-semibold text-primary">· itt szállsz le</span> : null}
        </span>
        <span className="text-right font-mono text-xs tabular-nums">
          {isPassed ? null : (
            <>
              <span className={delayTone(fc?.delayS ?? trip.delayS)}>{hm(expected)}</span>
              {fc && fc.upperS - fc.delayS >= 60 ? <span className="block text-[10px] text-muted-foreground">≤ {hm(s.schedTs + fc.upperS)}</span> : null}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

/** Az utazás lezárása a megadott megállónál (a napló elejére kerül). */
function endRide(ride: ActiveRide, trip: TripLive, atIdx: number): Ride | null {
  const to = trip.stops[Math.min(atIdx, trip.stops.length - 1)];
  const from = ride.fromIdx ?? 0;
  return finishRide({
    alightedAt: Math.round(Date.now() / 1000),
    toStopId: to?.id ?? null,
    toStopName: to?.name ?? null,
    stops: to ? Math.max(0, to.idx - from) : null,
    distanceM: to ? pathLengthM(trip.stops, from, to.idx) : null,
    delayAtAlightS: trip.delayS,
  });
}
