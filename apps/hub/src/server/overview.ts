/**
 * Az Áttekintés egyetlen hívásban: minden alrendszer legfontosabb száma és a
 * riasztások. Egy forrás kiesése nem dönti el az oldalt — az a rész jelzi a hibát.
 */
import { sql, sqlOne } from "@mvk/db";
import type { MetricStat } from "@mvk/core/ops/metrics";
import { buildAlerts, type SourceBrief } from "./alerts.ts";
import { diskUsage, listBackups } from "./backup.ts";
import { gitStatus } from "./deploy.ts";
import { dockerAvailable, listContainers } from "./docker.ts";
import { env } from "./env.ts";
import { settle } from "./http.ts";
import { latestProbes } from "./probes.ts";
import { webJson, workerJson } from "./services.ts";

export type WorkerMetrics = {
  at: number;
  windowMin: number;
  process: { uptimeSec: number; cpuPct: number; eventLoop: { meanMs: number; p99Ms: number; maxMs: number }; memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number }; nodeVersion: string };
  http: MetricStat[];
  upstream: MetricStat[];
  poll: { ok: number; fail: number; lastOkAt: number; lastError: string | null; lastMs: number; pingsKept: number; vehiclesMax: number; rtError?: string | null; vehicles: number; fetchedAt: number };
  ws: { clients: number; connections: number; messages: number };
  persist: Record<string, number>;
  cache: { backend: string; redis?: string };
  token: { present: boolean; expiresInSec?: number | null; rejected?: boolean; source?: string; receivedAt?: string; lastRenew?: unknown };
  gtfs: { feedVersion: string | null; today: { feedVersion: string; fallback: boolean } | null; lastCheck?: unknown };
  source?: SourceBrief;
  startedAt: number;
};

export type WebMetrics = { at: number; process: { uptimeSec: number; memory: { rssMb: number; heapUsedMb: number }; nodeVersion: string }; http: MetricStat[] };

const isErr = (v: unknown): v is { error: string } => typeof v === "object" && v != null && "error" in v && Object.keys(v).length === 1;

export function upstreamErrorPct(m: WorkerMetrics | null): number | null {
  if (!m) return null;
  const n = m.upstream.reduce((a, s) => a + s.count, 0);
  const err = m.upstream.reduce((a, s) => a + s.errors, 0);
  return n ? Math.round((err / n) * 1000) / 10 : null;
}

export async function overview() {
  const [worker, web, live, containers, git, usage, accounts, dbSize, agents] = await Promise.all([
    settle(workerJson<WorkerMetrics>("/system/metrics?window=15")),
    settle(webJson<WebMetrics>("/v3/admin/metrics?window=15")),
    settle(workerJson<{ clients: number; signedIn: number; devices: number; topics: Record<string, number> }>("/system/live")),
    dockerAvailable() ? settle(listContainers()) : Promise.resolve(null),
    settle(gitStatus()),
    settle(
      sqlOne<{ today: number; week: number; month: number }>(
        `SELECT count(*) FILTER (WHERE day = (now() AT TIME ZONE 'Europe/Budapest')::date)::int AS today,
                count(DISTINCT device_id) FILTER (WHERE day > (now() AT TIME ZONE 'Europe/Budapest')::date - 7)::int AS week,
                count(DISTINCT device_id)::int AS month
           FROM usage_day WHERE day > (now() AT TIME ZONE 'Europe/Budapest')::date - 30`,
      ),
    ),
    settle(sqlOne<{ n: number; week: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week FROM app_user`)),
    settle(sqlOne<{ bytes: number }>(`SELECT pg_database_size(current_database()) AS bytes`)),
    settle(sql<{ agentId: string; lastSeenAt: string; info: Record<string, unknown> }>(`SELECT agent_id AS "agentId", last_seen_at AS "lastSeenAt", info FROM agent_heartbeat ORDER BY last_seen_at DESC`)),
  ]);
  const w = isErr(worker) ? null : worker;
  const backups = listBackups();
  const disk = diskUsage();
  const probes = latestProbes();
  const g = isErr(git) ? null : git;
  const ctr = containers && !isErr(containers) ? containers : null;
  const agentRows = isErr(agents) ? [] : agents;

  const alerts = buildAlerts({
    now: Date.now(),
    workerReachable: Boolean(w),
    token: w ? w.token : null,
    agents: agentRows,
    poll: w ? w.poll : null,
    upstreamErrorPct: upstreamErrorPct(w),
    containers: ctr,
    dockerAvailable: dockerAvailable(),
    diskUsedPct: disk?.usedPct ?? null,
    lastBackupAt: backups[0]?.createdAt ?? null,
    backupsEnabled: env.backupHour >= 0 && dockerAvailable(),
    eventLoopP99Ms: w?.process.eventLoop.p99Ms ?? null,
    probes,
    gtfsFallback: w?.gtfs.today?.fallback ?? null,
    source: w?.source ?? null,
    behind: g?.available ? (g.behind ?? 0) : null,
  });

  return {
    at: Date.now(),
    alerts,
    worker: w ?? { error: (worker as { error: string }).error },
    web: web,
    live,
    containers: containers ?? { error: "a Docker socket nincs felcsatolva" },
    git,
    usage,
    accounts,
    db: dbSize,
    agents: agentRows,
    backups: { count: backups.length, last: backups[0] ?? null, totalBytes: backups.reduce((a, b) => a + b.bytes, 0) },
    disk,
    probes,
  };
}
