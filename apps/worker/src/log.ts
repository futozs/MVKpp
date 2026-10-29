/** Egysoros, időbélyeges napló — a konténer stdout-ja a forrás (docker logs). */
type Level = "info" | "warn" | "error";
const time = () => new Date().toISOString().slice(11, 19);

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
