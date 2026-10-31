import { useEffect, useRef, useState } from "react";
import { Check, Layers } from "lucide-react";
import type { FilterState } from "@/types";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { TILE_LAYERS } from "../tileLayers";
import { MapControl } from "./MapControl";
import { trafficColor } from "../trafficColor";

type LayerKey = "traffic" | "others" | "stops" | "onlyWatched" | "shape" | "labels";

/**
 * Térkép (jobb felső sarok): az alaptérkép és a rétegek egy helyen. Korábban
 * az alaptérkép a fejlécben és a szűrőpanelben is külön gomb volt, a rétegek
 * pedig a szűrők között — pedig nem szűrnek, csak a megjelenítést állítják.
 */
export function MapLayersControl({
  tileLayerId,
  onSelectTileLayer,
  filters,
  setFilters,
  watchedStops,
}: {
  tileLayerId: string;
  onSelectTileLayer: (id: string) => void;
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  watchedStops: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggles: { key: LayerKey; label: string; hint?: string; disabled?: boolean }[] = [
    { key: "traffic", label: "Forgalom (dugók)", hint: "élőben, a buszok menetidejéből" },
    { key: "others", label: "Többi busz követéskor", hint: "utazás közben is, halványan" },
    { key: "stops", label: "Megállók" },
    { key: "onlyWatched", label: "Csak a figyelt megállók", hint: `${watchedStops} figyelt`, disabled: !filters.stops },
    { key: "shape", label: "Járatok nyomvonala", hint: "a kiválasztott járatoké" },
    { key: "labels", label: "Rendszám a buszokon" },
  ];

  return (
    <div ref={root} className="pointer-events-auto relative">
      <MapControl icon={Layers} label="Térkép" showLabel="wide" active={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div
          role="dialog"
          aria-label="Térkép beállításai"
          className="absolute right-0 top-[52px] w-[min(300px,calc(100vw-1.5rem))] origin-top-right rounded-2xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
        >
          <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Alaptérkép</p>
          <ul className="mt-2 grid grid-cols-5 gap-1.5">
            {TILE_LAYERS.map((l) => {
              const on = l.id === tileLayerId;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTileLayer(l.id)}
                    aria-pressed={on}
                    title={`${l.name} — ${l.note}`}
                    className="group flex w-full flex-col items-center gap-1 rounded-lg p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "relative flex aspect-square w-full items-center justify-center rounded-lg border-2 shadow-sm transition-transform duration-fast group-hover:scale-105",
                        on ? "border-primary" : "border-border",
                      )}
                      style={{ backgroundColor: l.swatch }}
                    >
                      {on ? (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="h-3 w-3" />
                        </span>
                      ) : null}
                    </span>
                    <span className={cn("w-full truncate text-center text-[10px]", on ? "font-semibold text-foreground" : "text-muted-foreground")}>{l.short}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <p className="mt-3 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rétegek</p>
          <ul className="mt-1">
            {toggles.map((t) => (
              <li key={t.key}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-1 py-2 hover:bg-accent",
                    t.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{t.label}</span>
                    {t.hint ? <span className="block text-[11px] text-muted-foreground">{t.hint}</span> : null}
                    {t.key === "traffic" ? (
                      <span aria-hidden className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        lassul
                        <span className="h-1.5 w-20 rounded-full" style={{ background: `linear-gradient(90deg, ${trafficColor(0)}, ${trafficColor(0.5)}, ${trafficColor(1)})` }} />
                        beállt
                      </span>
                    ) : null}
                  </span>
                  <Switch
                    checked={filters[t.key]}
                    disabled={t.disabled}
                    onCheckedChange={(v) => setFilters((prev) => ({ ...prev, [t.key]: v }))}
                    aria-label={t.label}
                  />
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
