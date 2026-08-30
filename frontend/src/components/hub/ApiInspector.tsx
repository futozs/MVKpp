import React, { useState } from 'react'
import { Play, Clock, Code, CheckCircle, AlertCircle, Copy, Check } from 'lucide-react'

export const ApiInspector: React.FC = () => {
  const [selectedEndpoint, setSelectedEndpoint] = useState('/live/positions')
  const [customParam, setCustomParam] = useState('')
  const [response, setResponse] = useState<string | null>(null)
  const [statusCode, setStatusCode] = useState<number | null>(null)
  const [responseTime, setResponseTime] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const presetEndpoints = [
    { name: 'Élő járműpozíciók (Protobuf dec)', path: '/live/positions', defaultParam: '' },
    { name: 'Valós érkezések megállóhoz', path: '/live/arrivals', defaultParam: '?stop=SP1&limit=6' },
    { name: 'Több megálló valós érkezései', path: '/live/multi-arrivals', defaultParam: '?stops=SP1,SP2&limit=5' },
    { name: 'Egy jármű élő állapota (ID)', path: '/live/vehicle', defaultParam: '?id=1641' },
    { name: 'Járat nyomvonal (GTFS)', path: '/gtfs/route-geo', defaultParam: '?route=20,1V' },
    { name: 'GTFS Megállók lista', path: '/gtfs/stops.json', defaultParam: '' },
    { name: 'GTFS Járatok lista', path: '/gtfs/routes.json', defaultParam: '' },
    { name: 'Megálló diagnosztika (Debug)', path: '/live/debug', defaultParam: '?stop=SP1' },
    { name: 'Rendszer információ & Memória', path: '/system/info', defaultParam: '' },
    { name: 'Egészségügyi állapot (_health)', path: '/_health', defaultParam: '' },
  ]

  const handleSelectPreset = (ep: typeof presetEndpoints[0]) => {
    setSelectedEndpoint(ep.path)
    setCustomParam(ep.defaultParam)
  }

  const handleExecute = async () => {
    setLoading(true)
    setResponse(null)
    setStatusCode(null)
    const startTime = performance.now()

    const fullUrl = selectedEndpoint + (customParam ? customParam : '')

    try {
      const res = await fetch(fullUrl)
      const duration = Math.round(performance.now() - startTime)
      setResponseTime(duration)
      setStatusCode(res.status)

      const text = await res.text()
      try {
        const json = JSON.parse(text)
        setResponse(JSON.stringify(json, null, 2))
      } catch {
        setResponse(text)
      }
    } catch (err) {
      setResponseTime(Math.round(performance.now() - startTime))
      setStatusCode(0)
      setResponse(`Hálózati hiba: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = () => {
    if (response) {
      navigator.clipboard.writeText(response)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="bg-[#141820] border border-[#283344] rounded-3xl p-5 md:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-extrabold text-base text-white flex items-center gap-2">
            <Code className="w-5 h-5 text-[#FDCC00]" />
            Beépített API Inspector & Végpont Tesztelő
          </h3>
          <p className="text-xs text-[#94a3b8] mt-0.5">
            Közvetlen REST hívások végrehajtása a helyi MVK gateway felé valós idejű válaszidővel és formázott JSON-nal.
          </p>
        </div>
      </div>

      {/* Presets Bar */}
      <div className="flex flex-wrap gap-1.5">
        {presetEndpoints.map((ep) => (
          <button
            key={ep.path}
            onClick={() => handleSelectPreset(ep)}
            className={`px-2.5 py-1 rounded-xl text-xs font-semibold border transition-all ${
              selectedEndpoint === ep.path
                ? 'bg-[#FDCC00] text-black border-[#FDCC00] font-bold shadow-sm'
                : 'bg-[#1c232d] text-[#94a3b8] hover:text-white border-[#283344] hover:border-[#38455a]'
            }`}
          >
            {ep.name}
          </button>
        ))}
      </div>

      {/* URL Input & Execute */}
      <div className="flex flex-col sm:flex-row items-stretch gap-2">
        <div className="flex-1 flex items-center bg-[#12161f] border border-[#283344] focus-within:border-[#FDCC00] rounded-2xl px-3 py-2 transition-all font-mono text-xs">
          <span className="text-[#64748b] select-none font-bold mr-1">GET</span>
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
          onClick={handleExecute}
          disabled={loading}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl bg-[#FDCC00] text-black font-extrabold text-xs hover:bg-[#E5B800] transition-all disabled:opacity-50 shrink-0"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>{loading ? 'Futtatás…' : 'Hívás küldése'}</span>
        </button>
      </div>

      {/* Response Box */}
      {statusCode !== null && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 font-bold">
                {statusCode >= 200 && statusCode < 300 ? (
                  <CheckCircle className="w-4 h-4 text-[#3ddc84]" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-400" />
                )}
                <span
                  className={
                    statusCode >= 200 && statusCode < 300 ? 'text-[#3ddc84]' : 'text-red-400'
                  }
                >
                  HTTP {statusCode}
                </span>
              </span>

              {responseTime != null && (
                <span className="text-[#94a3b8] flex items-center gap-1 font-mono">
                  <Clock className="w-3.5 h-3.5" />
                  {responseTime} ms
                </span>
              )}
            </div>

            {response && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[11px] text-[#94a3b8] hover:text-white"
              >
                {copied ? <Check className="w-3 h-3 text-[#3ddc84]" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Másolva' : 'Másolás'}</span>
              </button>
            )}
          </div>

          <pre className="p-4 rounded-2xl bg-[#0e1116] border border-[#283344] text-xs font-mono text-[#e2e8f0] overflow-x-auto max-h-96 leading-relaxed">
            {response}
          </pre>
        </div>
      )}
    </div>
  )
}
