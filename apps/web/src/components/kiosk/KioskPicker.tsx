import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import type { Stop } from "@/types";
import { Button } from "@/components/ui/button";
import { normalizeSearchText } from "@/lib/utils";
import { isMergedTwin, isRegionalId, pickableStops, regionRank, useStopMerge } from "@/lib/modes";
import { stopKindLabel } from "@/components/transit/RegionalBits";

export const KIOSK_MAX = 3;

/** a sor jobb oldalán: az MVK-megálló kódja, a regionálisé a fajtája (Vasútállomás…) */
const stopTag = (s: Stop | undefined) => (s ? (isRegionalId(s.id) ? stopKindLabel(s) : s.code) : null);

/** Megállóválasztó a kijelzőhöz: 1–3 megálló, a választás sorrendjében. */
export function KioskPicker({
  stops,
  selected,
  onChange,
  onClose,
}: {
  stops: Stop[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onClose: (() => void) | null;
}) {
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  // összevont nézetben a Volán-iker nem külön tétel: az MVK-oszlop mutatja a járatait
  const merge = useStopMerge();
  const pickable = useMemo(() => pickableStops(stops).filter((s) => !isMergedTwin(s, merge)), [stops, merge]);
  const results = useMemo(() => {
    const q = normalizeSearchText(query.trim());
    if (!q) return [];
    // az állomások elöl (Tiszai pu., Búza téri autóbusz-állomás)
    return pickable
      .filter((s) => normalizeSearchText(s.name).includes(q) || (s.code ?? "").toLowerCase().includes(q))
      .sort((a, b) => regionRank(a) - regionRank(b) || Number(Boolean(b.station)) - Number(Boolean(a.station)))
      .slice(0, 40);
  }, [pickable, query]);
  const full = selected.length >= KIOSK_MAX;

  return (
    <div className="fixed inset-0 z-dialog flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-bold tracking-tight">Kijelző — megállók</h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">Legalább 1, legfeljebb {KIOSK_MAX} megálló, egymás mellett.</p>
          </div>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Bezárás" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </header>
        <ol className="space-y-1.5 px-5 pt-4">
          {selected.map((id, i) => {
            const s = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-3 rounded-xl border border-border bg-background/60 px-3 py-2">
                <span className="font-mono text-xs font-bold text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{s?.name ?? id}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{stopTag(s)}</span>
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  aria-label={`${s?.name ?? id} eltávolítása`}
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            );
          })}
          {!selected.length ? <li className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">Válassz megállót lent.</li> : null}
        </ol>
        <div className="px-5 pt-4">
          <label className="relative block">
            <span className="sr-only">Megálló keresése</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={full}
              placeholder={full ? `Legfeljebb ${KIOSK_MAX} megálló` : "Megálló neve vagy kódja"}
              className="h-11 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </label>
        </div>
        <ul className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {results.map((s) => {
            const added = selected.includes(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={added || full}
                  onClick={() => {
                    onChange([...selected, s.id]);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent disabled:opacity-40"
                >
                  <Plus className="h-4 w-4 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{stopTag(s)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <footer className="border-t border-border px-5 py-3">
          <Button className="h-11 w-full" disabled={!selected.length} onClick={onClose ?? undefined}>
            Kijelző indítása
          </Button>
        </footer>
      </div>
    </div>
  );
}
