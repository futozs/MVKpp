import { useCallback, useMemo, useState } from 'react'
import type { Route } from '@/types'
import {
  fmtDelay,
  serviceToday,
  shiftDate,
  statsApi,
  type RouteDay,
} from '@/services/statsApi'
import { BarChart, ChartFrame, EmptyChart, LineChart, StatTile } from '@/components/charts/Charts'
import { QueryBoundary, PillPicker } from './PanelState'
import { useStatsQuery } from './useStatsQuery'

const RANGES = [
  { id: '7', label: '7 nap' },
  { id: '30', label: '30 nap' },
  { id: '90', label: '90 nap' },
] as const

/** Egy nap két iránya egy sorba vonva — a napi mutató a kettő együtt. */
function mergeDirections(days: RouteDay[]) {
  const byDate = new Map<string, RouteDay[]>()
  for (const d of days) {
    const a = byDate.get(d.service_date) ?? []
    a.push(d)
    byDate.set(d.service_date, a)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const events = rows.reduce((a, r) => a + r.events_n, 0)
      // Az arányokat esemény-számmal súlyozzuk: két irány eltérő forgalmú.
      const weighted = (pick: (r: RouteDay) => number | null) => {
        const num = rows.reduce((a, r) => a + (pick(r) ?? 0) * r.events_n, 0)
        return events ? Math.round(num / events) : null
      }
      return {
        date,
        runs: rows.reduce((a, r) => a + r.runs, 0),
        ghosts: rows.reduce((a, r) => a + r.ghost_runs, 0),
        bunching: rows.reduce((a, r) => a + r.bunching_n, 0),
        events,
        otp: weighted((r) => r.otp_pct),
        avgDelay: weighted((r) => r.avg_delay_s),
        p85: weighted((r) => r.p85_delay_s),
      }
    })
}

export function RoutePanel({ routes }: { routes: Route[] }) {
  const [short, setShort] = useState<string | null>(routes[0]?.short ?? null)
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('30')

  const to = serviceToday()
  const from = shiftDate(to, -Number(range) + 1)

  const q = useStatsQuery(
    useCallback(() => statsApi.route(short!, from, to), [short, from, to]),
    [short, from, to],
    Boolean(short)
  )

  const sorted = useMemo(
    () => [...routes].sort((a, b) => a.short.localeCompare(b.short, 'hu', { numeric: true })),
    [routes]
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">Vonalak</h2>
        <PillPicker
          ariaLabel="Vonal választása"
          value={short}
          onChange={setShort}
          items={sorted.map((r) => ({ id: r.short, label: r.short, color: r.color }))}
        />
        <PillPicker
          ariaLabel="Időszak"
          value={range}
          onChange={(v) => setRange(v as typeof range)}
          items={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        />
      </div>

      {short ? (
        <QueryBoundary query={q} empty={(d) => d.days.length === 0}>
          {(d) => {
            const merged = mergeDirections(d.days)
            const totalEvents = merged.reduce((a, m) => a + m.events, 0)
            const totalRuns = merged.reduce((a, m) => a + m.runs, 0)
            const totalGhosts = merged.reduce((a, m) => a + m.ghosts, 0)
            const totalBunch = merged.reduce((a, m) => a + m.bunching, 0)
            const avgOtp = totalEvents
              ? Math.round(
                  merged.reduce((a, m) => a + (m.otp ?? 0) * m.events, 0) / totalEvents
                )
              : null
            const avgDelay = totalEvents
              ? Math.round(
                  merged.reduce((a, m) => a + (m.avgDelay ?? 0) * m.events, 0) / totalEvents
                )
              : null

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                  <StatTile
                    label="Menetrendtartás"
                    value={avgOtp != null ? `${avgOtp}%` : '—'}
                    sub="−1…+5 perc ablakban"
                    tone={avgOtp == null ? 'default' : avgOtp >= 80 ? 'ontime' : 'late'}
                  />
                  <StatTile
                    label="Átlagos késés"
                    value={fmtDelay(avgDelay)}
                    sub={`${totalEvents.toLocaleString('hu-HU')} megálló-esemény`}
                    tone={avgDelay != null && avgDelay > 60 ? 'late' : 'ontime'}
                  />
                  <StatTile
                    label="Kiesett menet"
                    value={totalGhosts}
                    sub={`${totalRuns} teljesítettből`}
                    tone={totalGhosts > 0 ? 'late' : 'ontime'}
                  />
                  <StatTile
                    label="Torlódás"
                    value={totalBunch}
                    sub="két jármű 2 percen belül"
                    tone={totalBunch > 0 ? 'late' : 'ontime'}
                  />
                </div>

                <ChartFrame
                  title="Menetrendtartás alakulása"
                  hint="Naponta, a −1…+5 perces ablakba eső érkezések aránya."
                >
                  <LineChart
                    unit="%"
                    data={merged.map((m) => ({ label: m.date.slice(5), value: m.otp }))}
                  />
                </ChartFrame>

                <ChartFrame
                  title="Átlagos késés naponta"
                  hint="Másodpercben; a nulla vonal alatt a vonal siet."
                >
                  <LineChart
                    zeroLine
                    unit=" mp"
                    data={merged.map((m) => ({ label: m.date.slice(5), value: m.avgDelay }))}
                  />
                </ChartFrame>

                <ChartFrame title="Teljesített és kiesett menetek" hint="Naponta.">
                  {merged.length ? (
                    <BarChart
                      labelEvery={Math.max(1, Math.ceil(merged.length / 8))}
                      data={merged.map((m) => ({
                        label: m.date.slice(5),
                        value: m.runs,
                        tone: m.ghosts > 0 ? 'fill-late' : 'fill-primary',
                        title: `${m.date}: ${m.runs} menet, ${m.ghosts} kiesett`,
                      }))}
                    />
                  ) : (
                    <EmptyChart />
                  )}
                </ChartFrame>
              </div>
            )
          }}
        </QueryBoundary>
      ) : null}
    </div>
  )
}
