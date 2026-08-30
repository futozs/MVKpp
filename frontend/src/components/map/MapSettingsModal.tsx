import { Check } from 'lucide-react'
import { TILE_LAYERS } from './TransitMap'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface MapSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  currentLayerId: string
  onSelectLayer: (layerId: string) => void
}

/**
 * Alaptérkép-választó.
 *
 * Csak olyan szolgáltatók szerepelnek, amelyek API-kulcs nélkül adnak
 * csempét — mindegyik le van ellenőrizve, hogy tényleg működik.
 */
export function MapSettingsModal({
  isOpen,
  onClose,
  currentLayerId,
  onSelectLayer,
}: MapSettingsModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="space-y-1 border-b border-border px-5 py-4 text-left">
          <DialogTitle>Alaptérkép</DialogTitle>
          <DialogDescription>
            A választás a böngészőben megjegyződik. Mindegyik szolgáltató ingyenes, kulcs nélkül.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-[60vh] overflow-y-auto divide-y divide-border/60">
          {TILE_LAYERS.map((layer) => {
            const selected = currentLayerId === layer.id
            return (
              <li key={layer.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectLayer(layer.id)
                    onClose()
                  }}
                  aria-pressed={selected}
                  className={cn(
                    'flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-fast',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                    selected ? 'bg-primary/10' : 'hover:bg-accent'
                  )}
                >
                  {/* Előnézeti folt: nagyjából amilyen a térkép alapszíne. */}
                  <span
                    aria-hidden
                    className={cn(
                      'h-9 w-9 shrink-0 rounded-lg border shadow-sm',
                      selected ? 'border-primary' : 'border-border'
                    )}
                    style={{ backgroundColor: layer.swatch }}
                  />

                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm',
                        selected ? 'font-semibold' : 'font-medium'
                      )}
                    >
                      {layer.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {layer.note}
                    </span>
                  </span>

                  {selected ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
