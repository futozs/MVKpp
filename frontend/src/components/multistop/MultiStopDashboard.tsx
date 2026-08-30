import React, { useMemo, useState } from 'react'
import { Plus, Radar } from 'lucide-react'
import type { Stop } from '@/types'
import { AddStopModal } from './AddStopModal'
import { StopCard } from './StopCard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

const MAX_STOPS = 6

/** Miskolc gyakran figyelt csomópontjai — valós megállók, nem helykitöltők. */
const QUICK_STOPS = [
  { label: 'Tiszai pályaudvar', match: 'Tiszai' },
  { label: 'Búza tér', match: 'Búza' },
  { label: 'Villanyrendőr', match: 'Villany' },
  { label: 'Újgyőri főtér', match: 'Újgyőri' },
  { label: 'Avas kilátó', match: 'Avas kilátó' },
  { label: 'Miskolctapolca, Barlangfürdő', match: 'Tapolca' },
]

interface MultiStopDashboardProps {
  stops: Stop[]
  selectedStopIds: string[]
  setSelectedStopIds: React.Dispatch<React.SetStateAction<string[]>>
  onFocusMap: (stop: Stop, vehicleTripId?: string, vehicleId?: string) => void
}

export function MultiStopDashboard({
  stops,
  selectedStopIds,
  setSelectedStopIds,
  onFocusMap,
}: MultiStopDashboardProps) {
  const [isPickerOpen, setPickerOpen] = useState(false)

  const stopById = useMemo(() => {
    const map = new Map<string, Stop>()
    stops.forEach((s) => map.set(s.id, s))
    return map
  }, [stops])

  const watched = selectedStopIds
    .map((id) => stopById.get(id))
    .filter((s): s is Stop => s !== undefined)

  const removeStop = (stopId: string) =>
    setSelectedStopIds((prev) => prev.filter((id) => id !== stopId))

  const toggleStop = (stopId: string) =>
    setSelectedStopIds((prev) => {
      if (prev.includes(stopId)) return prev.filter((id) => id !== stopId)
      if (prev.length >= MAX_STOPS) return prev
      return [...prev, stopId]
    })

  const addByName = (needle: string) => {
    const found = stops.find(
      (s) =>
        s.name.toLowerCase().includes(needle.toLowerCase()) ||
        s.id.toLowerCase().includes(needle.toLowerCase())
    )
    if (found) toggleStop(found.id)
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card/60 px-4 py-3">
        <div>
          <h2 className="text-base font-bold tracking-tight">Megállófigyelő</h2>
          <p className="text-xs text-muted-foreground">
            Élő indulások legfeljebb {MAX_STOPS} megállóból, négymásodperces frissüléssel.
          </p>
        </div>

        <Button
          onClick={() => setPickerOpen(true)}
          disabled={selectedStopIds.length >= MAX_STOPS}
          className="shadow-glow"
        >
          <Plus />
          Megálló felvétele
          <span className="ml-0.5 rounded bg-primary-foreground/20 px-1.5 py-px font-mono text-[10px] font-bold tabular-nums">
            {selectedStopIds.length}/{MAX_STOPS}
          </span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {watched.length === 0 ? (
          <Card className="mx-auto max-w-xl p-8 text-center shadow-lg">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Radar className="h-7 w-7" />
            </span>
            <h3 className="mt-4 text-lg font-bold tracking-tight">A figyelő üres</h3>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
              Vedd fel azokat a megállókat, amiket rendszeresen nézel. Mindegyikről látni fogod a
              következő járatot, a hozzá tartozó buszt és azt, hogy épp merre jár.
            </p>

            <Button size="lg" className="mt-5 shadow-glow" onClick={() => setPickerOpen(true)}>
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
                ? 'mx-auto grid max-w-lg gap-4'
                : watched.length === 2
                  ? 'mx-auto grid max-w-5xl gap-4 lg:grid-cols-2'
                  : watched.length <= 4
                    ? 'grid gap-4 md:grid-cols-2'
                    : 'grid gap-4 md:grid-cols-2 xl:grid-cols-3'
            }
          >
            {watched.map((stop) => (
              <StopCard
                key={stop.id}
                stop={stop}
                onRemove={removeStop}
                onFocusMap={onFocusMap}
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
        maxStops={MAX_STOPS}
      />
    </div>
  )
}
