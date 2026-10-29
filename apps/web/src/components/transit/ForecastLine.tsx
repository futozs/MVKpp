import { cn } from "@/lib/utils";
import { delayLabel, delayState, delayTone } from "./DelayBar";

/**
 * Várható késés ennél a megállónál — a mostani késésből és az elmúlt 8 hét
 * szakaszidejeiből; a „legrosszabb esetben” a 85%-os felső becslés.
 */
export function ForecastLine({
  delayS,
  upperS,
  className,
}: {
  delayS: number | null | undefined;
  upperS?: number | null;
  className?: string;
}) {
  if (delayS == null) return null;
  const state = delayState(delayS);
  const min = Math.max(1, Math.round(Math.abs(delayS) / 60));
  const main = state === "ontime" ? "pontosan" : state === "late" ? `+${min} perccel` : `${min} perccel korábban`;
  const showUpper = upperS != null && upperS - delayS >= 60 && delayState(upperS) === "late";
  return (
    <p
      className={cn("text-[11px] text-muted-foreground", className)}
      title="Előrejelzés a mostani késésből és az elmúlt 8 hét menetidejeiből (a felső érték 85%-ban nem lesz rosszabb)"
    >
      Ide várhatóan <span className={cn("font-semibold", delayTone(delayS))}>{main}</span> ér
      {showUpper ? (
        <>
          , legrosszabb esetben <span className="font-mono font-semibold text-late">{delayLabel(upperS)}</span>
        </>
      ) : null}
    </p>
  );
}
