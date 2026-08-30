import { AlertTriangle, DatabaseZap, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { QueryState } from './useStatsQuery'

/**
 * A lekérdezés három nem-sikeres állapotát mutatja meg, mindegyiket a maga
 * hangnemén: a betöltés semleges, az „adatraktár nem fut" tájékoztatás, és
 * csak a valódi hiba piros. Ez a különbségtétel azért fontos, mert a leállt
 * adatbázis nem hiba — a rendszer valós idejű része ilyenkor is működik.
 */
export function QueryBoundary<T>({
  query,
  children,
  empty,
}: {
  query: QueryState<T>
  children: (data: T) => ReactNode
  /** Igaz, ha a betöltött adat üres — így a panel maga döntheti el, mi az. */
  empty?: (data: T) => boolean
}) {
  if (query.unavailable) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
        <DatabaseZap className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-semibold">Az adatraktár nem érhető el</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          A statisztika MySQL-t használ. Ellenőrizd, hogy fut-e, és lefutott-e a{' '}
          <code className="font-mono">npm run db:migrate</code>. A valós idejű funkciók ettől
          függetlenül működnek.
        </p>
      </div>
    )
  }

  if (query.error) {
    return (
      <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">{query.error}</span>
      </div>
    )
  }

  if (query.loading && !query.data) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card px-6 py-10 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Betöltés…
      </div>
    )
  }

  if (!query.data || (empty && empty(query.data))) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
        <p className="text-sm font-semibold">Erre az időszakra még nincs adat</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A gyűjtés folyamatos — a mutatók az adat gyűlésével töltődnek fel.
        </p>
      </div>
    )
  }

  return <>{children(query.data)}</>
}

/** Görgethető pirulasor választáshoz — mobilon is használható marad. */
export function PillPicker<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: { id: T; label: string; sub?: string; color?: string | null }[]
  value: T | null
  onChange: (id: T) => void
  ariaLabel: string
}) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1" role="group" aria-label={ariaLabel}>
      <div className="flex min-w-max gap-1.5">
        {items.map((it) => {
          const active = it.id === value
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onChange(it.id)}
              aria-pressed={active}
              className={[
                'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              ].join(' ')}
            >
              {it.color ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: `#${it.color}` }}
                />
              ) : null}
              <span className="tabular-nums">{it.label}</span>
              {it.sub ? <span className="opacity-60">{it.sub}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
