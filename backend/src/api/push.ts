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
  /** Ha megadott, csak ez a pontos menetrendi menet vált ki riasztást (menetrend fül). */
  tripId?: string;
  /** Az figyelt megálló a menet KIINDULÓ megállója-e (szövegezéshez: "indul" vs "ér ide"). */
  isDeparture?: boolean;
  /**
   * "Ismétlődő" figyelés (menetrend fül, checkbox): menetrendi óra:perc
   * 0-1439 (éjféltől számolt perc), a tripId helyett — mert a GTFS naponta
   * más trip_id-t ad ugyanarra a mintára. Ha ez meg van adva, a tripId
   * mezőt figyelmen kívül hagyjuk.
   */
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
  // Ismétlődő figyelésnél nincs értelme egy konkrét tripId-nek — a napi
  // eltérő trip_id-k helyett a route + óra:perc alapján illesztünk.
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
