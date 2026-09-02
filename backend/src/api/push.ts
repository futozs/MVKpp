import { Hono } from "hono";
import { query, isReady } from "../db/pool.ts";
import { pushConfigured, vapidPublicKey } from "../lib/push.ts";

export const push = new Hono();

push.get("/vapid-public-key", (c) => {
  if (!pushConfigured) return c.json({ publicKey: null });
  return c.json({ publicKey: vapidPublicKey });
});

push.use("*", async (c, next) => {
  if (!pushConfigured) {
    return c.json({ error: "A push-értesítés nincs beállítva a szerveren" }, 503);
  }
  if (!(await isReady())) {
    return c.json({ error: "Az adatraktár nem érhető el" }, 503);
  }
  await next();
});

type WatchBody = {
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  stopId?: string;
  stopName?: string;
  thresholdMin?: number;
  routeShorts?: string[];
  tripId?: string;
  isDeparture?: boolean;
  schedMin?: number;
};

push.post("/watch", async (c) => {
  const body = await c.req.json<WatchBody>().catch(() => null);
  const endpoint = body?.subscription?.endpoint;
  const p256dh = body?.subscription?.keys?.p256dh;
  const auth = body?.subscription?.keys?.auth;
  const stopId = body?.stopId;
  const stopName = body?.stopName;
  if (!endpoint || !p256dh || !auth || !stopId || !stopName) {
    return c.json({ error: "Hiányzó mező" }, 400);
  }
  const thresholdMin = Math.max(1, Math.min(60, Number(body?.thresholdMin) || 5));
  const routeShorts =
    Array.isArray(body?.routeShorts) && body.routeShorts.length
      ? body.routeShorts.join(",")
      : null;
  const schedMin =
    Number.isFinite(body?.schedMin) && body!.schedMin! >= 0 && body!.schedMin! < 1440
      ? Math.round(body!.schedMin!)
      : null;
  const tripId = schedMin == null ? body?.tripId || null : null;
  const isDeparture = body?.isDeparture ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);

  console.log(
    `[push] figyelés mentése: stop=${stopId} (${stopName}), küszöb=${thresholdMin}p, járatok=${routeShorts ?? "bármelyik"}, trip=${tripId ?? "-"}, ismétlődő=${schedMin ?? "-"}, endpoint=...${endpoint.slice(-16)}`,
  );

  await query(
    `INSERT INTO push_subscription (endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [endpoint, p256dh, auth, now],
  );
  const [sub] = await query<{ sub_id: number }>(
    `SELECT sub_id FROM push_subscription WHERE endpoint = ?`,
    [endpoint],
  );
  if (!sub) return c.json({ error: "Feliratkozás mentése sikertelen" }, 500);

  await query(
    `INSERT INTO push_watch
       (sub_id, stop_id, stop_name, threshold_min, route_shorts, trip_id, is_departure, sched_min, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       stop_name = VALUES(stop_name), threshold_min = VALUES(threshold_min),
       route_shorts = VALUES(route_shorts), trip_id = VALUES(trip_id),
       is_departure = VALUES(is_departure), sched_min = VALUES(sched_min),
       updated_at = VALUES(updated_at), last_notified = NULL`,
    [sub.sub_id, stopId, stopName, thresholdMin, routeShorts, tripId, isDeparture, schedMin, now],
  );

  return c.json({ ok: true });
});

type DndBody = {
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  dndEnabled?: boolean;
  dndStartMin?: number;
  dndEndMin?: number;
};

push.post("/dnd", async (c) => {
  const body = await c.req.json<DndBody>().catch(() => null);
  const endpoint = body?.subscription?.endpoint;
  const p256dh = body?.subscription?.keys?.p256dh;
  const auth = body?.subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "Hiányzó mező" }, 400);
  }

  const validMin = (n: unknown): n is number =>
    Number.isFinite(n) && (n as number) >= 0 && (n as number) < 1440;
  const enabled = body?.dndEnabled === true;
  const startMin = enabled && validMin(body?.dndStartMin) ? Math.round(body!.dndStartMin!) : null;
  const endMin = enabled && validMin(body?.dndEndMin) ? Math.round(body!.dndEndMin!) : null;

  console.log(
    `[push] ne zavarj mentése: endpoint=...${endpoint.slice(-16)}, ${startMin != null && endMin != null ? `${startMin}p–${endMin}p` : "kikapcsolva"}`,
  );

  await query(
    `INSERT INTO push_subscription (endpoint, p256dh, auth, created_at, dnd_start_min, dnd_end_min)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth),
       dnd_start_min = VALUES(dnd_start_min), dnd_end_min = VALUES(dnd_end_min)`,
    [endpoint, p256dh, auth, Math.floor(Date.now() / 1000), startMin, endMin],
  );

  return c.json({
    ok: true,
    dnd: startMin != null && endMin != null ? { startMin, endMin } : null,
  });
});

type EnabledBody = {
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  enabled?: boolean;
};

push.post("/enabled", async (c) => {
  const body = await c.req.json<EnabledBody>().catch(() => null);
  const endpoint = body?.subscription?.endpoint;
  const p256dh = body?.subscription?.keys?.p256dh;
  const auth = body?.subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "Hiányzó mező" }, 400);
  }
  const enabled = body?.enabled !== false;

  console.log(
    `[push] értesítés globális kapcsoló: endpoint=...${endpoint.slice(-16)}, ${enabled ? "bekapcsolva" : "kikapcsolva"}`,
  );

  await query(
    `INSERT INTO push_subscription (endpoint, p256dh, auth, created_at, enabled)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth),
       enabled = VALUES(enabled)`,
    [endpoint, p256dh, auth, Math.floor(Date.now() / 1000), enabled ? 1 : 0],
  );

  return c.json({ ok: true, enabled });
});

push.delete("/watch", async (c) => {
  const body = await c
    .req.json<{ endpoint?: string; stopId?: string }>()
    .catch(() => null);
  const endpoint = body?.endpoint;
  const stopId = body?.stopId;
  if (!endpoint || !stopId) return c.json({ error: "Hiányzó mező" }, 400);

  console.log(`[push] figyelés törlése: stop=${stopId}, endpoint=...${endpoint.slice(-16)}`);

  await query(
    `DELETE w FROM push_watch w
       JOIN push_subscription s ON s.sub_id = w.sub_id
      WHERE s.endpoint = ? AND w.stop_id = ?`,
    [endpoint, stopId],
  );
  return c.json({ ok: true });
});
