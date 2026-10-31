import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, ChevronUp, Crosshair, Flag, LogOut, MapPin, Pencil, Repeat, TrafficCone, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import { delayLabel, delayTone } from "@/components/transit/DelayBar";
import { trafficColor } from "@/components/map/trafficColor";
import { cn } from "@/lib/utils";
import { cancelRide, continueRide, finishRide, patchActiveRide, setDestination, type ActiveRide, type Ride, type RideEndedBy } from "@/lib/rides";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { alightAt, boardAt, currentStopIdx, guessAlightIdx, guessBoardIdx, stopTimes, type RideStopTime } from "@mvk/core/rides";
import { useAlightingDetector } from "./useBoardingDetector";
import { TurnCard, useContinuation, type Continuation } from "./RideTurn";
import { distM, pathLengthM, useTripLive, type TripLive } from "./useTripLive";
import { useTrafficAhead, type TrafficAhead } from "./useTrafficAhead";
import { StopChoiceList } from "./StopChoiceList";
import { turnDecision } from "@mvk/core/loops";
import { serverNow, useServerClockVersion } from "@/lib/realtime";
import { displayVehicleId, RIDE_PROXIMITY, rideModeOf, VEHICLE_WORDS } from "@/lib/modes";

// A telefon és a jármű távolságai módonként (vonatnál tágabbak): lásd RIDE_PROXIMITY.
/** a telefon helye ennyi ideig számít frissnek (ms) */
const FRESH_POS_MS = 60_000;
/** „Felszálltam” után ennyi ideig a telefon helye még a felszállás helye (mp) */
const BOARD_POS_S = 120;
/**
 * Ha a végállomásra érkezés után ennyivel vesszük csak észre (bezárt vagy zsebben
 * alvó app), ott szállt le — nem folytatjuk a következő menettel (mp).
 */
const LATE_TURN_S = 300;
/** a soha le nem zárt utazás, amelynek a menetéről nincs adat: ennyi idő után véget ért (mp) */
const STALE_RIDE_S = 3 * 3600;

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
const hm = (unix: number) => HM.format(new Date(unix * 1000));
const minText = (s: number) => `${Math.max(1, Math.round(s / 60))} perc`;

type Picker = "from" | "to";

/**
 * Felszállás után: hol jár a busz, mennyit késik, mennyit késhet, hol áll a
 * forgalom előtte, és mikor melyik megállóban áll meg — a menet végéig, vagy
 * amíg le nem szállsz. Itt erősíted meg (vagy javítod), hol szálltál fel, és
 * itt jelölheted ki utólag is, hol szálltál le.
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
  onFinished: (r: Ride) => void;
  onCancel?: () => void;
  onRefollow: () => void;
}) {
  const trip = useTripLive(ride.tripId, ride.serviceDate);
  // vonatnál a csempén a vonatszám is („Sz 5169”), mint a térképen
  const trainNo = rideModeOf(ride.vehicleId, ride.tripId) === "rail" ? (/^\d+/.exec(trip?.tripShort ?? "")?.[0] ?? null) : null;
  const turn = ride.turn ?? null;
  const cont = useContinuation(ride.tripId, ride.vehicleId, Boolean(turn));
  // Fordulás közben a busz már a következő menetén van: a helyét a folytatás adja.
  const live = turn ? (cont?.vehicle ?? null) : (trip?.vehicle ?? null);
  const vLat = live?.lat ?? null;
  const vLon = live?.lon ?? null;
  const busPos = useMemo(() => (vLat != null && vLon != null ? { lat: vLat, lon: vLon } : null), [vLat, vLon]);
  // „Vele maradt” / „már nincs rajta” / „a megállóban áll” — módonként (a vonat hosszú, a jele késik)
  const px = RIDE_PROXIMITY[rideModeOf(ride.vehicleId, ride.tripId)];
  const withBusM = px.withBus;
  const awayM = px.away;
  const words = VEHICLE_WORDS[rideModeOf(ride.vehicleId, ride.tripId)];
  const reduce = useReducedMotion();
  const [collapsed, setCollapsed] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const passed = trip?.run?.lastStopIdx ?? -1;
  const times = useMemo(() => stopTimes(trip?.events ?? []), [trip?.events]);
  const fresh = position && Date.now() - position.at <= FRESH_POS_MS ? position : null;
  const away = Boolean(fresh && busPos && distM(fresh, busPos) > awayM);
  // ahol a busz most tart (ha a megállóban áll, az már az a megálló)
  const cur = trip ? currentStopIdx(trip.stops, passed, busPos, px.atStop) : 0;
  const fromIdx = ride.fromIdx ?? 0;
  // Az időn múló döntések (későn észrevett végállomás, órák óta le nem zárt utazás) a szerver
  // órájával: a készüléké eltérhet, a kapcsolódásig csak az ismert.
  const clockReady = useServerClockVersion() > 0;

  const finish = (atIdx: number, endedBy: RideEndedBy, alightedAt: number | null) => {
    if (!trip) return;
    const r = finishRide(endFields(ride, trip, times, atIdx, endedBy, alightedAt));
    if (r) onFinished(r);
  };

  // A felszállás helye az első adatból: a megálló, ahol a telefon a busz mellett állt
  // (felismerésnél még az együttes indulás előtt), vagy ahol a busz épp áll. Ezt utána megkérdezzük.
  useEffect(() => {
    if (!trip || ride.fromIdx != null || !trip.stops.length) return;
    const justBoarded = serverNow() - ride.boardedAt <= BOARD_POS_S;
    const phoneNearBus = position && (!busPos || distM(position, busPos) <= awayM);
    const spot = ride.boardNear ?? (justBoarded && phoneNearBus ? { lat: position.lat, lon: position.lon } : null);
    const idx = guessBoardIdx(trip.stops, passed, spot, busPos);
    // A busz még ott áll (nincs indulási esemény): a felszállás ideje a gombnyomásé.
    const fields = boardAt(trip.stops, times, idx, { at: ride.boardedAt, delayS: trip.delayS });
    patchActiveRide({ fromIdx: idx, ...fields, serviceDate: trip.run?.serviceDate ?? ride.serviceDate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, ride.fromIdx]);

  // Amikor a telefon a busszal van: megjegyezzük, meddig jutott vele (bezárt app után is) —
  // ennél korábban biztosan nem szállt le.
  useEffect(() => {
    if (turn || !position || !busPos || distM(position, busPos) > withBusM) return;
    if (ride.withBus?.passed === passed) return;
    patchActiveRide({ withBus: { passed, at: Math.round(serverNow()) } });
  }, [turn, position, busPos, passed, ride.withBus?.passed]);

  // Vége: a menet befejeződött, vagy a busz elhagyta a kijelölt leszállóhelyet.
  // Ha végállomásig utazott, és nem jelölt ki leszállóhelyet, a busz fordul: élőben innen a
  // körbeutazás dönt (lásd lent); ha csak utólag vesszük észre, a végállomáson leszállt.
  useEffect(() => {
    if (!trip?.run || ride.fromIdx == null || turn || picker) return;
    // Lezárt menetnél csak akkor, ha közben haladt is (épp véget ért menetre szállva ne zárjon azonnal).
    const done = trip.run.status !== "running" && passed > ride.fromIdx;
    const pastDest = ride.destIdx != null && passed >= ride.destIdx;
    if (!done && !pastDest) return;
    if (pastDest) return finish(ride.destIdx!, "dest", null);
    if (!clockReady) return;
    const lastIdx = trip.stops.length - 1;
    const now = Math.round(serverNow());
    const arrivedAt = trip.run.actualEnd ?? times.get(lastIdx)?.arr ?? now;
    if (passed >= lastIdx && now - arrivedAt <= LATE_TURN_S) {
      patchActiveRide({ turn: { arrivedAt, atIdx: lastIdx, terminusName: trip.stops[lastIdx]?.name ?? "végállomás", stay: null } });
      return;
    }
    finish(lastIdx, "terminus", arrivedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, passed, ride.fromIdx, ride.destIdx, turn, picker, clockReady]);

  // Soha le nem zárt utazás, amelynek a menetéről a szerveren sincs futás (nem indult el, vagy
  // nem látszott): órák múlva a menetrend szerinti végállomáson lezárjuk; megálló nélkül nincs mit menteni.
  useEffect(() => {
    if (!trip || trip.run || ride.fromIdx == null || !clockReady || serverNow() - ride.boardedAt < STALE_RIDE_S) return;
    if (trip.stops.length < 2) {
      cancelRide();
      onCancel?.();
      return;
    }
    finish(trip.stops.length - 1, "terminus", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, ride.fromIdx, clockReady]);

  // Körbeutazás: a végállomáson a busz a következő menettel folytatja.
  useEffect(() => {
    if (!turn || !trip) return;
    const withBus = position && busPos ? distM(position, busPos) <= withBusM : null;
    const decision = turnDecision(turn, cont, Math.round(serverNow()), withBus);
    if (decision === "alight") finish(turn.atIdx, turn.stay === false ? "user" : "terminus", turn.arrivedAt);
    else if (decision === "continue" && cont?.next) chainNext(ride, trip, times, turn, cont.next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, cont, trip, ride, position, busPos]);

  // Ha a telefon tartósan eltávolodik a busztól: leszállt. A felismerés csak percekkel a
  // leszállás után jelez, addig a busz már 2–3 megállóval továbbment — ezért a telefonhoz
  // legközelebbi elhagyott megállót vesszük, de nem korábbit annál, ahol még a busszal volt.
  useAlightingDetector(Boolean(trip) && ride.fromIdx != null && !picker, position, busPos, () => {
    if (!trip) return;
    if (turn) return finish(turn.atIdx, "terminus", turn.arrivedAt);
    finish(guessAlightIdx(trip.stops, fromIdx, passed, position, ride.withBus?.passed ?? null), "away", null);
  });

  // A következő megálló mindig látszódjon a listában.
  useEffect(() => {
    listRef.current?.querySelector('[data-next="1"]')?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [passed, reduce, collapsed, picker]);

  const lastIdx = (trip?.stops.length ?? 1) - 1;
  const aheadTo = ride.destIdx ?? lastIdx;
  const traffic = useTrafficAhead(trip?.stops ?? null, Math.max(passed, fromIdx), aheadTo, Boolean(trip) && !turn);
  const trafficByIdx = useMemo(() => new Map(traffic.map((t) => [t.fromIdx, t])), [traffic]);
  const worst = traffic.reduce<TrafficAhead | null>((a, t) => (!a || t.excessS > a.excessS ? t : a), null);

  const dest = ride.destIdx != null ? trip?.stops[ride.destIdx] : undefined;
  const destFc = ride.destIdx != null ? trip?.forecast.get(ride.destIdx) : undefined;
  const remaining = trip && ride.destIdx != null ? Math.max(0, ride.destIdx - passed) : null;
  const from = trip && ride.fromIdx != null ? trip.stops[ride.fromIdx] : undefined;
  const askBoard = Boolean(trip && from && !ride.fromConfirmed && !turn);

  const pickFrom = (idx: number) => {
    if (!trip) return;
    // a busz még ott áll (nincs indulási esemény): a felszállás most volt; korábbinál a menetrend + késés
    const fields = boardAt(trip.stops, times, idx, { at: idx >= cur ? ride.boardedAt : null, delayS: trip.delayS });
    patchActiveRide({ fromIdx: idx, ...fields, fromConfirmed: true, destIdx: ride.destIdx != null && ride.destIdx <= idx ? null : ride.destIdx });
    setPicker(null);
  };
  const pickTo = (idx: number) => finish(idx, "user", idx >= cur ? Math.round(serverNow()) : null);

  const onAlight = () => {
    if (!trip) return;
    if (turn) return finish(turn.atIdx, "user", turn.arrivedAt);
    // A telefon már messze a busztól: korábban szállt le — megkérdezzük, hol.
    if (away) return setPicker("to");
    finish(Math.max(currentStopIdx(trip.stops, passed, fresh ?? busPos, px.atStop), fromIdx), "user", Math.round(serverNow()));
  };

  const alightSuggest = trip ? guessAlightIdx(trip.stops, fromIdx, passed, fresh, ride.withBus?.passed ?? null) : null;

  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      aria-label="Utazás"
      // a térkép a buszt e fölött, a látható rész közepén tartja
      data-map-cover=""
      className="absolute inset-x-0 bottom-0 z-drawer flex max-h-[70dvh] flex-col overflow-hidden border-t border-border bg-card shadow-xl md:inset-x-auto md:bottom-4 md:right-4 md:max-h-[calc(100%-2rem)] md:w-[400px] md:rounded-xl md:border"
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
          {from && ride.fromConfirmed && !turn ? (
            <button
              type="button"
              onClick={() => setPicker("from")}
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
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Kinyitás" : "Összecsukás"}>
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
      </header>

      {picker && trip ? (
        <PickerPanel
          picker={picker}
          trip={trip}
          times={times}
          lo={picker === "from" ? 0 : Math.min(lastIdx, fromIdx + 1)}
          hi={picker === "from" ? Math.min(cur, lastIdx - 1, ride.destIdx != null ? ride.destIdx - 1 : Infinity) : Math.max(fromIdx + 1, Math.min(cur, lastIdx))}
          selected={picker === "from" ? fromIdx : alightSuggest}
          away={away}
          onPick={picker === "from" ? pickFrom : pickTo}
          onBack={() => setPicker(null)}
        />
      ) : (
        <>
          {askBoard && from ? (
            <div role="group" aria-label="Felszállás helye" className="mx-4 mb-3 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <MapPin className="h-3.5 w-3.5" aria-hidden /> Itt szálltál fel?
              </p>
              <p className="mt-0.5 truncate text-sm font-bold">
                {from.name} <span className="font-mono text-xs font-semibold text-muted-foreground">· {hm(ride.boardedAt)}</span>
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => patchActiveRide({ fromConfirmed: true })}>
                  <Check /> Igen, itt
                </Button>
                <Button size="sm" variant="outline" className="flex-1" onClick={() => setPicker("from")}>
                  Máshol szálltam fel
                </Button>
              </div>
            </div>
          ) : null}

          {turn ? (
            <TurnCard
              turn={turn}
              cont={cont}
              onStay={() => patchActiveRide({ turn: { ...turn, stay: true } })}
              onAlight={() => patchActiveRide({ turn: { ...turn, stay: false } })}
            />
          ) : dest ? (
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
              {worst && trip ? <TrafficLine t={worst} trip={trip} /> : null}
            </div>
          ) : askBoard ? null : (
            <div className="mx-4 mb-3 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              Koppints arra a megállóra, ahol leszállsz — megmutatom, mikorra érsz oda.
              {trip?.loopEnd ? (
                <span className="mt-1 flex items-start gap-1.5 text-foreground">
                  <Repeat className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                  <span>
                    {trip.stops.at(-1)?.name} fordulóhurok: ha ülve maradsz, a busszal együtt automatikusan folytatom a következő menettel (körbeutazás).
                  </span>
                </span>
              ) : null}
              {worst && trip ? <TrafficLine t={worst} trip={trip} /> : null}
            </div>
          )}

          {collapsed || !trip || turn ? null : (
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
              <Button variant="ghost" onClick={() => setPicker("to")} title="Már korábban leszálltam — kijelölöm, hol" disabled={!trip}>
                <Undo2 /> Korábban
              </Button>
            )}
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
          </footer>
        </>
      )}
    </motion.aside>
  );
}

/** Fel- vagy leszállás helyének kiválasztása a menet megállóiból. */
function PickerPanel({
  picker,
  trip,
  times,
  lo,
  hi,
  selected,
  away,
  onPick,
  onBack,
}: {
  picker: Picker;
  trip: TripLive;
  times: Map<number, RideStopTime>;
  lo: number;
  hi: number;
  selected: number | null;
  away: boolean;
  onPick: (idx: number) => void;
  onBack: () => void;
}) {
  const isFrom = picker === "from";
  const hint = isFrom
    ? "Ahol a busz már járt, az indulása látszik."
    : away
      ? "Úgy látom, már nem vagy a buszon — a javasolt megállót a helyzeted alapján jelöltem ki."
      : "Ahol a busz már járt, az érkezése látszik.";
  const marks = useMemo(() => (selected != null && !isFrom ? new Map([[selected, "javasolt"]]) : undefined), [selected, isFrom]);
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
      <div className="flex items-start gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{isFrom ? "Hol szálltál fel?" : "Hol szálltál le?"}</p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Vissza
        </Button>
      </div>
      <StopChoiceList
        className="flex-1 px-2 pb-3"
        stops={trip.stops}
        lo={lo}
        hi={hi}
        times={times}
        timeOf={isFrom ? "dep" : "arr"}
        selected={selected}
        marks={marks}
        onPick={onPick}
      />
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
 * érkezési eseménye — null esetén a menetrend és a késés adja.
 */
function endFields(ride: ActiveRide, trip: TripLive, times: Map<number, RideStopTime>, atIdx: number, endedBy: RideEndedBy | null, alightedAt: number | null) {
  const from = ride.fromIdx ?? 0;
  const idx = Math.min(Math.max(atIdx, from), trip.stops.length - 1);
  const to = alightAt(trip.stops, times, idx, { at: alightedAt, delayS: trip.delayS });
  return {
    alightedAt: to?.alightedAt ?? alightedAt ?? Math.round(serverNow()),
    toStopId: to?.toStopId ?? null,
    toStopName: to?.toStopName ?? null,
    delayAtAlightS: to?.delayAtAlightS ?? trip.delayS,
    stops: to ? Math.max(0, idx - from) : null,
    distanceM: to ? pathLengthM(trip.stops, from, idx) : null,
    endedBy,
  };
}

/** Körbeutazás: ez a menet a végállomáson lezárul, és ugyanazon a buszon a következő folytatódik. */
function chainNext(ride: ActiveRide, trip: TripLive, times: Map<number, RideStopTime>, turn: NonNullable<ActiveRide["turn"]>, next: NonNullable<Continuation["next"]>) {
  continueRide(endFields(ride, trip, times, turn.atIdx, null, turn.arrivedAt), {
    tripId: next.tripId,
    route: next.route,
    headsign: next.headsign,
    color: next.color,
    text: next.text,
    boardedAt: next.departedAt ?? Math.round(serverNow()),
    fromStopId: next.firstStopId,
    fromStopName: next.firstStopName,
    delayAtBoardS: next.startDelayS,
  });
}
