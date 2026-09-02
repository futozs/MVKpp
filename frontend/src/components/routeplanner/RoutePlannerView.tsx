import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Bus,
  Footprints,
  MapPin,
  TramFront,
  Zap,
} from "lucide-react";
import type { RoutePlanLeg, RoutePlanTrip, Stop } from "@/types";
import { api } from "@/services/api";
import { statsApi } from "@/services/statsApi";
import { ChartFrame } from "@/components/charts/Charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, normalizeSearchText } from "@/lib/utils";

const fmtMin = (sec: number) => {
  const m = Math.round(sec / 60);
  return `${m} perc`;
};

/** Az itinerárium ISO időbélyege helyi (nem UTC) idő — a "HH:MM" simán kivágható. */
const hm = (iso: string) => iso.slice(11, 16);

const MODE_LABEL: Record<string, string> = {
  BUS: "busz",
  TRAM: "villamos",
  TROLLEYBUS: "trolibusz",
  TROLLEY: "trolibusz",
  RAIL: "vonat",
};

function LegIcon({ mode }: { mode: string }) {
  if (mode === "WALK")
    return <Footprints className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  if (mode === "TRAM")
    return <TramFront className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  return <Bus className="h-3.5 w-3.5 shrink-0" aria-hidden />;
}

type DelayInfo = { avgDelaySec: number | null; samples: number };

function delayKey(l: RoutePlanLeg): string | null {
  if (l.mode === "WALK" || !l.routeShortName || !l.fromStopId) return null;
  return `${l.routeShortName}|${l.fromStopId}`;
}

function DelayNote({ info }: { info: DelayInfo | undefined }) {
  if (!info || info.avgDelaySec == null) return null;
  const min = Math.round(Math.abs(info.avgDelaySec) / 60);
  const text =
    Math.abs(info.avgDelaySec) < 30
      ? "átlagosan pontos"
      : info.avgDelaySec > 0
        ? `átlagosan ${min > 0 ? `${min} perccel` : `${info.avgDelaySec} mp-cel`} késik`
        : `átlagosan ${min > 0 ? `${min} perccel` : `${-info.avgDelaySec} mp-cel`} korábban jön`;
  return (
    <span
      className={cn(
        "text-[11px]",
        info.avgDelaySec > 60
          ? "text-late"
          : info.avgDelaySec < -60
            ? "text-early"
            : "text-muted-foreground",
      )}
    >
      {text} ({info.samples} mérésből)
    </span>
  );
}

function TripCard({
  trip,
  delays,
}: {
  trip: RoutePlanTrip;
  delays: Map<string, DelayInfo>;
}) {
  const boardingCount = trip.legs.filter((l) => l.mode !== "WALK").length;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold tabular-nums">
          {hm(trip.start)} → {hm(trip.end)}
        </p>
        <p className="text-xs text-muted-foreground">
          {fmtMin(trip.durationSec)} ·{" "}
          {boardingCount
            ? `${boardingCount} járat${boardingCount > 1 ? "tal" : "tal"}`
            : "gyalog"}
        </p>
      </div>

      <ol className="mt-3 space-y-2">
        {trip.legs.map((leg, i) => {
          const isWalk = leg.mode === "WALK";
          const info = delays.get(delayKey(leg) ?? "");
          return (
            <li key={i} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  isWalk
                    ? "bg-muted text-muted-foreground"
                    : "text-primary-foreground",
                )}
                style={
                  !isWalk
                    ? {
                        background: leg.routeColor
                          ? `#${leg.routeColor}`
                          : "hsl(var(--primary))",
                      }
                    : undefined
                }
              >
                <LegIcon mode={leg.mode} />
              </span>
              <div className="min-w-0 flex-1">
                {isWalk ? (
                  <p className="text-xs text-muted-foreground">
                    Gyalog {fmtMin(leg.durationSec)} — {leg.toName}
                  </p>
                ) : (
                  <>
                    <p className="text-xs font-semibold">
                      <span className="tabular-nums">{hm(leg.start)}</span>{" "}
                      {leg.routeShortName}
                      {MODE_LABEL[leg.mode] ? ` (${MODE_LABEL[leg.mode]})` : ""}{" "}
                      — {leg.fromName} felszállás
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      érkezés <span className="tabular-nums">{hm(leg.end)}</span> —{" "}
                      {leg.toName}
                      {leg.intermediateStopNames.length
                        ? ` (${leg.intermediateStopNames.length} megálló)`
                        : ""}
                    </p>
                    <DelayNote info={info} />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function usePlaces(stops: Stop[]) {
  return useMemo(() => {
    const byName = new Map<string, Stop>();
    for (const s of stops) if (!byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "hu"),
    );
  }, [stops]);
}

function PlaceSelect({
  label,
  places,
  value,
  onChange,
}: {
  label: string;
  places: Stop[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const matches = useMemo(() => {
    const t = normalizeSearchText(text.trim());
    if (!t) return [];
    return places
      .filter((s) => normalizeSearchText(s.name).includes(t))
      .slice(0, 8);
  }, [text, places]);
  const selected = places.find((s) => s.id === value);

  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {selected ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            setText("");
          }}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-left text-sm font-semibold transition-colors hover:bg-primary/15"
        >
          <span className="flex min-w-0 items-center gap-2">
            <MapPin
              aria-hidden
              className="h-4 w-4 shrink-0 text-primary/70"
            />
            <span className="truncate">{selected.name}</span>
          </span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
            módosít
          </span>
        </button>
      ) : (
        <>
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Település, városrész vagy megálló neve…"
            aria-label={label}
          />
          {matches.length ? (
            <ul className="max-h-44 overflow-y-auto rounded-lg border border-border bg-card">
              {matches.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(s.id);
                      setText("");
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <MapPin
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 truncate">{s.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : text.trim() ? (
            <p className="px-1 text-[11px] text-muted-foreground">
              Nincs ilyen nevű hely a hálózatban.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Útvonaltervező — helynév alapján (nem megállóazonosító alapján) kérdez rá,
 * melyik járattal, mikor és honnan lehet eljutni A-ból B-be. Az MVK saját,
 * hiteles útvonaltervezőjét (/api/v1/route/plan) hívja — ez adja a valódi
 * itinerárium(oka)t (melyik busz/villamos, mikor indul, hol kell felszállni),
 * amit a saját mért késésadatunkkal egészítünk ki, mert az MVK végpont csak
 * menetrendi időt ad, tényleges késést nem.
 *
 * Korábban a statisztika oldal „Menetidő A→B" füle volt, onnan ide
 * költözött, mert ott csak pontos megállónevet fogadott el.
 */
export function RoutePlannerView({ stops }: { stops: Stop[] }) {
  const places = usePlaces(stops);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [at, setAt] = useState(nowLocalInput());
  const [trips, setTrips] = useState<RoutePlanTrip[] | null>(null);
  const [delays, setDelays] = useState<Map<string, DelayInfo>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fromPlace = places.find((s) => s.id === from);
  const toPlace = places.find((s) => s.id === to);

  const run = async () => {
    if (!fromPlace || !toPlace) return;
    setLoading(true);
    setError(null);
    setTrips(null);
    setDelays(new Map());
    try {
      const iso = new Date(at).toISOString();
      const plan = await api.planRoute(
        { lat: fromPlace.lat, lon: fromPlace.lon },
        { lat: toPlace.lat, lon: toPlace.lon },
        iso,
      );
      const transit = plan.trips.filter((t) => t.travelProfile === "TRANSIT");
      setTrips(transit);
      if (!transit.length) {
        setError("Nincs tömegközlekedéssel elérhető útvonal ebben az időpontban.");
        return;
      }

      // Csak egyszer, egy köteg hívással kérjük le a késésátlagokat minden
      // egyedi (járat, felszállási megálló) párra, nehogy legenkénti külön
      // kérés menjen minden itineráriumhoz.
      const uniq = new Map<string, { routeShort: string; stopId: string }>();
      for (const t of transit) {
        for (const l of t.legs) {
          const key = delayKey(l);
          if (key && !uniq.has(key)) {
            uniq.set(key, { routeShort: l.routeShortName!, stopId: l.fromStopId! });
          }
        }
      }
      if (uniq.size) {
        const keys = [...uniq.keys()];
        const legs = [...uniq.values()];
        const delayRes = await statsApi.routeDelays(iso, legs);
        const map = new Map<string, DelayInfo>();
        keys.forEach((k, i) => map.set(k, delayRes.results[i]));
        setDelays(map);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const swap = () => {
    setFrom(to);
    setTo(from);
    setTrips(null);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
        <div>
          <h1 className="text-lg font-bold tracking-tight sm:text-xl">
            Útvonaltervező
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Melyik járattal, mikor és honnan jutsz el A-ból B-be — a mért
            késésadatainkkal kiegészítve, nem csak menetrendi idővel.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <PlaceSelect
              label="Honnan"
              places={places}
              value={from}
              onChange={setFrom}
            />
            <PlaceSelect
              label="Hova"
              places={places}
              value={to}
              onChange={setTo}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1 space-y-1.5">
              <label
                htmlFor="rp-at"
                className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Mikor
              </label>
              <Input
                id="rp-at"
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={swap}
              aria-label="Irány megfordítása"
            >
              <ArrowRightLeft />
            </Button>
            <Button onClick={run} disabled={!fromPlace || !toPlace || loading}>
              <Zap className={loading ? "animate-pulse" : undefined} />
              {loading ? "Keresés…" : "Útvonal keresése"}
            </Button>
          </div>

          {error ? (
            <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        {trips && trips.length ? (
          <ChartFrame
            title="Lehetséges útvonalak"
            hint={`${fromPlace?.name} → ${toPlace?.name}`}
          >
            <div className="space-y-3">
              {trips.map((t) => (
                <TripCard key={t.logDetailsId} trip={t} delays={delays} />
              ))}
            </div>
          </ChartFrame>
        ) : null}
      </div>
    </div>
  );
}
