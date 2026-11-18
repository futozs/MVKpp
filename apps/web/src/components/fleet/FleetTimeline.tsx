import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, History, LoaderCircle, Radio, SearchX, TramFront, Bus } from "lucide-react";
import type { Breakdown, FleetDay } from "@mvk/core";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { addDays, formatClockShort, formatDayLabel, serviceDayOf, serviceDayRange } from "@/components/map/historyTime";
import { API_BASE } from "@/lib/apiBase";
import { cn } from "@/lib/utils";
import { DayCurve } from "./DayCurve";
import { minutesText } from "./fleetText";

type Found = Breakdown & { date: string };
type FoundPage = { items: Found[]; next: string | null; firstDay: string | null };

const STEPS = [-15, -5, -1, 1, 5, 15];
/** ennyi napot néz át egy keresés a szerveren */
const SEARCH_DAYS = 31;
/** a „legutóbbi összeomlás” legfeljebb ennyi lapot (× 31 nap) keres visszafelé */
const SEARCH_PAGES = 6;

const nowUnix = () => Math.floor(Date.now() / 1000);

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function breakdownText(b: Breakdown): string {
  const n = b.kind === "tram" ? `${b.vehicles} villamos késett 10+ percet` : `${b.vehicles} busz késett 5+ percet`;
  return `${n}${b.maxDelayS != null && b.maxDelayS >= 60 ? `, a legtöbb ${minutesText(b.maxDelayS)}` : ""}`;
}

/**
 * Élő ↔ visszanézés. Visszanézéskor a nap késésgörbéjén húzható az időpont,
 * a nap összeomlásaira és a korábbiakra egy koppintással lehet ugrani.
 */
export function FleetTimeline({ at, onAt, onLive, loading }: { at: number | null; onAt: (t: number) => void; onLive: () => void; loading: boolean }) {
  if (at == null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-9 items-center gap-2 rounded-lg border border-live/30 bg-live/10 px-3 text-xs font-bold text-live">
          <Radio className="h-3.5 w-3.5" aria-hidden /> Élő
        </span>
        <Button variant="outline" size="sm" className="h-9" onClick={() => onAt(nowUnix() - 60)}>
          <History />
          Visszanézés
        </Button>
        <LatestBreakdownButton onJump={onAt} className="max-[420px]:w-full sm:ml-auto" />
      </div>
    );
  }
  return <HistoryBar at={at} onAt={onAt} onLive={onLive} loading={loading} />;
}

function HistoryBar({ at, onAt, onLive, loading }: { at: number; onAt: (t: number) => void; onLive: () => void; loading: boolean }) {
  const date = serviceDayOf(at);
  const range = serviceDayRange(date);
  const now = nowUnix();
  const today = serviceDayOf(now);
  const maxValue = Math.min(range.end - 1, now);
  const [day, setDay] = useState<FleetDay | null>(null);
  const [firstDay, setFirstDay] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setDay(null);
    getJson<FleetDay>(`${API_BASE}/engine/fleet/day?date=${date}`, ctl.signal)
      .then(setDay)
      .catch(() => {});
    return () => ctl.abort();
  }, [date]);

  // ugyanarra az órára a másik napon (a jövőbe nem)
  const goDay = (d: string) => onAt(Math.min(nowUnix(), serviceDayRange(d).start + (at - range.start)));

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-9" onClick={onLive}>
          <Radio />
          Vissza élőre
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Előző nap" disabled={Boolean(firstDay && date <= firstDay)} onClick={() => goDay(addDays(date, -1))}>
            <ChevronLeft />
          </Button>
          <DateField value={date} onChange={goDay} max={today} min={firstDay} today={today} aria-label="Nap" className="h-9 w-[10.5rem]" />
          <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Következő nap" disabled={date >= today} onClick={() => goDay(addDays(date, 1))}>
            <ChevronRight />
          </Button>
        </div>
        <p className="ml-auto flex items-center gap-2 text-[22px] font-extrabold leading-none tracking-tight tabular-nums" aria-live="polite">
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Betöltés" /> : null}
          {formatClockShort(at)}
        </p>
      </div>

      {day ? (
        <DayCurve range={range} buckets={day.buckets} breakdowns={day.breakdowns} value={at} maxValue={maxValue} onScrub={onAt} />
      ) : (
        <div className="h-[118px] animate-pulse rounded-lg bg-muted/40" aria-label="A nap görbéjének betöltése" />
      )}

      <div className="grid grid-cols-6 gap-1" role="group" aria-label="Léptetés">
        {STEPS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onAt(Math.max(range.start, Math.min(maxValue, at + m * 60)))}
            className="h-8 whitespace-nowrap rounded-md border border-border px-2 text-xs font-semibold tabular-nums text-muted-foreground transition-colors duration-fast hover:border-muted-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {m > 0 ? `+${m}` : `−${-m}`} p
          </button>
        ))}
      </div>

      {day?.breakdowns.length ? (
        <div>
          <p className="text-[12px] font-bold">Ezen a napon</p>
          <ul className="mt-1.5 space-y-1">
            {day.breakdowns.map((b) => (
              <li key={`${b.kind}-${b.start}`}>
                <BreakdownButton b={b} onJump={onAt} active={at >= b.start && at < b.end} />
              </li>
            ))}
          </ul>
        </div>
      ) : day ? (
        <p className="text-[12px] text-muted-foreground">Ezen a napon nem omlott össze sem a villamos, sem a buszhálózat.</p>
      ) : null}

      <PastBreakdowns onJump={onAt} onFirstDay={setFirstDay} skipDate={date} />
    </div>
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
        "flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-late/60 bg-late/10" : "border-border hover:border-muted-foreground/50",
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", b.kind === "tram" ? "text-late" : "text-nosignal")} aria-hidden />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold tabular-nums">
          {withDate && b.date ? `${formatDayLabel(b.date, true)} · ` : ""}
          {formatClockShort(b.start)}–{formatClockShort(b.end)} · {b.kind === "tram" ? "villamos-összeomlás" : "beállt a buszhálózat"}
        </span>
        <span className="block text-[11.5px] text-muted-foreground">{breakdownText(b)}</span>
      </span>
    </button>
  );
}

/** A korábbi összeomlások visszafelé, lapozva (31 naponként). */
function PastBreakdowns({ onJump, onFirstDay, skipDate }: { onJump: (t: number) => void; onFirstDay: (d: string | null) => void; skipDate: string }) {
  const [items, setItems] = useState<Found[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = (before: string | null, signal?: AbortSignal) => {
    setBusy(true);
    getJson<FoundPage>(`${API_BASE}/engine/fleet/breakdowns?days=${SEARCH_DAYS}&limit=20${before ? `&before=${before}` : ""}`, signal)
      .then((p) => {
        // az első lap felülír, a további lapok hozzáfűződnek
        setItems((prev) => (before ? [...prev, ...p.items] : p.items));
        setNext(p.next);
        onFirstDay(p.firstDay);
        setFailed(false);
      })
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      })
      .finally(() => {
        if (!signal?.aborted) setBusy(false);
      });
  };
  useEffect(() => {
    const ctl = new AbortController();
    load(null, ctl.signal);
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a nézett nap összeomlásai fent, az „Ezen a napon” alatt vannak
  const shown = items.filter((b) => b.date !== skipDate);

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        Korábbi összeomlások
        {shown.length ? <span className="font-mono text-late">{shown.length}{next ? "+" : ""}</span> : null}
        <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform duration-fast group-open:rotate-180" aria-hidden />
      </summary>
      {shown.length ? (
        <ul className="mt-1.5 space-y-1">
          {shown.map((b) => (
            <li key={`${b.date}-${b.kind}-${b.start}`}>
              <BreakdownButton b={b} onJump={onJump} withDate />
            </li>
          ))}
        </ul>
      ) : !busy ? (
        <p className="mt-1 text-[12px] text-muted-foreground">{failed ? "A keresés most nem sikerült." : "Más napon nem találtam összeomlást."}</p>
      ) : null}
      {next !== null ? (
        <Button variant="outline" size="sm" className="mt-2 h-9 w-full" disabled={busy} onClick={() => load(next ?? null)}>
          {busy ? <LoaderCircle className="animate-spin" /> : <History />}
          {busy ? "Keresés…" : next ? `Régebbiek (${formatDayLabel(next, true)} előtt)` : "Keresés"}
        </Button>
      ) : (
        <p className="mt-2 text-[11.5px] text-muted-foreground">Eddig tart az adat.</p>
      )}
    </details>
  );
}

/** Ugrás a legutóbbi villamos-összeomlás csúcsára (visszafelé keres, amíg talál vagy fogy az adat). */
function LatestBreakdownButton({ onJump, className }: { onJump: (t: number) => void; className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "none">("idle");
  const search = async () => {
    setState("busy");
    let before: string | null = null;
    for (let i = 0; i < SEARCH_PAGES; i++) {
      const page: FoundPage | null = await getJson<FoundPage>(`${API_BASE}/engine/fleet/breakdowns?kind=tram&limit=1&days=${SEARCH_DAYS}${before ? `&before=${before}` : ""}`).catch(() => null);
      const hit = page?.items[0];
      if (hit) {
        setState("idle");
        onJump(hit.peak);
        return;
      }
      if (!page?.next) break;
      before = page.next;
    }
    setState("none");
  };
  return (
    <Button variant="outline" size="sm" className={cn("h-9", className)} disabled={state === "busy"} onClick={search} title="Ugrás a legutóbbi villamos-összeomlás legrosszabb pillanatára">
      {state === "busy" ? <LoaderCircle className="animate-spin" /> : state === "none" ? <SearchX /> : <TramFront />}
      {state === "none" ? "Nem találtam villamos-összeomlást" : "Legutóbbi villamos-összeomlás"}
    </Button>
  );
}
