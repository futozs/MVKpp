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
  RelationBoardResponse,
  TrainDetailResponse,
  TransitSearchResponse,
} from "../types";
import { API_BASE } from "@/lib/apiBase";
import { boardKeyNow, boardQuery, modesParam } from "@/lib/modes";

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
  mode: "BUS" | "TRAM" | "COACH" | "RAIL";
  routeShortName: string;
  /** v3: a vonal kulcsa (a regionálisé a vonal azonosítója) */
  routeKey?: string;
  /** v3: a menet rövid neve (Volán: „4001/748”, vasút: „582 TOKAJ InterCity”) */
  tripShortName?: string;
  /** v3, vasút: a vonatszám és a név külön */
  trainNo?: string;
  trainName?: string;
  /** v3: vágány (vasút) / kocsiállás (autóbusz-állomás) a felszállásnál */
  fromPlatform?: string;
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
  /** a tervezésben használható módok (`?modes=`); alapból a Beállítások szerinti */
  modes?: string;
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
  /** A bekapcsolt módok megállói (v3: + forrás, szülő-állomás, állomás-e). */
  async getStops(modes = modesParam()): Promise<Stop[]> {
    const raw = await handleResponse<
      [string, string, string, number, number, string?, string?, number?, string?][]
    >(await fetch(`${API_BASE}/gtfs/stops.json?modes=${modes}`), "/gtfs/stops.json");
    return raw.map(([id, code, name, lat, lon, feed, parent, station, twinOf]) => ({
      id,
      code,
      name,
      lat,
      lon,
      ...(feed ? { feed: feed as Stop["feed"] } : {}),
      ...(parent ? { parent } : {}),
      ...(station ? { station: true } : {}),
      ...(twinOf ? { twinOf } : {}),
    }));
  },

  /** A bekapcsolt módok vonalai (v3: + mód, kulcs, üzemeltető). */
  async getRoutes(modes = modesParam()): Promise<Route[]> {
    const raw = await handleResponse<
      [string, string, string, string, string, string, string?, string?, string?][]
    >(await fetch(`${API_BASE}/gtfs/routes.json?modes=${modes}`), "/gtfs/routes.json");
    return raw.map(([id, short, long, type, color, text, mode, key, operator]) => ({
      id,
      short,
      long,
      type,
      color: color ? color.replace(/^#/, "") : "888888",
      text: text ? text.replace(/^#/, "") : "FFFFFF",
      ...(mode ? { mode: mode as Route["mode"] } : {}),
      ...(key ? { key } : {}),
      ...(operator ? { operator } : {}),
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

  async getTimetableRoutes(date?: string, modes = modesParam()): Promise<TimetableRoutesResponse> {
    const params = new URLSearchParams({ modes });
    if (date) params.set("date", date);
    return handleResponse<TimetableRoutesResponse>(
      await fetch(`${API_BASE}/gtfs/timetable/routes?${params.toString()}`),
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

  async getCancelledTrips(date?: string, modes = modesParam()): Promise<CancelledTripsResponse> {
    const params = new URLSearchParams({ modes });
    if (date) params.set("date", date);
    return handleResponse<CancelledTripsResponse>(
      await fetch(`${API_BASE}/live/cancelled?${params.toString()}`),
      "/live/cancelled",
    );
  },

  async getTripJournal(date?: string, modes = modesParam()): Promise<TripJournalResponse> {
    const params = new URLSearchParams({ modes });
    if (date) params.set("date", date);
    return handleResponse<TripJournalResponse>(
      await fetch(`${API_BASE}/gtfs/trip-journal?${params.toString()}`),
      "/gtfs/trip-journal",
    );
  },

  async getGtfsMeta(): Promise<GtfsMeta> {
    return handleResponse<GtfsMeta>(
      await fetch(`${API_BASE}/gtfs/meta.json`),
      "/gtfs/meta.json",
    );
  },

  async getLivePositions(modes = modesParam()): Promise<VehiclePositionsResponse> {
    return handleResponse<VehiclePositionsResponse>(
      await fetch(`${API_BASE}/live/positions?modes=${modes}`),
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
      await fetch(`${API_BASE}/live/vehicle?id=${encodeURIComponent(id)}&modes=${modesParam()}`),
      "/live/vehicle",
    );
  },

  /** `board`: a tábla kulcsa (módok és a közös megállók összevonása, lásd `boardKey`). */
  async getArrivals(stopId: string, limit = 12, board = boardKeyNow()): Promise<StopArrivalsResponse> {
    return handleResponse<StopArrivalsResponse>(
      await fetch(
        `${API_BASE}/live/arrivals?stop=${encodeURIComponent(stopId)}&limit=${limit}&${boardQuery(board)}`,
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
        `${API_BASE}/live/multi-arrivals?stops=${encodeURIComponent(stopIds.join(","))}&limit=${limit}&${boardQuery(boardKeyNow())}`,
      ),
      "/live/multi-arrivals",
    );
  },

  /** Viszonylat-tábla: A-ból B-be közvetlenül (pl. Miskolc-Tiszai → Füzesabony), a bekapcsolt módokkal. */
  async getRelation(from: string, to: string, limit = 8): Promise<RelationBoardResponse> {
    const params = new URLSearchParams({ from, to, limit: String(limit), modes: modesParam() });
    return handleResponse<RelationBoardResponse>(await fetch(`${API_BASE}/engine/transit/relation?${params.toString()}`), "/engine/transit/relation");
  },

  /** Egy vonat vonatszám szerint (a ma vagy holnap közlekedő példány, megállónként). */
  async getTrain(no: string): Promise<TrainDetailResponse> {
    return handleResponse<TrainDetailResponse>(await fetch(`${API_BASE}/engine/transit/train?no=${encodeURIComponent(no)}`), "/engine/transit/train");
  },

  /** Egy vasúti menet megállónként (a térképen követett vonat menetrendje). */
  async getTrainTrip(tripId: string): Promise<TrainDetailResponse> {
    return handleResponse<TrainDetailResponse>(await fetch(`${API_BASE}/engine/transit/train?trip=${encodeURIComponent(tripId)}`), "/engine/transit/train");
  },

  /** Megálló-, állomás- és vonatszám-keresés minden bekapcsolt módban. */
  async searchTransit(q: string, signal?: AbortSignal): Promise<TransitSearchResponse> {
    const params = new URLSearchParams({ q, modes: modesParam() });
    return handleResponse<TransitSearchResponse>(await fetch(`${API_BASE}/engine/transit/search?${params.toString()}`, { signal }), "/engine/transit/search");
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
      modes: q.modes ?? modesParam(),
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
