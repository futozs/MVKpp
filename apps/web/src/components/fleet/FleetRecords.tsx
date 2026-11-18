import { useEffect, useState } from "react";
import { ChevronDown, Clock, LoaderCircle } from "lucide-react";
import type { RecordRun, RecordsResult } from "@mvk/core";
import { RouteTile } from "@/components/transit/RouteTile";
import { Button } from "@/components/ui/button";
import { formatClockShort, formatDayLabel } from "@/components/map/historyTime";
import { cn } from "@/lib/utils";
import { DelayTrail } from "./DelayTrail";
import { fetchCached } from "./fleetCache";
import { minShort } from "./fleetText";
import { ModeChips, Segmented, useFleetMode } from "./RankList";

type Period = "day" | "7" | "30" | "all";
type Kind = "late" | "early";
type Result = RecordsResult & { from: string; to: string };

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "A nap" },
  { id: "7", label: "7 nap" },
  { id: "30", label: "30 nap" },
  { id: "all", label: "Mindig" },
];

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

/**
 * Késési rekordok: a legnagyobb késések (vagy sietések) menetenként a napon,
 * az elmúlt 7 / 30 napban, vagy mindig, amióta adat van. Kinyitva a menet
 * késése megállónként; egy gombbal az egész oldal arra a pillanatra ugrik.
 */
export function FleetRecords({ date, onJump }: { date: string; onJump: (t: number) => void }) {
  const [period, setPeriod] = useState<Period>("day");
  const [kind, setKind] = useState<Kind>("late");
  const [mode, setMode] = useFleetMode();
  const [res, setRes] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const today = formatDayLabel(date, true);

  useEffect(() => {
    let alive = true;
    setRes(null);
    setFailed(false);
    // a lezárt időszak nem változik; a mai napot érintő csak rövid ideig él
    fetchCached<Result>(`/engine/fleet/records?date=${date}&period=${period}&mode=${mode}&kind=${kind}&limit=25`, period === "all" ? 600 : 120)
      .then((r) => alive && setRes(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [date, period, mode, kind]);

  return (
    <div className="space-y-3">
      <Segmented label="Időszak" value={period} onChange={setPeriod} options={PERIODS} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex gap-1" role="group" aria-label="Rekord">
          {(["late", "early"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "h-8 rounded-full border px-3 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                kind === k ? (k === "late" ? "border-late/60 bg-late/15 text-foreground" : "border-early/60 bg-early/15 text-foreground") : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "late" ? "Késés" : "Sietés"}
            </button>
          ))}
        </div>
        <ModeChips mode={mode} onChange={setMode} />
      </div>

      {res ? (
        <>
          <p className="text-[11.5px] text-muted-foreground">
            {period === "day" ? today : `${formatDayLabel(res.from, true)} – ${formatDayLabel(res.to, true)}`}
          </p>
          <dl className="grid grid-cols-3 gap-1.5 text-center">
            <Num label="menet" value={res.runs.toLocaleString("hu-HU")} />
            <Num label="5+ percet késett" value={pct(res.late5, res.runs)} tone="text-late" />
            <Num label="10+ percet" value={pct(res.late10, res.runs)} tone="text-late" />
          </dl>
          {res.items.length ? (
            <ol className="space-y-1.5">
              {res.items.map((r, i) => {
                const key = `${r.date}-${r.tripId}-${r.vehicleId}`;
                return <RecordRow key={key} r={r} rank={i + 1} open={open === key} onToggle={() => setOpen(open === key ? null : key)} onJump={onJump} showDate={period !== "day"} />;
              })}
            </ol>
          ) : (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Ebben az időszakban nincs adat.</p>
          )}
          {res.routes.length ? <RouteRanking routes={res.routes} colors={new Map(res.items.map((r) => [r.route, r] as const))} /> : null}
        </>
      ) : failed ? (
        <p className="py-6 text-center text-sm text-muted-foreground">A rekordok most nem érhetők el.</p>
      ) : (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          {period === "all" ? "Az összes nap átnézése…" : "Betöltés…"}
        </p>
      )}
    </div>
  );
}

function RecordRow({ r, rank, open, onToggle, onJump, showDate }: { r: RecordRun; rank: number; open: boolean; onToggle: () => void; onJump: (t: number) => void; showDate: boolean }) {
  const late = r.delayS >= 0;
  return (
    <li className={cn("overflow-hidden rounded-xl border bg-card", open ? "border-muted-foreground/40" : "border-border")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2.5 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-right font-mono text-[11px] font-bold tabular-nums text-muted-foreground">{rank}</span>
        <RouteTile short={r.route} color={r.color || null} text={r.text || null} />
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold">{r.headsign}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">
            {showDate ? `${formatDayLabel(r.date, true)} ` : ""}
            {formatClockShort(r.ts)} · {r.stop} · <span className="font-mono">{r.vehicleId}</span>
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn("text-[18px] font-extrabold tabular-nums", late ? "text-late" : "text-early")}>{minShort(r.delayS)}</span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-fast", open && "rotate-180")} aria-hidden />
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border/70 px-3 pb-3 pt-3">
          {r.startDelayS != null && Math.abs(r.startDelayS) >= 120 ? (
            <p className="text-[12px] font-medium text-muted-foreground">
              Induláskor már {minShort(r.startDelayS)}
            </p>
          ) : null}
          <DelayTrail tripId={r.tripId} history={{ date: r.date }} />
          <Button variant="outline" size="sm" className="h-10 w-full" onClick={() => onJump(r.ts)}>
            <Clock />
            Az egész hálózat {formatClockShort(r.ts)}-kor
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** A legrosszabb vonalak: a menetek mekkora része késett legalább 5 percet. */
function RouteRanking({ routes, colors }: { routes: RecordsResult["routes"]; colors: Map<string, { color: string; text: string }> }) {
  const top = Math.max(0.01, ...routes.map((r) => r.late5 / r.runs));
  return (
    <section aria-label="A legtöbbet késő vonalak">
      <h3 className="text-[12px] font-bold text-muted-foreground">Vonalak, ahol a legtöbb menet késett 5+ percet</h3>
      <ul className="mt-2 space-y-1.5">
        {routes.map((r) => (
          <li key={r.route} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2.5 text-[12px]">
            <RouteTile short={r.route} size="sm" color={colors.get(r.route)?.color || null} text={colors.get(r.route)?.text || null} />
            <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full origin-left rounded-full bg-late" style={{ transform: `scaleX(${r.late5 / r.runs / top})` }} />
            </span>
            <span className="tabular-nums text-muted-foreground">
              <span className="font-bold text-foreground">{pct(r.late5, r.runs)}</span> · {r.runs} menet
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Num({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col-reverse rounded-lg bg-muted/50 px-2 py-1.5">
      <dt className="text-[10.5px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-[16px] font-extrabold tabular-nums leading-tight", tone)}>{value}</dd>
    </div>
  );
}
