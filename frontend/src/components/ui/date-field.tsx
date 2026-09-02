import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Saját dátum-választó a natív <input type="date"> helyett. iOS Safariban a
 * natív naptár egy le nem stílozható, mindig világos rendszer-sheet — ez
 * sötét témában minden telefonon rendszeridegennek hat, asztali böngészőben
 * viszont a lapba illeszkedik, ezért ez korábban csak mobilon (főleg
 * iPhone-on) tűnt fel hibaként. Ez a komponens ugyanazt a megjelenést adja
 * minden platformon.
 */

const WEEKDAY_LABELS = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
const MONTH_LABELS = [
  "január",
  "február",
  "március",
  "április",
  "május",
  "június",
  "július",
  "augusztus",
  "szeptember",
  "október",
  "november",
  "december",
];

function parseIso(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split("-").map(Number);
  return { y, m: (m || 1) - 1, d: d || 1 };
}

function toIso(y: number, m: number, d: number): string {
  const dt = new Date(y, m, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function todayIso(): string {
  const d = new Date();
  return toIso(d.getFullYear(), d.getMonth(), d.getDate());
}

function buildMonthGrid(y: number, m: number): (number | null)[] {
  const first = new Date(y, m, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // hétfővel kezdve
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstWeekday).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  min?: string | null;
  max?: string | null;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function DateField({
  value,
  onChange,
  min,
  max,
  id,
  className,
  ...aria
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const fieldId = id ?? reactId;

  const safeValue = value || todayIso();
  const { y, m } = parseIso(safeValue);
  const [viewY, setViewY] = useState(y);
  const [viewM, setViewM] = useState(m);

  useEffect(() => {
    if (!open) return;
    const { y: cy, m: cm } = parseIso(safeValue);
    setViewY(cy);
    setViewM(cm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const shiftMonth = (delta: number) => {
    let ny = viewY;
    let nm = viewM + delta;
    if (nm < 0) {
      nm = 11;
      ny -= 1;
    } else if (nm > 11) {
      nm = 0;
      ny += 1;
    }
    setViewY(ny);
    setViewM(nm);
  };

  const cells = buildMonthGrid(viewY, viewM);
  const label = new Date(`${safeValue}T12:00:00`).toLocaleDateString("hu-HU", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

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
          "flex h-9 items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm font-semibold tabular-nums text-foreground shadow-sm transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <CalendarDays aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {label}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Dátum választása"
          className="absolute left-0 top-[calc(100%+0.375rem)] z-50 w-64 rounded-lg border border-border bg-card p-2.5 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label="Előző hónap"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-xs font-semibold capitalize">
              {MONTH_LABELS[viewM]} {viewY}
            </p>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label="Következő hónap"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-semibold uppercase text-muted-foreground">
            {WEEKDAY_LABELS.map((w) => (
              <span key={w} className="py-1">
                {w}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (d == null) return <span key={i} />;
              const iso = toIso(viewY, viewM, d);
              const disabled = Boolean((min && iso < min) || (max && iso > max));
              const selected = iso === safeValue;
              const isToday = iso === todayIso();
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex h-7 w-full items-center justify-center rounded-md text-xs tabular-nums transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-30",
                    selected
                      ? "bg-primary font-bold text-primary-foreground hover:bg-primary"
                      : isToday
                        ? "font-bold text-primary"
                        : "text-foreground",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(todayIso());
              setOpen(false);
            }}
            className="mt-2 w-full rounded-md py-1 text-center text-[11px] font-semibold text-primary transition-colors hover:bg-accent"
          >
            Ma
          </button>
        </div>
      ) : null}
    </div>
  );
}
