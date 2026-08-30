import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, Server } from 'lucide-react'
import type { CacheResponse, HealthResponse, SystemInfoResponse } from '@/types'
import { StatusCards } from '@/components/StatusCards'
import { SystemActions } from '@/components/SystemActions'
import { ApiInspector } from '@/components/ApiInspector'
import { RedeployPanel } from '@/components/RedeployPanel'
import { LogViewer } from '@/components/LogViewer'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { dashboardUrl } from '@/lib/links'
import { getSystemUrl } from '@/lib/admin'
import { cn } from '@/lib/utils'

const POLL_MS = 10000

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfoResponse | null>(null)
  const [cache, setCache] = useState<CacheResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [h, s, c] = await Promise.all([
        fetch(getSystemUrl('/_health')).then((r) => r.json()),
        fetch(getSystemUrl('/system/info')).then((r) => r.json()).catch(() => null),
        fetch(getSystemUrl('/system/cache')).then((r) => r.json()).catch(() => null),
      ])
      setHealth(h)
      if (s) setSysInfo(s)
      setCache(c)
      setOffline(false)
    } catch {
      // A gateway épp újraindulhat — ezt jelezzük, nem hibaüzenettel riogatunk.
      setOffline(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // Visszatéréskor (fülváltás, böngésző-helyreállítás) azonnal frissítünk.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/80 px-3 backdrop-blur-xl sm:px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Server className="h-4 w-4" />
          </span>

          <div className="min-w-0">
            <p className="truncate text-sm font-bold tracking-tight">Rendszerpult</p>
            <p className="text-[11px] text-muted-foreground">
              MVK MobilON+ gateway ·{' '}
              {typeof window === 'undefined' ? ':8088' : `${window.location.hostname}:8088`}
            </p>
          </div>

          {offline ? (
            <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] font-semibold text-destructive">
              A gateway nem válaszol
            </span>
          ) : null}

          <div className="flex-1" />

          <Button variant="ghost" size="sm" asChild>
            <a href={dashboardUrl()} target="_blank" rel="noreferrer">
              <span className="hidden sm:inline">Fő dashboard</span>
              <ExternalLink className="opacity-60" />
            </a>
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={load}
            disabled={loading}
            aria-label="Állapot frissítése"
          >
            <RefreshCw className={cn(loading && 'animate-spin text-primary')} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          <StatusCards health={health} sysInfo={sysInfo} cache={cache} />
          <SystemActions onRefreshed={load} />
          <RedeployPanel onFinished={load} />
          <LogViewer />
          <ApiInspector />
        </div>
      </div>
    </TooltipProvider>
  )
}

export default App
