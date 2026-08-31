import { Layers, RefreshCw, Thermometer } from "lucide-react";
import type { ActiveTab } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LiveDot } from "@/components/transit/LiveDot";
import { useWeather } from "@/hooks/useWeather";
import { cn } from "@/lib/utils";

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  vehicleCount: number;
  lastUpdated: Date | null;
  isRefreshing: boolean;
  onManualRefresh: () => void;
  monitoredStopsCount: number;
  onOpenMapPicker: () => void;
  liveIncidentCount: number;
}

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "map", label: "Forgalmi térkép" },
  { id: "multistop", label: "Megállófigyelő" },
  { id: "timetable", label: "Menetrend" },
  { id: "stats", label: "Statisztika" },
];

export function Header({
  activeTab,
  setActiveTab,
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
  monitoredStopsCount,
  onOpenMapPicker,
  liveIncidentCount,
}: HeaderProps) {
  const weather = useWeather();

  return (
    <header className="relative z-bar hidden shrink-0 border-b border-border bg-card/80 backdrop-blur-xl md:block">
      <div className="flex h-14 items-center gap-2 px-2 sm:gap-3 sm:px-3 md:px-4">
        {}
        <nav
          aria-label="Fő nézetek"
          className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/60 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold transition-all duration-fast sm:gap-2 sm:px-3",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
                {tab.id === "stats" && liveIncidentCount > 0 ? (
                  <span
                    className={cn(
                      "flex items-center gap-1 rounded px-1 font-mono text-[10px] font-bold tabular-nums",
                      isActive
                        ? "bg-primary-foreground/20"
                        : "bg-late/15 text-late",
                    )}
                    title={`${liveIncidentCount} élő üzemzavar-jelzés`}
                  >
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                    {liveIncidentCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />

        {}
        <div className="hidden items-center gap-3 lg:flex">
          <Badge
            variant="outline"
            className="gap-1.5 border-primary/25 bg-primary/10 py-1 font-mono text-[11px] tabular-nums text-foreground"
          >
            <LiveDot />
            {vehicleCount} jármű
          </Badge>
          {lastUpdated ? (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {lastUpdated.toLocaleTimeString("hu-HU", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          ) : null}

          {}
          {weather?.tempC != null ? (
            <span
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title={`${weather.text}${weather.feelsLikeC != null ? ` · hőérzet ${Math.round(weather.feelsLikeC)} °C` : ""}`}
            >
              <Thermometer aria-hidden className="h-3.5 w-3.5 text-primary" />
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {Math.round(weather.tempC)} °C
              </span>
              <span className="hidden xl:inline">{weather.text}</span>
            </span>
          ) : null}
        </div>

        {}
        <div className="flex items-center gap-1">
          {activeTab === "map" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={onOpenMapPicker}>
                  <Layers />
                  <span className="hidden sm:inline">Alaptérkép</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Alaptérkép választása</TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={onManualRefresh}
                disabled={isRefreshing}
                aria-label="Járműpozíciók azonnali lekérése"
              >
                <RefreshCw
                  className={cn(isRefreshing && "animate-spin text-primary")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Azonnali frissítés</TooltipContent>
          </Tooltip>
        </div>
      </div>

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
