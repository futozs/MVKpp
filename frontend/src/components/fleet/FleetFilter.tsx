import React, { useState } from "react";
import {
  Plus,
  X,
  Radio,
  Eye,
  Crosshair,
  Bus,
  Layers,
  Sparkles,
} from "lucide-react";
import type { Route, LiveVehicle, FilterState } from "../../types";
import { RouteChips } from "./RouteChips";

interface FleetFilterProps {
  routes: Record<string, Route>;
  liveVehicles: LiveVehicle[];
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  onFocusVehicle: (vehicle: LiveVehicle) => void;
}

export const FleetFilter: React.FC<FleetFilterProps> = ({
  routes,
  liveVehicles,
  filters,
  setFilters,
  onFocusVehicle,
}) => {
  const [typedId, setTypedId] = useState("");

  const handleAddWatch = (idToAdd?: string) => {
    const target = (idToAdd || typedId).trim();
    if (!target) return;
    if (filters.watch.length >= 12) return;

    if (!filters.watch.some((x) => x.toLowerCase() === target.toLowerCase())) {
      setFilters((prev) => ({
        ...prev,
        watch: [...prev.watch, target],
        vq: "",
      }));
      setTypedId("");
    }
  };

  const handleRemoveWatch = (idToRemove: string) => {
    setFilters((prev) => ({
      ...prev,
      watch: prev.watch.filter(
        (x) => x.toLowerCase() !== idToRemove.toLowerCase(),
      ),
    }));
  };

  const handleClearWatch = () => {
    setFilters((prev) => ({ ...prev, watch: [], vq: "" }));
  };

  const handleToggleRoute = (routeId: string) => {
    setFilters((prev) => {
      const current = prev.routes;
      const updated = current.includes(routeId)
        ? current.filter((id) => id !== routeId)
        : [...current, routeId];
      return { ...prev, routes: updated };
    });
  };

  const handleSetRoutes = (routeIds: string[]) => {
    setFilters((prev) => ({ ...prev, routes: routeIds }));
  };

  const activeQueries = React.useMemo(() => {
    const list = [...filters.watch];
    const q = typedId.trim();
    if (q && !list.some((x) => x.toLowerCase() === q.toLowerCase())) {
      list.push(q);
    }
    return list;
  }, [filters.watch, typedId]);

  const filteredVehicles = React.useMemo(() => {
    let list = liveVehicles.slice();

    if (activeQueries.length > 0) {
      return list.filter((v) => {
        const vid = String(v.id || "").toLowerCase();
        const vlabel = String(v.label || "").toLowerCase();
        return activeQueries.some(
          (q) =>
            vid.includes(q.toLowerCase()) || vlabel.includes(q.toLowerCase()),
        );
      });
    }

    if (filters.type !== "all") {
      list = list.filter((v) => {
        const r = routes[v.routeId];
        const isTram = r?.type === "900" || v.label === "TRAM";
        return filters.type === "tram" ? isTram : !isTram;
      });
    }

    if (filters.routes.length > 0) {
      const set = new Set(filters.routes);
      list = list.filter((v) => set.has(v.routeId));
    }

    if (filters.speed === "moving") {
      list = list.filter((v) => (v.speed || 0) > 0.5);
    } else if (filters.speed === "idle") {
      list = list.filter((v) => (v.speed || 0) <= 0.5);
    }

    return list.sort((a, b) => {
      return (
        a.routeShort.localeCompare(b.routeShort, "hu") ||
        a.id.localeCompare(b.id, "hu")
      );
    });
  }, [liveVehicles, activeQueries, filters, routes]);

  return (
    <div className="flex flex-col h-full bg-[#141820] divide-y divide-[#283344] overflow-y-auto">
      {}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-[#FDCC00]" />
            Jármű / Busz ID Követés
          </label>
          {filters.watch.length > 0 && (
            <button
              onClick={handleClearWatch}
              className="text-[11px] font-semibold text-[#94a3b8] hover:text-red-400 transition-all"
            >
              Követés ürítése ({filters.watch.length}/12)
            </button>
          )}
        </div>

        {}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={typedId}
            onChange={(e) => {
              setTypedId(e.target.value);
              setFilters((prev) => ({ ...prev, vq: e.target.value }));
            }}
            onKeyDown={(e) => e.key === "Enter" && handleAddWatch()}
            placeholder="pl. 1641 vagy rendszám..."
            className="flex-1 bg-[#1c232d] border border-[#283344] focus:border-[#FDCC00] text-sm text-white font-mono rounded-xl px-3 py-2 outline-none transition-all placeholder:text-[#64748b]"
          />
          <button
            onClick={() => handleAddWatch()}
            disabled={!typedId.trim() || filters.watch.length >= 12}
            title="Hozzáadás a követéshez (Enter)"
            className="px-3 py-2 rounded-xl bg-[#FDCC00] text-black font-extrabold text-sm shadow-sm hover:bg-[#E5B800] transition-all disabled:opacity-40 disabled:pointer-events-none"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
          </button>
          {typedId && (
            <button
              onClick={() => {
                setTypedId("");
                setFilters((prev) => ({ ...prev, vq: "" }));
              }}
              className="p-2 rounded-xl bg-[#1c232d] text-[#94a3b8] hover:text-white border border-[#283344] transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {}
        {activeQueries.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {activeQueries.map((query) => {
              const hits = liveVehicles.filter((v) =>
                v.id.toLowerCase().includes(query.toLowerCase()),
              );
              const isPinned = filters.watch.some(
                (w) => w.toLowerCase() === query.toLowerCase(),
              );

              if (hits.length === 0) {
                return (
                  <div
                    key={query}
                    className="p-2.5 rounded-xl bg-[#1c232d] border border-dashed border-[#283344] flex items-center justify-between text-xs text-[#94a3b8]"
                  >
                    <div>
                      <strong className="text-white font-mono">{query}</strong>
                      <div className="text-[11px] text-[#64748b]">
                        Nincs bevetésen (nem ad élő jelet)
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        isPinned
                          ? handleRemoveWatch(query)
                          : handleAddWatch(query)
                      }
                      className="p-1 rounded-lg hover:bg-[#283344] text-[#94a3b8] hover:text-white"
                    >
                      {isPinned ? (
                        <X className="w-3.5 h-3.5 text-red-400" />
                      ) : (
                        <Plus className="w-3.5 h-3.5 text-[#FDCC00]" />
                      )}
                    </button>
                  </div>
                );
              }

              return hits.slice(0, 3).map((v) => {
                const speedKmh =
                  v.speed != null ? Math.round(v.speed * 3.6) : null;
                return (
                  <div
                    key={v.id}
                    onClick={() => onFocusVehicle(v)}
                    className="p-2.5 rounded-xl bg-[#1c232d] border border-[#283344] hover:border-[#FDCC00] flex items-center justify-between gap-2.5 cursor-pointer transition-all"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="px-2 py-0.5 rounded font-black text-xs shrink-0"
                        style={{
                          backgroundColor: "#" + (v.routeColor || "FDCC00"),
                          color: "#" + (v.routeText || "000000"),
                        }}
                      >
                        {v.routeShort}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <strong className="text-white font-mono text-xs">
                            {v.id}
                          </strong>
                          <span className="w-1.5 h-1.5 rounded-full bg-[#3ddc84]" />
                        </div>
                        <div className="text-[11px] text-[#94a3b8] truncate">
                          {v.headsign}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {speedKmh != null && (
                        <span className="text-xs font-mono font-bold text-[#e2e8f0]">
                          {speedKmh}{" "}
                          <span className="text-[10px] text-[#64748b]">
                            km/h
                          </span>
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          isPinned
                            ? handleRemoveWatch(query)
                            : handleAddWatch(query);
                        }}
                        className="p-1 rounded-lg hover:bg-[#283344] text-[#94a3b8] hover:text-white"
                      >
                        {isPinned ? (
                          <X className="w-3.5 h-3.5 text-red-400" />
                        ) : (
                          <Plus className="w-3.5 h-3.5 text-[#FDCC00]" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              });
            })}
          </div>
        )}

        {}
        <label className="flex items-center justify-between p-2 rounded-xl bg-[#10141b] border border-[#283344] cursor-pointer text-xs text-[#e2e8f0] font-medium">
          <span className="flex items-center gap-1.5">
            <Crosshair className="w-3.5 h-3.5 text-[#FDCC00]" />
            Térkép automatikusan kövesse a járműveket
          </span>
          <input
            type="checkbox"
            checked={filters.follow}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, follow: e.target.checked }))
            }
            className="w-4 h-4 accent-[#FDCC00] rounded cursor-pointer"
          />
        </label>
      </div>

      {}
      <div className="p-4 space-y-2.5">
        <label className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
          <Bus className="w-3.5 h-3.5 text-[#FDCC00]" />
          Járműtípus
        </label>
        <div className="grid grid-cols-3 gap-1.5 bg-[#0e1116] p-1 rounded-xl border border-[#283344]">
          {(["all", "bus", "tram"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilters((prev) => ({ ...prev, type: t }))}
              className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
                filters.type === t
                  ? "bg-[#FDCC00] text-black shadow-sm"
                  : "text-[#94a3b8] hover:text-white"
              }`}
            >
              {t === "all" ? "Mind" : t === "bus" ? "🚌 Busz" : "🚋 Villamos"}
            </button>
          ))}
        </div>
      </div>

      {}
      <div className="p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-[#FDCC00]" />
            Járatok Kiválasztása
          </label>
          <span className="text-xs text-[#94a3b8]">
            {filters.routes.length > 0
              ? `${filters.routes.length} kijelölve`
              : "Mind"}
          </span>
        </div>
        <RouteChips
          routes={routes}
          selectedRoutes={filters.routes}
          onToggleRoute={handleToggleRoute}
          onSetRoutes={handleSetRoutes}
          liveVehicles={liveVehicles}
        />
      </div>

      {}
      <div className="p-4 space-y-2">
        <label className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 mb-1">
          <Eye className="w-3.5 h-3.5 text-[#FDCC00]" />
          Térképi Megjelenítés
        </label>

        {[
          { key: "stops", label: "Megállók a térképen" },
          { key: "shape", label: "Kijelölt járatok nyomvonala" },
          { key: "rstops", label: "Csak a kijelölt járatok megállói" },
          { key: "moving", label: "Csak a mozgó járművek (>0.5 km/h)" },
          { key: "labels", label: "Jármű ID címke a térképen" },
        ].map(({ key, label }) => (
          <label
            key={key}
            className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-[#1c232d] cursor-pointer text-xs text-[#94a3b8] hover:text-white transition-all"
          >
            <span>{label}</span>
            <input
              type="checkbox"
              checked={filters[key as keyof FilterState] as boolean}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, [key]: e.target.checked }))
              }
              className="w-4 h-4 accent-[#FDCC00] rounded cursor-pointer"
            />
          </label>
        ))}
      </div>

      {}
      <div className="p-4 space-y-2 flex-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#FDCC00]" />
            Élő Flotta ({filteredVehicles.length} db)
          </label>
        </div>

        <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
          {filteredVehicles.length > 0 ? (
            filteredVehicles.map((v) => {
              const speed =
                v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : "—";
              return (
                <div
                  key={v.id}
                  onClick={() => onFocusVehicle(v)}
                  className="p-2 rounded-xl bg-[#1c232d] hover:bg-[#252f40] border border-[#283344] hover:border-[#FDCC00] flex items-center justify-between gap-2 cursor-pointer transition-all"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="px-2 py-0.5 rounded font-black text-xs shrink-0"
                      style={{
                        backgroundColor: "#" + (v.routeColor || "FDCC00"),
                        color: "#" + (v.routeText || "000000"),
                      }}
                    >
                      {v.routeShort}
                    </span>
                    <div className="min-w-0">
                      <strong className="text-white font-mono text-xs">
                        {v.id}
                      </strong>
                      <div className="text-[11px] text-[#94a3b8] truncate">
                        {v.headsign}
                      </div>
                    </div>
                  </div>

                  <span className="font-mono text-xs text-[#94a3b8] shrink-0 font-semibold">
                    {speed}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="text-xs text-[#64748b] py-4 text-center">
              Nincs a feltételeknek megfelelő élő jármű.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
