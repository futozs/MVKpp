import { useState } from "react";
import { LocateFixed, Plus, RotateCcw, X } from "lucide-react";
import type { FilterState, LiveVehicle, Route } from "@/types";
import { RouteChips } from "@/components/fleet/RouteChips";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RouteTile } from "@/components/transit/RouteTile";
import { LiveDot } from "@/components/transit/LiveDot";
import { cn } from "@/lib/utils";
import { activeFilterCount, MAX_WATCHED } from "./filterState";

const RADIUS_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Mind" },
  { value: 0.5, label: "500 m" },
  { value: 1.5, label: "1,5 km" },
  { value: 5, label: "5 km" },
];

const SORTS = [
  { id: "route", label: "Járat" },
  { id: "id", label: "Rendszám" },
  { id: "speed", label: "Sebesség" },
] as const;

type Tab = "filters" | "list";

/**
 * Szűrés: mely járművek látszódjanak a térképen (járat, kiemelt rendszám,
 * típus, mozgás, távolság), és a látható járművek listája. A megjelenítés
 * (alaptérkép, rétegek) a Térkép vezérlőben, a megálló-keresés a Keresésben van.
 */
export function FilterPanel({
  open,
  onClose,
  filters,
  setFilters,
  onClearFilters,
  routes,
  vehicles,
  visibleVehicles,
  hasPosition,
  onStartGeo,
  onPickVehicle,
}: {
  open: boolean;
  onClose: () => void;
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  onClearFilters: () => void;
  routes: Record<string, Route>;
  /** minden élő jármű (a járat-csempék számlálójához) */
  vehicles: LiveVehicle[];
  /** a szűrésnek megfelelő, rendezett lista */
  visibleVehicles: LiveVehicle[];
  hasPosition: boolean;
  onStartGeo: () => void;
  onPickVehicle: (v: LiveVehicle) => void;
}) {
  const [tab, setTab] = useState<Tab>("filters");
  const [typedId, setTypedId] = useState("");
  const active = activeFilterCount(filters);
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) => setFilters((prev) => ({ ...prev, [key]: value }));

  const addWatch = () => {
    const id = typedId.trim();
    if (!id || filters.watch.length >= MAX_WATCHED || filters.watch.some((x) => x.toLowerCase() === id.toLowerCase())) return;
    setFilters((prev) => ({ ...prev, watch: [...prev.watch, id] }));
    setTypedId("");
  };

  return (
    <>
      {open ? (
        <button type="button" aria-label="Szűrés bezárása" onClick={onClose} className="absolute inset-0 z-drawer bg-background/60 backdrop-blur-[2px] md:hidden" />
      ) : null}
      <aside
        aria-label="Szűrés"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "absolute z-drawer flex flex-col overflow-hidden border-border bg-card shadow-2xl transition-[transform,opacity] duration-normal ease-out",
          // telefonon bal oldali fiók, asztalon a térkép fölött lebegő kártya (nem szűkíti a térképet)
          "inset-y-0 left-0 w-[88%] max-w-[360px] border-r",
          "md:inset-y-3 md:left-3 md:w-[360px] md:rounded-2xl md:border",
          open ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-[calc(100%+1rem)] opacity-0",
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 pb-3 pt-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold tracking-tight">Szűrés</h2>
            <p className="text-[12px] text-muted-foreground">
              <span className="font-semibold text-foreground">{visibleVehicles.length}</span> jármű látszik
              {active ? ` · ${active} szűrő` : ""}
            </p>
          </div>
          {active ? (
            <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 px-2.5 text-xs" onClick={onClearFilters}>
              <RotateCcw className="h-3.5 w-3.5" /> Alaphelyzet
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onClose} aria-label="Szűrés bezárása">
            <X />
          </Button>
        </header>

        <div role="tablist" aria-label="Szűrés nézetei" className="grid shrink-0 grid-cols-2 gap-1 border-b border-border p-2">
          {(
            [
              ["filters", "Szűrők", active || null],
              ["list", "Járművek", visibleVehicles.length],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-colors duration-fast",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                tab === id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
              {count != null ? (
                <span className={cn("rounded px-1 font-mono text-[10px] font-bold tabular-nums", tab === id ? "bg-primary-foreground/20" : "bg-primary/15 text-primary")}>{count}</span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "filters" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Section
              title="Járatok"
              aside={
                filters.routes.length ? (
                  <button type="button" onClick={() => set("routes", [])} className="text-[11px] font-semibold text-primary hover:underline">
                    {filters.routes.length} kiválasztva · törlés
                  </button>
                ) : (
                  <span className="text-[11px] text-muted-foreground">mind látszik</span>
                )
              }
            >
              <RouteChips
                routes={routes}
                selectedRoutes={filters.routes}
                onToggleRoute={(id) =>
                  set("routes", filters.routes.includes(id) ? filters.routes.filter((r) => r !== id) : [...filters.routes, id])
                }
                liveVehicles={vehicles}
              />
            </Section>

            <Section title="Kiemelt járművek" aside={filters.watch.length ? <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{filters.watch.length}/{MAX_WATCHED}</span> : undefined}>
              <p className="-mt-1 text-[11.5px] text-muted-foreground">Csak ezek a rendszámok látszanak — a többi szűrőtől függetlenül.</p>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addWatch();
                }}
              >
                <input
                  value={typedId}
                  onChange={(e) => setTypedId(e.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  enterKeyHint="done"
                  placeholder="Rendszám, pl. 1641"
                  aria-label="Kiemelendő jármű rendszáma"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
                <Button type="submit" size="icon" className="h-10 w-10 shrink-0" disabled={!typedId || filters.watch.length >= MAX_WATCHED} aria-label="Kiemelés">
                  <Plus />
                </Button>
              </form>
              {filters.watch.length ? (
                <>
                  <ul className="flex flex-wrap gap-1.5">
                    {filters.watch.map((id) => (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => set("watch", filters.watch.filter((x) => x !== id))}
                          aria-label={`${id} kiemelésének levétele`}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/35 bg-primary/12 px-2.5 font-mono text-xs font-bold tabular-nums text-primary transition-colors duration-fast hover:border-destructive/50 hover:bg-destructive/12 hover:text-destructive"
                        >
                          {id}
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <SwitchRow label="A térkép kövesse őket" checked={filters.follow} onChange={(v) => set("follow", v)} />
                </>
              ) : null}
            </Section>

            <Section title="Jármű">
              <Segmented
                label="Típus"
                value={filters.type}
                onChange={(v) => set("type", v)}
                options={[
                  { id: "all", label: "Mind" },
                  { id: "bus", label: "Busz" },
                  { id: "tram", label: "Villamos" },
                ]}
              />
              <Segmented
                label="Mozgás"
                value={filters.speed}
                onChange={(v) => set("speed", v)}
                options={[
                  { id: "all", label: "Mind" },
                  { id: "moving", label: "Mozgó" },
                  { id: "idle", label: "Álló" },
                ]}
              />
            </Section>

            <Section
              title="A közelemben"
              last
              aside={
                !hasPosition ? (
                  <button type="button" onClick={onStartGeo} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
                    <LocateFixed className="h-3 w-3" /> Helyzetem bekapcsolása
                  </button>
                ) : undefined
              }
            >
              <div role="group" aria-label="Távolság" className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-muted/60 p-1">
                {RADIUS_OPTIONS.map((o) => (
                  <button
                    key={String(o.value)}
                    type="button"
                    disabled={!hasPosition && o.value !== null}
                    onClick={() => set("nearMeKm", o.value)}
                    aria-pressed={filters.nearMeKm === o.value}
                    className={cn(
                      "rounded-md py-1.5 text-xs font-semibold transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      filters.nearMeKm === o.value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </Section>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-4 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rendezés</span>
              <div className="flex gap-1">
                {SORTS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => set("sort", o.id)}
                    aria-pressed={filters.sort === o.id}
                    className={cn(
                      "rounded-md px-2 py-1 text-[11px] font-semibold transition-colors duration-fast",
                      filters.sort === o.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            {visibleVehicles.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">A jelenlegi szűrésnek egy jármű sem felel meg.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {visibleVehicles.map((v) => (
                  <li key={v.id}>
                    <button type="button" onClick={() => onPickVehicle(v)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent">
                      <RouteTile short={v.routeShort} color={v.routeColor} text={v.routeText} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 font-mono text-sm font-bold tabular-nums">
                          {v.id}
                          <LiveDot />
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">{v.headsign}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-muted-foreground">{v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Telefonon a fiók alján: egy érintéssel vissza a térképre, a találatok számával. */}
        <footer className="shrink-0 border-t border-border p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
          <Button className="w-full" onClick={onClose}>
            {visibleVehicles.length} jármű a térképen
          </Button>
        </footer>
      </aside>
    </>
  );
}

function Section({ title, aside, last, children }: { title: string; aside?: React.ReactNode; last?: boolean; children: React.ReactNode }) {
  return (
    <section className={cn("space-y-2.5 px-4 py-3.5", !last && "border-b border-border")}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[12px] font-medium text-muted-foreground">{label}</span>
      <div role="group" aria-label={label} className="grid flex-1 grid-cols-3 gap-1 rounded-lg border border-border bg-muted/60 p-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={value === o.id}
            className={cn(
              "rounded-md py-1.5 text-xs font-semibold transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              value === o.id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-1 py-1.5 hover:bg-accent">
      <span className="text-[13px] font-medium">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
