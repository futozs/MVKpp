/**
 * GET /v3/admin/metrics — a webes oldal válaszidői és folyamat-adatai a
 * rendszer-hubnak. Admin-kulcsos (X-Admin-Key = ADMIN_KEY), mint a worker
 * /system/* végpontjai.
 */
import { safeEqual } from "@mvk/db/crypto";
import { ApiError, apiMetrics, dispatch, intParam, json, route, type Route } from "./http.ts";

function requireAdmin(req: Request): void {
  const key = process.env.ADMIN_KEY ?? "";
  const got = req.headers.get("x-admin-key") ?? "";
  if (!key || !got || !safeEqual(got, key)) throw new ApiError(401, "admin kulcs szükséges (X-Admin-Key)");
}

const routes: Route[] = [
  route("GET", "/v3/admin/metrics", (req, _p, url) => {
    requireAdmin(req);
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
