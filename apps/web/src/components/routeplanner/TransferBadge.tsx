import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from "lucide-react";
import type { JourneyMode, JourneyTransferCheck } from "@/services/api";
import { cn } from "@/lib/utils";
import { marginText } from "./format";

type Props = {
  check: JourneyTransferCheck;
  mode: JourneyMode;
  /** Múltban: mindkét oldalát mértük-e. Ha nem, a tartalék csak menetrendi. */
  measured?: boolean;
  className?: string;
};

const STYLE = {
  safe: "border-ontime/35 bg-ontime/10 text-ontime",
  tight: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  risky: "border-late/45 bg-late/12 text-late",
  unknown: "border-border bg-muted/60 text-muted-foreground",
} as const;

const ICON = {
  safe: CircleCheck,
  tight: TriangleAlert,
  risky: CircleX,
  unknown: CircleDashed,
} as const;

function copy(check: JourneyTransferCheck, mode: JourneyMode, measured: boolean) {
  const m = marginText(check.marginSec);
  if (mode === "past") {
    if (!measured) {
      return {
        label: `nincs mérés: menetrend szerint ${m} tartalék`,
        title: "Az átszállás egyik oldaláról nincs mérésünk, ezért a menetrendi tartalékot mutatjuk.",
      };
    }
    const title = "A mért érkezés és a következő járat mért indulása közti idő.";
    if (check.risk === "risky") return { label: `lekésted volna: ${m}-cel`, title };
    if (check.risk === "tight") return { label: `épphogy elérted volna: ${m} tartalék`, title };
    return { label: `elérted volna: ${m} tartalék`, title };
  }
  if (check.chance != null) {
    const pct = Math.round(check.chance * 100);
    const title = `Az első busz várható és rossz esetbeli érkezéséből, a csatlakozás várható indulásából és a séta idejéből (${m} ${check.marginSec < 0 ? "hiány" : "tartalék"} várhatóan).`;
    const alt = check.fallback ? ` · ha lekésed: ${check.fallback.time}` : "";
    if (check.risk === "risky") return { label: `${pct}% esély — valószínűleg lekésed${alt}`, title };
    if (check.risk === "tight") return { label: `${pct}% eséllyel eléred${alt}`, title };
    return { label: `${pct}% eséllyel eléred · ${m} tartalék`, title };
  }
  const title =
    "A következő járat várható indulása és az előző rossz esetben (85%) várható érkezése közti idő.";
  if (check.risk === "risky") {
    return { label: "kockázatos: valószínűleg lekésed", title: `${title} Rossz esetben ${m} hiányzik.` };
  }
  if (check.risk === "tight") return { label: `szoros: ${m} tartalék`, title };
  return { label: `kényelmes: ${m} tartalék`, title };
}

export function TransferBadge({ check, mode, measured = true, className }: Props) {
  const kind = mode === "past" && !measured ? "unknown" : check.risk;
  const Icon = ICON[kind];
  const { label, title } = copy(check, mode, measured);
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-4",
        STYLE[kind],
        className,
      )}
    >
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      <span className="min-w-0 tabular-nums">{label}</span>
    </span>
  );
}
