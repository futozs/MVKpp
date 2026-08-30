import React, { useState, useEffect } from "react";
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
} from "lucide-react";
import type { HealthResponse, SystemInfoResponse, GtfsMeta } from "../../types";
import { api } from "../../services/api";
import { ApiInspector } from "./ApiInspector";

interface SystemHubProps {
  health: HealthResponse | null;
  gtfsMeta: GtfsMeta | null;
  onOpenTokenModal: () => void;
  onRefreshHealth: () => void;
}

export const SystemHub: React.FC<SystemHubProps> = ({
  health,
  gtfsMeta,
  onOpenTokenModal,
  onRefreshHealth,
}) => {
  const [sysInfo, setSysInfo] = useState<SystemInfoResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSysInfo = async () => {
    setLoading(true);
    try {
      const data = await api.getSystemInfo();
      setSysInfo(data);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSysInfo();
  }, []);

  const jwt = health?.jwt;
  const isTokenOk = jwt?.present && !jwt?.expired;
  const tokenMinLeft =
    jwt?.expiresInSec != null ? Math.round(jwt.expiresInSec / 60) : null;

  const formatUptime = (sec: number) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return `${d} nap ${h} óra`;
    if (h > 0) return `${h} óra ${m} perc`;
    return `${m} perc ${s} mp`;
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0c0f14] overflow-y-auto p-4 md:p-6 space-y-6">
      {}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-extrabold text-lg md:text-xl text-white flex items-center gap-2.5">
            <Server className="w-6 h-6 text-[#FDCC00]" />
            Rendszer Hub & MVK Instance Manager
          </h2>
          <p className="text-xs text-[#94a3b8] mt-1 max-w-xl">
            Valós idejű telemetria, GTFS motor állapot, hitelesítési token
            vezérlés és beépített API tesztelő.
          </p>
        </div>

        <button
          onClick={() => {
            onRefreshHealth();
            fetchSysInfo();
          }}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-[#1c232d] hover:bg-[#283344] text-white border border-[#283344] text-xs font-bold transition-all"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[#FDCC00]" : ""}`}
          />
          <span>Állapot frissítése</span>
        </button>
      </div>

      {}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {}
        <div className="bg-[#141820] border border-[#283344] rounded-3xl p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
              Token Állapot
            </span>
            <div
              className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                isTokenOk
                  ? "bg-emerald-950/60 text-[#3ddc84]"
                  : "bg-red-950/60 text-red-400"
              }`}
            >
              {isTokenOk ? (
                <ShieldCheck className="w-4 h-4" />
              ) : (
                <ShieldAlert className="w-4 h-4" />
              )}
            </div>
          </div>

          <div>
            <div className="text-xl font-black text-white font-mono tracking-tight">
              {isTokenOk
                ? `${tokenMinLeft} perc érvényes`
                : jwt?.expired
                  ? "LEJÁRT"
                  : "Hiányzik"}
            </div>
            <div className="text-xs text-[#94a3b8] mt-1 font-mono truncate">
              {jwt?.installationId
                ? `ID: ${jwt.installationId.slice(0, 14)}…`
                : "Nincs installation-id"}
            </div>
          </div>

          <button
            onClick={onOpenTokenModal}
            className="flex items-center justify-center gap-1.5 w-full py-2 rounded-xl bg-[#1c232d] hover:bg-[#283344] text-xs font-bold text-[#FDCC00] border border-[#283344] transition-all"
          >
            <Key className="w-3.5 h-3.5" />
            <span>Token kezelése / Ingest</span>
          </button>
        </div>

        {}
        <div className="bg-[#141820] border border-[#283344] rounded-3xl p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
              Backend Gateway
            </span>
            <div className="w-8 h-8 rounded-xl bg-emerald-950/60 text-[#3ddc84] flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="text-xl font-black text-white font-mono tracking-tight">
              {sysInfo ? formatUptime(sysInfo.uptimeSec) : "Online"}
            </div>
            <div className="text-xs text-[#94a3b8] mt-1 font-mono">
              Port: <strong className="text-white">8088</strong> · Node{" "}
              {sysInfo?.nodeVersion || "v26"}
            </div>
          </div>

          <div className="text-xs text-[#3ddc84] flex items-center gap-1.5 font-bold">
            <span className="w-2 h-2 rounded-full bg-[#3ddc84] live-pulse" />
            Hono REST Engine aktív
          </div>
        </div>

        {}
        <div className="bg-[#141820] border border-[#283344] rounded-3xl p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
              GTFS Statikus Motor
            </span>
            <div className="w-8 h-8 rounded-xl bg-[#1c232d] text-[#FDCC00] flex items-center justify-center">
              <Database className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="text-xl font-black text-white font-mono tracking-tight">
              {gtfsMeta?.stops || sysInfo?.gtfs.stops || "—"} megálló
            </div>
            <div className="text-xs text-[#94a3b8] mt-1 font-mono">
              {gtfsMeta?.routes || sysInfo?.gtfs.routes || "—"} járat ·{" "}
              {gtfsMeta?.trips || sysInfo?.gtfs.trips || "—"} menet
            </div>
          </div>

          <div
            className="text-[11px] text-[#94a3b8] truncate font-mono"
            title={gtfsMeta?.feedVersion}
          >
            Verzió: {gtfsMeta?.feedVersion || "MVK Auto-Sync"}
          </div>
        </div>

        {}
        <div className="bg-[#141820] border border-[#283344] rounded-3xl p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">
              Memóriahasználat
            </span>
            <div className="w-8 h-8 rounded-xl bg-[#1c232d] text-cyan-400 flex items-center justify-center">
              <Cpu className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="text-xl font-black text-white font-mono tracking-tight">
              {sysInfo ? `${sysInfo.memory.rssMb} MB` : "—"}
            </div>
            <div className="text-xs text-[#94a3b8] mt-1 font-mono">
              Heap:{" "}
              {sysInfo
                ? `${sysInfo.memory.heapUsedMb} / ${sysInfo.memory.heapTotalMb} MB`
                : "—"}
            </div>
          </div>

          <div className="text-xs text-[#94a3b8]">
            Optimalizált memóriaprofil
          </div>
        </div>
      </div>

      {}
      <div className="p-5 md:p-6 rounded-3xl bg-[#141820] border border-[#283344] space-y-4">
        <h3 className="font-extrabold text-base text-white flex items-center gap-2">
          <Terminal className="w-5 h-5 text-[#FDCC00]" />
          SaaS Rendszer Architektúra & Folyamatkezelő
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-4 rounded-2xl bg-[#12161f] border border-[#283344] space-y-2">
            <div className="flex items-center justify-between">
              <strong className="text-white font-bold">
                1. Backend API Gateway
              </strong>
              <span className="px-2 py-0.5 rounded-full bg-emerald-950/60 text-[#3ddc84] font-bold text-[10px]">
                :8088
              </span>
            </div>
            <p className="text-[#94a3b8] leading-relaxed">
              Hono + TypeScript szerver, GTFS-RT dekódolás, Bearer token
              injektálás, valós idejű érkezésszámítás.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-[#12161f] border border-[#283344] space-y-2">
            <div className="flex items-center justify-between">
              <strong className="text-white font-bold">
                2. Modern React Frontend
              </strong>
              <span className="px-2 py-0.5 rounded-full bg-emerald-950/60 text-[#3ddc84] font-bold text-[10px]">
                :5173
              </span>
            </div>
            <p className="text-[#94a3b8] leading-relaxed">
              Vite + React + Tailwind CSS, Multi-Stop Dashboard, Leaflet élő
              térkép, moduláris csomagkezelés.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-[#12161f] border border-[#283344] space-y-2">
            <div className="flex items-center justify-between">
              <strong className="text-white font-bold">3. Token Worker</strong>
              <span className="px-2 py-0.5 rounded-full bg-cyan-950/60 text-cyan-400 font-bold text-[10px]">
                Háttérfolyamat
              </span>
            </div>
            <p className="text-[#94a3b8] leading-relaxed">
              Csendes, optimalizált háttér-szolgáltatás a Mac-natív MVK app App
              Attest tokenjének 0–24 frissítésére.
            </p>
          </div>
        </div>
      </div>

      {}
      <ApiInspector />
    </div>
  );
};
