import { useCallback, useMemo, useState } from "react";
import { Search, Star } from "lucide-react";
import type { Stop } from "@/types";
import {
  fmtDelay,
  formatServiceHour,
  serviceToday,
  shiftDate,
  statsApi,
  type StopHour,
} from "@/services/statsApi";
import {
  BarChart,
  ChartFrame,
  EmptyChart,
  HourHeat,
  StatTile,
} from "@/components/charts/Charts";
import { Input } from "@/components/ui/input";
import { QueryBoundary } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";
import { cn, normalizeSearchText } from "@/lib/utils";
import { usePreference } from "@/hooks/usePreference";
import { isRegionalId, pickableStops } from "@/lib/modes";
import { stopKindLabel } from "@/components/transit/RegionalBits";

/** Kedvenc megállók a statisztikában  localStorage, így a felhős szinkron is viszi. */
const FAVORITE_STOPS_KEY = "mvk_stats_favorite_stops";
const MAX_FAVORITES = 40;

/** Megálló-pill csillaggal (a csillag külön gomb: a kiválasztás és a kedvencezés nem keveredik). */
function StopPill({
  stop,
  active,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  stop: Stop;
  active: boolean;
  favorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <span
      className={cn(
        "flex max-w-64 shrink-0 items-center gap-1 rounded-lg border py-1 pl-2.5 pr-1 text-xs font-semibold transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      <button type="button" onClick={onSelect} aria-pressed={active} className="flex min-w-0 items-center focus-visible:outline-none">
        <span className="truncate">{stop.name}</span>
        <span className="ml-1.5 font-mono text-[10px] opacity-60">{isRegionalId(stop.id) ? stopKindLabel(stop) : stop.id}</span>
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-pressed={favorite}
        aria-label={favorite ? `${stop.name}: eltávolítás a kedvencekből` : `${stop.name}: kedvencnek jelölés`}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          favorite ? (active ? "text-primary-foreground" : "text-early") : "opacity-40 hover:opacity-100",
        )}
      >
        <Star className="h-3.5 w-3.5" fill={favorite ? "currentColor" : "none"} />
      </button>
    </span>
  );
}

function byHour(hours: StopHour[]) {
  const map = new Map<
    number,
    {
      events: number;
      delaySum: number;
      otpSum: number;
      dwellSum: number;
      hwSum: number;
      hwN: number;
    }
  >();
  for (const h of hours) {
    const cur = map.get(h.hour) ?? {
      events: 0,
      delaySum: 0,
      otpSum: 0,
      dwellSum: 0,
      hwSum: 0,
      hwN: 0,
    };
    cur.events += h.events_n;
    cur.delaySum += (h.avg_delay_s ?? 0) * h.events_n;
    cur.otpSum += (h.otp_pct ?? 0) * h.events_n;
    cur.dwellSum += (h.avg_dwell_s ?? 0) * h.events_n;
    if (h.avg_headway_s != null) {
      cur.hwSum += h.avg_headway_s;
      cur.hwN += 1;
    }
    map.set(h.hour, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, v]) => ({
      hour,
      events: v.events,
      avgDelay: v.events ? Math.round(v.delaySum / v.events) : null,
      otp: v.events ? Math.round(v.otpSum / v.events) : null,
      dwell: v.events ? Math.round(v.dwellSum / v.events) : null,
      headway: v.hwN ? Math.round(v.hwSum / v.hwN) : null,
    }));
}

export function StopPanel({ stops }: { stops: Stop[] }) {
  const [search, setSearch] = useState("");
  const [favoriteIds, setFavoriteIds] = usePreference<string[]>(FAVORITE_STOPS_KEY, []);
  // Megnyitáskor az első kedvenc töltődik be.
  const [stopId, setStopId] = useState<string | null>(() => favoriteIds[0] ?? null);
  const isFavorite = (id: string) => favoriteIds.includes(id);
  const toggleFavorite = (id: string) =>
    setFavoriteIds(isFavorite(id) ? favoriteIds.filter((x) => x !== id) : [...favoriteIds, id].slice(-MAX_FAVORITES));
  const favorites = useMemo(() => {
    const byId = new Map(stops.map((s) => [s.id, s]));
    return favoriteIds.map((id) => byId.get(id)).filter((s): s is Stop => Boolean(s));
  }, [favoriteIds, stops]);

  const to = serviceToday();
  const from = shiftDate(to, -13);
  // az állomás a vágányaival együtt egy tétel (a mérései is együtt jönnek)
  const pickable = useMemo(() => pickableStops(stops), [stops]);

  const matches = useMemo(() => {
    const t = normalizeSearchText(search.trim());
    // Kereső nélkül a kedvencek külön sorban vannak  itt a többi.
    if (!t) return pickable.filter((s) => !favoriteIds.includes(s.id)).slice(0, 12);
    return pickable
      .filter(
        (s) =>
          normalizeSearchText(s.name).includes(t) ||
          s.id.toLowerCase().includes(t),
      )
      .slice(0, 12);
  }, [search, pickable, favoriteIds]);

  const q = useStatsQuery(
    useCallback(() => statsApi.stop(stopId!, from, to), [stopId, from, to]),
    [stopId, from, to],
    Boolean(stopId),
  );

  const selected = stops.find((s) => s.id === stopId);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">
          Megállók
        </h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Megálló keresése…"
            className="pl-9"
            aria-label="Megálló keresése"
          />
        </div>
        {favorites.length ? (
          <div className="flex items-center gap-2">
            <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Star className="h-3 w-3 text-early" fill="currentColor" /> Kedvencek
            </span>
            <div className="min-w-0 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex min-w-max gap-1.5">
                {favorites.map((s) => (
                  <StopPill key={s.id} stop={s} active={s.id === stopId} favorite onSelect={() => setStopId(s.id)} onToggleFavorite={() => toggleFavorite(s.id)} />
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <div className="overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max gap-1.5">
            {matches.map((s) => (
              <StopPill
                key={s.id}
                stop={s}
                active={s.id === stopId}
                favorite={isFavorite(s.id)}
                onSelect={() => setStopId(s.id)}
                onToggleFavorite={() => toggleFavorite(s.id)}
              />
            ))}
            {!matches.length ? (
              <span className="px-2 py-1.5 text-xs text-muted-foreground">
                Nincs találat.
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {stopId ? (
        <QueryBoundary query={q} empty={(d) => d.hours.length === 0}>
          {(d) => {
            const rows = byHour(d.hours);
            const totalEvents = rows.reduce((a, r) => a + r.events, 0);
            const wAvg = (pick: (r: (typeof rows)[number]) => number | null) =>
              totalEvents
                ? Math.round(
                    rows.reduce((a, r) => a + (pick(r) ?? 0) * r.events, 0) /
                      totalEvents,
                  )
                : null;
            const avgOtp = wAvg((r) => r.otp);
            const avgDelay = wAvg((r) => r.avgDelay);
            const avgDwell = wAvg((r) => r.dwell);
            const busiest = rows.reduce<(typeof rows)[number] | null>(
              (best, r) => (!best || r.events > best.events ? r : best),
              null,
            );

            return (
              <div className="space-y-4">
                <header>
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    {selected?.name ?? d.name ?? stopId}
                    <button
                      type="button"
                      onClick={() => toggleFavorite(stopId)}
                      aria-pressed={isFavorite(stopId)}
                      aria-label={isFavorite(stopId) ? "Eltávolítás a kedvencekből" : "Kedvencnek jelölés"}
                      title={isFavorite(stopId) ? "Kedvenc  a felhőbe is mentve" : "Kedvencnek jelölés"}
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        isFavorite(stopId) ? "text-early" : "text-muted-foreground",
                      )}
                    >
                      <Star className="h-4 w-4" fill={isFavorite(stopId) ? "currentColor" : "none"} />
                    </button>
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {from} – {to} · {totalEvents.toLocaleString("hu-HU")}{" "}
                    érkezés
                  </p>
                </header>

                <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                  <StatTile
                    label="Menetrendtartás"
                    value={avgOtp != null ? `${avgOtp}%` : ""}
                    tone={
                      avgOtp == null
                        ? "default"
                        : avgOtp >= 80
                          ? "ontime"
                          : "late"
                    }
                  />
                  <StatTile
                    label="Átlagos késés"
                    value={fmtDelay(avgDelay)}
                    tone={avgDelay != null && avgDelay > 60 ? "late" : "ontime"}
                  />
                  <StatTile
                    label="Átlagos állás"
                    value={avgDwell != null ? `${avgDwell} mp` : ""}
                    sub="utasforgalom-proxy"
                  />
                  <StatTile
                    label="Legforgalmasabb óra"
                    value={busiest ? `${formatServiceHour(busiest.hour)}:00` : ""}
                    sub={busiest ? `${busiest.events} érkezés` : undefined}
                  />
                </div>

                <ChartFrame
                  title="Érkezések óránként"
                >
                  <BarChart
                    data={rows.map((r) => ({
                      label: formatServiceHour(r.hour),
                      value: r.events,
                      title: `${formatServiceHour(r.hour)}:00  ${r.events} érkezés, pontosság ${r.otp ?? ""}%`,
                    }))}
                    labelEvery={2}
                  />
                </ChartFrame>

                <ChartFrame
                  title="Pontosság óránként"
                >
                  <HourHeat
                    cells={rows.map((r) => ({
                      hour: r.hour,
                      value: r.otp,
                      title: `${formatServiceHour(r.hour)}:00  pontosság ${r.otp ?? ""}%, átlag ${fmtDelay(r.avgDelay)}`,
                    }))}
                  />
                </ChartFrame>

                <ChartFrame title="Átlagos késés óránként">
                  {rows.some((r) => r.avgDelay != null) ? (
                    <BarChart
                      data={rows.map((r) => ({
                        label: formatServiceHour(r.hour),
                        value: r.avgDelay,
                        tone:
                          (r.avgDelay ?? 0) > 60
                            ? "fill-late"
                            : (r.avgDelay ?? 0) < -60
                              ? "fill-early"
                              : "fill-ontime",
                        title: `${formatServiceHour(r.hour)}:00  ${fmtDelay(r.avgDelay)}`,
                      }))}
                      labelEvery={2}
                    />
                  ) : (
                    <EmptyChart />
                  )}
                </ChartFrame>
              </div>
            );
          }}
        </QueryBoundary>
      ) : (
        <p className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center text-xs text-muted-foreground">
          Válassz megállót.
        </p>
      )}
    </div>
  );
}
