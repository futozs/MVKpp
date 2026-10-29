import { useGeo } from "@/context/GeoContext";
import { useApproach } from "@/hooks/useApproach";
import type { LocatableStop } from "@/lib/geo";
import {
  delaySentence,
  delayState,
  delayTone,
} from "@/components/transit/DelayBar";
import { HereChip } from "@/components/transit/HereChip";
import { cn } from "@/lib/utils";

interface ApproachStripProps {
  tripId: string | null;
  shape: [number, number][] | undefined;
  vehicle: { lat: number; lon: number; speed: number | null } | null;
  stops: readonly LocatableStop[];
  deviationSec?: number | null;
  className?: string;
}

export function ApproachStrip({
  tripId,
  shape,
  vehicle,
  stops,
  deviationSec,
  className,
}: ApproachStripProps) {
  const geo = useGeo();
  const approach = useApproach({
    tripId,
    shape,
    vehicle,
    position: geo.position,
  });

  return (
    <section
      aria-label="A busz és a helyzetem"
      className={cn(
        "border-t border-border bg-muted/25 px-4 py-2.5",
        className,
      )}
    >
      <HereChip stops={stops} />

      {approach.state === "no-gps" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Nincs helymeghatározás.
        </p>
      ) : approach.state === "no-vehicle" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Erre a menetre még nem jelentkezett be jármű.
        </p>
      ) : approach.state === "off-route" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          A járat nem halad el melletted.
        </p>
      ) : null}

      {delayState(deviationSec) !== "unknown" ? (
        <p
          className={cn(
            "mt-1.5 text-[11px] font-semibold",
            delayTone(deviationSec),
          )}
        >
          {delaySentence(deviationSec)}
        </p>
      ) : null}
    </section>
  );
}
