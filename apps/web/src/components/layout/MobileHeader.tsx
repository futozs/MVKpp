import { motion, useReducedMotion } from "framer-motion";
import { Bell } from "lucide-react";
import type { ActiveTab } from "@/types";
import { useWeather } from "@/hooks/useWeather";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { LiveStatusCompact } from "./LiveStatus";
import { NAV_TABS, TabBadge, tabBadge, type TabCounts } from "./navTabs";
import { useTabBadges } from "@/lib/watchPrefs";
import { RefreshSweep } from "./RefreshSweep";
import { SettingsMenu } from "./SettingsMenu";
import { formatTemp } from "./WeatherReadout";
import { FOCUS_RING, ICON_BUTTON } from "./headerStyles";

interface MobileHeaderProps {
  setActiveTab: (tab: ActiveTab) => void;
  vehicleCount: number;
  lastUpdated: Date | null;
  isRefreshing: boolean;
  onManualRefresh: () => void;
  onOpenNotifications: () => void;
  onOpenAccount: () => void;
}

const INDICATOR_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

/** Bal/jobb biztonsági sáv (fekvő iPhone notch)  legalább 8 px. */
const INSET_X =
  "pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]";

/**
 * Mobil fejléc (md alatt): egy tömör sáv márkajellel, élő állapottal és
 * ikongombokkal (44 px érintési felület). A nézetek a képernyő alján, a
 * hüvelykujj alatt vannak (MobileTabBar). A fiók a beállítások menüben érhető
 * el, a kézi frissítés az állapot-panelen.
 */
export function MobileHeader({
  setActiveTab,
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
  onOpenNotifications,
  onOpenAccount,
}: MobileHeaderProps) {
  const weather = useWeather();

  return (
    <header className="pwa-inset-top relative z-header shrink-0 border-b border-border bg-card md:hidden">
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

      <RefreshSweep isRefreshing={isRefreshing} />
    </header>
  );
}

interface MobileTabBarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  counts: TabCounts;
}

/** A nézetek mobilon: alsó sáv, hat egyenlő oszlop, az aktív ikon mögött egy halvány pirula. */
export function MobileTabBar({ activeTab, setActiveTab, counts }: MobileTabBarProps) {
  // a számlálók a Beállításokban kikapcsolhatók
  const showBadges = useTabBadges();
  const reduceMotion = useReducedMotion();

  return (
    <nav
      aria-label="Fő nézetek"
      className={cn("shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden", INSET_X)}
    >
      <ul className="grid grid-cols-6">
        {NAV_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const badge = showBadges ? tabBadge(tab.id, counts) : null;
          const Icon = tab.icon;
          return (
            <li key={tab.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group flex h-14 w-full min-w-0 flex-col items-center justify-center gap-1 transition-colors duration-fast",
                  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="relative flex h-7 w-12 items-center justify-center">
                  {isActive ? (
                    <motion.span
                      aria-hidden
                      layoutId="mobile-tab-indicator"
                      transition={reduceMotion ? { duration: 0 } : INDICATOR_SPRING}
                      className="absolute inset-0 rounded-full bg-primary/20"
                    />
                  ) : (
                    <span aria-hidden className="absolute inset-0 rounded-full bg-accent opacity-0 transition-opacity duration-fast group-active:opacity-100" />
                  )}
                  <span className="sr-only">{tab.label}</span>
                  <span className="relative flex">
                    <Icon aria-hidden className={cn("h-5 w-5", isActive && "text-primary")} strokeWidth={isActive ? 2.25 : 1.85} />
                    {badge ? <TabBadge {...badge} isActive={false} placement="corner" /> : null}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "max-w-full truncate text-[10.5px] leading-none tracking-[-0.01em]",
                    isActive ? "font-semibold" : "font-medium",
                  )}
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
