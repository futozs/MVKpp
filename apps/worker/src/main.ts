/**
 * MVK worker — a valós idejű motor.
 *
 *   MVK GTFS-RT ──(2,5 mp)──► Engine ──► TripMatcher ──► Postgres/Timescale
 *                                │                  └──► WebSocket-hub ──► böngészők
 *                                └──► Push (pg-boss sor, újrapróbálással)
 *
 * HTTP: a v2-kompatibilis /live, /gtfs, /weather, /_health végpontok (az
 * iOS app ezeket hívja), a /ws WebSocket, a /v3 motor-API és a macOS
 * token-agent fogadó végpontjai.
 */
import "@mvk/core/dev-clock";
import { createServer } from "node:http";
import { PgBoss } from "pg-boss";
import pg from "pg";
import { cacheStatus, closeCache } from "@mvk/cache";
import { serviceClock, shiftIso } from "@mvk/core";
import { closeDb, databaseUrl, dbReady } from "@mvk/db";
import { migrate } from "@mvk/db/migrate";
import { config } from "./config.ts";
import { Engine } from "./engine.ts";
import { FeedManager } from "./feeds.ts";
import { Hub } from "./hub.ts";
import { registerCompat } from "./http/compat.ts";
import { HttpError, readBody, Router, sendJson, type Req } from "./http/router.ts";
import { registerV3 } from "./http/v3.ts";
import { detectIncidentsForDay } from "./incidents.ts";
import { errMsg, log } from "./log.ts";
import { DelayForecaster } from "./forecast.ts";
import { trainDelayModelInThread } from "./ml/thread.ts";
import { TrafficMonitor } from "./traffic.ts";
import { TripInsights } from "./insights.ts";
import { Parking } from "./parking.ts";
import { VehiclePredictor } from "./predict.ts";
import { PushEngine } from "./push.ts";
import { loadToken, startRenewLoop, tokenStatus } from "./token.ts";

async function main() {
  for (let i = 0; !(await dbReady()); i++) {
    if (i > 30) throw new Error("az adatbázis nem érhető el");
    log.warn("db", "várakozás az adatbázisra…");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const applied = await migrate();
  if (applied.length) log.info("db", `migráció: ${applied.join(", ")}`);

  await loadToken();
  const st = tokenStatus();
  log.info("token", st.present ? `betöltve, ${Math.round((st.expiresInSec ?? 0) / 60)} percig érvényes` : "NINCS token — várom a macOS agentet (/agent/token)");
  startRenewLoop();

  const feeds = new FeedManager();
  await feeds.init();
  await feeds.warmToday();

  const engine = new Engine(feeds);
  const predictor = new VehiclePredictor(engine);
  await predictor.learn().catch((e) => log.warn("predict", "tanulás sikertelen", errMsg(e)));
  const forecaster = new DelayForecaster(engine);
  await forecaster.load().catch((e) => log.warn("forecast", "profilok betöltése sikertelen", errMsg(e)));
  const parking = new Parking(engine, predictor);
  // a motor indulása előtt: a mai nap visszajátszott eseményeiből is épül
  const traffic = new TrafficMonitor(engine, forecaster);
  const insights = new TripInsights(engine, forecaster, predictor, traffic);
  await parking.init().catch((e) => log.warn("parking", "indítás sikertelen", errMsg(e)));

  const boss = new PgBoss({ connectionString: databaseUrl(), schema: "pgboss" });
  boss.on("error", (e) => log.error("pgboss", errMsg(e)));
  await boss.start();

  const router = new Router();
  const server = createServer();
  const hub = new Hub(server, engine, predictor, parking, forecaster, insights);
  const ctx = { engine, feeds, predictor, parking, forecaster, traffic, insights, startedAt: Date.now(), hubStats: () => hub.status() };
  registerCompat(router, ctx);
  registerV3(router, ctx);

  server.on("request", async (raw, res) => {
    let url: URL;
    try {
      url = new URL(raw.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const req = raw as Req;
    req.path = url.pathname;
    req.query = url.searchParams;
    req.ip = String(raw.headers["x-forwarded-for"] ?? raw.socket.remoteAddress ?? "").split(",")[0].trim();
    const publicRead = /^\/(live|gtfs|weather|engine|_health)\b/.test(req.path);
    if (publicRead) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
    }
    if (raw.method === "OPTIONS") {
      res.writeHead(204, publicRead ? { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400" } : {});
      res.end();
      return;
    }
    const m = router.match(raw.method ?? "GET", req.path);
    if (!m) return sendJson(req, res, 404, { error: "nincs ilyen végpont" });
    req.params = m.params;
    try {
      if (raw.method === "POST" || raw.method === "PUT") req.body = await readBody(raw);
      await m.route.handler(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error("http", `${raw.method} ${req.path}`, errMsg(e));
      if (!res.headersSent) sendJson(req, res, status, { error: errMsg(e) });
      else res.end();
    }
  });

  await engine.start();
  const push = new PushEngine(engine, boss, insights);
  await push.start();

  // A webes oldal Postgres NOTIFY-jal szól: szinkron-változás, push-figyelés változott.
  // Ha a kapcsolat megszakad (Postgres újraindul), újrakapcsolódunk — különben a
  // kezeletlen 'error' leállítaná a workert, és a szinkron-értesítések elnémulnának.
  let activeListener: pg.Client | null = null;
  let stopping = false;
  const listen = async (attempt = 0): Promise<void> => {
    if (stopping) return;
    const listener = new pg.Client({ connectionString: databaseUrl() });
    activeListener = listener;
    let retried = false;
    const retry = () => {
      if (retried || stopping) return;
      retried = true;
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
      setTimeout(() => void listen(attempt + 1).catch(() => {}), wait).unref();
    };
    listener.on("error", (e) => {
      log.warn("listen", "a NOTIFY-kapcsolat megszakadt, újrakapcsolódás", errMsg(e));
      listener.removeAllListeners("end");
      void listener.end().catch(() => {});
      retry();
    });
    listener.on("end", () => retry());
    listener.on("notification", (n) => {
      try {
        const e = JSON.parse(n.payload ?? "{}") as { type?: string; userId?: string; keys?: string[]; deviceId?: string };
        if (e.type === "sync" && e.userId) hub.notifySync(e.userId, e.keys ?? [], e.deviceId ?? null);
        if (e.type === "push_watch") push.reload().catch(() => {});
      } catch {
        /* hibás értesítés — figyelmen kívül */
      }
    });
    try {
      await listener.connect();
      await listener.query("LISTEN mvk_events");
      // Kimaradt értesítések: a push-figyeléseket újratöltjük.
      if (attempt > 0) push.reload().catch(() => {});
    } catch (e) {
      log.warn("listen", "a NOTIFY-kapcsolat nem jött létre", errMsg(e));
      listener.removeAllListeners("end");
      void listener.end().catch(() => {});
      retry();
    }
  };
  await listen();

  // Ütemezett feladatok (pg-boss: egy példányban fut, újraindítás után is).
  await boss.createQueue("nightly");
  await boss.createQueue("minutely");
  await boss.createQueue("gtfs-refresh");
  await boss.schedule("nightly", "40 3 * * *", {}, { tz: "Europe/Budapest" });
  await boss.schedule("minutely", "* * * * *", {});
  await boss.schedule("gtfs-refresh", "*/30 * * * *", {});
  await boss.work("nightly", async () => {
    const yesterday = shiftIso(serviceClock().iso, -1);
    await detectIncidentsForDay(feeds, yesterday);
    await predictor.learn();
    await forecaster.load();
    // A késés-modell újratanítása a friss nappal (külön szálon); csak a bizonyítottan jobb modell él.
    if (await trainDelayModelInThread()) await forecaster.loadModel();
  });
  // Első indításkor (még nincs modell) nem várunk az éjszakáig.
  if (!forecaster.hasModel()) {
    setTimeout(() => {
      void trainDelayModelInThread().then(async (saved) => {
        if (saved) await forecaster.loadModel();
      });
    }, 3 * 60_000).unref();
  }
  await boss.work("minutely", async () => {
    await predictor.recordHorizons();
  });
  await boss.work("gtfs-refresh", async () => {
    log.info("gtfs", await feeds.refresh());
  });

  server.listen(config.port, config.host, () => log.info("worker", `fut: http://${config.host}:${config.port} (ws: /ws)`));
  log.info("worker", `gyorsítótár: ${cacheStatus().backend === "redis" ? "memória + Redis (REDIS_URL)" : "csak memória (nincs REDIS_URL)"}`);

  const shutdown = async (sig: string) => {
    log.info("worker", `leállás (${sig})`);
    server.close();
    await engine.stop().catch(() => {});
    await boss.stop({ graceful: true, timeout: 5000 }).catch(() => {});
    stopping = true;
    await activeListener?.end().catch(() => {});
    await closeDb();
    await closeCache();
    process.exit(0);
  };
  // Egy elszabadult ígéret ne állítsa le a teljes élő motort — naplózzuk.
  process.on("unhandledRejection", (e) => log.error("process", "kezeletlen hiba", errMsg(e)));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("worker", "végzetes hiba", errMsg(e));
  process.exit(1);
});
