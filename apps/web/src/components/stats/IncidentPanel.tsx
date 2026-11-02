import { useCallback, useMemo, useState } from "react";
import { ArrowRight, BadgeCheck, Ban, CircleAlert, Radar } from "lucide-react";
import { serviceToday, shiftDate, statsV3, type IncidentV3 } from "@/services/statsApi";
import { BarChart, ChartFrame, StatTile } from "@/components/charts/Charts";
import { RouteTile } from "@/components/transit/RouteTile";
import { cn } from "@/lib/utils";
import { QueryBoundary, PillPicker } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";
import { useLiveIncidentDetails } from "@/hooks/useLiveIncidents";
import type { Route } from "@/types";

const RANGES = [
  { id: "7", label: "7 nap" },
  { id: "14", label: "14 nap" },
  { id: "30", label: "30 nap" },
] as const;

const KINDS = [
  { id: "all", label: "Mind" },
  { id: "cancelled", label: "MVK-törlés" },
  { id: "breakdown", label: "Megállt menet" },
  { id: "missed", label: "Kimaradt" },
] as const;

const KIND_META: Record<IncidentV3["kind"], { label: string; icon: typeof Ban; tone: string }> = {
  cancelled: { label: "Az MVK törölte", icon: Ban, tone: "text-destructive" },
  missed: { label: "Valószínűleg kimaradt", icon: CircleAlert, tone: "text-late" },
  breakdown: { label: "Menet közben megállt", icon: Radar, tone: "text-late" },
  long_stop: { label: "Hosszú állás", icon: CircleAlert, tone: "text-muted-foreground" },
  detour: { label: "Terelés", icon: CircleAlert, tone: "text-muted-foreground" },
};

const fmtTime = (unix: number) => new Date(unix * 1000).toLocaleTimeString("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });

/**
 * Üzemzavarok — két, élesen elválasztott forrás:
 *  · hivatalos: az MVK saját törlési listája (biztos adat)
 *  · észlelt: menet közben elnémuló jármű, amely 30+ percig nem jelentkezett,
 *    és NEM ismert térerő-hiányos szakaszon — bizonyítékkal és megbízhatósággal.
 * A v2 itt minden félbeszakadt menetet meghibásodásnak mutatott.
 */
/**
 * Most élőben: a valószínűleg kimaradó menetek (ezeket számolja a fejléc piros
 * jelvénye) és az MVK mai hivatalos törléseinek száma.
 */
function LiveIncidentsCard({ routes, onOpenDisruptions }: { routes: Route[]; onOpenDisruptions?: () => void }) {
  const live = useLiveIncidentDetails();
  if (!live) return null;
  const byShort = new Map(routes.map((r) => [r.short, r]));
  return (
    <section className={cn("rounded-2xl border p-4 sm:p-5", live.missing.length ? "border-late/40 bg-late/[0.06]" : "border-border bg-card")}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className={cn("h-2 w-2 rounded-full", live.missing.length ? "bg-late motion-safe:animate-live-pulse" : "bg-ontime")} />
            Most élőben
          </h3>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {live.missing.length
              ? "Ezek a menetek 15–90 perce esedékesek, egyetlen busz sem kezdte el őket, és késő busz sem tart feléjük, pedig a vonal szomszédos meneteit látjuk. Nem számoljuk az „igény esetén” járatokat, a garázsból kiálló meneteket (alattuk a fedélzeti egység gyakran még nem küld adatot), és azt sem, amelyiket a busz láthatóan levitt, csak adat nélkül."
              : "Most nincs valószínűleg kimaradó menet."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-1 text-[11.5px] text-muted-foreground">
            Ma <span className="font-semibold text-foreground">{live.cancelled}</span> hivatalos MVK-törlés
          </span>
          {onOpenDisruptions ? (
            <button
              type="button"
              onClick={onOpenDisruptions}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11.5px] font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Mi marad ki, mi jön helyette
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      {live.missing.length ? (
        <ul className="mt-3 divide-y divide-border/60">
          {live.missing.map((m) => {
            const r = byShort.get(m.route);
            return (
              <li key={m.tripId} className="flex items-center gap-3 py-2">
                <RouteTile short={m.route} color={r?.color} text={r?.text} />
                <span className="font-mono text-sm font-semibold tabular-nums">{m.time}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{m.headsign}</span>
                <span className="shrink-0 text-[12px] font-semibold text-late">{m.lateMin} perce esedékes</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function IncidentPanel({ routes = [], onOpenDisruptions }: { routes?: Route[]; onOpenDisruptions?: () => void }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("14");
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const to = serviceToday();
  const from = shiftDate(to, -(Number(range) - 1));

  const q = useStatsQuery(
    useCallback(() => statsV3.incidents(from, to, kind === "all" ? undefined : kind, 50), [from, to, kind]),
    [from, to, kind],
  );

  return (
    <div className="space-y-4">
      <LiveIncidentsCard routes={routes} onOpenDisruptions={onOpenDisruptions} />
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">Üzemzavarok</h2>
        <p className="max-w-3xl text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Hivatalos</span>: az MVK által törölt menetek.{" "}
          <span className="font-semibold text-foreground">Észlelt</span>: a jármű menet közben elnémult, legalább 30 percig nem jelentkezett,
          és a hely nem ismert térerő-hiányos szakasz. Csak lezárt napra számoljuk, a mai nap csak a hivatalos törléseket mutatja.
        </p>
        <div className="flex flex-wrap gap-2">
          <PillPicker ariaLabel="Időszak" value={range} onChange={(v) => setRange(v as typeof range)} items={RANGES.map((r) => ({ id: r.id, label: r.label }))} />
          <PillPicker ariaLabel="Típus" value={kind} onChange={(v) => setKind(v as typeof kind)} items={KINDS.map((k) => ({ id: k.id, label: k.label }))} />
        </div>
      </div>

      <QueryBoundary query={q} empty={(d) => d.incidents.length === 0}>
        {(d) => <IncidentBody data={d} from={from} to={to} />}
      </QueryBoundary>
    </div>
  );
}

function IncidentBody({ data, from, to }: { data: { incidents: IncidentV3[]; byDay: { service_date: string; kind: string; n: number }[] }; from: string; to: string }) {
  const stats = useMemo(() => {
    const cancelled = data.incidents.filter((i) => i.kind === "cancelled").length;
    const detected = data.incidents.filter((i) => i.source === "detected").length;
    const byRoute = new Map<string, number>();
    for (const i of data.incidents) if (i.route_short) byRoute.set(i.route_short, (byRoute.get(i.route_short) ?? 0) + 1);
    const top = [...byRoute.entries()].sort((a, b) => b[1] - a[1])[0];
    const days: { label: string; value: number; title: string }[] = [];
    for (let dd = from; dd <= to; dd = shiftDate(dd, 1)) {
      const n = data.byDay.filter((x) => x.service_date === dd).reduce((a, x) => a + x.n, 0);
      days.push({ label: dd.slice(8), value: n, title: `${dd}: ${n} esemény` });
    }
    return { cancelled, detected, top, days };
  }, [data, from, to]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
        <StatTile label="Törölt menet (MVK)" value={stats.cancelled} sub="hivatalos adat" tone="late" />
        <StatTile label="Észlelt megállás" value={stats.detected} sub="bizonyítékkal, ≥50% megbízhatóság" />
        <StatTile label="Leginkább érintett vonal" value={stats.top ? stats.top[0] : "—"} sub={stats.top ? `${stats.top[1]} esemény` : undefined} />
      </div>

      <ChartFrame title="Események naponta" hint="a kiválasztott típusú események száma">
        <BarChart data={stats.days} labelEvery={Math.ceil(stats.days.length / 10)} />
      </ChartFrame>

      <ChartFrame title="Részletek" hint={`${data.incidents.length} esemény, legújabb elöl`}>
        <ul className="divide-y divide-border/60">
          {data.incidents.slice(0, 200).map((i) => {
            const meta = KIND_META[i.kind] ?? KIND_META.long_stop;
            const Icon = meta.icon;
            return (
              <li key={i.id} className="flex items-start gap-3 py-2.5">
                {i.route_short ? <RouteTile short={i.route_short} color={i.color ?? "888888"} text={i.text_color ?? "FFFFFF"} /> : <span className="h-7 w-9" />}
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-xs font-semibold">
                    <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.tone)} aria-hidden />
                    <span className="truncate">{i.title}</span>
                  </p>
                  {i.detail ? <p className="mt-0.5 text-[11px] text-muted-foreground">{i.detail}</p> : null}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
                    <span>{i.service_date}</span>
                    <span>{fmtTime(i.started_ts)}</span>
                    {i.vehicle_id ? <span className="rounded bg-primary/12 px-1 font-mono font-bold text-primary">{i.vehicle_id}</span> : null}
                    {i.source === "mvk" ? (
                      <span className="flex items-center gap-0.5 font-semibold text-foreground">
                        <BadgeCheck className="h-3 w-3" aria-hidden /> MVK
                      </span>
                    ) : (
                      <span title="Mennyire biztos az észlelés">{i.confidence}% biztos</span>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </ChartFrame>
    </div>
  );
}
