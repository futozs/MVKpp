import { useMemo, useState } from 'react'
import { Check, MapPin, Plus, Search } from 'lucide-react'
import type { Stop } from '@/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface AddStopModalProps {
  isOpen: boolean
  onClose: () => void
  stops: Stop[]
  selectedStopIds: string[]
  onToggleStop: (stopId: string) => void
  maxStops?: number
}

/** shadcn Dialog: fókuszcsapda, Escape, háttérkattintás és aria készen jön. */
export function AddStopModal({
  isOpen,
  onClose,
  stops,
  selectedStopIds,
  onToggleStop,
  maxStops = 6,
}: AddStopModalProps) {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return stops.slice(0, 60)
    return stops
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.code && s.code.toLowerCase().includes(q)) ||
          s.id.toLowerCase().includes(q)
      )
      .slice(0, 80)
  }, [stops, query])

  const atCapacity = selectedStopIds.length >= maxStops

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="space-y-1 border-b border-border px-5 py-4 text-left">
          <DialogTitle>Megálló felvétele a figyelőre</DialogTitle>
          <DialogDescription>
            {selectedStopIds.length} / {maxStops} hely foglalt. A figyelő minden megállóról a
            következő indulásokat mutatja.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-border px-5 py-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Név vagy megállókód — pl. Tiszai, Búza tér, SP1"
              aria-label="Megálló keresése"
              autoFocus
              className="pl-9"
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {results.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              Nincs „{query}” nevű megálló a menetrendben.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {results.map((stop) => {
                const selected = selectedStopIds.includes(stop.id)
                const blocked = !selected && atCapacity

                return (
                  <li key={stop.id}>
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => onToggleStop(stop.id)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors duration-fast',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                        selected ? 'bg-primary/10' : 'hover:bg-accent'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-fast',
                          selected
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {selected ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <MapPin className="h-4 w-4" />
                        )}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-sm',
                            selected ? 'font-semibold' : 'font-medium'
                          )}
                        >
                          {stop.name}
                        </span>
                        <span className="block font-mono text-[11px] tabular-nums text-muted-foreground">
                          {stop.code || stop.id}
                        </span>
                      </span>

                      {!selected ? (
                        <Plus aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {atCapacity
              ? `Betelt — vegyél le egyet a ${maxStops} közül`
              : `${maxStops - selectedStopIds.length} hely szabad`}
          </span>
          <Button size="sm" onClick={onClose}>
            Kész
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
