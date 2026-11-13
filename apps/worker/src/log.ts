/** Egysoros, időbélyeges napló  a konténer stdout-ja a forrás (docker logs). */
import { LogRing, parseLogLine, type LogLevel } from "@mvk/core/ops/logRing";

type Level = "info" | "warn" | "error";
const time = () => new Date().toISOString().slice(11, 19);

/** A folyamat utolsó sorai (a rendszer-hub /system/logs-ból olvassa). */
export const logRing = new LogRing();

function write(level: Level, tag: string, msg: string, extra?: unknown) {
  const line = `${time()} ${level === "info" ? " " : level === "warn" ? "!" : "✖"} [${tag}] ${msg}`;
  const tail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  (level === "error" ? console.error : console.log)(line + tail);
}

export const log = {
  info: (tag: string, msg: string, extra?: unknown) => write("info", tag, msg, extra),
  warn: (tag: string, msg: string, extra?: unknown) => write("warn", tag, msg, extra),
  error: (tag: string, msg: string, extra?: unknown) => write("error", tag, msg, extra),
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

let captured = false;

/**
 * A konzol minden kimenete (a saját naplónk és a könyvtáraké, pl. pg-boss) a
 * gyűrűbe is bekerül; a stdout változatlan marad.
 */
export function captureConsole(): void {
  if (captured) return;
  captured = true;
  const tee = (method: "log" | "info" | "warn" | "error", fallback: LogLevel) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(" ");
      const p = parseLogLine(text, fallback);
      logRing.push(p.level, p.tag, p.msg);
    };
  };
  tee("log", "info");
  tee("info", "info");
  tee("warn", "warn");
  tee("error", "error");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
