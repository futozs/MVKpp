import React, { useState, useEffect } from 'react'
import {
  Server,
  Activity,
  ShieldCheck,
  ShieldAlert,
  Database,
  Cpu,
  RefreshCw,
  Key,
  Terminal,
  Code,
  Play,
  Copy,
  Check,
  ExternalLink,
  RotateCw,
  CheckCircle,
  AlertCircle,
} from 'lucide-react'

interface JwtStatus {
  present: boolean
  exp?: number
  expiresInSec?: number | null
  expired?: boolean
  installationId?: string
}

interface HealthResponse {
  jwt: JwtStatus
  autoRenew: boolean
  lastRenew: {
    at: string
    ok: boolean
    status?: number
    note?: string
  } | null
  tokenRejected: boolean
  gtfs: {
    feedVersion: string
    stops: number
  }
  installationIdKnown: boolean
}

interface SystemInfoResponse {
  uptimeSec: number
  nodeVersion: string
  memory: {
    rssMb: number
    heapUsedMb: number
    heapTotalMb: number
  }
  gtfs: {
    feedVersion: string
    stops: number
    routes: number
    trips: number
    shapes: number
  }
  jwt: JwtStatus
  installationId: string | null
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfoResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshingToken, setRefreshingToken] = useState(false)
  const [tokenActionMsg, setTokenActionMsg] = useState<{ text: string; ok: boolean } | null>(null)

  // Manual token input state
  const [jwtInput, setJwtInput] = useState('')
  const [instInput, setInstInput] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  const [manualMsg, setManualMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [tokenCopied, setTokenCopied] = useState(false)

  // API Inspector State
  const [selectedEndpoint, setSelectedEndpoint] = useState('/live/positions')
  const [customParam, setCustomParam] = useState('')
  const [apiResponse, setApiResponse] = useState<string | null>(null)
  const [apiStatus, setApiStatus] = useState<number | null>(null)
  const [apiDuration, setApiDuration] = useState<number | null>(null)
  const [apiLoading, setApiLoading] = useState(false)
  const [apiCopied, setApiCopied] = useState(false)

  const presetEndpoints = [
    { name: 'Élő járműpozíciók', path: '/live/positions', defaultParam: '' },
    { name: 'Valós érkezések megállóhoz', path: '/live/arrivals', defaultParam: '?stop=SP1&limit=6' },
    { name: 'Multi-megálló érkezések', path: '/live/multi-arrivals', defaultParam: '?stops=SP1,SP2&limit=5' },
    { name: 'Egy jármű élő állapota', path: '/live/vehicle', defaultParam: '?id=1641' },
    { name: 'Járat nyomvonal (GTFS)', path: '/gtfs/route-geo', defaultParam: '?route=20,1V' },
    { name: 'GTFS Megállók lista', path: '/gtfs/stops.json', defaultParam: '' },
    { name: 'GTFS Járatok lista', path: '/gtfs/routes.json', defaultParam: '' },
    { name: 'Megálló diagnosztika (Debug)', path: '/live/debug', defaultParam: '?stop=SP1' },
    { name: 'Rendszer információ & Memória', path: '/system/info', defaultParam: '' },
    { name: 'Egészségügyi állapot (_health)', path: '/_health', defaultParam: '' },
  ]

  const fetchHealthAndInfo = async () => {
    setLoading(true)
    try {
      const [hRes, sRes] = await Promise.all([
        fetch('/_health').then((r) => r.json()),
        fetch('/system/info').then((r) => r.json()).catch(() => null),
      ])
      setHealth(hRes)
      if (sRes) setSysInfo(sRes)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchHealthAndInfo()
    const interval = setInterval(fetchHealthAndInfo, 10000)
    return () => clearInterval(interval)
  }, [])

  // Trigger app restart & token refresh
  const handleRefreshAppToken = async () => {
    setRefreshingToken(true)
    setTokenActionMsg(null)
    try {
      const res = await fetch('/system/refresh-app-token', { method: 'POST' })
      const data = await res.json()
      if (res.ok && data.ok) {
        setTokenActionMsg({ text: data.message || 'Token sikeresen frissítve!', ok: true })
        fetchHealthAndInfo()
      } else {
        setTokenActionMsg({ text: data.error || 'A token frissítése sikertelen.', ok: false })
      }
    } catch (err) {
      setTokenActionMsg({ text: `Hiba: ${(err as Error).message}`, ok: false })
    } finally {
      setRefreshingToken(false)
    }
  }

  // Handle manual JWT ingest
  const handleManualIngest = async () => {
    if (!jwtInput.trim()) return
    setManualSaving(true)
    setManualMsg(null)
    try {
      const body = instInput.trim()
        ? JSON.stringify({ jwt: jwtInput.trim(), installationId: instInput.trim() })
        : jwtInput.trim()
      const res = await fetch('/_ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        setManualMsg({ text: 'Token sikeresen elmentve!', ok: true })
        setJwtInput('')
        setInstInput('')
        fetchHealthAndInfo()
      } else {
        setManualMsg({ text: `Hiba: ${data.error || 'Érvénytelen token'}`, ok: false })
      }
    } catch (err) {
      setManualMsg({ text: `Hiba: ${(err as Error).message}`, ok: false })
    } finally {
      setManualSaving(false)
    }
  }

  // Handle Export Copy
  const handleCopyExport = async () => {
    try {
      const res = await fetch('/_export').then((r) => r.json())
      await navigator.clipboard.writeText(JSON.stringify(res, null, 2))
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  // Handle API Execution
  const handleExecuteApi = async () => {
    setApiLoading(true)
    setApiResponse(null)
    setApiStatus(null)
    const startTime = performance.now()
    const fullUrl = selectedEndpoint + (customParam ? customParam : '')

    try {
      const res = await fetch(fullUrl)
      const dur = Math.round(performance.now() - startTime)
      setApiDuration(dur)
      setApiStatus(res.status)
      const text = await res.text()
      try {
        setApiResponse(JSON.stringify(JSON.parse(text), null, 2))
      } catch {
        setApiResponse(text)
      }
    } catch (err) {
      setApiDuration(Math.round(performance.now() - startTime))
      setApiStatus(0)
      setApiResponse(`Hiba: ${(err as Error).message}`)
    } finally {
      setApiLoading(false)
    }
  }

  const jwt = health?.jwt
  const isTokenOk = jwt?.present && !jwt?.expired
  const minLeft = jwt?.expiresInSec != null ? Math.round(jwt.expiresInSec / 60) : null

  const formatUptime = (sec: number) => {
    const d = Math.floor(sec / 86400)
    const h = Math.floor((sec % 86400) / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (d > 0) return `${d} nap ${h} óra`
    if (h > 0) return `${h} óra ${m} perc`
    return `${m} perc ${s} mp`
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0c0f14] text-[#e2e8f0] overflow-hidden">
      {/* Top Header */}
      <header className="h-14 bg-[#141820] border-b border-[#283344] px-4 md:px-6 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#FDCC00] text-black flex items-center justify-center font-black">
            <Server className="w-4 h-4 text-black stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-extrabold text-sm md:text-base tracking-tight text-white">
                MVK MobilON+ <span className="text-[#FDCC00]">Rendszer Hub</span>
              </h1>
              <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-[#1c232d] text-[#FDCC00] border border-[#283344]">
                Port :5174
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="http://localhost:5173"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-xs font-semibold text-[#e2e8f0] border border-[#283344] hover:border-[#FDCC00] transition-all"
          >
            <span>Fő Dashboard (:5173)</span>
            <ExternalLink className="w-3.5 h-3.5 text-[#FDCC00]" />
          </a>

          <button
            onClick={fetchHealthAndInfo}
            disabled={loading}
            className="p-2 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-[#94a3b8] hover:text-white border border-[#283344] transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#FDCC00]' : ''}`} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {/* Metric Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* 1. JWT Token Health Card */}
          <div className="bg-[#141820] border border-[#283344] rounded-2xl p-5 flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
                Token Állapot
              </span>
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  isTokenOk
                    ? 'bg-emerald-950/60 text-[#3ddc84] border border-emerald-800/60'
                    : 'bg-red-950/60 text-red-400 border border-red-800/60'
                }`}
              >
                {isTokenOk ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
              </div>
            </div>

            <div>
              <div className="text-lg font-black text-white font-mono">
                {isTokenOk ? `${minLeft} perc érvényes` : jwt?.expired ? 'LEJÁRT' : 'Nincs Token'}
              </div>
              <div className="text-[11px] text-[#94a3b8] mt-1 font-mono truncate" title={jwt?.installationId}>
                {jwt?.installationId ? `ID: ${jwt.installationId.slice(0, 14)}…` : 'Nincs installation-id'}
              </div>
            </div>

            {jwt?.expiresInSec != null && (
              <div className="w-full bg-[#1c232d] h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    minLeft && minLeft > 60 ? 'bg-[#3ddc84]' : 'bg-[#FDCC00]'
                  }`}
                  style={{
                    width: `${Math.min(100, Math.max(5, (jwt.expiresInSec / (9 * 3600)) * 100))}%`,
                  }}
                />
              </div>
            )}
          </div>

          {/* 2. Backend Gateway Health Card */}
          <div className="bg-[#141820] border border-[#283344] rounded-2xl p-5 flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
                Backend Gateway
              </span>
              <div className="w-7 h-7 rounded-lg bg-emerald-950/60 text-[#3ddc84] border border-emerald-800/60 flex items-center justify-center">
                <Activity className="w-4 h-4" />
              </div>
            </div>

            <div>
              <div className="text-lg font-black text-white font-mono">
                {sysInfo ? formatUptime(sysInfo.uptimeSec) : 'Online'}
              </div>
              <div className="text-[11px] text-[#94a3b8] mt-1 font-mono">
                Port: <strong className="text-white">8088</strong> · Node {sysInfo?.nodeVersion || 'v26'}
              </div>
            </div>

            <div className="text-[11px] text-[#3ddc84] font-semibold flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#3ddc84]" />
              Hono REST Engine aktív
            </div>
          </div>

          {/* 3. GTFS Engine Card */}
          <div className="bg-[#141820] border border-[#283344] rounded-2xl p-5 flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
                GTFS Statikus Motor
              </span>
              <div className="w-7 h-7 rounded-lg bg-[#1c232d] text-[#FDCC00] border border-[#283344] flex items-center justify-center">
                <Database className="w-4 h-4" />
              </div>
            </div>

            <div>
              <div className="text-lg font-black text-white font-mono">
                {health?.gtfs.stops || sysInfo?.gtfs.stops || '—'} megálló
              </div>
              <div className="text-[11px] text-[#94a3b8] mt-1 font-mono">
                {sysInfo?.gtfs.routes || '—'} járat · {sysInfo?.gtfs.trips || '—'} menet
              </div>
            </div>

            <div className="text-[11px] text-[#94a3b8] truncate font-mono" title={health?.gtfs.feedVersion}>
              Verzió: {health?.gtfs.feedVersion || 'MVK Auto-Sync'}
            </div>
          </div>

          {/* 4. Memory Usage Card */}
          <div className="bg-[#141820] border border-[#283344] rounded-2xl p-5 flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
                Memóriahasználat
              </span>
              <div className="w-7 h-7 rounded-lg bg-[#1c232d] text-cyan-400 border border-[#283344] flex items-center justify-center">
                <Cpu className="w-4 h-4" />
              </div>
            </div>

            <div>
              <div className="text-lg font-black text-white font-mono">
                {sysInfo ? `${sysInfo.memory.rssMb} MB` : '—'}
              </div>
              <div className="text-[11px] text-[#94a3b8] mt-1 font-mono">
                Heap: {sysInfo ? `${sysInfo.memory.heapUsedMb} / ${sysInfo.memory.heapTotalMb} MB` : '—'}
              </div>
            </div>

            <div className="text-[11px] text-[#94a3b8]">
              Optimalizált Node profil
            </div>
          </div>
        </div>

        {/* Token Management Section */}
        <div className="bg-[#141820] border border-[#283344] rounded-2xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-extrabold text-base text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-[#FDCC00]" />
                MVK Token Vezérlés & App Újraindítás
              </h2>
              <p className="text-xs text-[#94a3b8] mt-0.5">
                Kérj le friss App Attest tokent a Mac-es MVK MobilON+ appból, vagy illessz be egy meglévő JWT-t.
              </p>
            </div>

            {/* Native App Refresh Trigger Button */}
            <button
              onClick={handleRefreshAppToken}
              disabled={refreshingToken}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#FDCC00] text-black font-extrabold text-xs hover:bg-[#E5B800] transition-all disabled:opacity-50 shadow-md shadow-[#FDCC00]/10"
            >
              <RotateCw className={`w-4 h-4 ${refreshingToken ? 'animate-spin' : ''}`} />
              <span>{refreshingToken ? 'App újraindítása & kinyerés…' : 'Token frissítése az MVK Appból'}</span>
            </button>
          </div>

          {tokenActionMsg && (
            <div
              className={`p-3 rounded-xl text-xs font-medium border flex items-center gap-2 ${
                tokenActionMsg.ok
                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
                  : 'bg-red-950/40 text-red-300 border-red-800/60'
              }`}
            >
              {tokenActionMsg.ok ? <CheckCircle className="w-4 h-4 shrink-0 text-[#3ddc84]" /> : <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />}
              <span>{tokenActionMsg.text}</span>
            </div>
          )}

          {/* Manual Input Grid */}
          <div className="pt-2 grid grid-cols-1 lg:grid-cols-2 gap-4 border-t border-[#1e2634]">
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-[#e2e8f0]">
                Kézi JWT Token Beillesztése
              </label>
              <textarea
                value={jwtInput}
                onChange={(e) => setJwtInput(e.target.value)}
                placeholder="eyJhbGciOiJIUzI1NiJ9..."
                rows={3}
                className="w-full bg-[#12161f] border border-[#283344] focus:border-[#FDCC00] text-xs text-white font-mono rounded-xl p-2.5 outline-none transition-all placeholder:text-[#64748b]"
              />
            </div>

            <div className="space-y-2 flex flex-col justify-between">
              <div>
                <label className="block text-xs font-semibold text-[#e2e8f0]">
                  Opcionális Installation ID
                </label>
                <input
                  type="text"
                  value={instInput}
                  onChange={(e) => setInstInput(e.target.value)}
                  placeholder="0b38e417-63b2-..."
                  className="w-full bg-[#12161f] border border-[#283344] focus:border-[#FDCC00] text-xs text-white font-mono rounded-xl px-3 py-2 outline-none transition-all placeholder:text-[#64748b]"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  onClick={handleCopyExport}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-[#94a3b8] hover:text-white border border-[#283344] text-xs font-semibold transition-all"
                >
                  {tokenCopied ? <Check className="w-3.5 h-3.5 text-[#3ddc84]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{tokenCopied ? 'Másolva!' : 'Token exportálása'}</span>
                </button>

                <button
                  onClick={handleManualIngest}
                  disabled={manualSaving || !jwtInput.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-xs font-bold text-[#FDCC00] border border-[#283344] hover:border-[#FDCC00] transition-all disabled:opacity-40"
                >
                  <Key className="w-3.5 h-3.5" />
                  <span>Kézi JWT mentése</span>
                </button>
              </div>
            </div>
          </div>

          {manualMsg && (
            <div
              className={`p-3 rounded-xl text-xs font-medium border ${
                manualMsg.ok
                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
                  : 'bg-red-950/40 text-red-300 border-red-800/60'
              }`}
            >
              {manualMsg.text}
            </div>
          )}
        </div>

        {/* Built-in API Inspector */}
        <div className="bg-[#141820] border border-[#283344] rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="font-extrabold text-base text-white flex items-center gap-2">
              <Code className="w-4 h-4 text-[#FDCC00]" />
              Beépített REST API Inspector & Végpont Tesztelő
            </h2>
            <p className="text-xs text-[#94a3b8] mt-0.5">
              Közvetlen hívások futtatása a gateway felé válaszidővel és syntax-highlighted JSON nézettel.
            </p>
          </div>

          {/* Preset Buttons */}
          <div className="flex flex-wrap gap-1.5">
            {presetEndpoints.map((ep) => (
              <button
                key={ep.path}
                onClick={() => {
                  setSelectedEndpoint(ep.path)
                  setCustomParam(ep.defaultParam)
                }}
                className={`px-2.5 py-1 rounded-xl text-xs font-semibold border transition-all ${
                  selectedEndpoint === ep.path
                    ? 'bg-[#FDCC00] text-black border-[#FDCC00] font-bold shadow-sm'
                    : 'bg-[#1c232d] text-[#94a3b8] hover:text-white border-[#283344]'
                }`}
              >
                {ep.name}
              </button>
            ))}
          </div>

          {/* Request Input */}
          <div className="flex flex-col sm:flex-row items-stretch gap-2">
            <div className="flex-1 flex items-center bg-[#12161f] border border-[#283344] focus-within:border-[#FDCC00] rounded-xl px-3 py-2 font-mono text-xs">
              <span className="text-[#64748b] font-bold mr-1 select-none">GET</span>
              <span className="text-[#FDCC00] font-bold select-none">{selectedEndpoint}</span>
              <input
                type="text"
                value={customParam}
                onChange={(e) => setCustomParam(e.target.value)}
                placeholder="?param=érték..."
                className="flex-1 bg-transparent text-white outline-none pl-1"
              />
            </div>

            <button
              onClick={handleExecuteApi}
              disabled={apiLoading}
              className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#FDCC00] text-black font-extrabold text-xs hover:bg-[#E5B800] transition-all disabled:opacity-50 shrink-0"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{apiLoading ? 'Futtatás…' : 'Hívás küldése'}</span>
            </button>
          </div>

          {/* Response Box */}
          {apiStatus !== null && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 font-bold">
                    {apiStatus >= 200 && apiStatus < 300 ? (
                      <CheckCircle className="w-4 h-4 text-[#3ddc84]" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-400" />
                    )}
                    <span
                      className={
                        apiStatus >= 200 && apiStatus < 300 ? 'text-[#3ddc84]' : 'text-red-400'
                      }
                    >
                      HTTP {apiStatus}
                    </span>
                  </span>

                  {apiDuration != null && (
                    <span className="text-[#94a3b8] font-mono">
                      {apiDuration} ms
                    </span>
                  )}
                </div>

                {apiResponse && (
                  <button
                    onClick={() => {
                      if (apiResponse) {
                        navigator.clipboard.writeText(apiResponse)
                        setApiCopied(true)
                        setTimeout(() => setApiCopied(false), 2000)
                      }
                    }}
                    className="flex items-center gap-1 text-[11px] text-[#94a3b8] hover:text-white"
                  >
                    {apiCopied ? <Check className="w-3 h-3 text-[#3ddc84]" /> : <Copy className="w-3 h-3" />}
                    <span>{apiCopied ? 'Másolva' : 'Másolás'}</span>
                  </button>
                )}
              </div>

              <pre className="p-4 rounded-xl bg-[#0e1116] border border-[#283344] text-xs font-mono text-[#e2e8f0] overflow-x-auto max-h-96 leading-relaxed">
                {apiResponse}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
export default App
