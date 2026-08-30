import { ExternalLink, Layers, LayoutDashboard, RefreshCw } from "lucide-react";
import type { ActiveTab } from "@/types";
import { Button } from "@/components/ui/button";
import { LiveDot } from "@/components/transit/LiveDot";
import { useWeather } from "@/hooks/useWeather";
import { hubUrl } from "@/lib/links";
import { cn } from "@/lib/utils";

interface MobileHeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  vehicleCount: number;
  lastUpdated: Date | null;
  isRefreshing: boolean;
  onManualRefresh: () => void;
  monitoredStopsCount: number;
  onOpenMapPicker: () => void;
}

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "map", label: "Térkép" },
  { id: "multistop", label: "Figyelő" },
  { id: "timetable", label: "Menetrend" },
  { id: "stats", label: "Statisztika" },
];

export function MobileHeader({
  activeTab,
  setActiveTab,
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
  monitoredStopsCount,
  onOpenMapPicker,
}: MobileHeaderProps) {
  const weather = useWeather();

  return (
    <header className="relative z-bar shrink-0 border-b border-border bg-card md:hidden">
      {}
      <div className="flex h-12 items-center gap-2 px-2">
        <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-2 py-1">
          <LiveDot />
          <span className="font-mono text-xs font-bold tabular-nums">
            {vehicleCount}
          </span>
          <span className="text-[11px] text-muted-foreground">jármű</span>
        </span>

        {lastUpdated ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {lastUpdated.toLocaleTimeString("hu-HU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : null}

        {}
        {weather?.tempC != null ? (
          <span
            className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-foreground"
            title={weather.text}
          >
            {Math.round(weather.tempC)}°
          </span>
        ) : null}

        <span className="flex-1" />

        {activeTab === "map" ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={onOpenMapPicker}
            aria-label="Alaptérkép választása"
          >
            <Layers />
          </Button>
        ) : null}

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          asChild
        >
          <a
            href={hubUrl()}
            target="_blank"
            rel="noreferrer"
            aria-label="Rendszerpult megnyitása"
          >
            <LayoutDashboard />
            <ExternalLink className="sr-only" />
          </a>
        </Button>

        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={onManualRefresh}
          disabled={isRefreshing}
          aria-label="Járműpozíciók azonnali lekérése"
        >
          <RefreshCw
            className={cn(isRefreshing && "animate-spin text-primary")}
          />
        </Button>
      </div>

      {}
      <nav
        aria-label="Fő nézetek"
        className="grid grid-cols-3 gap-1 border-t border-border p-1.5"
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition-all duration-fast",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/60 text-muted-foreground active:bg-accent",
              )}
            >
              {tab.label}
              {tab.id === "multistop" && monitoredStopsCount > 0 ? (
                <span
                  className={cn(
                    "rounded px-1 font-mono text-[10px] font-bold tabular-nums",
                    isActive
                      ? "bg-primary-foreground/20"
                      : "bg-primary/15 text-primary",
                  )}
                >
                  {monitoredStopsCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {}
      <div
        aria-hidden
        className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
      >
        {isRefreshing ? (
          <span className="block h-full w-1/4 animate-tick-sweep rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
        ) : null}
      </div>
    </header>
  );
}
