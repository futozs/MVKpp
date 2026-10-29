/** A régi API-val bájtra kompatibilis valós idejű típusok (az iOS app ezt olvassa). */

export type LiveVeh = {
  id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  routeId: string;
  tripId: string;
};

/** /live/positions egy eleme */
export type DecodedVehicle = {
  id: string;
  label: string;
  routeId: string;
  routeShort: string;
  routeColor: string;
  routeText: string;
  headsign: string;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  speed: number | null;
  tripId: string;
  timestamp: number | null;
  /** v3: az MVK által küldött eredeti trip_id (ha a feloldás miatt eltér) */
  rtTripId?: string;
};

export type StopPrediction = { unix: number; delay: number | null };

/**
 * Egy poll eredménye, előfeldolgozva: a megállónkénti előrejelzéseket
 * egyszer építjük fel, nem minden megálló-kérésnél a teljes feedből.
 */
export type RealtimeSnapshot = {
  fetchedAt: number;
  header: { version: string; timestamp: number };
  decoded: DecodedVehicle[];
  vehicles: LiveVeh[];
  /** stopId → (tripId → előrejelzés) — az első egyezés nyer, mint a régi kódban */
  predByStop: Map<string, Map<string, StopPrediction>>;
  updatesHeaderTs: number;
  updatesCount: number;
  rtError: string | null;
};

export type ArrivalItem = {
  route: string;
  color: string;
  text: string;
  headsign: string;
  time: string;
  etaMin: number;
  delaySec: number | null;
  live: boolean;
  tripId: string;
  vehicle: LiveVeh | null;
  currentStopName: string | null;
  distanceToStopKm: number | null;
  progressDesc: string | null;
  /** v3: a saját illesztőnk által mért aktuális késés (mp), ha van */
  measuredDelaySec?: number | null;
  /** v3: előre jelzett rendszám, ha még nincs élő jármű a menethez */
  predictedVehicle?: { id: string; confidence: number } | null;
  /** v3: az MVK törölte a menetet */
  cancelled?: boolean;
};

export type StopArrivals = {
  stop: { id: string; code?: string; name?: string; lat?: number; lon?: number };
  now: number;
  rtError: string | null;
  arrivals: ArrivalItem[];
};
