import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Bell,
  BellRing,
  Bus,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crosshair,
  Search,
  Star,
  X,
} from "lucide-react";
import type {
  LiveVehicle,
  Stop,
  TimetableResponse,
  TimetableRoute,
  TimetableTrip,
  TripJournalEntry,
} from "@/types";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { RouteTile } from "@/components/transit/RouteTile";
import { LiveDot } from "@/components/transit/LiveDot";
import { HereChip } from "@/components/transit/HereChip";
import { RunSummary } from "./RunSummary";
import { TimetableGrid } from "./TimetableGrid";
import { TripNotifyDialog } from "./TripNotifyDialog";
import { TripProgressRail } from "./TripProgressRail";
import { useCancelledTrips } from "@/hooks/useCancelledTrips";
import { useTripJournal } from "@/hooks/useTripJournal";
import { favoriteKey, useFavorites } from "@/hooks/useFavorites";
import {
  dayRelation,
  showsJournalVehicle,
  tripRunLabel,
  tripRunState,
  type DayRelation,
} from "@/lib/tripStatus";
import { getWatch } from "@/lib/notifications";
import { initialTimetableView, saveTimetableView } from "@/lib/viewState";
import { cn, normalizeSearchText } from "@/lib/utils";

interface TimetableViewProps {
  stops: Stop[];
  liveVehicles: LiveVehicle[];
  onFocusTrip: (tripId: string, vehicleId?: string) => void;
  /** A GTFS naptári érvényessége (YYYYMMDD) — ezen kívülre nincs élő menetrend. */
  serviceRange: { from: string; to: string } | null;
  /** Az elrakott menetrend tartománya — a naptár eddig enged visszalépni. */
  archiveRange: { from: string; to: string; days: number } | null;
}

function secondsSinceMidnight(d: Date) {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

/** YYYYMMDD ↔ YYYY-MM-DD: a backend az előbbit, az <input type="date"> az utóbbit érti. */
const ymdToIso = (ymd: string) =>
  `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const isoToYmd = (iso: string) => iso.replace(/-/g, "");

function todayIso(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

const clampIso = (iso: string, min: string | null, max: string | null) =>
  min && iso < min ? min : max && iso > max ? max : iso;

function DayPicker({
  value,
  onChange,
  min,
  max,
  className,
}: {
  value: string;
  onChange: (iso: string) => void;
  min: string | null;
  max: string | null;
  className?: string;
}) {
  const shift = (days: number) => {
    const d = new Date(`${value}T12:00:00`);
    d.setDate(d.getDate() + days);
    const next = d.toISOString().slice(0, 10);
    if ((min && next < min) || (max && next > max)) return;
    onChange(next);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-0.5",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => shift(-1)}
        disabled={Boolean(min) && value <= min!}
        aria-label="Előző nap"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>

      <label className="relative flex min-w-0 flex-1 items-center justify-center">
        <span className="sr-only">Menetrend napja</span>
        <CalendarDays
          aria-hidden
          className="pointer-events-none mr-1.5 h-3.5 w-3.5 shrink-0 text-primary"
        />
        <input
          type="date"
          value={value}
          min={min ?? undefined}
          max={max ?? undefined}
          onChange={(e) =>
            e.target.value && onChange(clampIso(e.target.value, min, max))
          }
          className="w-[7.5rem] bg-transparent text-center font-mono text-xs font-semibold tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => shift(1)}
        disabled={Boolean(max) && value >= max!}
        aria-label="Következő nap"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function TimetableView({
  stops,
  liveVehicles,
  onFocusTrip,
  serviceRange,
  archiveRange,
}: TimetableViewProps) {
  const restored = initialTimetableView();
  const [routes, setRoutes] = useState<TimetableRoute[]>([]);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(
    restored?.routeId ?? null,
  );
  const [selectedDir, setSelectedDir] = useState<string>(restored?.dir ?? "");
  const [table, setTable] = useState<TimetableResponse | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<TimetableTrip | null>(null);
  const pendingTripRef = useRef<string | null>(restored?.tripId ?? null);
  const { favorites, isFavorite, toggleFavorite } = useFavorites();

  // A naptár addig enged vissza, ameddig elrakott menetrend van: a GTFS feed
  // csak a következő pár hetet ismeri, a múltat az archívum őrzi.
  const from = [serviceRange?.from, archiveRange?.from].filter(Boolean).sort()[0];
  const to = [serviceRange?.to, archiveRange?.to].filter(Boolean).sort().pop();
  const minIso = from ? ymdToIso(from) : null;
  const maxIso = to ? ymdToIso(to) : null;
  const [date, setDate] = useState(todayIso());

  // A feed betöltése után derül ki, meddig ér az érvényesség — ha a mai nap
  // kilóg belőle, a legközelebbi érvényes napra igazítunk.
  useEffect(() => {
    setDate((prev) => clampIso(prev, minIso, maxIso));
  }, [minIso, maxIso]);

  const isToday = date === todayIso();
  const day = dayRelation(date, todayIso());

  // Mai napra élőben az MVK végpontjáról jön a lista, korábbi napra a backend
  // archívumából — a menetrendkönyv attól függetlenül tudja jelölni a törölt
  // meneteket, hogy visszalapoztunk-e a múltba.
  const cancelled = useCancelledTrips(isoToYmd(date), isToday);
  // A napló minden naplózott napra elérhető, nem csak a maira — így egy tegnapi
  // menetnél is látszik, melyik jármű vitte.
  const journal = useTripJournal(isoToYmd(date), day === "today" ? 60000 : 0);

  const [nowSec, setNowSec] = useState(() => secondsSinceMidnight(new Date()));
  useEffect(() => {
    const timer = setInterval(
      () => setNowSec(secondsSinceMidnight(new Date())),
      15000,
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .getTimetableRoutes(isoToYmd(date))
      .then((res) => {
        if (!alive) return;
        setRoutes(res.routes);
        setRoutesError(null);
      })
      .catch((err) => alive && setRoutesError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [date]);

  useEffect(() => {
    saveTimetableView({
      routeId: selectedRouteId,
      dir: selectedDir,
      tripId: selectedTrip?.tripId ?? null,
    });
  }, [selectedRouteId, selectedDir, selectedTrip]);

  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null;

  useEffect(() => {
    if (!selectedRouteId) {
      setTable(null);
      return;
    }
    let alive = true;
    setTableLoading(true);
    setSelectedTrip(null);
    api
      .getTimetable(selectedRouteId, selectedDir, isoToYmd(date))
      .then((res) => {
        if (!alive) return;
        setTable(res);
        const pending = pendingTripRef.current;
        if (!pending) return;
        pendingTripRef.current = null;
        const hit = res.trips.find((t) => t.tripId === pending);
        if (hit) setSelectedTrip(hit);
      })
      .catch(() => alive && setTable(null))
      .finally(() => alive && setTableLoading(false));
    return () => {
      alive = false;
    };
  }, [selectedRouteId, selectedDir, date]);

  const vehicleByTrip = useMemo(() => {
    const map = new Map<string, LiveVehicle>();
    liveVehicles.forEach((v) => {
      if (v.tripId) map.set(v.tripId, v);
    });
    return map;
  }, [liveVehicles]);

  const favoriteLines = useMemo(() => {
    const out: {
      route: TimetableRoute;
      dir: string;
      headsign: string;
      tripsToday: number;
    }[] = [];
    for (const fav of favorites) {
      const route = routes.find((r) => r.id === fav.routeId);
      const direction = route?.directions.find((d) => d.dir === fav.dir);
      if (!route || !direction) continue;
      out.push({
        route,
        dir: direction.dir,
        headsign: direction.headsign,
        tripsToday: direction.tripsToday,
      });
    }
    return out;
  }, [favorites, routes]);

  const visibleRoutes = useMemo(() => {
    const q = normalizeSearchText(query.trim());
    if (!q) return routes;
    return routes.filter(
      (r) =>
        normalizeSearchText(r.short).includes(q) ||
        normalizeSearchText(r.long).includes(q) ||
        r.directions.some((d) => normalizeSearchText(d.headsign).includes(q)),
    );
  }, [routes, query]);

  const selectRoute = (route: TimetableRoute) => {
    setSelectedRouteId(route.id);
    const withService =
      route.directions.find((d) => d.tripsToday > 0) ?? route.directions[0];
    setSelectedDir(withService?.dir ?? "");
  };

  // Egy kihúzott menethez tartozó jármű már nem ezt a menetet teljesíti, ezért
  // az „elindult” számból kimarad.
  const cancelledTripCount =
    table?.trips.filter((t) => cancelled.ids.has(t.tripId)).length ?? 0;
  const liveTripCount =
    day === "today"
      ? (table?.trips.filter(
          (t) => vehicleByTrip.has(t.tripId) && !cancelled.ids.has(t.tripId),
        ).length ?? 0)
      : 0;
  const cancelledByRoute = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of cancelled.trips) {
      if (!t.routeId) continue;
      map.set(t.routeId, (map.get(t.routeId) ?? 0) + 1);
    }
    return map;
  }, [cancelled.trips]);
  const selectedTripCancelled = selectedTrip
    ? cancelled.ids.has(selectedTrip.tripId)
    : false;
  const selectedVehicle =
    selectedTrip && !selectedTripCancelled
      ? (vehicleByTrip.get(selectedTrip.tripId) ?? null)
      : null;
  const dayLabel = new Date(`${date}T12:00:00`).toLocaleDateString("hu-HU", {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
  const runsWord = isToday ? "menet ma" : "menet ezen a napon";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {}
      <aside
        className={cn(
          "flex min-w-0 flex-col overflow-hidden border-border bg-card",
          "md:w-[260px] md:shrink-0 md:border-r lg:w-[300px]",
          selectedRoute ? "hidden md:flex" : "flex w-full",
        )}
      >
        <div className="shrink-0 border-b border-border px-3 py-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Járat vagy végállomás"
              aria-label="Járat keresése"
              className="pl-9"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[11px] text-muted-foreground">
              {visibleRoutes.length} járat · {dayLabel}
            </p>
            <HereChip stops={stops} />
          </div>

          <DayPicker
            value={date}
            onChange={setDate}
            min={minIso}
            max={maxIso}
            className="mt-2 w-full"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {routesError ? (
            <p
              role="alert"
              className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {routesError}
            </p>
          ) : visibleRoutes.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nincs „{query}” jelzésű járat.
            </p>
          ) : (
            <>
              {}
              {favoriteLines.length > 0 && !query.trim() ? (
                <section className="border-b border-border bg-muted/25 py-1">
                  <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Star
                      aria-hidden
                      className="h-3 w-3 fill-primary text-primary"
                    />
                    Kedvencek
                  </p>
                  <ul>
                    {favoriteLines.map((fav) => {
                      const isActive =
                        fav.route.id === selectedRouteId &&
                        fav.dir === selectedDir;
                      return (
                        <li key={favoriteKey(fav.route.id, fav.dir)}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedRouteId(fav.route.id);
                              setSelectedDir(fav.dir);
                            }}
                            aria-pressed={isActive}
                            className={cn(
                              "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-fast",
                              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                              isActive ? "bg-primary/10" : "hover:bg-accent",
                            )}
                          >
                            <RouteTile
                              short={fav.route.short}
                              color={fav.route.color}
                              text={fav.route.text}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">
                                {fav.headsign || fav.route.long}
                              </span>
                              <span className="block text-[11px] text-muted-foreground">
                                {fav.tripsToday > 0
                                  ? `${fav.tripsToday} ${runsWord}`
                                  : isToday
                                    ? "Ma nem közlekedik"
                                    : "Ezen a napon nem közlekedik"}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              <ul className="divide-y divide-border/60">
                {visibleRoutes.map((route) => {
                  const isActive = route.id === selectedRouteId;
                  const tripsToday = route.directions.reduce(
                    (n, d) => n + d.tripsToday,
                    0,
                  );
                  const cancelledOnRoute = cancelledByRoute.get(route.id) ?? 0;
                  return (
                    <li key={route.id}>
                      <button
                        type="button"
                        onClick={() => selectRoute(route)}
                        aria-pressed={isActive}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-fast",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                          isActive ? "bg-primary/10" : "hover:bg-accent",
                          tripsToday === 0 && !isActive && "opacity-55",
                        )}
                      >
                        <RouteTile
                          short={route.short}
                          color={route.color}
                          text={route.text}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {route.long}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {tripsToday > 0
                              ? `${tripsToday} ${runsWord}`
                              : isToday
                                ? "Ma nem közlekedik"
                                : "Ezen a napon nem közlekedik"}
                          </span>
                        </span>
                        {cancelledOnRoute > 0 ? (
                          <span
                            title={`${cancelledOnRoute} kihúzott menet ma ezen a járaton`}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 bg-destructive/12 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-destructive"
                          >
                            <Ban aria-hidden className="h-2.5 w-2.5" />
                            {cancelledOnRoute}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </aside>

      {}
      <div
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden",
          selectedRoute ? "flex" : "hidden md:flex",
        )}
      >
        {!selectedRoute ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <Card className="max-w-md p-8 text-center shadow-lg">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <Clock className="h-7 w-7" />
              </span>
              <h3 className="mt-4 text-lg font-bold tracking-tight">
                Válassz járatot
              </h3>
            </Card>
          </div>
        ) : (
          <>
            {}
            <div className="shrink-0 border-b border-border bg-card/70 px-3 py-3 sm:px-4">
              <div className="flex items-center gap-2.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 md:hidden"
                  onClick={() => setSelectedRouteId(null)}
                  aria-label="Vissza a járatlistához"
                >
                  <ChevronLeft />
                </Button>

                <RouteTile
                  short={selectedRoute.short}
                  color={selectedRoute.color}
                  text={selectedRoute.text}
                  size="lg"
                />

                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-bold tracking-tight sm:text-base">
                    {selectedRoute.long}
                  </h2>
                  <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>
                      {table ? `${table.trips.length} menet` : "betöltés…"}
                    </span>
                    {liveTripCount > 0 ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold text-live">
                        <LiveDot />
                        {liveTripCount} elindult
                      </span>
                    ) : null}
                    {cancelledTripCount > 0 ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-destructive">
                        <Ban aria-hidden className="h-3 w-3" />
                        {cancelledTripCount} törölve
                      </span>
                    ) : null}
                  </p>
                </div>

                {}
                <Button
                  variant={
                    isFavorite(selectedRoute.id, selectedDir)
                      ? "default"
                      : "outline"
                  }
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => toggleFavorite(selectedRoute.id, selectedDir)}
                  aria-pressed={isFavorite(selectedRoute.id, selectedDir)}
                  aria-label={
                    isFavorite(selectedRoute.id, selectedDir)
                      ? "Levétel a kedvencekről"
                      : "Hozzáadás a kedvencekhez"
                  }
                >
                  <Star
                    className={cn(
                      isFavorite(selectedRoute.id, selectedDir) &&
                        "fill-current",
                    )}
                  />
                </Button>

                <DayPicker
                  value={date}
                  onChange={setDate}
                  min={minIso}
                  max={maxIso}
                  className="hidden shrink-0 sm:flex"
                />
              </div>

              {}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selectedRoute.directions.map((d) => {
                  const isOn = d.dir === selectedDir;
                  return (
                    <button
                      key={d.dir}
                      type="button"
                      onClick={() => setSelectedDir(d.dir)}
                      aria-pressed={isOn}
                      className={cn(
                        "inline-flex min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-fast",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        isOn
                          ? "border-primary bg-primary text-primary-foreground shadow-sm"
                          : "border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <span className="max-w-[220px] truncate sm:max-w-[320px]">
                        {d.headsign || `Irány ${d.dir}`}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1 font-mono text-[10px] font-bold tabular-nums",
                          isOn ? "bg-primary-foreground/20" : "bg-muted",
                        )}
                      >
                        {d.tripsToday}
                      </span>
                    </button>
                  );
                })}
              </div>

              <DayPicker
                value={date}
                onChange={setDate}
                min={minIso}
                max={maxIso}
                className="mt-2.5 w-full sm:hidden"
              />

              {!selectedTrip ? (
                <HereChip stops={stops} className="mt-2.5 md:hidden" />
              ) : null}
            </div>

            {}
            {table &&
            table.trips.some((t) => t.deviates || t.headsignDiffers) ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground sm:px-4">
                {table.trips.some((t) => t.headsignDiffers) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-early" />
                    más célállomás, mint a viszonylat szokásos iránya (
                    {table.headsign})
                  </span>
                ) : null}
                {table.trips.some((t) => t.deviates) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                    a szokásos útvonalon kívüli megállót is érint (betérő)
                  </span>
                ) : null}
              </div>
            ) : null}

            {}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tableLoading ? (
                <p className="px-4 py-10 text-center font-mono text-xs text-muted-foreground">
                  Menetrend betöltése…
                </p>
              ) : !table || table.trips.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {table?.note ??
                    "Ezen az irányon ezen a napon nem közlekedik járat."}
                </p>
              ) : (
                <TimetableGrid
                  trips={table.trips}
                  vehicleByTrip={vehicleByTrip}
                  cancelledTripIds={cancelled.ids}
                  journal={journal}
                  selectedTripId={selectedTrip?.tripId ?? null}
                  onSelectTrip={(t) =>
                    setSelectedTrip((prev) =>
                      prev?.tripId === t.tripId ? null : t,
                    )
                  }
                  nowSec={nowSec}
                  day={day}
                  directionHeadsign={table.headsign}
                />
              )}
            </div>

            {}
            {selectedTrip && table ? (
              <TripDetail
                trip={selectedTrip}
                stops={table.stops}
                routeShort={selectedRoute.short}
                vehicle={selectedVehicle}
                cancelled={selectedTripCancelled}
                journalEntry={journal.get(selectedTrip.tripId) ?? null}
                nowSec={nowSec}
                day={day}
                onClose={() => setSelectedTrip(null)}
                onFocusTrip={onFocusTrip}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function TripDetail({
  trip,
  stops,
  routeShort,
  vehicle,
  cancelled,
  journalEntry,
  nowSec,
  day,
  onClose,
  onFocusTrip,
}: {
  trip: TimetableTrip;
  stops: TimetableResponse["stops"];
  routeShort: string;
  vehicle: LiveVehicle | null;
  /** A menet ki van húzva: nem késik, hanem el sem indul. */
  cancelled: boolean;
  /** A gateway naplója szerint melyik jármű teljesítette ezt a menetet. */
  journalEntry: TripJournalEntry | null;
  nowSec: number;
  day: DayRelation;
  onClose: () => void;
  onFocusTrip: (tripId: string, vehicleId?: string) => void;
}) {
  const [notifyTarget, setNotifyTarget] = useState<{
    stop: TimetableResponse["stops"][number];
    isDeparture: boolean;
  } | null>(null);
  // Bármelyik megállóhoz állítható értesítés (nem csak a kiindulóhoz) — az
  // első a "indul", a többi "ideér" szövegezést kap.
  const watchedStopIndex = stops.findIndex(
    (s) => getWatch(s.id)?.tripId === trip.tripId,
  );

  const state = tripRunState({
    cancelled,
    hasLiveVehicle: vehicle !== null,
    departureSec: trip.departureSec,
    arrivalSec: trip.arrivalSec,
    nowSec,
    day,
  });
  // A naplózott jármű a menet UTÁN is megvan — a térképen ilyenkor már máshol
  // jár, de az utasnak pont az a kérdés, hogy „melyik busz vitte ezt". Egy még
  // el sem indult menetnél viszont nem mutatjuk: az csak feed-zaj lehetne.
  const pastVehicleId = showsJournalVehicle(state)
    ? (journalEntry?.vehicleId ?? null)
    : null;
  // Ha a futás-összegző úgyis kiírja a járművet, a fejlécben ne ismételjük.
  const showRunSummary = Boolean(
    !cancelled && journalEntry && state !== "scheduled",
  );
  const statusLabel = tripRunLabel(
    state,
    showRunSummary ? null : pastVehicleId,
  );

  return (
    <div className="max-h-[42vh] shrink-0 overflow-y-auto border-t border-border bg-card shadow-xl">
      <div className="sticky top-0 z-10 bg-card">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
          <span
            className={cn(
              "font-mono text-xl font-bold tabular-nums",
              cancelled && "text-destructive line-through decoration-2",
            )}
          >
            {trip.departure}
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">
              {trip.destinationName}
            </span>
            <span className="block font-mono text-[11px] tabular-nums text-muted-foreground">
              érkezés {trip.arrival} · {trip.stopCount} megálló
              {trip.deviates ? " · betérő" : ""}
              {trip.headsignDiffers ? " · eltérő célállomás" : ""}
            </span>
            {}
            {!cancelled && statusLabel && (vehicle || pastVehicleId) ? (
              <span
                className={cn(
                  "block text-[11px] font-semibold",
                  state === "live" ? "text-live" : "text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
            ) : null}
          </span>

          {cancelled ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/50 bg-destructive/12 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-destructive">
              <Ban aria-hidden className="h-3 w-3" />
              Törölve
            </span>
          ) : vehicle ? (
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={() => onFocusTrip(trip.tripId, vehicle.id)}
            >
              <Crosshair />
              <span className="font-mono tabular-nums">{vehicle.id}</span>
              <span className="hidden sm:inline">a térképen</span>
            </Button>
          ) : pastVehicleId ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              title={`${pastVehicleId} teljesítette ezt a menetet — megnézem, hol jár most`}
              onClick={() => onFocusTrip(trip.tripId, pastVehicleId)}
            >
              <Bus />
              <span className="font-mono tabular-nums">{pastVehicleId}</span>
              <span className="hidden sm:inline">
                {state === "finished" ? "vitte" : "viszi"}
              </span>
            </Button>
          ) : statusLabel ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {statusLabel}
            </span>
          ) : null}

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onClose}
            aria-label="Menet részleteinek bezárása"
          >
            <X />
          </Button>
        </div>

        {cancelled ? (
          <p className="border-b border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:px-4">
            Az MVK kihúzta ezt a menetet — ma nem közlekedik. Válassz másik
            indulást.
          </p>
        ) : showRunSummary && journalEntry ? (
          <RunSummary entry={journalEntry} />
        ) : null}
      </div>

      {notifyTarget ? (
        <TripNotifyDialog
          open={Boolean(notifyTarget)}
          onOpenChange={(o) => !o && setNotifyTarget(null)}
          stopId={notifyTarget.stop.id}
          stopName={notifyTarget.stop.name}
          tripId={trip.tripId}
          routeShort={routeShort}
          isDeparture={notifyTarget.isDeparture}
          departureLabel={
            trip.times[stops.findIndex((s) => s.id === notifyTarget.stop.id)] ??
            trip.departure
          }
        />
      ) : null}

      {vehicle ? (
        <TripProgressRail
          trip={trip}
          vehicleId={vehicle.id}
          stopNames={stops.map((s) => s.name)}
        />
      ) : (
        <>
          {!cancelled && state === "scheduled" ? (
            <p className="px-3 pt-2 text-[11px] text-muted-foreground sm:px-4">
              Koppints egy megálló csengőjére, hogy szóljunk, mielőtt a busz
              odaér.
            </p>
          ) : null}
          <ol className="columns-1 gap-x-8 px-3 py-2 sm:columns-2 sm:px-4 lg:columns-3">
            {stops.map((stop, i) => {
              const time = trip.times[i];
              if (!time) return null;
              const isWatchingThisStop = watchedStopIndex === i;
              return (
                <li
                  key={stop.id}
                  className="flex break-inside-avoid items-center justify-between gap-2 border-b border-border/40 py-1.5"
                >
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {stop.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold tabular-nums">
                      {time}
                    </span>
                    {!cancelled && state === "scheduled" ? (
                      <button
                        type="button"
                        onClick={() =>
                          setNotifyTarget({ stop, isDeparture: i === 0 })
                        }
                        aria-label={`Értesítés beállítása — ${stop.name}`}
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                          isWatchingThisStop && "text-primary hover:text-primary",
                        )}
                      >
                        {isWatchingThisStop ? (
                          <BellRing className="h-3.5 w-3.5" />
                        ) : (
                          <Bell className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
