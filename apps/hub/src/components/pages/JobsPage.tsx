"use client";
import { Play } from "lucide-react";
import { isErr } from "@/lib/api";
import { ago, dateTime, duration } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { Maybe } from "@/lib/types";
import { PageHeader } from "../shell/Shell";
import { Button, Empty, ErrorNote, Loading, Panel, Pill, StatusDot, type Tone } from "../ui/primitives";

type Run = { job: string; startedAt: number; finishedAt: number | null; ok: boolean | null; note: string | null };
type Jobs = {
  schedules: Maybe<{ name: string; cron: string; timezone: string | null }[]>;
  recent: Maybe<{ name: string; state: string; n: number }[]>;
  lastRuns: Maybe<{ name: string; state: string; startedOn: string; completedOn: string | null; seconds: number | null; output: string | null }[]>;
  jobState: Maybe<{ job: string; lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null }[]>;
  runs: Maybe<{ jobs: string[]; running: string[]; runs: Run[] }>;
  ml: Maybe<Record<string, unknown>>;
  predictor: Maybe<Record<string, unknown>>;
};

const JOBS: { id: string; title: string; detail: string }[] = [
  { id: "gtfs-refresh", title: "GTFS-ellenőrzés", detail: "új menetrend keresése az MVK-nál (30 percenként magától)" },
  { id: "incidents", title: "Tegnapi üzemzavarok", detail: "az előző nap kimaradásainak, késéseinek újraszámolása" },
  { id: "predictor-learn", title: "Rendszám-előrejelző tanítása", detail: "a forda-terv súlyai az elmúlt napokból" },
  { id: "forecast-load", title: "Szakaszidő-profilok", detail: "a késés-előrejelzés alapadatai (28 nap)" },
  { id: "ml-train", title: "Késés-modell tanítása", detail: "GBDT újratanítás külön szálon; csak bizonyítottan jobb modell élesedik" },
  { id: "nightly", title: "Éjszakai csomag most", detail: "üzemzavarok + előrejelző + profilok + modell (03:40-kor magától)" },
];

const STATE_TONE: Record<string, Tone> = { completed: "ok", failed: "crit", active: "info", created: "warn", retry: "warn", cancelled: "idle" };

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-72 overflow-auto rounded-xl bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{JSON.stringify(value, null, 2)}</pre>;
}

export function JobsPage() {
  const { data, error, isLoading } = useHub<Jobs>("/api/jobs", 5_000);
  const now = useNow(5000);
  const { busy, run } = useAction();
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const runs = isErr(data.runs) ? null : data.runs;

  return (
    <>
      <PageHeader title="Feladatok" lead="Az ütemezett munkák (pg-boss) és a tanuló modellek. Bármelyik indítható most is — a futás a workerben történik, az eredmény alább látszik." />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {JOBS.map((j) => {
          const running = runs?.running.includes(j.id);
          const last = runs?.runs.find((r) => r.job === j.id);
          return (
            <div key={j.id} className="flex flex-col rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <StatusDot tone={running ? "info" : last ? (last.ok ? "ok" : "crit") : "idle"} pulse={running} />
                <span className="text-[14px] font-bold">{j.title}</span>
              </div>
              <p className="mt-1 flex-1 text-xs text-muted-foreground">{j.detail}</p>
              {last ? (
                <p className="mt-2 text-xs">
                  <span className={last.ok === false ? "text-late" : "text-muted-foreground"}>{last.finishedAt ? `${ago(last.finishedAt, now)}: ${last.note ?? ""}` : "fut…"}</span>
                </p>
              ) : null}
              <Button size="sm" className="mt-3 self-start" icon={<Play className="h-3.5 w-3.5" />} busy={busy === j.id || running} onClick={() => void run(j.id, "/api/jobs/run", { job: j.id }, { success: `${j.title}: elindítva`, refresh: ["/api/jobs"] })}>
                Indítás most
              </Button>
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Ütemezés (pg-boss)">
          {isErr(data.schedules) ? (
            <ErrorNote error={data.schedules} />
          ) : (
            <ul className="divide-y divide-border">
              {data.schedules.map((s) => {
                const last = isErr(data.lastRuns) ? undefined : data.lastRuns.find((r) => r.name === s.name);
                return (
                  <li key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                    <span className="font-semibold">{s.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {s.cron} {s.timezone ?? ""}
                    </span>
                    {last ? (
                      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                        <Pill tone={STATE_TONE[last.state] ?? "idle"}>{last.state}</Pill>
                        {ago(last.startedOn, now)}
                        {last.seconds != null ? ` · ${duration(last.seconds)}` : ""}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Futások (2 nap)" hint="pg-boss állapotonként">
          {isErr(data.recent) ? <ErrorNote error={data.recent} /> : data.recent.length ? (
            <ul className="space-y-1.5 text-[12.5px]">
              {data.recent.map((r) => (
                <li key={`${r.name}-${r.state}`} className="flex items-center gap-2">
                  <Pill tone={STATE_TONE[r.state] ?? "idle"}>{r.state}</Pill>
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="font-mono text-muted-foreground">{r.n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nincs futás.</Empty>
          )}
          {!isErr(data.jobState) && data.jobState.length ? (
            <ul className="mt-4 space-y-1 border-t border-border pt-3 text-xs">
              {data.jobState.map((j) => (
                <li key={j.job} className="flex flex-wrap gap-x-2">
                  <span className="font-semibold">{j.job}</span>
                  <span className="text-muted-foreground">utolsó jó: {j.lastOkAt ? dateTime(j.lastOkAt) : "–"}</span>
                  {j.lastError ? <span className="text-late">hiba: {j.lastError}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
        <Panel title="Késés-modell (ML)" hint="/engine/ml/status">
          {isErr(data.ml) ? <ErrorNote error={data.ml} /> : <Json value={data.ml} />}
        </Panel>
        <Panel title="Rendszám-előrejelző" hint="/engine/predict/status">
          {isErr(data.predictor) ? <ErrorNote error={data.predictor} /> : <Json value={data.predictor} />}
        </Panel>
      </div>
    </>
  );
}
