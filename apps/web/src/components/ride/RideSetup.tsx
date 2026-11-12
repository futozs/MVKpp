import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, MapPin, Repeat } from "lucide-react";
import { stopTimes, type RideStopEvent, type RideStopTime } from "@mvk/core/rides";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import type { ActiveRide, LoopPlan } from "@/lib/rides";
import { StopChoiceList } from "./StopChoiceList";
import { fetchContinuation } from "./RideTurn";
import { rideLogUrl, useFetched, type NextChoice } from "./rideLogApi";
import { tripDetailUrl, type TripDetail, type TripLive } from "./useTripLive";

export type SetupStep = "from" | "to" | "loop";

type NextTrip = { tripId: string; route: string; color: string; text: string; headsign: string; depTime: string; serviceDate: string };

/**
 * A busz következő menete a végállomásról (a körbeutazás előre megadásához):
 * a busz forda-terve / élő menete, ennek híján a menetrend szerinti első
 * ugyaninnen induló menet.
 */
function useNextTrip(ride: ActiveRide, enabled: boolean): { state: "loading" } | { state: "none" } | { state: "ok"; trip: NextTrip } {
  const [res, setRes] = useState<{ key: string; v: { state: "none" } | { state: "ok"; trip: NextTrip } } | null>(null);
  const key = `${ride.tripId}|${ride.vehicleId}|${ride.serviceDate}`;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      const c = await fetchContinuation(ride.tripId, ride.vehicleId);
      const n = c?.next;
      if (n && n.kind && !n.cancelled) {
        if (alive) setRes({ key, v: { state: "ok", trip: { ...n, serviceDate: ride.serviceDate } } });
        return;
      }
      const r = await fetch(rideLogUrl.next(ride.serviceDate, ride.tripId, ride.vehicleId), { cache: "no-store" }).catch(() => null);
      const body = r?.ok ? ((await r.json().catch(() => null)) as { choices?: NextChoice[] } | null) : null;
      const pick = body?.choices?.find((x) => x.sameVehicle) ?? body?.choices?.find((x) => x.kind === "loop") ?? body?.choices?.[0];
      if (!alive) return;
      setRes({
        key,
        v: pick
          ? { state: "ok", trip: { tripId: pick.tripId, route: pick.route, color: pick.color, text: pick.text, headsign: pick.headsign, depTime: hmOf(pick.depTs), serviceDate: pick.serviceDate } }
          : { state: "none" },
      });
    })();
    return () => {
      alive = false;
    };
  }, [enabled, key, ride.tripId, ride.vehicleId, ride.serviceDate]);
  return enabled && res?.key === key ? res.v : { state: "loading" };
}

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
const hmOf = (unix: number) => HM.format(new Date(unix * 1000));

function StepHead({ title, hint, onBack }: { title: string; hint: string; onBack?: () => void }) {
  return (
    <div className="flex items-start gap-2 px-4 pb-2 pt-3">
      {onBack ? (
        <button type="button" onClick={onBack} aria-label="Vissza" className="-ml-1.5 mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{title}</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

/**
 * Felszálláskor mindig az utas mondja meg: hol szállt fel, hol fog leszállni,
 * és — fordulóhurkos végállomásnál — körbeutazik-e. Nincs találgatás: a
 * kiválasztott leszállóhelynél (vagy a körbeutazás megadott megállójánál) az
 * app magától lezárja az utazást, akkor is, ha a telefon a zsebben van.
 */
export function RideSetup({
  step,
  ride,
  trip,
  times,
  cur,
  onStep,
  onDone,
  onFrom,
  onDest,
  onLoop,
}: {
  step: SetupStep;
  ride: ActiveRide;
  trip: TripLive;
  times: Map<number, RideStopTime>;
  /** ahol a busz most tart */
  cur: number;
  onStep: (s: SetupStep) => void;
  /** a beállítás kész (ha volt mit visszavonni, ez zárja be) — null: nem zárható be, amíg hiányzik valami */
  onDone: (() => void) | null;
  onFrom: (idx: number) => void;
  onDest: (idx: number) => void;
  onLoop: (plan: LoopPlan) => void;
}) {
  const lastIdx = trip.stops.length - 1;
  const fromIdx = ride.fromIdx ?? 0;
  const terminus = trip.stops[lastIdx]?.name ?? "végállomás";

  if (step === "from") {
    return (
      <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
        <StepHead
          title="Hol szálltál fel?"
          hint="Koppints a megállóra. Ahol a busz már járt, ott az indulása látszik."
          onBack={onDone && ride.fromConfirmed ? onDone : undefined}
        />
        <StopChoiceList
          className="flex-1 px-2 pb-3"
          stops={trip.stops}
          lo={0}
          hi={Math.max(0, Math.min(lastIdx - 1, cur + 1, ride.destIdx != null ? ride.destIdx - 1 : Infinity))}
          times={times}
          timeOf="dep"
          selected={ride.fromConfirmed ? ride.fromIdx : null}
          focusIdx={cur}
          focusLabel="a busz most itt"
          onPick={onFrom}
        />
      </div>
    );
  }

  if (step === "to") {
    return (
      <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
        <StepHead
          title="Hol szállsz le?"
          hint="Ha a busz odaért, magától lezárom az utazást — akkor is, ha közben nem nyitod meg az appot."
          onBack={onDone ?? (() => onStep("from"))}
        />
        <button
          type="button"
          onClick={() => onStep("from")}
          className="mx-4 mb-1 flex items-center gap-1.5 self-start rounded-md text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <MapPin className="h-3 w-3" aria-hidden /> Felszállás: <span className="font-semibold text-foreground">{trip.stops[fromIdx]?.name}</span>
        </button>
        <StopChoiceList
          className="flex-1 px-2 pb-2"
          stops={trip.stops}
          lo={Math.min(lastIdx, fromIdx + 1)}
          hi={lastIdx}
          times={times}
          timeOf="arr"
          selected={ride.destIdx}
          marks={new Map([[lastIdx, "végállomás"]])}
          onPick={onDest}
        />
        {trip.loopEnd ? (
          <div className="border-t border-border/70 px-4 py-3">
            <Button variant="outline" className="w-full justify-start border-primary/50" onClick={() => onStep("loop")}>
              <Repeat className="text-primary" />
              <span className="min-w-0 truncate">Körbeutazok — {terminus}-nál a buszon maradok</span>
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return <LoopStep ride={ride} terminus={terminus} onBack={() => onStep("to")} onLoop={onLoop} />;
}

/** Körbeutazás előre: a busz következő menetének megállói közül, hol száll le. */
function LoopStep({ ride, terminus, onBack, onLoop }: { ride: ActiveRide; terminus: string; onBack: () => void; onLoop: (plan: LoopPlan) => void }) {
  const next = useNextTrip(ride, true);
  const nextTrip = next.state === "ok" ? next.trip : null;
  const detail = useFetched<TripDetail & { events?: RideStopEvent[] }>(nextTrip ? tripDetailUrl(nextTrip.tripId, nextTrip.serviceDate) : null);
  const stops = detail.state === "ok" ? detail.data.stops : null;
  const times = useMemo(() => stopTimes(detail.state === "ok" ? (detail.data.events ?? []) : []), [detail]);
  const selected = ride.loopPlan?.stopId && stops ? stops.findIndex((s, i) => i > 0 && s.id === ride.loopPlan?.stopId) : -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
      <StepHead
        title="Körbeutazás: hol szállsz le?"
        hint={`${terminus}-nál a buszon maradsz. Válaszd ki, hol szállsz le a következő menetéből — odáig magától viszem tovább az utazást.`}
        onBack={onBack}
      />
      {nextTrip ? (
        <div className="mx-4 mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <RouteTile short={nextTrip.route} color={nextTrip.color} text={nextTrip.text} size="sm" />
          <span className="min-w-0 truncate">
            {nextTrip.headsign} · indul <span className="font-mono font-semibold text-foreground">{nextTrip.depTime}</span>
          </span>
        </div>
      ) : null}
      {next.state === "loading" || (nextTrip && detail.state === "loading") ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Megnézem, merre megy tovább a busz…</p>
      ) : next.state === "none" || detail.state === "error" || !stops?.length ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">Még nem látom, melyik menettel megy tovább a busz.</p>
          <Button className="mt-3" onClick={() => onLoop({ stopId: null, stopName: null, tripId: null })}>
            <Repeat /> Körbeutazok, a leszállást később adom meg
          </Button>
        </div>
      ) : (
        <StopChoiceList
          className="flex-1 px-2 pb-3"
          stops={stops}
          lo={1}
          hi={stops.length - 1}
          times={times}
          timeOf="arr"
          selected={selected >= 0 ? selected : null}
          marks={new Map([[stops.length - 1, "végállomás"]])}
          onPick={(idx) => onLoop({ stopId: stops[idx].id, stopName: stops[idx].name, tripId: nextTrip?.tripId ?? null })}
        />
      )}
    </div>
  );
}
