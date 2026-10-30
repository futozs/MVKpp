/**
 * GET /v3/admin/metrics — a webes oldal válaszidői és folyamat-adatai a
 * rendszer-hubnak. Saját, csak-olvasó kulccsal (X-Metrics-Key = METRICS_KEY):
 * a nyilvános web konténere így nem kapja meg a worker mesterkulcsát (ADMIN_KEY).
 */
import { safeEqual } from "@mvk/db/crypto";
import { ApiError, apiMetrics, dispatch, intParam, json, route, type Route } from "./http.ts";

function requireMetricsKey(req: Request): void {
  const key = process.env.METRICS_KEY ?? "";
  const got = req.headers.get("x-metrics-key") ?? "";
  if (!key || !got || !safeEqual(got, key)) throw new ApiError(401, "metrika-kulcs szükséges (X-Metrics-Key = METRICS_KEY)");
}

const routes: Route[] = [
  route("GET", "/v3/admin/metrics", (req, _p, url) => {
    requireMetricsKey(req);
    const windowMin = intParam(url.searchParams.get("window"), 15, 1, 60);
    const mem = process.memoryUsage();
    return json(
      {
        at: Date.now(),
        windowMin,
        process: {
          pid: process.pid,
          uptimeSec: Math.floor(process.uptime()),
          startedAt: Date.now() - Math.floor(process.uptime() * 1000),
          nodeVersion: process.version,
          memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576) },
        },
        http: apiMetrics.snapshot(windowMin),
      },
      200,
      { "cache-control": "no-store" },
    );
  }),
];

export const handleAdmin = (req: Request) => dispatch(routes, req);
