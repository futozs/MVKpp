import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { PredictionGuess, PredictionTrip } from "@/services/statsApi";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyChart } from "@/components/charts/Charts";
import { cn, normalizeSearchText } from "@/lib/utils";
import { PillPicker } from "./PanelState";

type Verdict = "all" | "hit" | "mixed" | "miss";
const PAGE = 60;

/** menetrendi idő a szolgáltatási nap kezdetétől: „19:12” (éjfél után is 0–23) */
export const hm = (sec: number) =>
  `${Math.floor(sec / 3600) % 24}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;

export function RoutePill({
  route,
  color,
  text,
}: {
  route: string;
  color: string | null;
  text: string | null;
}) {
  return (
    <span
      className="inline-flex h-[18px] min-w-[26px] shrink-0 items-center justify-center rounded-[5px] px-1 font-mono text-[11px] font-bold leading-none tabular-nums"
      style={{
        background: `#${color ?? "64748B"}`,
        color: `#${text ?? "FFFFFF"}`,
      }}
    >
      {route}
    </span>
  );
}

const verdictOf = (t: PredictionTrip): Exclude<Verdict, "all"> => {
  const hits = t.guesses.filter((g) => g.ok).length;
  return hits === t.guesses.length ? "hit" : hits === 0 ? "miss" : "mixed";
};

function GuessChip({ g }: { g: PredictionGuess }) {
  return (
    <span
      title={`${g.h} perccel indulás előtt: ${g.v} (${Math.round(g.c * 100)}% bizonyosság) — ${g.ok ? "talált" : "tévedett"}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none",
        g.ok ? "border-ontime/35 bg-ontime/10" : "border-late/35 bg-late/10",
      )}
    >
      {g.ok ? (
        <Check aria-hidden className="h-3 w-3 text-ontime" />
      ) : (
        <X aria-hidden className="h-3 w-3 text-late" />
      )}
      <span className="text-muted-foreground">{g.h}′</span>
      <span
        className={cn(
          "font-mono font-semibold tabular-nums text-foreground",
          !g.ok && "line-through decoration-late/60",
        )}
      >
        {g.v}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {Math.round(g.c * 100)}%
      </span>
      <span className="sr-only">{g.ok ? "talált" : "tévedett"}</span>
    </span>
  );
}

/** Menetenként: mit jósoltunk 30 / 15 / 5 perccel előtte, és ki vitte valójában. */
export function PredictionTripList({
  trips,
  query,
  onQueryChange,
  multiDay,
}: {
  trips: PredictionTrip[];
  query: string;
  onQueryChange: (q: string) => void;
  multiDay: boolean;
}) {
  const [verdict, setVerdict] = useState<Verdict>("all");
  const [shown, setShown] = useState(PAGE);

  const searched = useMemo(() => {
    const q = normalizeSearchText(query.trim());
    if (!q) return trips;
    return trips.filter(
      (t) =>
        t.actual.includes(q) ||
        t.guesses.some((g) => g.v.includes(q)) ||
        normalizeSearchText(t.route_short) === q ||
        normalizeSearchText(t.headsign ?? "").includes(q),
    );
  }, [trips, query]);

  const counts = useMemo(() => {
    const c = { all: searched.length, hit: 0, mixed: 0, miss: 0 };
    for (const t of searched) c[verdictOf(t)]++;
    return c;
  }, [searched]);

  const rows =
    verdict === "all"
      ? searched
      : searched.filter((t) => verdictOf(t) === verdict);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => {
              onQueryChange(e.target.value);
              setShown(PAGE);
            }}
            placeholder="Rendszám, vonal vagy cél"
            aria-label="Jóslatok szűrése rendszámra, vonalra vagy célállomásra"
            className="pl-9 pr-9"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Keresés törlése"
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <PillPicker<Verdict>
          ariaLabel="Kimenetel szerint"
          value={verdict}
          onChange={(v) => {
            setVerdict(v);
            setShown(PAGE);
          }}
          items={[
            { id: "all", label: "Mind", sub: String(counts.all) },
            { id: "hit", label: "Talált", sub: String(counts.hit) },
            { id: "mixed", label: "Részben", sub: String(counts.mixed) },
            { id: "miss", label: "Tévedett", sub: String(counts.miss) },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyChart>
          {query
            ? `Nincs „${query}” jóslat ebben az időszakban.`
            : "Ebben az időszakban nincs ilyen jóslat."}
        </EmptyChart>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.slice(0, shown).map((t) => {
            const v = verdictOf(t);
            return (
              <li
                key={`${t.date}|${t.trip_id}`}
                className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="row-span-2 self-start sm:row-span-1 sm:self-center">
                  <p className="font-mono text-[13px] font-semibold tabular-nums leading-none">
                    {hm(t.sched_start_s)}
                  </p>
                  {multiDay ? (
                    <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                      {t.date.slice(5).replace("-", ".")}.
                    </p>
                  ) : null}
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <RoutePill
                    route={t.route_short}
                    color={t.color}
                    text={t.text_color}
                  />
                  <span className="min-w-0 truncate text-[12.5px] font-medium">
                    {t.headsign ?? "—"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  {t.guesses.map((g) => (
                    <GuessChip key={g.h} g={g} />
                  ))}
                  <span
                    className={cn(
                      "ml-0.5 inline-flex items-center gap-1 text-[11px]",
                      v === "hit"
                        ? "text-ontime"
                        : v === "miss"
                          ? "text-late"
                          : "text-muted-foreground",
                    )}
                  >
                    vitte:{" "}
                    <span className="font-mono font-semibold tabular-nums text-foreground">
                      {t.actual}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > shown ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShown((n) => n + PAGE)}
          >
            További {Math.min(PAGE, rows.length - shown)} menet (
            {rows.length - shown} van még)
          </Button>
        </div>
      ) : null}
    </div>
  );
}
