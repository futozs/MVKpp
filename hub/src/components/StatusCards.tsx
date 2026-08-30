import { Activity, Cpu, Database, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { CacheResponse, HealthResponse, SystemInfoResponse } from '@/types'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

type StatusCardsProps = {
  health: HealthResponse | null
  sysInfo: SystemInfoResponse | null
  cache: CacheResponse | null
}

function formatUptime(sec: number) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d > 0) return `${d} nap ${h} óra`
  if (h > 0) return `${h} óra ${m} perc`
  return `${m} perc ${s} mp`
}

/** Egy mérőszám kerete — a négy kártya azonos szerkezetű. */
function Metric({
  label,
  icon,
  tone = 'neutral',
  value,
  detail,
  children,
}: {
  label: string
  icon: React.ReactNode
  tone?: 'neutral' | 'ok' | 'bad'
  value: React.ReactNode
  detail?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg',
            tone === 'ok' && 'bg-primary/15 text-primary',
            tone === 'bad' && 'bg-destructive/15 text-destructive',
            tone === 'neutral' && 'bg-muted text-muted-foreground'
          )}
        >
          {icon}
        </span>
      </div>

      <div>
        <div className="font-mono text-lg font-bold tabular-nums">{value}</div>
        {detail ? <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div> : null}
      </div>

      {children}
    </Card>
  )
}

export function StatusCards({ health, sysInfo, cache }: StatusCardsProps) {
  const jwt = health?.jwt
  const tokenOk = Boolean(jwt?.present && !jwt?.expired)
  const minutesLeft = jwt?.expiresInSec != null ? Math.round(jwt.expiresInSec / 60) : null

  // A valós idejű feedek akkor egészségesek, ha frissebbek a TTL kétszeresénél.
  const feedsFresh =
    cache?.feeds.length && cache.feeds.every((f) => f.ageMs != null && f.ageMs < cache.ttlMs * 3)

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Metric
        label="Token állapot"
        tone={tokenOk ? 'ok' : 'bad'}
        icon={tokenOk ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        value={tokenOk ? `${minutesLeft} perc` : jwt?.expired ? 'LEJÁRT' : 'Nincs token'}
        detail={
          jwt?.installationId ? `ID: ${jwt.installationId.slice(0, 14)}…` : 'Nincs installation-id'
        }
      >
        {jwt?.expiresInSec != null ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-normal',
                minutesLeft && minutesLeft > 60 ? 'bg-primary' : 'bg-destructive'
              )}
              style={{
                width: `${Math.min(100, Math.max(4, (jwt.expiresInSec / (9 * 3600)) * 100))}%`,
              }}
            />
          </div>
        ) : null}
      </Metric>

      <Metric
        label="Gateway"
        tone={feedsFresh ? 'ok' : 'neutral'}
        icon={<Activity className="h-4 w-4" />}
        value={sysInfo ? formatUptime(sysInfo.uptimeSec) : '—'}
        detail={`Port 8088 · Node ${sysInfo?.nodeVersion ?? '—'}`}
      >
        <p
          className={cn(
            'text-[11px] font-semibold',
            feedsFresh ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {feedsFresh
            ? 'Élő feedek frissek'
            : cache
              ? 'A háttérfrissítés áll (nincs érvényes token?)'
              : 'Gyorsítótár állapota ismeretlen'}
        </p>
      </Metric>

      <Metric
        label="GTFS menetrend"
        icon={<Database className="h-4 w-4" />}
        value={`${sysInfo?.gtfs.stops ?? health?.gtfs.stops ?? '—'} megálló`}
        detail={`${sysInfo?.gtfs.routes ?? '—'} járat · ${sysInfo?.gtfs.trips ?? '—'} menet`}
      >
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {health?.gtfs.feedVersion || 'ismeretlen verzió'}
        </p>
      </Metric>

      <Metric
        label="Memória"
        icon={<Cpu className="h-4 w-4" />}
        value={sysInfo ? `${sysInfo.memory.rssMb} MB` : '—'}
        detail={
          sysInfo
            ? `Heap ${sysInfo.memory.heapUsedMb} / ${sysInfo.memory.heapTotalMb} MB`
            : undefined
        }
      >
        {cache?.vehicles ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            {cache.vehicles.count} jármű a gyorsítótárban
          </p>
        ) : null}
      </Metric>
    </div>
  )
}
