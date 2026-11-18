import { useState } from "react";
import { ChevronDown, MapPinned, OctagonPause } from "lucide-react";
import type { BoardVehicle } from "@mvk/core";
import { RouteTile } from "@/components/transit/RouteTile";
import { Button } from "@/components/ui/button";
import { usePreference } from "@/hooks/usePreference";
import { cn } from "@/lib/utils";
import { DelayTrail } from "./DelayTrail";
import { causes, clockText, minutesText, whereText, type Cause } from "./fleetText";

export type Mode = "all" | "bus" | "tram";
type Sort = "late" | "early" | "all";

/** ennyi eltérés alatt a jármű időben jár (mp) */
export const ON_TIME_S = 60;

const SORTS: { id: Sort; label: string }[] = [
  { id: "late", label: "Késik" },
  { id: "early", label: "Siet" },
  { id: "all", label: "Mind" },
];
const MODES: { id: Mode; label: string }[] = [
  { id: "all", label: "Mind" },
  { id: "bus", label: "Busz" },
  { id: "tram", label: "Villamos" },
];

const CAUSE_TONE: Record<Cause["tone"], string> = {
  late: "text-late",
  jam: "text-late",
  early: "text-early",
  muted: "text-muted-foreground",
};

/** a villamos-szűrőben a villamospótló busz is ott van: ő viszi a villamos utasait */
export const inMode = (v: { mode: "tram" | "bus"; replacement?: boolean }, m: Mode) =>
  m === "all" || (m === "tram" ? v.mode === "tram" || Boolean(v.replacement) : v.mode === "bus" && !v.replacement);

/** a járműtípus-szűrő (a rangsor és a rekordok közös beállítása) */
export function useFleetMode() {
  return usePreference<Mode>("mvk_fleet_mode", "all");
}

export function ModeChips({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Járműtípus">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={mode === m.id}
          onClick={() => onChange(m.id)}
          className={cn(
            "h-8 rounded-full border px-3 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mode === m.id ? "border-primary/60 bg-primary/12 text-foreground" : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** Segmentált választó (rangsor, időszak, fülek): egyforma kinézet mindenhol. */
export function Segmented<T extends string>({ value, options, onChange, label, className }: { value: T; options: { id: T; label: string; count?: number; tone?: string }[]; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex gap-1 rounded-lg border border-border bg-muted/60 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === o.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="truncate">{o.label}</span>
          {o.count != null ? <span className={cn("font-mono text-[10.5px] tabular-nums", value === o.id && o.tone)}>{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A rangsor: a jármű, hol jár, honnan jön a késése; kinyitva a késés útja megállónként. */
export function RankList({
  vehicles,
  mode,
  onMode,
  past,
  onFocusTrip,
  refreshKey,
}: {
  vehicles: BoardVehicle[];
  mode: Mode;
  onMode: (m: Mode) => void;
  /** visszanézéskor a pillanat és a napja */
  past: { t: number; date: string } | null;
  onFocusTrip?: (tripId: string, vehicleId?: string) => void;
  refreshKey: number;
}) {
  const [sort, setSort] = usePreference<Sort>("mvk_fleet_sort", "late");
  const [open, setOpen] = useState<string | null>(null);
  const pool = vehicles.filter((v) => inMode(v, mode));
  const counts = { late: pool.filter((v) => v.delayS >= ON_TIME_S).length, early: pool.filter((v) => v.delayS <= -ON_TIME_S).length, all: pool.length };
  const list =
    sort === "late" ? pool.filter((v) => v.delayS >= ON_TIME_S) : sort === "early" ? pool.filter((v) => v.delayS <= -ON_TIME_S).sort((a, b) => a.delayS - b.delayS) : pool;
  const scale = Math.max(300, ...list.map((v) => Math.abs(v.delayS)));

  return (
    <section aria-label="Járművek késés szerint" className="min-w-0">
      <div className="sticky top-0 z-bar flex flex-wrap items-center gap-2 bg-background/95 pb-2 pt-1 backdrop-blur">
        <Segmented
          label="Rangsor"
          value={sort}
          onChange={setSort}
          className="min-w-[15rem] flex-1"
          options={SORTS.map((s) => ({ id: s.id, label: s.label, count: counts[s.id], tone: s.id === "late" ? "text-late" : s.id === "early" ? "text-early" : undefined }))}
        />
        <ModeChips mode={mode} onChange={onMode} />
      </div>
      {list.length ? (
        <ol className="mt-1 space-y-1.5">
          {list.map((v, i) => (
            <FleetRow
              key={v.vehicleId}
              v={v}
              rank={i + 1}
              scale={scale}
              open={open === v.vehicleId}
              onToggle={() => setOpen(open === v.vehicleId ? null : v.vehicleId)}
              onFocusTrip={past ? undefined : onFocusTrip}
              refreshKey={refreshKey}
              past={past}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {sort === "late" ? "Egy jármű sem késik egy percnél többet." : sort === "early" ? "Egy jármű sem siet egy percnél többet." : "Nincs úton jármű."}
        </p>
      )}
    </section>
  );
}

function FleetRow({
  v,
  rank,
  scale,
  open,
  onToggle,
  onFocusTrip,
  refreshKey,
  past,
}: {
  v: BoardVehicle;
  rank: number;
  scale: number;
  open: boolean;
  onToggle: () => void;
  onFocusTrip?: (tripId: string, vehicleId?: string) => void;
  refreshKey: number;
  past: { t: number; date: string } | null;
}) {
  const late = v.delayS >= ON_TIME_S;
  const early = v.delayS <= -ON_TIME_S;
  const tone = late ? "text-late" : early ? "text-early" : "text-ontime";
  const why = causes(v);
  const detailId = `fleet-${v.vehicleId}`;
  const stalled = v.stallS != null && v.stallS >= 120;
  return (
    <li className={cn("overflow-hidden rounded-xl border bg-card transition-colors duration-fast", open ? "border-muted-foreground/40" : "border-border")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailId}
        className="relative grid w-full grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-start gap-x-2.5 px-3 pb-2.5 pt-2.5 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="pt-[5px] text-right font-mono text-[11px] font-bold tabular-nums text-muted-foreground">{rank}</span>
        <RouteTile short={v.route} color={v.color} text={v.text} className="mt-px" />
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold leading-6">{v.headsign}</span>
          <span className="line-clamp-2 text-[12px] text-muted-foreground sm:line-clamp-1">
            <span className="font-mono text-foreground/80">{v.vehicleId}</span>
            {v.replacement ? <span className="ml-1.5 rounded bg-nosignal/15 px-1 text-[10.5px] font-bold text-nosignal">pótló</span> : null}
            <span> · {whereText(v)}</span>
          </span>
          {stalled || why.length ? (
            <span className="mt-0.5 flex min-w-0 items-start gap-2 text-[12px] font-medium">
              {stalled ? (
                <span className="flex shrink-0 items-center gap-1 text-nosignal">
                  <OctagonPause className="h-3.5 w-3.5" aria-hidden /> {Math.round((v.stallS ?? 0) / 60)} p áll
                </span>
              ) : null}
              {why[0] ? <span className={cn("line-clamp-2 sm:line-clamp-1", CAUSE_TONE[why[0].tone])}>{why[0].text}</span> : null}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-[2.75rem] flex-col items-end">
          {late || early ? (
            <>
              <span className={cn("text-[20px] font-extrabold leading-none tracking-tight tabular-nums", tone)}>{minutesText(v.delayS).replace(" perc", "")}</span>
              <span className="mt-0.5 text-[10.5px] font-semibold text-muted-foreground">perc</span>
            </>
          ) : (
            <span className="pt-0.5 text-[13px] font-bold text-ontime">Időben</span>
          )}
          <ChevronDown className={cn("mt-1 h-4 w-4 text-muted-foreground transition-transform duration-fast", open && "rotate-180")} aria-hidden />
        </span>
        {/* a késés nagysága a rangsor legnagyobbjához mérve */}
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-muted/60" aria-hidden>
          <span className={cn("block h-full origin-left", late ? "bg-late/80" : early ? "bg-early/80" : "bg-ontime/60")} style={{ transform: `scaleX(${Math.max(0.02, Math.abs(v.delayS) / scale)})` }} />
        </span>
      </button>

      {open ? (
        <div id={detailId} className="space-y-3 border-t border-border/70 px-3 pb-3 pt-3">
          <dl className="grid grid-cols-3 gap-2 text-[12px]">
            <Fact label={past ? "Akkor" : "Most"} value={clockText(v.delayS)} tone={tone} />
            <Fact label="Induláskor" value={v.startDelayS != null ? clockText(v.startDelayS) : "nem mért"} />
            <Fact label="Megálló" value={`${v.stopsDone} / ${v.stopsTotal}`} />
          </dl>
          {why.length > 1 ? (
            <ul className="space-y-0.5">
              {why.slice(1).map((c) => (
                <li key={c.text} className={cn("text-[12px] font-medium", CAUSE_TONE[c.tone])}>
                  {c.text}
                </li>
              ))}
            </ul>
          ) : null}
          <DelayTrail
            tripId={v.tripId}
            refreshKey={refreshKey}
            pickup={v.pickup}
            history={past ? { date: past.date, until: past.t, at: { delayS: v.delayS, lastIdx: v.stopsDone - 1 } } : undefined}
          />
          {onFocusTrip ? (
            <Button variant="outline" size="sm" className="h-10 w-full" onClick={() => onFocusTrip(v.tripId, v.vehicleId)}>
              <MapPinned />
              Követés a térképen
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-[14px] font-bold tabular-nums", tone)}>{value}</dd>
    </div>
  );
}
