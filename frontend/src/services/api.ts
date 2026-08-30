import type {
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
  TripProgressResponse,
  WeatherResponse,
} from "../types";

let API_BASE = import.meta.env.VITE_API_URL ?? "";
if (!API_BASE && typeof window !== "undefined" && import.meta.env.PROD) {
  const { protocol, hostname } = window.location;

  if (protocol === "https:") {
    API_BASE = `https://${hostname}`;
  } else {
    API_BASE = `http://${hostname}:8088`;
  }
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
};
