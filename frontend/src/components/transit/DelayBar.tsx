import { cn } from '@/lib/utils'

/** ±6 percen túl a sáv kifut a széléig; a szám mondja meg a pontos értéket. */
const SCALE_SEC = 360
/** Ennél kisebb eltérés pontosnak számít. */
const ON_TIME_SEC = 45

export type DelayState = 'ontime' | 'late' | 'early' | 'unknown'

export function delayState(sec: number | null | undefined): DelayState {
  if (sec == null) return 'unknown'
  if (Math.abs(sec) < ON_TIME_SEC) return 'ontime'
  return sec > 0 ? 'late' : 'early'
}

export function delayLabel(sec: number | null | undefined): string {
  const state = delayState(sec)
  if (state === 'unknown') return '—'
  if (state === 'ontime') return 'Pontos'
  const min = Math.max(1, Math.round(Math.abs(sec as number) / 60))
  return state === 'late' ? `+${min} perc` : `−${min} perc`
}

/**
 * Előjeles késés-sáv: a középvonaltól jobbra a lemaradás, balra a sietés.
 * Több sor egymás alatt egy pillantással összehasonlítható, mielőtt bárki
 * bármit elolvasna.
 */
export function DelayBar({
  delaySec,
  showLabel = true,
  className,
}: {
  delaySec: number | null | undefined
  showLabel?: boolean
  className?: string
}) {
  const state = delayState(delaySec)
  const magnitude =
    state === 'late' || state === 'early'
      ? Math.min(1, Math.abs(delaySec as number) / SCALE_SEC)
      : 0

  const fill =
    state === 'late' ? 'bg-late' : state === 'early' ? 'bg-early' : 'bg-ontime'
  const tone =
    state === 'late'
      ? 'text-late'
      : state === 'early'
        ? 'text-early'
        : state === 'ontime'
          ? 'text-ontime'
          : 'text-muted-foreground'

  return (
    <span
      className={cn('inline-flex items-center gap-2', className)}
      title={`Menetrendi eltérés: ${delayLabel(delaySec)}`}
    >
      <span
        aria-hidden
        className="relative block h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted"
      >
        {state === 'ontime' ? (
          <span className="absolute left-1/2 top-0 h-full w-2 -translate-x-1/2 rounded-full bg-ontime" />
        ) : magnitude > 0 ? (
          <span
            className={cn('absolute top-0 h-full rounded-full', fill)}
            style={{
              width: `${magnitude * 50}%`,
              left: state === 'late' ? '50%' : undefined,
              right: state === 'early' ? '50%' : undefined,
            }}
          />
        ) : null}
      </span>

      {showLabel ? (
        <span className={cn('font-mono text-[11px] font-semibold tabular-nums', tone)}>
          {delayLabel(delaySec)}
        </span>
      ) : null}
    </span>
  )
}
