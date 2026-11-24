import { useEffect, useRef, useState } from "react";
import { Check, CloudDownload, Layers, RotateCw } from "lucide-react";
import type { FilterState } from "@/types";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { MAP_LOOKS } from "../gl/looks";
import { loadTileset } from "../gl/engine";
import { downloadPack, PACK_SIZE_MB, packState, packSupported, type PackState } from "../gl/mapPack";
import { MapControl } from "./MapControl";
import { trafficColor } from "../trafficColor";

type LayerKey = "traffic" | "others" | "stops" | "onlyWatched" | "shape" | "labels";

/**
 * Térkép (jobb felső sarok): az alaptérkép és a rétegek egy helyen. Korábban
 * az alaptérkép a fejlécben és a szűrőpanelben is külön gomb volt, a rétegek
 * pedig a szűrők között  pedig nem szűrnek, csak a megjelenítést állítják.
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
  // a letöltés a menü bezárása után is fut; újranyitáskor itt az állása
  const [pack, setPack] = useState<PackState | null>(null);

  useEffect(() => {
    if (!open || pack?.status === "downloading" || !packSupported()) return;
    let alive = true;
    void loadTileset()
      .then(packState)
      .then((s) => alive && setPack(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startPack = async () => {
    // tartós tárhely: a böngésző ne ürítse ki magától (a kattintáshoz kötve kérhető)
    void navigator.storage?.persist?.();
    setPack({ status: "downloading", done: 0, total: 1 });
    try {
      const ts = await loadTileset();
      setPack(await downloadPack(ts, (done, total) => setPack({ status: "downloading", done, total })));
    } catch {
      setPack({ status: "error" });
    }
  };

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
    <div ref={root} className={cn("pointer-events-auto relative", open && "z-10")}>
      <MapControl icon={Layers} label="Térkép" showLabel="wide" active={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div
          role="dialog"
          aria-label="Térkép beállításai"
          className="absolute right-0 top-[52px] max-h-[calc(100dvh-11rem)] w-[min(300px,calc(100vw-1.5rem))] origin-top-right overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
        >
          <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Alaptérkép</p>
          <ul className="mt-2 grid grid-cols-5 gap-1.5">
            {MAP_LOOKS.map((l) => {
              const on = l.id === tileLayerId;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTileLayer(l.id)}
                    aria-pressed={on}
                    title={`${l.name}  ${l.note}`}
                    className="group flex w-full flex-col items-center gap-1 rounded-lg p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "relative flex aspect-square w-full items-center justify-center rounded-lg border-2 shadow-sm transition-transform duration-fast group-hover:scale-105",
                        on ? "border-primary" : "border-border",
                      )}
                      // a nézet két jellemző színe, élesen kettévágva (mint egy kis térképminta)
                      style={{ background: `linear-gradient(135deg, ${l.swatch[0]} 0 58%, ${l.swatch[1]} 58% 100%)` }}
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

          {packSupported() ? <OfflinePack state={pack} onStart={() => void startPack()} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} MB`;

/** Miskolc térképe net nélkül: egyszer letöltve a csempék, fontok és ikonok a telefonon maradnak. */
function OfflinePack({ state, onStart }: { state: PackState | null; onStart: () => void }) {
  const status = state?.status ?? "none";
  return (
    <section aria-label="Offline térkép" className="mt-3 border-t border-border/70 pt-3">
      <div className="flex items-start gap-2.5 px-1">
        <CloudDownload aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", status === "ready" ? "text-primary" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Miskolc offline</p>
          <p className="text-[11px] text-muted-foreground" aria-live="polite">
            {status === "ready" && state?.status === "ready"
              ? `Letöltve, ${mb(state.bytes)} · net nélkül is betölt`
              : status === "downloading" && state?.status === "downloading"
                ? `Letöltés… ${Math.round((state.done / Math.max(1, state.total)) * 100)}%`
                : status === "error"
                  ? "A letöltés megszakadt. Ami lejött, megmarad."
                  : `~${PACK_SIZE_MB} MB · utána a város térképe net nélkül is megy`}
          </p>
          {state?.status === "downloading" ? (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full origin-left rounded-full bg-primary transition-transform duration-fast ease-out"
                style={{ transform: `scaleX(${state.done / Math.max(1, state.total)})` }}
              />
            </div>
          ) : null}
        </div>
        {status === "none" || status === "error" ? (
          <button
            type="button"
            onClick={onStart}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-secondary px-2.5 text-[12px] font-semibold text-foreground transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {status === "error" ? <RotateCw aria-hidden className="h-3.5 w-3.5" /> : null}
            {status === "error" ? "Folytatás" : "Letöltés"}
          </button>
        ) : status === "ready" ? (
          <Check aria-label="Letöltve" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        ) : null}
      </div>
    </section>
  );
}
