import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Bus,
  Clock3,
  Footprints,
  History,
  MapPin,
  TramFront,
  Zap,
} from "lucide-react";
import type { RoutePlanLeg, RoutePlanTrip, Stop } from "@/types";
import { api } from "@/services/api";
import { statsApi, fmtDuration, type SegmentEstimate } from "@/services/statsApi";
import { ChartFrame } from "@/components/charts/Charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { TimeField } from "@/components/ui/time-field";
import { cn, normalizeSearchText } from "@/lib/utils";

const fmtMin = (sec: number) => {
  const m = Math.round(sec / 60);
  return `${m} perc`;
};

/**
 * Az itinerárium ISO időbélyege UTC-ben érkezik — a nyers karaktereket
 * kivágni (korábbi megoldás) 2 órával elcsúsztatta a kiírt időt nyáridőben.
 * A Date-en keresztüli konverzió a böngésző helyi időzónájában adja vissza.
 */
const hm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

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

/**
 * Az MVK route/plan végpontja a departureTime szövegét szó szerint, a saját
 * (budapesti) idejeként értelmezi — a "Z" (UTC) jelölést figyelmen kívül
 * hagyja. Ha ide valódi UTC-re konvertált időt küldenénk (pl. nyáron 07:00
 * helyi idő → 05:00Z), a szerver azt is 05:00-ként, tehát 2 órával korábbi
 * időpontként venné figyelembe — pontosan ez okozta, hogy egy megadott
 * 7:00-ás indulás a keresésben 5:00-ként jelent meg. Ezért ide a helyi
 * óra:perc számjegyeket küldjük, "Z"-vel megjelölve, DE valódi
 * időzóna-konverzió nélkül.
 *
 * A visszakapott itinerárium-időbélyegek (trip.start/end) viszont MÁR
 * valódi UTC-ben érkeznek — azokat a hm() lent a szokásos Date-konverzióval
 * jeleníti meg helyesen. A saját statisztika-backendünk (statsApi) szintén
 * valódi UTC-t vár, ott a sima toISOString() a helyes — ld. toTrueUtcIso().
 */
function toMvkDepartureParam(localAt: string): string {
  const withSeconds = localAt.length <= 16 ? `${localAt}:00` : localAt;
  return `${withSeconds}Z`;
}

/** A saját backendünknek (statsApi) szánt, valódi UTC időbélyeg. */
function toTrueUtcIso(localAt: string): string {
  return new Date(localAt).toISOString();
}

const PAST_BUFFER_MS = 3 * 60_000;

/** Múltbeli időpontnál az élő MVK-tervező helyett a mért adatainkból becslünk. */
function isPastMoment(localAt: string): boolean {
  return new Date(localAt).getTime() < Date.now() - PAST_BUFFER_MS;
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

function HistoricCard({ est }: { est: SegmentEstimate }) {
  const excessS = Math.max(0, est.p50S - est.schedS);
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold">
          {est.routeShort ? (
            <span
              className="flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-[11px] font-bold text-primary-foreground"
              style={{ background: est.routeColor ? `#${est.routeColor}` : "hsl(var(--primary))" }}
            >
              {est.routeShort}
            </span>
          ) : null}
          {est.headsign ? <span className="font-normal text-muted-foreground">{est.headsign}</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">~{fmtDuration(est.p50S)}</p>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Várható menetidő a mért adatok alapján{" "}
        <span className="font-semibold text-foreground">{fmtDuration(est.p50S)}</span>
        {excessS > 30 ? (
          <>
            {" "}— menetrend szerint {fmtDuration(est.schedS)}, tehát átlagosan{" "}
            <span className="text-late">{fmtDuration(excessS)}-cel több</span> kellett.
          </>
        ) : (
          " — nagyjából a menetrend szerint."
        )}
      </p>

      {est.legs.length > 1 ? (
        <ol className="mt-3 space-y-1.5 border-t border-border pt-2.5">
          {est.legs.map((l, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-muted-foreground">
                {l.from} → {l.to}
              </span>
              <span className="shrink-0 tabular-nums">{fmtDuration(l.p50S)}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <p className="mt-2.5 text-[11px] text-muted-foreground">
        {est.samples > 0
          ? `${est.samples} mérésből, ${est.confidence} megbízhatóságú becslés${est.scheduleExact ? "" : " (nem az adott napra érvényes menetrend alapján)"}.`
          : "Nincs mért adat ehhez az időszakhoz, a menetrendi időt mutatjuk."}
      </p>
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
  const [historic, setHistoric] = useState<SegmentEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fromPlace = places.find((s) => s.id === from);
  const toPlace = places.find((s) => s.id === to);
  const past = isPastMoment(at);

  const run = async () => {
    if (!fromPlace || !toPlace) return;
    setLoading(true);
    setError(null);
    setTrips(null);
    setHistoric(null);
    setDelays(new Map());
    try {
      // A múltbeli időpontnál az élő MVK-tervező üres/hibás választ ad
      // (nem tud múltra tervezni) — helyette a saját mért adatainkból
      // (menetrend + tényleges mért menetidő) becsülünk, hogy pl. arra is
      // lehessen válaszolni: "tegnap mennyi késéssel értem be a városba".
      if (past) {
        try {
          const est = await statsApi.segment(fromPlace.id, toPlace.id, toTrueUtcIso(at));
          setHistoric(est);
        } catch {
          setError(
            "Erre az útvonalra nincs történeti adatunk ehhez az időponthoz — ez csak olyan megállópárokra működik, amelyeket egyetlen járat közvetlenül, átszállás nélkül összeköt.",
          );
        }
        return;
      }

      const plan = await api.planRoute(
        { lat: fromPlace.lat, lon: fromPlace.lon },
        { lat: toPlace.lat, lon: toPlace.lon },
        toMvkDepartureParam(at),
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
        const delayRes = await statsApi.routeDelays(toTrueUtcIso(at), legs);
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
            <div className="space-y-1.5">
              <label
                htmlFor="rp-at-date"
                className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Mikor
              </label>
              <div className="flex gap-2">
                <DateField
                  id="rp-at-date"
                  value={at.slice(0, 10)}
                  onChange={(d) => setAt(`${d}T${at.slice(11, 16)}`)}
                  aria-label="Útvonaltervezés dátuma"
                />
                <TimeField
                  value={at.slice(11, 16)}
                  onChange={(t) => setAt(`${at.slice(0, 10)}T${t}`)}
                  aria-label="Útvonaltervezés időpontja"
                  className="w-24"
                />
              </div>
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
              {past ? (
                <History className={loading ? "animate-pulse" : undefined} />
              ) : (
                <Zap className={loading ? "animate-pulse" : undefined} />
              )}
              {loading ? "Keresés…" : past ? "Történeti becslés" : "Útvonal keresése"}
            </Button>
          </div>

          {past ? (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Ez az időpont a múltban van — az élő MVK-tervező helyett a saját
              mért menetidő- és késésadatainkból becslünk.
            </p>
          ) : null}

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

        {historic ? (
          <ChartFrame
            title="Történeti becslés"
            hint={`${fromPlace?.name} → ${toPlace?.name}`}
          >
            <HistoricCard est={historic} />
          </ChartFrame>
        ) : null}
      </div>
    </div>
  );
}
