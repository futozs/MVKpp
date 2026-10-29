import { useEffect, useState } from "react";
import type { LiveVehicle } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { serverNow, useServerClockVersion } from "@/lib/realtime";
import { cancelRide, getActiveRide, startRide, syncRides, useActiveRide, type Ride } from "@/lib/rides";
import { serviceNow } from "@/lib/serviceDay";
import { BoardingPrompt, RideSavedNote } from "./BoardingPrompt";
import { RidePanel } from "./RidePanel";
import { useBoardingDetector, type BoardingSpot } from "./useBoardingDetector";

const SAVED_NOTE_MS = 8000;
/** ennél régebbi, le nem zárt utazás biztosan véget ért (a leghosszabb miskolci menet is ~1 óra) */
const STALE_RIDE_S = 3 * 3600;

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
 * elindultak — a kérdésre adott válasz percekkel később is jöhet (zsebben a telefon).
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
  onFollow,
  onStopFollow,
}: {
  vehicles: LiveVehicle[];
  onFollow: (tripId: string, vehicleId: string) => void;
  onStopFollow: () => void;
}) {
  const geo = useGeo();
  const ride = useActiveRide();
  const [saved, setSaved] = useState<Ride | null>(null);
  const watching = geo.status === "watching";
  const detector = useBoardingDetector(watching && !ride, geo.position, vehicles);

  useEffect(() => {
    void syncRides();
  }, []);

  // Zsebben felejtett, sosem lezárt utazás (a felfüggesztett app nem tudja lezárni): órák múlva
  // nem hozzuk vissza — a szerver órájához mérve, ami a kapcsolódáskor érkezik.
  const clockVersion = useServerClockVersion();
  useEffect(() => {
    const a = getActiveRide();
    if (a && serverNow() - a.boardedAt > STALE_RIDE_S) cancelRide();
  }, [clockVersion]);

  // Utazás közben (és újratöltés után is) a térkép a buszt követi.
  useEffect(() => {
    if (ride) onFollow(ride.tripId, ride.vehicleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride?.tripId, ride?.vehicleId]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), SAVED_NOTE_MS);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <>
      {ride ? (
        <RidePanel
          // Körbeutazáskor új menet = új panel: az előző menet állapota nem keveredhet bele.
          key={ride.id}
          ride={ride}
          position={watching ? geo.position : null}
          onFinished={(r) => {
            setSaved(r);
            onStopFollow();
          }}
          onCancel={onStopFollow}
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
      {saved && !ride ? <RideSavedNote ride={saved} onClose={() => setSaved(null)} /> : null}
    </>
  );
}
