/**
 * Naplók egy helyen: a worker naplógyűrűje (mindig), a hub saját naplója, és
 * Dockerben minden konténer stdout/stderr-je (web, db, caddy is). Élőben
 * Server-Sent Events-szel, egységes sorformátumban.
 */
import { dockerAvailable, listContainers, streamContainerLogs } from "./docker.ts";
import { env } from "./env.ts";
import { HubError } from "./http.ts";
import { hubLogRing } from "./hublog.ts";
import { callService } from "./services.ts";

export type HubLogLine = { seq: number; ts: number; level: "info" | "warn" | "error"; tag: string; msg: string; source: string };

export async function logSources(): Promise<{ id: string; label: string }[]> {
  const out = [
    { id: "worker", label: "worker (napló)" },
    { id: "hub", label: "hub" },
  ];
  if (dockerAvailable()) {
    for (const c of await listContainers().catch(() => [])) out.push({ id: `docker:${c.name}`, label: `${c.service || c.name} (konténer)` });
  }
  return out;
}

const LEVEL_RE = /(✖|\b(error|fatal|panic|failed|hiba)\b)/i;
const WARN_RE = /(\s!\s|\bwarn(ing)?\b|figyelmeztet)/i;

/** Egy nyers konténersor szétszedése: Docker-időbélyeg, szint (a szövegből becsülve), címke. */
export function parseDockerLine(raw: string, stream: "out" | "err", seq: number, source: string): HubLogLine {
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s([\s\S]*)$/.exec(raw);
  const ts = m ? Date.parse(m[1]) : Date.now();
  const text = m ? m[2] : raw;
  const own = /^\d\d:\d\d:\d\d ([ !✖]) \[([^\]]{1,40})\] ([\s\S]*)$/.exec(text);
  if (own) return { seq, ts, level: own[1] === "!" ? "warn" : own[1] === "✖" ? "error" : "info", tag: own[2], msg: own[3], source };
  const level = LEVEL_RE.test(text) ? "error" : WARN_RE.test(text) || stream === "err" ? "warn" : "info";
  return { seq, ts, level, tag: source.replace(/^docker:/, "").replace(/^mvk-|-\d+$/g, ""), msg: text, source };
}

function sse(write: (s: string) => void, line: HubLogLine) {
  write(`data: ${JSON.stringify(line)}\n\n`);
}

/** Élő naplófolyam egy forrásból (SSE). A kapcsolat bontásakor minden leáll. */
export function logStream(source: string, req: Request): Response {
  const encoder = new TextEncoder();
  const ctl = new AbortController();
  req.signal.addEventListener("abort", () => ctl.abort());

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (!ctl.signal.aborted) controller.enqueue(encoder.encode(s));
      };
      const ping = setInterval(() => write(": ping\n\n"), 20_000);
      const done = () => {
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* már lezárva */
        }
      };
      ctl.signal.addEventListener("abort", done);
      void pump(source, write, ctl.signal)
        .catch((e) => write(`event: error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`))
        .finally(done);
    },
    cancel() {
      ctl.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

async function pump(source: string, write: (s: string) => void, signal: AbortSignal): Promise<void> {
  if (source === "hub") {
    for (const l of hubLogRing.since(0, 400)) sse(write, { ...l, source });
    const unsub = hubLogRing.subscribe((l) => sse(write, { ...l, source }));
    await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
    unsub();
    return;
  }
  if (source === "worker") return pumpWorker(write, signal);
  if (source.startsWith("docker:")) {
    const name = source.slice(7);
    const known = (await listContainers()).some((c) => c.name === name);
    if (!known) throw new HubError(404, "nincs ilyen konténer ebben a projektben");
    let seq = 0;
    await streamContainerLogs(name, { tail: 400, follow: true, signal }, (stream, raw) => sse(write, parseDockerLine(raw, stream, ++seq, source)));
    return;
  }
  throw new HubError(400, "ismeretlen naplóforrás");
}

/** A worker SSE-folyamát továbbítjuk (a kulcs a hubban marad); ha megszakad, újracsatlakozunk. */
async function pumpWorker(write: (s: string) => void, signal: AbortSignal): Promise<void> {
  let after = 0;
  while (!signal.aborted) {
    try {
      const res = await callService("worker", `/system/logs/stream?after=${after}`, { signal });
      if (!res.ok || !res.body) throw new Error(`worker: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const l = JSON.parse(data.slice(6)) as Omit<HubLogLine, "source">;
          after = Math.max(after, l.seq);
          sse(write, { ...l, source: "worker" });
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      write(`event: notice\ndata: ${JSON.stringify({ msg: `a worker naplója megszakadt (${e instanceof Error ? e.message : e})  újracsatlakozás…` })}\n\n`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export const LOG_SOURCES_HELP = `Dockerben (${env.dockerSock}) minden konténer naplója látszik; nélküle csak a worker és a hub.`;
