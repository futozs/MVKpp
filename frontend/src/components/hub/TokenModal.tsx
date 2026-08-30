import React, { useState } from 'react'
import {
  X,
  ShieldCheck,
  ShieldAlert,
  Key,
  Copy,
  Check,
  Terminal,
} from 'lucide-react'
import type { HealthResponse } from '../../types'
import { api } from '../../services/api'

interface TokenModalProps {
  isOpen: boolean
  onClose: () => void
  health: HealthResponse | null
  onRefreshHealth: () => void
}

export const TokenModal: React.FC<TokenModalProps> = ({
  isOpen,
  onClose,
  health,
  onRefreshHealth,
}) => {
  const [jwtInput, setJwtInput] = useState('')
  const [instInput, setInstInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!isOpen) return null

  const jwt = health?.jwt
  const isOk = jwt?.present && !jwt?.expired
  const minLeft = jwt?.expiresInSec != null ? Math.round(jwt.expiresInSec / 60) : null

  const handleIngest = async () => {
    if (!jwtInput.trim()) return
    setLoading(true)
    setMessage(null)
    try {
      const res = await api.ingestToken(jwtInput.trim(), instInput.trim() || undefined)
      if (res.ok) {
        setMessage({ text: '✅ Token sikeresen betöltve a gateway-be!', type: 'ok' })
        setJwtInput('')
        setInstInput('')
        onRefreshHealth()
      } else {
        setMessage({ text: `❌ Hiba: ${res.error || 'Érvénytelen token'}`, type: 'err' })
      }
    } catch (err) {
      setMessage({ text: `❌ Hiba: ${(err as Error).message}`, type: 'err' })
    } finally {
      setLoading(false)
    }
  }

  const handleRenew = async () => {
    setLoading(true)
    setMessage(null)
    try {
      const res = await api.renewToken()
      if (res.triggered) {
        setMessage({ text: 'Megújítás kezdeményezve.', type: 'ok' })
        onRefreshHealth()
      }
    } catch (err) {
      setMessage({ text: `❌ Megújítás sikertelen (attesztáció szükséges): ${(err as Error).message}`, type: 'err' })
    } finally {
      setLoading(false)
    }
  }

  const handleCopyExport = async () => {
    try {
      const exp = await api.exportCredentials()
      await navigator.clipboard.writeText(JSON.stringify(exp, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-150">
      <div className="bg-[#161b22] border border-[#283344] rounded-3xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 bg-[#1a202c] border-b border-[#283344] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-2xl flex items-center justify-center ${
                isOk
                  ? 'bg-emerald-950/60 text-[#3ddc84] border border-emerald-800/60'
                  : 'bg-red-950/60 text-red-400 border border-red-800/60'
              }`}
            >
              {isOk ? <ShieldCheck className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
            </div>
            <div>
              <h2 className="font-extrabold text-base text-white">MVK Hitelesítési Token (JWT)</h2>
              <p className="text-xs text-[#94a3b8]">
                Valós idejű MVK API hozzáférés és hitelesítés kezelése
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-[#94a3b8] hover:text-white hover:bg-[#283344] transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Status Box */}
          <div className="p-4 rounded-2xl bg-[#12161f] border border-[#283344] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider">
                Jelenlegi Állapot
              </span>
              <span
                className={`text-xs font-extrabold px-2.5 py-0.5 rounded-full border ${
                  isOk
                    ? 'bg-emerald-950/60 text-[#3ddc84] border-emerald-800/60'
                    : 'bg-red-950/60 text-red-400 border-red-800/60'
                }`}
              >
                {isOk ? 'Érvényes (Aktív)' : jwt?.expired ? 'Lejárt' : 'Nincs Token'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1 text-xs">
              <div>
                <div className="text-[#64748b]">Hátralévő érvényesség:</div>
                <div className="font-bold text-white font-mono text-sm mt-0.5">
                  {minLeft != null ? `${minLeft} perc` : '—'}
                </div>
              </div>
              <div>
                <div className="text-[#64748b]">Telepítés azonosító (ID):</div>
                <div className="font-bold text-white font-mono truncate mt-0.5" title={jwt?.installationId}>
                  {jwt?.installationId ? `${jwt.installationId.slice(0, 12)}…` : '—'}
                </div>
              </div>
            </div>

            {/* Progress bar */}
            {jwt?.expiresInSec != null && (
              <div className="w-full bg-[#1c232d] h-2 rounded-full overflow-hidden mt-2">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    minLeft && minLeft > 60 ? 'bg-[#3ddc84]' : 'bg-[#FDCC00]'
                  }`}
                  style={{
                    width: `${Math.min(100, Math.max(5, (jwt.expiresInSec / (9 * 3600)) * 100))}%`,
                  }}
                />
              </div>
            )}
          </div>

          {/* Ingest New Token Form */}
          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-extrabold text-white uppercase tracking-wider flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-[#FDCC00]" />
              Új Token Betöltése (Paste / Ingest)
            </h3>

            <div>
              <label className="block text-[11px] text-[#94a3b8] mb-1">
                JWT Token (eyJ... kezdetű sztring vagy export JSON)
              </label>
              <textarea
                value={jwtInput}
                onChange={(e) => setJwtInput(e.target.value)}
                placeholder="Illeszd be ide az új JWT tokent..."
                rows={3}
                className="w-full bg-[#12161f] border border-[#283344] focus:border-[#FDCC00] text-xs text-white font-mono rounded-xl p-2.5 outline-none transition-all placeholder:text-[#64748b]"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[#94a3b8] mb-1">
                Opcionális Installation ID
              </label>
              <input
                type="text"
                value={instInput}
                onChange={(e) => setInstInput(e.target.value)}
                placeholder="pl. 0b38e417-63b2-4299-abb4-..."
                className="w-full bg-[#12161f] border border-[#283344] focus:border-[#FDCC00] text-xs text-white font-mono rounded-xl px-3 py-2 outline-none transition-all placeholder:text-[#64748b]"
              />
            </div>

            {message && (
              <div
                className={`p-3 rounded-xl text-xs font-medium border ${
                  message.type === 'ok'
                    ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
                    : 'bg-red-950/40 text-red-300 border-red-800/60'
                }`}
              >
                {message.text}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <button
                onClick={handleCopyExport}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-[#94a3b8] hover:text-white border border-[#283344] text-xs font-semibold transition-all"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#3ddc84]" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Másolva!' : 'Token exportálása'}</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleRenew}
                  disabled={loading}
                  className="px-3 py-2 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-[#94a3b8] hover:text-white border border-[#283344] text-xs font-semibold transition-all disabled:opacity-50"
                >
                  Megújítás próba
                </button>
                <button
                  onClick={handleIngest}
                  disabled={loading || !jwtInput.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#FDCC00] text-black text-xs font-extrabold hover:bg-[#E5B800] transition-all disabled:opacity-40 disabled:pointer-events-none"
                >
                  <Key className="w-3.5 h-3.5" />
                  <span>Token mentése</span>
                </button>
              </div>
            </div>
          </div>

          {/* Token Worker Guide Hint */}
          <div className="p-3 rounded-2xl bg-[#12161f] border border-[#283344] flex items-start gap-2.5 text-xs text-[#94a3b8]">
            <Terminal className="w-4 h-4 text-[#FDCC00] shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              <strong className="text-white">Automatikus frissítés Mac-en:</strong> A háttérben futó{' '}
              <code className="text-[#FDCC00] font-mono">token_worker.sh</code> a Mac-re telepített
              MVK MobilON+ appból automatikusan betáplálja a legfrissebb tokent a háttérben.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
