import { useState } from "react";
import { TrafficCone } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { addAlert, removeAlert, useAlerts } from "@/lib/alerts";

const SLOT = "traffic";

/**
 * Dugóriasztás egy megállóhoz: ha az ide tartó busz előtt beáll a forgalom
 * (az élő forgalmi rétegből), push-értesítést kapsz a várható pluszidővel.
 * Független az „érkezik a busz” értesítéstől.
 */
export function TrafficAlertSwitch({ stopId, stopName, routeShorts }: { stopId: string; stopName: string; routeShorts: string[] }) {
  const alerts = useAlerts();
  const on = alerts.some((a) => a.stopId === stopId && a.slot === SLOT);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (!next) await removeAlert(stopId, SLOT);
      else {
        const r = await addAlert({ slot: SLOT, kind: "traffic", stopId, stopName, routeShorts: routeShorts.length ? routeShorts : undefined });
        if (!r.ok) setNote(r.reason ?? "Nem sikerült bekapcsolni.");
        else if (!r.push) setNote(r.reason ? `Push nem érhető el: ${r.reason}` : "Push nem érhető el ezen az eszközön.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1 rounded-lg border border-border px-3 py-2.5">
      <label className="flex items-center gap-3">
        <TrafficCone aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Dugóriasztás</span>
          <span className="block text-[11px] text-muted-foreground">
            Szólok, ha az ide tartó busz előtt beáll a forgalom{routeShorts.length ? ` (${routeShorts.join(", ")})` : ""}.
          </span>
        </span>
        <Switch checked={on} disabled={busy} onCheckedChange={(v) => void toggle(v)} aria-label="Dugóriasztás ehhez a megállóhoz" />
      </label>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
