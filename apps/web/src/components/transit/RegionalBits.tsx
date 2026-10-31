/**
 * A Volán és a vasút sorainak kiegészítői a megállótáblákon: vágány / kocsiállás
 * (élőben változhat), a MÁV hivatalos megjegyzései (késés oka, kocsiösszeállítás,
 * pótlóbusz), és a csempe szövege (vonatnál a kategória és a vonatszám).
 */
import { Info, Merge, TrainTrack } from "lucide-react";
import type { ArrivalItem, Stop } from "@/types";
import { displayVehicleId, feedOfId } from "@/lib/modes";
import { cn } from "@/lib/utils";

/** A csempe szövege: vonatnál „IC 582”, máshol a vonalszám. */
export function arrivalTileText(a: Pick<ArrivalItem, "route" | "mode" | "trainNo">): string {
  return a.mode === "rail" && a.trainNo ? `${a.route} ${a.trainNo}` : a.route;
}

/** A sor címe: vonatnál a név is („TOKAJ → Budapest-Nyugati”). */
export function arrivalTitle(a: Pick<ArrivalItem, "headsign" | "trainName">): string {
  return a.trainName ? `${a.trainName} → ${a.headsign}` : a.headsign;
}

/** A jármű címkéje a sorban: Volánnál a rendszám, vonatnál nincs (a vonatszám a csempén). */
export function arrivalVehicleLabel(a: Pick<ArrivalItem, "vehicle" | "mode">): string | null {
  if (!a.vehicle || a.mode === "rail") return null;
  return displayVehicleId(a.vehicle.id);
}

/** A megálló fajtája a fejlécben (az MVK-é a megálló-azonosító marad). */
export function stopKindLabel(stop: Pick<Stop, "id" | "station" | "feed">): string {
  const f = stop.feed ?? feedOfId(stop.id);
  if (f === "rail") return "Vasútállomás";
  if (f === "coach") return stop.station ? "Autóbusz-állomás" : "Volán-megálló";
  return stop.id;
}

/**
 * Vágány (vasút) vagy kocsiállás (autóbusz-állomás); a változás kiemelve. A még ki nem adott,
 * a korábbi napok szerinti várható (`predicted`) szaggatott kerettel és „~” jellel.
 */
export function PlatformBadge({
  platform,
  changed,
  predicted,
  mode,
  compact,
  className,
}: {
  platform?: string | null;
  changed?: boolean;
  predicted?: boolean;
  mode?: string;
  compact?: boolean;
  className?: string;
}) {
  if (!platform) return null;
  const rail = mode === "rail";
  const label = rail ? "vágány" : "kocsiállás";
  return (
    <span
      title={
        predicted
          ? `Várhatóan a ${platform}. ${label} — még nincs kiadva, a korábbi napok alapján`
          : changed
            ? `A ${label} változott: most ${platform}.`
            : `${platform}. ${label}`
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px font-mono text-[10.5px] font-bold tabular-nums",
        predicted ? "border-dashed border-muted-foreground/50 text-muted-foreground" : changed ? "border-late/50 bg-late/12 text-late" : "border-border bg-muted text-foreground",
        className,
      )}
    >
      {rail ? <TrainTrack aria-hidden className="h-2.5 w-2.5" /> : null}
      {predicted ? "~" : null}
      {platform}
      {compact ? null : <span className="font-sans text-[10px] font-semibold text-muted-foreground">{rail ? "vg." : "k.áll."}</span>}
    </span>
  );
}

/** A MÁV hivatalos megjegyzései egy menethez (pl. „Pálya állapota miatti késés”). */
export function NoticeList({ notices, compact, className }: { notices?: string[] | null; compact?: boolean; className?: string }) {
  if (!notices?.length) return null;
  const list = compact ? notices.slice(0, 1) : notices;
  return (
    <ul className={cn("space-y-1", className)}>
      {list.map((n) => (
        <li key={n} className={cn("flex items-start gap-1.5 text-muted-foreground", compact ? "text-[10.5px]" : "text-[11.5px]")}>
          <Info aria-hidden className="mt-px h-3 w-3 shrink-0 text-late" />
          <span className={cn("min-w-0", compact && "truncate")}>{n}</span>
        </li>
      ))}
    </ul>
  );
}

/** Közös megálló a fejlécben: az MVK-oszlop és a mellette álló Volán-megálló egy táblán. */
export function SharedStopTag({ merged }: { merged?: string[] | null }) {
  if (!merged || merged.length < 2) return null;
  return (
    <span
      title="Az MVK- és a Volán-megálló egy helyen áll: a táblán mindkettő járatai (a Beállításokban állítható)."
      className="inline-flex items-center gap-1 font-sans font-semibold text-foreground/80"
    >
      <Merge aria-hidden className="h-3 w-3 text-primary" />
      közös megálló
    </span>
  );
}
