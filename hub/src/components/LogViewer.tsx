import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { adminHeaders } from '@/lib/admin'
import { cn } from '@/lib/utils'

type LogSource = { name: string; label: string; size: number; mtime: string | null; exists: boolean }

const POLL_MS = 3000
const LINES = 400

function humanSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Naplónéző.
 *
 * A folyamatkezelő minden gyerekfolyamat kimenetét fájlba is írja
 * (`logs/<forrás>.log`), a gateway pedig ezek végét szolgálja ki. Így a
 * szerveren futó rendszer naplója távolról is olvasható, SSH nélkül.
 */
export function LogViewer() {
  const [sources, setSources] = useState<LogSource[]>([])
  const [active, setActive] = useState<string>('backend')
  const [lines, setLines] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [loading, setLoading] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  /** Ha a felhasználó felgörget, nem rángatjuk vissza az aljára. */
  const pinnedToBottom = useRef(true)

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch('/system/logs', { cache: 'no-store', headers: adminHeaders() })
      const data = await res.json()
      setSources(data.sources ?? [])
    } catch {
      /* a gateway épp újraindulhat */
    }
  }, [])

  const loadLines = useCallback(async (source: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/system/logs/${source}?lines=${LINES}`, {
        cache: 'no-store',
        headers: adminHeaders(),
      })
      if (res.status === 401) {
        setLines([])
        setNote('A naplók admin tokent kérnek — add meg fentebb, az Újratelepítés kártyán.')
        return
      }
      const data = await res.json()
      setLines(data.lines ?? [])
      setNote(data.note ?? data.error ?? null)
    } catch {
      setNote('A napló most nem érhető el — a gateway talán épp újraindul.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSources()
  }, [loadSources])

  useEffect(() => {
    loadLines(active)
  }, [active, loadLines])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => {
      loadLines(active)
      loadSources()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [live, active, loadLines, loadSources])

  useEffect(() => {
    const el = preRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const onScroll = () => {
    const el = preRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const activeSource = sources.find((s) => s.name === active)

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
            <ScrollText className="h-4 w-4 text-primary" />
            Naplók
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A futó folyamatok kimenete — a szerverhez való bejelentkezés nélkül.
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={() => setLive((v) => !v)}>
          {live ? <Pause /> : <Play />}
          {live ? 'Szünet' : 'Élő'}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => {
              pinnedToBottom.current = true
              setActive(s.name)
            }}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              active === s.name
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:border-primary/30 hover:text-foreground',
              !s.exists && 'opacity-50'
            )}
          >
            {s.label}
            {s.exists ? (
              <span className="ml-1.5 tabular-nums opacity-60">{humanSize(s.size)}</span>
            ) : null}
          </button>
        ))}
      </div>

      <pre
        ref={preRef}
        onScroll={onScroll}
        className="h-80 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
      >
        {lines.length ? lines.join('\n') : (note ?? (loading ? 'Betöltés…' : 'Üres napló.'))}
      </pre>

      {activeSource ? (
        <p className="text-[11px] text-muted-foreground">
          {activeSource.label} · {humanSize(activeSource.size)}
          {activeSource.mtime
            ? ` · utolsó bejegyzés ${new Date(activeSource.mtime).toLocaleString('hu-HU')}`
            : ''}
          {live ? ' · élő frissítés 3 mp-enként' : ' · frissítés szüneteltetve'}
        </p>
      ) : null}
    </Card>
  )
}
