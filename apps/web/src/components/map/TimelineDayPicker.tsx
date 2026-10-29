import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { addDays, formatDayLabel } from "./historyTime";

interface TimelineDayPickerProps {
  /** A választható napok, a legújabbal kezdve. */
  days: string[];
  value: string;
  today: string;
  compact: boolean;
  onChange: (day: string) => void;
}

function relativeHint(day: string, today: string): string | null {
  if (day === today) return "ma";
  if (day === addDays(today, -1)) return "tegnap";
  return null;
}

/**
 * Napválasztó csak a rögzített GPS-napokkal. A sáv a képernyő alján ül,
 * ezért a lista fölfelé nyílik.
 */
export function TimelineDayPicker({
  days,
  value,
  today,
  compact,
  onChange,
}: TimelineDayPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const index = days.indexOf(value);
  const older = index >= 0 && index < days.length - 1 ? days[index + 1] : null;
  const newer = index > 0 ? days[index - 1] : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    listRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView({ block: "nearest" });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const stepButton = (target: string | null, label: string, icon: ReactNode) => (
    <button
      type="button"
      disabled={!target}
      onClick={() => target && onChange(target)}
      aria-label={label}
      className={cn(
        "flex w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-fast",
        "hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {icon}
    </button>
  );

  return (
    <div ref={rootRef} className={cn("relative", compact ? "min-w-0 flex-1" : "shrink-0")}>
      <div
        className={cn(
          "flex items-stretch overflow-hidden rounded-lg border border-border bg-background/60",
          compact ? "h-11" : "h-9",
        )}
      >
        {compact ? null : stepButton(older, "Előző nap", <ChevronLeft className="h-4 w-4" />)}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Nap: ${formatDayLabel(value)}`}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm font-semibold transition-colors duration-fast",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            !compact && "border-x border-border",
          )}
        >
          {compact ? null : (
            <CalendarDays aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{formatDayLabel(value, compact)}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-fast",
              open && "rotate-180",
            )}
          />
        </button>
        {compact ? null : stepButton(newer, "Következő nap", <ChevronRight className="h-4 w-4" />)}
      </div>

      {open ? (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Rögzített napok"
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-10 max-h-72 w-full min-w-[220px] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
        >
          {days.map((day) => {
            const selected = day === value;
            const hint = relativeHint(day, today);
            return (
              <li key={day} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(day);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors duration-fast",
                    compact ? "h-11" : "h-9",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    selected
                      ? "bg-primary/15 font-semibold text-primary"
                      : "text-foreground hover:bg-accent",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{formatDayLabel(day)}</span>
                  {hint ? (
                    <span className="text-[11px] font-medium text-muted-foreground">{hint}</span>
                  ) : null}
                  {selected ? <Check aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
