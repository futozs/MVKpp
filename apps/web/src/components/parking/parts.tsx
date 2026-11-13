import { Star } from "lucide-react";
import type { Route } from "@/types";
import type { TripTip } from "@/services/parkingApi";
import { isRegionalId } from "@/lib/modes";
import { cn } from "@/lib/utils";
import { durationText, hmOfDaySec, pct, untilStart, untilText } from "./format";

export type RouteLookup = (short: string | null) => Route | undefined;

const FALLBACK = { color: "3A4A44", text: "FFFFFF" };
const hex = (v: string | undefined, fb: string) => `#${/^[0-9a-fA-F]{6}$/.test(v ?? "") ? v : fb}`;

/** A vonal színes csempéje  ugyanaz a forma, mint a térképen. */
export function RouteChip({
  route,
  lookup,
  className,
}: {
  route: string | null;
  lookup: RouteLookup;
  className?: string;
}) {
  if (!route) return null;
  const r = lookup(route);
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[26px] shrink-0 items-center justify-center whitespace-nowrap rounded-[5px] px-1 font-mono text-[11px] font-bold leading-none tabular-nums",
        className,
      )}
      style={{ background: hex(r?.color, FALLBACK.color), color: hex(r?.text, FALLBACK.text) }}
    >
      {route}
    </span>
  );
}

/** Élő jel: lüktető zöld pont; néma: üres karika. */
export function SignalDot({ online, className }: { online: boolean; className?: string }) {
  return online ? (
    <span className={cn("relative flex h-2 w-2", className)} title="Élő GPS-jel">
      <span className="absolute inline-flex h-full w-full rounded-full bg-live/60 motion-safe:animate-ping" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-live" />
    </span>
  ) : (
    <span className={cn("h-2 w-2 rounded-full border border-muted-foreground/60", className)} title="Nincs élő jel" />
  );
}

/**
 * Következő indulás. Szaggatott keret = előrejelzés (mint a megállófigyelőben),
 * teli = az MVK már kiadta neki a menetet.
 */
export function TipChip({
  tip,
  lookup,
  midnight,
  now,
  variant = "full",
}: {
  tip: TripTip;
  lookup: RouteLookup;
  midnight: number;
  now: number;
  /** full: nyíllal, hosszú visszaszámlálással · tile: csempébe · stall: csak vonal és idő */
  variant?: "full" | "tile" | "stall";
}) {
  const until = untilStart(tip, midnight, now);
  const extra =
    variant === "stall" ? null : !tip.certain ? pct(tip.confidence) : variant === "full" ? untilText(until) : until < 60 ? "most" : durationText(until);
  const title = tip.certain
    ? `${isRegionalId(tip.tripId) ? "A MÁV" : "Az MVK"} már kiadta neki: ${tip.route} ${hmOfDaySec(tip.startS)}`
    : `Előrejelzés a korábbi fordák alapján, ${pct(tip.confidence)} bizonyossággal`;
  return (
    <span
      title={title}
      className={cn(
        "flex min-w-0 items-center rounded-md px-1.5 py-1 text-[11px] leading-none",
        variant === "full" ? "gap-1.5" : "gap-1",
        tip.certain ? "border border-primary/50 bg-primary/10 text-foreground" : "border border-dashed border-primary/45 text-foreground/90",
      )}
    >
      {variant === "full" ? (
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
      ) : null}
      <RouteChip route={tip.route} lookup={lookup} className="h-4 min-w-[22px] text-[10px]" />
      <span className="font-mono font-semibold tabular-nums">{hmOfDaySec(tip.startS)}</span>
      {extra ? <span className="ml-auto truncate pl-0.5 text-muted-foreground">{extra}</span> : null}
    </span>
  );
}

/** Kedvenc parkoló kapcsoló (a kedvencek elöl állnak, és a felhőbe is mentődnek). */
export function FavoriteButton({ active, name, onToggle }: { active: boolean; name: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={active ? `${name}: levétel a kedvencekről` : `${name}: kedvenc parkoló`}
      title={active ? "Levétel a kedvencekről" : "Kedvenc  mindig elöl lesz"}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "text-primary hover:bg-primary/10" : "text-muted-foreground/60 hover:bg-accent hover:text-foreground",
      )}
    >
      <Star className={cn("h-4 w-4", active && "fill-current")} />
    </button>
  );
}

/** Az utolsó 14 nap: kint volt-e (teli) vagy pihent (üres). Jobb szélen a tegnap. */
export function PresenceStrip({ recent, className, tall = false }: { recent: string; className?: string; tall?: boolean }) {
  const out = [...recent].filter((c) => c === "1").length;
  return (
    <span
      className={cn("flex items-end gap-[2px]", className)}
      role="img"
      aria-label={`Az utolsó ${recent.length} napból ${out} napon volt kint`}
      title={`Az utolsó ${recent.length} napból ${out} napon volt kint (jobb szélen a tegnap)`}
    >
      {[...recent].map((c, i) => (
        <span
          key={i}
          className={cn(
            "w-[5px] rounded-[1.5px]",
            tall ? "h-4" : "h-2.5",
            c === "1" ? "bg-primary/80" : "bg-muted-foreground/20",
          )}
        />
      ))}
    </span>
  );
}
