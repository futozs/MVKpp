import type {
  CancelledTripsResponse,
  Stop,
  Route,
  RouteGeo,
  GtfsMeta,
  VehiclePositionsResponse,
  StopArrivalsResponse,
  MultiArrivalsResponse,
  TripPathResponse,
  HealthResponse,
  SystemInfoResponse,
  TimetableResponse,
  TimetableRoutesResponse,
  TripJournalResponse,
  TripProgressResponse,
  WeatherResponse,
  RoutePlanPoint,
  RoutePlanResponse,
} from "../types";
import { API_BASE } from "@/lib/apiBase";

/* ---------------------------------------------------------------------------
   Saját útvonaltervező (/engine/plan) — a menetrend, a mért késések és az élő
   adatok egyetlen forrása. Az ISO időbélyegek UTC-ben érkeznek, a `sched*`,
   `depTs`, `arrTs` mezők unix másodpercek.
   ------------------------------------------------------------------------- */

export type JourneyMode = "past" | "now" | "future";
export type TransferRisk = "safe" | "tight" | "risky";

export interface JourneyPlace {
  lat: number;
  lon: number;
  name: string;
}

export interface JourneyPrediction {
  source: "live" | "history" | "none";
  depDelayS: number | null;
  arrDelayS: number | null;
  arrDelayP85S: number | null;
  samples: number;
  vehicleId: string | null;
}

export interface JourneyActual {
  tracked: boolean;
  vehicleId: string | null;
  depTs: number | null;
  arrTs: number | null;
  depDelayS: number | null;
  arrDelayS: number | null;
  /** A leszállási időpontot nem mértük, hanem a pályából becsültük. */
  estimated: boolean;
}

interface JourneyLegBase {
  fromName: string;
  toName: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  start: string;
  end: string;
  durationSec: number;
  distanceMeter: number;
}

export interface JourneyWalkLeg extends JourneyLegBase {
  mode: "WALK";
}

export interface JourneyTransitLeg extends JourneyLegBase {
  mode: "BUS" | "TRAM";
  routeShortName: string;
  routeLongName: string | null;
  routeColor: string | null;
  routeTextColor: string | null;
  tripId: string;
  headsign: string | null;
  fromStopId: string;
  toStopId: string;
  intermediateStopNames: string[];
  schedDep: number;
  schedArr: number;
  shape: [number, number][];
  prediction?: JourneyPrediction;
  actual?: JourneyActual;
}

export type JourneyLeg = JourneyWalkLeg | JourneyTransitLeg;

export interface JourneyTransferCheck {
  at: string;
  marginSec: number;
  risk: TransferRisk;
  /** v3: 0..1 — eléred-e a csatlakozást (a két busz várható/rossz esetbeli idejéből) */
  chance?: number;
  /** v3: ha lekésed, a következő ugyanazzal a vonallal (ma) */
  fallback?: { tripId: string; time: string; departUnix: number } | null;
  fromTripId?: string;
  toTripId?: string;
  alightStopId?: string;
  boardStopId?: string;
  walkS?: number;
  fromRoute?: string;
  toRoute?: string;
}

export interface JourneyActualOutcome {
  tracked: boolean;
  departedDelayS: number | null;
  arrivedDelayS: number | null;
  vehicles: (string | null)[];
}

export interface JourneyTrip {
  start: string;
  end: string;
  durationSec: number;
  distanceMeter: number;
  transfers: number;
  transferChecks: JourneyTransferCheck[];
  legs: JourneyLeg[];
  actualOutcome?: JourneyActualOutcome | null;
}

export interface JourneyPlanResponse {
  date: string;
  at: number;
  mode: JourneyMode;
  arriveBy: boolean;
  schedule: {
    feedVersion: string;
    source: "feed" | "legacy";
    /** A sablonnap dátuma, ha az MVK erre a napra nem adott ki menetrendet. */
    fallback: string | null;
  };
  from: JourneyPlace;
  to: JourneyPlace;
  trips: JourneyTrip[];
}

export interface JourneyPlanQuery {
  /** `stop:<stopId>` vagy `<lat>,<lon>` */
  from: string;
  to: string;
  /** unix másodperc */
  at: number;
  arriveBy?: boolean;
  limit?: number;
  signal?: AbortSignal;
}

async function handleResponse<T>(res: Response, endpoint: string): Promise<T> {
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `API Error [${res.status}] at ${endpoint}: ${errorText || res.statusText}`,
    );
  }
  return res.json();
}

export const api = {
  async getStops(): Promise<Stop[]> {
    const raw = await handleResponse<
      [string, string, string, number, number][]
    >(await fetch(`${API_BASE}/gtfs/stops.json`), "/gtfs/stops.json");
    return raw.map(([id, code, name, lat, lon]) => ({
      id,
      code,
      name,
      lat,
      lon,
    }));
  },

  async getRoutes(): Promise<Route[]> {
    const raw = await handleResponse<
      [string, string, string, string, string, string][]
    >(await fetch(`${API_BASE}/gtfs/routes.json`), "/gtfs/routes.json");
    return raw.map(([id, short, long, type, color, text]) => ({
      id,
      short,
      long,
      type,
      color: color ? color.replace(/^#/, "") : "888888",
      text: text ? text.replace(/^#/, "") : "FFFFFF",
    }));
  },

  async getRouteGeo(routeIds: string[]): Promise<{ routes: RouteGeo[] }> {
    if (!routeIds.length) return { routes: [] };
    return handleResponse<{ routes: RouteGeo[] }>(
      await fetch(
        `${API_BASE}/gtfs/route-geo?route=${encodeURIComponent(routeIds.join(","))}`,
      ),
      "/gtfs/route-geo",
    );
  },

  async getTripProgress(
    tripId: string,
    vehicleId?: string,
  ): Promise<TripProgressResponse> {
    const params = new URLSearchParams({ trip: tripId });
    if (vehicleId) params.set("vehicle", vehicleId);
    return handleResponse<TripProgressResponse>(
      await fetch(`${API_BASE}/live/trip-progress?${params.toString()}`),
      "/live/trip-progress",
    );
  },

  async getWeather(): Promise<WeatherResponse> {
    return handleResponse<WeatherResponse>(
      await fetch(`${API_BASE}/weather`),
      "/weather",
    );
  },

  async getTimetableRoutes(date?: string): Promise<TimetableRoutesResponse> {
    const q = date ? `?date=${encodeURIComponent(date)}` : "";
    return handleResponse<TimetableRoutesResponse>(
      await fetch(`${API_BASE}/gtfs/timetable/routes${q}`),
      "/gtfs/timetable/routes",
    );
  },

  async getTimetable(
    routeId: string,
    dir: string,
    date?: string,
  ): Promise<TimetableResponse> {
    const params = new URLSearchParams({ route: routeId, dir });
    if (date) params.set("date", date);
    return handleResponse<TimetableResponse>(
      await fetch(`${API_BASE}/gtfs/timetable?${params.toString()}`),
      "/gtfs/timetable",
    );
  },

  async getCancelledTrips(date?: string): Promise<CancelledTripsResponse> {
    const q = date ? `?date=${encodeURIComponent(date)}` : "";
    return handleResponse<CancelledTripsResponse>(
      await fetch(`${API_BASE}/live/cancelled${q}`),
      "/live/cancelled",
    );
  },

  async getTripJournal(date?: string): Promise<TripJournalResponse> {
    const q = date ? `?date=${encodeURIComponent(date)}` : "";
    return handleResponse<TripJournalResponse>(
      await fetch(`${API_BASE}/gtfs/trip-journal${q}`),
      "/gtfs/trip-journal",
    );
  },

  async getGtfsMeta(): Promise<GtfsMeta> {
    return handleResponse<GtfsMeta>(
      await fetch(`${API_BASE}/gtfs/meta.json`),
      "/gtfs/meta.json",
    );
  },

  async getLivePositions(): Promise<VehiclePositionsResponse> {
    return handleResponse<VehiclePositionsResponse>(
      await fetch(`${API_BASE}/live/positions`),
      "/live/positions",
    );
  },

  async getVehicle(id: string) {
    return handleResponse<{
      query: string;
      inService: boolean;
      count: number;
      vehicles: Record<string, unknown>[];
    }>(
      await fetch(`${API_BASE}/live/vehicle?id=${encodeURIComponent(id)}`),
      "/live/vehicle",
    );
  },

  async getArrivals(stopId: string, limit = 12): Promise<StopArrivalsResponse> {
    return handleResponse<StopArrivalsResponse>(
      await fetch(
        `${API_BASE}/live/arrivals?stop=${encodeURIComponent(stopId)}&limit=${limit}`,
      ),
      "/live/arrivals",
    );
  },

  async getMultiArrivals(
    stopIds: string[],
    limit = 6,
  ): Promise<MultiArrivalsResponse> {
    if (!stopIds.length) return { results: [] };
    return handleResponse<MultiArrivalsResponse>(
      await fetch(
        `${API_BASE}/live/multi-arrivals?stops=${encodeURIComponent(stopIds.join(","))}&limit=${limit}`,
      ),
      "/live/multi-arrivals",
    );
  },

  async getTripPath(
    tripId: string,
    vehicleId?: string,
  ): Promise<TripPathResponse> {
    const params = new URLSearchParams();
    if (tripId) params.set("trip", tripId);
    if (vehicleId) params.set("vehicle", vehicleId);
    return handleResponse<TripPathResponse>(
      await fetch(`${API_BASE}/live/trip-path?${params.toString()}`),
      "/live/trip-path",
    );
  },

  async debugStop(stopId: string) {
    return handleResponse<Record<string, unknown>>(
      await fetch(`${API_BASE}/live/debug?stop=${encodeURIComponent(stopId)}`),
      "/live/debug",
    );
  },

  async getHealth(): Promise<HealthResponse> {
    return handleResponse<HealthResponse>(
      await fetch(`${API_BASE}/_health`),
      "/_health",
    );
  },

  async getSystemInfo(): Promise<SystemInfoResponse> {
    return handleResponse<SystemInfoResponse>(
      await fetch(`${API_BASE}/system/info`),
      "/system/info",
    );
  },

  async getJwt(): Promise<string> {
    const res = await fetch(`${API_BASE}/_jwt`);
    return res.text();
  },

  async exportCredentials(): Promise<Record<string, unknown>> {
    return handleResponse(await fetch(`${API_BASE}/_export`), "/_export");
  },

  async ingestToken(
    jwt: string,
    installationId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const body = installationId ? JSON.stringify({ jwt, installationId }) : jwt;
    const res = await fetch(`${API_BASE}/_ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return handleResponse(res, "/_ingest");
  },

  async renewToken(): Promise<{
    triggered: boolean;
    result: unknown;
    jwt: unknown;
  }> {
    const res = await fetch(`${API_BASE}/_renew`, { method: "POST" });
    return handleResponse(res, "/_renew");
  },

  /**
   * Az MVK saját, hiteles útvonaltervezője (autó/gyalog/kerékpár/tömegközlekedés
   * variánsokkal) — a gateway a `/api/*` proxyn keresztül automatikusan
   * beteszi a Bearer JWT-t, itt nincs külön hitelesítés.
   */
  async planRoute(
    from: RoutePlanPoint,
    to: RoutePlanPoint,
    departureTime: string,
  ): Promise<RoutePlanResponse> {
    const res = await fetch(`${API_BASE}/api/v1/route/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [from, to], departureTime }),
    });
    return handleResponse<RoutePlanResponse>(res, "/api/v1/route/plan");
  },

  /**
   * Saját útvonaltervező: múltbeli napra a ténylegesen mért indulás/érkezés,
   * mára és jövőre a várható késés (élő adat vagy korábbi mérések) is benne
   * van. Hibánál a backend magyar nyelvű `error` üzenetét dobja tovább.
   */
  async planJourney(q: JourneyPlanQuery): Promise<JourneyPlanResponse> {
    const params = new URLSearchParams({
      from: q.from,
      to: q.to,
      at: String(Math.floor(q.at)),
      limit: String(q.limit ?? 4),
    });
    if (q.arriveBy) params.set("arriveBy", "1");
    const res = await fetch(`${API_BASE}/engine/plan?${params.toString()}`, {
      signal: q.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      throw new Error(
        typeof body?.error === "string" && body.error
          ? body.error
          : `Az útvonaltervező most nem érhető el (HTTP ${res.status}).`,
      );
    }
    return res.json() as Promise<JourneyPlanResponse>;
  },
};
