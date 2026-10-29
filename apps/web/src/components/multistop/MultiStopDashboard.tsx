import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Check, LocateFixed, MonitorPlay, Plus, Radar, Ticket } from "lucide-react";
import type { Stop } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { distanceKm } from "@/lib/geo";
import { AddStopModal } from "./AddStopModal";
import { StopCard } from "./StopCard";
import { StopCarousel } from "./StopCarousel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn, normalizeSearchText } from "@/lib/utils";
import { RidesPanel } from "@/components/ride/RidesPanel";
import { CommuteCard } from "./CommuteCard";
import { MENU_ITEM, MoreMenu } from "./MoreMenu";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/** a megállókártyák rácsa asztalon: 340–400 px széles oszlopok, középre igazítva */
// auto-fit: az üres oszlopok összeesnek, így a meglévő kártyák valóban középre kerülnek (auto-fill mellett
// a ki nem töltött oszlopok is helyet foglaltak, és a kártyák balra csúsztak)
const STOP_GRID = "grid justify-center gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,340px),400px))]";

type WatchView = "stops" | "rides";
const VIEW_KEY = "mvk_watch_view";
const WATCH_VIEWS: { id: WatchView; label: string; icon: typeof Radar }[] = [
  { id: "stops", label: "Megállók", icon: Radar },
  { id: "rides", label: "Utazásaim", icon: Ticket },
];

const QUICK_STOPS = [
  { label: "Tiszai pályaudvar", match: "Tiszai" },
  { label: "Búza tér", match: "Búza" },
  { label: "Villanyrendőr", match: "Villany" },
  { label: "Újgyőri főtér", match: "Újgyőri" },
  { label: "Avas kilátó", match: "Avas kilátó" },
  { label: "Miskolctapolca, Barlangfürdő", match: "Tapolca" },
];

interface MultiStopDashboardProps {
  stops: Stop[];
  selectedStopIds: string[];
  setSelectedStopIds: React.Dispatch<React.SetStateAction<string[]>>;
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void;
  /** értesítésből nyitott megálló: a kártyája kerüljön elő */
  focusStop?: { id: string } | null;
}

export function MultiStopDashboard({
  stops,
  selectedStopIds,
  setSelectedStopIds,
  onFocusMap,
  focusStop,
}: MultiStopDashboardProps) {
  const isWide = useMediaQuery("(min-width: 768px)");
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [isReordering, setReordering] = useState(false);
  const geo = useGeo();

  // Megállók vagy a saját utazásaim (az utazásnapló a Statisztikából került ide).
  const [view, setViewState] = useState<WatchView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "rides" ? "rides" : "stops";
    } catch {
      return "stops";
    }
  });
  const setView = (next: WatchView) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* privát mód */
    }
  };

  // Értesítésből érkező megálló: a megállók nézete kell, nem a napló.
  useEffect(() => {
    if (focusStop) setViewState("stops");
  }, [focusStop]);

  const [nearestFirst, setNearestFirst] = useState(() => {
    try {
      return localStorage.getItem("mvk_watch_nearest_first") !== "0";
    } catch {
      return true;
    }
  });

  const toggleNearestFirst = () =>
    setNearestFirst((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("mvk_watch_nearest_first", next ? "1" : "0");
      } catch {}
      return next;
    });

  const stopById = useMemo(() => {
    const map = new Map<string, Stop>();
    stops.forEach((s) => map.set(s.id, s));
    return map;
  }, [stops]);

  const manualOrder = selectedStopIds
    .map((id) => stopById.get(id))
    .filter((s): s is Stop => s !== undefined);

  const distances = useMemo(() => {
    const map = new Map<string, number>();
    if (!geo.position) return map;
    const { lat, lon } = geo.position;
    manualOrder.forEach((s) =>
      map.set(s.id, distanceKm(lat, lon, s.lat, s.lon)),
    );
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.position, selectedStopIds, stopById]);

  const sortByDistance = nearestFirst && !isReordering && distances.size > 0;

  const watched = sortByDistance
    ? [...manualOrder].sort(
        (a, b) => (distances.get(a.id) ?? 1e9) - (distances.get(b.id) ?? 1e9),
      )
    : manualOrder;

  const nearestId = sortByDistance ? (watched[0]?.id ?? null) : null;

  // Asztalon a rácsban görgetünk a hivatkozott megálló kártyájához.
  const scrolledFocusRef = useRef<{ id: string } | null>(null);
  const focusShown = focusStop ? watched.some((s) => s.id === focusStop.id) : false;
  useEffect(() => {
    if (!isWide || !focusStop || !focusShown || scrolledFocusRef.current === focusStop) return;
    scrolledFocusRef.current = focusStop;
    requestAnimationFrame(() =>
      document.querySelector(`[data-stop-card="${CSS.escape(focusStop.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }, [isWide, focusStop, focusShown]);

  const removeStop = (stopId: string) =>
    setSelectedStopIds((prev) => prev.filter((id) => id !== stopId));

  const toggleStop = (stopId: string) =>
    setSelectedStopIds((prev) =>
      prev.includes(stopId)
        ? prev.filter((id) => id !== stopId)
        : [...prev, stopId],
    );

  const moveStop = (stopId: string, delta: number) =>
    setSelectedStopIds((prev) => {
      const from = prev.indexOf(stopId);
      if (from < 0) return prev;
      const to = from + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const addByName = (needle: string) => {
    const q = normalizeSearchText(needle);
    const found = stops.find(
      (s) =>
        normalizeSearchText(s.name).includes(q) ||
        s.id.toLowerCase().includes(q),
    );
    if (found) toggleStop(found.id);
  };

  const canNearest = manualOrder.length > 1 && Boolean(geo.position);
  // helyzet nélkül a „legközelebbi elöl” nem rendez: ilyenkor is lehessen kézzel sorba tenni
  const canReorder = watched.length > 1 && !sortByDistance;
  const kioskHref = watched.length ? `/kijelzo?m=${encodeURIComponent(watched.slice(0, 3).map((s) => s.id).join(","))}` : null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3 py-2.5 sm:px-4 sm:py-3">
        {/* A nézetváltó kitölti a szabad szélességet (egyenlő fülek): nincs üres lyuk a fejlécben. */}
        <div role="tablist" aria-label="Figyelő nézet" className="flex min-w-0 flex-1 gap-1 rounded-lg border border-border bg-muted/60 p-1">
          {WATCH_VIEWS.map((v) => {
            const on = view === v.id;
            const Icon = v.icon;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setView(v.id)}
                className={cn(
                  "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors duration-fast",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{v.label}</span>
              </button>
            );
          })}
        </div>

        {view === "stops" ? (
          <>
            {/* Asztalon kiírva… */}
            <div className="hidden shrink-0 items-center gap-2 sm:flex">
              {canNearest ? (
                <Button
                  variant={nearestFirst ? "default" : "outline"}
                  size="sm"
                  className="h-10"
                  onClick={toggleNearestFirst}
                  aria-pressed={nearestFirst}
                  title="Legközelebbi megálló elöl"
                >
                  <LocateFixed />
                  Legközelebbi elöl
                </Button>
              ) : null}
              {canReorder ? (
                <Button variant={isReordering ? "default" : "outline"} size="sm" className="h-10" onClick={() => setReordering((v) => !v)} aria-pressed={isReordering}>
                  {isReordering ? <Check /> : <ArrowLeftRight />}
                  {isReordering ? "Kész" : "Sorrend"}
                </Button>
              ) : null}
              {kioskHref ? (
                <Button asChild variant="outline" size="sm" className="h-10" title="Utastájékoztató kijelző tévére vagy tabletre (legfeljebb 3 megálló)">
                  <a href={kioskHref}>
                    <MonitorPlay />
                    Kijelző
                  </a>
                </Button>
              ) : null}
            </div>

            {/* …telefonon egy „⋯” menüben, hogy a nézetváltó kiférjen. */}
            {canNearest || canReorder || kioskHref ? (
              <MoreMenu className="sm:hidden">
                {canNearest ? (
                  <button type="button" role="menuitemcheckbox" aria-checked={nearestFirst} className={MENU_ITEM} onClick={toggleNearestFirst}>
                    <LocateFixed />
                    <span className="flex-1">Legközelebbi elöl</span>
                    {nearestFirst ? <Check className="!text-primary" /> : null}
                  </button>
                ) : null}
                {canReorder ? (
                  <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setReordering((v) => !v)}>
                    {isReordering ? <Check /> : <ArrowLeftRight />}
                    <span className="flex-1">{isReordering ? "Sorrend kész" : "Sorrend módosítása"}</span>
                  </button>
                ) : null}
                {kioskHref ? (
                  <a role="menuitem" href={kioskHref} className={MENU_ITEM}>
                    <MonitorPlay />
                    <span className="flex-1">Kijelző tévére</span>
                  </a>
                ) : null}
              </MoreMenu>
            ) : null}

            <Button onClick={() => setPickerOpen(true)} className="h-10 shrink-0" aria-label="Megálló felvétele">
              <Plus />
              <span className="hidden sm:inline">Megálló felvétele</span>
              {selectedStopIds.length > 0 ? (
                <span className="rounded bg-primary-foreground/20 px-1.5 py-px font-mono text-[10px] font-bold tabular-nums">
                  {selectedStopIds.length}
                </span>
              ) : null}
            </Button>
          </>
        ) : null}
      </div>

      {view === "rides" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1100px] space-y-4 px-3 py-3 sm:px-4 sm:py-4">
            <RidesPanel />
          </div>
        </div>
      ) : null}

      {/* Csak az egyik nézet él (a másik nem csak elrejtve): különben minden
          megálló kétszer kérné le az indulásokat és kétszer értesítene. */}
      {/* A naplóból felismert szokásos utad (csak a szokásos idő körül látszik). */}
      {view === "stops" && !isWide ? <CommuteCard className="mx-4 mt-3 shrink-0" /> : null}

      {view === "stops" && watched.length > 0 && !isWide ? (
        <div className="min-h-0 flex-1 overflow-hidden pt-4">
          <StopCarousel
            stops={watched}
            onRemove={removeStop}
            onFocusMap={onFocusMap}
            isReordering={isReordering}
            onMove={moveStop}
            distances={distances}
            nearestId={nearestId}
            focusStop={focusStop}
          />
        </div>
      ) : null}

      {view === "stops" && (watched.length === 0 || isWide) ? (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isWide ? <CommuteCard className="mx-auto mb-4 w-full max-w-[400px]" /> : null}
        {watched.length === 0 && stops.length === 0 && selectedStopIds.length > 0 ? (
          // a megállólista még nem jött meg: a figyelt megállók nem vesztek el
          <p className="mx-auto max-w-xl py-10 text-center text-sm text-muted-foreground">Megállók betöltése…</p>
        ) : watched.length === 0 ? (
          <Card className="mx-auto max-w-xl p-6 text-center shadow-lg sm:p-8">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Radar className="h-7 w-7" />
            </span>
            <h3 className="mt-4 text-lg font-bold tracking-tight">
              A figyelő üres
            </h3>
            <Button
              size="lg"
              className="mt-5"
              onClick={() => setPickerOpen(true)}
            >
              <Plus />
              Megállók böngészése
            </Button>

            <div className="mt-8 border-t border-border pt-5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Gyakori csomópontok
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {QUICK_STOPS.map((preset) => (
                  <Button
                    key={preset.match}
                    variant="outline"
                    size="sm"
                    onClick={() => addByName(preset.match)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          </Card>
        ) : (
          // Asztalon minden megálló ugyanakkora, keskeny kártya (mint a telefonon):
          // annyi fér egymás mellé, amennyi kifér, a sor középre igazítva —
          // nem nyúlnak szét a képernyő szélességére, akárhány megállót figyelsz.
          <div className={STOP_GRID}>
            {watched.map((stop, i) => (
              <StopCard
                key={stop.id}
                stop={stop}
                onRemove={removeStop}
                onFocusMap={onFocusMap}
                distanceKm={distances.get(stop.id) ?? null}
                isNearest={stop.id === nearestId}
                reorder={
                  isReordering
                    ? {
                        onMoveEarlier: () => moveStop(stop.id, -1),
                        onMoveLater: () => moveStop(stop.id, 1),
                        canMoveEarlier: i > 0,
                        canMoveLater: i < watched.length - 1,
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>
      ) : null}

      <AddStopModal
        isOpen={isPickerOpen}
        onClose={() => setPickerOpen(false)}
        stops={stops}
        selectedStopIds={selectedStopIds}
        onToggleStop={toggleStop}
      />
    </div>
  );
}
