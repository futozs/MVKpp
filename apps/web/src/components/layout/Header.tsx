import { motion, useReducedMotion } from "framer-motion";
import { Bell, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type { ActiveTab } from "@/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWeather } from "@/hooks/useWeather";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { LiveStatus } from "./LiveStatus";
import { NAV_TABS, TabBadge, tabBadge, type TabCounts } from "./navTabs";
import { SettingsMenu } from "./SettingsMenu";
import { RefreshSweep } from "./RefreshSweep";
import { WeatherReadout } from "./WeatherReadout";
import { FOCUS_RING, ICON_BUTTON, WELL } from "./headerStyles";

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  vehicleCount: number;
  lastUpdated: Date | null;
  isRefreshing: boolean;
  onManualRefresh: () => void;
  monitoredStopsCount: number;
  liveIncidentCount: number;
  onOpenNotifications: () => void;
  onOpenAccount: () => void;
}

const INDICATOR_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

/**
 * Asztali fejléc (md+). Bal: márkajel és a fő nézetek szegmentált sávja.
 * Jobb: az élő adat állapota (a frissítéssel együtt), az időjárás, majd a
 * személyes vezérlők. Minden vezérlő 36 px magas, így egy vonalban ülnek.
 */
export function Header({
  activeTab,
  setActiveTab,
  vehicleCount,
  lastUpdated,
  isRefreshing,
  onManualRefresh,
  monitoredStopsCount,
  liveIncidentCount,
  onOpenNotifications,
  onOpenAccount,
}: HeaderProps) {
  const weather = useWeather();

  return (
    <header className="relative z-bar hidden shrink-0 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:block">
      <div className="flex h-14 items-center gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <BrandMark onSelect={() => setActiveTab("map")} labelClassName="hidden xl:flex" />
        <span aria-hidden className="ml-1 mr-1 hidden h-6 w-px shrink-0 bg-border lg:block" />

        <DesktopNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          counts={{ monitoredStopsCount, liveIncidentCount }}
        />

        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 lg:gap-2">
          <LiveStatus
            vehicleCount={vehicleCount}
            lastUpdated={lastUpdated}
            isRefreshing={isRefreshing}
            onManualRefresh={onManualRefresh}
          />
          <WeatherReadout
            weather={weather}
            className="hidden xl:flex"
            textClassName="hidden min-[1680px]:inline"
          />

          <span aria-hidden className="mx-1 hidden h-6 w-px shrink-0 bg-border lg:block" />

          <div className="flex items-center gap-0.5">
            <HeaderAction label="Értesítések" onClick={onOpenNotifications}>
              <Bell aria-hidden />
            </HeaderAction>
            <HeaderAction
              label="Fiók és felhős mentés"
              onClick={onOpenAccount}
              className="hidden xl:inline-flex"
            >
              <UserRound aria-hidden />
            </HeaderAction>
            <SettingsMenu onOpenAccount={onOpenAccount} accountItemClassName="xl:hidden" />
          </div>
        </div>
      </div>

      <RefreshSweep isRefreshing={isRefreshing} />
    </header>
  );
}

interface DesktopNavProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  counts: TabCounts;
}

function DesktopNav({ activeTab, setActiveTab, counts }: DesktopNavProps) {
  const reduceMotion = useReducedMotion();

  return (
    <nav
      aria-label="Fő nézetek"
      className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <ul className={cn("flex h-9 w-max items-center gap-0.5 p-[3px]", WELL)}>
        {NAV_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const badge = tabBadge(tab.id, counts);
          const hasShortLabel = tab.short !== tab.label;
          return (
            <li key={tab.id} className="h-full">
              <button
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-full items-center gap-1.5 whitespace-nowrap rounded-md px-[7px] text-xs font-semibold transition-colors duration-fast lg:px-3 lg:text-[13px]",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  isActive
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {isActive ? (
                  <motion.span
                    aria-hidden
                    layoutId="header-tab-indicator"
                    transition={reduceMotion ? { duration: 0 } : INDICATOR_SPRING}
                    className="absolute inset-0 rounded-md bg-primary shadow-[inset_0_1px_0_hsl(0_0%_100%/0.2),0_1px_2px_hsl(160_40%_2%/0.6)]"
                  />
                ) : null}
                {hasShortLabel ? (
                  <>
                    <span aria-hidden className="relative 2xl:hidden">
                      {tab.short}
                    </span>
                    {/* Képernyőolvasó mindig a teljes nevet hallja; 2xl-en látszik is. */}
                    <span className="sr-only 2xl:not-sr-only 2xl:relative">{tab.label}</span>
                  </>
                ) : (
                  <span className="relative">{tab.label}</span>
                )}
                {badge ? (
                  <span className="relative flex">
                    <TabBadge {...badge} isActive={isActive} placement="inline" />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface HeaderActionProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  /** Ikon mellett szöveg is lehet (szélesebb gomb). */
  hasText?: boolean;
  className?: string;
}

function HeaderAction({ label, onClick, children, hasText, className }: HeaderActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            ICON_BUTTON,
            FOCUS_RING,
            "h-9",
            hasText ? "min-w-9 gap-2 px-2 text-xs font-semibold 2xl:px-2.5" : "w-9",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
