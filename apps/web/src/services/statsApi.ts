import { API_BASE } from "@/lib/apiBase";
import { serviceNow } from "@/lib/serviceDay";

export class StatsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsUnavailableError";
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/stats${path}`);
  if (res.status === 503) {
    const body = await res.json().catch(() => ({ error: "" }));
    throw new StatsUnavailableError(
      body.error || "Az adatraktár nem érhető el.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Statisztika [${res.status}] ${path}: ${text || res.statusText}`,
    );
  }
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/stats${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 503) {
    const b = await res.json().catch(() => ({ error: "" }));
    throw new StatsUnavailableError(
      b.error || "Az adatraktár nem érhető el.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Statisztika [${res.status}] ${path}: ${text || res.statusText}`,
    );
  }
  return res.json();
}

export type HealthCounts = {
  pings: number;
  runs: number;
  events: number;
  segments: number;
  profiles: number;
  vehicles: number;
};

export type FeedHealth = {
  service_date: string;
  polls_ok: number;
  polls_fail: number;
  pings_kept: number;
  pings_dup: number;
  vehicles_max: number;
};

export type JobRow = {
  job: string;
  started_at: string;
  ended_at: string | null;
  ok: number;
  rows_out: number;
  note: string | null;
};

export type StatsHealth = {
  today: FeedHealth | null;
  counts: HealthCounts;
  jobs: JobRow[];
};

export type VehicleListItem = {
  vehicle_id: string;
  kind: string;
  last_seen: string;
  runs: number;
  days: number;
  last_date: string | null;
  dist_km: number;
};

export type VehicleDay = {
  runs: number;
  routes_n: number;
  dist_m: number;
  service_s: number;
  moving_s: number;
  dwell_s: number;
  max_speed_dms: number | null;
  avg_delay_s: number | null;
  p85_delay_s: number | null;
  first_ts: number | null;
  last_ts: number | null;
  depot_lat_e7: number | null;
  depot_lon_e7: number | null;
  gaps_n: number;
};

export type VehicleRun = {
  run_id: number;
  sched_start_s: number;
  sched_end_s: number;
  actual_start: number | null;
  actual_end: number | null;
  start_delay_s: number | null;
  end_delay_s: number | null;
  dist_m: number | null;
  stops_seen: number;
  stops_total: number;
  quality: number;
  status: string;
  route_short: string;
  color: string | null;
  headsign: string | null;
  direction: number;
};

export type VehicleDetail = {
  vehicleId: string;
  date: string;
  summary: VehicleDay | null;
  runs: VehicleRun[];
  /** v3: azok a napok (újabb elöl), amelyeken a jármű ténylegesen közlekedett */
  days?: string[];
};

export type TrackPoint = [number, number, number, number | null, number | null];
export type VehicleTrack = {
  vehicleId: string;
  date: string;
  points: number;
  ofTotal: number;
  track: TrackPoint[];
};

export type VehicleRouteShare = {
  period_ym: number;
  route_short: string;
  color: string | null;
  kind: string;
  runs: number;
  share_pct: number;
  dist_km: number;
  service_s: number;
  days_active: number;
  avg_delay_s: number | null;
};

export type RouteDay = {
  service_date: string;
  direction: number;
  runs: number;
  ghost_runs: number;
  events_n: number;
  otp_pct: number | null;
  early_pct: number | null;
  late_pct: number | null;
  avg_delay_s: number | null;
  p50_delay_s: number | null;
  p85_delay_s: number | null;
  p95_delay_s: number | null;
  bunching_n: number;
};

export type StopHour = {
  service_date: string;
  hour: number;
  events_n: number;
  otp_pct: number | null;
  avg_delay_s: number | null;
  p85_delay_s: number | null;
  avg_dwell_s: number | null;
  avg_headway_s: number | null;
};

export type SegmentLeg = {
  from: string;
  to: string;
  schedS: number;
  p50S: number;
  p85S: number;
  samples: number;
  source: string;
};

export type SegmentEstimate = {
  from: string;
  to: string;
  at: string;
  daytype: number;
  school: boolean;
  via: string;
  routeShort: string | null;
  routeColor: string | null;
  headsign: string | null;
  scheduleExact: boolean;
  stopsBetween: number;
  schedS: number;
  p50S: number;
  p85S: number;
  rawP50S: number;
  liveFactor: number | null;
  liveSamples: number;
  samples: number;
  coverage: number;
  confidence: string;
  legs: SegmentLeg[];
};

export type SlowSegment = {
  from_name: string;
  to_name: string;
  from_lat: number;
  from_lon: number;
  to_lat: number;
  to_lon: number;
  dist_m: number | null;
  n: number;
  p50_s: number;
  sched_s: number;
  excess_s: number;
};

export type Incident = {
  incident_id: number;
  kind: "mid_trip_stop" | "stuck" | "no_signal" | "early_end" | "absence";
  service_date: string;
  started_ts: number;
  ended_ts: number | null;
  duration_s: number | null;
  progress_pct: number | null;
  severity: number;
  confidence: number;
  peers_stuck: number;
  absent_days: number | null;
  resolution: string | null;
  note: string | null;
  lat_e7?: number | null;
  lon_e7?: number | null;
  vehicle_id: string;
  vehicle_kind: string;
  route_short: string | null;
  color: string | null;
};

export type FleetReliability = {
  vehicle_id: string;
  vehicle_kind: string;
  days_active: number;
  runs: number;
  service_h: number;
  incidents: number;
  mid_trip: number;
  stuck: number;
  no_signal: number;
  absences: number;
  absent_days: number;
  absent_since: number | null;
  per_hour: number;
};

export type IncidentSummary = {
  from: string;
  to: string;
  fleet: FleetReliability[];
  byKind: {
    kind: string;
    n: number;
    avg_conf: number;
    avg_duration_s: number | null;
  }[];
  daily: { service_date: string; n: number }[];
  repairs: {
    vehicle_id: string;
    absent_days: number;
    service_date: string;
    ended_ts: number;
  }[];
};

export type RoutePrediction = {
  routeShort: string;
  color: string | null;
  probabilityPct: number;
  avgDelaySec: number | null;
};

export type PredictionAccuracy = {
  from: string;
  to: string;
  total: number;
  correct: number;
  accuracyPct: number | null;
  daily: { service_date: string; n: number; correct: number }[];
  byVehicle: { vehicle_id: string; n: number; correct: number }[];
};

export type NetworkHour = { hour: number; days: number; n: number; avg_delay_s: number | null; otp_pct: number | null; late_pct: number | null; p85_delay_s: number | null };
export type NetworkSlow = {
  from_stop: string;
  to_stop: string;
  from_name: string;
  to_name: string;
  n: number;
  p50_s: number;
  p85_s: number;
  sched_s: number;
  excess_s: number;
  excess_pct: number | null;
};
export type NetworkProfile = { daytype: number; days: number; fromHour: number; toHour: number; hourly: NetworkHour[]; slow: NetworkSlow[] };
export type IncidentV3 = {
  id: number;
  service_date: string;
  kind: "cancelled" | "missed" | "breakdown" | "long_stop" | "detour";
  source: "mvk" | "detected";
  confidence: number;
  route_short: string | null;
  color: string | null;
  text_color: string | null;
  trip_id: string | null;
  vehicle_id: string | null;
  stop_id: string | null;
  stop_name: string | null;
  started_ts: number;
  ended_ts: number | null;
  lat: number | null;
  lon: number | null;
  title: string;
  detail: string | null;
  evidence: Record<string, unknown>;
};
export type IncidentsV3 = { from: string; to: string; incidents: IncidentV3[]; byDay: { service_date: string; kind: string; n: number }[] };

/** egy kiértékelt csoport: hány jóslat, ebből hány talált */
export type HitCount = { n: number; hits: number };
export type PredictionGuess = { h: number; v: string; ok: boolean; c: number; m: string };
export type PredictionTrip = {
  date: string;
  trip_id: string;
  route_short: string;
  color: string | null;
  text_color: string | null;
  sched_start_s: number;
  actual: string;
  headsign: string | null;
  /** a legkorábbi horizont elöl (30 → 15 → 5 perc) */
  guesses: PredictionGuess[];
};
export type PredictionOverviewData = {
  from: string;
  to: string;
  pendingToday: number;
  byHorizon: (HitCount & { horizon: number; avg_conf: number })[];
  /** bucket: a bizonyosság tizede (0 = 0–10%, 9 = 90–100%) */
  calibration: (HitCount & { bucket: number; avg_conf: number })[];
  byMethod: (HitCount & { method: string; avg_conf: number })[];
  signals: (HitCount & { signal: string })[];
  weights: { signal: string; weight: number; hits: number; misses: number }[];
  daily: (HitCount & { date: string })[];
  byHour: (HitCount & { hour: number })[];
  byRoute: (HitCount & { route_short: string; color: string | null; text_color: string | null })[];
  byVehicle: (HitCount & { vehicle_id: string; wrong_picks: number })[];
  trips: PredictionTrip[];
};

async function getRoot<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (res.status === 503) throw new StatsUnavailableError("Az adatraktár nem érhető el.");
  if (!res.ok) throw new Error(`Statisztika [${res.status}] ${path}`);
  return res.json();
}

export const statsV3 = {
  network: (daytype: number, days: number, fromHour: number, toHour: number) =>
    getRoot<NetworkProfile>(`/v3/stats/network?daytype=${daytype}&days=${days}&fromHour=${fromHour}&toHour=${toHour}`),
  incidents: (from: string, to: string, kind?: string, minConfidence = 50) =>
    getRoot<IncidentsV3>(`/v3/incidents?from=${from}&to=${to}&minConfidence=${minConfidence}${kind ? `&kind=${kind}` : ""}`),
  days: () => getRoot<{ days: string[] }>(`/v3/stats/days`),
  predictions: (from: string, to: string) => getRoot<PredictionOverviewData>(`/v3/stats/predictions?from=${from}&to=${to}`),
};

export const statsApi = {
  health: () => get<StatsHealth>("/health"),

  vehicles: () => get<{ vehicles: VehicleListItem[] }>("/vehicles"),

  vehicle: (id: string, date: string) =>
    get<VehicleDetail>(`/vehicle/${encodeURIComponent(id)}?date=${date}`),

  vehicleTrack: (id: string, date: string, every = 2) =>
    get<VehicleTrack>(
      `/vehicle/${encodeURIComponent(id)}/track?date=${date}&every=${every}`,
    ),

  vehicleRoutes: (id: string) =>
    get<{ vehicleId: string; routes: VehicleRouteShare[] }>(
      `/vehicle/${encodeURIComponent(id)}/routes`,
    ),

  incidents: (from: string, to: string, kind?: string, minConfidence = 50) =>
    get<{ from: string; to: string; incidents: Incident[] }>(
      `/incidents?from=${from}&to=${to}&minConfidence=${minConfidence}${kind ? "&kind=" + kind : ""}`,
    ),

  incidentSummary: (from: string, to: string, minConfidence = 50) =>
    get<IncidentSummary>(
      `/incidents/summary?from=${from}&to=${to}&minConfidence=${minConfidence}`,
    ),

  vehicleIncidents: (id: string) =>
    get<{
      vehicleId: string;
      presence: Record<string, number | string | null> | null;
      incidents: Incident[];
    }>(`/vehicle/${encodeURIComponent(id)}/incidents`),

  route: (short: string, from: string, to: string) =>
    get<{ route: string; days: RouteDay[] }>(
      `/route/${encodeURIComponent(short)}?from=${from}&to=${to}`,
    ),

  stop: (id: string, from: string, to: string) =>
    get<{ stop: string; name: string | null; hours: StopHour[] }>(
      `/stop/${encodeURIComponent(id)}?from=${from}&to=${to}`,
    ),

  segment: (from: string, to: string, at: string) =>
    get<SegmentEstimate>(
      `/segment?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&at=${encodeURIComponent(at)}`,
    ),

  /** Egy útvonaltervező-itinerárium tömegközlekedési legjeihez mért átlagos késés. */
  routeDelays: (at: string, legs: { routeShort: string; stopId: string }[]) =>
    post<{ results: { avgDelaySec: number | null; samples: number }[] }>(
      "/route-delays",
      { at, legs },
    ),

  slowSegments: (bucketFrom = 28, bucketTo = 36) =>
    get<{ bucketFrom: number; bucketTo: number; segments: SlowSegment[] }>(
      `/network/slow?from=${bucketFrom}&to=${bucketTo}`,
    ),

  predictRoute: (id: string) =>
    get<{ vehicleId: string; samples: number; candidates: RoutePrediction[] }>(
      `/vehicle/${encodeURIComponent(id)}/predict-route`,
    ),

  predictionAccuracy: (from: string, to: string) =>
    get<PredictionAccuracy>(
      `/predictions/accuracy?from=${from}&to=${to}`,
    ),
};

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} ó ${m} p`;
  if (m > 0) return `${m} p ${s % 60} mp`;
  return `${s} mp`;
}

export function fmtSchedTime(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtClock(unix: number | null | undefined): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleTimeString("hu-HU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDelay(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = sec / 60;
  if (Math.abs(sec) < 45) return "pontos";
  return `${sec > 0 ? "+" : "−"}${Math.abs(m).toFixed(1)} p`;
}

export function fmtKm(meters: number | null | undefined): string {
  if (meters == null) return "—";
  return `${(meters / 1000).toFixed(1)} km`;
}

/** A mai szolgáltatási nap (Budapest szerint, 3:00-kor vált — a készülék időzónájától függetlenül). */
export function serviceToday(): string {
  return serviceNow().iso;
}

export function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatServiceHour(hour: number): string {
  return hour < 24 ? String(hour) : `${hour % 24}+`;
}
