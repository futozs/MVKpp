import { todayLocalIso } from "./format";
import { ArrowLeftRight, ArrowUpDown, History, Search } from "lucide-react";
import type { Stop } from "@/types";
import type { JourneyMode } from "@/services/api";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { TimeField } from "@/components/ui/time-field";
import { cn } from "@/lib/utils";
import { PlaceSelect } from "./PlaceSelect";

export type PlanFormValue = {
  from: string;
  to: string;
  arriveBy: boolean;
  /** YYYY-MM-DD, helyi idő */
  date: string;
  /** HH:MM, helyi idő */
  time: string;
};

type Props = {
  places: Stop[];
  value: PlanFormValue;
  onChange: (patch: Partial<PlanFormValue>) => void;
  onNow: () => void;
  onSubmit: () => void;
  mode: JourneyMode;
  isLoading: boolean;
};

const HINT: Record<JourneyMode, string> = {
  past: "Múltbeli időpont: a járművek mért adataiból megmutatjuk, mi történt valójában.",
  now: "Most: ahol a jármű már úton van, az élő késéssel számolunk.",
  future: "Jövőbeli időpont: a várható késést a korábbi, azonos napszakos mérésekből becsüljük.",
};

function Segmented({ value, onChange }: { value: boolean; onChange: (arriveBy: boolean) => void }) {
  const options = [
    { id: false, label: "Indulás" },
    { id: true, label: "Érkezés" },
  ];
  return (
    <div role="group" aria-label="Az időpont jelentése" className="grid h-9 grid-cols-2 gap-1 rounded-lg border border-border bg-muted/60 p-1">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cn(
            "rounded-md px-3 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === o.id
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PlanForm({ places, value, onChange, onNow, onSubmit, mode, isLoading }: Props) {
  const canSubmit = Boolean(value.from && value.to && value.from !== value.to);
  const swap = () => onChange({ from: value.to, to: value.from });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !isLoading) onSubmit();
      }}
      className="rounded-2xl border border-border bg-card p-4 sm:p-5"
    >
      {/* Mobilon a két mező egymás alatt, a csere gomb mellettük középen;
          szélesebb kijelzőn a gomb a két mező között. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-3">
        <div className="col-start-1 row-start-1 min-w-0">
          <PlaceSelect label="Honnan" places={places} value={value.from} onChange={(from) => onChange({ from })} />
        </div>
        <div className="col-start-2 row-span-2 row-start-1 self-center pt-5 sm:row-span-1 sm:mt-[1.6rem] sm:self-start sm:pt-0">
          <Button type="button" variant="outline" size="icon" onClick={swap} aria-label="Irány megfordítása" className="rounded-full">
            <ArrowUpDown className="sm:hidden" />
            <ArrowLeftRight className="hidden sm:block" />
          </Button>
        </div>
        <div className="col-start-1 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1">
          <PlaceSelect label="Hova" places={places} value={value.to} onChange={(to) => onChange({ to })} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2 sm:gap-3">
        <Segmented value={value.arriveBy} onChange={(arriveBy) => onChange({ arriveBy })} />
        <div className="flex items-center gap-2">
          <DateField
            value={value.date}
            onChange={(date) => onChange({ date })}
            aria-label={value.arriveBy ? "Érkezés napja" : "Indulás napja"}
            today={todayLocalIso()}
          />
          <TimeField
            value={value.time}
            onChange={(time) => onChange({ time })}
            aria-label={value.arriveBy ? "Érkezés ideje" : "Indulás ideje"}
            className="w-[5.5rem]"
          />
          <Button type="button" variant="ghost" size="sm" onClick={onNow} className="px-2 text-primary">
            Most
          </Button>
        </div>
        <Button type="submit" disabled={!canSubmit || isLoading} className="w-full sm:ml-auto sm:w-auto">
          {mode === "past" ? <History /> : <Search />}
          {isLoading ? "Keresés…" : mode === "past" ? "Mi történt akkor?" : "Útvonal keresése"}
        </Button>
      </div>

      <p className={cn("mt-3 text-[11px]", mode === "past" ? "text-early" : "text-muted-foreground")}>
        {value.from && value.from === value.to ? "A kiinduló- és a célpont ugyanaz." : HINT[mode]}
      </p>
    </form>
  );
}
