import { useState } from "react";
import type { FleetDay } from "@mvk/core";
import type { Route } from "@/types";
import { serviceDayOf, serviceDayRange } from "@/components/map/historyTime";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import { Breakdowns } from "./Breakdowns";
import { DayCurve, type CurveLane } from "./DayCurve";
import { fetchCached } from "./fleetCache";
import { FleetRecords } from "./FleetRecords";
import { Segmented } from "./RankList";

const STEPS = [-15, -5, -1, 1, 5, 15];
/** ennél több kiválasztott vonalnál egy közös sáv (különben túl magas a görbe) */
const MAX_LANES = 4;
type Tab = "records" | "breakdowns";

const nowUnix = () => Math.floor(Date.now() / 1000);

/** A görbe sávjai: a flottára villamos és busz; vonalszűrésnél vonalanként (sok vonalnál összevonva). */
function curveLanes(day: FleetDay, routes: string[]): CurveLane[] {
  if (!routes.length) {
    return [
      { key: "tram", label: "Villamos", late: day.buckets.map((b) => b.tramLate), fill: "fill-late/70", bands: day.breakdowns.filter((b) => b.kind === "tram"), bandFill: "fill-late/15" },
      { key: "bus", label: "Busz", late: day.buckets.map((b) => b.busLate), fill: "fill-foreground/35", bands: day.breakdowns.filter((b) => b.kind === "bus"), bandFill: "fill-nosignal/15" },
    ];
  }
  const lanes = (day.lanes ?? []).filter((l) => routes.includes(l.route));
  if (lanes.length <= MAX_LANES) {
    return routes.flatMap((r) => {
      const l = lanes.find((x) => x.route === r);
      return l ? [{ key: r, label: r, late: l.late, running: l.n, fill: "fill-late/75" }] : [];
    });
  }
  const sum = (pick: (l: (typeof lanes)[number]) => number[]) => day.buckets.map((_, i) => lanes.reduce((n, l) => n + (pick(l)[i] ?? 0), 0));
  return [{ key: "sel", label: `${lanes.length} vonal`, late: sum((l) => l.late), running: sum((l) => l.n), fill: "fill-late/75" }];
}

/**
 * Az idő: a nap késésgörbéje (élőben a mai, visszanézéskor a választott nap;
 * vonalszűrésnél a kiválasztott vonalaké), rajta húzható az időpont; alatta a
 * rekordok és az összeomlások.
 */
export function TimePanel({ at, onAt, routes, allRoutes }: { at: number | null; onAt: (t: number) => void; routes: string[]; allRoutes: Route[] }) {
  const now = nowUnix();
  const date = serviceDayOf(at ?? now);
  const range = serviceDayRange(date);
  const maxValue = Math.min(range.end - 1, now);
  const [day, setDay] = useState<{ key: string; data: FleetDay } | null>(null);
  const [tab, setTab] = useState<Tab>("records");
  const today = serviceDayOf(now);
  const key = `${date}|${routes.join(",")}`;

  // a mai görbe élőben kétpercenként frissül; a lezárt nap gyorsítótárból jön
  useVisiblePoll(
    () => {
      fetchCached<FleetDay>(`/engine/fleet/day?date=${date}${routes.length ? `&routes=${encodeURIComponent(routes.join(","))}` : ""}`, date < today ? 3600 : 110)
        .then((data) => setDay({ key, data }))
        .catch(() => {});
    },
    120_000,
    [key],
  );
  const curve = day?.key === key ? day.data : null;
  const lanes = curve ? curveLanes(curve, routes) : [];

  return (
    <div className="space-y-4">
      <section aria-label="A nap késésgörbéje" className="rounded-xl border border-border bg-card p-3">
        {curve && lanes.length ? (
          <DayCurve
            range={range}
            from={curve.from}
            step={curve.step}
            lanes={lanes}
            value={at ?? now}
            maxValue={maxValue}
            onScrub={onAt}
            legend={routes.length ? "piros: 5+ percet késő menetek · halvány: úton lévők · húzd az időpontot" : "5+ percet késő járművek · színes háttér: összeomlás · húzd az időpontot"}
          />
        ) : curve ? (
          <p className="py-6 text-center text-xs text-muted-foreground">A kiválasztott vonalaknak ezen a napon nincs adata.</p>
        ) : (
          <div className="h-[128px] animate-pulse rounded-lg bg-muted/40" aria-label="A nap görbéjének betöltése" />
        )}
        {at != null ? (
          <div className="mt-2 grid grid-cols-6 gap-1" role="group" aria-label="Léptetés">
            {STEPS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onAt(Math.max(range.start, Math.min(maxValue, at + m * 60)))}
                className="h-8 whitespace-nowrap rounded-md border border-border text-xs font-semibold tabular-nums text-muted-foreground transition-colors duration-fast hover:border-muted-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m > 0 ? `+${m}` : `−${-m}`} p
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <Segmented
        label="Idő nézet"
        value={tab}
        onChange={setTab}
        options={[
          { id: "records", label: "Rekordok" },
          { id: "breakdowns", label: "Összeomlások", count: curve?.breakdowns.length || undefined, tone: "text-late" },
        ]}
      />
      {tab === "records" ? <FleetRecords date={date} onJump={onAt} pageRoutes={routes} allRoutes={allRoutes} /> : <Breakdowns dayItems={curve?.breakdowns ?? null} at={at} onJump={onAt} />}
    </div>
  );
}
