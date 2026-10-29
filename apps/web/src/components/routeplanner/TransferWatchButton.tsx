import { useState } from "react";
import { BellPlus, BellRing, Loader2 } from "lucide-react";
import type { JourneyTransferCheck } from "@/services/api";
import { addAlert, removeAlert, useAlerts } from "@/lib/alerts";
import { cn } from "@/lib/utils";

/**
 * „Figyeld az átszállást”: ha útközben elszáll az esély (az első busz késik,
 * a csatlakozás korábban megy), push-értesítés jön — a következő lehetőséggel.
 * Csak a mai, közeli utakra (a szerver a mai előrejelzésből számol).
 */
export function TransferWatchButton({ check, className }: { check: JourneyTransferCheck; className?: string }) {
  const alerts = useAlerts();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!check.toTripId || !check.fromTripId || !check.boardStopId || !check.alightStopId) return null;
  const slot = `transfer:${check.toTripId}`;
  const on = alerts.some((a) => a.stopId === check.boardStopId && a.slot === slot);

  const toggle = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (on) await removeAlert(check.boardStopId!, slot);
      else {
        const r = await addAlert({
          slot,
          kind: "transfer",
          stopId: check.boardStopId!,
          stopName: check.at,
          tripId: check.toTripId,
          params: {
            fromTrip: check.fromTripId,
            alightStopId: check.alightStopId,
            walkS: check.walkS ?? 0,
            fromRoute: check.fromRoute,
            toRoute: check.toRoute,
            boardStopName: check.at,
          },
        });
        if (!r.ok) setNote(r.reason ?? "Nem sikerült bekapcsolni.");
        else if (!r.push) setNote("Ezen az eszközön nincs push — csak nyitott oldalnál látod.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={cn("inline-flex flex-col", className)}>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={on}
        title={on ? "Szólok, ha veszélybe kerül az átszállás — koppints a kikapcsoláshoz" : "Szólj, ha veszélybe kerül ez az átszállás"}
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
        )}
      >
        {busy ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : on ? <BellRing aria-hidden className="h-3 w-3" /> : <BellPlus aria-hidden className="h-3 w-3" />}
        {on ? "Figyelem az átszállást" : "Figyeld az átszállást"}
      </button>
      {note ? <span className="mt-0.5 text-[10.5px] text-muted-foreground">{note}</span> : null}
    </span>
  );
}
