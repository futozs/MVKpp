import { useMemo, useState } from "react";
import { ArrowLeft, Repeat } from "lucide-react";
import { alightAt, boardAt, estimatedAt, pathLengthM, stopTimes, type RideStopEvent, type RideStopTime } from "@mvk/core/rides";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RouteTile } from "@/components/transit/RouteTile";
import { addRides, useRides, type Ride } from "@/lib/rides";
import { displayVehicleId } from "@/lib/modes";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { StopChoiceList } from "./StopChoiceList";
import { hmOf, PastTripList } from "./PastTripList";
import { recentDays, rideLogUrl, useFetched, type NextChoice, type PastRoute, type PastTripRow } from "./rideLogApi";
import { tripDetailUrl, type TripDetail, type TripStop } from "./useTripLive";

type LegFields = Omit<Ride, "id" | "chainId">;
type LegDraft = {
  trip: PastTripRow;
  vehicleId: string;
  /** a buszt a rendszer látta (vagy az előző menetről öröklődik) — nem kell beírni */
  vehicleKnown: boolean;
  /** körbeutazás következő menete: a végállomáson ülve maradt, a felszállás helye biztos */
  fixedFrom: boolean;
  from: number | null;
  to: number | null;
  /** a lezárt menet mezői — a következő menet felvételekor számoljuk ki, amíg a megállói megvannak */
  done?: LegFields;
};
type Step = "pick" | "trips" | "leg" | "next";
type Detail = { stops: TripStop[]; times: Map<number, RideStopTime> };

/** egy még el nem indult menettel nem lehetett utazni (a szerver órájához pár perc ráhagyás) */
const FUTURE_SLACK_S = 120;
const FAVORITES = 5;

/** A menet mezői a választott fel- és leszállásból; ahol a busznak nincs eseménye, ott becsült idővel. */
function legFields(leg: LegDraft, d: Detail, last: boolean): LegFields | null {
  if (leg.from == null || leg.to == null || leg.to <= leg.from) return null;
  const est = (idx: number) => ({ at: estimatedAt(d.stops, d.times, idx), delayS: null });
  const board = boardAt(d.stops, d.times, leg.from, est(leg.from));
  const alight = alightAt(d.stops, d.times, leg.to, est(leg.to));
  if (!board || !alight) return null;
  const t = leg.trip;
  return {
    serviceDate: t.serviceDate,
    vehicleId: leg.vehicleId.trim(),
    tripId: t.tripId,
    route: t.route,
    headsign: t.headsign,
    color: t.color,
    text: t.text,
    ...board,
    ...alight,
    stops: leg.to - leg.from,
    distanceM: pathLengthM(d.stops, leg.from, leg.to),
    detected: "later",
    endedBy: last ? "user" : null,
    editedAt: null,
  };
}

/**
 * Utólag felvett utazás: a menetrendből választott menet (nap → vonal →
 * indulás → fel- és leszállás). Körbeutazásnál a végállomáson „Rajta
 * maradtam”, és jön a következő menet. `continueFrom`: egy már rögzített út
 * folytatása (az app a végállomáson lezárta, de az utas a buszon maradt).
 */
export function RideAddSheet({ continueFrom, onClose }: { continueFrom?: Ride[]; onClose: () => void }) {
  const base = continueFrom?.length ? continueFrom[continueFrom.length - 1] : null;
  const days = useMemo(recentDays, []);
  const rides = useRides();
  const [day, setDay] = useState(days[0].iso);
  const [route, setRoute] = useState<PastRoute | null>(null);
  const [step, setStep] = useState<Step>(base ? "next" : "pick");
  const [legs, setLegs] = useState<LegDraft[]>([]);
  const [mode, setMode] = useState<"from" | "to">("from");

  const current = step === "leg" ? (legs[legs.length - 1] ?? null) : null;
  const detailRes = useFetched<TripDetail & { events?: RideStopEvent[] }>(current ? tripDetailUrl(current.trip.tripId, current.trip.serviceDate) : null);
  const detail = useMemo<Detail | null>(
    () => (detailRes.state === "ok" && detailRes.data.stops?.length ? { stops: detailRes.data.stops, times: stopTimes(detailRes.data.events ?? []) } : null),
    [detailRes],
  );
  const favorites = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of rides) n.set(r.route, (n.get(r.route) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).slice(0, FAVORITES).map(([r]) => r);
  }, [rides]);

  // amiből a „next” lépés folytat: az utolsó felvett menet, vagy a folytatott út utolsó menete
  const prev = legs[legs.length - 1];
  const prevVehicle = prev?.vehicleId ?? base?.vehicleId ?? "";
  const nextOf = prev
    ? { date: prev.trip.serviceDate, trip: prev.trip.tripId, terminus: prev.trip.destinationName }
    : base
      ? { date: base.serviceDate, trip: base.tripId, terminus: base.toStopName ?? "" }
      : null;

  const patchCurrent = (p: Partial<LegDraft>) => setLegs((ls) => ls.map((l, i) => (i === ls.length - 1 ? { ...l, ...p } : l)));

  const startLeg = (trip: PastTripRow, continued: boolean) => {
    const vehicleId = continued ? prevVehicle || trip.run?.vehicleId || "" : (trip.run?.vehicleId ?? "");
    setLegs((ls) => [...ls, { trip, vehicleId, vehicleKnown: Boolean(vehicleId) && (continued || Boolean(trip.run)), fixedFrom: continued, from: continued ? 0 : null, to: null }]);
    setMode(continued ? "to" : "from");
    setStep("leg");
  };

  const back = () => {
    if (step === "trips") setStep("pick");
    else if (step === "next") {
      patchCurrent({ done: undefined });
      setMode("to");
      setStep("leg");
    } else if (step === "leg") {
      setLegs((ls) => ls.slice(0, -1));
      setStep(legs.length > 1 || base ? "next" : "trips");
    }
  };

  const stay = () => {
    if (!current || !detail) return;
    const done = legFields(current, detail, false);
    if (!done) return;
    patchCurrent({ done });
    setStep("next");
  };

  const save = () => {
    if (!current || !detail) return;
    const last = legFields(current, detail, true);
    const fields = [...legs.slice(0, -1).map((l) => l.done ?? null), last];
    if (fields.some((f) => !f)) return;
    const ids = fields.map(() => crypto.randomUUID());
    // egy út menetei közös lánc-azonosítóval (az első meneté); folytatásnál a meglévő úté
    const chainId = base ? (base.chainId ?? base.id) : fields.length > 1 ? ids[0] : null;
    addRides(fields.map((f, i) => ({ ...(f as LegFields), id: ids[i], chainId })));
    onClose();
  };

  const n = detail?.stops.length ?? 0;
  // hányadik menete az útnak (körbeutazásnál; a folytatott út meneteivel együtt)
  const legNo = (continueFrom?.length ?? 0) + legs.length;
  const title =
    step === "pick" || step === "trips"
      ? "Utazás hozzáadása"
      : step === "next"
        ? "Hogyan ment tovább a busz?"
        : current?.fixedFrom
          ? "Hol szálltál le?"
          : "Hol szálltál fel és le?";
  const description =
    step === "pick"
      ? "Válaszd ki a menetrendből, melyik járattal utaztál."
      : step === "trips"
        ? `${days.find((d) => d.iso === day)?.label ?? day} · melyik indulással mentél?`
        : step === "next"
          ? `A végállomáson (${nextOf?.terminus ?? "?"}) a buszon maradtál — melyik menettel ment tovább?`
          : current
            ? `${current.trip.headsign} · ${hmOf(current.trip.depTs)}${legNo > 1 ? ` · ${legNo}. menet` : ""}`
            : "";
  // a folytatás első lépéséből nincs hova visszalépni (azt a bezárás intézi)
  const canGoBack = step !== "pick" && !(step === "next" && !legs.length);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* állandó magasság: lépésváltáskor és napváltáskor ne ugráljon az alsó lap */}
      <DialogContent className="flex h-[85dvh] flex-col gap-0 p-0 sm:h-[min(85dvh,720px)] sm:max-w-md">
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2 pr-6">
            {canGoBack ? (
              <button type="button" onClick={back} aria-label="Vissza" className="-ml-1.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : null}
            {step === "trips" && route ? <RouteTile short={route.short} color={route.color} text={route.text} size="sm" /> : null}
            {step === "leg" && current ? <RouteTile short={current.trip.route} color={current.trip.color} text={current.trip.text} size="sm" /> : null}
            {title}
          </DialogTitle>
          <DialogDescription className="line-clamp-2">{description}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {step === "pick" ? (
            <DayRoutePicker
              days={days}
              day={day}
              favorites={favorites}
              onDay={setDay}
              onRoute={(r) => {
                setRoute(r);
                setStep("trips");
              }}
            />
          ) : step === "trips" && route ? (
            <TripPicker date={day} today={day === days[0].iso} route={route.short} onPick={(t) => startLeg(t, false)} />
          ) : step === "next" && nextOf ? (
            <NextPicker date={nextOf.date} trip={nextOf.trip} vehicle={prevVehicle} onPick={(t) => startLeg(t, true)} />
          ) : step === "leg" && current ? (
            <LegStops
              leg={current}
              detail={detail}
              failed={detailRes.state === "error" || (detailRes.state === "ok" && !detail)}
              mode={mode}
              onMode={setMode}
              onVehicle={(v) => patchCurrent({ vehicleId: v })}
              onPick={(idx) => {
                patchCurrent({ [mode]: idx });
                if (mode === "from" && current.to == null) setMode("to");
              }}
            />
          ) : null}
        </div>

        {step === "leg" && current ? (
          <DialogFooter className="shrink-0 gap-2 border-t border-border/70 px-5 py-4 sm:space-x-0">
            {current.to != null && n > 0 && current.to === n - 1 ? (
              <Button variant="outline" onClick={stay} disabled={current.from == null}>
                <Repeat /> A buszon maradtam, tovább utaztam
              </Button>
            ) : null}
            <Button onClick={save} disabled={current.from == null || current.to == null || !detail}>
              Mentés
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Loading({ text }: { text: string }) {
  return <p className="px-5 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}

function DayRoutePicker({
  days,
  day,
  favorites,
  onDay,
  onRoute,
}: {
  days: { iso: string; label: string }[];
  day: string;
  favorites: string[];
  onDay: (iso: string) => void;
  onRoute: (r: PastRoute) => void;
}) {
  const res = useFetched<{ routes: PastRoute[] }>(rideLogUrl.routes(day));
  const routes = res.state === "ok" ? res.data.routes : [];
  const fav = favorites.map((s) => routes.find((r) => r.short === s)).filter((r): r is PastRoute => Boolean(r));
  const tile = (r: PastRoute, key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => onRoute(r)}
      title={r.long}
      className="rounded-lg p-1 transition-transform duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-95"
    >
      <RouteTile short={r.short} color={r.color} text={r.text} size="lg" />
    </button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
      <div role="radiogroup" aria-label="Nap" className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-3 [scrollbar-width:none]">
        {days.map((d) => (
          <button
            key={d.iso}
            type="button"
            role="radio"
            aria-checked={d.iso === day}
            onClick={() => onDay(d.iso)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              d.iso === day ? "border-primary/60 bg-primary/12 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {d.label}
          </button>
        ))}
      </div>
      {res.state === "loading" ? (
        <Loading text="A nap vonalait töltöm…" />
      ) : res.state === "error" || !routes.length ? (
        <Loading text="Erre a napra nincs menetrend." />
      ) : (
        <>
          {fav.length ? (
            <section aria-label="Gyakori vonalaid" className="mb-3">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Gyakori vonalaid</p>
              <div className="-mx-1 flex flex-wrap">{fav.map((r) => tile(r, `fav-${r.short}`))}</div>
            </section>
          ) : null}
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Minden vonal</p>
          <div className="-mx-1 flex flex-wrap">{routes.map((r) => tile(r, r.short))}</div>
        </>
      )}
    </div>
  );
}

function TripPicker({ date, today, route, onPick }: { date: string; today: boolean; route: string; onPick: (t: PastTripRow) => void }) {
  const res = useFetched<{ trips: PastTripRow[] }>(rideLogUrl.trips(date, route));
  const now = serverNow();
  const trips = res.state === "ok" ? res.data.trips.filter((t) => t.depTs <= now + FUTURE_SLACK_S) : [];
  // ma a legutóbb elindult menet legyen szem előtt (ez a legvalószínűbb); egy korábbi napon a nap eleje
  const focusId = today && trips.length ? trips[trips.length - 1].tripId : null;
  if (res.state === "loading") return <Loading text="A menetrendet töltöm…" />;
  if (res.state === "error") return <Loading text="Most nem érem el a menetrendet. Próbáld újra kicsit később." />;
  if (!trips.length) return <Loading text="Ezen a napon eddig nem indult menet ezen a vonalon." />;
  return <PastTripList className="flex-1 px-3 pb-4" trips={trips} focusId={focusId} onPick={onPick} />;
}

function NextPicker({ date, trip, vehicle, onPick }: { date: string; trip: string; vehicle: string; onPick: (t: NextChoice) => void }) {
  const res = useFetched<{ choices: NextChoice[] }>(rideLogUrl.next(date, trip, vehicle));
  if (res.state === "loading") return <Loading text="Megnézem, merre ment tovább…" />;
  if (res.state === "error") return <Loading text="Most nem érem el a menetrendet. Próbáld újra kicsit később." />;
  const choices = res.data.choices;
  if (!choices.length) return <Loading text="A végállomásról nem indult tovább menet 45 percen belül." />;
  return (
    <PastTripList
      className="flex-1 px-3 pb-4"
      trips={choices}
      focusId={choices[0].tripId}
      badge={(c) => (c.sameVehicle ? "ez a busz" : c.kind === "nearby" ? "szomszéd kocsiállás" : null)}
      onPick={onPick}
    />
  );
}

function LegStops({
  leg,
  detail,
  failed,
  mode,
  onMode,
  onVehicle,
  onPick,
}: {
  leg: LegDraft;
  detail: Detail | null;
  failed: boolean;
  mode: "from" | "to";
  onMode: (m: "from" | "to") => void;
  onVehicle: (v: string) => void;
  onPick: (idx: number) => void;
}) {
  if (failed) return <Loading text="Ennek a menetnek a megállói nem érhetők el." />;
  if (!detail) return <Loading text="A menet megállóit töltöm…" />;
  const n = detail.stops.length;
  const lo = mode === "from" ? 0 : (leg.from ?? 0) + 1;
  const hi = mode === "from" ? (leg.to ?? n - 1) - 1 : n - 1;
  const nameOf = (idx: number | null) => (idx != null ? detail.stops[idx]?.name : null) ?? "Válaszd ki";
  return (
    <>
      <div className="mx-5 mb-2 flex items-center gap-2 text-[12.5px]">
        <span className="text-muted-foreground">Busz:</span>
        {leg.vehicleKnown ? (
          <span className="rounded bg-primary/12 px-1.5 py-px font-mono font-bold tabular-nums text-primary">{displayVehicleId(leg.vehicleId)}</span>
        ) : (
          <Input
            value={leg.vehicleId}
            onChange={(e) => onVehicle(e.target.value.replace(/[^\w-]/g, "").slice(0, 12))}
            placeholder="pályaszám, ha tudod"
            aria-label="A busz pályaszáma"
            autoComplete="off"
            className="h-8 w-44 font-mono"
          />
        )}
      </div>
      <div role="tablist" aria-label="Mit adsz meg" className="mx-5 grid grid-cols-2 gap-2">
        {(["from", "to"] as const).map((m) => {
          const locked = m === "from" && leg.fixedFrom;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              disabled={locked}
              onClick={() => onMode(m)}
              className={cn(
                "min-w-0 rounded-xl border px-3 py-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default",
                mode === m ? "border-primary/60 bg-primary/10" : "border-border hover:bg-accent disabled:hover:bg-transparent",
              )}
            >
              <span className={cn("block text-[10.5px] font-semibold uppercase tracking-wide", mode === m ? "text-primary" : "text-muted-foreground")}>
                {m === "from" ? "Felszállás" : "Leszállás"}
              </span>
              <span className="block truncate text-[13px] font-semibold">{nameOf(m === "from" ? leg.from : leg.to)}</span>
            </button>
          );
        })}
      </div>
      <StopChoiceList
        key={mode}
        className="mt-2 flex-1 px-3 pb-2"
        stops={detail.stops}
        lo={lo}
        hi={hi}
        times={detail.times}
        timeOf={mode === "from" ? "dep" : "arr"}
        selected={mode === "from" ? leg.from : leg.to}
        onPick={onPick}
      />
    </>
  );
}
