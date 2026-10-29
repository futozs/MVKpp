import {
  CalendarClock,
  ChartColumn,
  MapIcon,
  Radar,
  Route,
  type LucideIcon,
} from "lucide-react";
import type { ActiveTab } from "@/types";
import { cn } from "@/lib/utils";

export interface NavTab {
  id: ActiveTab;
  /** Teljes név — széles kijelzőn és a képernyőolvasónak. */
  label: string;
  /** Rövid név — keskenyebb fejlécben és mobilon. */
  short: string;
  icon: LucideIcon;
}

export const NAV_TABS: readonly NavTab[] = [
  { id: "map", label: "Forgalmi térkép", short: "Térkép", icon: MapIcon },
  { id: "multistop", label: "Megállófigyelő", short: "Figyelő", icon: Radar },
  { id: "timetable", label: "Menetrend", short: "Menetrend", icon: CalendarClock },
  { id: "planner", label: "Útvonaltervező", short: "Útvonal", icon: Route },
  { id: "stats", label: "Statisztika", short: "Statisztika", icon: ChartColumn },
];

export interface TabCounts {
  monitoredStopsCount: number;
  liveIncidentCount: number;
}

type BadgeKind = "monitored" | "incident";

/** Melyik fülön milyen számláló látszik (ha van mit mutatni). */
export function tabBadge(
  tab: ActiveTab,
  counts: TabCounts,
): { kind: BadgeKind; value: number } | null {
  if (tab === "multistop" && counts.monitoredStopsCount > 0) {
    return { kind: "monitored", value: counts.monitoredStopsCount };
  }
  if (tab === "stats" && counts.liveIncidentCount > 0) {
    return { kind: "incident", value: counts.liveIncidentCount };
  }
  return null;
}

const SR_TEXT: Record<BadgeKind, (n: number) => string> = {
  monitored: (n) => `, ${n} figyelt megálló`,
  incident: (n) => `, ${n} élő üzemzavar-jelzés`,
};

interface TabBadgeProps {
  kind: BadgeKind;
  value: number;
  isActive: boolean;
  /** `inline`: a felirat mellett (asztali), `corner`: az ikon sarkában (mobil). */
  placement: "inline" | "corner";
}

/**
 * Számláló a fülön. A szín jelentést hordoz: zöld a saját figyelés,
 * piros az élő üzemzavar — aktív fülön mindkettő a kitöltés színére vált.
 */
export function TabBadge({ kind, value, isActive, placement }: TabBadgeProps) {
  const isIncident = kind === "incident";
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "inline-flex items-center justify-center gap-1 rounded-[5px] font-mono font-bold tabular-nums leading-none",
          placement === "inline"
            ? "h-[18px] min-w-[18px] px-1 text-[10.5px]"
            : "absolute -right-2.5 -top-1.5 h-4 min-w-4 px-[3px] text-[9.5px] ring-2",
          placement === "inline" &&
            (isActive
              ? "bg-primary-foreground/15 text-primary-foreground"
              : isIncident
                ? "bg-late/15 text-late"
                : "bg-primary/15 text-primary"),
          placement === "corner" &&
            (isActive
              ? "bg-primary-foreground text-primary ring-primary"
              : isIncident
                ? "bg-late text-destructive-foreground ring-background"
                : "bg-primary text-primary-foreground ring-background"),
        )}
      >
        {isIncident && placement === "inline" ? (
          <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />
        ) : null}
        {value}
      </span>
      <span className="sr-only">{SR_TEXT[kind](value)}</span>
    </>
  );
}
