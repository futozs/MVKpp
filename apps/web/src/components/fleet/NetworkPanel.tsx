import { Bus, TramFront } from "lucide-react";
import type { BoardSnapshot, Corridor } from "@mvk/core";
import { cn } from "@/lib/utils";
import { minShort, verdictText } from "./fleetText";
import { TramLineMap } from "./TramLineMap";

/**
 * A hálózat: fent a villamosvonal (mi történik, néhány szám, a vonal rajza a
 * villamosokkal), alatta a busz-gerinc dugói. A szöveg csak akkor, ha baj van.
 */
export function NetworkPanel({ data, routes }: { data: BoardSnapshot; routes: string[] }) {
  // vonalszűrésnél csak a kiválasztott vonalakat érintő dugók
  const corridors = routes.length ? data.bus.corridors.filter((c) => c.routes.some((r) => routes.includes(r))) : data.bus.corridors;
  const t = data.tram;
  const v = verdictText(t.analysis.verdict);
  const bad = t.analysis.verdict.kind !== "ok";
  const bunches = t.analysis.lines.flatMap((l) => l.bunches.map((ids) => ({ toward: l.toward, ids })));
  return (
    <div className="space-y-4">
      <section aria-labelledby="fleet-tram" className="rounded-xl border border-border bg-card p-3.5">
        <h2 id="fleet-tram" className="flex items-center gap-2 text-sm font-bold">
          <TramFront className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className={cn(bad && "text-late")}>{v.title}</span>
        </h2>
        {v.text ? <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{v.text}</p> : null}
        {bunches.map((b) => (
          <p key={b.ids.join()} className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
            Egymás nyakában {b.toward} felé: {b.ids.join(", ")}
          </p>
        ))}
        <dl className="mt-3 grid grid-cols-3 gap-1.5 text-center">
          <Num label="úton" value={String(t.running)} />
          <Num label="10+ perc" value={String(t.severe)} tone={t.severe ? "text-late" : undefined} />
          <Num label="legtöbb" value={t.maxDelayS != null && t.maxDelayS >= 60 ? minShort(t.maxDelayS) : "–"} tone={t.maxDelayS != null && t.maxDelayS >= 300 ? "text-late" : undefined} />
        </dl>
        {t.trouble ? (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Késés felszedve: <span className="font-semibold text-foreground">{t.trouble.from === t.trouble.to ? t.trouble.from : `${t.trouble.from} → ${t.trouble.to}`}</span> ({t.trouble.toward} felé)
          </p>
        ) : null}
        <div className="mt-4">
          <TramLineMap lines={t.analysis.lines} />
        </div>
      </section>

      <section aria-labelledby="fleet-bus" className="rounded-xl border border-border bg-card p-3.5">
        <h2 id="fleet-bus" className="flex items-center gap-2 text-sm font-bold">
          <Bus className="h-4 w-4 text-muted-foreground" aria-hidden />
          Busz-gerinc
        </h2>
        <dl className="mt-3 grid grid-cols-3 gap-1.5 text-center">
          <Num label="úton" value={String(data.bus.running)} />
          <Num label="5+ perc" value={String(data.bus.late)} tone={data.bus.late ? "text-late" : undefined} />
          <Num label="siet" value={String(data.bus.early)} tone={data.bus.early ? "text-early" : undefined} />
        </dl>
        {corridors.length ? (
          <CorridorList corridors={corridors} />
        ) : (
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            {routes.length ? "A kiválasztott vonalakat nem érinti dugó a gerincen." : "Nincs dugó a legalább öt vonal közös szakaszain."}
          </p>
        )}
      </section>
    </div>
  );
}

function Num({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    // a szám van fent, de a felolvasó előbb a feliratot hallja
    <div className="flex flex-col-reverse rounded-lg bg-muted/50 px-2 py-1.5">
      <dt className="text-[10.5px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-[16px] font-extrabold tabular-nums leading-tight", tone)}>{value}</dd>
    </div>
  );
}

/** A torlódó gerincfolyosók: hol, mennyi többletidő, hány vonalat érint. */
function CorridorList({ corridors }: { corridors: Corridor[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {corridors.map((c) => (
        <li key={`${c.fromId}|${c.toId}`} className="text-[12.5px] leading-snug">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 font-semibold">
              {c.from} → {c.to}
            </span>
            <span className="shrink-0 font-bold tabular-nums text-late">{minShort(c.excessS)}</span>
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full origin-left rounded-full bg-late" style={{ transform: `scaleX(${Math.max(0.12, c.level)})` }} />
            </span>
            <span className="text-[11.5px] text-muted-foreground">{c.routes.length} vonal</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
