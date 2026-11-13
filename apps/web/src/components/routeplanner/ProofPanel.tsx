import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCheck, Copy, TriangleAlert } from "lucide-react";
import type { JourneyPlanResponse, JourneyTrip } from "@/services/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MODE_NOUN,
  legTileText,
  TONE_TEXT,
  delayExact,
  hm,
  hms,
  localIsoDate,
  longDate,
  toneOf,
  transitLegs,
} from "./format";
import { buildProofText, pastOutcome } from "./proof";
import { displayVehicleId, vehicleIdTitle } from "@/lib/modes";

const COPIED_MS = 2200;

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Régebbi / nem biztonságos (http) környezet: rejtett szövegmező.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("copy failed");
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleCopy = async () => {
    try {
      await writeClipboard(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), COPIED_MS);
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy} className="shrink-0">
      {state === "copied" ? <Check className="text-ontime" /> : <Copy />}
      <span aria-live="polite">
        {state === "copied" ? "Másolva" : state === "failed" ? "Nem sikerült" : "Másolás"}
      </span>
    </Button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** Múltbeli utazás összefoglalója, igazolásként bemutatható formában. */
export function ProofPanel({ plan, trip }: { plan: JourneyPlanResponse; trip: JourneyTrip }) {
  const o = pastOutcome(trip);
  const vehicles = transitLegs(trip).map((l) => ({
    key: `${l.tripId}-${l.fromStopId}`,
    route: `${legTileText(l)} ${l.trainName ?? MODE_NOUN[l.mode]}`,
    id: l.actual?.vehicleId ? displayVehicleId(l.actual.vehicleId) : null,
  }));
  const appUrl = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <section aria-label="Igazolás" className="rounded-xl border border-border bg-background/50 p-3 sm:p-3.5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ClipboardCheck aria-hidden className="h-3.5 w-3.5" />
            Igazolás
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Bemásolható szöveg, pl. tanárnak vagy munkahelynek.
          </p>
        </div>
        <CopyButton text={buildProofText(plan, trip, appUrl)} />
      </header>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Row label="Nap">{longDate(localIsoDate(trip.start))}</Row>
        <Row label="Útvonal">
          {plan.from.name} → {plan.to.name}
        </Row>
        <Row label="Menetrend">
          <span className="tabular-nums">
            {hm(trip.start)} → {hm(trip.end)}
          </span>
        </Row>
        <Row label="Valójában">
          {o.actualArrival != null && o.arrivalDelayS != null ? (
            <span className="tabular-nums">
              érkezés {hms(o.actualArrival)}
              {o.arrivalEstimated ? " (becsült)" : ""} ·{" "}
              <span className={cn("font-semibold", TONE_TEXT[toneOf(o.arrivalDelayS)])}>
                {delayExact(o.arrivalDelayS)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">az érkezésről nincs mérés</span>
          )}
        </Row>
        <Row label="Járművek">
          {vehicles.map((v, i) => (
            <span key={v.key}>
              {i ? ", " : ""}
              {v.id ? <span className="font-mono font-semibold" title={vehicleIdTitle(v.id)}>{displayVehicleId(v.id)}</span> : <span className="text-muted-foreground">nincs mérés</span>}
              <span className="text-muted-foreground"> ({v.route})</span>
            </span>
          ))}
        </Row>
      </dl>

      {o.missedTransfer ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-late/40 bg-late/10 px-2 py-1.5 text-[11px] text-late">
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          A mért idők szerint az átszállás itt nem jött volna össze: {o.missedTransfer.at}. A tényleges
          érkezés ennél későbbi lett volna.
        </p>
      ) : null}
      {o.partial ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {o.untrackedRoutes.length < o.rideCount
            ? `Részleges mérés: a(z) ${o.untrackedRoutes.join(", ")} menetéről nincs adatunk.`
            : "Erről az útról nincs mérésünk  igazolásra nem alkalmas, csak a menetrendet mutatja."}
        </p>
      ) : null}
    </section>
  );
}
