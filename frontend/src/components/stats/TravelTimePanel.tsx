import { useMemo, useState } from "react";
import { ArrowDown, ArrowRightLeft, Zap } from "lucide-react";
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

function StopSelect({
  label,
  stops,
  value,
  onChange,
}: {
  label: string;
  stops: Stop[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [text, setText] = useState("");
  // Névre és kódra is keresünk: azonos nevű megállóból több is van, a kód
  // viszont egyedi — ezzel lehet a megfelelőt kiválasztani.
  const matches = useMemo(() => {
    const t = normalizeSearchText(text.trim());
    if (!t) return [];
    return stops
      .filter(
        (s) =>
          normalizeSearchText(s.name).includes(t) ||
          normalizeSearchText(s.code || "").includes(t) ||
          s.id.toLowerCase().includes(t),
      )
      .slice(0, 8);
  }, [text, stops]);
  const selected = stops.find((s) => s.id === value);

  /** Ugyanaz a név többször is előfordul — az irány adja a különbséget. */
  const twinCount = selected
    ? stops.filter((s) => s.name === selected.name).length
    : 0;

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
          <span className="min-w-0">
            <span className="block truncate">{selected.name}</span>
            <span className="block font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
              {selected.id}
              {twinCount > 1 ? ` · ${twinCount} ilyen nevű megálló van` : ""}
            </span>
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
            placeholder="Megálló neve vagy kódja…"
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
                    className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {s.id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export function TravelTimePanel({ stops }: { stops: Stop[] }) {
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
            ? "Nincs közvetlen járat a két megálló között."
            : (e as Error).message,
      );
    } finally {
      setLoading(false);
    }
  };

  const fromStop = stops.find((s) => s.id === from);
  const toStop = stops.find((s) => s.id === to);

  const swap = () => {
    setFrom(to);
    setTo(from);
    setResult(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">
          Mennyi idő A-ból B-be?
        </h2>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <StopSelect
            label="Honnan"
            stops={stops}
            value={from}
            onChange={setFrom}
          />
          <StopSelect label="Hova" stops={stops} value={to} onChange={setTo} />
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-1.5">
            <label
              htmlFor="tt-at"
              className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Mikor
            </label>
            <Input
              id="tt-at"
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
            {loading ? "Számolás…" : "Becslés"}
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
            <strong className="text-foreground">{fromStop?.name}</strong>
            <span className="font-mono tabular-nums">({fromStop?.id})</span>
            <ArrowDown aria-hidden className="h-3 w-3 rotate-[-90deg]" />
            <strong className="text-foreground">{toStop?.name}</strong>
            <span className="font-mono tabular-nums">({toStop?.id})</span>
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
                {result.liveFactor > 1 ? "lassabb" : "gyorsabb"} a szokásosnál (
                {result.liveSamples} friss mérés).
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
  );
}
