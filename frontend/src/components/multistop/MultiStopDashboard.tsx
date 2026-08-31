import React, { useMemo, useState } from "react";
import { ArrowLeftRight, Check, LocateFixed, Plus, Radar } from "lucide-react";
import type { Stop } from "@/types";
import { useGeo } from "@/context/GeoContext";
import { distanceKm } from "@/lib/geo";
import { AddStopModal } from "./AddStopModal";
import { NextDepartureBanner } from "./NextDepartureBanner";
import { StopCard } from "./StopCard";
import { StopCarousel } from "./StopCarousel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn, normalizeSearchText } from "@/lib/utils";

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
}

export function MultiStopDashboard({
  stops,
  selectedStopIds,
  setSelectedStopIds,
  onFocusMap,
}: MultiStopDashboardProps) {
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [isReordering, setReordering] = useState(false);
  const geo = useGeo();

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

  /**
   * A GPS ismeretében a hozzád legközelebbi figyelt megálló kerül előre — így
   * tíz felvett megálló mellett is az elsőt látod, amelyikre ténylegesen
   * ki fogsz állni. Sorrendezés közben a kézi sorrend érvényes.
   */
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

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold tracking-tight sm:text-base">
            Megállófigyelő
          </h2>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {manualOrder.length > 1 && geo.position ? (
            <Button
              variant={nearestFirst ? "default" : "outline"}
              size="sm"
              className="h-10"
              onClick={toggleNearestFirst}
              aria-pressed={nearestFirst}
              title="Legközelebbi megálló elöl"
            >
              <LocateFixed />
              <span className="hidden sm:inline">Legközelebbi elöl</span>
            </Button>
          ) : null}

          {watched.length > 1 && !nearestFirst ? (
            <Button
              variant={isReordering ? "default" : "outline"}
              size="sm"
              className="h-10"
              onClick={() => setReordering((v) => !v)}
              aria-pressed={isReordering}
            >
              {isReordering ? <Check /> : <ArrowLeftRight />}
              <span className="hidden sm:inline">
                {isReordering ? "Kész" : "Sorrend"}
              </span>
            </Button>
          ) : null}

          <Button onClick={() => setPickerOpen(true)} className="h-10">
            <Plus />
            <span className="hidden sm:inline">Megálló felvétele</span>
            {selectedStopIds.length > 0 ? (
              <span className="rounded bg-primary-foreground/20 px-1.5 py-px font-mono text-[10px] font-bold tabular-nums">
                {selectedStopIds.length}
              </span>
            ) : null}
          </Button>
        </div>
      </div>

      {watched.length > 1 ? (
        <div className="shrink-0 px-3 pt-3 sm:px-4">
          <NextDepartureBanner stops={watched} onFocusMap={onFocusMap} />
        </div>
      ) : null}

      {}
      {watched.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-hidden pt-4 md:hidden">
          <StopCarousel
            stops={watched}
            onRemove={removeStop}
            onFocusMap={onFocusMap}
            isReordering={isReordering}
            onMove={moveStop}
            distances={distances}
            nearestId={nearestId}
          />
        </div>
      ) : null}

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-4",
          watched.length > 0 && "hidden md:block",
        )}
      >
        {watched.length === 0 ? (
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
          <div
            className={
              watched.length === 1
                ? "mx-auto grid max-w-lg gap-4"
                : watched.length === 2
                  ? "mx-auto grid max-w-5xl gap-4 lg:grid-cols-2"
                  : watched.length <= 4
                    ? "grid gap-4 md:grid-cols-2"
                    : "grid gap-4 md:grid-cols-2 xl:grid-cols-3"
            }
          >
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
