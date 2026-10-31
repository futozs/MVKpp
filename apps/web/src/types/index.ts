/** Közlekedési mód: MVK villamos, MVK busz, Volán (helyközi busz), vasút. */
export type TransitMode = "tram" | "bus" | "coach" | "rail";

export interface Stop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** v3 (?modes=): melyik forrásé — "mvk", "coach" (Volán) vagy "rail" */
  feed?: "mvk" | "coach" | "rail";
  /** v3: a szülő-állomás (vasútállomás, autóbusz-állomás) — a vágány / kocsiállás így tartozik hozzá */
  parent?: string;
  /** v3: maga az állomás */
  station?: boolean;
  /**
   * v3: közös megálló — ez a Volán-megálló ugyanott áll, mint ez az MVK-oszlop
   * (összevont nézetben nem külön tétel, az MVK-oszlop táblája mutatja a járatait)
   */
  twinOf?: string;
}

export interface Route {
  id: string;
  short: string;
  long: string;
  type: string;
  color: string;
  text: string;
  /** v3 (?modes=): mód, a statisztikai kulcs (MVK: a rövid név), üzemeltető */
  mode?: TransitMode;
  key?: string;
  operator?: string;
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
  /** v3: a Volán és a vasút a mai menetrendben — „pending”, amíg a worker indulás után építi */
  regional?: "off" | "pending" | "ready";
}

/**
 * A jármű helyzete a nyomvonalán (a WebSocket küldi): s = nyomvonal, a = hol tart (m),
 * t = a jel ideje (unix), e = a következő megálló (m), v = várható sebesség (m/s).
 */
export interface LiveMotion {
  s: string;
  a: number;
  t: number;
  e: number;
  v: number;
  /** várható pálya: [hely a nyomvonalon (m), idő a jel óta (mp)] — ezt követi a térkép */
  k?: [number, number][] | null;
}

export interface LiveVehicle {
  /** v3: a térképi becsléshez (csak WebSocketen) */
  motion?: LiveMotion | null;
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
  /** v3: közlekedési mód és a vonal kulcsa (a natív MVK-jármű nem hordozza) */
  mode?: TransitMode;
  routeKey?: string;
  /** v3: rendszám (Volán, és az MVK-é a tartalék forrásból) */
  plate?: string;
  /** v3: vasút: vonatszám és név (TOKAJ) */
  trainNo?: string;
  trainName?: string;
  /** v3: hivatalos késés a következő megállónál (mp) — Volán, vasút, tartalék üzem */
  delaySec?: number | null;
  /** v3: menetrendből becsült helyzet (nem GPS) */
  estimated?: boolean;
  /** v3: "otp2" = a MÁV+ adatából (regionális, vagy MVK tartalékban) */
  source?: "otp2";
  /** v3 (WebSocket): a saját illesztőnk mért késése most (mp) */
  liveDelaySec?: number | null;
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
  /** v3, regionális jármű (a menet-követésben): mód, rendszám, vonatszám és -név */
  mode?: TransitMode;
  plate?: string;
  trainNo?: string;
  trainName?: string;
  /** a MÁV által közölt késés (mp) — vonatnál ez a hivatalos, a menetrend is ebből számol */
  delaySec?: number;
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
  /** v3: várható késés ennél a megállónál és a 85%-os felső becslés (mp) */
  forecastDelaySec?: number | null;
  forecastUpperSec?: number | null;
  /** v3: menetrend szerinti idő ennél a megállónál (unix) */
  schedUnix?: number | null;
  /** v3: késve indul / valószínűleg kimarad — a busza még az előző menetén jár */
  startRisk?: {
    vehicleId: string;
    expectedDelayS: number;
    level: "late" | "likely-missed";
    prevRoute: string | null;
    prevEndUnix: number;
    predicted: boolean;
  } | null;
  /** v3: dugó a busz előtt a megállóig */
  trafficAhead?: { excessS: number; level: number; fromName: string; toName: string } | null;
  /** v3 (?modes=): mód, vonal-kulcs, üzemeltető */
  mode?: TransitMode;
  routeKey?: string;
  operator?: string | null;
  /** v3: vasút: vonatszám, név (TOKAJ) */
  trainNo?: string | null;
  trainName?: string | null;
  /** v3: vágány / kocsiállás (élőben változhat) */
  platform?: string | null;
  platformChanged?: boolean;
  /** v3: a vágány még nincs kiadva — a korábbi napok szerinti várható */
  platformPredicted?: boolean;
  /** v3: a megálló (állomásnál a vágány), ahonnan indul */
  stopId?: string;
  /** v3: hivatalos megjegyzések (késés oka, kocsiösszeállítás, pótlóbusz) */
  notices?: string[];
}

export interface StopArrivalsResponse {
  stop: {
    id: string;
    code?: string;
    name?: string;
    lat?: number;
    lon?: number;
  };
  /** v3: közös megálló — a táblán ezeknek a megállóknak az indulásai (MVK-oszlop + Volán-pár) */
  merged?: string[];
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

/** A térkép késés-szűrője: a hivatalos (MÁV+) vagy a saját illesztőnk mért késése alapján. */
export type DelayFilter = "all" | "late" | "ontime";

export interface FilterState {
  vq: string;
  watch: string[];
  routes: string[];
  /** a térképen látszó módok ([] = minden bekapcsolt mód) — a régi `type` (busz / villamos) helyett */
  modes: TransitMode[];
  /** Volán: üzemeltető-egység (pl. „Helyközi busz”, „Tiszaújváros”); [] = mind */
  operators: string[];
  /** vasút: kategória (Sz, IR, IC…); [] = mind */
  railKinds: string[];
  delay: DelayFilter;
  speed: SpeedFilter;
  nearMeKm: number | null;
  sort: VehicleSort;
  stops: boolean;
  onlyWatched: boolean;
  shape: boolean;
  rstops: boolean;
  labels: boolean;
  follow: boolean;
  /** élő forgalom (dugók) réteg */
  traffic: boolean;
  /** követés (utazás) közben a többi busz is látszik */
  others: boolean;
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
  /** v3 (?modes=): mód, kulcs, üzemeltető */
  mode?: TransitMode;
  key?: string;
  operator?: string | null;
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
  /** útvonal-változat betűjele (az alaptól eltérő menetnél) — magyarázata a `variants`-ban */
  variant?: string;
  times: (string | null)[];
}

/** „A = Avas városközpont érintésével” — miben más a betűjeles menet */
export interface TimetableVariant {
  code: string;
  label: string;
  trips: number;
}

export interface TimetableResponse {
  route: Route;
  dir: string;
  date: string;
  headsign: string;
  stops: TimetableStop[];
  trips: TimetableTrip[];
  note?: string;
  variants?: TimetableVariant[];
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

/** v3: viszonylat-tábla (A → B közvetlenül), lásd /engine/transit/relation */
export interface RelationRow {
  tripId: string;
  route: string;
  routeKey: string;
  color: string;
  text: string;
  mode: TransitMode;
  operator: string | null;
  trainNo: string | null;
  trainName: string | null;
  headsign: string;
  depStopId: string;
  arrStopId: string;
  depTime: string;
  depUnix: number;
  schedDepUnix: number;
  depDelaySec: number | null;
  arrTime: string;
  arrUnix: number;
  schedArrUnix: number;
  arrDelaySec: number | null;
  durationMin: number;
  stops: number;
  platform: string | null;
  /** v3: a vágány még nincs kiadva — a korábbi napok szerinti várható */
  platformPredicted?: boolean;
  live: boolean;
  cancelled: boolean;
  vehicle: ArrivalVehicle | null;
  notices: string[] | null;
  today: boolean;
}

export interface RelationBoardResponse {
  from: { id: string; name: string | null };
  to: { id: string; name: string | null };
  now: number;
  rows: RelationRow[];
}

/** v3: egy vonat vonatszám szerint, lásd /engine/transit/train */
export interface TrainStop {
  id: string;
  name: string;
  platform: string | null;
  /** az élő vágány eltér a menetrenditől */
  platformChanged?: boolean;
  /** v3: a vágány még nincs kiadva — a korábbi napok szerinti várható */
  platformPredicted?: boolean;
  schedArr: string;
  schedDep: string;
  arrUnix: number;
  depUnix: number;
  delaySec: number | null;
  passed: boolean;
}

export interface TrainDetailResponse {
  no: string;
  found: boolean;
  tripId?: string;
  date?: string;
  today?: boolean;
  name?: string;
  trainName?: string | null;
  category?: string | null;
  route?: { key: string; short: string; long: string; color: string; text: string; mode: TransitMode; operator: string | null } | null;
  headsign?: string;
  stops?: TrainStop[];
  vehicle?: LiveVehicle | null;
  liveDelaySec?: number | null;
  officialDelaySec?: number | null;
  notices?: { text: string; kind: string }[];
  cancelled?: boolean;
}

/** v3: keresés minden feedben (megálló, állomás, vonatszám) */
export interface TransitSearchResponse {
  q: string;
  stops: { id: string; name: string; mode: "mvk" | "coach" | "rail"; station: boolean; platforms: number; lat: number; lon: number; routes: { short: string; color: string; text: string; mode: TransitMode }[] }[];
  trains: { tripId: string; no: string; name: string; headsign: string; from: string; departure: string; today: boolean }[];
}
