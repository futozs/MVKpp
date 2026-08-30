import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Hammer,
  Loader2,
  Lock,
  RefreshCcwDot,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { adminHeaders, deployStatusUrl, getAdminToken, setAdminToken } from '@/lib/admin'
import { cn } from '@/lib/utils'

type StepState = 'pending' | 'running' | 'done' | 'failed'
type DeployStep = { id: string; label: string; state: StepState; ms: number | null; note: string | null }
type DeployStatus = {
  running: boolean
  ok: boolean | null
  startedAt: string | null
  finishedAt: string | null
  currentStep: string | null
  error: string | null
  steps: DeployStep[]
  log?: string[]
}

const POLL_MS = 1500

function StepRow({ step }: { step: DeployStep }) {
  const icon = {
    pending: <CircleDashed className="h-4 w-4 text-muted-foreground" />,
    running: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
    done: <Check className="h-4 w-4 text-primary" />,
    failed: <X className="h-4 w-4 text-destructive" />,
  }[step.state]

  return (
    <li className="flex items-center gap-2.5 py-1 text-xs">
      <span className="shrink-0">{icon}</span>
      <span className={cn('font-medium', step.state === 'pending' && 'text-muted-foreground')}>
        {step.label}
      </span>
      {step.note ? <span className="truncate text-muted-foreground">— {step.note}</span> : null}
      <span className="flex-1" />
      {step.ms != null ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {(step.ms / 1000).toFixed(1)} mp
        </span>
      ) : null}
    </li>
  )
}

/**
 * Újratelepítés a hubról.
 *
 * A gomb megállítja az egész rendszert, frissít gitből, buildel, majd nulláról
 * indít. Mivel ez alatt a gateway ÉS a hub Vite-szervere is halott, a haladást
 * a telepítő saját állapotszerveréről kérdezzük le (:8089), a proxy
 * megkerülésével — így a folyamat végig követhető, nem fekete doboz.
 */
export function RedeployPanel({ onFinished }: { onFinished: () => void }) {
  const [token, setToken] = useState(getAdminToken())
  const [tokenSaved, setTokenSaved] = useState(false)
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const wasRunning = useRef(false)

  const poll = useCallback(async () => {
    // Először a telepítő saját szervere: telepítés közben csak ez él.
    // Ha az nem elérhető (már vége, port lezárva), a gateway másolatát kérjük.
    for (const url of [deployStatusUrl(), '/system/deploy-status']) {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
        if (!res.ok) continue
        const data = (await res.json()) as DeployStatus
        setStatus(data)
        return data
      } catch {
        /* a következő forrást próbáljuk */
      }
    }
    return null
  }, [])

  useEffect(() => {
    if (!polling) return
    const timer = setInterval(async () => {
      const data = await poll()
      if (data && !data.running && wasRunning.current) {
        setPolling(false)
        onFinished()
      }
      if (data?.running) wasRunning.current = true
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [polling, poll, onFinished])

  // Induláskor egyszer megnézzük: hátha épp fut egy telepítés (pl. újratöltött oldal).
  useEffect(() => {
    poll().then((d) => {
      if (d?.running) {
        wasRunning.current = true
        setPolling(true)
      }
    })
  }, [poll])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [status?.log])

  const start = async (skipPull: boolean) => {
    const what = skipPull ? 'Build és újraindítás' : 'Teljes újratelepítés (git pull + build)'
    if (
      !window.confirm(
        `${what}\n\nA rendszer MINDEN folyamata leáll, majd nulláról indul. ` +
          'Ez néhány percig tart, és közben nincs élő adat. Folytatod?'
      )
    )
      return

    setBusy(true)
    setError(null)
    wasRunning.current = false
    try {
      const res = await fetch('/system/redeploy', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ skipPull }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(
          res.status === 401
            ? 'Hibás admin token. A helyes érték a szerver indítási naplójában és a backend/state/admin_token.txt fájlban van.'
            : data.error || 'Az újratelepítést nem sikerült elindítani.'
        )
        return
      }
      setPolling(true)
      await poll()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const running = status?.running === true
  const finished = status && !status.running && status.ok !== null

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
          <RefreshCcwDot className="h-4 w-4 text-primary" />
          Újratelepítés
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Mindent leállít, frissít gitből, buildeli a backendet, a dashboardot és a hubot, majd
          nulláról indít. A haladás akkor is látszik, amikor a gateway épp nem él.
        </p>
      </div>

      {/* Admin token */}
      <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
        <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Lock className="h-3 w-3" />
          Admin token
        </label>
        <div className="flex gap-2">
          <Input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value)
              setTokenSaved(false)
            }}
            placeholder="a szerver indítási naplójából"
            className="font-mono text-xs"
            autoComplete="off"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdminToken(token.trim())
              setTokenSaved(true)
            }}
          >
            {tokenSaved ? <Check className="text-primary" /> : null}
            {tokenSaved ? 'Mentve' : 'Mentés'}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A gateway hálózaton is elérhető, ezért az újratelepítés — ami kódot tölt le és futtat —
          tokent kér. Az érték a <code className="font-mono">backend/state/admin_token.txt</code>{' '}
          fájlban van, és a szerver indításkor is kiírja.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" onClick={() => start(false)} disabled={busy || running}>
          <RefreshCcwDot className={cn((busy || running) && 'animate-spin')} />
          {running ? 'Fut…' : 'Teljes újratelepítés'}
        </Button>
        <Button variant="outline" onClick={() => start(true)} disabled={busy || running}>
          <Hammer />
          Build és újraindítás
        </Button>
      </div>

      {error ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      {status?.steps?.length ? (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <ul className="divide-y divide-border/60">
            {status.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>

          {finished ? (
            <p
              className={cn(
                'mt-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs',
                status.ok
                  ? 'border-primary/30 bg-primary/10 text-foreground'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              )}
            >
              {status.ok ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>{status.ok ? 'Az újratelepítés befejeződött, a rendszer fut.' : status.error}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {status?.log?.length ? (
        <pre
          ref={logRef}
          className="max-h-56 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
        >
          {status.log.join('\n')}
        </pre>
      ) : null}
    </Card>
  )
}
