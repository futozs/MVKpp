import type {
  JourneyPlanResponse,
  JourneyTransferCheck,
  JourneyTransitLeg,
  JourneyTrip,
} from "@/services/api";
import {
  MODE_NOUN,
  legTileText,
  delayExact,
  hm,
  hms,
  isTransit,
  localIsoDate,
  longDate,
  marginText,
  minutes,
  spanExact,
  trailingWalkSec,
  transitLegs,
} from "./format";
import { displayVehicleId } from "@/lib/modes";

/**
 * Múltbeli utazás összegzése — mit mutat a mérés a menetrendhez képest.
 * A kártya fejléce és a másolható igazolás is ebből dolgozik, hogy a kettő
 * soha ne mondjon mást.
 */
export interface PastOutcome {
  /** Az utolsó járműről való leszállás tényleges késése (mp), ha mértük. */
  arrivalDelayS: number | null;
  /** A célba érés tényleges ideje (unix), a végső gyaloglással együtt. */
  actualArrival: number | null;
  arrivalEstimated: boolean;
  /** Legalább egy menetről nincs mérés. */
  partial: boolean;
  rideCount: number;
  untrackedRoutes: string[];
  /** Az első olyan átszállás, ami a mért idők szerint nem jött volna össze. */
  missedTransfer: JourneyTransferCheck | null;
}

/** Az átszállás mindkét oldalát mértük-e (különben a tartalék menetrendi). */
export function transferMeasured(trip: JourneyTrip, index: number): boolean {
  const rides = transitLegs(trip);
  const before = rides[index]?.actual;
  const after = rides[index + 1]?.actual;
  return before?.arrDelayS != null && after?.depDelayS != null;
}

export function pastOutcome(trip: JourneyTrip): PastOutcome {
  const rides = transitLegs(trip);
  const last = rides[rides.length - 1]?.actual;
  const arrivalDelayS = trip.actualOutcome?.arrivedDelayS ?? last?.arrDelayS ?? null;
  const actualArrival = last?.arrTs != null ? last.arrTs + trailingWalkSec(trip) : null;
  const untrackedRoutes = rides
    .filter((r) => !r.actual?.tracked)
    .map((r) => r.routeShortName);
  const missedTransfer =
    trip.transferChecks.find(
      (t, i) => t.risk === "risky" && transferMeasured(trip, i),
    ) ?? null;
  return {
    arrivalDelayS,
    actualArrival,
    arrivalEstimated: Boolean(last?.estimated),
    partial: untrackedRoutes.length > 0,
    rideCount: rides.length,
    untrackedRoutes,
    missedTransfer,
  };
}

/** „4 p 41 mp késéssel érkeztél volna” */
export function outcomeHeadline(o: PastOutcome): string {
  if (o.missedTransfer) {
    return `Lekésted volna az átszállást (${o.missedTransfer.at})`;
  }
  if (o.untrackedRoutes.length === o.rideCount) return "Erről az útról nincs mérés";
  if (o.arrivalDelayS == null) return "Az érkezésről nincs mérés";
  const d = o.arrivalDelayS;
  if (Math.abs(d) < 30) return "Pontosan érkeztél volna";
  return d > 0
    ? `${spanExact(d)} késéssel érkeztél volna`
    : `${spanExact(d)}-cel korábban érkeztél volna`;
}

function arrivalVerdict(delayS: number): string {
  if (Math.abs(delayS) < 30) return `pontosan (${delayExact(delayS)})`;
  return delayS > 0 ? `${spanExact(delayS)} késés` : `${spanExact(delayS)}-cel korábban`;
}

function legLines(leg: JourneyTransitLeg, n: number): string[] {
  const a = leg.actual;
  const head = `${n}. ${legTileText(leg)} ${leg.trainName ?? MODE_NOUN[leg.mode]}${leg.headsign ? ` (${leg.headsign})` : ""}`;
  const lines = [head];
  if (!a?.tracked) {
    lines.push(`   Felszállás: ${leg.fromName}, menetrend szerint ${hm(leg.schedDep)}`);
    lines.push(`   Leszállás: ${leg.toName}, menetrend szerint ${hm(leg.schedArr)}`);
    lines.push("   Erről a menetről nincs mérés.");
    return lines;
  }
  const dep =
    a.depTs != null && a.depDelayS != null
      ? `valójában ${hms(a.depTs)} (${delayExact(a.depDelayS)})`
      : "az indulásról nincs mérés";
  const arr =
    a.arrTs != null && a.arrDelayS != null
      ? `valójában ${hms(a.arrTs)} (${delayExact(a.arrDelayS)})${a.estimated ? ", becsült" : ""}`
      : "az érkezésről nincs mérés";
  lines.push(`   Felszállás: ${leg.fromName}, menetrend szerint ${hm(leg.schedDep)}, ${dep}`);
  lines.push(`   Leszállás: ${leg.toName}, menetrend szerint ${hm(leg.schedArr)}, ${arr}`);
  if (a.vehicleId) lines.push(`   Jármű: ${displayVehicleId(a.vehicleId)}`);
  return lines;
}

/** Sima szöveges igazolás a vágólapra (pl. tanárnak, munkahelynek). */
export function buildProofText(
  plan: JourneyPlanResponse,
  trip: JourneyTrip,
  appUrl: string,
): string {
  const o = pastOutcome(trip);
  const out: string[] = [
    "Utazás a mért adatok alapján — Miskolc, MVK",
    `Dátum: ${longDate(localIsoDate(trip.start))}`,
    `Útvonal: ${plan.from.name} → ${plan.to.name}`,
    `Menetrend szerint: ${hm(trip.start)} → ${hm(trip.end)}`,
    "",
  ];
  let n = 0;
  let ride = 0;
  for (const leg of trip.legs) {
    n += 1;
    if (isTransit(leg)) {
      out.push(...legLines(leg, n));
      const check = trip.transferChecks[ride];
      if (check) {
        const measured = transferMeasured(trip, ride);
        out.push(
          `   Átszállás itt: ${check.at} — ${
            !measured
              ? `menetrend szerint ${marginText(check.marginSec)} tartalék (nincs mérés)`
              : check.marginSec < 0
                ? `a mérés szerint ${marginText(check.marginSec)}-cel lekésted volna`
                : `a mérés szerint ${marginText(check.marginSec)} tartalék`
          }`,
        );
      }
      ride += 1;
    } else {
      out.push(`${n}. Gyalog ${minutes(leg.durationSec)} (${leg.distanceMeter} m) → ${leg.toName}`);
    }
  }
  out.push("");
  if (o.actualArrival != null && o.arrivalDelayS != null) {
    out.push(
      `Érkezés: menetrend szerint ${hm(trip.end)}, valójában ${hms(o.actualArrival)}${o.arrivalEstimated ? " (becsült)" : ""} — ${arrivalVerdict(o.arrivalDelayS)}.`,
    );
  } else {
    out.push(`Érkezés: menetrend szerint ${hm(trip.end)}; az érkezésről nincs mérés.`);
  }
  if (o.missedTransfer) {
    out.push(
      `Figyelem: a mérés szerint az átszállás (${o.missedTransfer.at}) nem jött volna össze.`,
    );
  }
  if (o.partial) {
    out.push(`Megjegyzés: a(z) ${o.untrackedRoutes.join(", ")} menetéről nincs mérés.`);
  }
  out.push(
    "",
    `Forrás: MVK++ (${appUrl}) — az MVK járműveinek mért helyadataiból; menetrend: ${plan.schedule.feedVersion}.`,
  );
  return out.join("\n");
}
