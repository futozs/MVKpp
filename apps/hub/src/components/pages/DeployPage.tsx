"use client";
import { GitBranch, RefreshCw, Rocket, ScrollText } from "lucide-react";
import { useState } from "react";
import { api, isErr } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { Commit, GitStatus, Maybe, TaskInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageHeader } from "../shell/Shell";
import { ConfirmDialog, DialogRoot, DialogTitle, Sheet } from "../ui/dialog";
import { Button, Empty, ErrorNote, KeyValue, Loading, Panel, Pill, StatusDot } from "../ui/primitives";
import { TaskConsole } from "./TaskConsole";

type Deploy = {
  git: GitStatus;
  commits: Maybe<Commit[]>;
  previous: Maybe<{ name: string; exitCode: number | null; state: string; createdAt: number }[]>;
  tasks: TaskInfo[];
  running: TaskInfo | null;
  dockerAvailable: boolean;
  deployable: string[];
};
type AuditRow = { id: number; at: string; action: string; target: string | null; ok: boolean; detail: unknown; ip: string | null };

const SERVICE_HINT: Record<string, string> = { worker: "élő motor, push, v2-API", web: "a felület", hub: "ez a pult (utoljára cserélődik)" };

const ACTION_LABEL: Record<string, string> = {
  login: "belépés",
  "token:renew": "token megújítás",
  "token:ingest": "token kézi betöltés",
  "token:reveal": "token megtekintés",
  "agent:command": "agent-parancs",
  "agent:cancel": "agent-parancs visszavonva",
  "mvk:call": "MVK API-hívás",
  "gtfs:reload": "GTFS újratöltés",
  "git:fetch": "git fetch",
  "task:deploy": "telepítés",
  "task:backup": "mentés",
  "task:restore": "visszaállítás",
  "job:run": "feladat indítása",
  "worker:soft-restart": "worker újraindítás",
  "user:delete": "fiók törlése",
  "user:revoke-sessions": "kiléptetés",
  "user:export": "adatexport",
  "user:delete-passkey": "passkey törlése",
  "backup:delete": "mentés törlése",
  "backup:download": "mentés letöltése",
  "backup:upload": "mentés feltöltése",
  "backup:prune": "régi mentések ritkítása",
  "db:cancel": "lekérdezés megszakítása",
  "db:terminate": "kapcsolat bontása",
};

function CommitList({ commits, now }: { commits: Commit[]; now: number }) {
  return (
    <ul className="divide-y divide-border">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-baseline gap-3 py-2 text-[12.5px]">
          <span className="shrink-0 font-mono text-primary">{c.short}</span>
          <span className="min-w-0 flex-1 truncate" title={c.subject}>
            {c.subject}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {c.author} · {ago(c.date, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AuditLog({ now }: { now: number }) {
  const { data, error } = useHub<{ rows: AuditRow[] }>("/api/audit?limit=150", 30_000);
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  if (!data.rows.length) return <Empty>Még nincs bejegyzés.</Empty>;
  return (
    <div className="max-h-[520px] overflow-y-auto">
      <ul className="divide-y divide-border">
        {data.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-[12.5px]">
            <StatusDot tone={r.ok ? "ok" : "crit"} />
            <span className="font-semibold">{ACTION_LABEL[r.action] ?? r.action.replace(/^container:/, "konténer: ")}</span>
            {r.target ? <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{r.target}</span> : null}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground" title={dateTime(r.at)}>
              {r.ip ?? ""} · {ago(r.at, now)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DeployPage() {
  const { data, error, isLoading, refetch } = useHub<Deploy>("/api/deploy", 15_000);
  const now = useNow(30_000);
  const { busy, run } = useAction();
  const [services, setServices] = useState<string[]>(["worker", "web", "hub"]);
  const [pull, setPull] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ name: string; lines: string[] } | null>(null);

  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const g = data.git;
  const active = taskId ?? (data.running?.kind === "deploy" ? data.running.id : null);

  const start = async () => {
    const r = await run<{ taskId: string }>("deploy", "/api/deploy/run", { pull, services });
    if (r) setTaskId(r.taskId);
  };

  return (
    <>
      <PageHeader
        title="Telepítés"
        lead="Frissítés a gitből és újratelepítés egy gombnyomással. A telepítés egy külön segédkonténerben fut (git pull → build → worker és web cseréje → egészség-ellenőrzés → a hub cseréje), így akkor is végigmegy, ha a pult közben újraindul."
        actions={
          <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} busy={busy === "fetch"} onClick={() => void run("fetch", "/api/deploy/fetch", {}, { success: "frissítések lekérdezve", refresh: ["/api/deploy", "/api/overview"] })}>
            Frissítések keresése
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Panel title="Forráskód" className="xl:col-span-2">
          {g.available ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-[13px] font-semibold">{g.branch}</span>
                {g.behind ? <Pill tone="info">{g.behind} új commit</Pill> : <Pill tone="ok">naprakész</Pill>}
                {g.ahead ? <Pill tone="warn">{g.ahead} nem feltöltött</Pill> : null}
                {g.dirty?.length ? <Pill tone="warn">{g.dirty.length} helyi módosítás</Pill> : null}
              </div>
              <KeyValue
                rows={[
                  ["most fut", g.head ? `${g.head.short} · ${ago(g.head.date, now)}` : "–"],
                  ["upstream", g.upstream ?? "nincs beállítva"],
                  ["utolsó ellenőrzés", g.lastFetchAt ? ago(g.lastFetchAt, now) : "még nem volt"],
                ]}
              />
              {g.head ? <p className="mt-3 text-[12.5px]">{g.head.subject}</p> : null}
              {g.dirty?.length ? (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-nosignal">helyi módosítások (a git pull ezeket nem írja felül — ütközésnél leáll)</summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-background/60 p-2 font-mono text-[11px] text-muted-foreground">{g.dirty.join("\n")}</pre>
                </details>
              ) : null}
            </>
          ) : (
            <ErrorNote error={g.reason ?? "a repó nem érhető el"} />
          )}
        </Panel>

        <Panel title="Újratelepítés" className="xl:col-span-3">
          {!data.dockerAvailable ? <ErrorNote className="mb-3" error="A telepítéshez a hubnak Dockerben kell futnia, felcsatolt docker.sock-kal és repóval." /> : null}
          <div className="flex flex-wrap gap-2">
            {data.deployable.map((s) => {
              const on = services.includes(s);
              return (
                <button
                  key={s}
                  aria-pressed={on}
                  onClick={() => setServices((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))}
                  className={cn("rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", on ? "border-signal-700 bg-accent" : "border-border bg-background/40 opacity-70 hover:opacity-100")}
                >
                  <div className="text-[13px] font-semibold">{s}</div>
                  <div className="text-[11px] text-muted-foreground">{SERVICE_HINT[s]}</div>
                </button>
              );
            })}
          </div>
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} className="accent-[hsl(var(--primary))]" />
            előtte <span className="font-mono">git pull --ff-only</span> {g.behind ? <span className="text-early">({g.behind} új commit jön)</span> : null}
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" icon={<Rocket className="h-3.5 w-3.5" />} disabled={!services.length || !data.dockerAvailable || Boolean(data.running)} busy={busy === "deploy"} onClick={() => setConfirm(true)}>
              {pull ? "Frissítés és újratelepítés" : "Újratelepítés"}
            </Button>
          </div>
          {data.running && !active ? <p className="mt-2 text-xs text-nosignal">Épp fut: {data.running.title}</p> : null}
          {active ? <TaskConsole className="mt-4" taskId={active} onDone={() => void refetch()} /> : null}
        </Panel>

        {g.incoming?.length ? (
          <Panel title="Érkező változások" hint={`${g.upstream} → most`} className="xl:col-span-5">
            <CommitList commits={g.incoming} now={now} />
          </Panel>
        ) : null}

        <Panel title="Korábbi telepítések" hint="a segédkonténerek (az utolsó 5)" className="xl:col-span-2">
          {!isErr(data.previous) && data.previous.length ? (
            <ul className="divide-y divide-border">
              {data.previous.map((p) => (
                <li key={p.name} className="flex items-center gap-3 py-2 text-[12.5px]">
                  <StatusDot tone={p.state === "running" ? "info" : p.exitCode === 0 ? "ok" : "crit"} />
                  <span className="min-w-0 flex-1 truncate">{dateTime(p.createdAt)}</span>
                  <span className="text-xs text-muted-foreground">{p.state === "running" ? "fut" : p.exitCode === 0 ? "sikeres" : `hiba (${p.exitCode})`}</span>
                  <Button size="sm" variant="ghost" icon={<ScrollText className="h-3.5 w-3.5" />} onClick={() => void api<{ lines: string[] }>(`/api/deploy/history/${p.name}`).then((r) => setHistory({ name: p.name, lines: r.lines }))}>
                    napló
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Még nem volt telepítés a hubból.</Empty>
          )}
        </Panel>
        <Panel title="Legutóbbi commitok" className="xl:col-span-3">
          {!isErr(data.commits) ? <CommitList commits={data.commits} now={now} /> : <ErrorNote error={data.commits} />}
        </Panel>
        <Panel title="Műveleti napló" hint="minden beavatkozás a hubból: ki (honnan), mit, mikor, sikerült-e" className="xl:col-span-5">
          <AuditLog now={now} />
        </Panel>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={pull ? "Frissítés és újratelepítés" : "Újratelepítés"}
        description={`Újraépül és cserélődik: ${services.join(", ")}. A worker és a web cseréje alatt pár másodperc kiesés lehet${services.includes("hub") ? "; a pult a végén újraindul, utána töltsd újra az oldalt" : ""}.`}
        confirmLabel="Indítás"
        onConfirm={start}
      />
      <DialogRoot open={history != null} onOpenChange={(o) => !o && setHistory(null)}>
        <Sheet wide>
          <DialogTitle className="text-base font-semibold">Telepítési napló</DialogTitle>
          <pre className="mt-3 max-h-[60vh] overflow-auto rounded-xl bg-background/70 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{history?.lines.join("\n") || "(üres)"}</pre>
        </Sheet>
      </DialogRoot>
    </>
  );
}
