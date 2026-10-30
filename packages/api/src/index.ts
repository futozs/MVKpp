/**
 * A webes oldal szerveroldali API-ja, keretrendszer-függetlenül
 * (Request → Response). A Next.js route handlerek csak ezt hívják.
 */
import { handleAccount } from "./account.ts";
import { handleAdmin } from "./admin.ts";
import { handleUsage } from "./usage.ts";
import { handlePush } from "./push.ts";
import { handleRides } from "./rides.ts";
import { handleStats } from "./stats.ts";
import { handleSync } from "./sync.ts";
import { handleV3Stats } from "./v3stats.ts";
import { json } from "./http.ts";

export async function handleApi(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/stats/")) return handleStats(req);
  if (path.startsWith("/account/")) return handleAccount(req);
  if (path.startsWith("/push/") || path.startsWith("/v3/push/")) return handlePush(req);
  if (path === "/v3/sync") return handleSync(req);
  if (path === "/v3/rides" || path.startsWith("/v3/rides/")) return handleRides(req);
  if (path === "/v3/usage") return handleUsage(req);
  if (path.startsWith("/v3/admin/")) return handleAdmin(req);
  if (path.startsWith("/v3/")) return handleV3Stats(req);
  return json({ error: "nincs ilyen végpont" }, 404);
}
