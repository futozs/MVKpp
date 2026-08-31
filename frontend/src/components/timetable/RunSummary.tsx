import { Bus, Flag, LogOut } from "lucide-react";
import type { TripJournalEntry } from "@/types";
import { delayState, delayTone } from "@/components/transit/DelayBar";
import { delayPastSentence } from "@/lib/tripStatus";
import { cn } from "@/lib/utils";

/**
 * Egy menet TÉNYLEGES futása: melyik jármű vitte, mennyit késett vagy sietett
 * induláskor és érkezéskor. Múltbeli napoknál ez az egyetlen forrás — az élő
 * feed addigra semmit nem tud a menetről.
 */
export function RunSummary({
  entry,
  className,
}: {
  entry: TripJournalEntry;
  className?: string;
}) {
  const startText = delayPastSentence(entry.startDelaySec, "start");
  const endText = delayPastSentence(entry.endDelaySec, "end");
  if (!startText && !endText && !entry.vehicleId) return null;

  // A worker akkor jelöl `partial`-t, ha a menet közben elvesztette a járművet:
  // ilyenkor az eltérés csak a látott megállókra igaz.
  const partial =
    entry.status === "partial" &&
    entry.stopsSeen != null &&
    entry.stopsTotal != null;

  return (
    <section
      aria-label="A menet tényleges futása"
      className={cn(
        "border-b border-border bg-muted/30 px-3 py-2 sm:px-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {entry.vehicleId ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold">
            <Bus aria-hidden className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono tabular-nums">{entry.vehicleId}</span>
            <span className="font-normal text-muted-foreground">vitte</span>
          </span>
        ) : null}

        {startText ? (
          <Chip
            icon={<LogOut aria-hidden className="h-3 w-3" />}
            text={startText}
            sec={entry.startDelaySec}
          />
        ) : null}

        {endText ? (
          <Chip
            icon={<Flag aria-hidden className="h-3 w-3" />}
            text={endText}
            sec={entry.endDelaySec}
          />
        ) : null}
      </div>

      {partial ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Részleges mérés: {entry.stopsSeen}/{entry.stopsTotal} megállónál volt
          élő jel.
        </p>
      ) : null}
    </section>
  );
}

function Chip({
  icon,
  text,
  sec,
}: {
  icon: React.ReactNode;
  text: string;
  sec: number | null;
}) {
  const state = delayState(sec);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
        state === "late"
          ? "border-late/40 bg-late/10"
          : state === "early"
            ? "border-early/40 bg-early/10"
            : "border-border bg-card",
        delayTone(sec),
      )}
    >
      {icon}
      {text}
    </span>
  );
}
