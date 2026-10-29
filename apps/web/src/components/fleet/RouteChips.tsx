import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { LiveVehicle, Route } from "@/types";
import { Input } from "@/components/ui/input";
import { cn, normalizeSearchText } from "@/lib/utils";

interface RouteChipsProps {
  routes: Record<string, Route>;
  selectedRoutes: string[];
  onToggleRoute: (routeId: string) => void;
  liveVehicles: LiveVehicle[];
}

export function RouteChips({
  routes,
  selectedRoutes,
  onToggleRoute,
  liveVehicles,
}: RouteChipsProps) {
  const [query, setQuery] = useState("");

  const liveCountByRoute = useMemo(() => {
    const counts: Record<string, number> = {};
    liveVehicles.forEach((v) => {
      counts[v.routeId] = (counts[v.routeId] || 0) + 1;
    });
    return counts;
  }, [liveVehicles]);

  const ordered = useMemo(
    () =>
      Object.values(routes).sort((a, b) => {
        const na = parseInt(a.short, 10);
        const nb = parseInt(b.short, 10);
        if (!isNaN(na) && !isNaN(nb))
          return na - nb || a.short.localeCompare(b.short, "hu");
        return a.short.localeCompare(b.short, "hu");
      }),
    [routes],
  );

  // Alapból csak a most futó járatok (rövidebb lista); a kiválasztottak mindig látszanak.
  const [onlyLive, setOnlyLive] = useState(true);
  const selected = new Set(selectedRoutes);

  // A kiválasztottak elöl (látszódjon, mi van bekapcsolva), utána sorszám szerint.
  const visible = useMemo(() => {
    const q = normalizeSearchText(query.trim());
    const list = ordered.filter(
      (r) =>
        (!q || normalizeSearchText(r.short).includes(q) || (r.long && normalizeSearchText(r.long).includes(q))) &&
        (!onlyLive || liveCountByRoute[r.id] || selectedRoutes.includes(r.id)),
    );
    return [...list.filter((r) => selectedRoutes.includes(r.id)), ...list.filter((r) => !selectedRoutes.includes(r.id))];
  }, [ordered, query, onlyLive, liveCountByRoute, selectedRoutes]);

  const liveRoutes = Object.keys(liveCountByRoute).filter((id) => routes[id]).length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Járatszám vagy útvonal"
            aria-label="Járat keresése"
            className="h-9 pl-8 text-xs"
          />
        </div>
        <button
          type="button"
          onClick={() => setOnlyLive((v) => !v)}
          aria-pressed={onlyLive}
          title="Csak azok a járatok, amelyeken most busz közlekedik"
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors duration-fast",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            onlyLive ? "border-primary bg-primary/12 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", onlyLive ? "bg-primary" : "bg-muted-foreground/60")} />
          Csak futó ({liveRoutes})
        </button>
      </div>

      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            {query.trim() ? `Nincs „${query.trim()}” jelzésű járat.` : "Járatok betöltése…"}
          </p>
        ) : (
          visible.map((route) => {
            const isOn = selected.has(route.id);
            const liveCount = liveCountByRoute[route.id] || 0;
            const idle = liveCount === 0;

            return (
              <button
                key={route.id}
                type="button"
                onClick={() => onToggleRoute(route.id)}
                aria-pressed={isOn}
                title={route.long || route.short}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2",
                  "text-xs font-bold tabular-nums tracking-tight",
                  "transition-all duration-fast",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isOn && "shadow-sm ring-1 ring-inset ring-black/20",
                  !isOn &&
                    !idle &&
                    "border-border bg-secondary hover:border-primary/40 hover:bg-accent",
                  !isOn &&
                    idle &&
                    "border-border/50 bg-transparent text-muted-foreground opacity-55 hover:opacity-100",
                )}
                style={
                  isOn
                    ? {
                        backgroundColor: `#${route.color || "1FB574"}`,
                        color: `#${route.text || "FFFFFF"}`,
                        borderColor: `#${route.color || "1FB574"}`,
                      }
                    : undefined
                }
              >
                {!isOn ? (
                  <span
                    aria-hidden
                    className="h-3 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${route.color || "888888"}` }}
                  />
                ) : null}

                <span>{route.short}</span>

                {liveCount > 0 ? (
                  <span
                    className={cn(
                      "rounded px-1 font-mono text-[10px] font-bold leading-none",
                      isOn ? "bg-black/25" : "bg-primary/15 text-primary",
                    )}
                  >
                    {liveCount}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
