import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "mysql2/promise";

import { getPool, closePool, isReady } from "../db/pool.ts";
import { loadKeys } from "../db/dims.ts";
import { loadGtfs, serviceNow, localMidnightUnix } from "../lib/gtfs.ts";
import { collectOnce, recordHealth, COLLECT_INTERVAL_MS } from "./collector.ts";
import {
  matchOnce,
  loadCalendar,
  clearRunCache,
  type PingRow,
} from "./matcher.ts";
import { closeRuns, markGhosts, yesterdayIso } from "./closer.ts";
import {
  rollSegmentProfile,
  rollVehicleDay,
  rollRouteDay,
  rollStopHour,
  rollVehicleRoute,
} from "./roller.ts";
import { runJanitor, captureWeather } from "./janitor.ts";
import { detectIncidents } from "./incidents.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GTFS_DIR = join(HERE, "..", "..", "gtfs");

const MATCH_INTERVAL_MS = Number(process.env.MATCH_INTERVAL_MS ?? 30_000);
const CLOSE_INTERVAL_MS = Number(process.env.CLOSE_INTERVAL_MS ?? 300_000);
const WEATHER_INTERVAL_MS = 900_000;
const JANITOR_INTERVAL_MS = 6 * 3600_000;
const NIGHTLY_AT_S = 27 * 3600 + 10 * 60;

const log = (tag: string, msg: string) =>
  console.log(`${new Date().toLocaleTimeString("hu-HU")} [${tag}] ${msg}`);

async function withJob<T>(
  pool: Pool,
  job: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const [ins] = await pool.query(
    `INSERT INTO job_run (job, started_at) VALUES (?, NOW())`,
    [job],
  );
  const jobId = (ins as { insertId: number }).insertId;
  try {
    const out = await fn();
    const n = typeof out === "number" ? out : 0;
    await pool.query(
      `UPDATE job_run SET ended_at = NOW(), ok = 1, rows_out = ? WHERE job_id = ?`,
      [n, jobId],
    );
    return out;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 250);
    await pool.query(
      `UPDATE job_run SET ended_at = NOW(), ok = 0, errors = 1, note = ? WHERE job_id = ?`,
      [msg, jobId],
    );
    log(job, `HIBA: ${msg}`);
    return null;
  }
}

async function rollDay(pool: Pool, isoDate: string): Promise<void> {
  const midnight = localMidnightUnix(isoDate);
  await withJob(pool, "ghosts", () => markGhosts(pool, isoDate));
  await withJob(pool, "roll:route", () => rollRouteDay(pool, isoDate));
  await withJob(pool, "roll:stop", () => rollStopHour(pool, isoDate, midnight));
  await withJob(pool, "roll:vehicle", () => rollVehicleDay(pool, isoDate));
  await withJob(pool, "roll:vehroute", () =>
    rollVehicleRoute(pool, Number(isoDate.slice(0, 7).replace("-", ""))),
  );
  await withJob(pool, "incidents", async () => {
    const r = await detectIncidents(pool, isoDate);
    if (r.skipped) log("incidents", `kihagyva: ${r.skipped}`);
    else if (r.detected || r.closed)
      log("incidents", `${r.detected} észlelés, ${r.closed} lezárva`);
    return r.detected;
  });
  log("roll", `${isoDate} kész`);
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const rollIdx = args.indexOf("--roll");

  const g = loadGtfs(GTFS_DIR);
  log(
    "gtfs",
    `${g.stops} megálló, ${g.routes} vonal, ${g.trips} menet, feed=${g.feedVersion}`,
  );

  if (!(await isReady())) {
    console.error(
      "[worker] Az adatbázis nem érhető el. Futtasd előbb: npm run db:migrate",
    );
    process.exit(1);
  }
  const pool = getPool();
  await loadKeys(pool);
  await loadCalendar(pool);
  log("db", "kulcsok és naptár betöltve");

  if (rollIdx >= 0) {
    const date = args[rollIdx + 1] ?? yesterdayIso();
    await withJob(pool, "profile", () => rollSegmentProfile(pool));
    await rollDay(pool, date);
    await closePool();
    return;
  }

  await withJob(pool, "janitor", async () => {
    const r = await runJanitor(pool);
    log("janitor", `partíció +${r.created.length} / −${r.dropped.length}`);
    return r.created.length;
  });

  const carry = new Map<number, PingRow>();
  let collectBusy = false;
  let matchBusy = false;
  let lastNightly = "";

  const collect = async () => {
    if (collectBusy) return;
    collectBusy = true;
    try {
      const r = await collectOnce(pool);
      await recordHealth(pool, r);
      if (!r.ok) log("collect", `feed hiba: ${r.error}`);
    } catch (e) {
      log("collect", `HIBA: ${(e as Error).message}`);
    } finally {
      collectBusy = false;
    }
  };

  const match = async () => {
    if (matchBusy) return;
    matchBusy = true;
    try {
      const r = await matchOnce(pool, carry);
      if (r.pings)
        log(
          "match",
          `${r.pings} pont → ${r.runs} menet, ${r.events} megálló, ${r.segments} szakasz`,
        );
    } catch (e) {
      log("match", `HIBA: ${(e as Error).message}`);
    } finally {
      matchBusy = false;
    }
  };

  await collect();
  await match();
  if (once) {
    const r = await closeRuns(pool);
    log("close", `${r.closed} menet lezárva`);
    await closePool();
    return;
  }

  setInterval(collect, COLLECT_INTERVAL_MS);
  setInterval(match, MATCH_INTERVAL_MS);

  setInterval(async () => {
    const r = await closeRuns(pool);
    if (r.closed) log("close", `${r.closed} menet lezárva`);
  }, CLOSE_INTERVAL_MS);

  setInterval(() => captureWeather(pool), WEATHER_INTERVAL_MS);
  captureWeather(pool);

  setInterval(
    () =>
      withJob(pool, "janitor", async () => {
        const r = await runJanitor(pool);
        if (r.created.length || r.dropped.length)
          log(
            "janitor",
            `partíció +${r.created.length} / −${r.dropped.length}`,
          );
        return r.created.length;
      }),
    JANITOR_INTERVAL_MS,
  );

  setInterval(async () => {
    const now = serviceNow();
    if (now.secOfDay < NIGHTLY_AT_S || lastNightly === now.isoDate) return;
    lastNightly = now.isoDate;
    log("nightly", "éjszakai összegzés indul");
    clearRunCache();
    await loadCalendar(pool);
    await withJob(pool, "profile", () => rollSegmentProfile(pool));
    await rollDay(pool, yesterdayIso());
  }, CLOSE_INTERVAL_MS);

  setInterval(() => rollDay(pool, serviceNow().isoDate), CLOSE_INTERVAL_MS);

  log(
    "worker",
    `fut — gyűjtés ${COLLECT_INTERVAL_MS / 1000} mp, illesztés ${MATCH_INTERVAL_MS / 1000} mp`,
  );

  const shutdown = async () => {
    log("worker", "leállás");
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[worker] végzetes hiba:", e);
  process.exit(1);
});
