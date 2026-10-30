"use client";
/**
 * Élő naplók: a worker naplógyűrűje, a hub saját naplója és (Dockerben) minden
 * konténer kimenete. Szűrés szintre és szövegre, megállítás, letöltés.
 */
import { Download, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { clock } from "@/lib/format";
import { useHub } from "@/lib/hooks";
import type { LogLine } from "@/lib/types";
import { useSse } from "@/lib/useSse";
import { cn } from "@/lib/utils";
import { PageHeader } from "../shell/Shell";
import { Button, Input, Segmented, StatusDot } from "../ui/primitives";

const MAX_LINES = 5000;
type Level = "all" | "warn" | "error";

const LEVEL_CLASS: Record<LogLine["level"], string> = { info: "text-muted-foreground", warn: "text-nosignal", error: "text-late" };

export function LogsPage() {
  const { data } = useHub<{ sources: { id: string; label: string }[] }>("/api/logs/sources", 60_000);
  const [source, setSource] = useState("worker");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<Level>("all");
  const [q, setQ] = useState("");
  const buffer = useRef<LogLine[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setLines([]);
    buffer.current = [];
  }, [source]);

  const { connected, error } = useSse<LogLine>(`/api/logs/stream?source=${encodeURIComponent(source)}`, (l) => {
    buffer.current.push(l);
  });

  // A sorokat kötegekben tesszük ki (egy forgalmas napló ne rajzolja újra soronként az oldalt).
  useEffect(() => {
    const t = setInterval(() => {
      if (paused || !buffer.current.length) return;
      const add = buffer.current;
      buffer.current = [];
      setLines((prev) => {
        const next = [...prev, ...add];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }, 250);
    return () => clearInterval(t);
  }, [paused]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines.filter((l) => (level === "all" || (level === "warn" ? l.level !== "info" : l.level === "error")) && (!needle || `${l.tag} ${l.msg}`.toLowerCase().includes(needle)));
  }, [lines, level, q]);
  const counts = useMemo(() => ({ warn: lines.filter((l) => l.level === "warn").length, error: lines.filter((l) => l.level === "error").length }), [lines]);

  const download = () => {
    const text = shown.map((l) => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.tag}] ${l.msg}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `mvk-${source.replace(/\W+/g, "-")}-${Date.now()}.log` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader title="Naplók" lead="Minden konzolkimenet élőben. A worker a saját naplógyűrűjéből jön (mindig elérhető), a többi konténer a Dockerből." />
      <div className="flex h-[calc(100dvh-210px)] min-h-[420px] flex-col rounded-2xl border border-border bg-card shadow-xs">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="h-8 rounded-xl border border-border bg-background/60 px-2.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="naplóforrás"
          >
            {(data?.sources ?? [{ id: "worker", label: "worker (napló)" }]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <Segmented
            value={level}
            onChange={setLevel}
            options={[
              { value: "all", label: "mind" },
              { value: "warn", label: `figy. + hiba${counts.warn + counts.error ? ` (${counts.warn + counts.error})` : ""}` },
              { value: "error", label: `hiba${counts.error ? ` (${counts.error})` : ""}` },
            ]}
          />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="szűrés szövegre / címkére" className="h-8 w-56 text-xs" />
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={connected ? "ok" : "warn"} pulse={connected && !paused} />
            {connected ? (paused ? "megállítva" : "élő") : "kapcsolódás…"}
          </span>
          <Button size="sm" variant="ghost" icon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} onClick={() => setPaused((p) => !p)}>
            {paused ? "folytatás" : "megállítás"}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setLines([])} aria-label="képernyő törlése" />
          <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={download} aria-label="letöltés" />
        </div>
        {error ? <div className="border-b border-border px-3 py-1.5 text-xs text-nosignal">{error}</div> : null}
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
          className="min-h-0 flex-1 overflow-y-auto bg-[hsl(160_20%_3%)] px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
          role="log"
        >
          {shown.map((l) => (
            <div key={`${l.source}-${l.seq}-${l.ts}`} className={cn("flex gap-2 whitespace-pre-wrap break-words", LEVEL_CLASS[l.level])}>
              <span className="shrink-0 select-none text-muted-foreground/50">{clock(l.ts)}</span>
              <span className={cn("shrink-0", l.level === "info" ? "text-signal-600" : "")}>[{l.tag}]</span>
              <span className={cn("min-w-0", l.level === "info" && "text-foreground/85")}>{l.msg}</span>
            </div>
          ))}
          {!shown.length ? <div className="py-6 text-center text-muted-foreground/60">{lines.length ? "a szűrőnek nincs találata" : "várakozás a naplóra…"}</div> : null}
        </div>
      </div>
    </>
  );
}
