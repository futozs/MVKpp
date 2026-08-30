import type { ReactNode } from 'react'
import { Bus, Timer } from 'lucide-react'
import type { Stop } from '@/types'
import { useGeo } from '@/context/GeoContext'
import { useApproach } from '@/hooks/useApproach'
import { formatDistance } from '@/lib/geo'
import { delaySentence, delayState, delayTone } from '@/components/transit/DelayBar'
import { HereChip } from '@/components/transit/HereChip'
import { cn } from '@/lib/utils'

interface ApproachStripProps {
  tripId: string | null
  shape: [number, number][] | undefined
  vehicle: { lat: number; lon: number; speed: number | null } | null
  stops: Stop[]
  /** Menetrendi eltérés a busz pillanatnyi helyén: + késik, − siet. */
  deviationSec?: number | null
  className?: string
}

/**
 * A követett járat és köztem lévő viszony egyetlen sávban.
 *
 * Két kérdésre válaszol, mert menet közben csak ez a kettő számít: hány
 * méterre van tőlem a busz, és mikor ér ide. Fölötte az áll, honnan nézve —
 * melyik megállónál vagyok éppen.
 */
export function ApproachStrip({
  tripId,
  shape,
  vehicle,
  stops,
  deviationSec,
  className,
}: ApproachStripProps) {
  const geo = useGeo()
  const approach = useApproach({ tripId, shape, vehicle, position: geo.position })

  const distance =
    approach.distanceKm != null ? formatDistance(approach.distanceKm) : '—'

  const distanceLabel =
    approach.state === 'passed'
      ? 'Ennyivel ment tovább'
      : approach.state === 'off-route'
        ? 'Távolság légvonalban'
        : 'Milyen messze van'

  const eta =
    approach.state === 'passed'
      ? 'Elhaladt'
      : approach.etaMin == null
        ? '—'
        : approach.etaMin <= 0
          ? 'Most'
          : `${approach.etaMin} perc`

  const etaHighlighted = approach.state === 'inbound' && approach.etaMin != null

  return (
    <section
      aria-label="A busz és a helyzetem"
      className={cn('border-t border-border bg-muted/25 px-4 py-2.5', className)}
    >
      <HereChip stops={stops} />

      {approach.state === 'no-gps' ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Kapcsold be a helymeghatározást, és itt látszik, hány méterre van tőled a busz, és
          hány perc múlva ér ide.
        </p>
      ) : approach.state === 'no-vehicle' ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Erre a menetre még nem jelentkezett be jármű.
        </p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Cell
              icon={<Bus aria-hidden className="h-3 w-3" />}
              label={distanceLabel}
              value={distance}
            />
            <Cell
              icon={<Timer aria-hidden className="h-3 w-3" />}
              label={approach.state === 'inbound' ? 'Ideér (becsült)' : 'Érkezés'}
              value={eta}
              highlighted={etaHighlighted}
            />
          </div>

          {approach.state === 'off-route' ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Ez a járat nem halad el melletted, ezért érkezési időt nem becsülünk.
            </p>
          ) : null}
        </>
      )}

      {delayState(deviationSec) !== 'unknown' ? (
        <p className={cn('mt-1.5 text-[11px] font-semibold', delayTone(deviationSec))}>
          {delaySentence(deviationSec)}
        </p>
      ) : null}
    </section>
  )
}

/** Egy szám a saját dobozában: fölötte halkan az, hogy mit jelent. */
function Cell({
  icon,
  label,
  value,
  highlighted = false,
}: {
  icon: ReactNode
  label: string
  value: string
  highlighted?: boolean
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg border px-2.5 py-1.5',
        highlighted ? 'border-primary/40 bg-primary/10' : 'border-border/70 bg-card'
      )}
    >
      <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </p>
      <p
        className={cn(
          'mt-0.5 truncate font-mono text-lg font-bold leading-none tabular-nums',
          highlighted ? 'text-primary' : 'text-foreground'
        )}
      >
        {value}
      </p>
    </div>
  )
}
