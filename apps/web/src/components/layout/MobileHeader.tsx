import { motion, useReducedMotion } from "framer-motion";
import { Bell, Layers } from "lucide-react";
import type { ActiveTab } from "@/types";
import { useWeather } from "@/hooks/useWeather";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { LiveStatusCompact } from "./LiveStatus";
import { NAV_TABS, TabBadge, tabBadge, type TabCounts } from "./navTabs";
import { RefreshSweep } from "./RefreshSweep";
import { SettingsMenu } from "./SettingsMenu";
import { formatTemp } from "./WeatherReadout";
import { FOCUS_RING, ICON_BUTTON, WELL } from "./headerStyles";

interface MobileHeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  vehicleCount: number;
  lastUpdated: Date | null;
  isRefreshing: boolean;
  onManualRefresh: () => void;
  monitoredStopsCount: number;
  onOpenMapPicker: () => void;
  liveIncidentCount: number;
  onOpenNotifications: () => void;
  onOpenAccount: () => void;
}

const INDICATOR_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

/** Bal/jobb biztonsági sáv (fekvő iPhone notch) — legalább 8 px. */
const INSET_X =
  "pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]";

/**
 * Mobil fejléc (md alatt). Felül egy tömör sáv: márkajel, élő állapot,
 * ikongombok (44 px érintési felület). Alatta az öt nézet egyenlő szélességű
 * szegmensekben — nincs vízszintes görgetés, minden nézet egyszerre látszik.
 * A fiók a beállítások menüben érhető el, a kézi frissítés az állapot-panelen.
 */
export function MobileHeader({
  activeTab,
  setActiveTab,
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
  monitoredStopsCount,
  onOpenMapPicker,
  liveIncidentCount,
  onOpenNotifications,
  onOpenAccount,
}: MobileHeaderProps) {
  const weather = useWeather();

  return (
    <header className="pwa-inset-top relative z-bar shrink-0 border-b border-border bg-card md:hidden">
      <div className="relative flex h-12 items-center gap-1 pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))]">
        <BrandMark onSelect={() => setActiveTab("map")} isTouch />

        <LiveStatusCompact
          vehicleCount={vehicleCount}
          lastUpdated={lastUpdated}
          isRefreshing={isRefreshing}
          onManualRefresh={onManualRefresh}
          weather={weather}
        />

        <div className="ml-auto flex shrink-0 items-center">
          {weather?.tempC != null ? (
            <span
              className="mr-1 hidden font-mono text-xs font-semibold tabular-nums text-foreground min-[390px]:inline"
              aria-label={`Miskolc most ${formatTemp(weather.tempC)}, ${weather.text}`}
              role="img"
            >
              {Math.round(weather.tempC)}°
            </span>
          ) : null}
          {activeTab === "map" ? (
            <button
              type="button"
              onClick={onOpenMapPicker}
              aria-label="Alaptérkép választása"
              className={cn(ICON_BUTTON, FOCUS_RING, "h-11 w-11")}
            >
              <Layers aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onOpenNotifications}
            aria-label="Értesítések"
            className={cn(ICON_BUTTON, FOCUS_RING, "h-11 w-11")}
          >
            <Bell aria-hidden />
          </button>
          <SettingsMenu onOpenAccount={onOpenAccount} isTouch />
        </div>
      </div>

      <MobileNav
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        counts={{ monitoredStopsCount, liveIncidentCount }}
      />

      <RefreshSweep isRefreshing={isRefreshing} />
    </header>
  );
}

interface MobileNavProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  counts: TabCounts;
}

function MobileNav({ activeTab, setActiveTab, counts }: MobileNavProps) {
  const reduceMotion = useReducedMotion();

  return (
    <nav aria-label="Fő nézetek" className={cn("pb-2", INSET_X)}>
      <ul className={cn("grid grid-cols-5 gap-0.5 p-[3px]", WELL)}>
        {NAV_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const badge = tabBadge(tab.id, counts);
          const Icon = tab.icon;
          return (
            <li key={tab.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-11 w-full min-w-0 flex-col items-center justify-center gap-[3px] rounded-md transition-colors duration-fast",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  isActive
                    ? "text-primary-foreground"
                    : "text-muted-foreground active:bg-accent/70",
                )}
              >
                {isActive ? (
                  <motion.span
                    aria-hidden
                    layoutId="mobile-tab-indicator"
                    transition={reduceMotion ? { duration: 0 } : INDICATOR_SPRING}
                    className="absolute inset-0 rounded-md bg-primary shadow-[inset_0_1px_0_hsl(0_0%_100%/0.2),0_1px_2px_hsl(160_40%_2%/0.6)]"
                  />
                ) : null}
                <span className="sr-only">{tab.label}</span>
                <span className="relative flex">
                  <Icon aria-hidden className="h-[17px] w-[17px]" strokeWidth={isActive ? 2.25 : 2} />
                  {badge ? <TabBadge {...badge} isActive={isActive} placement="corner" /> : null}
                </span>
                <span
                  aria-hidden
                  className="relative max-w-full truncate text-[10px] font-semibold leading-[1.25] tracking-[-0.01em] min-[360px]:text-[10.5px]"
                >
                  {tab.short}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
