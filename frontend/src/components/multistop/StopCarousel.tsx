import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Stop } from '@/types'
import { StopCard } from './StopCard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** A sáv vízszintes belső margója (px-4) — a kártya ehhez igazodik. */
const TRACK_PADDING = 16

type StopCarouselProps = {
  stops: Stop[]
  onRemove: (stopId: string) => void
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void
  isReordering?: boolean
  onMove?: (stopId: string, delta: number) => void
}

/**
 * Megállófigyelő telefonon.
 *
 * A kártyák egymás mellett, vízszintesen görgetve élnek — ujjal húzva
 * folyamatosan csúszik, a két nyílgomb pedig pontosan egy kártyát lapoz.
 * Így a teljes tábla látszik egyszerre, nem kell függőlegesen bányászni.
 */
export function StopCarousel({
  stops,
  onRemove,
  onFocusMap,
  isReordering,
  onMove,
}: StopCarouselProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)

  /**
   * A látható kártya sorszáma a MÉRT pozícióból: az, amelyiknek a közepe
   * legközelebb esik a sáv közepéhez. Se lépésköz-feltételezés, se
   * késleltetett React-állapot nem játszik bele.
   */
  const nearestIndex = useCallback(() => {
    const track = trackRef.current
    if (!track) return 0
    const viewportCenter = track.getBoundingClientRect().left + track.clientWidth / 2

    let nearest = 0
    let nearestDistance = Infinity
    Array.from(track.children).forEach((node, i) => {
      const rect = (node as HTMLElement).getBoundingClientRect()
      const distance = Math.abs(rect.left + rect.width / 2 - viewportCenter)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = i
      }
    })
    return nearest
  }, [])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const onScroll = () => setIndex(nearestIndex())
    track.addEventListener('scroll', onScroll, { passive: true })
    return () => track.removeEventListener('scroll', onScroll)
  }, [nearestIndex])

  // Ha kikerül egy megálló, ne ragadjon bent egy nem létező sorszám.
  useEffect(() => {
    setIndex((prev) => Math.min(prev, Math.max(0, stops.length - 1)))
  }, [stops.length])

  const scrollToCard = (target: number) => {
    const track = trackRef.current
    if (!track) return
    const clamped = Math.min(stops.length - 1, Math.max(0, target))
    const child = track.children[clamped] as HTMLElement | undefined
    if (!child) return

    const left =
      child.getBoundingClientRect().left -
      track.getBoundingClientRect().left +
      track.scrollLeft -
      TRACK_PADDING

    track.scrollLeft = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, left))
    // A görgetési esemény aszinkron; a sorszámot rögtön frissítjük, hogy a
    // pontsor és a gombok tiltása azonnal helyes legyen.
    setIndex(clamped)
  }

  /** Mindig a jelenlegi, mért kártyához képest lépünk. */
  const step = (delta: number) => scrollToCard(nearestIndex() + delta)

  const atStart = index <= 0
  const atEnd = index >= stops.length - 1

  return (
    <div className="flex h-full flex-col">
      <div
        ref={trackRef}
        className={cn(
          'flex min-h-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden',
          // Szándékosan NINCS `scroll-smooth`: a lágy görgetés több
          // környezetben (csökkentett mozgás, háttérbe került lap) egyszerűen
          // nem fut le, és a lapozógomb némán elnyeli a koppintást. Az
          // azonnali ugrás mindenhol működik.
          'px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {stops.map((stop, i) => (
          <div key={stop.id} className="flex h-full w-[86vw] max-w-sm shrink-0 snap-center">
            <StopCard
              stop={stop}
              onRemove={onRemove}
              onFocusMap={onFocusMap}
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
      </div>

      {/* Lapozó — hüvelykujjal elérhető méretben, a képernyő alján. */}
      {stops.length > 1 ? (
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

          {/* Pontsor: hol tartunk a figyelt megállók között. */}
          <div className="flex items-center gap-1.5">
            {stops.map((stop, i) => (
              <button
                key={stop.id}
                type="button"
                onClick={() => scrollToCard(i)}
                aria-label={`Ugrás ide: ${stop.name}`}
                aria-current={i === index ? 'true' : undefined}
                className={cn(
                  'h-2 rounded-full transition-all duration-fast',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  i === index ? 'w-6 bg-primary' : 'w-2 bg-muted-foreground/35'
                )}
              />
            ))}
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
  )
}
