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
  /** A feed naptári érvényessége, YYYYMMDD alakban. */
  serviceRange?: { from: string; to: string } | null;
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

export type ActiveTab = "map" | "multistop" | "timetable" | "stats";

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
  /** Csak a figyelőre felvett megállók látszanak a térképen. */
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
  originName: string;
  destinationName: string;
  stopCount: number;
  deviates: boolean;
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
