import { useEffect, useState } from "react";
import type { LiveVehicle } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { serverNow, useServerClockVersion } from "@/lib/realtime";
import { canFixRide, cancelRide, extendRideLive, getActiveRide, journeyOf, startRide, syncRides, useActiveRide, useRides, type Ride } from "@/lib/rides";
import { serviceNow } from "@/lib/serviceDay";
import { BoardingPrompt, endedOnItsOwn, RideSavedNote } from "./BoardingPrompt";
import { RideAddSheet } from "./RideAddSheet";
import { RideFixSheet } from "./RideFixSheet";
import { RidePanel } from "./RidePanel";
import { fetchContinuation } from "./RideTurn";
import { useBoardingDetector, type BoardingSpot } from "./useBoardingDetector";

const SAVED_NOTE_MS = 8000;
/**
 * Végső biztosíték: egy napnál régebbi, le nem zárt utazás, amit a menet adataiból
 * sem sikerült lezárni (a menet nem tölthető be)  nem hozzuk vissza.
 */
const LOST_RIDE_S = 24 * 3600;

export interface BoardInfo {
  tripId: string;
  vehicleId: string;
  route: string;
  color: string;
  text: string;
  headsign: string;
}


/**
 * Felszállás: utazás indítása (a térkép a buszt követi). Felismert felszállásnál
 * `since` a hely és idő, ahol a telefon a busz mellett állt, mielőtt együtt
 * elindultak  a kérdésre adott válasz percekkel később is jöhet (zsebben a telefon).
 */
export function boardVehicle(info: BoardInfo, detected: "auto" | "manual", since?: BoardingSpot) {
  // folyamatban lévő utazást nem írunk felül csendben (az elveszne a naplóból)
  if (getActiveRide()) return;
  const ageS = since ? Math.max(0, (Date.now() - since.at) / 1000) : 0;
  const boardedAt = Math.round(serverNow() - ageS);
  startRide({
    ...info,
    // szolgáltatási nap (03:00-kor vált): a hajnali 1-es busz még az előző napé
    serviceDate: serviceNow(boardedAt * 1000).iso,
    boardedAt,
    boardNear: since ? { lat: since.lat, lon: since.lon } : null,
    fromIdx: null,
    fromStopId: null,
    fromStopName: null,
    delayAtBoardS: null,
    detected,
  });
}

/**
 * A térkép utazás-rétege: a felszállás felismerése (csak nyitott térképpel és
 * engedélyezett helymeghatározással), az utazás panelje és a végén az összegzés.
 * Utazás közben a térkép a buszt követi.
 */
export function RideLayer({
  vehicles,
  followingTripId,
  onFollow,
  onStopFollow,
}: {
  vehicles: LiveVehicle[];
  /** a térkép épp ezt a menetet követi */
  followingTripId: string | null;
  onFollow: (tripId: string, vehicleId: string) => void;
  onStopFollow: () => void;
}) {
  const geo = useGeo();
  const ride = useActiveRide();
  const all = useRides();
  /** a most lezárt utazás; `atLoop`: fordulóhurkos végállomáson ért véget (onnan körbe lehet még utazni) */
  const [savedState, setSavedState] = useState<{ ride: Ride; atLoop: boolean } | null>(null);
  const saved = savedState?.ride ?? null;
  const setSaved = (r: Ride | null) => setSavedState(r ? { ride: r, atLoop: false } : null);
  const [looping, setLooping] = useState(false);
  const [fixing, setFixing] = useState<{ legs: Ride[]; initial: "from" | "to" } | null>(null);
  /** a végállomáson lezárt út folytatása utólag (a buszon maradt) */
  const [continuing, setContinuing] = useState<Ride[] | null>(null);
  const watching = geo.status === "watching";
  const detector = useBoardingDetector(watching && !ride, geo.position, vehicles);

  useEffect(() => {
    void syncRides();
  }, []);

  // Lezárt vagy zsebben alvó app: az utazás megmarad, és újranyitáskor a menet adataiból
  // zárul le (a kijelölt leszállóhelyen, vagy a végállomáson)  lásd RidePanel. Ami egy nap
  // után sem zárult le, annak a menete nem tölthető be: azt elengedjük.
  // A készülék órája eltérhet (és egy visszajátszott napon el is tér): csak a szerver órájával döntünk.
  const clockVersion = useServerClockVersion();
  useEffect(() => {
    const a = getActiveRide();
    if (clockVersion > 0 && a && serverNow() - a.boardedAt > LOST_RIDE_S) cancelRide();
  }, [clockVersion]);

  // Utazás közben (és újratöltés után is) a térkép a buszt követi.
  useEffect(() => {
    if (ride) onFollow(ride.tripId, ride.vehicleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride?.tripId, ride?.vehicleId]);

  // Az app magától zárta le, vagy fordulóhurkon ért véget (onnan még körbeutazhat):
  // a jegyzet a „Körbeutazok” gombbal addig marad, amíg nem nyugtázza.
  const keepNote = Boolean(savedState?.atLoop);
  useEffect(() => {
    if (!saved || endedOnItsOwn(saved) || keepNote) return;
    const t = setTimeout(() => setSaved(null), SAVED_NOTE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, keepNote]);

  const savedLegs = saved ? journeyOf(all, saved) : [];

  return (
    <>
      {ride ? (
        <RidePanel
          // Körbeutazáskor új menet = új panel: az előző menet állapota nem keveredhet bele.
          key={ride.id}
          ride={ride}
          position={watching ? geo.position : null}
          following={followingTripId === ride.tripId}
          onFinished={(r, info) => {
            setSavedState({ ride: r, atLoop: info.atLoopTerminus });
            onStopFollow();
          }}
          onCancel={onStopFollow}
          onRefollow={() => onFollow(ride.tripId, ride.vehicleId)}
        />
      ) : null}
      {detector.candidate && !ride ? (
        <BoardingPrompt
          vehicle={detector.candidate}
          onYes={() => {
            const v = detector.candidate!;
            boardVehicle({ tripId: v.tripId, vehicleId: v.id, route: v.routeShort, color: v.routeColor, text: v.routeText, headsign: v.headsign }, "auto", v.since);
            detector.clear();
          }}
          onNo={detector.dismiss}
        />
      ) : null}
      {saved && !ride ? (
        <RideSavedNote
          ride={saved}
          onClose={() => setSaved(null)}
          onFix={
            canFixRide(savedLegs)
              ? () => {
                  setFixing({ legs: savedLegs, initial: "to" });
                  setSaved(null);
                }
              : undefined
          }
          onContinue={() => {
            setContinuing(savedLegs);
            setSaved(null);
          }}
          looping={looping}
          onLoop={
            savedState?.atLoop || saved.endedBy === "terminus"
              ? async () => {
                  // Körbeutazok: a busz következő menetével élőben folytatjuk; ha az nem
                  // derül ki (pl. már régen volt), utólag, a menetrendből vehető fel.
                  setLooping(true);
                  const legs = savedLegs;
                  const last = legs[legs.length - 1];
                  const next = last.vehicleId ? (await fetchContinuation(last.tripId, last.vehicleId))?.next : null;
                  setLooping(false);
                  setSaved(null);
                  if (next && next.kind && !next.cancelled) {
                    const r = extendRideLive(legs, {
                      tripId: next.tripId,
                      route: next.route,
                      headsign: next.headsign,
                      color: next.color,
                      text: next.text,
                      boardedAt: next.departedAt ?? next.depTs,
                      fromStopId: next.firstStopId,
                      fromStopName: next.firstStopName,
                      delayAtBoardS: next.startDelayS,
                    });
                    if (r) onFollow(r.tripId, r.vehicleId);
                  } else setContinuing(legs);
                }
              : undefined
          }
        />
      ) : null}
      {fixing ? <RideFixSheet legs={fixing.legs} initial={fixing.initial} onClose={() => setFixing(null)} /> : null}
      {continuing ? <RideAddSheet continueFrom={continuing} onClose={() => setContinuing(null)} /> : null}
    </>
  );
}
