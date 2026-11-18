import { Bus, TramFront, type LucideIcon } from "lucide-react";
import type { BoardSnapshot, Corridor } from "@mvk/core";
import { cn } from "@/lib/utils";
import { busStatus, minutesText, tramStatus } from "./fleetText";

const TONE = {
  ok: { box: "border-border bg-card", icon: "bg-ontime/12 text-ontime", title: "text-foreground" },
  off: { box: "border-border bg-card", icon: "bg-muted text-muted-foreground", title: "text-muted-foreground" },
  warn: { box: "border-nosignal/35 bg-nosignal/[0.07]", icon: "bg-nosignal/15 text-nosignal", title: "text-nosignal" },
  bad: { box: "border-late/40 bg-late/[0.08]", icon: "bg-late/15 text-late", title: "text-late" },
} as const;

/**
 * A két hálózat állapota egymás alatt. Rendben egy csendes sor, baj esetén
 * a sor színt kap, és alá kerül, hol a gond.
 */
export function NetworkStatus({ data }: { data: BoardSnapshot }) {
  const tram = tramStatus(data.tram);
  const bus = busStatus(data.bus);
  return (
    <section aria-label="A hálózat állapota" className="space-y-2">
      <StatusRow icon={TramFront} label="Villamos" status={tram} />
      <StatusRow icon={Bus} label="Busz" status={bus}>
        {data.bus.corridors.length && data.bus.state !== "ok" ? <CorridorList corridors={data.bus.corridors} /> : null}
      </StatusRow>
    </section>
  );
}

function StatusRow({
  icon: Icon,
  label,
  status,
  children,
}: {
  icon: LucideIcon;
  label: string;
  status: ReturnType<typeof tramStatus>;
  children?: React.ReactNode;
}) {
  const t = TONE[status.tone];
  return (
    <div className={cn("rounded-xl border px-3.5 py-3", t.box)} role={status.tone === "bad" ? "alert" : undefined}>
      <div className="flex items-start gap-3">
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", t.icon)} aria-hidden>
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("text-[15px] font-bold leading-tight tracking-tight", t.title)}>
            <span className="sr-only">{label}: </span>
            {status.title}
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{status.detail}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** A torlódó gerincfolyosók: hol, mennyi többletidő, hány vonalat érint. */
function CorridorList({ corridors }: { corridors: Corridor[] }) {
  return (
    <ul className="mt-3 space-y-1.5 border-t border-border/60 pt-2.5 pl-12">
      {corridors.map((c) => (
        <li key={`${c.fromId}|${c.toId}`} className="text-[12.5px] leading-snug">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 font-semibold text-foreground">
              {c.from} → {c.to}
            </span>
            <span className="shrink-0 font-bold tabular-nums text-late">{minutesText(c.excessS)}</span>
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full origin-left rounded-full bg-late" style={{ transform: `scaleX(${Math.max(0.12, c.level)})` }} />
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground">{c.routes.length} vonal érinti</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
