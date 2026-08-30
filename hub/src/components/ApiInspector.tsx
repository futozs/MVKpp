import { useState } from 'react'
import { AlertCircle, Check, CheckCircle, Code, Copy, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const PRESETS = [
  { name: 'Élő járműpozíciók', path: '/live/positions', param: '' },
  { name: 'Érkezések megállóhoz', path: '/live/arrivals', param: '?stop=SP1&limit=6' },
  { name: 'Menet haladása', path: '/live/trip-progress', param: '?trip=' },
  { name: 'Multi-megálló', path: '/live/multi-arrivals', param: '?stops=SP1,SP2&limit=5' },
  { name: 'Egy jármű', path: '/live/vehicle', param: '?id=1641' },
  { name: 'Menetrend (járatok)', path: '/gtfs/timetable/routes', param: '' },
  { name: 'Menetrend (egy irány)', path: '/gtfs/timetable', param: '?route=1&dir=1' },
  { name: 'Járat nyomvonal', path: '/gtfs/route-geo', param: '?route=20,1V' },
  { name: 'Megállók', path: '/gtfs/stops.json', param: '' },
  { name: 'Időjárás', path: '/weather', param: '' },
  { name: 'Gyorsítótár', path: '/system/cache', param: '' },
  { name: 'Rendszerinfó', path: '/system/info', param: '' },
  { name: 'Egészség', path: '/_health', param: '' },
]

/** Beépített REST-kliens: a gateway végpontjai válaszidővel és nyers JSON-nal. */
export function ApiInspector() {
  const [endpoint, setEndpoint] = useState(PRESETS[0].path)
  const [param, setParam] = useState(PRESETS[0].param)
  const [body, setBody] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const run = async () => {
    setLoading(true)
    setBody(null)
    setStatus(null)
    const startedAt = performance.now()

    try {
      const res = await fetch(endpoint + param)
      setDurationMs(Math.round(performance.now() - startedAt))
      setStatus(res.status)
      const text = await res.text()
      try {
        setBody(JSON.stringify(JSON.parse(text), null, 2))
      } catch {
        setBody(text)
      }
    } catch (err) {
      setDurationMs(Math.round(performance.now() - startedAt))
      setStatus(0)
      setBody(`Hiba: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const ok = status !== null && status >= 200 && status < 300

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
          <Code className="h-4 w-4 text-primary" />
          REST API vizsgáló
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Közvetlen hívások a gatewayre, válaszidővel.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.path + preset.name}
            type="button"
            onClick={() => {
              setEndpoint(preset.path)
              setParam(preset.param)
            }}
            aria-pressed={endpoint === preset.path}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors duration-fast',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              endpoint === preset.path
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-1 items-center gap-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-within:border-primary">
          <span className="select-none font-bold text-muted-foreground">GET</span>
          <span className="select-none font-bold text-primary">{endpoint}</span>
          <Input
            value={param}
            onChange={(e) => setParam(e.target.value)}
            placeholder="?param=érték"
            aria-label="Lekérdezési paraméterek"
            className="h-auto flex-1 border-0 bg-transparent px-1 py-0 font-mono text-xs shadow-none focus-visible:ring-0"
          />
        </div>

        <Button onClick={run} disabled={loading} className="shrink-0">
          <Play className="fill-current" />
          {loading ? 'Futtatás…' : 'Hívás'}
        </Button>
      </div>

      {status !== null ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-3">
              <span
                className={cn(
                  'flex items-center gap-1.5 font-semibold',
                  ok ? 'text-primary' : 'text-destructive'
                )}
              >
                {ok ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                HTTP {status}
              </span>
              {durationMs != null ? (
                <span className="font-mono tabular-nums text-muted-foreground">
                  {durationMs} ms
                </span>
              ) : null}
            </span>

            {body ? (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(body)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Másolva' : 'Másolás'}
              </button>
            ) : null}
          </div>

          <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
            {body}
          </pre>
        </div>
      ) : null}
    </Card>
  )
}
