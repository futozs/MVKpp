import type { ReactNode } from "react";
import type { KindCounts } from "@/services/parkingApi";
import { cn } from "@/lib/utils";

const SEGMENTS: { key: keyof Omit<KindCounts, "total">; label: string; color: string; text: string }[] = [
  { key: "service", label: "bevetésen", color: "bg-primary", text: "text-primary" },
  { key: "terminus", label: "végállomáson", color: "bg-park", text: "text-park" },
  { key: "depot", label: "kocsiszínben", color: "bg-depot/70", text: "text-depot" },
  { key: "nosignal", label: "jel nélkül", color: "bg-nosignal", text: "text-nosignal" },
];

/** A flotta megoszlása most: négy nagy szám és egy arányos sáv. */
export function FleetSummary({ counts, facts }: { counts: KindCounts; facts: { label: string; value: ReactNode }[] }) {
  const total = Math.max(1, counts.total);
  return (
    <section aria-label="A flotta most" className="rounded-2xl border border-border bg-card px-4 pb-4 pt-3.5 shadow-sm sm:px-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {SEGMENTS.map((s) => (
          <div key={s.key} className={cn("min-w-0", s.key === "nosignal" && counts.nosignal === 0 && "opacity-50")}>
            <dt className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className={cn("h-2 w-2 rounded-[3px]", s.color)} />
              {s.label}
            </dt>
            <dd className={cn("mt-1 text-[26px] font-bold leading-none tracking-tight tabular-nums sm:text-[30px]", s.text)}>{counts[s.key]}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex h-2.5 w-full gap-[3px] overflow-hidden" role="img" aria-label={SEGMENTS.map((s) => `${counts[s.key]} ${s.label}`).join(", ")}>
        {SEGMENTS.map((s) =>
          counts[s.key] ? (
            <span
              key={s.key}
              className={cn("h-full rounded-full transition-[flex-grow] duration-normal", s.color)}
              style={{ flexGrow: counts[s.key] / total }}
            />
          ) : null,
        )}
      </div>
      {facts.length ? (
        <ul className="mt-4 grid gap-2 border-t border-border/70 pt-3 sm:grid-cols-3">
          {facts.map((f) => (
            <li key={f.label} className="min-w-0">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{f.label}</p>
              <p className="mt-0.5 truncate text-[13px]">{f.value}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
