/** A hub API válaszainak alakja (a kliens ezekre számít). A szerveroldali forrásuk a src/server alatt. */
import type { MetricStat } from "@mvk/core/ops/metrics";

export type { MetricStat };
export type Maybe<T> = T | { error: string };

export type Alert = { id: string; severity: "crit" | "warn" | "info"; title: string; detail?: string; href: string };

export type WorkerMetrics = {
  at: number;
  windowMin: number;
  process: { pid: number; uptimeSec: number; cpuPct: number; nodeVersion: string; eventLoop: { meanMs: number; p99Ms: number; maxMs: number }; memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number } };
  http: MetricStat[];
  upstream: MetricStat[];
  poll: { ok: number; fail: number; lastOkAt: number; lastError: string | null; lastMs: number; pingsKept: number; vehiclesMax: number; rtError?: string | null; vehicles: number; fetchedAt: number };
  ws: { clients: number; connections: number; messages: number };
  persist: { pings: number; events: number; runs: number; segments: number; errors: number; pending: number };
  cache: { backend: string; redis?: string };
  token: { present: boolean; exp?: number; expiresInSec?: number | null; expired?: boolean; rejected?: boolean; source?: string; receivedAt?: string; installationId?: string; lastRenew?: { at: string; ok: boolean; status?: number; note?: string } | null };
  gtfs: { feedVersion: string | null; feeds: number; loaded: string[]; lastCheck?: unknown; today: { feedVersion: string; fallback: boolean } | null };
  startedAt: number;
};

export type WebMetrics = { at: number; process: { uptimeSec: number; startedAt: number; nodeVersion: string; memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number } }; http: MetricStat[] };

export type Container = {
  id: string;
  name: string;
  service: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  createdAt: number;
  ports: string[];
  stats?: Maybe<{ cpuPct: number; memMb: number; memLimitMb: number; memPct: number; netRxMb: number; netTxMb: number; blockReadMb: number; blockWriteMb: number; pids: number }> | null;
};

export type Probe = { id: string; label: string; at: number; ms: number | null; status: number; ok: boolean; error?: string };

export type Commit = { sha: string; short: string; subject: string; author: string; date: string };
export type GitStatus = { available: boolean; reason?: string; branch?: string; head?: Commit; dirty?: string[]; upstream?: string | null; ahead?: number; behind?: number; incoming?: Commit[]; lastFetchAt?: string | null };

export type BackupMeta = { name: string; bytes: number; createdAt: string; kind: "auto" | "manual" | "pre-restore" | "upload"; note?: string; durationMs?: number; dbBytes?: number | null; serverVersion?: string | null };
export type Disk = { totalGb: number; freeGb: number; usedPct: number; path: string } | null;

export type Agent = { agentId: string; lastSeenAt: string; info: { host?: string; appRunning?: boolean; plistReadable?: boolean; version?: number; localTokenLeftSec?: number; lastRestartAt?: string; macos?: string } & Record<string, unknown> };

export type Overview = {
  at: number;
  alerts: Alert[];
  worker: Maybe<WorkerMetrics>;
  web: Maybe<WebMetrics>;
  live: Maybe<{ clients: number; signedIn: number; devices: number; topics: Record<string, number> }>;
  containers: Maybe<Container[]>;
  git: Maybe<GitStatus>;
  usage: Maybe<{ today: number; week: number; month: number } | null>;
  accounts: Maybe<{ n: number; week: number } | null>;
  db: Maybe<{ bytes: number } | null>;
  agents: Agent[];
  backups: { count: number; last: BackupMeta | null; totalBytes: number };
  disk: Disk;
  probes: Probe[];
};

export type TaskLine = { at: number; text: string; level: "info" | "error" | "step" };
export type TaskInfo = { id: string; kind: string; title: string; startedAt: number; finishedAt: number | null; ok: boolean | null; error: string | null; lines: number };

export type LogLine = { seq: number; ts: number; level: "info" | "warn" | "error"; tag: string; msg: string; source: string };
