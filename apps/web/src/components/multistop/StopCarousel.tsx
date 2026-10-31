import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Stop } from "@/types";
import { StopCard } from "./StopCard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TRACK_PADDING = 16;

type StopCarouselProps = {
  stops: Stop[];
  onRemove: (stopId: string) => void;
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void;
  isReordering?: boolean;
  onMove?: (stopId: string, delta: number) => void;
  distances?: Map<string, number>;
  nearestId?: string | null;
  /** értesítésből nyitott megálló: ennek a kártyájára lapozunk (és ott is maradunk) */
  focusStop?: { id: string } | null;
  /** további kártyák a megállók után (viszonylat, vonatszám) */
  extra?: { key: string; label: string; node: ReactNode }[];
};

export function StopCarousel({
  stops,
  onRemove,
  onFocusMap,
  isReordering,
  onMove,
  distances,
  nearestId,
  focusStop,
  extra = [],
}: StopCarouselProps) {
  const total = stops.length + extra.length;
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const appliedFocusRef = useRef<{ id: string } | null>(null);

  const nearestIndex = useCallback(() => {
    const track = trackRef.current;
    if (!track) return 0;
    const viewportCenter =
      track.getBoundingClientRect().left + track.clientWidth / 2;

    let nearest = 0;
    let nearestDistance = Infinity;
    Array.from(track.children).forEach((node, i) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = i;
      }
    });
    return nearest;
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onScroll = () => setIndex(nearestIndex());
    track.addEventListener("scroll", onScroll, { passive: true });
    return () => track.removeEventListener("scroll", onScroll);
  }, [nearestIndex]);

  useEffect(() => {
    setIndex((prev) => Math.min(prev, Math.max(0, total - 1)));
  }, [total]);

  // A megállók a viszonylat- és vonatkártyák után töltődnek be (a GTFS-listából): a böngésző
  // ilyenkor a már látott kártyán tartaná a görgetést — az első betöltéskor az elejére ugrunk.
  const hadStopsRef = useRef(stops.length > 0);
  useEffect(() => {
    if (hadStopsRef.current || !stops.length) return;
    hadStopsRef.current = true;
    if (appliedFocusRef.current || !extra.length) return;
    requestAnimationFrame(() => {
      trackRef.current?.scrollTo({ left: 0 });
      setIndex(0);
    });
  }, [stops.length, extra.length]);

  useEffect(() => {
    // A hivatkozott megálló kártyáját nem lapozza el a „legközelebbi elöl”.
    if (!nearestId || appliedFocusRef.current) return;
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: 0, behavior: "smooth" });
    setIndex(0);
  }, [nearestId]);

  const scrollToCard = (target: number) => {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.min(total - 1, Math.max(0, target));
    const child = track.children[clamped] as HTMLElement | undefined;
    if (!child) return;

    const left =
      child.getBoundingClientRect().left -
      track.getBoundingClientRect().left +
      track.scrollLeft -
      TRACK_PADDING;

    track.scrollLeft = Math.max(
      0,
      Math.min(track.scrollWidth - track.clientWidth, left),
    );
    setIndex(clamped);
  };

  const step = (delta: number) => scrollToCard(nearestIndex() + delta);

  useEffect(() => {
    if (!focusStop || appliedFocusRef.current === focusStop) return;
    const i = stops.findIndex((s) => s.id === focusStop.id);
    if (i < 0) return; // még nincs kint (épp most vettük fel) — a következő körben
    appliedFocusRef.current = focusStop;
    requestAnimationFrame(() => scrollToCard(i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusStop, stops]);

  const atStart = index <= 0;
  const atEnd = index >= total - 1;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={trackRef}
        className={cn(
          "flex min-h-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden",
          "overscroll-x-contain px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {stops.map((stop, i) => (
          <div
            key={stop.id}
            className="flex h-full w-full shrink-0 snap-center"
          >
            <StopCard
              stop={stop}
              onRemove={onRemove}
              onFocusMap={onFocusMap}
              distanceKm={distances?.get(stop.id) ?? null}
              isNearest={stop.id === nearestId}
              className="h-full w-full"
              reorder={
                isReordering && onMove
                  ? {
                      onMoveEarlier: () => onMove(stop.id, -1),
                      onMoveLater: () => onMove(stop.id, 1),
                      canMoveEarlier: i > 0,
                      canMoveLater: i < stops.length - 1,
                    }
                  : undefined
              }
            />
          </div>
        ))}
        {extra.map((x) => (
          <div key={x.key} className="flex h-full w-full shrink-0 snap-center">
            {x.node}
          </div>
        ))}
      </div>

      {}
      {total > 1 ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-4 py-2.5">
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10"
            onClick={() => step(-1)}
            disabled={atStart}
            aria-label="Előző megálló"
          >
            <ChevronLeft />
          </Button>

          {}
          <div className="flex min-w-0 flex-1 items-center justify-center">
            {total <= 8 ? (
              <div className="flex items-center gap-1.5">
                {[...stops.map((s) => ({ key: s.id, label: s.name })), ...extra].map((stop, i) => (
                  <button
                    key={stop.key}
                    type="button"
                    onClick={() => scrollToCard(i)}
                    aria-label={`Ugrás ide: ${stop.label}`}
                    aria-current={i === index ? "true" : undefined}
                    className={cn(
                      "h-2 rounded-full transition-all duration-fast",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      i === index
                        ? "w-6 bg-primary"
                        : "w-2 bg-muted-foreground/35",
                    )}
                  />
                ))}
              </div>
            ) : (
              <p className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                {index + 1} / {total}
              </p>
            )}
          </div>

          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10"
            onClick={() => step(1)}
            disabled={atEnd}
            aria-label="Következő megálló"
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
