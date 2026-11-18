import { useState } from "react";
import type { FleetDay } from "@mvk/core";
import { serviceDayOf, serviceDayRange } from "@/components/map/historyTime";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import { Breakdowns } from "./Breakdowns";
import { DayCurve } from "./DayCurve";
import { fetchCached } from "./fleetCache";
import { FleetRecords } from "./FleetRecords";
import { Segmented } from "./RankList";

const STEPS = [-15, -5, -1, 1, 5, 15];
type Tab = "records" | "breakdowns";

const nowUnix = () => Math.floor(Date.now() / 1000);

/**
 * Az idő: a nap késésgörbéje (élőben a mai, visszanézéskor a választott nap),
 * rajta húzható az időpont; alatta a rekordok és az összeomlások.
 */
export function TimePanel({ at, onAt }: { at: number | null; onAt: (t: number) => void }) {
  const now = nowUnix();
  const date = serviceDayOf(at ?? now);
  const range = serviceDayRange(date);
  const maxValue = Math.min(range.end - 1, now);
  const [day, setDay] = useState<{ date: string; data: FleetDay } | null>(null);
  const [tab, setTab] = useState<Tab>("records");
  const today = serviceDayOf(now);

  // a mai görbe élőben kétpercenként frissül; a lezárt nap gyorsítótárból jön
  useVisiblePoll(
    () => {
      fetchCached<FleetDay>(`/engine/fleet/day?date=${date}`, date < today ? 3600 : 110)
        .then((data) => setDay({ date, data }))
        .catch(() => {});
    },
    120_000,
    [date],
  );
  const curve = day?.date === date ? day.data : null;

  return (
    <div className="space-y-4">
      <section aria-label="A nap késésgörbéje" className="rounded-xl border border-border bg-card p-3">
        {curve ? (
          <DayCurve range={range} buckets={curve.buckets} breakdowns={curve.breakdowns} value={at ?? now} maxValue={maxValue} onScrub={onAt} />
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
      {tab === "records" ? <FleetRecords date={date} onJump={onAt} /> : <Breakdowns dayItems={curve?.breakdowns ?? null} at={at} onJump={onAt} />}
    </div>
  );
}
