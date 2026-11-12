import { useEffect, useMemo, useState } from "react";
import { Cloud, CloudOff, Map as MapIcon, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { journeyDelay, rideStats } from "@mvk/core/rideStats";
import { ChartFrame } from "@/components/charts/Charts";
import { RouteTile } from "@/components/transit/RouteTile";
import { delayLabel, delayTone } from "@/components/transit/DelayBar";
import { getSession } from "@/lib/account";
import { Button } from "@/components/ui/button";
import { canFixRide, deleteRide, groupJourneys, syncRides, useRides, type Ride } from "@/lib/rides";
import { serverNow } from "@/lib/realtime";
import { RideAddSheet } from "./RideAddSheet";
import { RideFixSheet } from "./RideFixSheet";
import { RideStatsView } from "./RideStatsView";
import { useDelayBackfill, useLoopRoutes } from "./useRideExtras";
import { statsApi } from "@/services/statsApi";
import { cn } from "@/lib/utils";
import { displayVehicleId, vehicleIdTitle } from "@/lib/modes";

const nf = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", month: "short", day: "numeric", weekday: "short" });
const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
/** ennyi napra visszamenőleg lehet körbeutazással meghosszabbítani (a szerver két hetet ad a menetrendből) */
const EXTEND_DAYS = 13;
/** a plusz menetidő ettől látszik a sorban (mp) */
const EXTRA_SHOWN_S = 60;

/** Utazásaim: a rögzített utazások összesítése és listája. */
export function RidesPanel() {
  const rides = useRides();
  const [fleetSize, setFleetSize] = useState<number | null>(null);
  const [fixing, setFixing] = useState<Ride[] | null>(null);
  /** utólagos felvétel: új utazás (`[]`), vagy egy már rögzített út körbeutazásként meghosszabbítva */
  const [adding, setAdding] = useState<Ride[] | null>(null);
  const loggedIn = Boolean(getSession());
  const loopRoutes = useLoopRoutes();
  useDelayBackfill(rides);

  useEffect(() => {
    void syncRides();
    statsApi
      .vehicles()
      .then((r) => setFleetSize(r.vehicles.length))
      .catch(() => setFleetSize(null));
  }, []);

  const journeys = useMemo(() => groupJourneys(rides), [rides]);
  const s = useMemo(() => rideStats(journeys), [journeys]);
  const unsynced = (rides as (Ride & { synced?: boolean })[]).filter((r) => !r.synced).length;
  const extendFrom = Math.round(serverNow()) - EXTEND_DAYS * 86_400;

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
        <Button size="sm" variant="outline" onClick={() => setAdding([])}>
          <Plus /> Utazás hozzáadása
        </Button>
      </header>

      {!rides.length ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
          <MapIcon className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Még nincs rögzített utazásod</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
            A térképen kövess egy buszt, és nyomd meg a „Felszálltam” gombot: megadod, hol szálltál fel és hol szállsz le (vagy hogy körbeutazol), a többit az app intézi. Egy korábbi utat a menetrendből is felvehetsz.
          </p>
        </div>
      ) : (
        <>
          <RideStatsView s={s} fleetSize={fleetSize} />

          <ChartFrame title="Utazások" hint="A legutóbbi elöl">
            <ul className="divide-y divide-border/60">
              {journeys.slice(0, 200).map((legs) => {
                const last = legs[legs.length - 1];
                const onFix = canFixRide(legs) ? () => setFixing(legs) : undefined;
                // Körbeutazásként meghosszabbítható: fordulóhurkos vonal (vagy menet), a menetrend még elérhető
                const loopable = (last.loopEnd ?? loopRoutes.has(last.route)) && last.boardedAt >= extendFrom;
                const onExtend = loopable ? () => setAdding(legs) : undefined;
                return <JourneyRow key={legs[0].id} legs={legs} onFix={onFix} onExtend={onExtend} />;
              })}
            </ul>
          </ChartFrame>
        </>
      )}
      {fixing ? <RideFixSheet legs={fixing} initial="from" onClose={() => setFixing(null)} /> : null}
      {adding ? <RideAddSheet continueFrom={adding.length ? adding : undefined} onClose={() => setAdding(null)} /> : null}
    </div>
  );
}

function IconAction({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      className="rounded-md p-1.5 text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {children}
    </button>
  );
}

/** Az út késése: felszálláskor mennyit késett a busz, és mennyivel tartott tovább az út. */
function DelayFacts({ legs }: { legs: Ride[] }) {
  const d = journeyDelay(legs);
  if (d.boardS == null && d.alightS == null) return <span className="text-muted-foreground/80">késés: nincs mérés</span>;
  return (
    <>
      <span className={cn("font-mono font-semibold", delayTone(d.boardS ?? d.alightS))} title="A busz késése felszálláskor">
        {delayLabel(d.boardS ?? d.alightS)}
      </span>
      {d.extraS != null && d.extraS >= EXTRA_SHOWN_S ? (
        <span className="font-mono text-late" title="Ennyivel tovább tartott az út a menetrendnél">
          +{Math.round(d.extraS / 60)} perc út közben
        </span>
      ) : null}
    </>
  );
}

/** Egy út: egy menet, vagy körbeutazásnál az ülve maradva megtett menetek együtt. */
function JourneyRow({ legs, onFix, onExtend }: { legs: Ride[]; onFix?: () => void; onExtend?: () => void }) {
  const first = legs[0];
  const last = legs[legs.length - 1];
  const loop = legs.length > 1;
  const mins = last.alightedAt ? Math.max(1, Math.round((last.alightedAt - first.boardedAt) / 60)) : null;
  const stops = legs.some((r) => r.stops != null) ? legs.reduce((a, r) => a + (r.stops ?? 0), 0) : null;
  const meters = legs.some((r) => r.distanceM != null) ? legs.reduce((a, r) => a + (r.distanceM ?? 0), 0) : null;
  const routes = [...new Map(legs.map((r) => [r.route, r])).values()];
  const what = loop ? "Körbeutazás" : "Utazás";
  return (
    <li className="flex items-center gap-3 py-2.5">
      {/* minden sorban ugyanakkora csempe (körbeutazásnál is), több vonalnál egymás alatt */}
      <span className="flex w-12 shrink-0 flex-col items-start gap-1">
        {routes.map((r) => (
          <RouteTile key={r.route} short={r.route} color={r.color} text={r.text} />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        {loop ? (
          <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-primary">
            <Repeat className="h-3 w-3" aria-hidden /> Körbeutazás · {legs.length} menet
          </p>
        ) : null}
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
          {first.vehicleId ? (
            <span className="font-mono" title={vehicleIdTitle(first.vehicleId)}>
              {displayVehicleId(first.vehicleId)}
            </span>
          ) : null}
          {mins != null ? <span>{mins} perc</span> : null}
          {stops != null ? <span>{stops} megálló</span> : null}
          {meters ? <span>{nf.format(meters / 1000)} km</span> : null}
          <DelayFacts legs={legs} />
          {legs.every((r) => r.detected === "later") ? <span className="rounded bg-muted px-1">utólag</span> : null}
        </p>
      </div>
      <span className="flex shrink-0 items-center">
        {onExtend ? (
          <IconAction label={`${what}: a végállomáson a buszon maradtam — körbeutazás hozzáadása`} title="Körbeutazás hozzáadása" onClick={onExtend}>
            <Repeat className="h-4 w-4" />
          </IconAction>
        ) : null}
        {onFix ? (
          <IconAction label={`${what}: hol szálltál fel és le`} title="Hol szálltál fel és le?" onClick={onFix}>
            <Pencil className="h-4 w-4" />
          </IconAction>
        ) : null}
        <IconAction
          label={`${what} törlése`}
          onClick={() => {
            if (confirm(loop ? "Törlöd ezt a körbeutazást (minden menetét)?" : "Törlöd ezt az utazást?")) for (const r of legs) void deleteRide(r.id);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </IconAction>
      </span>
    </li>
  );
}
