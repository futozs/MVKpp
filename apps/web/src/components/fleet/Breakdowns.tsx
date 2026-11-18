import { useEffect, useState } from "react";
import { Bus, History, LoaderCircle, SearchX, TramFront } from "lucide-react";
import type { Breakdown } from "@mvk/core";
import { Button } from "@/components/ui/button";
import { formatClockShort, formatDayLabel } from "@/components/map/historyTime";
import { cn } from "@/lib/utils";
import { fetchCached } from "./fleetCache";
import { minShort } from "./fleetText";

type Found = Breakdown & { date: string };
type FoundPage = { items: Found[]; next: string | null; firstDay: string | null };

/** ennyi napot néz át egy keresés a szerveren */
const SEARCH_DAYS = 31;
/** a „legutóbbi összeomlás” legfeljebb ennyi lapot (× 31 nap) keres visszafelé */
const SEARCH_PAGES = 6;
const LIST_TTL_S = 300;

const page = (q: string) => fetchCached<FoundPage>(`/engine/fleet/breakdowns?${q}`, LIST_TTL_S);

/** Ugrás a legutóbbi villamos-összeomlás csúcsára (visszafelé keres, amíg talál vagy fogy az adat). */
export function LatestBreakdownButton({ onJump, className }: { onJump: (t: number) => void; className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "none">("idle");
  const search = async () => {
    setState("busy");
    let before: string | null = null;
    for (let i = 0; i < SEARCH_PAGES; i++) {
      const p: FoundPage | null = await page(`kind=tram&limit=1&days=${SEARCH_DAYS}${before ? `&before=${before}` : ""}`).catch(() => null);
      const hit = p?.items[0];
      if (hit) {
        setState("idle");
        onJump(hit.peak);
        return;
      }
      if (!p?.next) break;
      before = p.next;
    }
    setState("none");
  };
  return (
    <Button variant="outline" size="sm" className={cn("h-9", className)} disabled={state === "busy"} onClick={search} title="Ugrás a legutóbbi villamos-összeomlás legrosszabb pillanatára">
      {state === "busy" ? <LoaderCircle className="animate-spin" /> : state === "none" ? <SearchX /> : <TramFront />}
      {state === "none" ? "Nincs villamos-összeomlás" : "Legutóbbi villamos-összeomlás"}
    </Button>
  );
}

function BreakdownButton({ b, onJump, active, withDate }: { b: Breakdown & { date?: string }; onJump: (t: number) => void; active?: boolean; withDate?: boolean }) {
  const Icon = b.kind === "tram" ? TramFront : Bus;
  return (
    <button
      type="button"
      onClick={() => onJump(b.peak)}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-late/60 bg-late/10" : "border-border hover:border-muted-foreground/50",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", b.kind === "tram" ? "text-late" : "text-nosignal")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold tabular-nums">
          {withDate && b.date ? `${formatDayLabel(b.date, true)} · ` : ""}
          {formatClockShort(b.start)}–{formatClockShort(b.end)}
        </span>
        <span className="block truncate text-[11.5px] text-muted-foreground">
          {b.kind === "tram" ? `${b.vehicles} villamos 10+ percet késett` : `${b.vehicles} busz 5+ percet késett`}
        </span>
      </span>
      {b.maxDelayS != null && b.maxDelayS >= 60 ? <span className="shrink-0 text-[13px] font-extrabold tabular-nums text-late">{minShort(b.maxDelayS)}</span> : null}
    </button>
  );
}

/** A nap összeomlásai, és a korábbiak visszafelé lapozva. */
export function Breakdowns({ dayItems, at, onJump }: { dayItems: Breakdown[] | null; at: number | null; onJump: (t: number) => void }) {
  const [items, setItems] = useState<Found[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = (before: string | null) => {
    setBusy(true);
    page(`days=${SEARCH_DAYS}&limit=20${before ? `&before=${before}` : ""}`)
      .then((p) => {
        // az első lap felülír, a további lapok hozzáfűződnek
        setItems((prev) => (before ? [...prev, ...p.items] : p.items));
        setNext(p.next);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(null), []);

  return (
    <div className="space-y-4">
      <LatestBreakdownButton onJump={onJump} className="w-full" />
      {dayItems ? (
        <div>
          <h3 className="text-[12px] font-bold text-muted-foreground">Ezen a napon</h3>
          {dayItems.length ? (
            <ul className="mt-1.5 space-y-1">
              {dayItems.map((b) => (
                <li key={`${b.kind}-${b.start}`}>
                  <BreakdownButton b={b} onJump={onJump} active={at != null && at >= b.start && at < b.end} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[12px] text-muted-foreground">Nem volt összeomlás.</p>
          )}
        </div>
      ) : null}
      <div>
        <h3 className="text-[12px] font-bold text-muted-foreground">Korábban</h3>
        {items.length ? (
          <ul className="mt-1.5 space-y-1">
            {items.map((b) => (
              <li key={`${b.date}-${b.kind}-${b.start}`}>
                <BreakdownButton b={b} onJump={onJump} withDate active={at != null && at >= b.start && at < b.end} />
              </li>
            ))}
          </ul>
        ) : !busy ? (
          <p className="mt-1 text-[12px] text-muted-foreground">{failed ? "A keresés most nem sikerült." : "Az átnézett napokon nem volt összeomlás."}</p>
        ) : null}
        {next !== null ? (
          <Button variant="outline" size="sm" className="mt-2 h-9 w-full" disabled={busy} onClick={() => load(next ?? null)}>
            {busy ? <LoaderCircle className="animate-spin" /> : <History />}
            {busy ? "Keresés…" : next ? `Régebbiek (${formatDayLabel(next, true)} előtt)` : "Keresés"}
          </Button>
        ) : (
          <p className="mt-2 text-[11.5px] text-muted-foreground">Eddig tart az adat.</p>
        )}
      </div>
    </div>
  );
}
