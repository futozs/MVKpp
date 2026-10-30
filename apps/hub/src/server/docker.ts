/**
 * Docker Engine API a unix socketen át (/var/run/docker.sock) — konténerek
 * listája, erőforrás-használat, újraindítás, naplók. Ha a socket nincs
 * felcsatolva (fejlesztés), `dockerAvailable()` hamis, és a hub ezt mutatja.
 */
import { existsSync } from "node:fs";
import http from "node:http";
import { env } from "./env.ts";
import { HubError } from "./http.ts";

const TIMEOUT_MS = 15_000;

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
};

export type ContainerDetail = Container & { startedAt: string | null; restartCount: number; exitCode: number | null; oomKilled: boolean; mounts: { source: string; destination: string }[] };

export type ContainerStats = { cpuPct: number; memMb: number; memLimitMb: number; memPct: number; netRxMb: number; netTxMb: number; blockReadMb: number; blockWriteMb: number; pids: number };

export const dockerAvailable = () => existsSync(env.dockerSock);

function request(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath: env.dockerSock, method, path, headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("a Docker nem válaszolt időben")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!dockerAvailable()) throw new HubError(503, `a Docker socket nincs felcsatolva (${env.dockerSock})`);
  const r = await request(method, path, body);
  if (r.status >= 400) {
    let msg = r.text;
    try {
      msg = (JSON.parse(r.text) as { message?: string }).message ?? r.text;
    } catch {
      /* nyers szöveg */
    }
    throw new HubError(r.status === 404 ? 404 : 502, `Docker: ${msg.slice(0, 300)}`);
  }
  return (r.text ? JSON.parse(r.text) : null) as T;
}

type RawContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Labels: Record<string, string>;
  Ports: { PrivatePort: number; PublicPort?: number; IP?: string; Type: string }[];
};

function toContainer(c: RawContainer): Container {
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] ?? null;
  return {
    id: c.Id.slice(0, 12),
    name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
    service: c.Labels["com.docker.compose.service"] ?? "",
    image: c.Image,
    state: c.State,
    status: c.Status,
    health: health === "health: starting" ? "starting" : health,
    createdAt: c.Created * 1000,
    ports: c.Ports.filter((p) => p.PublicPort).map((p) => `${p.IP ?? ""}:${p.PublicPort}→${p.PrivatePort}`),
  };
}

/** A Compose-projekt konténerei (alapból „mvk”). */
export async function listContainers(): Promise<Container[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${env.composeProject}`] }));
  const raw = await dockerJson<RawContainer[]>("GET", `/containers/json?all=1&filters=${filters}`);
  return raw.map(toContainer).sort((a, b) => a.service.localeCompare(b.service));
}

type RawInspect = {
  Id: string;
  Name: string;
  RestartCount: number;
  State: { Status: string; StartedAt: string; ExitCode: number; OOMKilled: boolean; Health?: { Status: string } };
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: { Source: string; Destination: string }[];
  Created: string;
};

export async function inspectContainer(idOrName: string): Promise<ContainerDetail> {
  const c = await dockerJson<RawInspect>("GET", `/containers/${encodeURIComponent(idOrName)}/json`);
  return {
    id: c.Id.slice(0, 12),
    name: c.Name.replace(/^\//, ""),
    service: c.Config.Labels["com.docker.compose.service"] ?? "",
    image: c.Config.Image,
    state: c.State.Status,
    status: c.State.Status,
    health: c.State.Health?.Status ?? null,
    createdAt: Date.parse(c.Created),
    ports: [],
    startedAt: c.State.StartedAt && !c.State.StartedAt.startsWith("0001") ? c.State.StartedAt : null,
    restartCount: c.RestartCount,
    exitCode: c.State.ExitCode,
    oomKilled: c.State.OOMKilled,
    mounts: c.Mounts.map((m) => ({ source: m.Source, destination: m.Destination })),
  };
}

type RawStats = {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op: string; value: number }[] | null };
  pids_stats?: { current?: number };
};

const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

export async function containerStats(id: string): Promise<ContainerStats> {
  const s = await dockerJson<RawStats>("GET", `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=false`);
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus ?? 1;
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
  const used = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
  const limit = s.memory_stats.limit ?? 0;
  const nets = Object.values(s.networks ?? {});
  const blk = s.blkio_stats?.io_service_bytes_recursive ?? [];
  return {
    cpuPct: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0,
    memMb: mb(used),
    memLimitMb: mb(limit),
    memPct: limit ? Math.round((used / limit) * 1000) / 10 : 0,
    netRxMb: mb(nets.reduce((a, n) => a + n.rx_bytes, 0)),
    netTxMb: mb(nets.reduce((a, n) => a + n.tx_bytes, 0)),
    blockReadMb: mb(blk.filter((b) => /read/i.test(b.op)).reduce((a, b) => a + b.value, 0)),
    blockWriteMb: mb(blk.filter((b) => /write/i.test(b.op)).reduce((a, b) => a + b.value, 0)),
    pids: s.pids_stats?.current ?? 0,
  };
}

export type ContainerAction = "start" | "stop" | "restart";

export async function containerAction(id: string, action: ContainerAction): Promise<void> {
  if (!dockerAvailable()) throw new HubError(503, "a Docker socket nincs felcsatolva");
  const r = await request("POST", `/containers/${encodeURIComponent(id)}/${action}${action === "start" ? "" : "?t=20"}`, undefined, 60_000);
  // 304: már abban az állapotban van
  if (r.status >= 400) throw new HubError(502, `Docker: ${r.text.slice(0, 300)}`);
}

export type DockerInfo = { serverVersion: string; os: string; kernel: string; cpus: number; memGb: number; containersRunning: number; images: number };

export async function dockerInfo(): Promise<DockerInfo> {
  const i = await dockerJson<{ ServerVersion: string; OperatingSystem: string; KernelVersion: string; NCPU: number; MemTotal: number; ContainersRunning: number; Images: number }>("GET", "/info");
  return { serverVersion: i.ServerVersion, os: i.OperatingSystem, kernel: i.KernelVersion, cpus: i.NCPU, memGb: Math.round((i.MemTotal / 1073741824) * 10) / 10, containersRunning: i.ContainersRunning, images: i.Images };
}

type RawDf = { Volumes?: { Name: string; Labels: Record<string, string> | null; UsageData?: { Size: number } }[]; Images?: { Size: number }[]; BuildCache?: { Size: number }[] };
let dfCache: { at: number; data: unknown } | null = null;

/** A projekt köteteinek mérete (pl. az adatbázis kötete) — drága hívás, 10 percig gyorsítótárazva. */
export async function volumeUsage(): Promise<{ volumes: { name: string; sizeMb: number }[]; imagesMb: number; buildCacheMb: number }> {
  if (dfCache && Date.now() - dfCache.at < 10 * 60_000) return dfCache.data as Awaited<ReturnType<typeof volumeUsage>>;
  const df = await dockerJson<RawDf>("GET", "/system/df");
  const data = {
    volumes: (df.Volumes ?? [])
      .filter((v) => v.Labels?.["com.docker.compose.project"] === env.composeProject)
      .map((v) => ({ name: v.Name, sizeMb: mb(Math.max(0, v.UsageData?.Size ?? 0)) })),
    imagesMb: mb((df.Images ?? []).reduce((a, x) => a + x.Size, 0)),
    buildCacheMb: mb((df.BuildCache ?? []).reduce((a, x) => a + x.Size, 0)),
  };
  dfCache = { at: Date.now(), data };
  return data;
}

/**
 * Konténer-napló folyamként: soronként hívja `onLine`-t, amíg `signal` le nem áll.
 * TTY nélküli konténernél a Docker 8 bájtos fejlécekkel keveri a stdout/stderr-t.
 */
export function streamContainerLogs(id: string, opts: { tail: number; follow: boolean; signal: AbortSignal }, onLine: (stream: "out" | "err", line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!dockerAvailable()) return reject(new HubError(503, "a Docker socket nincs felcsatolva"));
    const path = `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${opts.tail}&follow=${opts.follow ? 1 : 0}`;
    const req = http.request({ socketPath: env.dockerSock, method: "GET", path, headers: { host: "docker" } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        return reject(new HubError(502, `Docker napló: HTTP ${res.statusCode}`));
      }
      const tty = !String(res.headers["content-type"] ?? "").includes("multiplexed");
      let buf = Buffer.alloc(0);
      const partial = { out: "", err: "" };
      const emit = (stream: "out" | "err", text: string) => {
        const lines = (partial[stream] + text).split("\n");
        partial[stream] = lines.pop() ?? "";
        for (const l of lines) if (l) onLine(stream, l);
      };
      res.on("data", (chunk: Buffer) => {
        if (tty) return emit("out", chunk.toString("utf8"));
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const size = buf.readUInt32BE(4);
          if (buf.length < 8 + size) break;
          emit(buf[0] === 2 ? "err" : "out", buf.subarray(8, 8 + size).toString("utf8"));
          buf = buf.subarray(8 + size);
        }
      });
      res.on("end", () => resolve());
      res.on("error", reject);
    });
    opts.signal.addEventListener("abort", () => {
      req.destroy();
      resolve();
    });
    req.on("error", (e) => (opts.signal.aborted ? resolve() : reject(e)));
    req.end();
  });
}
