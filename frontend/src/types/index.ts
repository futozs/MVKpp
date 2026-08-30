// GTFS Static Types
export interface Stop {
  id: string
  code: string
  name: string
  lat: number
  lon: number
}

export interface Route {
  id: string
  short: string
  long: string
  type: string
  color: string
  text: string
}

export interface RouteGeo {
  id: string
  short: string
  long: string
  type: string
  color: string
  text: string
  shapes: [number, number][][]
  stops: string[]
}

export interface GtfsMeta {
  feedVersion: string
  stops: number
  routes: number
  trips: number
  shapes?: number
}

// Real-time Vehicle Positions
export interface LiveVehicle {
  id: string
  label: string
  routeId: string
  routeShort: string
  routeColor: string
  routeText: string
  headsign: string
  lat: number | null
  lon: number | null
  bearing: number | null
  speed: number | null
  tripId: string
  timestamp: number | null
}

export interface VehiclePositionsResponse {
  header: {
    version?: string
    timestamp: number
  }
  vehicles: LiveVehicle[]
}

// Real-time Arrivals
export interface ArrivalVehicle {
  id: string
  lat: number
  lon: number
  bearing: number | null
  speed: number | null
  routeId: string
  tripId: string
}

export interface ArrivalItem {
  route: string
  color: string
  text: string
  headsign: string
  time: string
  etaMin: number
  delaySec: number | null
  live: boolean
  tripId: string
  vehicle: ArrivalVehicle | null
  currentStopName?: string | null
  distanceToStopKm?: number | null
  progressDesc?: string | null
}

export interface StopArrivalsResponse {
  stop: {
    id: string
    code?: string
    name?: string
    lat?: number
    lon?: number
  }
  now: number
  rtError: string | null
  arrivals: ArrivalItem[]
}

export interface MultiArrivalsResponse {
  results: StopArrivalsResponse[]
}

// Live Trip Path
export interface TripPathResponse {
  trip: string
  route: string
  color: string
  text: string
  headsign: string
  shape: [number, number][]
  vehicle: ArrivalVehicle | null
}

// View and Filter State
export type ActiveTab = 'map' | 'multistop' | 'timetable'

export interface FilterState {
  vq: string
  watch: string[]
  routes: string[]
  type: 'all' | 'bus' | 'tram'
  moving: boolean
  stops: boolean
  shape: boolean
  rstops: boolean
  labels: boolean
  follow: boolean
}

// Gateway diagnosztika
export interface JwtStatus {
  present: boolean
  exp?: number
  expiresInSec?: number | null
  expired?: boolean
  installationId?: string
}

export interface HealthResponse {
  jwt: JwtStatus
  autoRenew: boolean
  lastRenew: {
    at: string
    ok: boolean
    status?: number
    note?: string
  } | null
  tokenRejected: boolean
  gtfs: {
    feedVersion: string
    stops: number
  }
  installationIdKnown: boolean
}

export interface SystemInfoResponse {
  uptimeSec: number
  nodeVersion: string
  memory: {
    rssMb: number
    heapUsedMb: number
    heapTotalMb: number
  }
  gtfs: {
    feedVersion: string
    stops: number
    routes: number
    trips: number
    shapes: number
  }
  jwt: JwtStatus
  installationId: string | null
}


// ── Menetrendkönyv ───────────────────────────────────────────────────────────
export interface TimetableDirection {
  /** GTFS direction_id. Önmagában semmit nem mond — a headsign a beszédes név. */
  dir: string
  headsign: string
  tripsToday: number
  tripsTotal: number
  firstDeparture: string | null
}

export interface TimetableRoute {
  id: string
  short: string
  long: string
  type: string
  color: string
  text: string
  directions: TimetableDirection[]
}

export interface TimetableRoutesResponse {
  date: string
  routes: TimetableRoute[]
}

export interface TimetableStop {
  id: string
  code: string
  name: string
  lat: number | null
  lon: number | null
}

export interface TimetableTrip {
  tripId: string
  headsign: string
  departure: string
  departureSec: number
  arrival: string
  originName: string
  destinationName: string
  stopCount: number
  /** A menet a fő megállósoron kívüli megállókat is érint (betérő). */
  deviates: boolean
  /** A megállósorral egy indexre igazítva; null = ez a menet kihagyja. */
  times: (string | null)[]
}

export interface TimetableResponse {
  route: Route
  dir: string
  date: string
  headsign: string
  stops: TimetableStop[]
  trips: TimetableTrip[]
  note?: string
}
