import type {
  JourneyPrediction,
  JourneyTransferCheck,
  JourneyTrip,
  TransferRisk,
} from "@/services/api";
import { ON_TIME_SEC, trailingWalkSec, transitLegs } from "./format";

/** Mai / jövőbeli utazás: mikorra érsz be várhatóan, és rossz esetben. */
export interface TripForecast {
  arrDelayS: number | null;
  /** Várható célba érés (unix), a végső gyaloglással együtt. */
  expectedArrival: number | null;
  /** Rossz eset (85. percentilis), ha érdemben későbbi a várhatónál. */
  worstArrival: number | null;
  hasLive: boolean;
  hasData: boolean;
}

export function tripForecast(trip: JourneyTrip): TripForecast {
  const rides = transitLegs(trip);
  const last = rides[rides.length - 1];
  const p = last?.prediction;
  const walk = trailingWalkSec(trip);
  const arr = p?.arrDelayS ?? null;
  const p85 = p?.arrDelayP85S ?? null;
  return {
    arrDelayS: arr,
    expectedArrival: last && arr != null ? last.schedArr + arr + walk : null,
    worstArrival:
      last && p85 != null && p85 - (arr ?? 0) >= ON_TIME_SEC
        ? last.schedArr + p85 + walk
        : null,
    hasLive: rides.some((r) => r.prediction?.source === "live"),
    hasData: rides.some((r) => r.prediction && r.prediction.source !== "none"),
  };
}

const RISK_ORDER: Record<TransferRisk, number> = { safe: 0, tight: 1, risky: 2 };

/** A legrosszabb átszállás  ezt emeljük ki a kártya fejlécében. */
export function worstTransfer(
  trip: JourneyTrip,
): { check: JourneyTransferCheck; index: number } | null {
  let best: { check: JourneyTransferCheck; index: number } | null = null;
  for (let index = 0; index < trip.transferChecks.length; index++) {
    const check = trip.transferChecks[index];
    const worse =
      !best ||
      RISK_ORDER[check.risk] > RISK_ORDER[best.check.risk] ||
      (RISK_ORDER[check.risk] === RISK_ORDER[best.check.risk] && (check.chance ?? 1) < (best.check.chance ?? 1));
    if (worse) {
      best = { check, index };
    }
  }
  return best;
}

/** „élő adat” / „959 korábbi mérés alapján” / „nincs adat” */
export function basisLabel(p: JourneyPrediction | undefined): string {
  if (!p || p.source === "none") return "nincs adat, menetrendi idő";
  if (p.source === "live") return "élő adat";
  return `${p.samples.toLocaleString("hu-HU")} korábbi mérés alapján`;
}
