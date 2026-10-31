import { EyeOff, History, Radio } from "lucide-react";
import type { JourneyMode, JourneyTransitLeg } from "@/services/api";
import { cn } from "@/lib/utils";
import { LiveDot } from "@/components/transit/LiveDot";
import {
  ON_TIME_SEC,
  TONE_TEXT,
  delayForecast,
  delayShort,
  hms,
  toneOf,
  vehiclePhrase,
} from "./format";
import { basisLabel } from "./forecast";
import { displayVehicleId } from "@/lib/modes";

type Props = { leg: JourneyTransitLeg; mode: JourneyMode };

/** Járatszakasz: várható késés (ma/jövő) vagy a mért valóság (múlt). */
export function LegInsight({ leg, mode }: Props) {
  return mode === "past" ? <ActualInsight leg={leg} /> : <ForecastInsight leg={leg} />;
}

function Delay({ sec, children }: { sec: number | null; children: React.ReactNode }) {
  return (
    <span className={cn("whitespace-nowrap font-semibold tabular-nums", TONE_TEXT[toneOf(sec)])}>
      {children}
    </span>
  );
}

/** „08:35:12-kor” — az idő és a rag ne törjön el egymástól. */
function At({ unix }: { unix: number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-semibold tabular-nums">{hms(unix)}</span>-kor
    </span>
  );
}

function ForecastInsight({ leg }: { leg: JourneyTransitLeg }) {
  const p = leg.prediction;
  if (!p || p.source === "none" || (p.depDelayS == null && p.arrDelayS == null)) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Ehhez a menethez nincs késési adatunk — a menetrendi időt mutatjuk.
      </p>
    );
  }
  const p85 = p.arrDelayP85S;
  const showWorst = p85 != null && p85 >= ON_TIME_SEC && p85 - (p.arrDelayS ?? 0) >= ON_TIME_SEC;
  const live = p.source === "live";
  return (
    <div className="space-y-1">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] leading-4">
        <dt className="text-muted-foreground">Indulás</dt>
        <dd>
          {p.depDelayS == null ? (
            <span className="text-muted-foreground">nincs adat</span>
          ) : (
            <span className="whitespace-nowrap">
              várhatóan <Delay sec={p.depDelayS}>{delayForecast(p.depDelayS)}</Delay>
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Érkezés</dt>
        <dd>
          {p.arrDelayS == null ? (
            <span className="text-muted-foreground">nincs adat</span>
          ) : (
            <span className="whitespace-nowrap">
              várhatóan <Delay sec={p.arrDelayS}>{delayForecast(p.arrDelayS)}</Delay>
            </span>
          )}
          {showWorst ? (
            <span className="whitespace-nowrap text-muted-foreground">
              {" "}
              · rossz esetben <span className="font-semibold tabular-nums text-late">{delayShort(p85)}</span>
            </span>
          ) : null}
        </dd>
      </dl>
      <p
        className={cn(
          "flex items-center gap-1.5 text-[10.5px]",
          live ? "font-semibold text-live" : "text-muted-foreground",
        )}
      >
        {live ? <LiveDot /> : <History aria-hidden className="h-3 w-3 shrink-0" />}
        {basisLabel(p)}
        {live && p.vehicleId ? (
          <span className="font-normal text-muted-foreground">
            ·{" "}
            {leg.mode === "RAIL" ? (
              "a vonat úton"
            ) : (
              <>
                <span className="font-mono">{displayVehicleId(p.vehicleId)}</span> úton
              </>
            )}
          </span>
        ) : null}
      </p>
    </div>
  );
}

function ActualInsight({ leg }: { leg: JourneyTransitLeg }) {
  const a = leg.actual;
  if (!a?.tracked) {
    return (
      <p className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground">
        <EyeOff aria-hidden className="h-3 w-3 shrink-0" />
        Erről a menetről nincs mérés.
      </p>
    );
  }
  return (
    <div className="space-y-0.5 text-[11px] leading-4">
      {a.depTs != null && a.depDelayS != null ? (
        <p>
          Valójában <At unix={a.depTs} /> indult (<Delay sec={a.depDelayS}>{delayShort(a.depDelayS)}</Delay>)
          {a.vehicleId ? (
            <>
              , <span className="whitespace-nowrap">{vehiclePhrase(a.vehicleId, leg.mode)}</span>
            </>
          ) : null}
          .
        </p>
      ) : (
        <p className="text-muted-foreground">
          Az indulásról nincs mérés{a.vehicleId ? ` (jármű: ${displayVehicleId(a.vehicleId)})` : ""}.
        </p>
      )}
      {a.arrTs != null && a.arrDelayS != null ? (
        <p className="flex flex-wrap items-center gap-x-1.5">
          <span>
            Valójában <At unix={a.arrTs} /> érkezett (<Delay sec={a.arrDelayS}>{delayShort(a.arrDelayS)}</Delay>).
          </span>
          {a.estimated ? (
            <span
              title="Ennél a megállónál nem volt közvetlen mérés, az időt a jármű pályájából becsültük."
              className="inline-flex items-center gap-1 rounded border border-border px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              <Radio aria-hidden className="h-2.5 w-2.5" />
              becsült
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-muted-foreground">Az érkezésről nincs mérés.</p>
      )}
    </div>
  );
}
