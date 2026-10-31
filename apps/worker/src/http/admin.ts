/**
 * A rendszer-hub (apps/hub) üzemeltetési végpontjai — mind admin-kulcsos
 * (X-Admin-Key). A hub szerveroldala hívja őket a belső hálón; a böngésző
 * soha nem kapja meg a kulcsot.
 *
 *   GET  /system/metrics       válaszidők (saját + MVK API), folyamat, poll, WebSocket
 *   GET  /system/live          ki van most fent (témák, bejelentkezettek, legnézettebb megállók)
 *   GET  /system/logs          a naplógyűrű lapozva (?after=<seq>&limit=)
 *   GET  /system/logs/stream   ugyanez élőben (Server-Sent Events)
 *   POST /system/mvk-call      tetszőleges MVK API-hívás a szerver tokenjével (API-vizsgáló)
 *   GET  /system/jobs/runs     a hubból indított feladatok állapota
 *   POST /system/jobs/run      feladat indítása most ({ job })
 */
import type { ServerResponse } from "node:http";
import { cacheStatus } from "@mvk/cache";
import { decodeRtFeedJson, serviceClock, shiftIso } from "@mvk/core";
import { detectIncidentsForDay } from "../incidents.ts";
import { errMsg, log, logRing } from "../log.ts";
import { httpMetrics, processStats, upstreamMetrics } from "../metrics.ts";
import { trainDelayModelInThread } from "../ml/thread.ts";
import { mvkFetch } from "../mvk.ts";
import { lastRenewInfo, tokenStatus } from "../token.ts";
import { requireAdmin, type Ctx } from "./compat.ts";
import { HttpError, sendJson, type Req, type Router } from "./router.ts";

export type AdminCtx = Ctx & { liveBreakdown: () => unknown };

const MAX_INSPECT_BYTES = 1_000_000;
const SSE_BACKLOG = 300;
const SSE_PING_MS = 20_000;

type JobName = "gtfs-refresh" | "incidents" | "predictor-learn" | "forecast-load" | "ml-train" | "nightly";
type JobRun = { job: JobName; startedAt: number; finishedAt: number | null; ok: boolean | null; note: string | null };

const JOB_NAMES: JobName[] = ["gtfs-refresh", "incidents", "predictor-learn", "forecast-load", "ml-train", "nightly"];

export function registerAdmin(r: Router, ctx: AdminCtx) {
  const runs: JobRun[] = [];
  const running = new Set<JobName>();

  const jobs: Record<JobName, () => Promise<string>> = {
    "gtfs-refresh": async () => String(await ctx.feeds.refresh()),
    incidents: async () => {
      const day = shiftIso(serviceClock().iso, -1);
      await detectIncidentsForDay(ctx.feeds, day);
      return `${day} üzemzavarai újraszámolva`;
    },
    "predictor-learn": async () => {
      await ctx.predictor.learn();
      return "a rendszám-előrejelző újratanult";
    },
    "forecast-load": async () => {
      await ctx.forecaster.load();
      return "a szakaszidő-profilok újratöltve";
    },
    "ml-train": async () => {
      const saved = await trainDelayModelInThread();
      if (saved) await ctx.forecaster.loadModel();
      return saved ? "új késés-modell élesítve" : "a modell nem lett jobb — a régi marad";
    },
    nightly: async () => {
      const out: string[] = [];
      for (const j of ["incidents", "predictor-learn", "forecast-load", "ml-train"] as const) out.push(await jobs[j]());
      return out.join(" · ");
    },
  };

  r.get("/system/metrics", (req, res) => {
    requireAdmin(req);
    const windowMin = clampInt(req.query.get("window"), 15, 1, 60);
    sendJson(req, res, 200, {
      at: Date.now(),
      windowMin,
      process: processStats(),
      http: httpMetrics.snapshot(windowMin),
      upstream: upstreamMetrics.snapshot(windowMin),
      poll: { ...ctx.engine.poll, rtError: ctx.engine.snapshot.rtError, vehicles: ctx.engine.snapshot.vehicles.length, fetchedAt: ctx.engine.snapshot.fetchedAt },
      ws: ctx.hubStats(),
      persist: { ...ctx.engine.persister.stats, pending: ctx.engine.persister.pending() },
      cache: cacheStatus(),
      token: { ...tokenStatus(), lastRenew: lastRenewInfo() },
      gtfs: ctx.feeds.status(),
      // MVK ↔ MÁV+ (a hub oldalsávjának és riasztásainak); a részletek: /system/sources
      source: sourceBrief(ctx),
      startedAt: ctx.startedAt,
    });
  });

  r.get("/system/live", (req, res) => {
    requireAdmin(req);
    sendJson(req, res, 200, ctx.liveBreakdown(), { "cache-control": "no-store" });
  });

  r.get("/system/logs", (req, res) => {
    requireAdmin(req);
    const after = clampInt(req.query.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(req.query.get("limit"), 500, 1, 4000);
    sendJson(req, res, 200, { lastSeq: logRing.lastSeq, lines: logRing.since(after, limit) }, { "cache-control": "no-store" });
  });

  r.get("/system/logs/stream", (req, res) => {
    requireAdmin(req);
    streamLogs(req, res);
  });

  r.post("/system/mvk-call", async (req, res) => {
    requireAdmin(req);
    sendJson(req, res, 200, await inspectMvk(req.body));
  });

  r.get("/system/jobs/runs", (req, res) => {
    requireAdmin(req);
    sendJson(req, res, 200, { jobs: JOB_NAMES, running: [...running], runs: runs.slice(-50).reverse() });
  });

  r.post("/system/jobs/run", (req, res) => {
    requireAdmin(req);
    const job = String(parseJson(req.body)?.job ?? "") as JobName;
    if (!JOB_NAMES.includes(job)) throw new HttpError(400, `ismeretlen feladat — ezek vannak: ${JOB_NAMES.join(", ")}`);
    if (running.has(job)) throw new HttpError(409, "ez a feladat már fut");
    const run: JobRun = { job, startedAt: Date.now(), finishedAt: null, ok: null, note: null };
    runs.push(run);
    if (runs.length > 200) runs.splice(0, runs.length - 200);
    running.add(job);
    log.info("admin", `feladat indítva a hubból: ${job}`);
    void jobs[job]()
      .then((note) => Object.assign(run, { ok: true, note }))
      .catch((e) => {
        Object.assign(run, { ok: false, note: errMsg(e) });
        log.error("admin", `feladat sikertelen: ${job}`, errMsg(e));
      })
      .finally(() => {
        run.finishedAt = Date.now();
        running.delete(job);
      });
    sendJson(req, res, 202, { ok: true, run });
  });
}

function streamLogs(req: Req, res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  const after = clampInt(req.query.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  const backlog = logRing.since(after, after ? 4000 : SSE_BACKLOG);
  for (const l of backlog) res.write(`id: ${l.seq}\ndata: ${JSON.stringify(l)}\n\n`);
  const unsub = logRing.subscribe((l) => res.write(`id: ${l.seq}\ndata: ${JSON.stringify(l)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), SSE_PING_MS);
  const close = () => {
    clearInterval(ping);
    unsub();
  };
  req.on("close", close);
  res.on("error", close);
}

type InspectIn = { method?: string; path?: string; body?: string; accept?: string };

async function inspectMvk(raw: Buffer | undefined) {
  const j = (parseJson(raw) ?? {}) as InspectIn;
  const method = String(j.method ?? "GET").toUpperCase();
  const path = String(j.path ?? "");
  if (method !== "GET" && method !== "POST") throw new HttpError(400, "csak GET és POST");
  if (!/^\/api\/[\w./?=&%:,-]{1,400}$/.test(path)) throw new HttpError(400, "az útvonal /api/…-val kezdődjön (pl. /api/v1/gtfs/get-positions)");
  // ne lehessen kilépni az /api/ alól (a hívás a szerver tokenjét viszi)
  if (/\.\.|%2e|%2f|%5c|\/\//i.test(path.split("?")[0])) throw new HttpError(400, "érvénytelen útvonal");
  const isProto = /gtfs\/get-(positions|updates)/.test(path);
  const t0 = performance.now();
  const r = await mvkFetch(path, {
    method,
    body: method === "POST" ? Buffer.from(String(j.body ?? "{}")) : undefined,
    contentType: method === "POST" ? "application/json" : undefined,
    accept: j.accept ?? (isProto ? "application/x-protobuf, */*" : "application/json"),
    timeoutMs: 20_000,
    redirect: "manual",
  });
  const ms = Math.round(performance.now() - t0);
  const out = { status: r.status, ms, contentType: r.contentType, bytes: r.buf.length, body: null as unknown, text: null as string | null, truncated: false };
  if (isProto && r.status === 200) {
    try {
      const feed = decodeRtFeedJson(r.buf);
      out.body = { decodedFrom: "GTFS-RT protobuf", entities: feed.entity.length, header: feed.header, sample: feed.entity.slice(0, 25) };
      return out;
    } catch {
      /* nem dekódolható — nyersen adjuk vissza */
    }
  }
  const text = r.buf.subarray(0, MAX_INSPECT_BYTES).toString("utf8");
  out.truncated = r.buf.length > MAX_INSPECT_BYTES;
  try {
    out.body = JSON.parse(text);
  } catch {
    out.text = text;
  }
  return out;
}

function parseJson(raw: Buffer | undefined): Record<string, unknown> | null {
  if (!raw?.length) return null;
  try {
    const v = JSON.parse(raw.toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    throw new HttpError(400, "érvénytelen JSON");
  }
}

function clampInt(v: string | null, fallback: number, min: number, max: number): number {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

/** Az adatforrás röviden: melyik viszi az MVK-t, és él-e a MÁV+ (Volán, vasút). */
function sourceBrief(ctx: Ctx) {
  const st = ctx.engine.sources.status();
  const rt = ctx.regionalRt.status();
  return {
    state: st.state,
    since: st.since,
    reason: st.reason,
    fallbackSecToday: st.fallbackSecToday,
    regional: { enabled: rt.enabled, vehicles: rt.vehicles, lastOkAt: rt.client.lastOkAt || null, lastError: rt.error ?? rt.client.lastError, limited: rt.client.limited },
  };
}
