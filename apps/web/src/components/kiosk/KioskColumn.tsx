import { Bus, Radio } from "lucide-react";
import type { ArrivalItem, Stop } from "@/types";
import { cn } from "@/lib/utils";
import { delayState } from "@/components/transit/DelayBar";
import { PREF_PREDICTED_VEHICLE, usePreference } from "@/hooks/usePreference";
import { useStopBoard } from "./useStopBoard";
import { ForecastLine } from "@/components/transit/ForecastLine";

const hex = (v: string | undefined, fb: string) => `#${/^[0-9a-fA-F]{6}$/.test(v ?? "") ? v : fb}`;

/**
 * Egy megálló oszlopa a kijelzőn — a megállófigyelő kártyájának nagy változata:
 * felül kiemelve a következő busz (hol jár, melyik jármű jön), alatta a többi.
 * Minden méret `em`-ben van: a betűméretet a kijelző a képernyőhöz igazítja.
 */
export function KioskColumn({ stop, stopId, rows }: { stop: Stop | undefined; stopId: string; rows: number }) {
  const { data, error } = useStopBoard(stopId);
  const [showPredicted] = usePreference(PREF_PREDICTED_VEHICLE, true);
  const arrivals = data?.arrivals ?? [];
  const next = arrivals[0];
  const rest = arrivals.slice(1, 1 + rows);
  const name = stop?.name ?? data?.stop.name ?? stopId;
  const code = stop?.code ?? data?.stop.code;
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[0.9em] border border-border bg-card">
      <header className="flex items-baseline justify-between gap-[0.6em] px-[1.1em] pb-[0.6em] pt-[0.9em]">
        <h2 className="min-w-0 truncate text-[1.35em] font-extrabold leading-tight tracking-tight">{name}</h2>
        {code ? <span className="shrink-0 font-mono text-[0.7em] font-semibold text-muted-foreground">{code}</span> : null}
      </header>
      {next ? (
        <>
          <Featured a={next} showPredicted={showPredicted} />
          <ul className="flex min-h-0 flex-1 flex-col justify-start divide-y divide-border/60 px-[1.1em]">
            {rest.map((a, i) => (
              <Row key={`${a.tripId}-${i}`} a={a} showPredicted={showPredicted} />
            ))}
          </ul>
        </>
      ) : (
        <p className="flex flex-1 items-center justify-center px-[1em] text-center text-[0.9em] text-muted-foreground">
          {error ? "A megálló adatai most nem érhetők el." : data ? "A következő órában nincs innen induló járat." : "Betöltés…"}
        </p>
      )}
    </section>
  );
}

function RouteTile({ a, big = false }: { a: ArrivalItem; big?: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[0.35em] px-[0.3em] font-mono font-bold leading-none tabular-nums",
        big ? "h-[2.1em] min-w-[2.9em] text-[1.15em]" : "h-[1.7em] min-w-[2.4em] text-[0.9em]",
      )}
      style={{ background: hex(a.color, "3A4A44"), color: hex(a.text, "FFFFFF") }}
    >
      {a.route}
    </span>
  );
}

/** Késés szövegesen és színnel (mért késés elsőbbséggel, ahogy a megállófigyelőben). */
function Delay({ a }: { a: ArrivalItem }) {
  if (a.cancelled) return <span className="font-bold uppercase tracking-wide text-late">törölve</span>;
  const delay = a.measuredDelaySec ?? a.delaySec;
  const state = delayState(delay);
  if (state === "unknown") return null;
  if (state === "ontime") return <span className="text-ontime">pontos</span>;
  const min = Math.max(1, Math.round(Math.abs(delay!) / 60));
  return <span className={cn("font-mono font-bold", state === "late" ? "text-late" : "text-early")}>{state === "late" ? `+${min} perc` : `−${min} perc`}</span>;
}

/** Melyik jármű jön: élő rendszám, vagy előrejelzett (szaggatott keret, mint a figyelőben). */
function Vehicle({ a, showPredicted }: { a: ArrivalItem; showPredicted: boolean }) {
  if (a.vehicle)
    return (
      <span className="inline-flex items-center gap-[0.3em]">
        <Radio className="h-[1em] w-[1em] text-live" aria-label="élő" />
        <span className="font-mono font-bold text-foreground">{a.vehicle.id}</span>
      </span>
    );
  if (a.predictedVehicle && showPredicted)
    return (
      <span className="rounded-[0.25em] border border-dashed border-primary/50 px-[0.35em] font-mono font-bold text-primary" title="Előrejelzett rendszám">
        ~{a.predictedVehicle.id}
      </span>
    );
  return null;
}

function Eta({ a, big = false }: { a: ArrivalItem; big?: boolean }) {
  if (a.cancelled) return null;
  const mins = Math.max(0, Math.round(a.etaMin));
  return (
    <span className="shrink-0 text-right font-mono font-extrabold leading-none tabular-nums">
      {mins <= 0 ? (
        <span className={cn("text-primary motion-safe:animate-live-pulse", big ? "text-[1.9em]" : "text-[1.15em]")}>most</span>
      ) : (
        <span className={big ? "text-[2.6em]" : "text-[1.35em]"}>
          {mins}
          <span className="ml-[0.1em] text-[0.42em] font-bold text-muted-foreground">perc</span>
        </span>
      )}
    </span>
  );
}

function Featured({ a, showPredicted }: { a: ArrivalItem; showPredicted: boolean }) {
  const where = a.progressDesc ?? (a.currentStopName ? `${a.currentStopName} közelében` : null);
  return (
    <div className={cn("mx-[0.7em] mb-[0.5em] rounded-[0.75em] border border-border bg-muted/40 px-[0.9em] py-[0.8em]", a.cancelled && "opacity-60")}>
      <div className="flex items-center gap-[0.75em]">
        <RouteTile a={a} big />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-[1.1em] font-bold leading-tight", a.cancelled && "line-through")}>{a.headsign}</p>
          <p className="mt-[0.3em] flex items-center gap-[0.6em] text-[0.72em] text-muted-foreground">
            <span className="font-mono tabular-nums">{a.time}</span>
            <Delay a={a} />
          </p>
        </div>
        <Eta a={a} big />
      </div>
      {where || a.vehicle || a.predictedVehicle ? (
        <p className="mt-[0.65em] flex items-center gap-[0.5em] border-t border-border/70 pt-[0.55em] text-[0.78em] text-muted-foreground">
          <Bus className="h-[1.1em] w-[1.1em] shrink-0" />
          <span className="min-w-0 flex-1 truncate">{where ?? (a.vehicle ? "úton" : "még nem indult el")}</span>
          <Vehicle a={a} showPredicted={showPredicted} />
        </p>
      ) : null}
      <ForecastLine className="mt-[0.45em] text-[0.72em]" delayS={a.forecastDelaySec} upperS={a.forecastUpperSec} />
    </div>
  );
}

function Row({ a, showPredicted }: { a: ArrivalItem; showPredicted: boolean }) {
  const where = a.vehicle ? (a.currentStopName ?? null) : null;
  return (
    <li className={cn("flex min-h-0 items-center gap-[0.7em] py-[0.62em]", a.cancelled && "opacity-60")}>
      <RouteTile a={a} />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-[0.92em] font-semibold leading-tight", a.cancelled && "line-through")}>{a.headsign}</p>
        <p className="mt-[0.25em] flex items-center gap-[0.55em] truncate text-[0.66em] text-muted-foreground">
          <span className="font-mono tabular-nums">{a.time}</span>
          <Delay a={a} />
          {where ? <span className="truncate">· {where}</span> : null}
          <Vehicle a={a} showPredicted={showPredicted} />
        </p>
      </div>
      <Eta a={a} />
    </li>
  );
}
