import { useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import type { Route } from "@/types";
import { RouteTile } from "@/components/transit/RouteTile";
import { cn, normalizeSearchText } from "@/lib/utils";

/** villamos elöl, utána számsorrendben (1, 1G, 3 … 120, AU1, ZOO) */
function routeOrder(a: Route, b: Route): number {
  const tram = (r: Route) => (r.type === "900" ? 0 : 1);
  return tram(a) - tram(b) || a.short.localeCompare(b.short, "hu", { numeric: true });
}

/**
 * Vonalválasztó: egy gomb mutatja, mire szűrünk; kinyitva az összes vonal a
 * színével, kereshetően, több is kijelölhető. Üres választás: minden vonal.
 */
export function RoutePicker({
  routes,
  value,
  onChange,
  label = "Vonal",
  allLabel = "minden",
  className,
}: {
  routes: Route[];
  value: string[];
  onChange: (v: string[]) => void;
  label?: string;
  allLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const byShort = new Map(routes.map((r) => [r.short, r]));
  const needle = normalizeSearchText(q);
  const shown = [...routes].sort(routeOrder).filter((r) => !needle || normalizeSearchText(`${r.short} ${r.long}`).includes(needle));
  const toggle = (short: string) => onChange(value.includes(short) ? value.filter((x) => x !== short) : [...value, short]);

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value.length ? "border-primary/60 bg-primary/12" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {label}: {value.length ? "" : allLabel}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-fast", open && "rotate-180")} aria-hidden />
        </button>
        {value.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {value.map((s) => (
              <button key={s} type="button" onClick={() => toggle(s)} aria-label={`${s} kivétele`} className="group flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <RouteTile short={s} color={byShort.get(s)?.color} text={byShort.get(s)?.text} size="sm" />
                <X className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" aria-hidden />
              </button>
            ))}
            <button type="button" onClick={() => onChange([])} className="h-7 rounded-md px-1.5 text-[11.5px] font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              minden vonal
            </button>
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 rounded-xl border border-border bg-card p-2.5">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vonal vagy végállomás" aria-label="Vonal keresése" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </label>
          <div className="mt-2 flex max-h-52 flex-wrap gap-1.5 overflow-y-auto" role="group" aria-label="Vonalak">
            {shown.map((r) => {
              const on = value.includes(r.short);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggle(r.short)}
                  aria-pressed={on}
                  title={r.long}
                  className={cn("rounded-lg p-0.5 transition-opacity duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", on ? "ring-2 ring-primary" : value.length ? "opacity-55 hover:opacity-100" : "")}
                >
                  <RouteTile short={r.short} color={r.color} text={r.text} />
                </button>
              );
            })}
            {!shown.length ? <p className="px-1 py-2 text-xs text-muted-foreground">Nincs ilyen vonal.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
