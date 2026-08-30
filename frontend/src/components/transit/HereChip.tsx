import { LocateFixed, MapPin } from "lucide-react";
import type { Stop } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { formatDistance, nearest } from "@/lib/geo";
import { cn } from "@/lib/utils";

export function HereChip({
  stops,
  className,
}: {
  stops: Stop[];
  className?: string;
}) {
  const geo = useGeo();

  if (!geo.position) {
    const blocked = geo.status === "denied" || geo.status === "unavailable";
    return blocked ? (
      <p className={cn("text-[11px] text-muted-foreground", className)}>
        {geo.error ?? "A helymeghatározás nem érhető el."}
      </p>
    ) : (
      <button
        type="button"
        onClick={geo.start}
        disabled={geo.status === "requesting"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-early/40 bg-early/10 px-2.5 py-1",
          "text-[11px] font-semibold text-early transition-colors duration-fast",
          "hover:bg-early/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:opacity-60",
          className,
        )}
      >
        <LocateFixed
          aria-hidden
          className={cn(
            "h-3 w-3",
            geo.status === "requesting" && "animate-pulse",
          )}
        />
        {geo.status === "requesting" ? "Helyzet keresése…" : "Hol vagyok?"}
      </button>
    );
  }

  const hit = nearest(stops, geo.position.lat, geo.position.lon);

  return (
    <p
      className={cn("flex min-w-0 items-center gap-1.5 text-[11px]", className)}
      title={
        geo.isStale
          ? "Az utolsó ismert helyzeted — friss mérés még nem érkezett."
          : `Pontosság: ±${Math.round(geo.position.accuracyM)} m`
      }
    >
      <MapPin
        aria-hidden
        className={cn(
          "h-3.5 w-3.5 shrink-0 text-early",
          geo.isStale && "opacity-50",
        )}
      />
      <span className="shrink-0 font-semibold text-muted-foreground">
        Itt vagy
      </span>
      {hit ? (
        <>
          <span className="min-w-0 truncate font-medium text-foreground">
            {hit.item.name}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
            {formatDistance(hit.km)}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">a megállólistán kívül</span>
      )}
    </p>
  );
}
