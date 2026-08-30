import { useCallback, useState } from 'react'
import { statsApi } from '@/services/statsApi'
import { ChartFrame, RankBars, StatTile } from '@/components/charts/Charts'
import { QueryBoundary, PillPicker } from './PanelState'
import { useStatsQuery } from './useStatsQuery'

/** A negyedórás sávok a nap 0–95 indexén — itt a szokásos csúcsokat kínáljuk. */
const WINDOWS = [
  { id: 'am', label: 'Reggeli csúcs', sub: '7–9', from: 28, to: 36 },
  { id: 'mid', label: 'Napközben', sub: '10–14', from: 40, to: 56 },
  { id: 'pm', label: 'Délutáni csúcs', sub: '15–18', from: 60, to: 72 },
  { id: 'eve', label: 'Este', sub: '19–22', from: 76, to: 88 },
] as const

export function NetworkPanel() {
  const [win, setWin] = useState<(typeof WINDOWS)[number]['id']>('am')
  const active = WINDOWS.find((w) => w.id === win)!

  const q = useStatsQuery(
    useCallback(() => statsApi.slowSegments(active.from, active.to), [active.from, active.to]),
    [active.from, active.to]
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">Hálózat</h2>
        <p className="text-xs text-muted-foreground">
          Hol veszít a legtöbb időt a forgalom a menetrendhez képest — munkanapokon.
        </p>
        <PillPicker
          ariaLabel="Napszak"
          value={win}
          onChange={(v) => setWin(v as typeof win)}
          items={WINDOWS.map((w) => ({ id: w.id, label: w.label, sub: w.sub }))}
        />
      </div>

      <QueryBoundary query={q} empty={(d) => d.segments.length === 0}>
        {(d) => {
          const worst = d.segments[0]
          const totalExcess = d.segments.reduce((a, s) => a + Math.max(0, s.excess_s), 0)
          const slower = d.segments.filter((s) => s.excess_s > 0).length

          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
                <StatTile
                  label="Vizsgált szakasz"
                  value={d.segments.length}
                  sub={`${slower} lassabb a tervnél`}
                />
                <StatTile
                  label="Legnagyobb csúszás"
                  value={worst ? `+${Math.round(worst.excess_s)} mp` : '—'}
                  sub={worst ? `${worst.from_name} → ${worst.to_name}` : undefined}
                  tone="late"
                />
                <StatTile
                  label="Összes többletidő"
                  value={`${Math.round(totalExcess / 60)} perc`}
                  sub="a listázott szakaszokon együtt"
                  tone="late"
                />
              </div>

              <ChartFrame
                title="Leglassabb szakaszok"
                hint={`${active.label} (${active.sub} óra) · a menetrendhez képesti többletidő`}
              >
                <RankBars
                  rows={d.segments.slice(0, 20).map((s) => ({
                    label: `${s.from_name} → ${s.to_name}`,
                    sub: `terv ${Math.round(s.sched_s / 60)} p · tény ${Math.round(s.p50_s / 60)} p · ${s.n} mérés`,
                    value: Math.round(s.excess_s),
                    display: `+${Math.round(s.excess_s)} mp`,
                  }))}
                />
              </ChartFrame>
            </div>
          )
        }}
      </QueryBoundary>
    </div>
  )
}
