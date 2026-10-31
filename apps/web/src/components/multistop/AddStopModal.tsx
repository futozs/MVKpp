import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, MapPin, Plus, Route as RouteIcon, Search, TrainFront, X } from "lucide-react";
import type { Stop, TransitSearchResponse } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import { stopKindLabel } from "@/components/transit/RegionalBits";
import { MAX_RELATIONS, MAX_TRAINS, type RelationWatch } from "@/lib/transitWatches";
import { isMergedTwin, pickableStops, regionRank, useStopMerge } from "@/lib/modes";
import { cn, normalizeSearchText, withHungarianSuffix } from "@/lib/utils";

type Tab = "stops" | "relation" | "train";

type AddStopModalProps = {
  isOpen: boolean;
  onClose: () => void;
  stops: Stop[];
  selectedStopIds: string[];
  onToggleStop: (stopId: string) => void;
  /** viszonylat (A → B) és vonatszám figyelése — a vasúthoz, de bármelyik módra jó */
  relations?: RelationWatch[];
  onAddRelation?: (r: RelationWatch) => void;
  trains?: string[];
  onToggleTrain?: (no: string) => void;
  /** a vasút be van-e kapcsolva (a Vonatszám fül csak akkor) */
  showRail?: boolean;
};

export function AddStopModal({
  isOpen,
  onClose,
  stops,
  selectedStopIds,
  onToggleStop,
  relations = [],
  onAddRelation,
  trains = [],
  onToggleTrain,
  showRail = false,
}: AddStopModalProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("stops");
  const [relFrom, setRelFrom] = useState<Stop | null>(null);
  const [trainQuery, setTrainQuery] = useState("");
  const [trainHits, setTrainHits] = useState<TransitSearchResponse["trains"] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // összevont nézetben a Volán-iker nem külön tétel: az MVK-oszlop mutatja a járatait
  const merge = useStopMerge();
  const pickable = useMemo(() => pickableStops(stops).filter((s) => !isMergedTwin(s, merge)), [stops, merge]);
  const results = useMemo(() => {
    const q = normalizeSearchText(query.trim());
    // az állomások elöl (Tiszai pu., Búza téri autóbusz-állomás), utána a megállók
    const ranked = [...pickable].sort((a, b) => regionRank(a) - regionRank(b) || Number(Boolean(b.station)) - Number(Boolean(a.station)));
    if (!q) return ranked.slice(0, 60);
    return ranked
      .filter(
        (s) =>
          normalizeSearchText(s.name).includes(q) ||
          (s.code && normalizeSearchText(s.code).includes(q)) ||
          s.id.toLowerCase().includes(q),
      )
      .slice(0, 80);
  }, [pickable, query]);

  // Vonatszám: a szerver tudja, ma / holnap melyik vonat ez.
  useEffect(() => {
    const q = trainQuery.trim();
    if (tab !== "train" || !/^\d{2,6}$/.test(q)) {
      setTrainHits(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .searchTransit(q, ctl.signal)
        .then((r) => setTrainHits(r.trains))
        .catch(() => setTrainHits([]));
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [trainQuery, tab]);

  const close = () => {
    setRelFrom(null);
    onClose();
  };

  const tabs: { id: Tab; label: string; icon: typeof MapPin }[] = [
    { id: "stops", label: "Megálló", icon: MapPin },
    ...(onAddRelation ? [{ id: "relation" as const, label: "Viszonylat", icon: RouteIcon }] : []),
    ...(onToggleTrain && showRail ? [{ id: "train" as const, label: "Vonatszám", icon: TrainFront }] : []),
  ];

  const pickStop = (stop: Stop) => {
    if (tab === "stops") return onToggleStop(stop.id);
    if (!relFrom) {
      // a „hová” keresése üres mezővel, fókusszal indul
      setRelFrom(stop);
      setQuery("");
      searchRef.current?.focus();
      return;
    }
    if (stop.id === relFrom.id) return setRelFrom(null);
    onAddRelation?.({ from: relFrom.id, to: stop.id });
    setRelFrom(null);
    setQuery("");
  };

  const relationsFull = relations.length >= MAX_RELATIONS;
  const description =
    tab === "train"
      ? `${trains.length} vonat a figyelőn${trains.length >= MAX_TRAINS ? " (több nem fér)" : ""}`
      : tab === "relation"
        ? relFrom
          ? `Honnan: ${relFrom.name} — most válaszd ki, hová`
          : relationsFull
            ? "A figyelő megtelt viszonylattal"
            : "Válaszd ki, honnan indulsz"
        : selectedStopIds.length > 0
          ? `${selectedStopIds.length} megálló a figyelőn`
          : "Még nincs figyelt megálló";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="space-y-1 border-b border-border px-5 py-4 text-left">
          <DialogTitle>Felvétel a figyelőre</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {tabs.length > 1 ? (
          <div role="tablist" aria-label="Mit figyelsz" className="grid gap-1 border-b border-border p-2" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => {
                    setTab(t.id);
                    setRelFrom(null);
                  }}
                  className={cn(
                    "flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-colors duration-fast",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    tab === t.id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {tab === "train" ? (
          <TrainTab query={trainQuery} onQuery={setTrainQuery} hits={trainHits} trains={trains} onToggleTrain={onToggleTrain} />
        ) : (
          <>
            <div className="border-b border-border px-5 py-3">
              {tab === "relation" && relFrom ? (
                <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-semibold">{relFrom.name}</span>
                  <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">hová?</span>
                  <button type="button" onClick={() => setRelFrom(null)} aria-label="Kiinduló megálló törlése" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tab === "relation" ? (relFrom ? "Hová? (pl. Füzesabony)" : "Honnan? (pl. Tiszai)") : "Név vagy megállókód"}
                  aria-label="Megálló keresése"
                  autoFocus
                  className="pl-9"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {results.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                  {query.trim() ? `Nincs „${query.trim()}” nevű megálló a menetrendben.` : "Megállók betöltése…"}
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {results.map((stop) => {
                    const selected = tab === "stops" ? selectedStopIds.includes(stop.id) : relFrom?.id === stop.id;
                    const disabled = tab === "relation" && relationsFull;
                    const kind = stopKindLabel(stop);
                    return (
                      <li key={stop.id}>
                        <button
                          type="button"
                          onClick={() => pickStop(stop)}
                          disabled={disabled}
                          aria-pressed={selected}
                          className={cn(
                            "flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50",
                            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                            selected ? "bg-primary/10" : "hover:bg-accent",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-fast",
                              selected ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground",
                            )}
                          >
                            {selected ? <Check className="h-4 w-4" /> : stop.feed === "rail" ? <TrainFront className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cn("block truncate text-sm", selected ? "font-semibold" : "font-medium")}>{stop.name}</span>
                            <span className={cn("block text-[11px] text-muted-foreground", kind === stop.id && "font-mono tabular-nums")}>{kind}</span>
                          </span>
                          {!selected ? <Plus aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {tab === "relation"
              ? `${relations.length} viszonylat a figyelőn`
              : tab === "train"
                ? `${trains.length} vonat a figyelőn`
                : selectedStopIds.length === 0
                  ? "Még nincs kiválasztott megálló"
                  : `${selectedStopIds.length} megálló kiválasztva`}
          </span>
          <Button size="sm" onClick={close}>
            Kész
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Vonatszám-keresés: a mai / holnapi vonat neve és útja, egy érintéssel a figyelőre. */
function TrainTab({
  query,
  onQuery,
  hits,
  trains,
  onToggleTrain,
}: {
  query: string;
  onQuery: (q: string) => void;
  hits: TransitSearchResponse["trains"] | null;
  trains: string[];
  onToggleTrain?: (no: string) => void;
}) {
  const no = query.trim();
  const full = trains.length >= MAX_TRAINS;
  return (
    <>
      <div className="border-b border-border px-5 py-3">
        <div className="relative">
          <TrainFront aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Vonatszám, pl. 5139 vagy 582"
            aria-label="Vonatszám"
            autoFocus
            className="pl-9 font-mono tabular-nums"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">A vonat minden nap ugyanazzal a számmal jár: a kártya mindig a ma (vagy ha már elment, a holnap) közlekedőt mutatja.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ul className="divide-y divide-border/60">
          {trains.map((t) => (
            <li key={`w-${t}`} className="flex items-center gap-3 px-5 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                <Check className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 text-sm font-semibold">{withHungarianSuffix(t)} vonat</span>
              <Button variant="ghost" size="sm" className="h-8" onClick={() => onToggleTrain?.(t)}>
                Levétel
              </Button>
            </li>
          ))}
          {hits?.length
            ? hits
                // egy vonatszám egyszer (a mai és a holnapi menet azonosítója ugyanaz lehet)
                .filter((h, i, all) => !trains.includes(h.no) && all.findIndex((x) => x.no === h.no) === i)
                .map((h) => (
                  <li key={h.tripId}>
                    <button
                      type="button"
                      disabled={full}
                      onClick={() => onToggleTrain?.(h.no)}
                      className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors duration-fast hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <TrainFront className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{h.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {h.from} {h.departure} → {h.headsign}
                          {h.today ? "" : " · holnap"}
                        </span>
                      </span>
                      <Plus aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))
            : null}
        </ul>
        {/^\d{2,6}$/.test(no) && hits && hits.length === 0 && !trains.includes(no) ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Ma és holnap nincs {withHungarianSuffix(no)} vonat a megyét érintve.</p>
        ) : null}
      </div>
    </>
  );
}

