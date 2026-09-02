import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bus,
  MapPinned,
  Route as RouteIcon,
  Wrench,
  TrendingUp,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { Route, Stop } from "@/types";
import { OverviewPanel } from "./OverviewPanel";
import { VehiclePanel } from "./VehiclePanel";
import { IncidentPanel } from "./IncidentPanel";
import { RoutePanel } from "./RoutePanel";
import { StopPanel } from "./StopPanel";
import { NetworkPanel } from "./NetworkPanel";
import { PredictionPanel } from "./PredictionPanel";
import { cn } from "@/lib/utils";

type PanelId =
  | "overview"
  | "vehicle"
  | "incident"
  | "route"
  | "stop"
  | "network"
  | "prediction";

const OVERVIEW_PANEL: { id: PanelId; label: string; short: string; icon: LucideIcon } = {
  id: "overview",
  label: "Áttekintés",
  short: "Áttek.",
  icon: Activity,
};

// Az „Áttekintés” alapból nincs kitéve a fülsorra — összefoglaló nézet, ami
// leginkább csak első pillantásra kell, a többi fül a napi munkára való. Az
// OVERVIEW_PANEL-en keresztül külön gombbal továbbra is elérhető.
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
  {
    id: "prediction",
    label: "Előrejelzés",
    short: "Jóslat",
    icon: Sparkles,
  },
];

export function StatsView({
  stops,
  routes,
  onFocusVehicle,
}: {
  stops: Stop[];
  routes: Route[];
  onFocusVehicle?: (vehicleId: string) => void;
}) {
  const [panel, setPanel] = useState<PanelId>("vehicle");
  const navRef = useRef<HTMLUListElement>(null);

  // A fülsor telefonon oldalra görgethető — a kiválasztott fül különben
  // kicsúszhat a képből, és nem látszik, hol tartunk.
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [panel]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      {}
      <nav
        aria-label="Statisztikai nézetek"
        className="flex shrink-0 items-stretch gap-1 border-b border-border bg-background/85 px-3 backdrop-blur-sm sm:px-4"
      >
        <ul
          ref={navRef}
          className={cn(
            "flex min-w-0 flex-1 gap-1 overflow-x-auto py-2",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {PANELS.map((p) => {
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

        {}
        <button
          type="button"
          onClick={() => setPanel("overview")}
          aria-current={panel === "overview" ? "page" : undefined}
          title="Áttekintés (összefoglaló nézet)"
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
            <VehiclePanel onFocusVehicle={onFocusVehicle} />
          )}
          {panel === "incident" && <IncidentPanel />}
          {panel === "route" && <RoutePanel routes={routes} />}
          {panel === "stop" && <StopPanel stops={stops} />}
          {panel === "network" && <NetworkPanel />}
          {panel === "prediction" && <PredictionPanel />}
        </div>
      </div>
    </div>
  );
}
