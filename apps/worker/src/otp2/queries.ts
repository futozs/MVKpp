/**
 * Az OTP2-lekérdezések egy helyen. Mind élőben kipróbálva (docs/MAVPLUSZ_OTP2.md
 * 5. fejezet); ha egy OTP-frissítés után egy mező eltűnik, az `errors` mező
 * szól, és a hub szondája ezt a katalógust futtatja.
 */

const VEHICLE_FIELDS = `vehicleId label lat lon heading speed lastUpdated isEstimated
  stopRelationship { status stop { gtfsId } }
  nextStop { arrivalDelay departureDelay stop { gtfsId } }
  trip { gtfsId pattern { code } route { gtfsId } }`;

/**
 * A régió járművei egy kérésben: buszok és villamosok a megye körüli dobozban,
 * a vonatok az egész országban (a megyét érintő vonat végig követhető).
 */
export const VEHICLES = `query V($b: Float!, $l: Float!, $t: Float!, $r: Float!, $nb: Float!, $nl: Float!, $nt: Float!, $nr: Float!) {
  road: vehiclePositions(swLat: $b, swLon: $l, neLat: $t, neLon: $r, modes: [TRAM, BUS, COACH, TROLLEYBUS]) { ${VEHICLE_FIELDS} }
  rail: vehiclePositions(swLat: $nb, swLon: $nl, neLat: $nt, neLon: $nr, modes: [RAIL, RAIL_REPLACEMENT_BUS, TRAMTRAIN, SUBURBAN_RAILWAY]) { ${VEHICLE_FIELDS} }
}`;

/** A dobozból kiért (pl. Budapest felé tartó) helyközi buszok mintánként. */
export function patternVehicles(codes: string[]): string {
  return `{ ${codes.map((c, i) => `p${i}: pattern(id: ${JSON.stringify(c)}) { vehiclePositions { ${VEHICLE_FIELDS} } }`).join(" ")} }`;
}

/** A régió megállói a mintáikkal (a megyét érintő minták felderítése). */
export const STOPS_IN_BBOX = `query S($a: Float!, $b: Float!, $c: Float!, $d: Float!) {
  stopsByBbox(minLat: $a, minLon: $b, maxLat: $c, maxLon: $d) { gtfsId lat lon patterns { code } }
}`;

const PATTERN_FIELDS = `code headsign directionId
  route { gtfsId shortName longName mode type color textColor agency { gtfsId name } }
  stops { gtfsId name code lat lon platformCode parentStation { gtfsId name lat lon } }
  patternGeometry { points }`;

export function patternDetails(codes: string[]): string {
  return `{ ${codes.map((c, i) => `p${i}: pattern(id: ${JSON.stringify(c)}) { ${PATTERN_FIELDS} }`).join(" ")} }`;
}

/** Egy OTP-szolgáltatási nap menetei mintánként (a megálló-azonosítók a minta sorrendjében). */
export function patternTrips(codes: string[], ymd: string): string {
  const d = JSON.stringify(ymd);
  return `{ ${codes
    .map((c, i) => `p${i}: pattern(id: ${JSON.stringify(c)}) { code tripsForDate(serviceDate: ${d}) { gtfsId tripShortName tripHeadsign directionId stoptimes { scheduledArrival scheduledDeparture pickupType dropoffType } } }`)
    .join(" ")} }`;
}

const STOPTIME_RT = `serviceDay scheduledDeparture realtimeDeparture departureDelay realtime realtimeState
  stop { gtfsId platformCode } trip { gtfsId }`;

/** Állomások / megállók táblái (valós idejű késés, vágány, törlés) egy kérésben. */
export function boards(ids: { id: string; station: boolean }[], timeRangeS: number): string {
  return `{ ${ids
    .map(
      (x, i) =>
        `b${i}: ${x.station ? "station" : "stop"}(id: ${JSON.stringify(x.id)}) { gtfsId stoptimesWithoutPatterns(numberOfDepartures: 6, timeRange: ${timeRangeS}, omitNonPickups: false) { ${STOPTIME_RT} } }`,
    )
    .join(" ")} }`;
}

/** Futó menetek valós ideje megállónként (tartalék üzemben az MVK `get-updates` helyett). */
export function tripsRealtime(ids: string[], ymd: string): string {
  const d = JSON.stringify(ymd);
  return `{ ${ids
    .map((id, i) => `t${i}: trip(id: ${JSON.stringify(id)}) { gtfsId stoptimesForDate(serviceDate: ${d}) { stop { gtfsId platformCode } realtimeDeparture departureDelay realtime realtimeState } }`)
    .join(" ")} }`;
}

export const ALERTS = `{ alerts(feeds: ["hkir", "1"]) {
  feed alertHeaderText alertDescriptionText alertEffect alertCause effectiveStartDate effectiveEndDate
  entities { __typename ... on Trip { gtfsId } ... on Route { gtfsId } ... on Stop { gtfsId } }
} }`;

/** A hub szondája: minden fenti mező egy olcsó kérésben (hibánál az `errors` megmondja, melyik tűnt el). */
export const PROBE = `{ serviceTimeRange { start end }
  stop(id: "1:005511387_0") { gtfsId stoptimesWithoutPatterns(numberOfDepartures: 1, timeRange: 3600) { ${STOPTIME_RT} } }
  vehiclePositions(swLat: 48.09, swLon: 20.78, neLat: 48.11, neLon: 20.80) { ${VEHICLE_FIELDS} } }`;
