import { useCallback, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  formatServiceHour,
  serviceToday,
  shiftDate,
  statsV3,
  type HitCount,
  type PredictionOverviewData,
} from "@/services/statsApi";
import {
  BarChart,
  ChartFrame,
  EmptyChart,
  LineChart,
  RankBars,
  StatTile,
} from "@/components/charts/Charts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PillPicker, QueryBoundary } from "./PanelState";
import { PredictionTripList, RoutePill } from "./PredictionTripList";
import { useStatsQuery } from "./useStatsQuery";

const nf = new Intl.NumberFormat("hu-HU");
const RANGES = [
  { id: "1", label: "Ma" },
  { id: "7", label: "7 nap" },
  { id: "14", label: "14 nap" },
  { id: "30", label: "30 nap" },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const SIGNALS: Record<string, { label: string; sub: string }> = {
  chain: {
    label: "Forda-lánc",
    sub: "aki az előző menetet vitte, megy tovább",
  },
  turnaround: {
    label: "Forda-terv",
    sub: "a kint lévő buszok órákra előre végigvezetve",
  },
  terminal: {
    label: "Végállomáson vár",
    sub: "a menet indulási pontján álló busz",
  },
  slot: {
    label: "Megszokás",
    sub: "ki szokta vinni ezt a menetet ilyen napon",
  },
};

const pct = (c: HitCount) => (c.n ? Math.round((100 * c.hits) / c.n) : null);

/** a találati arány jelentése: jó / közepes / gyenge (zöld / borostyán / piros) */
const grade = (p: number | null) =>
  p == null ? "none" : p >= 85 ? "good" : p >= 65 ? "fair" : "poor";
// Teljes osztálynevek: a Tailwind csak a forrásban szó szerint szereplőket generálja.
const BAR_FILL = {
  good: "fill-ontime",
  fair: "fill-nosignal",
  poor: "fill-late",
  none: "fill-muted",
} as const;
const BAR_BG = {
  good: "bg-ontime/80",
  fair: "bg-nosignal/80",
  poor: "bg-late/80",
  none: "bg-muted",
} as const;
const TILE_TONE = {
  good: "ontime",
  fair: "default",
  poor: "late",
  none: "default",
} as const;

const pctLabel = (p: number | null) => (p == null ? "" : `${p}%`);

export function PredictionOverview() {
  const [range, setRange] = useState<RangeId>("14");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const to = serviceToday();
  const from = shiftDate(to, -(Number(range) - 1));
  const fetcher = useCallback(() => statsV3.predictions(from, to), [from, to]);
  const q = useStatsQuery<PredictionOverviewData>(fetcher, [from, to]);

  const pickVehicle = (id: string) => {
    setQuery(id);
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section aria-labelledby="prediction-heading" className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="prediction-heading"
            className="text-lg font-bold tracking-tight sm:text-xl"
          >
            Rendszám-jóslás
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Melyik busz viszi a még el nem indult menetet: a 30, 15 és 5 perccel
            előtte adott tippek, ahogy a menet indulásakor kiderült.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PillPicker<RangeId>
            ariaLabel="Időszak"
            value={range}
            onChange={setRange}
            items={RANGES.map((r) => ({ id: r.id, label: r.label }))}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={q.reload}
            disabled={q.loading}
            aria-label="Frissítés"
          >
            <RefreshCw className={q.loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </header>

      <QueryBoundary query={q}>
        {(d) => {
          const total = d.byHorizon.reduce(
            (a, h) => ({ n: a.n + h.n, hits: a.hits + h.hits }),
            { n: 0, hits: 0 },
          );
          if (!total.n) {
            return (
              <EmptyChart>
                Ebben az időszakban még nincs kiértékelt jóslat.
                {d.pendingToday
                  ? ` Ma ${nf.format(d.pendingToday)} tipp vár a menet indulására.`
                  : ""}
              </EmptyChart>
            );
          }
          return (
            <div className="space-y-4">
              <SummaryTiles d={d} total={total} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <CalibrationChart d={d} />
                <ChartFrame
                  title="Napi találati arány"
                  hint="Minden kiértékelt tipp, horizonttól függetlenül."
                >
                  <LineChart
                    unit="%"
                    data={d.daily.map((x) => ({
                      label: x.date.slice(5).replace("-", "."),
                      value: pct(x),
                    }))}
                  />
                </ChartFrame>
                <ChartFrame
                  title="Napszak szerint"
                  hint="A menet menetrendi indulásának órája."
                >
                  <BarChart
                    unit="%"
                    maxValue={100}
                    data={d.byHour.map((x) => {
                      const p = pct(x);
                      return {
                        label: formatServiceHour(x.hour),
                        value: p,
                        tone: BAR_FILL[grade(p)],
                        title: `${pctLabel(p)} talált · ${formatServiceHour(x.hour)} órakor · ${nf.format(x.n)} tipp`,
                      };
                    })}
                  />
                </ChartFrame>
                <SignalBreakdown d={d} />
              </div>
              <RouteBreakdown d={d} />
              <VehicleGrid d={d} onPick={pickVehicle} active={query} />
              <div ref={listRef} className="scroll-mt-4">
                <ChartFrame
                  title="Tippek menetenként"
                  hint={`A legutóbbi ${nf.format(d.trips.length)} kiértékelt menet. Az áthúzott rendszám a téves tipp.`}
                >
                  <PredictionTripList
                    trips={d.trips}
                    query={query}
                    onQueryChange={setQuery}
                    multiDay={range !== "1"}
                  />
                </ChartFrame>
              </div>
            </div>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

function SummaryTiles({
  d,
  total,
}: {
  d: PredictionOverviewData;
  total: HitCount;
}) {
  const all = pct(total);
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
      <StatTile
        label="Összes találat"
        value={pctLabel(all)}
        sub={`${nf.format(total.hits)} / ${nf.format(total.n)} tipp`}
        tone={TILE_TONE[grade(all)]}
      />
      {[30, 15, 5].map((h) => {
        const row = d.byHorizon.find((x) => x.horizon === h);
        const p = row ? pct(row) : null;
        return (
          <StatTile
            key={h}
            label={`${h} perccel előtte`}
            value={pctLabel(p)}
            sub={
              row
                ? `${nf.format(row.hits)} / ${nf.format(row.n)} · átl. ${Math.round(row.avg_conf * 100)}%-ot ígért`
                : "nincs tipp"
            }
            tone={TILE_TONE[grade(p)]}
          />
        );
      })}
      <StatTile
        label="Ma még nyitott"
        value={nf.format(d.pendingToday)}
        sub="tipp vár a menet indulására"
      />
    </div>
  );
}

/** Kalibráció: ha a rendszer X%-ot mond, tényleg X%-ban talál-e? */
function CalibrationChart({ d }: { d: PredictionOverviewData }) {
  const n = d.calibration.reduce((a, b) => a + b.n, 0);
  // Súlyozott eltérés a tényleges találat és az ígért bizonyosság között (százalékpont).
  const gap = n
    ? Math.round(
        (d.calibration.reduce((a, b) => a + (b.hits - b.avg_conf * b.n), 0) /
          n) *
          100,
      )
    : 0;
  const verdict =
    Math.abs(gap) <= 3
      ? "A bizonyosság pontosan azt jelenti, amit mond."
      : gap > 0
        ? `Szerényebb a valóságnál: átlagosan ${gap} százalékponttal többször talál, mint amit ígér.`
        : `Túl magabiztos: átlagosan ${-gap} százalékponttal ritkábban talál, mint amit ígér.`;
  return (
    <ChartFrame
      title="Mennyit ér a bizonyosság?"
      hint="Bizonyosság-sávonként a tényleges találati arány. A 80%-os tippnek kb. 80%-ban kell bejönnie."
    >
      <BarChart
        unit="%"
        maxValue={100}
        data={d.calibration.map((b) => {
          const p = pct(b);
          const honest = p != null && p >= b.avg_conf * 100 - 5;
          return {
            label: `${b.bucket * 10}%`,
            value: p,
            tone: honest ? "fill-ontime" : "fill-late",
            title: `${pctLabel(p)} talált · ${b.bucket * 10}–${b.bucket * 10 + 10}%-os tippeknél (átl. ${Math.round(b.avg_conf * 100)}%) · ${nf.format(b.n)} tipp`,
          };
        })}
      />
      <p className="mt-2 text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{verdict}</span> Zöld:
        legalább annyit talál, amennyit ígér; piros: kevesebbet.
      </p>
    </ChartFrame>
  );
}

function SignalBreakdown({ d }: { d: PredictionOverviewData }) {
  const ranked = [...d.signals].sort((a, b) => (pct(b) ?? 0) - (pct(a) ?? 0));
  const rows = ranked.map((s) => {
    const alone = pct(s);
    const decided = d.byMethod.find((m) => m.method === s.signal);
    const w = d.weights.find((x) => x.signal === s.signal);
    const meta = SIGNALS[s.signal] ?? { label: s.signal, sub: "" };
    const parts = [
      `egyedül ${nf.format(s.hits)}/${nf.format(s.n)}`,
      decided
        ? `döntött ${nf.format(decided.n)}× (${pctLabel(pct(decided))})`
        : null,
      w ? `tanult súly ${w.weight.toFixed(2).replace(".", ",")}` : null,
    ].filter(Boolean);
    return {
      label: meta.label,
      sub: `${meta.sub} · ${parts.join(" · ")}`,
      value: alone ?? 0,
      display: pctLabel(alone),
      barClass: BAR_BG[grade(alone)],
    };
  });
  return (
    <ChartFrame
      title="Melyik jelzés mennyire pontos"
      hint="Ha csak ez a jelzés döntött volna, milyen arányban lett volna igaza."
    >
      <RankBars rows={rows} />
    </ChartFrame>
  );
}

function RouteBreakdown({ d }: { d: PredictionOverviewData }) {
  const top = d.byRoute.slice(0, 16);
  return (
    <ChartFrame
      title="Vonalanként"
      hint={`A ${top.length} legtöbbet tippelt vonal (összesen ${d.byRoute.length}).`}
    >
      {top.length ? (
        <ol className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {top.map((r) => {
            const p = pct(r);
            return (
              <li
                key={r.route_short}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1"
              >
                <RoutePill
                  route={r.route_short}
                  color={r.color}
                  text={r.text_color}
                />
                <span className="truncate text-[11.5px] text-muted-foreground">
                  {nf.format(r.hits)} / {nf.format(r.n)} tipp
                </span>
                <span className="text-[12.5px] font-semibold tabular-nums">
                  {pctLabel(p)}
                </span>
                <div className="col-span-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", BAR_BG[grade(p)])}
                    style={{ width: `${p ?? 0}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyChart />
      )}
    </ChartFrame>
  );
}

const CHIP_TINT = {
  good: "border-ontime/40 bg-ontime/10 hover:bg-ontime/20",
  fair: "border-nosignal/40 bg-nosignal/10 hover:bg-nosignal/20",
  poor: "border-late/40 bg-late/10 hover:bg-late/20",
  none: "border-border bg-card hover:bg-accent",
} as const;

/** Minden rendszám egy csempe: hány menetét találtuk el, és hányszor tippeltük tévesen. */
function VehicleGrid({
  d,
  onPick,
  active,
}: {
  d: PredictionOverviewData;
  onPick: (id: string) => void;
  active: string;
}) {
  const carried = d.byVehicle.filter((v) => v.n > 0);
  const onlyWrong = d.byVehicle.filter((v) => v.n === 0);
  const perfect = carried.filter((v) => v.hits === v.n).length;
  return (
    <ChartFrame
      title="Rendszámok"
      hint={`${nf.format(carried.length)} busz menetét tippeltük; ${nf.format(perfect)} esetében minden tipp talált. Kattints egyre a menetei listájáért.`}
    >
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1.5">
        {carried.map((v) => {
          const p = pct(v);
          return (
            <li key={v.vehicle_id}>
              <button
                type="button"
                onClick={() => onPick(v.vehicle_id)}
                aria-pressed={active === v.vehicle_id}
                title={`${v.vehicle_id}: ${v.n} menetéből ${v.hits}-t eltaláltunk${v.wrong_picks ? `, ${v.wrong_picks}× tévesen tippeltük rá más menetére` : ""}`}
                className={cn(
                  "flex w-full flex-col items-start rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  CHIP_TINT[grade(p)],
                  active === v.vehicle_id && "ring-2 ring-foreground/60",
                )}
              >
                <span className="font-mono text-[12.5px] font-bold tabular-nums leading-none">
                  {v.vehicle_id}
                </span>
                <span className="mt-1 text-[10.5px] tabular-nums text-muted-foreground">
                  {v.hits}/{v.n}
                  {v.wrong_picks ? (
                    <span className="text-late">
                      {" "}
                      · {v.wrong_picks}× tévesen
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {onlyWrong.length ? (
        <p className="mt-3 text-[11.5px] text-muted-foreground">
          Csak téves tippben szerepelt:{" "}
          {onlyWrong
            .map((v) => `${v.vehicle_id} (${v.wrong_picks}×)`)
            .join(", ")}
        </p>
      ) : null}
    </ChartFrame>
  );
}
