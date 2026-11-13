/**
 * Napló-gyűrű: a folyamat utolsó néhány ezer sora memóriában, sorszámmal.
 * A rendszer-hub ebből olvas (lapozva és élőben), akkor is, ha nincs
 * Docker-hozzáférése a konténer stdout-jához.
 */
export type LogLevel = "info" | "warn" | "error";
export type LogLine = { seq: number; ts: number; level: LogLevel; tag: string; msg: string };

const DEFAULT_CAP = 4000;
const MAX_LINE = 4000;

export class LogRing {
  private lines: LogLine[] = [];
  private seq = 0;
  private subs = new Set<(l: LogLine) => void>();
  private cap: number;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  push(level: LogLevel, tag: string, msg: string): LogLine {
    const line: LogLine = { seq: ++this.seq, ts: Date.now(), level, tag, msg: msg.length > MAX_LINE ? `${msg.slice(0, MAX_LINE)}…` : msg };
    this.lines.push(line);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    for (const fn of this.subs) {
      try {
        fn(line);
      } catch {
        /* egy hibás feliratkozó ne állítsa meg a naplózást */
      }
    }
    return line;
  }

  /** A `after` sorszám utáni sorok (0: a legrégebbitől), legfeljebb `limit` darab  a legfrissebbek. */
  since(after = 0, limit = 500): LogLine[] {
    const out = this.lines.filter((l) => l.seq > after);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  subscribe(fn: (l: LogLine) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get lastSeq(): number {
    return this.seq;
  }
}

/** A saját napló formátumának visszafejtése: `HH:MM:SS ! [tag] üzenet`. */
export function parseLogLine(text: string, fallback: LogLevel): { level: LogLevel; tag: string; msg: string } {
  const m = /^\d\d:\d\d:\d\d ([ !✖]) \[([^\]]{1,40})\] ([\s\S]*)$/.exec(text);
  if (!m) return { level: fallback, tag: "console", msg: text };
  return { level: m[1] === "!" ? "warn" : m[1] === "✖" ? "error" : "info", tag: m[2], msg: m[3] };
}
