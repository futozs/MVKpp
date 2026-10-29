import { useEffect, useState } from "react";
import type { LiveVehicle } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { serverNow } from "@/lib/realtime";
import { startRide, syncRides, useActiveRide, type Ride } from "@/lib/rides";
import { BoardingPrompt, RideSavedNote } from "./BoardingPrompt";
import { RidePanel } from "./RidePanel";
import { useBoardingDetector } from "./useBoardingDetector";

const SAVED_NOTE_MS = 8000;

export interface BoardInfo {
  tripId: string;
  vehicleId: string;
  route: string;
  color: string;
  text: string;
  headsign: string;
}

const TODAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Budapest" });

/** Felszállás: utazás indítása (a térkép a buszt követi). */
export function boardVehicle(info: BoardInfo, detected: "auto" | "manual") {
  startRide({
    ...info,
    serviceDate: TODAY.format(new Date(serverNow() * 1000)),
    boardedAt: Math.round(serverNow()),
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
        />
      ) : null}
      {detector.candidate && !ride ? (
        <BoardingPrompt
          vehicle={detector.candidate}
          onYes={() => {
            const v = detector.candidate!;
            boardVehicle({ tripId: v.tripId, vehicleId: v.id, route: v.routeShort, color: v.routeColor, text: v.routeText, headsign: v.headsign }, "auto");
            detector.clear();
          }}
          onNo={detector.dismiss}
        />
      ) : null}
      {saved && !ride ? <RideSavedNote ride={saved} onClose={() => setSaved(null)} /> : null}
    </>
  );
}
