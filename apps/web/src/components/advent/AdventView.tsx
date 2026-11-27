import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, Radio } from "lucide-react";
import { dayPlan, seasonOf, type AdventSeason } from "@mvk/core/advent/season";
import { shiftIso } from "@mvk/core/time";
import type { AdventIncident } from "@mvk/core/advent/day";
import type { LiveVehicle, Route } from "@/types";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { useAdventDay, useAdventMeta, useAdventSeason, useLineTrams, type SeasonMeta } from "./adventApi";
import { dowShort, hm, shortDate, VERDICT } from "./adventText";
import { AdventMap, type ReplayTarget } from "./AdventMap";
import type { ReplayRequest } from "./AdventReplay";
import { CatchPlanner } from "./CatchPlanner";
import { SeasonCalendar, SeasonSlots, SeasonStops, SeasonTotals } from "./SeasonParts";
import { StatusRow } from "./StatusRow";
import { DayCounters, DeparturePills, IncidentLog, TripList } from "./TodayParts";
import { WrappedStory, WrappedTeaser } from "./WrappedStory";

/**
 * Az adventi villamos: élőben hol jár és hogy áll, a nap minden menete és száma,
 * hol és mikor érhető el, és az évad (naptár, rekordok, megállók, Wrapped).
 * Telefonon egy görgetett oldal, széles kijelzőn három oszlop: Ma · térkép · Évad.
 */
export function AdventView({ routes }: { routes: Route[] }) {
  const { meta, failed } = useAdventMeta();
  const [date, setDate] = useState<string | null>(null);
  const year = meta?.current ?? null;
  const season = meta?.seasons.find((s) => s.year === year) ?? null;
  const { resp, failed: dayFailed } = useAdventDay(date);
  const seasonResp = useAdventSeason(year);
  const isAdvent = useMemo(() => {
    const ids = new Set(season?.vehicleIds ?? []);
    const shorts = new Set(season?.routeShorts ?? []);
    return (v: LiveVehicle) => ids.has(v.id) || shorts.has(v.routeShort);
  }, [season]);
  const { tram, others } = useLineTrams(isAdvent);
  const [stop, setStop] = useState<number | null>(null);
  const [openTrip, setOpenTrip] = useState<string | null>(null);
  const [story, setStory] = useState<"day" | "season" | null>(null);
  /** a mai nap visszanézése (múltbeli napon a térkép mindig visszajátszik) */
  const [todayReplay, setTodayReplay] = useState(false);
  const [replayReq, setReplayReq] = useState<ReplayRequest | null>(null);
  const mapRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  if (failed) return <Notice>Az adventi villamos adatai most nem érhetők el.</Notice>;
  if (!meta || !season) return <Skeleton />;

  const today = meta.today;
  const day = resp?.day ?? null;
  const live = date == null;
  const shown = date ?? today;
  const core = seasonOf(season.year);
  const before = today < season.start;
  const over = today > season.end;
  const dayNo = shown >= season.start && shown <= season.end ? Math.round((Date.parse(shown) - Date.parse(season.start)) / 86_400_000) + 1 : null;
  const totalDays = Math.round((Date.parse(season.end) - Date.parse(season.start)) / 86_400_000) + 1;
  const canPrev = shown > season.start;
  const canNext = shown < today && shown < season.end;
  const pickDate = (iso: string | null) => {
    setDate(iso);
    setOpenTrip(null);
    setReplayReq(null);
    setTodayReplay(false);
  };
  const step = (d: number) => {
    const next = shiftIso(shown, d);
    pickDate(next >= today ? null : next);
  };
  const replay: ReplayTarget | null = live ? (todayReplay ? { iso: today, today: true, request: replayReq } : null) : { iso: shown, today: false, request: replayReq };
  /** a térkép visszajátssza a napot `t`-től (telefonon a térkép a képbe gördül) */
  const watchFrom = (t: number) => {
    if (live) setTodayReplay(true);
    setReplayReq((r) => ({ t, play: true, n: (r?.n ?? 0) + 1 }));
    showMap();
  };
  /** egy oszlopban (telefon) a térkép a ragadós fejléc alá gördül, ha nem látszik egészen */
  const showMap = () => {
    const root = rootRef.current;
    const map = mapRef.current;
    if (!root || !map || getComputedStyle(root).overflowY !== "auto") return;
    const head = root.querySelector("header")?.offsetHeight ?? 0;
    const box = root.getBoundingClientRect();
    const r = map.getBoundingClientRect();
    if (r.top >= box.top + head && r.bottom <= box.bottom) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: root.scrollTop + r.top - box.top - head - 8, behavior: reduce ? "auto" : "smooth" });
  };
  const selectTrip = (key: string | null) => {
    setOpenTrip(key);
    const t = key ? day?.trips.find((x) => x.key === key) : null;
    const at = t ? (t.dep ?? t.sched.dep) : null;
    if (at != null && at < serverNow()) watchFrom(at - 60);
  };
  const selectIncident = (i: AdventIncident) => watchFrom(i.from - 60);
  const dayCards = resp?.cards ?? null;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:overflow-hidden">
      <header className="sticky top-0 z-bar flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-background/90 px-3 py-2 backdrop-blur-md sm:px-4 xl:static">
        <h2 className="flex items-baseline gap-2">
          <span className="text-[17px] font-extrabold tracking-tight">Adventi villamos</span>
          <span className="text-[12.5px] font-semibold text-advent-gold">
            {season.title} · {season.year}
          </span>
        </h2>
        <nav aria-label="Nap" className="ml-auto flex items-center gap-1">
          <IconBtn label="Előző nap" disabled={!canPrev} onClick={() => step(-1)}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </IconBtn>
          <span className="min-w-[7.5rem] text-center text-[13px] font-semibold tabular-nums">
            {live ? (
              <span className="inline-flex items-center gap-1.5 text-advent-gold">
                <Radio className="h-3.5 w-3.5" aria-hidden /> Ma, {shortDate(today)}
              </span>
            ) : (
              `${shortDate(shown)} ${dowShort(shown)}`
            )}
          </span>
          <IconBtn label="Következő nap" disabled={!canNext && !(!live && shown < today)} onClick={() => step(1)}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </IconBtn>
          {!live ? (
            <button
              type="button"
              onClick={() => pickDate(null)}
              className="ml-1 h-8 rounded-lg border border-advent-gold/50 px-2.5 text-[12px] font-bold text-advent-gold hover:bg-advent-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Élő
            </button>
          ) : null}
        </nav>
      </header>

      <div className="flex flex-col gap-4 px-3 py-3 sm:px-4 xl:grid xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(340px,0.95fr)_minmax(0,1.5fr)_minmax(340px,1fr)] xl:gap-4 xl:py-0">
        {/* Ma */}
        <div className="contents xl:flex xl:min-h-0 xl:flex-col xl:gap-4 xl:overflow-y-auto xl:overscroll-contain xl:py-3">
          <section className="order-1 xl:order-none" aria-label="Most">
            {live && before ? (
              <PreSeason season={season} core={core} today={today} />
            ) : day ? (
              live ? (
                <StatusRow day={day} season={season} />
              ) : (
                <PastHeader day={day} dayNo={dayNo} totalDays={totalDays} />
              )
            ) : dayFailed ? (
              <Notice>A nap adatai most nem jöttek le.</Notice>
            ) : (
              <div className="h-[86px] animate-pulse rounded-xl bg-muted/40" />
            )}
          </section>

          {day && day.trips.length ? (
            <section className="order-3 space-y-2 xl:order-none" aria-label="Indulások">
              <DeparturePills day={day} selected={openTrip} onSelect={selectTrip} />
              {day.trips.some((t) => t.leg != null) ? <DayCounters day={day} season={season} /> : null}
            </section>
          ) : null}

          {day && dayCards?.length && day.stats.doneTrips + day.stats.partialTrips > 0 ? (
            <section className="order-4 xl:order-none">
              <WrappedTeaser cards={dayCards} title={live && !day.closed ? "Mai összegző" : "A nap összegzője"} onOpen={() => setStory("day")} />
            </section>
          ) : null}

          {day && day.trips.length ? (
            <Section title="Menetek" className="order-6 xl:order-none">
              <TripList day={day} season={season} open={openTrip} onOpen={setOpenTrip} />
            </Section>
          ) : null}

          {day && day.verdict !== "future" && day.verdict !== "none" ? (
            <Section title="Zavarok" className="order-7 xl:order-none">
              <IncidentLog incidents={day.incidents} onSelect={selectIncident} />
            </Section>
          ) : null}
        </div>

        {/* Térkép és az Elkapó */}
        <div className="contents xl:flex xl:min-h-0 xl:flex-col xl:gap-3 xl:overflow-y-auto xl:overscroll-contain xl:py-3">
          <section ref={mapRef} className="order-2 overflow-hidden rounded-2xl border border-border bg-card xl:order-none" aria-label="Térkép">
            <AdventMap
              meta={meta}
              season={season}
              day={day}
              tram={live ? tram : null}
              others={live ? others : []}
              routes={routes}
              selectedStop={stop}
              onSelectStop={setStop}
              replay={replay}
              onReplay={live && !todayReplay && day?.legs.length ? () => setTodayReplay(true) : null}
              onLive={live && todayReplay ? () => pickDate(null) : null}
              className="h-[46svh] min-h-[300px] rounded-none border-0 xl:h-[62vh]"
            />
          </section>

          {live && day && !over ? (
            <Section title="Hol éred el?" className="order-5 xl:order-none">
              <CatchPlanner day={day} season={season} stop={stop} onStop={setStop} />
            </Section>
          ) : null}
        </div>

        {/* Évad */}
        <div className="contents xl:flex xl:min-h-0 xl:flex-col xl:gap-4 xl:overflow-y-auto xl:overscroll-contain xl:py-3">
          <Section title={`Az évad · ${dayNo && !before ? `${Math.min(dayNo, totalDays)}. nap a ${totalDays}-ből` : `${totalDays} nap`}`} className="order-8 xl:order-none">
            {seasonResp ? (
              <div className="space-y-3">
                <SeasonCalendar summary={seasonResp.summary} today={today} selected={date} onSelect={(iso) => pickDate(iso === today ? null : iso)} />
                {seasonResp.summary.totals.daysRun ? (
                  <WrappedTeaser cards={seasonResp.cards} title={over ? "Az évad összegzője" : "Az évad eddig"} onOpen={() => setStory("season")} />
                ) : null}
                <SeasonTotals summary={seasonResp.summary} season={season} onDay={(iso) => pickDate(iso === today ? null : iso)} />
              </div>
            ) : (
              <div className="h-64 animate-pulse rounded-xl bg-muted/40" />
            )}
          </Section>
          {seasonResp?.summary.slots.length ? (
            <Section title="Indulásonként" className="order-9 xl:order-none">
              <SeasonSlots summary={seasonResp.summary} />
            </Section>
          ) : null}
          {seasonResp?.summary.stops.length ? (
            <Section title="Megállónként" className="order-10 xl:order-none">
              <SeasonStops summary={seasonResp.summary} season={season} />
            </Section>
          ) : null}
        </div>
      </div>

      {story === "day" && dayCards ? (
        <WrappedStory
          cards={dayCards}
          title={`Adventi villamos · ${shortDate(shown)}`}
          subtitle={`${dayNo ? `${dayNo}. nap · ` : ""}${day?.dayType ?? ""}`}
          onClose={() => setStory(null)}
        />
      ) : null}
      {story === "season" && seasonResp ? (
        <WrappedStory cards={seasonResp.cards} title={`${season.title} ${season.year}`} subtitle={`${season.edition}. adventi villamos`} onClose={() => setStory(null)} />
      ) : null}
    </div>
  );
}

function Section({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn("space-y-2", className)}>
      <h3 className="text-[14px] font-bold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-border hover:bg-accent disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** a lezárt nap fejléce: az ítélet, hányadik nap, a naptípus */
function PastHeader({
  day,
  dayNo,
  totalDays,
}: {
  day: {
    verdict: keyof typeof VERDICT;
    dayType: string;
    note: string | null;
    stats: { doneTrips: number; plannedTrips: number };
  };
  dayNo: number | null;
  totalDays: number;
}) {
  const v = VERDICT[day.verdict];
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5", v.cell)}>
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", v.dot)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-extrabold leading-tight">{v.label}</span>
        <span className="block truncate text-[12px] opacity-80">
          {dayNo ? `${dayNo}. nap a ${totalDays}-ből · ` : ""}
          {day.dayType}
          {day.note ? ` · ${day.note}` : ""}
        </span>
      </span>
      <span className="font-mono text-[15px] font-bold tabular-nums">
        {day.stats.doneTrips}/{day.stats.plannedTrips}
      </span>
    </div>
  );
}

/** az évad előtt: mikor indul az első kör, és a nyitónap indulásai */
function PreSeason({ season, core, today }: { season: SeasonMeta; core: AdventSeason | null; today: string }) {
  const plan = core ? dayPlan(core, season.start) : null;
  const first = plan?.trips[0] ?? null;
  const days = Math.round((Date.parse(season.start) - Date.parse(today)) / 86_400_000);
  return (
    <div className="rounded-xl border border-advent-gold/40 bg-advent-navy px-3.5 py-3">
      <p className="text-[26px] font-extrabold leading-none tracking-tight text-advent-gold">{days === 1 ? "Holnap indul" : `${days} nap múlva`}</p>
      <p className="mt-1 text-[13px] text-advent-ink/80">
        {shortDate(season.start)} {first ? `${hm(first.dep)}, ${first.from === "tiszai" ? "Tiszai pályaudvar" : "Felső-Majláth"}` : ""} · {season.edition}. adventi villamos
      </p>
      {plan ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="A nyitónap indulásai">
          {plan.trips.map((t) => (
            <li key={t.dep} className="rounded-md border border-advent-gold/30 px-2 py-0.5 font-mono text-[12.5px] font-semibold tabular-nums text-advent-ink">
              {hm(t.dep)} {t.from === "tiszai" ? "Tiszai" : "Majláth"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
      <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="h-[86px] animate-pulse rounded-xl bg-muted/40" />
      <div className="h-[46svh] min-h-[300px] animate-pulse rounded-2xl bg-muted/40" />
    </div>
  );
}
