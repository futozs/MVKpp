/** A hub saját naplója: a konzol minden sora a gyűrűbe is bekerül (a Naplók oldal „hub” forrása). */
import { LogRing, type LogLevel } from "@mvk/core/ops/logRing";

const g = globalThis as { __hubLogRing?: LogRing; __hubConsoleTee?: boolean };
export const hubLogRing: LogRing = (g.__hubLogRing ??= new LogRing(2000));

export function teeConsole(): void {
  if (g.__hubConsoleTee) return;
  g.__hubConsoleTee = true;
  const tee = (method: "log" | "info" | "warn" | "error", level: LogLevel) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(" ");
      const m = /^\[([\w:-]{1,24})\]\s*([\s\S]*)$/.exec(text);
      hubLogRing.push(level, m?.[1] ?? "hub", m?.[2] ?? text);
    };
  };
  tee("log", "info");
  tee("info", "info");
  tee("warn", "warn");
  tee("error", "error");
}
