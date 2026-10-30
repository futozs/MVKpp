import { describe, expect, it } from "vitest";
import { buildAlerts, type AlertInput } from "../src/server/alerts.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const healthy: AlertInput = {
  now: NOW,
  workerReachable: true,
  token: { present: true, expiresInSec: 5 * 3600, rejected: false },
  agents: [{ agentId: "mac", lastSeenAt: new Date(NOW - 30_000).toISOString() }],
  poll: { lastOkAt: NOW - 3_000, lastError: null },
  upstreamErrorPct: 0,
  containers: [{ service: "worker", state: "running", health: "healthy" }],
  dockerAvailable: true,
  diskUsedPct: 40,
  lastBackupAt: new Date(NOW - 3_600_000).toISOString(),
  backupsEnabled: true,
  eventLoopP99Ms: 12,
  probes: [{ id: "worker:health", label: "worker", ok: true }],
  gtfsFallback: false,
  behind: 0,
};

describe("buildAlerts", () => {
  it("is quiet when everything is healthy", () => {
    expect(buildAlerts(healthy)).toEqual([]);
  });

  it("puts critical problems first", () => {
    const a = buildAlerts({ ...healthy, behind: 2, diskUsedPct: 85, token: { present: true, expiresInSec: 600 }, containers: [{ service: "web", state: "exited", health: null }] });
    expect(a.map((x) => x.severity)).toEqual(["crit", "warn", "warn", "info"]);
    expect(a[0].id).toBe("ctr-web");
  });

  it("flags token, agent, feed and backup problems with the right severity", () => {
    const ids = (i: Partial<AlertInput>) => buildAlerts({ ...healthy, ...i }).map((a) => `${a.severity}:${a.id}`);
    expect(ids({ token: { present: false } })).toEqual(["crit:token-missing"]);
    expect(ids({ token: { present: true, expiresInSec: 9000, rejected: true } })).toEqual(["crit:token-rejected"]);
    expect(ids({ agents: [{ agentId: "mac", lastSeenAt: new Date(NOW - 25 * 60_000).toISOString() }] })).toEqual(["warn:agent-mac"]);
    expect(ids({ poll: { lastOkAt: NOW - 120_000, lastError: "HTTP 503" } })).toEqual(["crit:poll-stale"]);
    expect(ids({ lastBackupAt: null })).toEqual(["warn:backup-none"]);
    expect(ids({ backupsEnabled: false, lastBackupAt: null })).toEqual([]);
    expect(ids({ workerReachable: false, token: null, poll: null })).toEqual(["crit:worker-down"]);
  });

  it("ignores container state when Docker is not visible", () => {
    expect(buildAlerts({ ...healthy, dockerAvailable: false, containers: [{ service: "web", state: "exited", health: null }] })).toEqual([]);
  });
});
