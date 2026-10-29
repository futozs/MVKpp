export interface Stop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface Route {
  id: string;
  short: string;
  long: string;
  type: string;
  color: string;
  text: string;
}

export interface RouteGeo {
  id: string;
  short: string;
  long: string;
  type: string;
  color: string;
  text: string;
  shapes: [number, number][][];
  stops: string[];
}

export interface GtfsMeta {
  feedVersion: string;
  stops: number;
  routes: number;
  trips: number;
  shapes?: number;
  serviceRange?: { from: string; to: string } | null;
  archiveRange?: { from: string; to: string; days: number } | null;
}

export interface LiveVehicle {
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
}

export interface VehiclePositionsResponse {
  header: {
    version?: string;
    timestamp: number;
  };
  vehicles: LiveVehicle[];
}

export interface ArrivalVehicle {
  id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  routeId: string;
  tripId: string;
}

export interface ArrivalItem {
  route: string;
  color: string;
  text: string;
  headsign: string;
  time: string;
  etaMin: number;
  delaySec: number | null;
  live: boolean;
  tripId: string;
  vehicle: ArrivalVehicle | null;
  currentStopName?: string | null;
  distanceToStopKm?: number | null;
  progressDesc?: string | null;
  /** v3: a saját illesztőnk által mért aktuális késés (mp) */
  measuredDelaySec?: number | null;
  /** v3: előre jelzett rendszám, ha még nincs élő jármű ("matched": már fut, az illesztő azonosította) */
  predictedVehicle?: { id: string; confidence: number; method?: string } | null;
  /** v3: az MVK törölte a menetet */
  cancelled?: boolean;
}

export interface StopArrivalsResponse {
  stop: {
    id: string;
    code?: string;
    name?: string;
    lat?: number;
    lon?: number;
  };
  now: number;
  rtError: string | null;
  arrivals: ArrivalItem[];
}

export interface MultiArrivalsResponse {
  results: StopArrivalsResponse[];
}

export interface TripPathResponse {
  trip: string;
  route: string;
  color: string;
  text: string;
  headsign: string;
  shape: [number, number][];
  vehicle: ArrivalVehicle | null;
  nextStop?: TripProgressStop | null;
  scheduleDeviationSec?: number | null;
}

export type ActiveTab =
  | "map"
  | "multistop"
  | "timetable"
  | "parking"
  | "planner"
  | "stats";

export type SpeedFilter = "all" | "moving" | "idle";

export type VehicleSort = "route" | "id" | "speed";

export interface FilterState {
  vq: string;
  watch: string[];
  routes: string[];
  type: "all" | "bus" | "tram";
  speed: SpeedFilter;
  nearMeKm: number | null;
  sort: VehicleSort;
  stops: boolean;
  onlyWatched: boolean;
  shape: boolean;
  rstops: boolean;
  labels: boolean;
  follow: boolean;
}

export interface JwtStatus {
  present: boolean;
  exp?: number;
  expiresInSec?: number | null;
  expired?: boolean;
  installationId?: string;
}

export interface HealthResponse {
  jwt: JwtStatus;
  autoRenew: boolean;
  lastRenew: {
    at: string;
    ok: boolean;
    status?: number;
    note?: string;
  } | null;
  tokenRejected: boolean;
  gtfs: {
    feedVersion: string;
    stops: number;
  };
  installationIdKnown: boolean;
}

export interface SystemInfoResponse {
  uptimeSec: number;
  nodeVersion: string;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  };
  gtfs: {
    feedVersion: string;
    stops: number;
    routes: number;
    trips: number;
    shapes: number;
  };
  jwt: JwtStatus;
  installationId: string | null;
}

export interface WeatherResponse {
  tempC: number | null;
  feelsLikeC: number | null;
  windKmh: number | null;
  code: number;
  text: string;
  at: string;
}

export interface TripProgressStop {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  dep: number;
}

export interface TripProgressResponse {
  tripId: string;
  live: boolean;
  vehicle?: {
    id: string;
    lat: number;
    lon: number;
    speed: number | null;
  };
  stops: TripProgressStop[];
  segmentIndex: number | null;
  segmentFraction?: number;
  progress: number | null;
  nextStop?: TripProgressStop | null;
  scheduleDeviationSec?: number | null;
}

export interface TimetableDirection {
  dir: string;
  headsign: string;
  tripsToday: number;
  tripsTotal: number;
  firstDeparture: string | null;
}

export interface TimetableRoute {
  id: string;
  short: string;
  long: string;
  type: string;
  color: string;
  text: string;
  directions: TimetableDirection[];
}

export interface TimetableRoutesResponse {
  date: string;
  routes: TimetableRoute[];
}

export interface TimetableStop {
  id: string;
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
}

export interface TimetableTrip {
  tripId: string;
  headsign: string;
  departure: string;
  departureSec: number;
  arrival: string;
  arrivalSec: number;
  originName: string;
  destinationName: string;
  stopCount: number;
  deviates: boolean;
  headsignDiffers: boolean;
  times: (string | null)[];
}

export interface TimetableResponse {
  route: Route;
  dir: string;
  date: string;
  headsign: string;
  stops: TimetableStop[];
  trips: TimetableTrip[];
  note?: string;
}

export interface CancelledTrip {
  tripId: string;
  known: boolean;
  routeId: string;
  routeShort: string;
  routeColor: string;
  routeText: string;
  dir: string;
  headsign: string;
  departure: string | null;
  departureSec: number | null;
  arrival: string | null;
  originName: string | null;
  destinationName: string | null;
}

export interface CancelledTripsResponse {
  date: string;
  count: number;
  stale: boolean;
  archived: boolean;
  fetchedAt: string | null;
  tripIds: string[];
  trips: CancelledTrip[];
}

export interface TripJournalEntry {
  vehicleId: string | null;
  samples: number;
  firstSeen: number | null;
  lastSeen: number | null;
  startDelaySec: number | null;
  endDelaySec: number | null;
  actualStart: number | null;
  actualEnd: number | null;
  status: string | null;
  stopsSeen: number | null;
  stopsTotal: number | null;
}

export interface TripJournalResponse {
  date: string;
  count: number;
  source: string;
  trips: Record<string, TripJournalEntry>;
}

// ── Útvonaltervező (MVK /api/v1/route/plan) ────────────────────────────

export interface RoutePlanPoint {
  lat: number;
  lon: number;
}

export interface RoutePlanLeg {
  mode: string;
  routeShortName: string | null;
  routeLongName: string | null;
  routeColor: string | null;
  polyline: string | null;
  fromStopId: string | null;
  fromName: string;
  from: RoutePlanPoint;
  toStopId: string | null;
  toName: string;
  to: RoutePlanPoint;
  start: string;
  end: string;
  durationSec: number;
  distanceMeter: number;
  intermediateStopNames: string[];
}

export interface RoutePlanTrip {
  logDetailsId: number;
  travelProfile: string;
  start: string;
  end: string;
  durationSec: number;
  distanceMeter: number;
  legs: RoutePlanLeg[];
}

export interface RoutePlanResponse {
  logHeaderId: number;
  trips: RoutePlanTrip[];
}
