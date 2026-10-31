import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import type { RideStopTime } from "@mvk/core/rides";
import { cn } from "@/lib/utils";
import type { TripStop } from "./useTripLive";

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
const hm = (unix: number) => HM.format(new Date(unix * 1000));

/**
 * Megállólista a fel- vagy leszállás helyének kiválasztásához. Ahol a busz
 * már járt, a tényleges ideje látszik (felszállásnál az indulása, leszállásnál
 * az érkezése) — erről könnyebb felidézni, hol szálltál fel vagy le.
 */
export function StopChoiceList({
  stops,
  lo,
  hi,
  times,
  timeOf,
  selected,
  marks,
  onPick,
  className,
}: {
  stops: TripStop[];
  lo: number;
  hi: number;
  times: Map<number, RideStopTime>;
  timeOf: "dep" | "arr";
  selected: number | null;
  /** megjegyzés egy-egy megálló mellett (pl. „javasolt”, „felszállás”) */
  marks?: ReadonlyMap<number, string>;
  onPick: (idx: number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLOListElement>(null);
  // a kiválasztott (javasolt) megálló legyen szem előtt
  useEffect(() => {
    ref.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "center" });
  }, []);

  return (
    <ol ref={ref} className={cn("min-h-0 overflow-y-auto", className)}>
      {stops.slice(Math.max(0, lo), Math.max(lo, hi) + 1).map((s) => {
        const t = times.get(s.idx);
        const at = t ? (timeOf === "dep" ? (t.dep ?? t.arr) : t.arr) : null;
        const on = selected === s.idx;
        const mark = marks?.get(s.idx);
        return (
          <li key={s.idx}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onPick(s.idx)}
              className={cn(
                "grid w-full grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                on && "bg-primary/10 ring-1 ring-primary/45 hover:bg-primary/15",
              )}
            >
              <span className={cn("font-mono text-xs tabular-nums", at == null && "text-muted-foreground")}>{at != null ? hm(at) : s.schedTime}</span>
              <span className={cn("truncate text-[13px]", on ? "font-semibold" : "font-medium")}>{s.name}</span>
              <span className="flex items-center gap-1 text-[10.5px] font-semibold text-primary">
                {mark}
                {on ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
