import { useMemo, useState } from "react";
import { ArrowDown, ArrowRightLeft, MapPin, Zap } from "lucide-react";
import type { Stop } from "@/types";
import {
  StatsUnavailableError,
  statsApi,
  type SegmentEstimate,
} from "@/services/statsApi";
import { ChartFrame, StatTile } from "@/components/charts/Charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, normalizeSearchText } from "@/lib/utils";

const fmtMin = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} p ${s} mp` : `${m} perc`;
};

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Egy „hely" a megállók nevéből képzett lista — ugyanaz a név (pl.
 * „Cementgyár") a valóságban több megállót takarhat (mindkét irány,
 * több peron), de a felhasználónak ez egy hely. A kereséshez elég egy
 * reprezentáns stopId, a szerver a `/stats/segment` végponton amúgy is
 * minden azonos nevű megállót összevon (lásd `sameNameStopIds`).
 */
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
 * mennyi idő alatt lehet eljutni A-ból B-be, a mért (nem csak menetrendi)
 * adatok alapján. Korábban a statisztika oldal „Menetidő A→B" füle volt,
 * onnan ide költözött, mert ott csak pontos megállónevet fogadott el.
 */
export function RoutePlannerView({ stops }: { stops: Stop[] }) {
  const places = usePlaces(stops);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [at, setAt] = useState(nowLocalInput());
  const [result, setResult] = useState<SegmentEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const iso = new Date(at).toISOString();
      setResult(await statsApi.segment(from, to, iso));
    } catch (e) {
      setError(
        e instanceof StatsUnavailableError
          ? "Az adatraktár nem érhető el."
          : (e as Error).message.includes("404")
            ? "Nincs közvetlen járat a két hely között."
            : (e as Error).message,
      );
    } finally {
      setLoading(false);
    }
  };

  const fromPlace = places.find((s) => s.id === from);
  const toPlace = places.find((s) => s.id === to);

  const swap = () => {
    setFrom(to);
    setTo(from);
    setResult(null);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
        <div>
          <h1 className="text-lg font-bold tracking-tight sm:text-xl">
            Útvonaltervező
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Mennyi idő alatt érsz A-ból B-be — a tényleges, mért menetidők
            alapján, nem csak a menetrend szerint.
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
            <Button onClick={run} disabled={!from || !to || loading}>
              <Zap className={loading ? "animate-pulse" : undefined} />
              {loading ? "Számolás…" : "Útvonal keresése"}
            </Button>
          </div>

          {error ? (
            <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        {result ? (
          <div className="space-y-4">
            {}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <strong className="text-foreground">{fromPlace?.name}</strong>
              <ArrowDown aria-hidden className="h-3 w-3 rotate-[-90deg]" />
              <strong className="text-foreground">{toPlace?.name}</strong>
            </p>

            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              <StatTile label="Menetrend szerint" value={fmtMin(result.schedS)} />
              <StatTile
                label="Szokásos (p50)"
                value={fmtMin(result.p50S)}
                sub={
                  result.samples ? `${result.samples} mérésből` : "nincs mérés"
                }
                tone={result.p50S > result.schedS * 1.1 ? "late" : "ontime"}
              />
              <StatTile
                label="Rossz esetben (p85)"
                value={fmtMin(result.p85S)}
                sub="ennyivel érdemes tervezni"
                tone="late"
              />
              <StatTile
                label="Megbízhatóság"
                value={result.confidence}
                sub={`${result.coverage}% lefedettség`}
                tone={result.confidence === "magas" ? "ontime" : "default"}
              />
            </div>

            {result.liveFactor ? (
              <p className="flex items-start gap-2 rounded-xl border border-live/40 bg-live/10 px-3 py-2 text-xs">
                <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-live" />
                <span>
                  Élő korrekció alkalmazva: a korridor most{" "}
                  <strong>
                    {Math.round((result.liveFactor - 1) * 100)}%-kal
                  </strong>{" "}
                  {result.liveFactor > 1 ? "lassabb" : "gyorsabb"} a
                  szokásosnál ({result.liveSamples} friss mérés).
                </span>
              </p>
            ) : null}

            <ChartFrame
              title="Szakaszonként"
              hint={`${result.stopsBetween} megállóköz · ${result.school ? "tanév" : "szünet"} · ${
                result.daytype === 0
                  ? "munkanap"
                  : result.daytype === 1
                    ? "szombat"
                    : "vasárnap/ünnep"
              }`}
            >
              <ol className="space-y-1">
                {result.legs.map((l, i) => {
                  const over = l.p50S - l.schedS;
                  return (
                    <li
                      key={i}
                      className="grid grid-cols-[1fr_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 odd:bg-muted/30"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">
                          {l.from}{" "}
                          <ArrowDown className="inline h-3 w-3 rotate-[-90deg] opacity-50" />{" "}
                          {l.to}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          terv {Math.round(l.schedS / 60)} p ·{" "}
                          {l.source === "menetrend"
                            ? "nincs mérés"
                            : `${l.samples} mérés`}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 text-xs font-semibold tabular-nums",
                          over > 30
                            ? "text-late"
                            : over < -30
                              ? "text-early"
                              : "text-ontime",
                        )}
                      >
                        {Math.round(l.p50S / 60)} p
                      </span>
                    </li>
                  );
                })}
              </ol>
            </ChartFrame>
          </div>
        ) : null}
      </div>
    </div>
  );
}
