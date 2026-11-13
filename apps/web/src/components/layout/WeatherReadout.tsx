import { Thermometer } from "lucide-react";
import type { WeatherResponse } from "@/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./headerStyles";

export function formatTemp(c: number): string {
  return `${Math.round(c)} °C`;
}

/** „hőérzet 16 °C · szél 12 km/h”  üres, ha egyik sem ismert. */
export function weatherExtras(w: WeatherResponse): string {
  const parts: string[] = [];
  if (w.feelsLikeC != null) parts.push(`hőérzet ${formatTemp(w.feelsLikeC)}`);
  if (w.windKmh != null) parts.push(`szél ${Math.round(w.windKmh)} km/h`);
  return parts.join(" · ");
}

/** „Részben felhős · hőérzet 16 °C · szél 12 km/h” */
export function describeWeather(w: WeatherResponse): string {
  return [w.text, weatherExtras(w)].filter(Boolean).join(" · ");
}

interface WeatherReadoutProps {
  weather: WeatherResponse | null;
  /** A szöveges leírás láthatósága (pl. csak nagyon széles kijelzőn). */
  textClassName?: string;
  className?: string;
}

/** Csendes, keret nélküli kiírás: a hőmérséklet a hír, a leírás kiegészítés. */
export function WeatherReadout({ weather, textClassName, className }: WeatherReadoutProps) {
  if (weather?.tempC == null) return null;
  const description = describeWeather(weather);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`Miskolc most ${formatTemp(weather.tempC)}, ${description}`}
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground",
            FOCUS_RING,
            className,
          )}
        >
          <Thermometer aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {formatTemp(weather.tempC)}
          </span>
          <span className={cn("max-w-[9rem] truncate", textClassName ?? "hidden")}>
            {weather.text}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="border border-border bg-popover text-popover-foreground shadow-lg">
        Miskolc · {description}
      </TooltipContent>
    </Tooltip>
  );
}
