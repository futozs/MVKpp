import { useEffect } from "react";
import { Footprints, Repeat, Shuffle, TrafficCone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pruneAlerts, removeAlert, useAlerts, type AlertWatch } from "@/lib/alerts";

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function describe(a: AlertWatch): { icon: typeof Footprints; title: string; sub: string } {
  if (a.kind === "traffic") return { icon: TrafficCone, title: `Dugóriasztás — ${a.stopName}`, sub: a.routeShorts?.length ? `csak: ${a.routeShorts.join(", ")}` : "bármelyik ide tartó busz" };
  if (a.kind === "transfer") {
    const p = a.params ?? {};
    return { icon: Shuffle, title: `Átszállás — ${a.stopName}`, sub: `${p.fromRoute ?? "?"} → ${p.toRoute ?? "?"}, szólok, ha veszélybe kerül` };
  }
  const walk = Number(a.params?.walkS ?? 0);
  const d = a.params?.days;
  const days = Array.isArray(d)
    ? d.map((x) => ["", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat", "vasárnap"][Number(x)] ?? "").join(", ")
    : d === "workday"
      ? "munkanaponként"
      : d === "weekend"
        ? "hétvégén"
        : "naponta";
  return {
    icon: a.schedMin != null ? Repeat : Footprints,
    title: `Indulj most — ${a.stopName}`,
    sub: `${a.schedMin != null ? `${days} ${hm(a.schedMin)}` : "egy menetre"}${a.routeShorts?.length ? ` · ${a.routeShorts.join(", ")}` : ""}${walk ? ` · ${Math.round(walk / 60)} perc séta` : ""}`,
  };
}

/** A különleges értesítések (indulj most, dugó, átszállás) — itt lehet őket kikapcsolni. */
export function AlertList() {
  const alerts = useAlerts();
  useEffect(() => pruneAlerts(), []);
  if (!alerts.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Indulás, dugó, átszállás ({alerts.length})</p>
      <ul className="divide-y divide-border/60 rounded-lg border border-border">
        {alerts.map((a) => {
          const d = describe(a);
          const Icon = d.icon;
          return (
            <li key={`${a.stopId}|${a.slot}`} className="flex items-center gap-2.5 px-3 py-2">
              <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{d.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {d.sub}
                  {a.pushRegistered ? "" : " · push nélkül"}
                </span>
              </span>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 hover:text-destructive" aria-label={`${d.title} kikapcsolása`} onClick={() => void removeAlert(a.stopId, a.slot)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
