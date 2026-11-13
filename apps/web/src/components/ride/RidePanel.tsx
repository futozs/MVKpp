import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronUp, Crosshair, Flag, LogOut, MapPin, Pencil, Repeat, TrafficCone, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import { delayLabel, delayTone } from "@/components/transit/DelayBar";
import { trafficColor } from "@/components/map/trafficColor";
import { cn } from "@/lib/utils";
import { cancelRide, continueRide, finishRide, patchActiveRide, setDestination, type ActiveRide, type LoopPlan, type Ride, type RideEndedBy } from "@/lib/rides";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { alightAt, boardAt, currentStopIdx, nearestDelayS, stopTimes, type RideStopTime } from "@mvk/core/rides";
import { plannedTurnDecision } from "@mvk/core/loops";
import { useAlightingDetector } from "./useBoardingDetector";
import { TurnCard, useContinuation, type Continuation } from "./RideTurn";
import { RideSetup, type SetupStep } from "./RideSetup";
import { distM, pathLengthM, useTripLive, type TripLive } from "./useTripLive";
import { useTrafficAhead, type TrafficAhead } from "./useTrafficAhead";
import { StopChoiceList } from "./StopChoiceList";
import { serverNow, useServerClockVersion } from "@/lib/realtime";
import { displayVehicleId, RIDE_PROXIMITY, rideModeOf, VEHICLE_WORDS } from "@/lib/modes";

/** a telefon helye ennyi ideig számít frissnek (ms) */
const FRESH_POS_MS = 60_000;
/** a soha le nem zárt utazás, amelynek a menetéről nincs adat: ennyi idő után véget ért (mp) */
const STALE_RIDE_S = 3 * 3600;
/** „Még rajta vagyok” után ennyi ideig nem kérdezünk újra (ms) */
const AWAY_SNOOZE_MS = 15 * 60_000;

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
const hm = (unix: number) => HM.format(new Date(unix * 1000));
const minText = (s: number) => `${Math.max(1, Math.round(s / 60))} perc`;

/** Lezárás után: a végállomásán ért-e véget, és az fordulóhurok (onnan körbe lehet még utazni). */
export type FinishInfo = { atLoopTerminus: boolean };

/**
 * Felszállás után: hol jár a busz, mennyit késik, mennyit késhet, hol áll a
 * forgalom előtte, és mikor melyik megállóban áll meg  a menet végéig, vagy
 * amíg le nem szállsz.
 *
 * Mindig az utas mondja meg, hol szállt fel, hol száll le, és hogy körbeutazik-e
 * (lásd RideSetup)  a telefon helyéből nem találgatunk. A kijelölt leszállóhelynél
 * (körbeutazásnál a következő menet megadott megállójánál) magától zárul le.
 */
export function RidePanel({
  ride,
  position,
  following,
  onFinished,
  onCancel,
  onRefollow,
}: {
  ride: ActiveRide;
  position: GeoPosition | null;
  /** a térkép épp ezt a buszt követi */
  following: boolean;
  onFinished: (r: Ride, info: FinishInfo) => void;
  onCancel?: () => void;
  onRefollow: () => void;
}) {
  const trip = useTripLive(ride.tripId, ride.serviceDate);
  // vonatnál a csempén a vonatszám is („Sz 5169”), mint a térképen
  const trainNo = rideModeOf(ride.vehicleId, ride.tripId) === "rail" ? (/^\d+/.exec(trip?.tripShort ?? "")?.[0] ?? null) : null;
  const turn = ride.turn ?? null;
  const plan = ride.loopPlan ?? null;
  const cont = useContinuation(ride.tripId, ride.vehicleId, Boolean(turn));
  // Fordulás közben a busz már a következő menetén van: a helyét a folytatás adja.
  const live = turn ? (cont?.vehicle ?? null) : (trip?.vehicle ?? null);
  const vLat = live?.lat ?? null;
  const vLon = live?.lon ?? null;
  const busPos = useMemo(() => (vLat != null && vLon != null ? { lat: vLat, lon: vLon } : null), [vLat, vLon]);
  const px = RIDE_PROXIMITY[rideModeOf(ride.vehicleId, ride.tripId)];
  const words = VEHICLE_WORDS[rideModeOf(ride.vehicleId, ride.tripId)];
  const reduce = useReducedMotion();
  const [collapsed, setCollapsed] = useState(false);
  /** a felszállás / leszállás / körbeutazás megadása (ha valami hiányzik, magától nyílik) */
  const [step, setStep] = useState<SetupStep | null>(null);
  /** „Korábban leszálltam”: a már elhagyott megállók közül */
  const [alightPicker, setAlightPicker] = useState(false);
  const [awaySnooze, setAwaySnooze] = useState(0);
  const [awayAsk, setAwayAsk] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const passed = trip?.run?.lastStopIdx ?? -1;
  const times = useMemo(() => stopTimes(trip?.events ?? []), [trip?.events]);
  const fresh = position && Date.now() - position.at <= FRESH_POS_MS ? position : null;
  const away = Boolean(fresh && busPos && distM(fresh, busPos) > px.away);
  // ahol a busz most tart (ha a megállóban áll, az már az a megálló)
  const cur = trip ? currentStopIdx(trip.stops, passed, busPos, px.atStop) : 0;
  const fromIdx = ride.fromIdx ?? 0;
  const lastIdx = (trip?.stops.length ?? 1) - 1;
  // Az időn múló döntések (fordulás, órák óta le nem zárt utazás) a szerver órájával:
  // a készüléké eltérhet, a kapcsolódásig csak az ismert.
  const clockReady = useServerClockVersion() > 0;

  const needsFrom = !ride.fromConfirmed || ride.fromIdx == null;
  const destPending = ride.destIdx == null && !plan && Boolean(ride.destStopId);
  const needsDest = ride.destIdx == null && !plan && !ride.destStopId;
  const setup: SetupStep | null = needsFrom ? "from" : (step ?? (needsDest ? "to" : null));

  const finish = (atIdx: number, endedBy: RideEndedBy, alightedAt: number | null) => {
    if (!trip) return;
    const fields = endFields(ride, trip, times, atIdx, endedBy, alightedAt);
    const r = finishRide(fields);
    if (r) onFinished(r, { atLoopTerminus: trip.loopEnd && Math.max(atIdx, fromIdx) >= lastIdx });
  };

  // Régi (automatikus körbeutazós) utazás fordulás közben: körbeutazásként visszük tovább.
  useEffect(() => {
    if (turn && !plan) patchActiveRide({ loopPlan: { stopId: null, stopName: null, tripId: null } });
  }, [turn, plan]);

  // Körbeutazás következő menete: a már megadott leszállóhely ezen a meneten.
  useEffect(() => {
    if (!trip?.stops.length || !destPending) return;
    const want = ride.destStopId;
    let idx = trip.stops.findIndex((s) => s.idx > 0 && s.id === want);
    if (idx < 0) {
      // a menetrend azonosítói változhattak: azonos nevű megálló
      const name = ride.destStopName ?? null;
      idx = name ? trip.stops.findIndex((s) => s.idx > 0 && s.name === name) : -1;
    }
    patchActiveRide(idx > 0 ? { destIdx: idx, destStopId: null, destStopName: null } : { destStopId: null, destStopName: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.stops, destPending]);

  // Vége: a busz elérte a kijelölt leszállóhelyet (vagy a menet lezárult). Körbeutazásnál a
  // végállomáson nem zárul: a busz következő menetével folytatjuk (lásd lent).
  useEffect(() => {
    if (!trip?.run || needsFrom || turn || setup || alightPicker) return;
    const done = trip.run.status !== "running" && passed > fromIdx;
    if (ride.destIdx != null) {
      if (passed >= ride.destIdx || done) finish(ride.destIdx, "dest", null);
      return;
    }
    if (!plan || !(passed >= lastIdx || done) || !clockReady) return;
    const now = Math.round(serverNow());
    const arrivedAt = trip.run.actualEnd ?? times.get(lastIdx)?.arr ?? now;
    patchActiveRide({ turn: { arrivedAt, atIdx: lastIdx, terminusName: trip.stops[lastIdx]?.name ?? "végállomás" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, passed, ride.destIdx, plan, turn, needsFrom, setup, alightPicker, clockReady]);

  // Körbeutazás a végállomáson: a busz indulásakor folytatjuk (a telefon helyétől függetlenül).
  useEffect(() => {
    if (!turn || !trip || !clockReady) return;
    const now = Math.round(serverNow());
    const decision = plannedTurnDecision(turn.arrivedAt, cont, now);
    if (decision === "continue" && cont?.next) chainNext(ride, trip, times, turn, cont.next, plan);
    else if (decision === "alight" || (!cont && now - turn.arrivedAt > STALE_RIDE_S)) finish(turn.atIdx, "terminus", turn.arrivedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, cont, trip, clockReady]);

  // Soha le nem zárt utazás, amelynek a menetéről a szerveren sincs futás (nem indult el, vagy
  // nem látszott): órák múlva a kijelölt leszállóhelyen (ennek híján a végállomáson) lezárjuk.
  useEffect(() => {
    if (!trip || trip.run || !clockReady || serverNow() - ride.boardedAt < STALE_RIDE_S) return;
    if (trip.stops.length < 2 || needsFrom) {
      cancelRide();
      onCancel?.();
      return;
    }
    finish(ride.destIdx ?? lastIdx, "terminus", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, needsFrom, clockReady]);

  // Ha a telefon tartósan eltávolodik a busztól, csak megkérdezzük  magától nem zárjuk le
  // (a busz GPS-e is tévedhet, és aki zsebre tett telefonnal körbeutazik, az nem szállt le).
  useAlightingDetector(Boolean(trip) && !needsFrom && !turn && !setup && !alightPicker && Date.now() > awaySnooze, position, busPos, () => setAwayAsk(true));

  // A következő megálló mindig látszódjon a listában.
  useEffect(() => {
    listRef.current?.querySelector('[data-next="1"]')?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [passed, reduce, collapsed, setup]);

  const aheadTo = ride.destIdx ?? lastIdx;
  const traffic = useTrafficAhead(trip?.stops ?? null, Math.max(passed, fromIdx), aheadTo, Boolean(trip) && !turn);
  const trafficByIdx = useMemo(() => new Map(traffic.map((t) => [t.fromIdx, t])), [traffic]);
  const worst = traffic.reduce<TrafficAhead | null>((a, t) => (!a || t.excessS > a.excessS ? t : a), null);

  const dest = ride.destIdx != null ? trip?.stops[ride.destIdx] : undefined;
  const destFc = ride.destIdx != null ? trip?.forecast.get(ride.destIdx) : undefined;
  const remaining = trip && ride.destIdx != null ? Math.max(0, ride.destIdx - passed) : null;
  const from = trip && !needsFrom ? trip.stops[fromIdx] : undefined;

  const pickFrom = (idx: number) => {
    if (!trip) return;
    // a busz még ott áll (nincs indulási esemény): a felszállás most volt; korábbinál a menetrend + késés
    const fields = boardAt(trip.stops, times, idx, { at: idx >= cur ? ride.boardedAt : null, delayS: nearestDelayS(times, idx) ?? trip.delayS });
    const keepDest = ride.destIdx != null && ride.destIdx > idx;
    patchActiveRide({ fromIdx: idx, ...fields, fromConfirmed: true, destIdx: keepDest ? ride.destIdx : null, serviceDate: trip.run?.serviceDate ?? ride.serviceDate });
    setStep(keepDest || plan ? null : "to");
  };
  const pickDest = (idx: number) => {
    setDestination(idx);
    setStep(null);
  };
  const pickLoop = (p: LoopPlan) => {
    patchActiveRide({ loopPlan: p, destIdx: null, destStopId: null, destStopName: null });
    setStep(null);
  };
  const pickTo = (idx: number) => {
    setAlightPicker(false);
    finish(idx, "user", idx >= cur ? Math.round(serverNow()) : null);
  };

  const onAlight = () => {
    if (!trip) return;
    if (turn) return finish(turn.atIdx, "user", turn.arrivedAt);
    // A telefon már messze a busztól: korábban szállt le  megkérdezzük, hol.
    if (away) return setAlightPicker(true);
    finish(Math.max(currentStopIdx(trip.stops, passed, fresh ?? busPos, px.atStop), fromIdx), "user", Math.round(serverNow()));
  };

  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      aria-label="Utazás"
      // a térkép a buszt e fölött, a látható rész közepén tartja
      data-map-cover=""
      className="absolute inset-x-0 bottom-0 z-drawer flex max-h-[75dvh] flex-col overflow-hidden border-t border-border bg-card shadow-xl md:inset-x-auto md:bottom-4 md:right-4 md:max-h-[calc(100%-2rem)] md:w-[400px] md:rounded-xl md:border"
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <RouteTile short={trainNo ? `${ride.route} ${trainNo}` : ride.route} color={ride.color} text={ride.text} size="lg" />
        <div className="min-w-0 flex-1">
          {(ride.leg ?? 1) > 1 ? (
            <p className="mb-0.5 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-primary">
              <Repeat className="h-3 w-3" aria-hidden /> Körbeutazás · {ride.leg}. menet
            </p>
          ) : null}
          <p className="truncate text-sm font-bold tracking-tight">{ride.headsign}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono font-bold text-primary">{displayVehicleId(ride.vehicleId)}</span>
            <span className="text-muted-foreground">most</span>
            <span className={cn("font-mono font-semibold", delayTone(trip?.delayS))}>{trip ? delayLabel(trip.delayS) : "…"}</span>
            {trip?.vehicle?.speed != null ? <span className="font-mono text-muted-foreground">{Math.round(trip.vehicle.speed * 3.6)} km/h</span> : null}
          </p>
          {from && !setup && !turn ? (
            <button
              type="button"
              onClick={() => setStep("from")}
              className="group mt-1.5 flex max-w-full items-center gap-1.5 rounded-md text-left text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <MapPin className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">
                Felszállás: <span className="font-semibold text-foreground">{from.name}</span> · {hm(ride.boardedAt)}
              </span>
              <Pencil className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" aria-label="Felszállás helyének módosítása" />
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {following ? null : (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRefollow} aria-label={`A ${words.om} a térképen`} title={`A ${words.om} a térképen`}>
              <Crosshair />
            </Button>
          )}
          {setup ? null : (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Kinyitás" : "Összecsukás"}>
              {collapsed ? <ChevronUp /> : <ChevronDown />}
            </Button>
          )}
        </div>
      </header>

      {!trip ? (
        <>
          <p className="border-t border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">A menet megállóit töltöm…</p>
          <footer className="flex justify-end border-t border-border/70 px-4 py-2.5">
            <CancelButton words={words} onCancel={onCancel} />
          </footer>
        </>
      ) : setup ? (
        <>
          <RideSetup
            step={setup}
            ride={ride}
            trip={trip}
            times={times}
            cur={cur}
            onStep={setStep}
            onDone={needsFrom || needsDest ? null : () => setStep(null)}
            onFrom={pickFrom}
            onDest={pickDest}
            onLoop={pickLoop}
          />
          <footer className="flex justify-end border-t border-border/70 px-4 py-2.5">
            <CancelButton words={words} onCancel={onCancel} />
          </footer>
        </>
      ) : alightPicker ? (
        <AlightPicker trip={trip} times={times} lo={Math.min(lastIdx, fromIdx + 1)} hi={Math.max(fromIdx + 1, Math.min(cur, lastIdx))} cur={cur} away={away} onPick={pickTo} onBack={() => setAlightPicker(false)} />
      ) : (
        <>
          {awayAsk && !turn ? (
            <div role="alert" className="mx-4 mb-3 rounded-xl border border-late/40 bg-late/10 px-3 py-2.5">
              <p className="text-sm font-bold">Már nem vagy a buszon?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Percek óta messze vagy tőle. Amíg nem válaszolsz, az utazás megy tovább a kijelölt leszállóhelyig.</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setAwayAsk(false);
                    setAlightPicker(true);
                  }}
                >
                  <LogOut /> Leszálltam
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setAwayAsk(false);
                    setAwaySnooze(Date.now() + AWAY_SNOOZE_MS);
                  }}
                >
                  Még rajta vagyok
                </Button>
              </div>
            </div>
          ) : null}

          {turn && plan ? (
            <TurnCard turn={turn} plan={plan} cont={cont} onAlight={() => finish(turn.atIdx, "user", turn.arrivedAt)} />
          ) : plan ? (
            <div className="mx-4 mb-3 rounded-xl border border-primary/35 bg-primary/10 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <Repeat className="h-3.5 w-3.5" aria-hidden /> Körbeutazás · {trip.stops[lastIdx]?.name}
              </p>
              <p className="mt-0.5 text-sm font-bold">{plan.stopName ? `Leszállás: ${plan.stopName}` : "A végállomáson a buszon maradsz"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {plan.stopName ? "a busz következő menetén  ha odaértél, magától lezárom" : "a leszállást a következő menet indulása után adhatod meg"}
              </p>
              {worst ? <TrafficLine t={worst} trip={trip} /> : null}
              <PlanActions onChange={() => setStep("to")} />
            </div>
          ) : dest ? (
            <div className="mx-4 mb-3 rounded-xl border border-primary/35 bg-primary/10 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <Flag className="h-3.5 w-3.5" /> Leszállás
              </p>
              <p className="mt-0.5 truncate text-sm font-bold">{dest.name}</p>
              <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-muted-foreground">
                <span>
                  várhatóan <span className="font-mono text-sm font-bold text-foreground">{hm(dest.schedTs + (destFc?.delayS ?? trip.delayS ?? 0))}</span>
                </span>
                {destFc && destFc.upperS - destFc.delayS >= 60 ? (
                  <span>
                    legkésőbb <span className="font-mono font-semibold text-late">{hm(dest.schedTs + destFc.upperS)}</span>
                  </span>
                ) : null}
                {remaining != null ? <span>még {remaining} megálló</span> : null}
              </p>
              {worst ? <TrafficLine t={worst} trip={trip} /> : null}
              <PlanActions onChange={() => setStep("to")} onLoop={trip.loopEnd ? () => setStep("loop") : undefined} />
            </div>
          ) : destPending ? (
            <p className="mx-4 mb-3 text-xs text-muted-foreground">A leszállóhelyet keresem ezen a meneten…</p>
          ) : null}

          {collapsed || turn ? null : (
            <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-border/70 px-2 py-2">
              {trip.stops.map((s) => (
                <StopRow key={s.idx} s={s} trip={trip} passed={passed} ride={ride} jam={trafficByIdx.get(s.idx - 1)} />
              ))}
            </ol>
          )}

          <footer className="flex gap-2 border-t border-border/70 px-4 py-3">
            <Button className="flex-1" onClick={onAlight}>
              <LogOut /> {turn ? `Leszálltam (${turn.terminusName})` : "Leszálltam"}
            </Button>
            {turn ? null : (
              <Button variant="ghost" onClick={() => setAlightPicker(true)} title="Már korábban leszálltam  kijelölöm, hol">
                <Undo2 /> Korábban
              </Button>
            )}
            <CancelButton words={words} onCancel={onCancel} />
          </footer>
        </>
      )}
    </motion.aside>
  );
}

function CancelButton({ words, onCancel }: { words: (typeof VEHICLE_WORDS)[keyof typeof VEHICLE_WORDS]; onCancel?: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={() => {
        cancelRide();
        // a térkép se kövesse tovább a téves buszt
        onCancel?.();
      }}
      title={`Mégsem ezen a ${words.on} vagyok`}
    >
      <X /> Mégse
    </Button>
  );
}

/** A leszállóhely módosítása, és fordulóhurkos végállomásnál a körbeutazás. */
function PlanActions({ onChange, onLoop }: { onChange: () => void; onLoop?: () => void }) {
  return (
    <div className="mt-2 flex gap-2">
      <Button size="sm" variant="outline" className="flex-1 bg-card" onClick={onChange}>
        <Pencil /> Módosítom
      </Button>
      {onLoop ? (
        <Button size="sm" variant="outline" className="flex-1 bg-card" onClick={onLoop}>
          <Repeat /> Körbeutazok
        </Button>
      ) : null}
    </div>
  );
}

/** „Korábban leszálltam”: a busz által már elhagyott megállók közül. */
function AlightPicker({
  trip,
  times,
  lo,
  hi,
  cur,
  away,
  onPick,
  onBack,
}: {
  trip: TripLive;
  times: Map<number, RideStopTime>;
  lo: number;
  hi: number;
  cur: number;
  away: boolean;
  onPick: (idx: number) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
      <div className="flex items-start gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">Hol szálltál le?</p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {away ? "Úgy látom, már nem vagy a buszon. " : ""}Ahol a busz már járt, az érkezése látszik.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Vissza
        </Button>
      </div>
      <StopChoiceList className="flex-1 px-2 pb-3" stops={trip.stops} lo={lo} hi={hi} times={times} timeOf="arr" selected={null} focusIdx={cur} focusLabel="a busz most itt" onPick={onPick} />
    </div>
  );
}

/** A busz előtti legnagyobb dugó a hátralévő úton. */
function TrafficLine({ t, trip }: { t: TrafficAhead; trip: TripLive }) {
  const a = trip.stops[t.fromIdx]?.name;
  const b = trip.stops[t.fromIdx + 1]?.name;
  return (
    <span className="mt-1.5 flex items-start gap-1.5 text-xs text-foreground">
      <TrafficCone className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: trafficColor(t.level) }} aria-hidden />
      <span>
        Dugó előtted: {a} → {b}, kb. <span className="font-mono font-semibold">+{minText(t.excessS)}</span>
      </span>
    </span>
  );
}

function StopRow({ s, trip, passed, ride, jam }: { s: TripLive["stops"][number]; trip: TripLive; passed: number; ride: ActiveRide; jam?: TrafficAhead }) {
  const isPassed = s.idx <= passed;
  const isNext = s.idx === passed + 1;
  const fc = trip.forecast.get(s.idx);
  const isDest = ride.destIdx === s.idx;
  const isFrom = ride.fromIdx === s.idx;
  const canPick = !isPassed && s.idx > (ride.fromIdx ?? 0) && !isDest;
  const expected = s.schedTs + (fc?.delayS ?? trip.delayS ?? 0);
  return (
    <li data-next={isNext ? "1" : undefined}>
      {jam ? (
        // a megálló előtti szakaszon áll a forgalom
        <span className="ml-[4.25rem] flex items-center gap-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
          <span className="h-3 w-1 rounded-full" style={{ background: trafficColor(jam.level) }} aria-hidden />
          dugó · kb. +{minText(jam.excessS)}
        </span>
      ) : null}
      <button
        type="button"
        disabled={!canPick}
        onClick={() => setDestination(s.idx)}
        title={canPick ? "Itt szállok le" : undefined}
        className={cn(
          "grid w-full grid-cols-[3rem_1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left disabled:cursor-default",
          isPassed ? "opacity-45" : canPick && "hover:bg-accent",
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
          {isFrom ? <span className="ml-1.5 text-[11px] font-semibold text-muted-foreground">· itt szálltál fel</span> : null}
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

/**
 * A lezárás mezői a megadott megállónál. `alightedAt`: ha a busznak ott még nincs
 * érkezési eseménye  null esetén a menetrend és a késés adja. A felszállás ideje és
 * késése is itt véglegesül: addigra a busz indulása onnan már mért esemény.
 */
function endFields(ride: ActiveRide, trip: TripLive, times: Map<number, RideStopTime>, atIdx: number, endedBy: RideEndedBy | null, alightedAt: number | null) {
  const from = ride.fromIdx ?? 0;
  const idx = Math.min(Math.max(atIdx, from), trip.stops.length - 1);
  // Esemény nélküli megállónál a legközelebbi mért megálló késése; ha épp most nyomta meg, a busz mostani késése.
  const near = nearestDelayS(times, idx);
  const to = alightAt(trip.stops, times, idx, { at: alightedAt, delayS: alightedAt != null ? (trip.delayS ?? near) : (near ?? trip.delayS) });
  const board = times.has(from) ? boardAt(trip.stops, times, from, { at: ride.boardedAt, delayS: ride.delayAtBoardS }) : null;
  return {
    ...(board
      ? { boardedAt: board.boardedAt, delayAtBoardS: board.delayAtBoardS }
      : ride.delayAtBoardS == null
        ? { delayAtBoardS: nearestDelayS(times, from) }
        : {}),
    alightedAt: to?.alightedAt ?? alightedAt ?? Math.round(serverNow()),
    toStopId: to?.toStopId ?? null,
    toStopName: to?.toStopName ?? null,
    delayAtAlightS: to?.delayAtAlightS ?? trip.delayS,
    stops: to ? Math.max(0, idx - from) : null,
    distanceM: to ? pathLengthM(trip.stops, from, idx) : null,
    loopEnd: trip.loopEnd,
    endedBy,
  };
}

/** Körbeutazás: ez a menet a végállomáson lezárul, és ugyanazon a buszon a következő folytatódik. */
function chainNext(
  ride: ActiveRide,
  trip: TripLive,
  times: Map<number, RideStopTime>,
  turn: NonNullable<ActiveRide["turn"]>,
  next: NonNullable<Continuation["next"]>,
  dest: LoopPlan | null,
) {
  continueRide(
    endFields(ride, trip, times, turn.atIdx, null, turn.arrivedAt),
    {
      tripId: next.tripId,
      route: next.route,
      headsign: next.headsign,
      color: next.color,
      text: next.text,
      boardedAt: next.departedAt ?? Math.round(serverNow()),
      fromStopId: next.firstStopId,
      fromStopName: next.firstStopName,
      delayAtBoardS: next.startDelayS,
    },
    dest,
  );
}
