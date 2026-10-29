import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import type { Route } from "@/types";
import type { FleetKind, KindCounts, ParkedVehicle, ParkingSnapshot } from "@/services/parkingApi";
import { useRealtimeConnected } from "@/lib/realtime";
import { usePreference } from "@/hooks/usePreference";
import { cn } from "@/lib/utils";
import { BlockChart } from "./BlockChart";
import { DepotLotCard } from "./DepotLot";
import { depotKey, PREF_PARKING_FAVORITES, terminalKey, withFavorites } from "./favorites";
import { FleetSummary } from "./FleetSummary";
import { clockOf, daysBetween, durationText } from "./format";
import { NoSignalList, ServiceList } from "./Lists";
import { TerminalLotCard, type LotContext } from "./TerminalLot";
import { useParking } from "./useParking";
import { VehicleSheet } from "./VehicleSheet";

type KindFilter = "all" | FleetKind;

const KIND_OPTIONS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "Mind" },
  { id: "bus", label: "Busz" },
  { id: "tram", label: "Villamos" },
];

export function ParkingView({
  routes,
  onFocusVehicle,
  embedded = false,
}: {
  routes: Route[];
  onFocusVehicle: (id: string) => void;
  /** a Statisztikán belül: ott már van görgetés és margó */
  embedded?: boolean;
}) {
  const { data, error, now } = useParking();
  const live = useRealtimeConnected();
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = usePreference<"lots" | "blocks">("mvk_parking_mode", "lots");
  const [favorites, setFavorites] = usePreference<string[]>(PREF_PARKING_FAVORITES, []);
  const isFav = (key: string) => favorites.includes(key);
  const toggleFav = (key: string) => setFavorites(isFav(key) ? favorites.filter((k) => k !== key) : [...favorites, key]);

  const byShort = useMemo(() => new Map(routes.map((r) => [r.short, r])), [routes]);
  const lookup = (short: string | null) => (short ? byShort.get(short) : undefined);
  const view = useMemo(() => (data ? withFavorites(filterSnapshot(data, kind, query), favorites, query) : null), [data, kind, query, favorites]);

  if (!data || !view) {
    return (
      <Shell embedded={embedded}>
        <Header live={live} at={null} kind={kind} setKind={setKind} query={query} setQuery={setQuery} />
        <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-sm text-muted-foreground">
          {error ?? "A parkoló betöltése…"}
        </div>
      </Shell>
    );
  }

  const ctx: LotContext = { now, midnight: data.midnight, limitS: data.limitS, lookup, history: (id) => data.fleet[id], onSelect: setSelected };
  const counts = sumCounts(data.counts, kind);
  const empty = !view.terminals.length && !view.depots.some((d) => d.vehicles.length) && !view.nosignal.length && !view.service.length;

  return (
    <Shell embedded={embedded}>
      <Header live={live} at={data.at} kind={kind} setKind={setKind} query={query} setQuery={setQuery} />
      <FleetSummary counts={counts} facts={facts(view, data, now)} />
      <div role="tablist" aria-label="Nézet" className="inline-flex gap-1 rounded-lg border border-border bg-muted/60 p-1">
        {(
          [
            ["lots", "Parkoló"],
            ["blocks", "Forda-tábla"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={cn(
              "rounded-md px-3.5 py-1.5 text-xs font-semibold transition-all duration-fast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              mode === id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "blocks" ? (
        <BlockChart lookup={lookup} kind={kind} query={query} onSelect={setSelected} />
      ) : empty ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">Nincs ilyen jármű.</div>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
          <section aria-labelledby="parking-terminals" className="min-w-0 space-y-3">
            <SectionTitle id="parking-terminals" count={view.terminals.reduce((n, t) => n + t.vehicles.length, 0)}>
              Végállomásokon
            </SectionTitle>
            {view.terminals.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {view.terminals.map((t) => (
                  <TerminalLotCard
                    key={t.name}
                    lot={t}
                    ctx={ctx}
                    favorite={isFav(terminalKey(t.name))}
                    onToggleFavorite={() => toggleFav(terminalKey(t.name))}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">Most egy végállomáson sem parkol senki.</p>
            )}
            <NoSignalList vehicles={view.nosignal} now={now} limitS={data.limitS} onSelect={setSelected} lookup={lookup} />
          </section>
          <aside aria-labelledby="parking-depots" className="min-w-0 space-y-3 xl:sticky xl:top-4">
            <SectionTitle id="parking-depots" count={view.depots.reduce((n, d) => n + d.vehicles.length, 0)}>
              Kocsiszínben
            </SectionTitle>
            {view.depots
              .filter((d) => d.vehicles.length || kind === d.id)
              .map((d) => (
                <DepotLotCard
                  key={d.id}
                  lot={d}
                  ctx={ctx}
                  serviceDate={data.serviceDate}
                  favorite={isFav(depotKey(d.id))}
                  onToggleFavorite={() => toggleFav(depotKey(d.id))}
                />
              ))}
          </aside>
        </div>
      )}
      {mode === "lots" ? <ServiceList vehicles={view.service} onSelect={setSelected} lookup={lookup} /> : null}
      <VehicleSheet snap={data} id={selected} now={now} lookup={lookup} onClose={() => setSelected(null)} onFocusVehicle={onFocusVehicle} />
    </Shell>
  );
}

function Shell({ children, embedded }: { children: ReactNode; embedded: boolean }) {
  if (embedded) return <div className="space-y-5 pb-6">{children}</div>;
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1480px] space-y-5 px-4 pb-10 pt-4 sm:px-6 lg:pt-6">{children}</div>
    </div>
  );
}

function Header({
  live,
  at,
  kind,
  setKind,
  query,
  setQuery,
}: {
  live: boolean;
  at: number | null;
  kind: KindFilter;
  setKind: (k: KindFilter) => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-extrabold leading-tight tracking-tight sm:text-[26px]">Parkoló</h1>
        <p className="mt-1 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-live motion-safe:animate-live-pulse" : "bg-muted-foreground/50")} />
          {live ? "élő" : "frissítés 15 mp-enként"}
          {at ? <span className="font-mono tabular-nums">· {clockOf(at)}</span> : null}
          <span className="hidden sm:inline">· ki áll melyik végállomáson, és ki pihen a kocsiszínben</span>
        </p>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <div role="group" aria-label="Járműtípus" className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/60 p-1">
          {KIND_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={kind === o.id}
              onClick={() => setKind(o.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-all duration-fast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                kind === o.id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="relative w-full sm:w-56">
          <span className="sr-only">Keresés rendszámra vagy vonalra</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rendszám vagy vonal"
            inputMode="search"
            className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-3 font-mono text-[13px] placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>
    </header>
  );
}

function SectionTitle({ id, count, children }: { id: string; count: number; children: ReactNode }) {
  return (
    <h2 id={id} className="flex items-baseline gap-2 px-0.5 text-[13px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
      <span className="font-mono text-foreground">{count}</span>
    </h2>
  );
}

function sumCounts(c: Record<FleetKind, KindCounts>, kind: KindFilter): KindCounts {
  if (kind !== "all") return c[kind];
  return {
    service: c.bus.service + c.tram.service,
    terminus: c.bus.terminus + c.tram.terminus,
    depot: c.bus.depot + c.tram.depot,
    nosignal: c.bus.nosignal + c.tram.nosignal,
    total: c.bus.total + c.tram.total,
  };
}

/** Típus és keresés szerinti szűrés: rendszám-előtagra vagy pontos vonalszámra. */
function filterSnapshot(s: ParkingSnapshot, kind: KindFilter, query: string): ParkingSnapshot {
  const q = query.trim().toLowerCase();
  const ok = (v: { id: string; kind: FleetKind }, route: string | null) =>
    (kind === "all" || v.kind === kind) && (!q || v.id.toLowerCase().startsWith(q) || route?.toLowerCase() === q);
  const parked = (v: ParkedVehicle) => ok(v, v.lastRoute) || (Boolean(q) && v.next?.route.toLowerCase() === q && (kind === "all" || v.kind === kind));
  return {
    ...s,
    terminals: s.terminals.map((t) => ({ ...t, vehicles: t.vehicles.filter(parked) })).filter((t) => t.vehicles.length),
    depots: s.depots.map((d) => ({ ...d, vehicles: d.vehicles.filter(parked) })),
    nosignal: s.nosignal.filter(parked),
    service: s.service.filter((v) => ok(v, v.route)),
  };
}

/** Három érdekesség a fejléc alá: ki áll a legrégebben, hol állnak a legtöbben, ki pihen a legrégebben. */
function facts(view: ParkingSnapshot, data: ParkingSnapshot, now: number) {
  const out: { label: string; value: ReactNode }[] = [];
  let longest: { id: string; place: string; since: number } | null = null;
  for (const t of view.terminals)
    for (const v of t.vehicles) if (v.since && (!longest || v.since < longest.since)) longest = { id: v.id, place: t.name, since: v.since };
  if (longest)
    out.push({
      label: "Legrégebben áll",
      value: (
        <>
          <span className="font-mono font-bold">{longest.id}</span> · {longest.place} · {durationText(now - longest.since)}
        </>
      ),
    });
  const busiest = view.terminals[0];
  if (busiest && busiest.vehicles.length > 1)
    out.push({ label: "Legtöbben itt", value: <>{busiest.name} · <span className="font-mono font-bold">{busiest.vehicles.length}</span></> });
  let rest: { id: string; days: number } | null = null;
  for (const d of view.depots)
    for (const v of d.vehicles) {
      const last = v.reason === "not-today" ? data.fleet[v.id]?.lastDate : null;
      const days = last ? daysBetween(last, data.serviceDate) : 0;
      if (days > 1 && (!rest || days > rest.days)) rest = { id: v.id, days };
    }
  if (rest)
    out.push({ label: "Leghosszabb pihenő", value: <><span className="font-mono font-bold">{rest.id}</span> · {rest.days}. napja nincs kint</> });
  return out;
}
