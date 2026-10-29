import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Ban, CircleAlert, EyeOff, MapPin } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RouteTile } from "@/components/transit/RouteTile";
import { HereChip } from "@/components/transit/HereChip";
import { useGeo } from "@/context/GeoContext";
import { API_BASE } from "@/lib/apiBase";
import { distanceKm } from "@/lib/geo";
import { cn } from "@/lib/utils";
import type { ArrivalItem, Stop } from "@/types";
import { StartRiskLine } from "@/components/transit/TripInsights";

export type DisruptionKind = "cancelled" | "missing" | "unseen";

export interface DisruptionTrip {
  tripId: string;
  kind: DisruptionKind;
  routeId: string;
  route: string;
  color: string;
  text: string;
  dir: string;
  headsign: string;
  depS: number;
  depTime: string;
  arrTime: string;
  from: string;
  to: string;
  replacement: { tripId: string; depTime: string; gapMin: number } | null;
  near: { stopId: string; name: string; time: string; timeS: number } | null;
  upcoming: boolean;
  plannedVehicle: string | null;
}

interface Disruptions {
  date: string;
  nowS: number;
  stale: boolean;
  counts: Record<DisruptionKind, number> & { routes: number };
  nearStops: { id: string; name: string }[];
  byHour: { h: number; cancelled: number; missing: number; unseen: number }[];
  trips: DisruptionTrip[];
  /** hamarosan induló menetek, amelyeknek a busza még az előző menetén késik */
  atRisk?: AtRiskTrip[];
}

export type AtRiskTrip = Omit<DisruptionTrip, "kind" | "replacement" | "plannedVehicle"> & { risk: NonNullable<ArrivalItem["startRisk"]> };

const POLL_MS = 60_000;
/** ennyin belüli megállókat tekintünk „itt vagy”-nak (m) */
const NEAR_M = 300;
const NEAR_MAX = 6;

const KIND: Record<DisruptionKind, { label: string; short: string; hint: string; icon: typeof Ban; tone: string; bar: string }> = {
  cancelled: { label: "Az MVK törölte", short: "Törölve", hint: "hivatalos MVK-adat", icon: Ban, tone: "text-destructive", bar: "bg-destructive" },
  missing: { label: "Most kimarad", short: "Kimarad", hint: "15–90 perce esedékes, egyetlen busz sem vitte", icon: CircleAlert, tone: "text-late", bar: "bg-late" },
  unseen: { label: "Nem láttuk elindulni", short: "Nem indult", hint: "nincs kihúzva, de nem közlekedett", icon: EyeOff, tone: "text-muted-foreground", bar: "bg-muted-foreground/60" },
};

const FILTERS = [
  { id: "all", label: "Mind" },
  { id: "cancelled", label: "Törölve" },
  { id: "missing", label: "Kimarad" },
  { id: "unseen", label: "Nem indult" },
] as const;

/** A közelben (≤300 m) lévő megállók, a legközelebbi elöl. */
function useNearStopIds(stops: Stop[]): string[] {
  const geo = useGeo();
  const lat = geo.position?.lat;
  const lon = geo.position?.lon;
  return useMemo(() => {
    if (lat == null || lon == null) return [];
    return stops
      .map((s) => ({ id: s.id, km: distanceKm(lat, lon, s.lat, s.lon) }))
      .filter((s) => s.km * 1000 <= NEAR_M)
      .sort((a, b) => a.km - b.km)
      .slice(0, NEAR_MAX)
      .map((s) => s.id);
    // A helyzet ~50 m-es változására elég újraszámolni.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, lat == null ? null : Math.round(lat * 2000), lon == null ? null : Math.round(lon * 2000)]);
}

function useDisruptions(open: boolean, near: string[]) {
  const [data, setData] = useState<Disruptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nearKey = near.join(",");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/engine/disruptions${nearKey ? `?near=${encodeURIComponent(nearKey)}` : ""}`, { cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) throw new Error(r.status === 503 ? "A mai menetrend még töltődik — próbáld újra pár másodperc múlva." : `Hiba (${r.status})`);
          return (await r.json()) as Disruptions;
        })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Nem sikerült betölteni"));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, nearKey]);
  return { data, error };
}

/**
 * Mai zavarok: a nap minden kieső menete egy helyen — hivatalos törlések, most
 * kimaradók és a korábban el nem indultak, pótló indulással. Ha tudjuk, hol
 * állsz, az ott megálló menetek kerülnek előre.
 */
export function DisruptionsDialog({
  open,
  onOpenChange,
  stops,
  onPickTrip,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stops: Stop[];
  onPickTrip: (t: DisruptionTrip) => void;
}) {
  const near = useNearStopIds(stops);
  const { data, error } = useDisruptions(open, near);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [route, setRoute] = useState<string | null>(null);

  const view = useMemo(() => {
    const trips = (data?.trips ?? []).filter((t) => (filter === "all" || t.kind === filter) && (!route || t.route === route));
    const here = trips.filter((t) => t.near).sort((a, b) => Number(b.upcoming) - Number(a.upcoming) || a.near!.timeS - b.near!.timeS);
    const ahead = trips.filter((t) => t.upcoming && !t.near);
    const past = trips.filter((t) => !t.upcoming && !t.near).reverse();
    return { here, ahead, past };
  }, [data, filter, route]);
  // a „késve indulhat” lista csak a teljes nézetben (a fajtaszűrő a kieső menetekre vonatkozik)
  const atRisk = useMemo(() => (filter === "all" ? (data?.atRisk ?? []).filter((t) => !route || t.route === route) : []), [data, filter, route]);

  const routes = useMemo(() => {
    const m = new Map<string, { route: string; color: string; text: string; n: number }>();
    for (const t of data?.trips ?? []) {
      const cur = m.get(t.route) ?? { route: t.route, color: t.color, text: t.text, n: 0 };
      cur.n++;
      m.set(t.route, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.route.localeCompare(b.route, "hu", { numeric: true }));
  }, [data]);

  const nearName = data?.nearStops[0]?.name ?? null;
  const total = data ? data.counts.cancelled + data.counts.missing + data.counts.unseen : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <header className="shrink-0 border-b border-border px-4 pb-3 pt-4 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <span className={cn("h-2 w-2 rounded-full", data?.counts.missing ? "bg-late motion-safe:animate-live-pulse" : "bg-ontime")} />
            Mai zavarok
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px]">
            {data ? `${total} kieső menet ma, ${data.counts.routes} vonalon. Koppints egy menetre, és megnyitom a menetrendben.` : "Betöltés…"}
            {data?.stale ? " Az MVK törlési listája most nem frissül — a legutóbbi ismert állapot látszik." : null}
          </DialogDescription>

          {data ? (
            <dl className="mt-3 grid grid-cols-3 gap-2">
              {(["cancelled", "missing", "unseen"] as const).map((k) => {
                const Icon = KIND[k].icon;
                const on = filter === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFilter(on ? "all" : k)}
                    aria-pressed={on}
                    className={cn(
                      "rounded-xl border px-2.5 py-2 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      on ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-accent",
                    )}
                  >
                    <dt className={cn("flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide", KIND[k].tone)}>
                      <Icon className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">{KIND[k].short}</span>
                    </dt>
                    <dd className="mt-0.5 font-mono text-xl font-bold tabular-nums">{data.counts[k]}</dd>
                  </button>
                );
              })}
            </dl>
          ) : null}

          {data?.byHour.length ? <HourStrip rows={data.byHour} nowS={data.nowS} /> : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 sm:px-5">
          {error ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {routes.length > 1 ? (
            <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button
                type="button"
                onClick={() => setRoute(null)}
                aria-pressed={!route}
                className={cn("shrink-0 rounded-lg border px-2.5 py-1 text-xs font-semibold", !route ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent")}
              >
                Minden vonal
              </button>
              {routes.map((r) => (
                <button
                  key={r.route}
                  type="button"
                  onClick={() => setRoute(route === r.route ? null : r.route)}
                  aria-pressed={route === r.route}
                  className={cn("flex shrink-0 items-center gap-1 rounded-lg border px-1 py-0.5", route === r.route ? "border-primary bg-primary/10" : "border-border hover:bg-accent")}
                >
                  <RouteTile short={r.route} color={r.color} text={r.text} size="sm" />
                  <span className="pr-1 font-mono text-[11px] font-bold tabular-nums text-muted-foreground">{r.n}</span>
                </button>
              ))}
            </div>
          ) : null}

          <section aria-label="A közeled" className="mb-4 rounded-xl border border-early/30 bg-early/[0.06] px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-early">
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              {nearName ? `Itt, a(z) ${nearName} megállónál` : "A közeled"}
            </p>
            {nearName ? (
              view.here.length ? (
                <ul className="mt-1.5 divide-y divide-border/50">
                  {view.here.map((t) => (
                    <TripRow key={t.tripId} t={t} at={t.near!} onPick={onPickTrip} />
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[12px] text-muted-foreground">Ma egyetlen itt megálló menet sem esett ki — ha nem jön a busz, az késés, nem kimaradás.</p>
              )
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <span>Ha tudom, hol állsz, az ott megálló kieső menetek kerülnek előre.</span>
                <HereChip stops={stops} />
              </div>
            )}
          </section>

          {data && !view.ahead.length && !view.past.length && !view.here.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{total ? "A szűrésnek nincs találata." : "Ma eddig nem esett ki menet."}</p>
          ) : null}

          {atRisk.length ? (
            <TripGroup title="Késve indulhat" n={atRisk.length}>
              {atRisk.map((t) => (
                <RiskRow key={t.tripId} t={t} onPick={() => onPickTrip({ ...t, kind: "missing", replacement: null, plannedVehicle: null })} />
              ))}
            </TripGroup>
          ) : null}

          {view.ahead.length ? (
            <TripGroup title="Hátralévő" n={view.ahead.length}>
              {view.ahead.map((t) => (
                <TripRow key={t.tripId} t={t} onPick={onPickTrip} />
              ))}
            </TripGroup>
          ) : null}
          {view.past.length ? (
            <TripGroup title="Már esedékes volt" n={view.past.length} muted>
              {view.past.map((t) => (
                <TripRow key={t.tripId} t={t} onPick={onPickTrip} />
              ))}
            </TripGroup>
          ) : null}

          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">Törölve</span>: az MVK hivatalos törlési listája.{" "}
            <span className="font-semibold text-foreground">Kimarad</span>: 15–90 perce esedékes, egyetlen busz sem kezdte el, és késő busz sem tart felé.{" "}
            <span className="font-semibold text-foreground">Nem indult</span>: korábban ma esedékes volt, nincs kihúzva, mégsem láttuk — miközben a vonal szomszédos meneteit igen. Az „igény esetén” járatokat nem számoljuk.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TripGroup({ title, n, muted, children }: { title: string; n: number; muted?: boolean; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className={cn("mb-1 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide", muted ? "text-muted-foreground" : "text-foreground")}>
        {title}
        <span className="font-mono tabular-nums text-muted-foreground">{n}</span>
      </h3>
      <ul className={cn("divide-y divide-border/50", muted && "opacity-80")}>{children}</ul>
    </section>
  );
}

function TripRow({ t, at, onPick }: { t: DisruptionTrip; at?: DisruptionTrip["near"]; onPick: (t: DisruptionTrip) => void }) {
  const meta = KIND[t.kind];
  const Icon = meta.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(t)}
        className="grid w-full grid-cols-[auto_3rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-lg px-1.5 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <RouteTile short={t.route} color={t.color} text={t.text} />
        <span className={cn("pt-0.5 font-mono text-sm font-bold tabular-nums", t.kind === "cancelled" && "line-through decoration-destructive/70 decoration-2")}>
          {at ? at.time : t.depTime}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold">{t.headsign || t.to}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1 font-semibold", meta.tone)} title={meta.hint}>
              <Icon className="h-3 w-3" aria-hidden /> {meta.short}
            </span>
            <span className="truncate">
              {at ? `itt ${at.time} · indul ${t.from} ${t.depTime}` : `${t.from} → ${t.to}, ${t.depTime}–${t.arrTime}`}
            </span>
            {t.plannedVehicle ? <span className="font-mono">{t.plannedVehicle} vitte volna</span> : null}
          </span>
          {t.replacement ? (
            <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-ontime/10 px-1.5 py-0.5 text-[11px] font-semibold text-ontime">
              <ArrowRight className="h-3 w-3" aria-hidden />
              helyette {t.replacement.depTime} <span className="font-normal text-muted-foreground">(+{t.replacement.gapMin} perc)</span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** Még nem esett ki, de a busza késik az előző menetén: előre szólunk. */
function RiskRow({ t, onPick }: { t: AtRiskTrip; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="grid w-full grid-cols-[auto_3rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-lg px-1.5 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <RouteTile short={t.route} color={t.color} text={t.text} />
        <span className="pt-0.5 font-mono text-sm font-bold tabular-nums">{t.near ? t.near.time : t.depTime}</span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold">{t.headsign || t.to}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {t.near ? `itt ${t.near.time} · indul ${t.from} ${t.depTime}` : `${t.from} → ${t.to}, ${t.depTime}–${t.arrTime}`}
          </span>
          <StartRiskLine risk={t.risk} className="mt-1" />
        </span>
      </button>
    </li>
  );
}

/** Kieső menetek óránként (a nap eleje → most → vége); a mostani óra kiemelve. */
function HourStrip({ rows, nowS }: { rows: Disruptions["byHour"]; nowS: number }) {
  const from = Math.min(4, ...rows.map((r) => r.h));
  const to = Math.max(23, ...rows.map((r) => r.h));
  const byH = new Map(rows.map((r) => [r.h, r]));
  const max = Math.max(1, ...rows.map((r) => r.cancelled + r.missing + r.unseen));
  const nowH = Math.floor(nowS / 3600);
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <figure className="mt-3" aria-label="Kieső menetek óránként">
      <div className="flex h-10 items-end gap-[2px]">
        {hours.map((h) => {
          const r = byH.get(h);
          const n = r ? r.cancelled + r.missing + r.unseen : 0;
          return (
            <span
              key={h}
              title={`${String(h % 24).padStart(2, "0")} óra: ${n} kieső menet`}
              className={cn("flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-[2px] bg-muted/60", h === nowH && "ring-1 ring-primary")}
              style={{ height: `${Math.max(8, (100 * n) / max)}%` }}
            >
              {r
                ? (["cancelled", "missing", "unseen"] as const).map((k) =>
                    r[k] ? <span key={k} className={KIND[k].bar} style={{ height: `${(100 * r[k]) / n}%` }} /> : null,
                  )
                : null}
            </span>
          );
        })}
      </div>
      <figcaption className="mt-1 flex justify-between font-mono text-[9.5px] tabular-nums text-muted-foreground">
        <span>{String(from % 24).padStart(2, "0")}</span>
        <span>{String(Math.floor((from + to) / 2) % 24).padStart(2, "0")}</span>
        <span>{String(to % 24).padStart(2, "0")}</span>
      </figcaption>
    </figure>
  );
}
