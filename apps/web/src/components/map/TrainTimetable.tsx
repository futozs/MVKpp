import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { ChevronDown, ListOrdered, RefreshCw } from "lucide-react";
import type { TrainDetailResponse, TrainStop } from "@/types";
import { api } from "@/services/api";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import { delayTone } from "@/components/transit/DelayBar";
import { NoticeList, PlatformBadge } from "@/components/transit/RegionalBits";
import { hmOf } from "@/components/transit/TripInsights";
import { describeApiError, type FriendlyError } from "@/lib/apiError";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;
/** ennél nagyobb eltérésnél az élő idő is látszik a menetrendi mellett */
const LIVE_SHOWN_S = 60;
/** telefonon összecsukva: az utolsó elhagyott és a következő két állomás */
const COMPACT_BEFORE = 1;
const COMPACT_AFTER = 2;

type Loaded = { tripId: string; res: TrainDetailResponse };

/**
 * A térképen követett vonat menetrendje: minden állomás menetrendi és várható
 * idővel, vágánnyal, a már elhagyottak halványan, a következő kiemelve, és a MÁV
 * megjegyzései (késés oka). Asztalon a követés-kártya fölött a jobb oldali
 * oszlopban teljes hosszában, telefonon a kártya fölött összecsukva (lenyitható).
 */
export function TrainTimetable({ tripId, className }: { tripId: string; className?: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [expanded, setExpanded] = useState(false);
  const current = useRef(tripId);
  current.current = tripId;

  useVisiblePoll(
    () => {
      api
        .getTrainTrip(tripId)
        .then((res) => {
          // egy lassan visszaérő, előző vonatra szóló válasz ne írja felül az újat
          if (current.current !== tripId) return;
          setLoaded({ tripId, res });
          setError(null);
        })
        .catch((e) => current.current === tripId && setError(describeApiError(e)));
    },
    POLL_MS,
    [tripId],
  );

  const data = loaded?.tripId === tripId ? loaded.res : null;
  const stops = data?.found ? (data.stops ?? []) : [];
  const nextIdx = stops.findIndex((s) => !s.passed);
  const arrived = stops.length > 0 && nextIdx < 0;
  const notices = data?.notices?.map((n) => n.text);

  const listRef = useStopScroll(stops.length, nextIdx, expanded);

  if (!data && !error) {
    return (
      <Shell className={className}>
        <p className="px-4 py-5 text-center font-mono text-xs text-muted-foreground">A menetrend betöltése…</p>
      </Shell>
    );
  }
  if (data && !data.found) return null;

  const from = arrived ? stops.length - 1 - COMPACT_BEFORE : Math.max(0, nextIdx - COMPACT_BEFORE);
  const inCompact = (i: number) => (arrived ? i >= from : i >= from && i <= nextIdx + COMPACT_AFTER);
  const hiddenCount = stops.length - stops.filter((_, i) => inCompact(i)).length;

  return (
    <Shell className={className}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <ListOrdered aria-hidden className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Menetrend</h2>
        {stops.length ? <span className="text-[11px] text-muted-foreground">{stops.length} állomás</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {data?.cancelled ? (
            <span className="rounded-md border border-destructive/50 bg-destructive/12 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive">Törölve</span>
          ) : null}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              aria-expanded={expanded}
              className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-semibold text-primary hover:bg-primary/10 md:hidden"
            >
              {expanded ? "Kevesebb" : "Mind"}
              <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
            </button>
          ) : null}
        </span>
      </header>

      {error ? (
        <p role="status" className="flex items-center gap-2 border-b border-border bg-late/10 px-4 py-1.5 text-[11px]">
          <RefreshCw aria-hidden className="h-3 w-3 shrink-0 text-late motion-safe:animate-spin" />
          <span className="min-w-0 truncate text-muted-foreground">
            <span className="font-semibold text-foreground">Hiba, újrapróbálom…</span> {error.reason}
          </span>
        </p>
      ) : null}

      {notices?.length ? (
        <div className="border-b border-border px-4 py-2">
          <NoticeList notices={notices} compact={!expanded} className="md:hidden" />
          <NoticeList notices={notices} className="hidden md:block" />
        </div>
      ) : null}

      {stops.length ? (
        <ol
          ref={listRef}
          aria-label="A vonat állomásai"
          className={cn("relative min-h-0 overflow-y-auto overscroll-contain py-1 md:flex-1", expanded && "max-h-[34dvh] md:max-h-none")}
        >
          {stops.map((s, i) => (
            <StopRow
              key={`${s.id}-${i}`}
              stop={s}
              index={i}
              last={stops.length - 1}
              next={nextIdx}
              className={cn(!expanded && !inCompact(i) && "hidden md:flex")}
            />
          ))}
        </ol>
      ) : null}
    </Shell>
  );
}

function Shell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section
      aria-label="A követett vonat menetrendje"
      className={cn("flex min-h-0 flex-col overflow-hidden border-t border-border bg-card shadow-xl md:rounded-xl md:border", className)}
    >
      {children}
    </section>
  );
}

/**
 * Egy állomás sora: idő, a menet vonala pöttyel, név, vágány. A vonal az elhagyott
 * szakaszokon telt, a mostanin (az utolsó elhagyott és a következő között) félig.
 */
function StopRow({ stop: s, index: i, last, next, className }: { stop: TrainStop; index: number; last: number; next: number; className?: string }) {
  const isNext = i === next;
  const passed = s.passed;
  const terminus = i === last;
  const sched = terminus ? s.schedArr : s.schedDep;
  const liveUnix = terminus ? s.arrUnix : s.depUnix;
  const showLive = !passed && s.delaySec != null && Math.abs(s.delaySec) >= LIVE_SHOWN_S;
  const dwell = i > 0 && !terminus && s.schedArr !== s.schedDep;
  // a bejövő szakasz: elhagyott állomásig telt, a következőig (ott jár most) félig
  const inDone = i > 0 && (passed || isNext);
  const outDone = !terminus && passed;

  return (
    <li data-idx={i} className={cn("relative flex items-stretch gap-3 px-4", className)} aria-current={isNext ? "step" : undefined}>
      <span className="flex w-[42px] shrink-0 flex-col items-end justify-center py-1.5 font-mono text-[11.5px] leading-tight tabular-nums">
        <span className={cn(passed ? "text-muted-foreground" : "font-semibold", showLive && "text-muted-foreground line-through decoration-1")}>{sched}</span>
        {showLive ? <span className={cn("font-bold", delayTone(s.delaySec))}>{hmOf(liveUnix)}</span> : null}
      </span>

      <span aria-hidden className="relative flex w-3 shrink-0 justify-center">
        {i > 0 ? <span className={cn("absolute left-1/2 top-0 h-1/2 w-0.5 -translate-x-1/2", inDone ? (isNext ? "bg-gradient-to-b from-primary to-primary/25" : "bg-primary") : "bg-border")} /> : null}
        {!terminus ? <span className={cn("absolute bottom-0 left-1/2 h-1/2 w-0.5 -translate-x-1/2", outDone ? "bg-primary" : "bg-border")} /> : null}
        <span className="relative my-auto flex h-3 w-3 items-center justify-center">
          {isNext ? <span className="absolute inline-flex h-full w-full rounded-full bg-primary/40 motion-safe:animate-ping" /> : null}
          <span
            className={cn(
              "relative rounded-full",
              isNext ? "h-3 w-3 border-2 border-card bg-primary ring-2 ring-primary" : passed ? "h-2 w-2 bg-primary/70" : "h-2.5 w-2.5 border-2 border-muted-foreground/45 bg-card",
              (i === 0 || terminus) && !isNext && "rounded-[3px]",
            )}
          />
        </span>
      </span>

      <span className="flex min-w-0 flex-1 flex-col justify-center py-1.5">
        <span className={cn("truncate text-[12.5px]", isNext ? "font-bold" : passed ? "text-muted-foreground" : "font-medium")} title={s.name}>
          {s.name}
        </span>
        {isNext || dwell ? (
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            {isNext ? <span className="font-semibold uppercase tracking-wide text-primary">{i === 0 ? "Indul" : "Következő"}</span> : null}
            {dwell ? <span className="font-mono tabular-nums">érk. {s.schedArr}</span> : null}
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center">
        <PlatformBadge platform={s.platform} changed={s.platformChanged} predicted={s.platformPredicted} mode="rail" compact />
      </span>
    </li>
  );
}

/**
 * Az állomáslista görgetése: betöltéskor és amikor a vonat elhagy egy állomást,
 * az utolsó elhagyott kerül felülre (a kézi görgetést a következő állomásig nem bántja).
 */
function useStopScroll(count: number, nextIdx: number, expanded: boolean) {
  const ref = useRef<HTMLOListElement>(null);
  const reduce = useReducedMotion();
  const first = useRef(true);
  useEffect(() => {
    const list = ref.current;
    if (!list || !count) return;
    const target = nextIdx < 0 ? count - 1 : Math.max(0, nextIdx - 1);
    const row = list.querySelector<HTMLElement>(`[data-idx="${target}"]`);
    if (!row) return;
    list.scrollTo({ top: Math.max(0, row.offsetTop - 4), behavior: first.current || reduce ? "auto" : "smooth" });
    first.current = false;
  }, [count, nextIdx, expanded, reduce]);
  return ref;
}
