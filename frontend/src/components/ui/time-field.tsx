import { useEffect, useId, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Saját idő-választó a natív <input type="time"> helyett. iOS Safariban a
 * natív óra-választó egy le nem stílozható, mindig világos rendszer-sheet —
 * ez sötét témában minden telefonon rendszeridegennek hat. Ez a komponens
 * ugyanazt a megjelenést adja minden platformon.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

function parseTime(value: string): { h: number; m: number } {
  const [h, m] = value.split(":").map(Number);
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");

interface TimeFieldProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function TimeField({
  value,
  onChange,
  id,
  className,
  ...aria
}: TimeFieldProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hourListRef = useRef<HTMLDivElement>(null);
  const minuteListRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const fieldId = id ?? reactId;
  const { h, m } = parseTime(value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    hourListRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "center" });
    minuteListRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "center" });
  }, [open]);

  const setH = (nh: number) => onChange(`${pad(nh)}:${pad(m)}`);
  const setM = (nm: number) => onChange(`${pad(h)}:${pad(nm)}`);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={fieldId}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...aria}
        className={cn(
          "flex h-9 w-full items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm font-semibold tabular-nums text-foreground shadow-sm transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <Clock aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {pad(h)}:{pad(m)}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Időpont választása"
          className="absolute left-0 top-[calc(100%+0.375rem)] z-50 flex overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        >
          <div ref={hourListRef} className="max-h-48 w-14 overflow-y-auto border-r border-border py-1">
            {HOURS.map((hh) => (
              <button
                key={hh}
                type="button"
                data-selected={hh === h}
                onClick={() => setH(hh)}
                className={cn(
                  "block w-full px-3 py-1.5 text-center text-sm tabular-nums transition-colors hover:bg-accent",
                  hh === h
                    ? "bg-primary/10 font-bold text-primary"
                    : "text-foreground",
                )}
              >
                {pad(hh)}
              </button>
            ))}
          </div>
          <div ref={minuteListRef} className="max-h-48 w-14 overflow-y-auto py-1">
            {MINUTES.map((mm) => (
              <button
                key={mm}
                type="button"
                data-selected={mm === m}
                onClick={() => {
                  setM(mm);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full px-3 py-1.5 text-center text-sm tabular-nums transition-colors hover:bg-accent",
                  mm === m
                    ? "bg-primary/10 font-bold text-primary"
                    : "text-foreground",
                )}
              >
                {pad(mm)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
