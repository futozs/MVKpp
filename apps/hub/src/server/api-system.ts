/**
 * A hub API-jának rendszer-része: belépés, áttekintés, szolgáltatások,
 * válaszidők, token, MVK API, telepítés, feladatok, naplók, ütemezett munkák.
 */
import { audit } from "./audit.ts";
import { containerAction, containerStats, dockerAvailable, dockerInfo, listContainers, volumeUsage, type ContainerAction } from "./docker.ts";
import { DEPLOYABLE, deployLogs, gitFetch, gitStatus, previousDeploys, recentCommits, redeploy, type Deployable } from "./deploy.ts";
import { configProblems, env } from "./env.ts";
import { HubError, json, readJson, route, settle } from "./http.ts";
import { logSources, logStream } from "./logs.ts";
import { feedOverview, jobsOverview } from "./ops.ts";
import { overview, type WebMetrics, type WorkerMetrics } from "./overview.ts";
import { latestProbes, probeSeries, probeUptime, probeTargets } from "./probes.ts";
import { postJson, webJson, workerJson } from "./services.ts";
import { clearLoginFailures, issueSession, loginBlocked, noteLoginFailure, passwordMatches, SESSION_COOKIE } from "./session.ts";
import { getTask, listTasks, runningExclusive, startTask } from "./tasks.ts";
import { AGENT_COMMANDS, cancelAgentCommand, ingestToken, queueAgentCommand, renewToken, revealToken, tokenOverview } from "./token.ts";

const int = (v: string | null, d: number, min: number, max: number) => {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : d;
};

function cookie(value: string, expires: Date | null, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", expires ? `Expires=${expires.toUTCString()}` : "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const authRoutes = [
  route("POST", "/api/auth/login", async ({ req, ip, url }) => {
    const wait = loginBlocked(ip);
    if (wait) throw new HubError(429, `túl sok hibás próbálkozás — próbáld újra ${Math.ceil(wait / 60_000)} perc múlva`);
    const problems = configProblems();
    if (env.password.length < 12 || env.appSecret.length < 16) throw new HubError(503, problems.join(" "));
    const b = await readJson<{ password: string }>(req);
    if (!passwordMatches(String(b.password ?? ""), env.password)) {
      noteLoginFailure(ip);
      await audit("login", null, false, null, ip);
      throw new HubError(401, "hibás jelszó");
    }
    clearLoginFailures(ip);
    const s = issueSession(env.password, env.appSecret, env.sessionHours * 3_600_000);
    await audit("login", null, true, null, ip);
    return json({ ok: true }, 200, { "set-cookie": cookie(s.value, s.expires, url.protocol === "https:") });
  }),
  route("POST", "/api/auth/logout", ({ url }) => json({ ok: true }, 200, { "set-cookie": cookie("", null, url.protocol === "https:") })),
  // Belépés előtt is hívható (a proxy átengedi): csak a beállítási hibákat adja vissza.
  route("GET", "/api/auth/me", () => json({ problems: configProblems() })),
];

const statusRoutes = [
  route("GET", "/api/overview", async () => json(await overview())),

  route("GET", "/api/services", async () => {
    const [containers, info, volumes, worker, web] = await Promise.all([
      dockerAvailable() ? settle(listContainers()) : null,
      dockerAvailable() ? settle(dockerInfo()) : null,
      dockerAvailable() ? settle(volumeUsage()) : null,
      settle(workerJson<WorkerMetrics>("/system/metrics?window=15")),
      settle(webJson<WebMetrics>("/v3/admin/metrics?window=15")),
    ]);
    const list = containers && Array.isArray(containers) ? containers : [];
    const stats = await Promise.all(list.map((c) => (c.state === "running" ? settle(containerStats(c.id)) : Promise.resolve(null))));
    return json({
      dockerAvailable: dockerAvailable(),
      containers: containers && !Array.isArray(containers) ? containers : list.map((c, i) => ({ ...c, stats: stats[i] })),
      docker: info,
      volumes,
      worker,
      web,
    });
  }),

  route("POST", "/api/services/:name/:action", async ({ params, ip }) => {
    const action = params.action as ContainerAction;
    if (!["start", "stop", "restart"].includes(action)) throw new HubError(400, "ismeretlen művelet");
    const c = (await listContainers()).find((x) => x.name === params.name);
    if (!c) throw new HubError(404, "nincs ilyen konténer ebben a projektben");
    if (c.service === "hub" && action === "stop") throw new HubError(400, "a hub nem állíthatja le önmagát (újraindítani lehet)");
    try {
      await containerAction(c.id, action);
      await audit(`container:${action}`, c.name, true, null, ip);
    } catch (e) {
      await audit(`container:${action}`, c.name, false, { error: String(e) }, ip);
      throw e;
    }
    return json({ ok: true });
  }),

  route("POST", "/api/worker/soft-restart", async ({ ip }) => {
    const r = await workerJson("/system/restart", { method: "POST" });
    await audit("worker:soft-restart", "worker", true, null, ip);
    return json(r);
  }),

  route("GET", "/api/metrics", async ({ url }) => {
    const window = int(url.searchParams.get("window"), 15, 1, 60);
    const [worker, web, uptime] = await Promise.all([
      settle(workerJson<WorkerMetrics>(`/system/metrics?window=${window}`)),
      settle(webJson<WebMetrics>(`/v3/admin/metrics?window=${window}`)),
      settle(probeUptime(24)),
    ]);
    return json({ worker, web, probes: { targets: probeTargets(), latest: latestProbes(), uptime } });
  }),

  route("GET", "/api/probes", async ({ url }) => {
    const hours = int(url.searchParams.get("hours"), 24, 1, 24 * 14);
    const bucket = hours <= 6 ? 2 : hours <= 24 ? 10 : hours <= 72 ? 30 : 120;
    return json({ hours, bucketMin: bucket, targets: probeTargets(), series: await probeSeries(hours, bucket) });
  }),
];

const tokenRoutes = [
  route("GET", "/api/token", async () => json({ ...(await tokenOverview()), agentCommands: AGENT_COMMANDS })),
  route("POST", "/api/token/renew", async ({ ip }) => {
    const r = await renewToken();
    await audit("token:renew", null, Boolean(r.ok), r, ip);
    const note = (r as { result?: { note?: string } }).result?.note;
    return r.ok ? json(r) : json({ ...r, error: `az MVK nem adott új tokent${note ? `: ${note}` : ""} — kérj app-újraindítást az agenttől` }, 502);
  }),
  route("POST", "/api/token/ingest", async ({ req, ip }) => {
    const b = await readJson<{ jwt: string; installationId: string }>(req);
    const r = await ingestToken(String(b.jwt ?? ""), b.installationId ? String(b.installationId) : null);
    await audit("token:ingest", null, true, { installationId: b.installationId ?? null }, ip);
    return json(r);
  }),
  route("POST", "/api/token/reveal", async ({ ip }) => {
    const jwt = await revealToken();
    await audit("token:reveal", null, true, null, ip);
    return json({ jwt });
  }),
  route("POST", "/api/token/agent", async ({ req, ip }) => {
    const b = await readJson<{ kind: string; agentId: string }>(req);
    const r = await queueAgentCommand(String(b.kind ?? ""), b.agentId ? String(b.agentId) : null, `hub@${ip}`);
    await audit("agent:command", b.agentId ? String(b.agentId) : "bármelyik", true, { kind: b.kind, id: r.id }, ip);
    return json(r);
  }),
  route("POST", "/api/token/agent/:id/cancel", async ({ params, ip }) => {
    await cancelAgentCommand(int(params.id, 0, 0, Number.MAX_SAFE_INTEGER));
    await audit("agent:cancel", params.id, true, null, ip);
    return json({ ok: true });
  }),
];

const mvkRoutes = [
  route("GET", "/api/mvk", async () => {
    const [metrics, feeds] = await Promise.all([settle(workerJson<WorkerMetrics>("/system/metrics?window=60")), settle(feedOverview())]);
    return json({ metrics, feeds });
  }),
  route("POST", "/api/mvk/call", async ({ req, ip }) => {
    const b = await readJson<{ method: string; path: string; body: string }>(req);
    const r = await workerJson("/system/mvk-call", { ...postJson({ method: b.method, path: b.path, body: b.body }), timeoutMs: 25_000 });
    await audit("mvk:call", `${b.method ?? "GET"} ${b.path ?? ""}`, true, null, ip);
    return json(r);
  }),
  route("POST", "/api/mvk/reload-gtfs", async ({ ip }) => {
    const r = await workerJson("/system/reload-gtfs", { method: "POST", timeoutMs: 120_000 });
    await audit("gtfs:reload", null, true, r, ip);
    return json(r);
  }),
];

const opsRoutes = [
  route("GET", "/api/deploy", async () => {
    const [git, commits, previous] = await Promise.all([gitStatus(), settle(recentCommits(12)), settle(previousDeploys())]);
    return json({ git, commits, previous, tasks: listTasks(), running: runningExclusive(), dockerAvailable: dockerAvailable(), deployable: DEPLOYABLE });
  }),
  route("POST", "/api/deploy/fetch", async ({ ip }) => {
    await gitFetch();
    await audit("git:fetch", null, true, null, ip);
    return json(await gitStatus());
  }),
  route("POST", "/api/deploy/run", async ({ req, ip }) => {
    const b = await readJson<{ pull: boolean; services: string[] }>(req);
    const services = (Array.isArray(b.services) ? b.services : [...DEPLOYABLE]).filter((s): s is Deployable => (DEPLOYABLE as readonly string[]).includes(s));
    if (!services.length) throw new HubError(400, "válassz legalább egy szolgáltatást");
    const pull = b.pull !== false;
    const task = startTask("deploy", `${pull ? "frissítés + " : ""}újratelepítés: ${services.join(", ")}`, ip, (t) => redeploy(t, { pull, services }));
    return json({ taskId: task.id });
  }),
  route("GET", "/api/deploy/history/:name", async ({ params }) => json({ lines: await deployLogs(params.name) })),

  route("GET", "/api/tasks", () => json({ tasks: listTasks(), running: runningExclusive() })),
  route("GET", "/api/tasks/:id", ({ params, url }) => {
    const t = getTask(params.id);
    if (!t) throw new HubError(404, "nincs ilyen feladat (a hub újraindult?)");
    return json({ ...t.info(), lines: t.lines.slice(int(url.searchParams.get("from"), 0, 0, 1e9)) });
  }),
  route("GET", "/api/tasks/:id/stream", ({ params, req }) => {
    const t = getTask(params.id);
    if (!t) throw new HubError(404, "nincs ilyen feladat");
    return taskStream(t, req);
  }),

  route("GET", "/api/logs/sources", async () => json({ sources: await logSources() })),
  route("GET", "/api/logs/stream", ({ url, req }) => logStream(url.searchParams.get("source") ?? "worker", req)),

  route("GET", "/api/jobs", async () => json(await jobsOverview())),
  route("POST", "/api/jobs/run", async ({ req, ip }) => {
    const b = await readJson<{ job: string }>(req);
    const r = await workerJson("/system/jobs/run", postJson({ job: b.job }));
    await audit("job:run", String(b.job ?? ""), true, null, ip);
    return json(r);
  }),
];

function taskStream(t: NonNullable<ReturnType<typeof getTask>>, req: Request): Response {
  const enc = new TextEncoder();
  let unsub: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* a kliens elment */
        }
      };
      for (const l of t.lines) send(`data: ${JSON.stringify(l)}\n\n`);
      unsub = t.subscribe((l) => {
        if (l) return send(`data: ${JSON.stringify(l)}\n\n`);
        send(`event: done\ndata: ${JSON.stringify(t.info())}\n\n`);
        try {
          controller.close();
        } catch {
          /* már lezárva */
        }
      });
      req.signal.addEventListener("abort", () => unsub());
    },
    cancel() {
      unsub();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

export const systemRoutes = [...authRoutes, ...statusRoutes, ...tokenRoutes, ...mvkRoutes, ...opsRoutes];
