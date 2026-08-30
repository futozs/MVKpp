import React, { useState, useMemo } from "react";
import { Search, MapPin, ChevronRight, Plus, Check } from "lucide-react";
import type { Stop } from "../../types";

interface StopSearchListProps {
  stops: Stop[];
  onSelectStop: (stopId: string) => void;
  selectedStopId: string | null;
  monitoredStopIds: string[];
  onToggleMonitorStop: (stopId: string) => void;
}

export const StopSearchList: React.FC<StopSearchListProps> = ({
  stops,
  onSelectStop,
  selectedStopId,
  monitoredStopIds,
  onToggleMonitorStop,
}) => {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stops.slice(0, 80);
    return stops
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.code && s.code.toLowerCase().includes(q)) ||
          s.id.toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [stops, query]);

  return (
    <div className="flex flex-col h-full bg-[#141820] overflow-hidden">
      {}
      <div className="p-3 border-b border-[#283344] bg-[#181d27]">
        <div className="relative">
          <Search className="w-4 h-4 text-[#94a3b8] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Megálló keresése (név vagy kód)..."
            className="w-full bg-[#12161f] border border-[#283344] focus:border-[#FDCC00] text-sm text-white rounded-xl pl-9 pr-3 py-2 outline-none transition-all placeholder:text-[#64748b]"
          />
        </div>
        <div className="text-[11px] text-[#94a3b8] mt-1.5 px-1 flex items-center justify-between">
          <span>
            {filtered.length} találat ({stops.length} megállóból)
          </span>
        </div>
      </div>

      {}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 divide-y divide-[#1e2634]">
        {filtered.length > 0 ? (
          filtered.map((stop) => {
            const isSelected = selectedStopId === stop.id;
            const isMonitored = monitoredStopIds.includes(stop.id);

            return (
              <div
                key={stop.id}
                onClick={() => onSelectStop(stop.id)}
                className={`p-2.5 rounded-xl flex items-center justify-between gap-2.5 cursor-pointer transition-all ${
                  isSelected
                    ? "bg-[#1e2838] border border-[#FDCC00]"
                    : "hover:bg-[#1c232d]"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      isSelected
                        ? "bg-[#FDCC00] text-black font-bold"
                        : "bg-[#1f2735] text-[#94a3b8]"
                    }`}
                  >
                    <MapPin className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-white truncate">
                      {stop.name}
                    </div>
                    <div className="text-[11px] text-[#94a3b8] font-mono">
                      kód: {stop.id}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleMonitorStop(stop.id);
                    }}
                    title={
                      isMonitored
                        ? "Megálló eltávolítása a figyelőből"
                        : "Hozzáadás a multi-megálló figyelőhöz"
                    }
                    className={`p-1.5 rounded-lg border transition-all ${
                      isMonitored
                        ? "bg-[#FDCC00]/15 text-[#FDCC00] border-[#FDCC00]/40 hover:bg-red-950/40 hover:text-red-400 hover:border-red-800"
                        : "bg-[#1c232d] text-[#94a3b8] border-[#283344] hover:text-white hover:border-[#FDCC00]"
                    }`}
                  >
                    {isMonitored ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <ChevronRight className="w-4 h-4 text-[#64748b]" />
                </div>
              </div>
            );
          })
        ) : (
          <div className="p-8 text-center text-xs text-[#64748b]">
            Nincs találat a keresésre.
          </div>
        )}
      </div>
    </div>
  );
};
