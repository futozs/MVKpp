import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/apiBase";
import { cn } from "@/lib/utils";
import type { FleetKind } from "@/services/parkingApi";
import { hmOfDaySec } from "./format";
import type { RouteLookup } from "./parts";
import { displayVehicleId } from "@/lib/modes";

type BlockRun = { t: string; r: string; h: string; s: number; e: number; as: number | null; ae: number | null; st: string; d: number | null };
type BlockPlan = { t: string; r: string; h: string; s: number; e: number; c: number | null };
type BlockRow = { id: string; kind: FleetKind; runs: BlockRun[]; plan: BlockPlan[] };
type Blocks = { date: string; midnight: number; now: number; vehicles: BlockRow[] };

const REFRESH_MS = 60_000;
type SortMode = "route" | "first" | "id";
const SORTS: { id: SortMode; label: string }[] = [
  { id: "route", label: "Vonal szerint" },
  { id: "first", label: "Kiállás szerint" },
  { id: "id", label: "Rendszám" },
];
const byNumeric = (a: string, b: string) => a.localeCompare(b, "hu", { numeric: true });

/** A jármű „mostani” menete: ami fut, különben a következő tipp, különben az utolsó lefutott. */
function anchorOf(v: BlockRow): { route: string; start: number } {
  const running = v.runs.find((r) => r.st === "running");
  if (running) return { route: running.r, start: running.as ?? running.s };
  const next = v.plan[0];
  if (next) return { route: next.r, start: next.s };
  const last = v.runs[v.runs.length - 1];
  return last ? { route: last.r, start: last.s } : { route: "?", start: Infinity };
}

type Group = { route: string | null; rows: BlockRow[] };

/** Vonal szerint csoportosítva, a csoporton belül a mostani menet indulása szerint — mint egy menetrend. */
function groupRows(rows: BlockRow[], sort: SortMode): Group[] {
  if (sort === "id") return [{ route: null, rows: [...rows].sort((a, b) => byNumeric(a.id, b.id)) }];
  if (sort === "first") return [{ route: null, rows }];
  const groups = new Map<string, BlockRow[]>();
  for (const v of rows) {
    const k = anchorOf(v).route;
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  return [...groups]
    .sort((a, b) => byNumeric(a[0], b[0]))
    .map(([route, list]) => ({ route, rows: list.sort((a, b) => anchorOf(a).start - anchorOf(b).start) }));
}
const ROW_H = 30;
const LEFT_W = 64;
const HOUR = 3600;

function useBlocks() {
  const [data, setData] = useState<Blocks | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/engine/blocks`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Blocks>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { data, error };
}

/**
 * Forda-tábla: a flotta napja egy idővonalon. Teli sáv = lefutott vagy épp
 * futó menet (a valós indulástól), szaggatott = a forda-terv szerinti következő
 * menet; minél halványabb, annál bizonytalanabb a tipp.
 */
export function BlockChart({ lookup, kind, query, onSelect }: { lookup: RouteLookup; kind: "all" | FleetKind; query: string; onSelect: (id: string) => void }) {
  const { data, error } = useBlocks();
  const scroller = useRef<HTMLDivElement>(null);
  const [ppm, setPpm] = useState(() => (window.innerWidth < 640 ? 2 : 3));
  const [sort, setSort] = useState<SortMode>("route");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.vehicles ?? []).filter(
      (v) => (kind === "all" || v.kind === kind) && (!q || v.id.toLowerCase().startsWith(q) || v.runs.some((x) => x.r.toLowerCase() === q) || v.plan.some((x) => x.r.toLowerCase() === q)),
    );
  }, [data, kind, query]);

  const [t0, t1] = useMemo(() => {
    let lo = 4 * HOUR;
    let hi = 24 * HOUR;
    for (const v of data?.vehicles ?? []) {
      for (const x of [...v.runs, ...v.plan]) {
        lo = Math.min(lo, x.s);
        hi = Math.max(hi, x.e);
      }
    }
    return [Math.floor(lo / HOUR) * HOUR, Math.min(27 * HOUR, Math.ceil(hi / HOUR) * HOUR)];
  }, [data]);
  const x = (sec: number) => ((sec - t0) / 60) * ppm;
  const groups = useMemo(() => groupRows(rows, sort), [rows, sort]);
  const width = x(t1);

  // Első betöltéskor a „most” legyen középen.
  const centered = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !data || centered.current) return;
    el.scrollLeft = Math.max(0, x(data.now) - (el.clientWidth - LEFT_W) / 2);
    centered.current = true;
  });

  if (!data) return <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">{error ?? "A forda-tábla betöltése…"}</p>;

  const hours = Array.from({ length: (t1 - t0) / HOUR + 1 }, (_, i) => t0 + i * HOUR);
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-5 rounded-sm bg-foreground/70" /> lefutott / fut</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-5 rounded-sm border border-dashed border-foreground/70" /> tipp (forda-terv)</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-primary" /> most</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/60 p-0.5" role="group" aria-label="Rendezés">
          {SORTS.map((o) => (
            <button key={o.id} type="button" aria-pressed={sort === o.id} onClick={() => setSort(o.id)} className={cn("rounded-md px-2 py-1 text-xs font-semibold", sort === o.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/60 p-0.5" role="group" aria-label="Nagyítás">
          {[2, 3, 5].map((p) => (
            <button key={p} type="button" aria-pressed={ppm === p} onClick={() => setPpm(p)} className={cn("rounded-md px-2 py-1 text-xs font-semibold", ppm === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}>
              {p === 2 ? "Nap" : p === 3 ? "Félnap" : "Közeli"}
            </button>
          ))}
        </div>
        </div>
      </header>
      <div ref={scroller} className="max-h-[70dvh] overflow-auto">
        <div className="relative" style={{ width: width + LEFT_W }}>
          {/* óra-sáv */}
          <div className="sticky top-0 z-20 flex h-7 border-b border-border bg-card">
            <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-card" style={{ width: LEFT_W }} />
            <div className="relative flex-1">
              {hours.map((h) => (
                <span key={h} className="absolute top-1.5 -translate-x-1/2 font-mono text-[10.5px] text-muted-foreground" style={{ left: x(h) }}>
                  {hmOfDaySec(h)}
                </span>
              ))}
            </div>
          </div>
          {groups.map((g) => (
            <div key={g.route ?? "all"}>
              {g.route ? <GroupHeader route={g.route} count={g.rows.length} lookup={lookup} width={width} /> : null}
              {g.rows.map((v) => (
            <div key={v.id} className="flex border-b border-border/40" style={{ height: ROW_H }}>
              <button
                type="button"
                onClick={() => onSelect(v.id)}
                className="sticky left-0 z-10 shrink-0 border-r border-border bg-card px-2 text-left font-mono text-[12px] font-bold tabular-nums hover:text-primary"
                style={{ width: LEFT_W }}
              >
                {displayVehicleId(v.id)}
              </button>
              <div className="relative flex-1">
                {v.runs.map((r) => {
                  const s = r.as ?? r.s;
                  const e = r.ae ?? (r.st === "running" ? Math.max(data.now, s + 60) : r.e);
                  return <Bar key={`r-${r.t}`} left={x(s)} width={x(e) - x(s)} route={r.r} lookup={lookup} solid running={r.st === "running"} title={`${r.r} · ${r.h} · ${hmOfDaySec(s)}–${hmOfDaySec(e)}${r.d != null ? ` · ${r.d >= 60 ? `+${Math.round(r.d / 60)}` : r.d <= -60 ? Math.round(r.d / 60) : "±0"} perc` : ""}`} />;
                })}
                {v.plan.map((p) => (
                  <Bar key={`p-${p.t}`} left={x(p.s)} width={x(p.e) - x(p.s)} route={p.r} lookup={lookup} confidence={p.c ?? 0.3} title={`tipp: ${p.r} · ${p.h} · ${hmOfDaySec(p.s)}–${hmOfDaySec(p.e)}${p.c != null ? ` · ${Math.round(p.c * 100)}%` : ""}`} />
                ))}
              </div>
            </div>
              ))}
            </div>
          ))}
          {/* most-vonal */}
          <div className="pointer-events-none absolute bottom-0 top-7 z-[5] w-0.5 bg-primary/80" style={{ left: LEFT_W + x(data.now) }} />
        </div>
        {!rows.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nincs ilyen jármű.</p> : null}
      </div>
    </section>
  );
}

/** Csoportfejléc: a vonal csempéje balra rögzítve, mellette a járművek száma. */
function GroupHeader({ route, count, lookup, width }: { route: string; count: number; lookup: RouteLookup; width: number }) {
  const r = lookup(route);
  return (
    <div className="flex h-7 items-center border-b border-border bg-muted/40" style={{ width: width + LEFT_W }}>
      <div className="sticky left-0 z-10 flex h-full items-center gap-2 bg-muted/90 px-2 backdrop-blur" style={{ minWidth: LEFT_W }}>
        <span
          className="flex h-[18px] min-w-[26px] items-center justify-center rounded-[5px] px-1 font-mono text-[11px] font-bold leading-none"
          style={{ background: hex(r?.color, "3A4A44"), color: hex(r?.text, "FFFFFF") }}
        >
          {route}
        </span>
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">{count} jármű</span>
      </div>
    </div>
  );
}

const hex = (v: string | undefined, fb: string) => `#${/^[0-9a-fA-F]{6}$/.test(v ?? "") ? v : fb}`;

function Bar({
  left,
  width,
  route,
  lookup,
  title,
  solid = false,
  running = false,
  confidence = 1,
}: {
  left: number;
  width: number;
  route: string;
  lookup: RouteLookup;
  title: string;
  solid?: boolean;
  running?: boolean;
  confidence?: number;
}) {
  const r = lookup(route);
  const bg = hex(r?.color, "3A4A44");
  const fg = hex(r?.text, "FFFFFF");
  return (
    <span
      title={title}
      className={cn(
        "absolute top-[5px] flex h-5 items-center justify-center overflow-hidden rounded-[4px] font-mono text-[10.5px] font-bold leading-none",
        running && "ring-2 ring-primary ring-offset-1 ring-offset-card",
      )}
      style={
        solid
          ? { left, width: Math.max(2, width), background: bg, color: fg }
          : { left, width: Math.max(2, width), border: `1.5px dashed ${bg}`, color: bg, background: `${bg}22`, opacity: 0.35 + 0.65 * Math.min(1, confidence) }
      }
    >
      {width >= 22 ? route : null}
    </span>
  );
}
