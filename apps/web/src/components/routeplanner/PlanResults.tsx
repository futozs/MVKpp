import { CalendarClock, History, TrendingUp, TriangleAlert } from "lucide-react";
import type { JourneyMode, JourneyPlanResponse } from "@/services/api";
import { LiveDot } from "@/components/transit/LiveDot";
import { cn } from "@/lib/utils";
import { dateAdjective, hm, localIsoDate, longDate } from "./format";
import { TripCard } from "./TripCard";

const MODE_TAG: Record<JourneyMode, string> = {
  past: "Mért adatok",
  now: "Élő",
  future: "Előrejelzés",
};

const MODE_NOTE: Record<JourneyMode, string> = {
  past: "A menetrendet a járművek mért GPS-adataival vetjük össze: így ment valójában.",
  now: "Ahol a jármű már úton van, az élő késésével számolunk, a többinél a korábbi mérésekkel.",
  future:
    "A várható késés az elmúlt 90 nap hasonló napjain, ugyanebben a napszakban mért adatokból jön. A „rossz esetben” értéknél a mérések 85%-a nem volt rosszabb.",
};

function ModeTag({ mode }: { mode: JourneyMode }) {
  const Icon = mode === "past" ? History : TrendingUp;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
        mode === "now" ? "border-live/40 bg-live/10 text-live" : "border-border bg-muted/60 text-foreground",
      )}
    >
      {mode === "now" ? <LiveDot /> : <Icon aria-hidden className="h-3 w-3" />}
      {MODE_TAG[mode]}
    </span>
  );
}

/** `emptyHint`: ha nincs út, mit érdemes kipróbálni (pl. a Volán vagy a vonat bepipálását) */
export function PlanResults({ plan, emptyHint }: { plan: JourneyPlanResponse; emptyHint?: string | null }) {
  const when = plan.arriveBy ? `${hm(plan.at)}-ig érkezéssel` : `${hm(plan.at)} utáni indulással`;
  return (
    <section aria-labelledby="rp-results-title" className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-1">
        <div className="min-w-0">
          <h2 id="rp-results-title" className="text-sm font-semibold tracking-tight [overflow-wrap:anywhere]">
            {plan.from.name} → {plan.to.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <CalendarClock aria-hidden className="h-3 w-3 shrink-0" />
            {longDate(localIsoDate(plan.at))} · {when}
          </p>
        </div>
        <ModeTag mode={plan.mode} />
      </header>

      {plan.schedule.fallback ? (
        <p className="flex items-start gap-2 rounded-xl border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span>
            Az MVK erre a napra nem adott ki menetrendet, ezért {dateAdjective(plan.schedule.fallback)}{" "}
            menetrend alapján terveztünk. A valóságban eltérhet.
          </span>
        </p>
      ) : null}

      {plan.trips.length ? (
        <>
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{MODE_NOTE[plan.mode]}</p>
          <div className="space-y-3">
            {plan.trips.map((t, i) => (
              <TripCard key={`${plan.at}-${t.start}-${i}`} plan={plan} trip={t} defaultOpen={i === 0} />
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-semibold">Ebben az időpontban nincs kapcsolat a két hely között.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {emptyHint ?? "Éjszaka és hétvégén kevesebb járat közlekedik — próbálj másik időpontot."}
          </p>
        </div>
      )}
    </section>
  );
}

export function ResultsSkeleton() {
  return (
    <div aria-hidden className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3 rounded-2xl border border-border bg-card p-4">
          <div className="flex justify-between">
            <div className="h-6 w-36 rounded-md bg-muted motion-safe:animate-pulse" />
            <div className="h-4 w-14 rounded-md bg-muted motion-safe:animate-pulse" />
          </div>
          <div className="flex gap-1.5">
            <div className="h-5 w-9 rounded-md bg-muted motion-safe:animate-pulse" />
            <div className="h-5 w-9 rounded-md bg-muted motion-safe:animate-pulse" />
          </div>
          <div className="h-3.5 w-52 max-w-full rounded bg-muted motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}
