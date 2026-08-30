import { useCallback, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { Stop } from '@/types'
import { fmtDelay, serviceToday, shiftDate, statsApi, type StopHour } from '@/services/statsApi'
import { BarChart, ChartFrame, EmptyChart, HourHeat, StatTile } from '@/components/charts/Charts'
import { Input } from '@/components/ui/input'
import { QueryBoundary } from './PanelState'
import { useStatsQuery } from './useStatsQuery'
import { cn } from '@/lib/utils'

/** Órákra összevonva: a napokon átívelő átlag óránként. */
function byHour(hours: StopHour[]) {
  const map = new Map<number, { events: number; delaySum: number; otpSum: number; dwellSum: number; hwSum: number; hwN: number }>()
  for (const h of hours) {
    const cur = map.get(h.hour) ?? { events: 0, delaySum: 0, otpSum: 0, dwellSum: 0, hwSum: 0, hwN: 0 }
    cur.events += h.events_n
    cur.delaySum += (h.avg_delay_s ?? 0) * h.events_n
    cur.otpSum += (h.otp_pct ?? 0) * h.events_n
    cur.dwellSum += (h.avg_dwell_s ?? 0) * h.events_n
    if (h.avg_headway_s != null) {
      cur.hwSum += h.avg_headway_s
      cur.hwN += 1
    }
    map.set(h.hour, cur)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, v]) => ({
      hour,
      events: v.events,
      avgDelay: v.events ? Math.round(v.delaySum / v.events) : null,
      otp: v.events ? Math.round(v.otpSum / v.events) : null,
      dwell: v.events ? Math.round(v.dwellSum / v.events) : null,
      headway: v.hwN ? Math.round(v.hwSum / v.hwN) : null,
    }))
}

export function StopPanel({ stops }: { stops: Stop[] }) {
  const [search, setSearch] = useState('')
  const [stopId, setStopId] = useState<string | null>(null)

  const to = serviceToday()
  const from = shiftDate(to, -13)

  const matches = useMemo(() => {
    const t = search.trim().toLowerCase()
    if (!t) return stops.slice(0, 12)
    return stops.filter((s) => s.name.toLowerCase().includes(t)).slice(0, 12)
  }, [search, stops])

  const q = useStatsQuery(
    useCallback(() => statsApi.stop(stopId!, from, to), [stopId, from, to]),
    [stopId, from, to],
    Boolean(stopId)
  )

  const selected = stops.find((s) => s.id === stopId)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">Megállók</h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Megálló keresése…"
            className="pl-9"
            aria-label="Megálló keresése"
          />
        </div>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div className="flex min-w-max gap-1.5">
            {matches.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStopId(s.id)}
                aria-pressed={s.id === stopId}
                className={cn(
                  'max-w-56 truncate rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  s.id === stopId
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
                )}
              >
                {s.name}
              </button>
            ))}
            {!matches.length ? (
              <span className="px-2 py-1.5 text-xs text-muted-foreground">Nincs találat.</span>
            ) : null}
          </div>
        </div>
      </div>

      {stopId ? (
        <QueryBoundary query={q} empty={(d) => d.hours.length === 0}>
          {(d) => {
            const rows = byHour(d.hours)
            const totalEvents = rows.reduce((a, r) => a + r.events, 0)
            const wAvg = (pick: (r: (typeof rows)[number]) => number | null) =>
              totalEvents
                ? Math.round(rows.reduce((a, r) => a + (pick(r) ?? 0) * r.events, 0) / totalEvents)
                : null
            const avgOtp = wAvg((r) => r.otp)
            const avgDelay = wAvg((r) => r.avgDelay)
            const avgDwell = wAvg((r) => r.dwell)
            const busiest = rows.reduce<(typeof rows)[number] | null>(
              (best, r) => (!best || r.events > best.events ? r : best),
              null
            )

            return (
              <div className="space-y-4">
                <header>
                  <h3 className="text-base font-semibold">{selected?.name ?? d.name ?? stopId}</h3>
                  <p className="text-xs text-muted-foreground">
                    {from} – {to} · {totalEvents.toLocaleString('hu-HU')} érkezés
                  </p>
                </header>

                <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                  <StatTile
                    label="Menetrendtartás"
                    value={avgOtp != null ? `${avgOtp}%` : '—'}
                    tone={avgOtp == null ? 'default' : avgOtp >= 80 ? 'ontime' : 'late'}
                  />
                  <StatTile
                    label="Átlagos késés"
                    value={fmtDelay(avgDelay)}
                    tone={avgDelay != null && avgDelay > 60 ? 'late' : 'ontime'}
                  />
                  <StatTile
                    label="Átlagos állás"
                    value={avgDwell != null ? `${avgDwell} mp` : '—'}
                    sub="utasforgalom-proxy"
                  />
                  <StatTile
                    label="Legforgalmasabb óra"
                    value={busiest ? `${busiest.hour % 24}:00` : '—'}
                    sub={busiest ? `${busiest.events} érkezés` : undefined}
                  />
                </div>

                <ChartFrame
                  title="Érkezések óránként"
                  hint="Az üzemi nap kezdetétől számolva — a 24 fölötti órák az éjfél utáni járatok."
                >
                  <BarChart
                    data={rows.map((r) => ({
                      label: String(r.hour % 24),
                      value: r.events,
                      title: `${r.hour % 24}:00 — ${r.events} érkezés, pontosság ${r.otp ?? '—'}%`,
                    }))}
                    labelEvery={2}
                  />
                </ChartFrame>

                <ChartFrame
                  title="Pontosság óránként"
                  hint="Minél sötétebb, annál pontosabb az adott óra."
                >
                  <HourHeat
                    legend="A szám az órát jelöli. Üres keret = abban az órában nem volt mérés."
                    cells={rows.map((r) => ({
                      hour: r.hour,
                      value: r.otp,
                      title: `${r.hour % 24}:00 — pontosság ${r.otp ?? '—'}%, átlag ${fmtDelay(r.avgDelay)}`,
                    }))}
                  />
                </ChartFrame>

                <ChartFrame title="Átlagos késés óránként" hint="Másodpercben.">
                  {rows.some((r) => r.avgDelay != null) ? (
                    <BarChart
                      data={rows.map((r) => ({
                        label: String(r.hour % 24),
                        value: r.avgDelay,
                        tone:
                          (r.avgDelay ?? 0) > 60
                            ? 'fill-late'
                            : (r.avgDelay ?? 0) < -60
                              ? 'fill-early'
                              : 'fill-ontime',
                        title: `${r.hour % 24}:00 — ${fmtDelay(r.avgDelay)}`,
                      }))}
                      labelEvery={2}
                    />
                  ) : (
                    <EmptyChart />
                  )}
                </ChartFrame>
              </div>
            )
          }}
        </QueryBoundary>
      ) : (
        <p className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center text-xs text-muted-foreground">
          Válassz megállót a fenti listából vagy keresővel.
        </p>
      )}
    </div>
  )
}
