import { useCallback } from "react";
import { BrainCircuit } from "lucide-react";
import { API_BASE } from "@/lib/apiBase";
import { cn } from "@/lib/utils";
import { QueryBoundary } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";

type Bucket = {
  n: number;
  maeBaseline: number;
  maeModel: number;
  coverBaseline: number;
  coverModel: number;
  useMedian: boolean;
  useUpper: boolean;
};
type Report = { rows: { train: number; test: number }; days: { train: string[]; test: string[] }; buckets: Record<string, Bucket>; cells?: Record<string, { useMedian: boolean; maeBaseline: number; maeModel: number }>; overall: { maeBaseline: number; maeModel: number; improvement: number } };
type Status = {
  inUse: { trainedAt: string | null; report: Report | null; stats: { model: number; formula: number; errors: number } };
  lastTraining: { trainedAt: string; accepted: boolean; report: Report } | null;
};

// (a JSON-mező a kulcsokat átrendezi  a horizontok sorrendje rögzített)
const ORDER = ["1-3", "4-6", "7-10", "11-15", "16+"];
const HORIZON_LABEL: Record<string, string> = { "1-3": "1–3", "4-6": "4–6", "7-10": "7–10", "11-15": "11–15", "16+": "16+" };
const DT = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

async function load(): Promise<Status> {
  const r = await fetch(`${API_BASE}/engine/ml/status`);
  if (!r.ok) throw new Error(`Hiba (${r.status})`);
  return (await r.json()) as Status;
}

/**
 * A késés-előrejelzés modellje: mi becsül most (tanított modell vagy a képlet),
 * és a legutóbbi tanítás visszamérése a sosem látott tesztnapokon.
 */
export function ForecastModelCard() {
  const q = useStatsQuery(useCallback(load, []), []);
  return (
    <section className="space-y-3">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight sm:text-xl">
          <BrainCircuit className="h-5 w-5 text-primary" aria-hidden /> Késés-előrejelzés
        </h2>
        <p className="mt-0.5 max-w-3xl text-[12.5px] text-muted-foreground">
          Tanított modell (kvantilis gradient boosting): a mostani forgalmat, az előtte járó buszt, a busz késés-trendjét és az időjárást is nézi. Éjszakánként újratanul, és csak ott becsül, ahol a
          tanításból kihagyott napokon bizonyítottan pontosabb a régi képletnél.
        </p>
      </header>
      <QueryBoundary query={q}>
        {(d) => {
          const rep = d.inUse.report ?? d.lastTraining?.report ?? null;
          const active = Boolean(d.inUse.trainedAt);
          if (!rep)
            return (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                Még nincs tanított modell  a képlet becsül. Az első tanítás a worker indulása után pár perccel, utána minden éjjel fut.
              </p>
            );
          const weak = Object.entries(rep.cells ?? {}).filter(([, c]) => !c.useMedian);
          return (
            <div className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <p className="text-sm">
                  <span className={cn("mr-2 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-bold", active ? "bg-ontime/15 text-ontime" : "bg-muted text-muted-foreground")}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-ontime" : "bg-muted-foreground")} />
                    {active ? "Modell becsül" : "Képlet becsül"}
                  </span>
                  átlagos hiba <b className="font-mono">{rep.overall.maeBaseline} mp</b> → <b className="font-mono text-ontime">{rep.overall.maeModel} mp</b>{" "}
                  <span className="text-muted-foreground">({rep.overall.improvement}% pontosabb)</span>
                </p>
                <p className="text-[12px] text-muted-foreground">
                  tanítva {d.inUse.trainedAt ? DT.format(new Date(d.inUse.trainedAt)) : ""} · {rep.days.train.length} nap, {rep.rows.train.toLocaleString("hu-HU")} minta · teszt: {rep.days.test.length} sosem látott nap
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-[12.5px]">
                  <thead className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="py-1.5 pr-3 font-semibold">Megálló előre</th>
                      <th className="py-1.5 pr-3 font-semibold">Képlet hibája</th>
                      <th className="py-1.5 pr-3 font-semibold">Modell hibája</th>
                      <th className="py-1.5 pr-3 font-semibold">„Legkésőbb” tart</th>
                      <th className="py-1.5 font-semibold">Becslő</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {Object.entries(rep.buckets)
                      .sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b))
                      .map(([id, b]) => (
                      <tr key={id} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-3 font-sans font-semibold">{HORIZON_LABEL[id] ?? id}</td>
                        <td className="py-1.5 pr-3">{b.maeBaseline} mp</td>
                        <td className={cn("py-1.5 pr-3", b.maeModel < b.maeBaseline && "font-bold text-ontime")}>{b.maeModel} mp</td>
                        <td className="py-1.5 pr-3">
                          {Math.round(b.coverModel * 100)}% <span className="text-muted-foreground">(képlet {Math.round(b.coverBaseline * 100)}%)</span>
                        </td>
                        <td className="py-1.5 font-sans">{b.useMedian ? "modell" : "képlet"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {weak.length ? (
                <p className="text-[11.5px] text-muted-foreground">
                  A képlet marad itt (a modell nem volt legalább 3%-kal jobb): {weak.map(([k]) => k.replace("|", " · ")).join(", ")}.
                </p>
              ) : null}
            </div>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
