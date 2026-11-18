import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Pause, TramFront } from "lucide-react";
import type { BoardSnapshot, PlacedTram, TramLineView } from "@mvk/core";
import { cn } from "@/lib/utils";
import { minutesText, verdictText } from "./fleetText";
import { spreadLabels } from "./spreadLabels";

const ROW = 30;
/** két címke legalább ennyire kerül egymástól (a címke 22 px magas) */
const LABEL_GAP = 25;
/** a címke ennyire van a vágánytól; a köz a vezetővonalé (px) */
const LABEL_INSET = 14;

/** `y`: a villamos valódi helye, `labelY`: a címkéé (a közeliek szétosztva, hogy ne takarják egymást) */
type Chip = { t: PlacedTram; y: number; labelY: number };

function chips(trams: PlacedTram[], yOf: (t: PlacedTram) => number | null, height: number): Chip[] {
  const placed = trams.flatMap((t) => {
    const y = yOf(t);
    return y == null ? [] : [{ t, y }];
  });
  placed.sort((a, b) => a.y - b.y);
  const labels = spreadLabels(
    placed.map((p) => p.y),
    LABEL_GAP,
    11,
    height - 11,
  );
  return placed.map((p, i) => ({ ...p, labelY: labels[i] }));
}

/**
 * A villamosvonal sematikusan, élőben: középen a megállók, bal sávban az
 * egyik, jobb sávban a másik irány villamosai a valódi helyükön. Az álló
 * villamos szünet-jelet kap, a sor eleje és a valószínű akadály pirosan.
 */
export function TramLineMap({ lines }: { lines: TramLineView[] }) {
  const [down, up] = lines;
  if (!down) return null;
  const n = down.stops.length;
  const rowOf = new Map(down.stops.map((name, i) => [name, i]));
  // a második irány helye a bal oldali megállósor szerint, név alapján párosítva
  const upY = (t: PlacedTram) => {
    if (!up) return null;
    const k = Math.floor(t.pos);
    const a = rowOf.get(up.stops[k]);
    const b = rowOf.get(up.stops[Math.min(k + 1, up.stops.length - 1)]);
    if (a == null || b == null) return null;
    return (a + (b - a) * (t.pos - k)) * ROW + ROW / 2;
  };
  const downY = (t: PlacedTram) => t.pos * ROW + ROW / 2;
  const left = chips(down.trams, downY, n * ROW);
  const right = up ? chips(up.trams, upY, n * ROW) : [];
  const band = (view: TramLineView, yOf: (t: PlacedTram) => number | null) => {
    const head = view.blockage ? view.trams.find((t) => t.vehicleId === view.blockage?.head) : undefined;
    const y = head ? yOf(head) : null;
    return y == null ? null : y;
  };
  const leftBand = band(down, downY);
  const rightBand = up ? band(up, upY) : null;

  return (
    <figure aria-label="A villamosvonal élőben" className="select-none">
      <div className="mb-2 grid grid-cols-[1fr_7.5rem_1fr] text-[11px] font-semibold text-muted-foreground">
        <span className="flex items-center gap-1">
          <ArrowDown className="h-3.5 w-3.5" aria-hidden /> {down.toward} felé
        </span>
        <span />
        {up ? (
          <span className="flex items-center justify-end gap-1 text-right">
            {up.toward} felé <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
      </div>
      <div className="relative grid grid-cols-[1fr_7.5rem_1fr]" style={{ height: n * ROW }}>
        {/* a két vágány a megállónevek két oldalán */}
        <span className="absolute bottom-[15px] top-[15px] w-[3px] rounded-full bg-border" style={{ left: "calc(50% - 3.75rem - 1.5px)" }} aria-hidden />
        <span className="absolute bottom-[15px] top-[15px] w-[3px] rounded-full bg-border" style={{ left: "calc(50% + 3.75rem - 1.5px)" }} aria-hidden />
        {leftBand != null ? <Obstacle side="left" y={leftBand} dir="down" /> : null}
        {rightBand != null ? <Obstacle side="right" y={rightBand} dir="up" /> : null}

        <ol className="col-start-2 row-start-1">
          {down.stops.map((name, i) => (
            <li key={`${name}-${i}`} className="relative flex items-center justify-center px-2 text-center" style={{ height: ROW }}>
              <span className="absolute left-[-4px] h-2 w-2 rounded-full border-2 border-muted-foreground/60 bg-background" aria-hidden />
              <span className="line-clamp-2 text-[10.5px] leading-tight text-muted-foreground">{name}</span>
              <span className="absolute right-[-4px] h-2 w-2 rounded-full border-2 border-muted-foreground/60 bg-background" aria-hidden />
            </li>
          ))}
        </ol>

        <div className="relative col-start-1 row-start-1">
          {left.map((c) => (
            <TramChip key={c.t.vehicleId} c={c} side="left" />
          ))}
        </div>
        <div className="relative col-start-3 row-start-1">
          {right.map((c) => (
            <TramChip key={c.t.vehicleId} c={c} side="right" />
          ))}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-late" aria-hidden /> a villamos helye (színe: késik / időben / siet)
        </span>
        <span className="flex items-center gap-1">
          <Pause className="h-3 w-3 text-nosignal" aria-hidden /> 3+ perce áll
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm ring-2 ring-late" aria-hidden /> a sor eleje
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-[5px] rounded-full bg-late" aria-hidden /> valószínű akadály
        </span>
      </figcaption>
    </figure>
  );
}

/** a sor eleje előtti vágányszakasz, ahol az akadály valószínűleg van: a vágány pirosan */
function Obstacle({ side, y, dir }: { side: "left" | "right"; y: number; dir: "down" | "up" }) {
  const top = dir === "down" ? y : y - ROW;
  return (
    <span
      className="absolute w-[7px] rounded-full bg-late"
      style={{ top, height: ROW, left: side === "left" ? "calc(50% - 3.75rem - 3.5px)" : "calc(50% + 3.75rem - 3.5px)" }}
      aria-hidden
    />
  );
}

function TramChip({ c, side }: { c: Chip; side: "left" | "right" }) {
  const t = c.t;
  const late = t.delayS >= 60;
  const early = t.delayS <= -60;
  const edge = side === "left" ? "right" : "left";
  const top = Math.min(c.y, c.labelY);
  const moved = Math.abs(c.labelY - c.y) > 1;
  return (
    <>
      {/* a valódi hely a vágányon */}
      <span
        className={cn("absolute z-[1] h-2.5 w-2.5 -translate-y-1/2 rounded-full ring-2 ring-card", late ? "bg-late" : early ? "bg-early" : "bg-ontime")}
        style={{ top: c.y, [edge]: -5 }}
        aria-hidden
      />
      {/* vezetővonal a címkéhez: a vágány mellett le/fel, majd a címkéig */}
      {moved ? <span className="absolute w-px bg-muted-foreground/50" style={{ top, height: Math.abs(c.labelY - c.y), [edge]: 6 }} aria-hidden /> : null}
      <span className="absolute h-px bg-muted-foreground/50" style={{ top: c.labelY, width: LABEL_INSET - (moved ? 6 : 0), [edge]: moved ? 6 : 0 }} aria-hidden />
      <span
        className={cn(
          "absolute flex h-[22px] -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-md border bg-card px-1.5 text-[11px] font-bold tabular-nums shadow-sm",
          t.role === "head" ? "border-late ring-2 ring-late/60" : t.role === "stuck" ? "border-nosignal/70" : "border-border",
        )}
        style={{ top: c.labelY, [edge]: LABEL_INSET }}
        title={`${t.route} · ${t.vehicleId} · ${t.delayS >= 0 ? "+" : "−"}${Math.round(Math.abs(t.delayS) / 60)} perc${t.stallS ? ` · ${Math.round(t.stallS / 60)} perce áll` : ""}`}
      >
        {t.state === "stopped" ? <Pause className="h-3 w-3 text-nosignal" aria-label="áll" /> : null}
        <span className="font-mono text-foreground/90">{t.vehicleId}</span>
        {late || early ? <span className={late ? "text-late" : "text-early"}>{minutesText(t.delayS).replace(" perc", "")}</span> : null}
      </span>
    </>
  );
}

/**
 * Figyelő → Flotta: a villamosvonal elemzése. Baj esetén magától nyitva;
 * a felhasználó kézzel be- és kicsukhatja.
 */
export function TramLineSection({ analysis, alert }: { analysis: BoardSnapshot["tram"]["analysis"]; alert: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? alert;
  const v = verdictText(analysis.verdict);
  const bad = analysis.verdict.kind !== "ok";
  const bunches = analysis.lines.flatMap((l) => l.bunches.map((ids) => ({ toward: l.toward, ids })));
  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-3.5 py-3 text-left text-sm font-bold hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TramFront className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="flex-1">Villamosvonal élőben</span>
        {bad ? <span className="rounded bg-late/15 px-1.5 py-0.5 text-[10.5px] font-bold text-late">{v.title}</span> : null}
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-fast", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border/70 px-3.5 pb-4 pt-3">
          <div>
            <p className={cn("text-[13.5px] font-bold", bad ? "text-late" : "text-foreground")}>{v.title}</p>
            <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{v.text}</p>
            {bunches.map((b) => (
              <p key={b.ids.join()} className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">
                {b.toward} felé egymás nyakában jár {b.ids.length} villamos ({b.ids.join(", ")}).
              </p>
            ))}
          </div>
          <TramLineMap lines={analysis.lines} />
        </div>
      ) : null}
    </section>
  );
}
