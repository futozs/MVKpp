/**
 * Hosszú műveletek (telepítés, mentés, visszaállítás) futtatója: soronkénti
 * kimenet a memóriában, élő követés (SSE), és egyszerre csak egy „kizárólagos”
 * feladat — két telepítés vagy egy mentés + visszaállítás nem futhat egymásra.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.ts";
import { HubError } from "./http.ts";

export type TaskKind = "deploy" | "backup" | "restore" | "restart" | "git";
export type TaskLine = { at: number; text: string; level: "info" | "error" | "step" };
export type TaskInfo = { id: string; kind: TaskKind; title: string; startedAt: number; finishedAt: number | null; ok: boolean | null; error: string | null; lines: number };

const MAX_LINES = 8000;
const KEEP_TASKS = 30;

export class Task {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  finishedAt: number | null = null;
  ok: boolean | null = null;
  error: string | null = null;
  readonly lines: TaskLine[] = [];
  private subs = new Set<(l: TaskLine | null) => void>();

  constructor(
    readonly kind: TaskKind,
    readonly title: string,
  ) {}

  log(text: string, level: TaskLine["level"] = "info"): void {
    for (const part of text.replace(/\r/g, "").split("\n")) {
      if (!part.trim()) continue;
      const line = { at: Date.now(), text: part, level };
      this.lines.push(line);
      if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
      for (const fn of this.subs) fn(line);
    }
  }

  step(text: string): void {
    this.log(`▸ ${text}`, "step");
  }

  finish(ok: boolean, error: string | null = null): void {
    this.ok = ok;
    this.error = error;
    this.finishedAt = Date.now();
    if (error) this.log(error, "error");
    for (const fn of this.subs) fn(null);
    this.subs.clear();
  }

  subscribe(fn: (l: TaskLine | null) => void): () => void {
    if (this.finishedAt) {
      fn(null);
      return () => {};
    }
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  info(): TaskInfo {
    return { id: this.id, kind: this.kind, title: this.title, startedAt: this.startedAt, finishedAt: this.finishedAt, ok: this.ok, error: this.error, lines: this.lines.length };
  }
}

const g = globalThis as { __hubTasks?: { all: Task[]; exclusive: Task | null } };
const state = (g.__hubTasks ??= { all: [], exclusive: null });

export function listTasks(): TaskInfo[] {
  return state.all.map((t) => t.info()).reverse();
}

export function getTask(id: string): Task | undefined {
  return state.all.find((t) => t.id === id);
}

export function runningExclusive(): TaskInfo | null {
  return state.exclusive && !state.exclusive.finishedAt ? state.exclusive.info() : null;
}

/**
 * Feladat indítása a háttérben. A hívó azonnal visszakapja az azonosítót; a
 * kimenet a /api/tasks/:id/stream-en követhető. A végén a műveleti naplóba kerül.
 */
export function startTask(kind: TaskKind, title: string, ip: string, body: (t: Task) => Promise<void>, exclusive = true): Task {
  if (exclusive && state.exclusive && !state.exclusive.finishedAt) {
    throw new HubError(409, `már fut egy művelet: ${state.exclusive.title}`);
  }
  const task = new Task(kind, title);
  state.all.push(task);
  if (state.all.length > KEEP_TASKS) state.all.splice(0, state.all.length - KEEP_TASKS);
  if (exclusive) state.exclusive = task;
  void body(task)
    .then(() => task.finish(true))
    .catch((e) => task.finish(false, e instanceof Error ? e.message : String(e)))
    .finally(() => {
      void audit(`task:${kind}`, title, task.ok === true, { taskId: task.id, error: task.error, ms: (task.finishedAt ?? Date.now()) - task.startedAt }, ip);
    });
  return task;
}

/** Parancs futtatása, a kimenet soronként a feladatba; nem nulla kilépés → hiba. */
export function run(task: Task, cmd: string, args: string[], opts: SpawnOptions & { input?: NodeJS.ReadableStream; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!opts.quiet) task.log(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    const child = spawn(cmd, args, { ...opts, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      out += s;
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
      if (!opts.quiet) task.log(s);
    });
    child.stderr?.on("data", (c: Buffer) => task.log(c.toString("utf8")));
    if (opts.input && child.stdin) {
      opts.input.pipe(child.stdin);
      child.stdin.on("error", () => {
        /* a folyamat korábban kilépett — a kilépési kód mondja meg, mi történt */
      });
    }
    child.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args[0] ?? ""} — kilépési kód: ${code}`))));
  });
}
