/**
 * MÁV+ OTP2 járműpozíciók → a motor saját alakja.
 *
 * Az OTP2 `lastUpdated` VALÓDI UTC (az MVK GTFS-RT-jével ellentétben, ami helyi
 * időt kódol unixként)  itt tehát nincs eltolás-levonás. Az MVK-s járművek
 * (`mvkzrt:` előtag) azonosítóit levágjuk: pontosan egyeznek a natív feedével,
 * így a tartalék forrásról jövő pontok ugyanannak a járműnek a folytatásai.
 */

export type OtpVehiclePosition = {
  vehicleId: string;
  label?: string | null;
  lat: number;
  lon: number;
  heading?: number | null;
  speed?: number | null;
  lastUpdated: number;
  isEstimated?: boolean | null;
  stopRelationship?: { status?: string | null; stop?: { gtfsId: string } | null } | null;
  nextStop?: { arrivalDelay?: number | null; departureDelay?: number | null; stop?: { gtfsId: string } | null } | null;
  trip?: { gtfsId: string; pattern?: { code: string } | null; route?: { gtfsId: string } | null } | null;
};

/** Egy jármű a forrástól függetlenül (az illesztő és a snapshot ezt kapja). */
export type RtVehicle = {
  id: string;
  label: string;
  lat: number;
  lon: number;
  bearing: number | null;
  /** m/s */
  speed: number | null;
  /** valódi UTC unix */
  ts: number;
  rtTripId: string;
  routeId: string;
  /** a minta (pattern) kódja  a megyéből kiért járművek külön követéséhez */
  pattern: string | null;
  /** menetrendből becsült helyzet, nem GPS: a térképen látszik, de nem illesztjük és nem mentjük */
  estimated: boolean;
  /** a következő megálló és a hivatalos késés ott (mp) */
  nextStopId: string | null;
  delayS: number | null;
  /** STOPPED_AT / IN_TRANSIT_TO */
  status: string | null;
};

const MVK = "mvkzrt:";
const strip = (id: string) => (id.startsWith(MVK) ? id.slice(MVK.length) : id);

export function rtFromOtp(v: OtpVehiclePosition): RtVehicle | null {
  if (!v?.vehicleId || !Number.isFinite(v.lat) || !Number.isFinite(v.lon) || !v.lastUpdated) return null;
  const trip = v.trip?.gtfsId ?? "";
  const delay = v.nextStop?.arrivalDelay ?? v.nextStop?.departureDelay ?? null;
  return {
    id: strip(v.vehicleId),
    label: v.label ?? "",
    lat: v.lat,
    lon: v.lon,
    bearing: v.heading ?? null,
    speed: v.speed ?? null,
    ts: Math.floor(v.lastUpdated),
    rtTripId: strip(trip),
    routeId: strip(v.trip?.route?.gtfsId ?? ""),
    pattern: v.trip?.pattern?.code ?? null,
    estimated: v.isEstimated === true,
    nextStopId: v.nextStop?.stop?.gtfsId ? strip(v.nextStop.stop.gtfsId) : null,
    delayS: delay == null || !Number.isFinite(delay) ? null : Math.round(delay),
    status: v.stopRelationship?.status ?? null,
  };
}

/** Az MVK-s jármű-e (a tartalék forrásnál ezek mennek az MVK-ágra). */
export const isMvkVehicle = (v: OtpVehiclePosition) => v.vehicleId.startsWith(MVK);
