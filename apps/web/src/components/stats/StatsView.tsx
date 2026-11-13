import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bus,
  Flame,
  MapPinned,
  Route as RouteIcon,
  Wrench,
  TrainFront,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { Route, Stop } from "@/types";
import { OverviewPanel } from "./OverviewPanel";
import { VehiclePanel } from "./VehiclePanel";
import { IncidentPanel } from "./IncidentPanel";
import { RoutePanel } from "./RoutePanel";
import { StopPanel } from "./StopPanel";
import { NetworkPanel } from "./NetworkPanel";
import { HeatPanel } from "./HeatPanel";
import { RegionalPanel } from "./RegionalPanel";
import { cn } from "@/lib/utils";
import { hasRegional, isRegionalId, useEnabledModes } from "@/lib/modes";

type PanelId =
  | "overview"
  | "vehicle"
  | "incident"
  | "route"
  | "stop"
  | "network"
  | "heat"
  | "regional";

const OVERVIEW_PANEL: { id: PanelId; label: string; short: string; icon: LucideIcon } = {
  id: "overview",
  label: "Áttekintés",
  short: "Áttek.",
  icon: Activity,
};

const PANELS: {
  id: PanelId;
  label: string;
  short: string;
  icon: LucideIcon;
}[] = [
  { id: "vehicle", label: "Járművek", short: "Járművek", icon: Bus },
  { id: "incident", label: "Üzemzavarok", short: "Zavarok", icon: Wrench },
  { id: "route", label: "Vonalak", short: "Vonalak", icon: RouteIcon },
  { id: "stop", label: "Megállók", short: "Megállók", icon: MapPinned },
  { id: "network", label: "Hálózat", short: "Hálózat", icon: TrendingUp },
  { id: "heat", label: "Hőtérkép", short: "Hőtérkép", icon: Flame },
];

/** a Volán és a vasút saját panele  csak ha legalább az egyik be van kapcsolva */
const REGIONAL_PANEL = { id: "regional" as PanelId, label: "Vasút és Volán", short: "Vasút", icon: TrainFront };

export function StatsView({
  stops,
  routes,
  onFocusVehicle,
  onOpenDisruptions,
  liveIncidents = 0,
}: {
  stops: Stop[];
  routes: Route[];
  onFocusVehicle?: (vehicleId: string) => void;
  /** a Menetrend „Mai zavarok” ablaka */
  onOpenDisruptions?: () => void;
  /** van élő zavar (piros jelvény) → az Üzemzavarok nyíljon meg elsőként */
  liveIncidents?: number;
}) {
  const [panel, setPanel] = useState<PanelId>(() => (liveIncidents ? "incident" : "vehicle"));
  const navRef = useRef<HTMLUListElement>(null);
  const modes = useEnabledModes();
  const regional = hasRegional(modes);
  const panels = regional ? [...PANELS, REGIONAL_PANEL] : PANELS;
  // az üzemzavar és a hőtérkép az MVK hálózatáé (a regionálisra nincs ilyen mérés)
  const mvkRoutes = useMemo(() => routes.filter((r) => !isRegionalId(r.id)), [routes]);
  // a kikapcsolt regionális módnál ne maradjon a panelen
  useEffect(() => {
    if (!regional && panel === "regional") setPanel("vehicle");
  }, [regional, panel]);

  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [panel]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <nav
        aria-label="Statisztikai nézetek"
        className="flex shrink-0 items-stretch gap-1 border-b border-border bg-background/85 px-3 backdrop-blur-sm sm:px-4"
      >
        <ul
          ref={navRef}
          className={cn(
            "flex min-w-0 flex-1 gap-1 overflow-x-auto py-2",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)] sm:[mask-image:none]",
          )}
        >
          {panels.map((p) => {
            const Icon = p.icon;
            const active = panel === p.id;
            return (
              <li key={p.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setPanel(p.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">{p.label}</span>
                  <span className="sm:hidden">{p.short}</span>
                </button>
              </li>
            );
          })}
        </ul>

          <button
          type="button"
          onClick={() => setPanel("overview")}
          aria-current={panel === "overview" ? "page" : undefined}
          title="Áttekintés: rendszám-jóslás pontossága és adatraktár"
          className={cn(
            "flex shrink-0 items-center gap-1.5 self-center whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            panel === "overview"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <OVERVIEW_PANEL.icon className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden md:inline">{OVERVIEW_PANEL.label}</span>
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1600px] space-y-4 px-3 py-3 sm:px-4 sm:py-4 lg:px-6 lg:py-6">
          {panel === "overview" && (
            <OverviewPanel onJumpToVehicles={() => setPanel("vehicle")} />
          )}
          {panel === "vehicle" && (
            <VehiclePanel onFocusVehicle={onFocusVehicle} routes={routes} />
          )}
          {panel === "incident" && <IncidentPanel routes={mvkRoutes} onOpenDisruptions={onOpenDisruptions} />}
          {panel === "route" && <RoutePanel routes={routes} />}
          {panel === "stop" && <StopPanel stops={stops} />}
          {panel === "network" && <NetworkPanel />}
          {panel === "heat" && <HeatPanel routes={mvkRoutes} />}
          {panel === "regional" && regional && <RegionalPanel modes={modes} />}
        </div>
      </div>
    </div>
  );
}
