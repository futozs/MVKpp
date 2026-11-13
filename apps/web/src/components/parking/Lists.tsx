import { ChevronDown, WifiOff } from "lucide-react";
import type { ParkedVehicle, ServiceVehicle } from "@/services/parkingApi";
import { cn } from "@/lib/utils";
import { durationText } from "./format";
import { RouteChip, type RouteLookup } from "./parts";
import { displayVehicleId, vehicleIdTitle } from "@/lib/modes";

/** Menet közben elnémult járművek  a borostyán sáv az 1 órás határig hátralévő időt mutatja. */
export function NoSignalList({
  vehicles,
  now,
  limitS,
  onSelect,
  lookup,
}: {
  vehicles: (ParkedVehicle & { place: string | null })[];
  now: number;
  limitS: number;
  onSelect: (id: string) => void;
  lookup: RouteLookup;
}) {
  if (!vehicles.length) return null;
  return (
    <section className="rounded-2xl border border-nosignal/30 bg-nosignal/[0.06] p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <WifiOff className="h-4 w-4 text-nosignal" /> Jel nélkül
        <span className="font-mono text-nosignal">{vehicles.length}</span>
      </h3>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">
        Menet közben elnémultak. Ha {Math.round(limitS / 60)} percen belül nem jelentkeznek, a kocsiszínbe soroljuk őket.
      </p>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {vehicles.map((v) => {
          const silent = v.lastSeen ? Math.max(0, now - v.lastSeen) : 0;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelect(v.id)}
              className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-left hover:border-nosignal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center justify-between">
                <span className="font-mono text-[15px] font-bold tabular-nums" title={vehicleIdTitle(v.id)}>{displayVehicleId(v.id)}</span>
                <RouteChip route={v.lastRoute} lookup={lookup} />
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {v.place ? `${v.place} közelében · ` : ""}
                {durationText(silent)}
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full origin-left rounded-full bg-nosignal" style={{ transform: `scaleX(${Math.min(1, silent / limitS)})` }} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Akik most menetet visznek  összecsukható, hogy a parkolók legyenek elöl. */
export function ServiceList({ vehicles, onSelect, lookup }: { vehicles: ServiceVehicle[]; onSelect: (id: string) => void; lookup: RouteLookup }) {
  if (!vehicles.length) return null;
  return (
    <details className="group rounded-2xl border border-border bg-card shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-bold [&::-webkit-details-marker]:hidden">
        <span className="h-2 w-2 rounded-[3px] bg-primary" />
        Bevetésen
        <span className="font-mono text-primary">{vehicles.length}</span>
        <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform duration-fast group-open:rotate-180" />
      </summary>
      <div className="flex flex-wrap gap-1.5 border-t border-border/70 px-4 py-3">
        {vehicles.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id)}
            title={v.deadhead ? "menet nélkül úton" : (v.headsign ?? undefined)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1 pl-2 pr-1.5 hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              v.deadhead && "border-dashed",
            )}
          >
            <span className="font-mono text-[12.5px] font-bold tabular-nums" title={vehicleIdTitle(v.id)}>{displayVehicleId(v.id)}</span>
            {v.route ? <RouteChip route={v.route} lookup={lookup} /> : <span className="text-[10.5px] text-muted-foreground">úton</span>}
          </button>
        ))}
      </div>
    </details>
  );
}
