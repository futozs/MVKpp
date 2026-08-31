import { Hono } from "hono";
import { query, isReady } from "../db/pool.ts";
import { pushConfigured, sendPush, vapidPublicKey } from "../lib/push.ts";

export const push = new Hono();

push.get("/vapid-public-key", (c) => {
  if (!pushConfigured) return c.json({ publicKey: null });
  return c.json({ publicKey: vapidPublicKey });
});

// Azonnali teszt-push, a küszöb/időzítés-logika megkerülésével — erre való,
// hogy a "Teszt küldése" gombbal egyből ki lehessen deríteni, hogy a
// feliratkozás/kézbesítés lánc egyáltalán működik-e, anélkül hogy valós
// buszra kellene várni.
push.post("/test", async (c) => {
  if (!pushConfigured) {
    return c.json({ error: "A push nincs beállítva a szerveren" }, 503);
  }
  const body = await c
    .req.json<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>()
    .catch(() => null);
  const endpoint = body?.subscription?.endpoint;
  const p256dh = body?.subscription?.keys?.p256dh;
  const auth = body?.subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "Hiányzó feliratkozás-adat" }, 400);
  }
  console.log(`[push] TESZT küldés kérve — endpoint=...${endpoint.slice(-16)}`);
  const result = await sendPush(
    { endpoint, keys: { p256dh, auth } },
    {
      title: "Teszt üzenet",
      body: "Ha ezt látod, a push-értesítés működik! 🎉",
      tag: "mvk-test",
    },
  );
  return c.json({ result });
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
  const now = Math.floor(Date.now() / 1000);

  console.log(
    `[push] figyelés mentése: stop=${stopId} (${stopName}), küszöb=${thresholdMin}p, járatok=${routeShorts ?? "bármelyik"}, endpoint=...${endpoint.slice(-16)}`,
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
       (sub_id, stop_id, stop_name, threshold_min, route_shorts, updated_at)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       stop_name = VALUES(stop_name), threshold_min = VALUES(threshold_min),
       route_shorts = VALUES(route_shorts), updated_at = VALUES(updated_at),
       last_notified = NULL`,
    [sub.sub_id, stopId, stopName, thresholdMin, routeShorts, now],
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
