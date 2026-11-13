import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** A tervezésben használt regionális módok (az MVK mindig benne van). */
export type PlanTravel = { coach: boolean; rail: boolean };

/** Üres eredménynél: mit érdemes még bepipálni. */
export function travelEmptyHint(t: PlanTravel): string | null {
  if (t.coach && t.rail) return null;
  if (!t.coach && !t.rail) return "Lehet, hogy csak MVK-val nem érhető el  pipáld be a Volánt vagy a vonatot, vagy próbálj másik időpontot.";
  return t.rail
    ? "Lehet, hogy Volán nélkül nem érhető el  pipáld be a Volánt, vagy próbálj másik időpontot."
    : "Lehet, hogy vonat nélkül nem érhető el  pipáld be a vonatot, vagy próbálj másik időpontot.";
}

function ModeCheck({
  label,
  checked,
  locked,
  onChange,
}: {
  label: string;
  checked: boolean;
  /** mindig benne van (az MVK): látszik, de nem vehető ki */
  locked?: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <label
      title={locked ? "Az MVK járatai mindig benne vannak a tervezésben." : undefined}
      className={cn(
        "inline-flex h-9 select-none items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors duration-fast focus-within:ring-1 focus-within:ring-ring",
        checked ? "border-primary/50 bg-primary/10 text-foreground" : "border-border bg-muted/60 text-muted-foreground",
        locked ? "cursor-default" : "cursor-pointer hover:border-primary/40 hover:text-foreground",
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} disabled={locked} onChange={(e) => onChange?.(e.target.checked)} />
      <span
        aria-hidden
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-fast",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 bg-card",
          locked && "opacity-70",
        )}
      >
        {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </span>
      {label}
    </label>
  );
}

/** Mivel tervezzen: az MVK mindig, a Volán és a vonat bepipálható. */
export function TravelModes({ value, onChange }: { value: PlanTravel; onChange: (patch: Partial<PlanTravel>) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mivel utaznál?</legend>
      <div className="flex flex-wrap gap-2">
        <ModeCheck label="MVK" checked locked />
        <ModeCheck label="Volán" checked={value.coach} onChange={(coach) => onChange({ coach })} />
        <ModeCheck label="Vonat" checked={value.rail} onChange={(rail) => onChange({ rail })} />
      </div>
    </fieldset>
  );
}
