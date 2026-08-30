import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Crosshair, Gauge } from 'lucide-react'
import {
  fmtClock,
  fmtDelay,
  fmtDuration,
  fmtKm,
  fmtSchedTime,
  serviceToday,
  shiftDate,
  statsApi,
  type TrackPoint,
  type VehicleDetail,
  type VehicleRun,
} from '@/services/statsApi'
import { ChartFrame, Donut, EmptyChart, StatTile, useMeasure } from '@/components/charts/Charts'
import { Button } from '@/components/ui/button'
import { QueryBoundary, PillPicker } from './PanelState'
import { useStatsQuery } from './useStatsQuery'
import { cn } from '@/lib/utils'

/** Efölött „gyors" a szakasz a nyomvonalon (dm/s -> 10 m/s = 36 km/h). */
const FAST_DMS = 100

/**
 * A nap nyomvonala egyetlen SVG-ben.
 *
 * Nem Leaflet: egy második térképpéldány súlyos, és itt nem is kell — a kérdés
 * az útvonal ALAKJA és a sebességprofil, nem a földrajzi kontextus. A szakaszok
 * sebesség szerint színeződnek, így az álldogálás és a szabad futás ránézésre
 * elválik.
 */
function TrackTrace({ track }: { track: TrackPoint[] }) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  if (track.length < 2) return <EmptyChart>Ehhez a naphoz nincs elég GPS-pont.</EmptyChart>

  const height = 260
  const w = Math.max(width, 240)
  const pad = 12

  const lats = track.map((p) => p[1])
  const lons = track.map((p) => p[2])
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)

  // Egyenlő téglalapos vetítés, a szélességi kör szerinti torzítás korrigálva —
  // enélkül a város kelet-nyugati irányban megnyúlna.
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180))
  const spanX = Math.max((maxLon - minLon) * kx, 1e-6)
  const spanY = Math.max(maxLat - minLat, 1e-6)
  const scale = Math.min((w - pad * 2) / spanX, (height - pad * 2) / spanY)
  const offX = (w - spanX * scale) / 2
  const offY = (height - spanY * scale) / 2

  const px = (lon: number) => offX + (lon - minLon) * kx * scale
  const py = (lat: number) => height - offY - (lat - minLat) * scale

  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={height} role="img" aria-label="A jármű napi nyomvonala">
        {track.slice(1).map((p, i) => {
          const prev = track[i]
          const speed = p[3] ?? 0
          const gapMin = (p[0] - prev[0]) / 60
          // Nagy időrés = adathiány, nem megtett út: szaggatottan jelöljük.
          const isGap = gapMin > 5
          return (
            <line
              key={i}
              x1={px(prev[2])} y1={py(prev[1])}
              x2={px(p[2])} y2={py(p[1])}
              strokeWidth={isGap ? 1 : 2}
              strokeLinecap="round"
              strokeDasharray={isGap ? '3 4' : undefined}
              className={cn(
                isGap
                  ? 'stroke-muted-foreground/40'
                  : speed >= FAST_DMS
                    ? 'stroke-primary'
                    : speed > 10
                      ? 'stroke-primary/60'
                      : 'stroke-late/70'
              )}
            />
          )
        })}
        <circle cx={px(track[0][2])} cy={py(track[0][1])} r={4} className="fill-ontime stroke-card" strokeWidth={2}>
          <title>{`Nap első pontja — ${fmtClock(track[0][0])}`}</title>
        </circle>
        <circle
          cx={px(track[track.length - 1][2])} cy={py(track[track.length - 1][1])} r={4}
          className="fill-late stroke-card" strokeWidth={2}
        >
          <title>{`Nap utolsó pontja — ${fmtClock(track[track.length - 1][0])}`}</title>
        </circle>
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-primary" />gyors</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-late/70" />lassú vagy áll</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 border-t border-dashed border-muted-foreground/60" />adathiány</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ontime" />nap eleje</span>
      </div>
    </div>
  )
}

/** A nap menetei idősávon — egy pillantással látszik a kihasználtság. */
function RunTimeline({ runs }: { runs: VehicleRun[] }) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  if (!runs.length) return <EmptyChart>Ezen a napon nem futott menet.</EmptyChart>

  const w = Math.max(width, 240)
  const minS = Math.min(...runs.map((r) => r.sched_start_s))
  const maxS = Math.max(...runs.map((r) => r.sched_end_s))
  const span = Math.max(maxS - minS, 1)
  const rowH = 26
  const height = runs.length * rowH + 18
  const labelW = 44

  return (
    <div ref={ref} className="w-full overflow-hidden">
      <svg width={w} height={height} role="img" aria-label="A nap menetei idővonalon">
        {runs.map((r, i) => {
          const x = labelW + ((r.sched_start_s - minS) / span) * (w - labelW - 8)
          const bw = Math.max(3, ((r.sched_end_s - r.sched_start_s) / span) * (w - labelW - 8))
          const y = i * rowH + 4
          return (
            <g key={r.run_id}>
              <text x={0} y={y + 13} className="fill-muted-foreground text-[10px] tabular-nums">
                {fmtSchedTime(r.sched_start_s)}
              </text>
              <rect
                x={x} y={y} width={bw} height={16} rx={4}
                fill={r.color ? `#${r.color}` : 'hsl(var(--primary))'}
                opacity={r.status === 'ghost' ? 0.25 : 0.85}
              >
                <title>
                  {`${r.route_short} · ${r.headsign ?? ''}\n` +
                    `terv ${fmtSchedTime(r.sched_start_s)}–${fmtSchedTime(r.sched_end_s)}\n` +
                    `megálló ${r.stops_seen}/${r.stops_total} (${r.quality}%)\n` +
                    `indulási késés: ${fmtDelay(r.start_delay_s)}`}
                </title>
              </rect>
              <text
                x={x + 6} y={y + 12}
                className="pointer-events-none fill-background text-[10px] font-bold"
              >
                {bw > 26 ? r.route_short : ''}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function VehiclePanel({ onFocusVehicle }: { onFocusVehicle?: (id: string) => void }) {
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [date, setDate] = useState(serviceToday())

  const listQ = useStatsQuery(useCallback(() => statsApi.vehicles(), []), [])

  // Az első jármű automatikus kiválasztása: üres képernyővel indulni rossz
  // fogadtatás, és a lista úgyis a legutóbb látott járművel kezdődik.
  useEffect(() => {
    if (!vehicleId && listQ.data?.vehicles.length) {
      setVehicleId(listQ.data.vehicles[0].vehicle_id)
    }
  }, [listQ.data, vehicleId])

  const detailQ = useStatsQuery<VehicleDetail>(
    useCallback(() => statsApi.vehicle(vehicleId!, date), [vehicleId, date]),
    [vehicleId, date],
    Boolean(vehicleId)
  )
  const trackQ = useStatsQuery(
    useCallback(() => statsApi.vehicleTrack(vehicleId!, date, 2), [vehicleId, date]),
    [vehicleId, date],
    Boolean(vehicleId)
  )
  const routesQ = useStatsQuery(
    useCallback(() => statsApi.vehicleRoutes(vehicleId!), [vehicleId]),
    [vehicleId],
    Boolean(vehicleId)
  )

  return (
    <div className="space-y-4">
      <QueryBoundary query={listQ} empty={(d) => d.vehicles.length === 0}>
        {(d) => (
          <div className="space-y-2">
            <h2 className="text-lg font-bold tracking-tight sm:text-xl">Járművek</h2>
            <PillPicker
              ariaLabel="Jármű választása"
              value={vehicleId}
              onChange={setVehicleId}
              items={d.vehicles.map((v) => ({
                id: v.vehicle_id,
                label: v.vehicle_id,
                sub: v.kind === 'TRAM' ? '🚋' : undefined,
              }))}
            />
          </div>
        )}
      </QueryBoundary>

      {vehicleId ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" onClick={() => setDate(shiftDate(date, -1))} aria-label="Előző nap">
                <ChevronLeft />
              </Button>
              <span className="min-w-32 text-center text-sm font-semibold tabular-nums">{date}</span>
              <Button
                variant="outline" size="icon"
                onClick={() => setDate(shiftDate(date, 1))}
                disabled={date >= serviceToday()}
                aria-label="Következő nap"
              >
                <ChevronRight />
              </Button>
            </div>
            {onFocusVehicle ? (
              <Button variant="ghost" size="sm" onClick={() => onFocusVehicle(vehicleId)}>
                <Crosshair />
                Élőben a térképen
              </Button>
            ) : null}
          </div>

          <QueryBoundary query={detailQ}>
            {(d) => {
              const s = d.summary
              const stopped = s ? Math.max(0, s.service_s - s.moving_s) : 0
              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                    <StatTile label="Menet" value={s?.runs ?? d.runs.length} sub={`${s?.routes_n ?? '—'} vonalon`} />
                    <StatTile label="Megtett út" value={fmtKm(s?.dist_m)} />
                    <StatTile label="Üzemidő" value={fmtDuration(s?.service_s)} sub={`ebből állva ${fmtDuration(stopped)}`} />
                    <StatTile
                      label="Átlagos késés"
                      value={fmtDelay(s?.avg_delay_s)}
                      sub={s?.p85_delay_s != null ? `p85: ${fmtDelay(s.p85_delay_s)}` : undefined}
                      tone={s?.avg_delay_s != null && s.avg_delay_s > 60 ? 'late' : 'ontime'}
                    />
                  </div>

                  {s ? (
                    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                      <StatTile label="Első pont" value={fmtClock(s.first_ts)} />
                      <StatTile label="Utolsó pont" value={fmtClock(s.last_ts)} />
                      <StatTile
                        label="Csúcssebesség"
                        value={s.max_speed_dms != null ? `${Math.round((s.max_speed_dms / 10) * 3.6)} km/h` : '—'}
                      />
                      <StatTile
                        label="Hiányos menet"
                        value={s.gaps_n}
                        sub="részleges vagy megszakadt"
                        tone={s.gaps_n > 0 ? 'late' : 'ontime'}
                      />
                    </div>
                  ) : null}

                  <ChartFrame
                    title="A nap menetei"
                    hint="Menetrendi sávok — a szélesség a tervezett menetidő, a szín a vonal."
                  >
                    <RunTimeline runs={d.runs} />
                  </ChartFrame>

                  {d.runs.length ? (
                    <ChartFrame title="Menetek részletesen" hint={`${d.runs.length} menet ezen a napon`}>
                      <div className="-mx-4 overflow-x-auto sm:mx-0">
                        <table className="w-full min-w-[34rem] text-xs">
                          <thead>
                            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                              <th className="px-2 py-2 font-semibold">Vonal</th>
                              <th className="px-2 py-2 font-semibold">Terv</th>
                              <th className="px-2 py-2 font-semibold">Tény</th>
                              <th className="px-2 py-2 text-right font-semibold">Késés</th>
                              <th className="px-2 py-2 text-right font-semibold">Megálló</th>
                              <th className="px-2 py-2 text-right font-semibold">Állapot</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {d.runs.map((r) => (
                              <tr key={r.run_id}>
                                <td className="px-2 py-2">
                                  <span
                                    className="inline-flex min-w-8 justify-center rounded px-1.5 py-0.5 text-[11px] font-bold"
                                    style={{
                                      background: r.color ? `#${r.color}` : 'hsl(var(--primary))',
                                      color: 'hsl(var(--background))',
                                    }}
                                  >
                                    {r.route_short}
                                  </span>
                                </td>
                                <td className="px-2 py-2 tabular-nums text-muted-foreground">
                                  {fmtSchedTime(r.sched_start_s)}
                                </td>
                                <td className="px-2 py-2 tabular-nums">{fmtClock(r.actual_start)}</td>
                                <td
                                  className={cn(
                                    'px-2 py-2 text-right font-semibold tabular-nums',
                                    r.start_delay_s == null
                                      ? 'text-muted-foreground'
                                      : r.start_delay_s > 45
                                        ? 'text-late'
                                        : r.start_delay_s < -45
                                          ? 'text-early'
                                          : 'text-ontime'
                                  )}
                                >
                                  {fmtDelay(r.start_delay_s)}
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                  {r.stops_seen}/{r.stops_total}
                                </td>
                                <td className="px-2 py-2 text-right text-[11px] text-muted-foreground">
                                  {r.status === 'complete'
                                    ? 'teljes'
                                    : r.status === 'partial'
                                      ? `részleges ${r.quality}%`
                                      : r.status === 'running'
                                        ? 'fut'
                                        : r.status === 'ghost'
                                          ? 'kiesett'
                                          : 'megszakadt'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </ChartFrame>
                  ) : null}
                </div>
              )
            }}
          </QueryBoundary>

          <ChartFrame
            title="Napi nyomvonal"
            hint={
              trackQ.data
                ? `${trackQ.data.points} pont (${trackQ.data.ofTotal} mérésből ritkítva)`
                : 'GPS-pontok a nap folyamán'
            }
          >
            {trackQ.data ? <TrackTrace track={trackQ.data.track} /> : <EmptyChart>Betöltés…</EmptyChart>}
          </ChartFrame>

          <ChartFrame
            title="Milyen vonalakon jár?"
            hint="Havi megoszlás a teljesített menetek alapján."
            action={<Gauge className="h-4 w-4 text-muted-foreground" />}
          >
            {routesQ.data?.routes.length ? (
              <Donut
                centerLabel={`${routesQ.data.routes[0].share_pct}%`}
                centerSub={`Összesen ${routesQ.data.routes.reduce((a, r) => a + r.runs, 0)} menet, ${routesQ.data.routes[0].days_active} aktív nap`}
                slices={routesQ.data.routes.map((r) => ({
                  label: `${r.route_short} — ${r.runs} menet`,
                  value: r.runs,
                  color: r.color,
                }))}
              />
            ) : (
              <EmptyChart>Még nincs havi összegzés ehhez a járműhöz.</EmptyChart>
            )}
          </ChartFrame>
        </>
      ) : null}
    </div>
  )
}
