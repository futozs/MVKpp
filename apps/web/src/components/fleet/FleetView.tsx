import { useState } from "react";
import { ChevronDown, CircleAlert, MapPinned, OctagonPause } from "lucide-react";
import type { BoardVehicle } from "@mvk/core";
import { RouteTile } from "@/components/transit/RouteTile";
import { Button } from "@/components/ui/button";
import { usePreference } from "@/hooks/usePreference";
import { cn } from "@/lib/utils";
import { DelayTrail } from "./DelayTrail";
import { NetworkStatus } from "./NetworkStatus";
import { TramLineSection } from "./TramLineMap";
import { causes, clockText, minutesText, whereText, type Cause } from "./fleetText";
import { useFleetBoard } from "./useFleetBoard";
import { FleetTimeline } from "./FleetTimeline";
import { formatClockShort, formatDayLabel, serviceDayOf } from "@/components/map/historyTime";

type Sort = "late" | "early" | "all";
type Mode = "all" | "bus" | "tram";

/** ennyi eltérés alatt a jármű időben jár (mp) */
const ON_TIME_S = 60;

const SORTS: { id: Sort; label: string }[] = [
  { id: "late", label: "Késik" },
  { id: "early", label: "Siet" },
  { id: "all", label: "Mind" },
];
const MODES: { id: Mode; label: string }[] = [
  { id: "all", label: "Minden jármű" },
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
const inMode = (v: BoardVehicle, m: Mode) => m === "all" || (m === "tram" ? v.mode === "tram" || v.replacement : v.mode === "bus" && !v.replacement);

/**
 * Flotta: az összes úton lévő MVK-jármű késés szerint rangsorolva, a
 * villamos- és a buszhálózat állapotával. Élőben, vagy visszanézve bármely
 * múltbeli pillanatra, amíg van adat.
 */
export function FleetView({ onFocusTrip }: { onFocusTrip?: (tripId: string, vehicleId?: string) => void }) {
  /** null: élő; különben a visszanézett pillanat (unix mp) */
  const [at, setAt] = useState<number | null>(null);
  const { data, failed, loading } = useFleetBoard(at);
  const [sort, setSort] = usePreference<Sort>("mvk_fleet_sort", "late");
  const [mode, setMode] = usePreference<Mode>("mvk_fleet_mode", "all");
  const [open, setOpen] = useState<string | null>(null);

  const timeline = <FleetTimeline at={at} onAt={setAt} onLive={() => setAt(null)} loading={loading} />;

  if (!data) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1100px] space-y-3 px-3 py-4 sm:px-4">
          {timeline}
          {failed ? (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <CircleAlert className="h-4 w-4" /> A flotta adatai most nem érhetők el. Pár másodperc múlva újra próbálom.
            </p>
          ) : (
            [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[74px] animate-pulse rounded-xl bg-muted/40" />)
          )}
        </div>
      </div>
    );
  }

  const pool = data.vehicles.filter((v) => inMode(v, mode));
  const counts = {
    late: pool.filter((v) => v.delayS >= ON_TIME_S).length,
    early: pool.filter((v) => v.delayS <= -ON_TIME_S).length,
    all: pool.length,
  };
  const list =
    sort === "late"
      ? pool.filter((v) => v.delayS >= ON_TIME_S)
      : sort === "early"
        ? pool.filter((v) => v.delayS <= -ON_TIME_S).sort((a, b) => a.delayS - b.delayS)
        : pool;
  const scale = Math.max(300, ...list.map((v) => Math.abs(v.delayS)));
  const onTime = data.vehicles.filter((v) => Math.abs(v.delayS) < ON_TIME_S).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1100px] px-3 pt-3 sm:px-4 sm:pt-4">{timeline}</div>
      <div className={cn("mx-auto grid w-full max-w-[1100px] gap-4 px-3 py-3 transition-opacity duration-fast sm:px-4 sm:py-4 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start", loading && "opacity-60")}>
        <div className="space-y-3 lg:sticky lg:top-4">
          <NetworkStatus data={data} />
          <TramLineSection analysis={data.tram.analysis} alert={mode === "tram" || !["ok", "off"].includes(data.tram.state)} />
          <p className="px-1 text-[11.5px] text-muted-foreground">
            {data.vehicles.length} jármű úton · {onTime} időben jár ·{" "}
            {at != null ? `állapot ${formatDayLabel(serviceDayOf(data.at), true)} ${formatClockShort(data.at)}-kor` : failed ? "a frissítés most nem sikerült" : freshText(Date.now() / 1000 - data.at)}
          </p>
        </div>

        <section aria-label="Járművek késés szerint" className="min-w-0">
          <div className="sticky top-0 z-bar -mx-3 space-y-2 bg-background/95 px-3 pb-2 pt-1 backdrop-blur sm:-mx-4 sm:px-4 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:backdrop-blur-none">
            <div role="tablist" aria-label="Rangsor" className="flex gap-1 rounded-lg border border-border bg-muted/60 p-1">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={sort === s.id}
                  onClick={() => setSort(s.id)}
                  className={cn(
                    "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    sort === s.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s.label}
                  <span className={cn("font-mono text-[10.5px] tabular-nums", sort === s.id && (s.id === "late" ? "text-late" : s.id === "early" ? "text-early" : "text-muted-foreground"))}>{counts[s.id]}</span>
                </button>
              ))}
            </div>
            <div className="flex gap-1.5" role="group" aria-label="Járműtípus">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    "h-8 rounded-full border px-3 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    mode === m.id ? "border-primary/60 bg-primary/12 text-foreground" : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
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
                  onFocusTrip={at == null ? onFocusTrip : undefined}
                  refreshKey={data.at}
                  past={at != null ? { t: data.at, date: serviceDayOf(data.at) } : null}
                />
              ))}
            </ol>
          ) : (
            <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {sort === "late" ? "Most egy jármű sem késik egy percnél többet." : sort === "early" ? "Most egy jármű sem siet egy percnél többet." : "Most nincs úton jármű."}
              {mode !== "all" ? " (a kiválasztott járműtípusból)" : ""}
            </p>
          )}
        </section>
      </div>
    </div>
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
  /** visszanézéskor a pillanat és a napja */
  past: { t: number; date: string } | null;
}) {
  const late = v.delayS >= ON_TIME_S;
  const early = v.delayS <= -ON_TIME_S;
  const tone = late ? "text-late" : early ? "text-early" : "text-ontime";
  const why = causes(v);
  const detailId = `fleet-${v.vehicleId}`;
  return (
    <li className={cn("overflow-hidden rounded-xl border bg-card transition-colors duration-fast", open ? "border-muted-foreground/40" : "border-border")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailId}
        className="relative grid w-full grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-start gap-x-2.5 px-3 pb-3 pt-2.5 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="pt-[5px] text-right font-mono text-[11px] font-bold tabular-nums text-muted-foreground">{rank}</span>
        <RouteTile short={v.route} color={v.color} text={v.text} className="mt-px" />
        <span className="min-w-0">
          <span className="line-clamp-2 text-[14px] font-semibold leading-snug">{v.headsign}</span>
          <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
            <span className="font-mono text-foreground/80">{v.vehicleId}</span>
            {v.replacement ? <span className="ml-1.5 rounded bg-nosignal/15 px-1 text-[10.5px] font-bold text-nosignal">pótló</span> : null}
            <span> · {whereText(v)}</span>
          </span>
          {v.stallS != null && v.stallS >= 120 ? (
            <span className="mt-1 flex items-center gap-1 text-[12px] font-semibold text-nosignal">
              <OctagonPause className="h-3.5 w-3.5 shrink-0" aria-hidden /> {Math.round(v.stallS / 60)} perce áll egy helyben
            </span>
          ) : null}
          {(open ? [] : why.slice(0, 1)).map((c) => (
            <span key={c.text} className={cn("mt-1 block text-[12px] font-medium leading-snug", CAUSE_TONE[c.tone])}>
              {c.text}
            </span>
          ))}
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
          <ChevronDown className={cn("mt-1.5 h-4 w-4 text-muted-foreground transition-transform duration-fast", open && "rotate-180")} aria-hidden />
        </span>
        {/* a késés nagysága a rangsor legnagyobbjához mérve */}
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-muted/60" aria-hidden>
          <span
            className={cn("block h-full origin-left", late ? "bg-late/80" : early ? "bg-early/80" : "bg-ontime/60")}
            style={{ transform: `scaleX(${Math.max(0.02, Math.abs(v.delayS) / scale)})` }}
          />
        </span>
      </button>

      {open ? (
        <div id={detailId} className="space-y-3 border-t border-border/70 px-3 pb-3 pt-3">
          <dl className="grid grid-cols-3 gap-2 text-[12px]">
            <Fact label="Most" value={clockText(v.delayS)} tone={tone} />
            <Fact label="Induláskor" value={v.startDelayS != null ? clockText(v.startDelayS) : "nem mért"} />
            <Fact label="Megálló" value={`${v.stopsDone} / ${v.stopsTotal}`} />
          </dl>
          {why.length ? (
            <ul className="space-y-1">
              {why.map((c) => (
                <li key={c.text} className={cn("text-[12.5px] font-medium", CAUSE_TONE[c.tone])}>
                  {c.text}
                </li>
              ))}
            </ul>
          ) : null}
          <DelayTrail tripId={v.tripId} refreshKey={refreshKey} pickup={v.pickup} past={past ? { ...past, delayS: v.delayS, lastIdx: v.stopsDone - 1 } : null} />
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

function freshText(ageS: number): string {
  return ageS < 60 ? "élő adat" : `${Math.round(ageS / 60)} perce frissült`;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-[14px] font-bold tabular-nums", tone)}>{value}</dd>
    </div>
  );
}
