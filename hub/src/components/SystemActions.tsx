import { useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  Copy,
  Check,
  DownloadCloud,
  Key,
  Power,
  RotateCw,
} from 'lucide-react'
import type { ActionResult } from '@/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { adminHeaders, getSystemUrl } from '@/lib/admin'
import { cn } from '@/lib/utils'

type SystemActionsProps = {
  onRefreshed: () => void
}

/** Egy művelet visszajelzése — zöld vagy piros, mindig konkrét szöveggel. */
function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null
  return (
    <p
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
        result.ok
          ? 'border-primary/30 bg-primary/10 text-foreground'
          : 'border-destructive/30 bg-destructive/10 text-destructive'
      )}
    >
      {result.ok ? (
        <CheckCircle className="h-4 w-4 shrink-0 text-primary" />
      ) : (
        <AlertCircle className="h-4 w-4 shrink-0" />
      )}
      <span>{result.text}</span>
    </p>
  )
}

/**
 * Rendszerműveletek.
 *
 * Minden gomb pontosan egy dolgot csinál, és megmondja, mi történt. Az
 * újraindítás megvárja, amíg a gateway tényleg visszajön — nem csak
 * elküldi a kérést és reménykedik.
 */
export function SystemActions({ onRefreshed }: SystemActionsProps) {
  const [restarting, setRestarting] = useState(false)
  const [restartResult, setRestartResult] = useState<ActionResult | null>(null)

  const [reloading, setReloading] = useState(false)
  const [reloadResult, setReloadResult] = useState<ActionResult | null>(null)

  const [tokenRefreshing, setTokenRefreshing] = useState(false)
  const [tokenResult, setTokenResult] = useState<ActionResult | null>(null)

  const [jwtInput, setJwtInput] = useState('')
  const [instInput, setInstInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<ActionResult | null>(null)
  const [copied, setCopied] = useState(false)

  /** Megvárja, amíg a gateway újra válaszol. */
  const waitForGateway = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    // Rövid türelmi idő, hogy a régi példány biztosan lelépjen.
    await new Promise((r) => setTimeout(r, 1200))
    while (Date.now() < deadline) {
      try {
        const res = await fetch(getSystemUrl('/_health'), { cache: 'no-store' })
        if (res.ok) return true
      } catch {
        /* még nem jött vissza */
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    return false
  }

  const handleRestart = async () => {
    if (!window.confirm('Biztosan újraindítod a gatewayt? Néhány másodpercig nem lesz élő adat.'))
      return

    setRestarting(true)
    setRestartResult(null)
    try {
      const res = await fetch(getSystemUrl('/system/restart'), { method: 'POST' })
      const data = await res.json()

      if (!data.managed) {
        setRestartResult({
          ok: false,
          text:
            'A gateway leállt, de manager nélkül indult, ezért magától nem jön vissza. Indítsd újra: npm start',
        })
        return
      }

      const back = await waitForGateway()
      setRestartResult(
        back
          ? { ok: true, text: 'A gateway újraindult és válaszol.' }
          : { ok: false, text: 'Az újraindítás elindult, de a gateway 30 mp alatt nem jött vissza.' }
      )
      if (back) onRefreshed()
    } catch (err) {
      // A kapcsolat megszakadása itt VÁRT: a szerver épp kilép.
      const back = await waitForGateway()
      setRestartResult(
        back
          ? { ok: true, text: 'A gateway újraindult és válaszol.' }
          : { ok: false, text: `Nem jött vissza: ${(err as Error).message}` }
      )
      if (back) onRefreshed()
    } finally {
      setRestarting(false)
    }
  }

  const handleReloadGtfs = async () => {
    setReloading(true)
    setReloadResult(null)
    try {
      const res = await fetch(getSystemUrl('/system/reload-gtfs'), { method: 'POST', headers: adminHeaders() })
      const data = await res.json()
      setReloadResult(
        data.ok
          ? {
              ok: true,
              text: `Menetrend frissítve: ${data.stops} megálló, ${data.routes} járat, ${data.trips} menet (${data.feedVersion}).`,
            }
          : { ok: false, text: data.error || 'A menetrend frissítése nem sikerült.' }
      )
      if (data.ok) onRefreshed()
    } catch (err) {
      setReloadResult({ ok: false, text: (err as Error).message })
    } finally {
      setReloading(false)
    }
  }

  const handleRefreshAppToken = async () => {
    setTokenRefreshing(true)
    setTokenResult(null)
    try {
      const res = await fetch(getSystemUrl('/system/refresh-app-token'), { method: 'POST', headers: adminHeaders() })
      const data = await res.json()
      setTokenResult({
        ok: Boolean(res.ok && data.ok),
        text: data.message || data.error || 'Ismeretlen válasz.',
      })
      if (data.ok) onRefreshed()
    } catch (err) {
      setTokenResult({ ok: false, text: (err as Error).message })
    } finally {
      setTokenRefreshing(false)
    }
  }

  const handleSaveJwt = async () => {
    if (!jwtInput.trim()) return
    setSaving(true)
    setSaveResult(null)
    try {
      const body = instInput.trim()
        ? JSON.stringify({ jwt: jwtInput.trim(), installationId: instInput.trim() })
        : jwtInput.trim()
      const res = await fetch(getSystemUrl('/_ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        setSaveResult({ ok: true, text: 'Token elmentve.' })
        setJwtInput('')
        setInstInput('')
        onRefreshed()
      } else {
        setSaveResult({ ok: false, text: data.error || 'Érvénytelen token.' })
      }
    } catch (err) {
      setSaveResult({ ok: false, text: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const handleCopyExport = async () => {
    try {
      const res = await fetch(getSystemUrl('/_export')).then((r) => r.json())
      await navigator.clipboard.writeText(JSON.stringify(res, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* a vágólap megtagadható — a gomb ilyenkor nem vált állapotot */
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Folyamatvezérlés */}
      <Card className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="text-base font-bold tracking-tight">Folyamatvezérlés</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A gateway újraindítása és a menetrend frissítése leállás nélkül.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" onClick={handleRestart} disabled={restarting}>
            <Power className={cn(restarting && 'animate-pulse')} />
            {restarting ? 'Újraindítás…' : 'Gateway újraindítása'}
          </Button>

          <Button variant="outline" onClick={handleReloadGtfs} disabled={reloading}>
            <DownloadCloud className={cn(reloading && 'animate-pulse')} />
            {reloading ? 'Letöltés…' : 'GTFS újratöltése'}
          </Button>
        </div>

        <Result result={restartResult} />
        <Result result={reloadResult} />
      </Card>

      {/* Token */}
      <Card className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
            <Key className="h-4 w-4 text-primary" />
            MVK token
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Friss App Attest token kinyerése a Mac-es MVK appból, vagy meglévő JWT beillesztése.
          </p>
        </div>

        <Button onClick={handleRefreshAppToken} disabled={tokenRefreshing}>
          <RotateCw className={cn(tokenRefreshing && 'animate-spin')} />
          {tokenRefreshing ? 'App újraindítása…' : 'Token frissítése az appból'}
        </Button>

        <Result result={tokenResult} />

        <div className="space-y-2 border-t border-border pt-3">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Kézi JWT
          </label>
          <Textarea
            value={jwtInput}
            onChange={(e) => setJwtInput(e.target.value)}
            placeholder="eyJhbGciOiJIUzI1NiJ9..."
            rows={3}
            className="font-mono text-xs"
          />
          <Input
            value={instInput}
            onChange={(e) => setInstInput(e.target.value)}
            placeholder="Opcionális installation-id"
            className="font-mono text-xs"
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={handleSaveJwt} disabled={saving || !jwtInput.trim()}>
              <Key />
              Mentés
            </Button>
            <Button variant="outline" size="sm" onClick={handleCopyExport}>
              {copied ? <Check className="text-primary" /> : <Copy />}
              {copied ? 'Másolva' : 'Token exportálása'}
            </Button>
          </div>

          <Result result={saveResult} />
        </div>
      </Card>
    </div>
  )
}
