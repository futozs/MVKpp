"use client";
/** Egy hosszú művelet (telepítés, mentés, visszaállítás) élő kimenete, terminál-szerűen. */
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clock } from "@/lib/format";
import type { TaskInfo, TaskLine } from "@/lib/types";
import { useSse } from "@/lib/useSse";
import { cn } from "@/lib/utils";

export function TaskConsole({ taskId, onDone, className }: { taskId: string; onDone?: (info: TaskInfo) => void; className?: string }) {
  const [lines, setLines] = useState<TaskLine[]>([]);
  const [done, setDone] = useState<TaskInfo | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setLines([]);
    setDone(null);
  }, [taskId]);

  const { error } = useSse<TaskLine>(
    done ? null : `/api/tasks/${taskId}/stream`,
    (l) => setLines((prev) => (prev.length > 6000 ? [...prev.slice(-5000), l] : [...prev, l])),
    (info) => {
      setDone(info as TaskInfo);
      onDone?.(info as TaskInfo);
    },
  );

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-[hsl(160_20%_3%)]", className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        {done ? done.ok ? <CheckCircle2 className="h-4 w-4 text-live" /> : <XCircle className="h-4 w-4 text-late" /> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="font-semibold">{done ? (done.ok ? "kész" : "hibával állt le") : "fut…"}</span>
        {done?.error ? <span className="truncate text-late">{done.error}</span> : null}
        {error ? <span className="truncate text-nosignal">{error}</span> : null}
        <span className="ml-auto font-mono text-muted-foreground">{lines.length} sor</span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[420px] min-h-[160px] overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed"
        role="log"
        aria-live="polite"
      >
        {lines.map((l, i) => (
          <div key={i} className={cn("whitespace-pre-wrap break-words", l.level === "error" ? "text-late" : l.level === "step" ? "mt-1 font-semibold text-primary" : "text-muted-foreground")}>
            <span className="mr-2 select-none text-muted-foreground/50">{clock(l.at)}</span>
            {l.text}
          </div>
        ))}
        {!lines.length ? <div className="text-muted-foreground/60">várakozás a kimenetre…</div> : null}
      </div>
    </div>
  );
}
