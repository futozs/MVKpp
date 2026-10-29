import { useEffect, useMemo, useState } from "react";
import { Cloud, CloudOff, Map as MapIcon, Repeat, Trash2 } from "lucide-react";
import { StatTile, ChartFrame } from "@/components/charts/Charts";
import { RouteTile } from "@/components/transit/RouteTile";
import { delayLabel, delayTone } from "@/components/transit/DelayBar";
import { getSession } from "@/lib/account";
import { deleteRide, syncRides, useRides, type Ride } from "@/lib/rides";
import { statsApi } from "@/services/statsApi";
import { cn } from "@/lib/utils";

const nf = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", month: "short", day: "numeric", weekday: "short" });
const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });

/** Pontosnak számít, ha ±1 percen belül érkezett a busz. */
const ON_TIME_S = 60;

/** Utazásaim: a „Felszálltam” gombbal / felismeréssel rögzített utazások összesítése. */
export function RidesPanel() {
  const rides = useRides();
  const [fleetSize, setFleetSize] = useState<number | null>(null);
  const loggedIn = Boolean(getSession());

  useEffect(() => {
    void syncRides();
    statsApi
      .vehicles()
      .then((r) => setFleetSize(r.vehicles.length))
      .catch(() => setFleetSize(null));
  }, []);

  const s = useMemo(() => summarize(rides), [rides]);
  const journeys = useMemo(() => groupJourneys(rides), [rides]);
  const unsynced = (rides as (Ride & { synced?: boolean })[]).filter((r) => !r.synced).length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight sm:text-xl">Utazásaim</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            {loggedIn ? <Cloud className="h-3.5 w-3.5 text-primary" /> : <CloudOff className="h-3.5 w-3.5" />}
            {loggedIn
              ? unsynced
                ? `${unsynced} utazás feltöltésre vár`
                : "Minden utazás a felhőben is megvan"
              : "Csak ezen az eszközön — jelentkezz be, és minden feltöltődik"}
          </p>
        </div>
      </header>

      {!rides.length ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
          <MapIcon className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Még nincs rögzített utazásod</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
            A térképen kövess egy buszt, és nyomd meg a „Felszálltam” gombot. Ha a helymeghatározás be van kapcsolva, a nyitott térkép magától is felismeri, ha együtt mozogsz egy busszal.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Utazás" value={journeys.length} sub={s.loops ? `ebből ${s.loops} körbeutazás` : undefined} />
            <StatTile label="Megtett út" value={`${nf.format(s.km)} km`} sub="megállóról megállóra, légvonalban" />
            <StatTile label="Buszon töltött idő" value={formatDuration(s.minutes)} />
            <StatTile label="Begyűjtött rendszám" value={s.vehicles.length} sub={fleetSize ? `a flotta ${fleetSize} járművéből` : undefined} tone="live" />
            <StatTile label="Vonal" value={s.routes.length} />
            <StatTile
              label="Pontos busz"
              value={s.onTimePct != null ? `${s.onTimePct}%` : "—"}
              sub="felszálláskor ±1 percen belül"
              tone={s.onTimePct != null && s.onTimePct >= 70 ? "ontime" : "late"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartFrame title="Begyűjtött rendszámok" hint="Melyik buszon hányszor utaztál">
              <div className="flex flex-wrap gap-1.5">
                {s.vehicles.map(([id, n]) => (
                  <span key={id} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1 pl-2 pr-1.5">
                    <span className="font-mono text-[13px] font-bold tabular-nums">{id}</span>
                    <span className="rounded bg-primary/15 px-1 font-mono text-[10.5px] font-bold text-primary">{n}×</span>
                  </span>
                ))}
              </div>
            </ChartFrame>
            <ChartFrame title="Kedvenc vonalaid" hint="Az utazásaid vonalai">
              <ul className="space-y-1.5">
                {s.routes.slice(0, 8).map(([key, n, sample]) => (
                  <li key={key} className="flex items-center gap-3">
                    <RouteTile short={sample.route} color={sample.color} text={sample.text} size="sm" />
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary/70" style={{ width: `${(100 * n) / s.routes[0][1]}%` }} />
                    </span>
                    <span className="w-8 text-right font-mono text-xs tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
            </ChartFrame>
          </div>

          <ChartFrame title="Utazások" hint="A legutóbbi elöl">
            <ul className="divide-y divide-border/60">
              {journeys.slice(0, 200).map((legs) =>
                legs.length > 1 ? <LoopRow key={legs[0].id} legs={legs} /> : <RideRow key={legs[0].id} r={legs[0]} />,
              )}
            </ul>
          </ChartFrame>
        </>
      )}
    </div>
  );
}

function RideRow({ r }: { r: Ride }) {
  const mins = r.alightedAt ? Math.max(1, Math.round((r.alightedAt - r.boardedAt) / 60)) : null;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <RouteTile short={r.route} color={r.color} text={r.text} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">
          {r.fromStopName ?? "?"} <span className="text-muted-foreground">→</span> {r.toStopName ?? "?"}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
          <span>
            {DAY.format(new Date(r.boardedAt * 1000))} {HM.format(new Date(r.boardedAt * 1000))}
          </span>
          <span className="font-mono">{r.vehicleId}</span>
          {mins != null ? <span>{mins} perc</span> : null}
          {r.stops != null ? <span>{r.stops} megálló</span> : null}
          {r.distanceM != null ? <span>{nf.format(r.distanceM / 1000)} km</span> : null}
          {r.delayAtBoardS != null ? <span className={cn("font-mono", delayTone(r.delayAtBoardS))}>{delayLabel(r.delayAtBoardS)}</span> : null}
          {r.detected === "auto" ? <span className="rounded bg-muted px-1">felismert</span> : null}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (confirm("Törlöd ezt az utazást?")) void deleteRide(r.id);
        }}
        aria-label="Utazás törlése"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

/** Körbeutazás: egy buszon, ülve maradva megtett menetek egy sorban. */
function LoopRow({ legs }: { legs: Ride[] }) {
  const first = legs[0];
  const last = legs[legs.length - 1];
  const mins = last.alightedAt ? Math.max(1, Math.round((last.alightedAt - first.boardedAt) / 60)) : null;
  const stops = legs.reduce((a, r) => a + (r.stops ?? 0), 0);
  const meters = legs.reduce((a, r) => a + (r.distanceM ?? 0), 0);
  const routes = [...new Map(legs.map((r) => [r.route, r])).values()];
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="flex shrink-0 flex-col gap-1">
        {routes.map((r) => (
          <RouteTile key={r.route} short={r.route} color={r.color} text={r.text} size="sm" />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-primary">
          <Repeat className="h-3 w-3" aria-hidden /> Körbeutazás · {legs.length} menet
        </p>
        <p className="line-clamp-2 text-[13px] font-semibold">
          {first.fromStopName ?? "?"}
          {legs.slice(0, -1).map((r) => (
            <span key={r.id}>
              {" "}
              <span className="text-muted-foreground">→</span> {r.toStopName ?? "?"}
            </span>
          ))}{" "}
          <span className="text-muted-foreground">→</span> {last.toStopName ?? "?"}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
          <span>
            {DAY.format(new Date(first.boardedAt * 1000))} {HM.format(new Date(first.boardedAt * 1000))}
          </span>
          <span className="font-mono">{first.vehicleId}</span>
          {mins != null ? <span>{mins} perc</span> : null}
          <span>{stops} megálló</span>
          {meters ? <span>{nf.format(meters / 1000)} km</span> : null}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (confirm("Törlöd ezt a körbeutazást (minden menetét)?")) for (const r of legs) void deleteRide(r.id);
        }}
        aria-label="Körbeutazás törlése"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

/** Utazások csoportosítva: a körbeutazás menetei (közös chainId) egy utazásnak számítanak; legújabb elöl. */
function groupJourneys(rides: Ride[]): Ride[][] {
  const chains = new Map<string, Ride[]>();
  const out: Ride[][] = [];
  for (const r of rides) {
    if (!r.chainId) {
      out.push([r]);
      continue;
    }
    const legs = chains.get(r.chainId);
    if (legs) legs.push(r);
    else {
      const fresh = [r];
      chains.set(r.chainId, fresh);
      out.push(fresh);
    }
  }
  for (const legs of chains.values()) legs.sort((a, b) => a.boardedAt - b.boardedAt);
  return out;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} perc`;
  const h = Math.floor(minutes / 60);
  return `${h} ó ${minutes % 60} p`;
}

function summarize(rides: Ride[]) {
  const vehicles = new Map<string, number>();
  const routes = new Map<string, { n: number; sample: Ride }>();
  let meters = 0;
  let minutes = 0;
  let measured = 0;
  let onTime = 0;
  for (const r of rides) {
    vehicles.set(r.vehicleId, (vehicles.get(r.vehicleId) ?? 0) + 1);
    const rt = routes.get(r.route);
    routes.set(r.route, { n: (rt?.n ?? 0) + 1, sample: rt?.sample ?? r });
    meters += r.distanceM ?? 0;
    if (r.alightedAt) minutes += Math.max(0, Math.round((r.alightedAt - r.boardedAt) / 60));
    if (r.delayAtBoardS != null) {
      measured++;
      if (Math.abs(r.delayAtBoardS) <= ON_TIME_S) onTime++;
    }
  }
  return {
    count: rides.length,
    loops: new Set(rides.map((r) => r.chainId).filter(Boolean)).size,
    km: meters / 1000,
    minutes,
    vehicles: [...vehicles].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "hu", { numeric: true })),
    routes: [...routes].map(([key, v]) => [key, v.n, v.sample] as const).sort((a, b) => b[1] - a[1]),
    onTimePct: measured ? Math.round((100 * onTime) / measured) : null,
  };
}
