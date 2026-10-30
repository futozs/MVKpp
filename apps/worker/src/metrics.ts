/**
 * A worker mérőszámai a rendszer-hubnak: saját HTTP-útvonalak, az MVK API
 * hívásai, és a folyamat állapota (CPU, memória, event loop késése).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { RouteMetrics } from "@mvk/core/ops/metrics";

export const httpMetrics = new RouteMetrics();
export const upstreamMetrics = new RouteMetrics();

const SAMPLE_MS = 10_000;
/** a mintavétel felbontása (ms) — a hisztogram ezt alapzajként tartalmazza, ezért levonjuk */
const LOOP_RESOLUTION_MS = 20;
const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loop.enable();

let cpuPct = 0;
let lag = { meanMs: 0, p99Ms: 0, maxMs: 0 };
let lastCpu = process.cpuUsage();
let lastAt = Date.now();

setInterval(() => {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  cpuPct = Math.round(((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 1000) / 10;
  lastCpu = process.cpuUsage();
  lastAt = now;
  const lagMs = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);
  lag = { meanMs: lagMs(loop.mean), p99Ms: lagMs(loop.percentile(99)), maxMs: lagMs(loop.max) };
  loop.reset();
}, SAMPLE_MS).unref();

export function processStats() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    cpuPct,
    eventLoop: lag,
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      externalMb: Math.round(mem.external / 1048576),
    },
  };
}

/** Az MVK-útvonal a kulcs: a lekérdezés nélkül, a számok/azonosítók összevonva. */
export function upstreamKey(method: string, path: string): string {
  const p = path.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/:n");
  return `${method} ${p}`;
}
