/**
 * Egy indulás „jóslatai” a megállótáblákon: elérem-e gyalog, késve indul-e
 * (a busza még az előző menetén jár), és van-e dugó előtte.
 */
import { Bell, BellRing, Footprints, Hourglass, Loader2, TrafficCone, Zap } from "lucide-react";
import type { CatchVerdict } from "@mvk/core/catchBus";
import type { ArrivalItem } from "@/types";
import { cn, withHungarianSuffix } from "@/lib/utils";

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
export const hmOf = (unix: number) => HM.format(new Date(unix * 1000));
const minText = (s: number) => `${Math.max(1, Math.round(s / 60))} perc`;

const TONE: Record<CatchVerdict["state"], string> = {
  relax: "border-ontime/30 bg-ontime/10 text-ontime",
  go: "border-primary/50 bg-primary/15 text-primary",
  run: "border-amber-400/45 bg-amber-400/12 text-amber-300",
  missed: "border-late/40 bg-late/10 text-late",
};

function catchText(v: CatchVerdict): string {
  if (v.state === "relax") return `Ráérsz — indulj ${hmOf(v.leaveAtUnix)}-kor`;
  if (v.state === "go") return "Indulj most";
  if (v.state === "run") return `Csak futva éred el (${minText(v.runS)})`;
  return "Ezt már nem éred el";
}

/** Rövid jelzés a lista soraiban. */
export function CatchPill({ verdict, className }: { verdict: CatchVerdict | null; className?: string }) {
  if (!verdict) return null;
  const label = verdict.state === "relax" ? hmOf(verdict.leaveAtUnix) : verdict.state === "go" ? "most" : verdict.state === "run" ? "fuss" : "lekésed";
  return (
    <span
      title={`${catchText(verdict)} · ${minText(verdict.walkS)} séta`}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px font-mono text-[10px] font-bold tabular-nums", TONE[verdict.state], className)}
    >
      {verdict.state === "run" ? <Zap aria-hidden className="h-2.5 w-2.5" /> : <Footprints aria-hidden className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

/**
 * A következő indulás „Elérem?” sávja: séta, mikor indulj, és egy gomb, hogy
 * szóljunk, amikor indulni kell (push — a sétaidővel együtt számolva).
 */
export function CatchLine({
  verdict,
  next,
  alertOn,
  alertBusy,
  onToggleAlert,
  className,
}: {
  verdict: CatchVerdict | null;
  /** ha ezt lekésed: a következő ugyanazzal a vonallal */
  next?: ArrivalItem | null;
  alertOn: boolean;
  alertBusy?: boolean;
  onToggleAlert?: () => void;
  className?: string;
}) {
  if (!verdict) return null;
  const missedNext = verdict.state === "missed" && next ? ` — a következő ${withHungarianSuffix(next.route)}: ${next.time}` : "";
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold", TONE[verdict.state], className)}>
      {verdict.state === "run" ? <Zap aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <Footprints aria-hidden className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1">
        {catchText(verdict)}
        {missedNext}
        <span className="ml-1.5 font-normal opacity-80">· {minText(verdict.walkS)} séta</span>
      </span>
      {onToggleAlert && verdict.state !== "missed" ? (
        <button
          type="button"
          onClick={onToggleAlert}
          disabled={alertBusy}
          aria-pressed={alertOn}
          title={alertOn ? "Szólok, amikor indulni kell — koppints a kikapcsoláshoz" : "Szólj, amikor indulnom kell (a sétával együtt számolva)"}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            alertOn ? "bg-current/0 underline decoration-dotted underline-offset-2" : "hover:bg-foreground/10",
          )}
        >
          {alertBusy ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : alertOn ? <BellRing aria-hidden className="h-3 w-3" /> : <Bell aria-hidden className="h-3 w-3" />}
          {alertOn ? "Szólok" : "Szólj"}
        </button>
      ) : null}
    </div>
  );
}

/** A busza még az előző menetén jár: várhatóan később indul (vagy kimarad). */
export function StartRiskLine({ risk, compact, className }: { risk: ArrivalItem["startRisk"]; compact?: boolean; className?: string }) {
  if (!risk) return null;
  const missed = risk.level === "likely-missed";
  const where = risk.prevRoute ? `még a ${withHungarianSuffix(risk.prevRoute)} vonalon jár` : "még az előző menetén jár";
  const text = compact
    ? missed
      ? "valószínűleg kimarad"
      : `később indul (~${minText(risk.expectedDelayS)})`
    : `${missed ? "Valószínűleg kimarad vagy nagyon késve indul" : `Várhatóan kb. ${minText(risk.expectedDelayS)} késéssel indul`}: a busza (${risk.predicted ? "~" : ""}${risk.vehicleId}) ${where}, ${hmOf(risk.prevEndUnix)} körül ér be.`;
  return (
    <p
      className={cn(compact ? "inline-flex items-center gap-1 text-[10.5px]" : "flex items-start gap-1.5 text-[11.5px] leading-snug", "font-semibold", missed ? "text-late" : "text-amber-300", className)}
      title={compact ? `A busza (${risk.vehicleId}) ${where}` : undefined}
    >
      <Hourglass aria-hidden className={cn("shrink-0", compact ? "h-2.5 w-2.5" : "mt-px h-3.5 w-3.5")} />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** Dugó a busz előtt a megállóig (az élő forgalmi rétegből). */
export function TrafficLine({ traffic, compact, className }: { traffic: ArrivalItem["trafficAhead"]; compact?: boolean; className?: string }) {
  if (!traffic) return null;
  const heavy = traffic.level >= 0.6;
  return (
    <p
      className={cn(compact ? "inline-flex items-center gap-1 text-[10.5px]" : "flex items-start gap-1.5 text-[11.5px] leading-snug", "font-semibold", heavy ? "text-late" : "text-amber-300", className)}
      title={`${traffic.fromName} → ${traffic.toName}`}
    >
      <TrafficCone aria-hidden className={cn("shrink-0", compact ? "h-2.5 w-2.5" : "mt-px h-3.5 w-3.5")} />
      <span className="min-w-0">
        {compact ? `dugó +${minText(traffic.excessS)}` : `Dugó előtte: ${traffic.fromName} → ${traffic.toName}, kb. +${minText(traffic.excessS)}`}
      </span>
    </p>
  );
}

/** Kihúzott menet helyett: a következő nem kimaradó indulás ugyanazzal a vonallal és iránnyal a listában. */
export function replacementFor(list: readonly ArrivalItem[], a: ArrivalItem): ArrivalItem | null {
  if (!a.cancelled) return null;
  const i = list.indexOf(a);
  return list.slice(i + 1).find((x) => !x.cancelled && x.route === a.route && x.headsign === a.headsign) ?? null;
}

/** „helyette 08:05 (+12 perc)” a kihúzott menet mellé. */
export function ReplacementNote({ instead, cancelled, compact, className }: { instead: ArrivalItem | null; cancelled: ArrivalItem; compact?: boolean; className?: string }) {
  if (!instead) {
    return compact ? null : <p className={cn("text-[11.5px] font-semibold text-destructive", className)}>Az MVK kihúzta — a közeli indulások között nincs helyette ugyanilyen.</p>;
  }
  const gap = Math.max(0, instead.etaMin - cancelled.etaMin);
  return (
    <span className={cn("inline-flex items-center gap-1 rounded bg-ontime/10 px-1 py-px text-[10.5px] font-semibold text-ontime", !compact && "mt-2 text-[11.5px]", className)}>
      helyette {instead.time}
      {gap ? <span className="font-normal text-muted-foreground">(+{gap} perc)</span> : null}
    </span>
  );
}

