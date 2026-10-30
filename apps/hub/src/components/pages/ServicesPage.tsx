"use client";
import { Play, Power, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { isErr } from "@/lib/api";
import { ago, duration, num, num1 } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { Container, Maybe, WebMetrics, WorkerMetrics } from "@/lib/types";
import { PageHeader } from "../shell/Shell";
import { ConfirmDialog } from "../ui/dialog";
import { Button, ErrorNote, KeyValue, Loading, Meter, Panel, Pill, StatusDot, type Tone } from "../ui/primitives";

type Services = {
  dockerAvailable: boolean;
  containers: Maybe<Container[]> | null;
  docker: Maybe<{ serverVersion: string; os: string; kernel: string; cpus: number; memGb: number; containersRunning: number; images: number }> | null;
  volumes: Maybe<{ volumes: { name: string; sizeMb: number }[]; imagesMb: number; buildCacheMb: number }> | null;
  worker: Maybe<WorkerMetrics>;
  web: Maybe<WebMetrics>;
};

type Pending = { name: string; service: string; action: "start" | "stop" | "restart" } | null;

const ROLE: Record<string, string> = {
  worker: "MVK-pollozás, illesztés, WebSocket, push, v2-API",
  web: "Next.js felület és /v3 API",
  db: "Postgres + TimescaleDB + PostGIS",
  caddy: "HTTPS, a nyilvános belépési pont",
  hub: "ez a pult",
  redis: "gyorsítótár",
};

function containerTone(c: Container): Tone {
  if (c.state !== "running") return "crit";
  if (c.health === "unhealthy") return "crit";
  if (c.health === "starting") return "warn";
  return "ok";
}

function ContainerCard({ c, now, onAction, busy }: { c: Container; now: number; onAction: (a: "start" | "stop" | "restart") => void; busy: boolean }) {
  const s = c.stats && !isErr(c.stats) ? c.stats : null;
  const tone = containerTone(c);
  return (
    <div className="rounded-2xl border border-border bg-background/40 p-4">
      <div className="flex items-start gap-3">
        <StatusDot tone={tone} pulse={tone === "ok"} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-bold tracking-tight">{c.service || c.name}</span>
            <Pill tone={tone}>{c.state === "running" ? (c.health ?? "fut") : c.state}</Pill>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{ROLE[c.service] ?? c.image}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
        <div>
          <div className="mb-1 flex justify-between text-muted-foreground">
            <span>CPU</span>
            <span className="font-mono text-foreground">{s ? `${num1(s.cpuPct)}%` : "–"}</span>
          </div>
          <Meter value={s?.cpuPct ?? 0} max={100} tone={(s?.cpuPct ?? 0) > 85 ? "warn" : "ok"} label="CPU" />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-muted-foreground">
            <span>memória</span>
            <span className="font-mono text-foreground">{s ? `${num(Math.round(s.memMb))} MB` : "–"}</span>
          </div>
          <Meter value={s?.memPct ?? 0} max={100} tone={(s?.memPct ?? 0) > 85 ? "warn" : "ok"} label="memória" />
        </div>
      </div>
      <KeyValue
        className="mt-3"
        rows={[
          ["állapot", c.status],
          ["konténer", c.name],
          ["létrehozva", ago(c.createdAt, now)],
          ...(s ? ([["hálózat ↓/↑", `${num1(s.netRxMb)} / ${num1(s.netTxMb)} MB`], ["lemez olv./ír.", `${num1(s.blockReadMb)} / ${num1(s.blockWriteMb)} MB`], ["folyamatok", num(s.pids)]] as [string, string][]) : []),
          ...(c.ports.length ? ([["portok", c.ports.join(", ")]] as [string, string][]) : []),
        ]}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} busy={busy} onClick={() => onAction("restart")} disabled={c.state !== "running"}>
          Újraindítás
        </Button>
        {c.state === "running" ? (
          c.service !== "hub" ? (
            <Button size="sm" variant="ghost" icon={<Square className="h-3.5 w-3.5" />} onClick={() => onAction("stop")}>
              Leállítás
            </Button>
          ) : null
        ) : (
          <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => onAction("start")}>
            Indítás
          </Button>
        )}
      </div>
    </div>
  );
}

function ProcessPanel({ title, m, extra }: { title: string; m: Maybe<WorkerMetrics> | Maybe<WebMetrics>; extra?: [string, string][] }) {
  if (isErr(m)) return <Panel title={title}><ErrorNote error={m} /></Panel>;
  const p = m.process;
  return (
    <Panel title={title} hint={`Node ${p.nodeVersion}`}>
      <KeyValue
        rows={[
          ["fut", duration(p.uptimeSec)],
          ["memória (RSS)", `${p.memory.rssMb} MB`],
          ["heap", `${p.memory.heapUsedMb} / ${p.memory.heapTotalMb} MB`],
          ...(extra ?? []),
        ]}
      />
    </Panel>
  );
}

export function ServicesPage() {
  const { data, error, isLoading } = useHub<Services>("/api/services", 10_000);
  const now = useNow(5000);
  const { busy, run } = useAction();
  const [pending, setPending] = useState<Pending>(null);
  const [softRestart, setSoftRestart] = useState(false);

  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const w = isErr(data.worker) ? null : data.worker;
  const containers = data.containers && !isErr(data.containers) ? data.containers : null;

  const doAction = async () => {
    if (!pending) return;
    const verb = pending.action === "restart" ? "újraindítva" : pending.action === "stop" ? "leállítva" : "elindítva";
    await run(`${pending.name}:${pending.action}`, `/api/services/${encodeURIComponent(pending.name)}/${pending.action}`, {}, { success: `${pending.service || pending.name} ${verb}`, refresh: ["/api/services", "/api/overview"] });
  };

  return (
    <>
      <PageHeader
        title="Szolgáltatások"
        lead="A Docker Compose-projekt minden konténere élő erőforrás-használattal. Újraindítás, leállítás, indítás innen — minden lépés a műveleti naplóba kerül."
        actions={
          <Button size="sm" icon={<Power className="h-3.5 w-3.5" />} onClick={() => setSoftRestart(true)} busy={busy === "soft"}>
            Worker gyors újraindítása
          </Button>
        }
      />

      {!data.dockerAvailable ? (
        <ErrorNote className="mb-5" error="A hub nem látja a Docker socketet (/var/run/docker.sock) — a konténerek kezelése nem érhető el. Fejlesztéskor ez normális; élesben a compose felcsatolja." />
      ) : null}

      {containers ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {containers.map((c) => (
            <ContainerCard key={c.id} c={c} now={now} busy={busy === `${c.name}:restart`} onAction={(action) => setPending({ name: c.name, service: c.service, action })} />
          ))}
        </div>
      ) : data.containers && isErr(data.containers) ? (
        <ErrorNote error={data.containers} />
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <ProcessPanel
          title="Worker folyamat"
          m={data.worker}
          extra={w ? [["CPU", `${w.process.cpuPct}%`], ["event loop átlag / p99", `${w.process.eventLoop.meanMs} / ${w.process.eventLoop.p99Ms} ms`], ["WebSocket kliensek", num(w.ws.clients)], ["kiküldött üzenetek", num(w.ws.messages)], ["írási sor / hibák", `${w.persist.pending} / ${w.persist.errors}`], ["gyorsítótár", w.cache.backend === "redis" ? `Redis (${w.cache.redis ?? "?"})` : "csak memória"]] : undefined}
        />
        <ProcessPanel title="Web folyamat" m={data.web} />
        <Panel title="Docker gazdagép">
          {data.docker && !isErr(data.docker) ? (
            <KeyValue
              rows={[
                ["Docker", data.docker.serverVersion],
                ["rendszer", data.docker.os],
                ["CPU / RAM", `${data.docker.cpus} mag · ${data.docker.memGb} GB`],
                ["futó konténer", num(data.docker.containersRunning)],
                ["image-ek", `${data.docker.images} db${data.volumes && !isErr(data.volumes) ? ` · ${num(Math.round(data.volumes.imagesMb))} MB` : ""}`],
                ...(data.volumes && !isErr(data.volumes) ? data.volumes.volumes.map((v) => [`kötet: ${v.name}`, `${num(Math.round(v.sizeMb))} MB`] as [string, string]) : []),
              ]}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Docker nélkül nincs gazdagép-adat.</p>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={pending != null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? `${pending.service || pending.name}: ${pending.action === "restart" ? "újraindítás" : pending.action === "stop" ? "leállítás" : "indítás"}` : ""}
        description={
          pending?.service === "db"
            ? "Az adatbázis újraindítása alatt a worker és a web pár másodpercig hibát kap, majd újracsatlakozik."
            : pending?.service === "hub"
              ? "A pult pár másodpercre eltűnik, utána töltsd újra az oldalt."
              : pending?.action === "stop"
                ? "A szolgáltatás leáll, és csak kézi indításra jön vissza."
                : "Pár másodperces kiesés, a Docker visszaindítja."
        }
        confirmLabel={pending?.action === "stop" ? "Leállítás" : pending?.action === "start" ? "Indítás" : "Újraindítás"}
        danger={pending?.action === "stop" || pending?.service === "db"}
        requireText={pending?.action === "stop" ? pending.service || pending.name : undefined}
        onConfirm={doAction}
      />
      <ConfirmDialog
        open={softRestart}
        onOpenChange={setSoftRestart}
        title="Worker gyors újraindítása"
        description="A worker kilép, a Docker (vagy a fejlesztői futtató) azonnal újraindítja. Docker nélkül is működik."
        confirmLabel="Újraindítás"
        onConfirm={() => run("soft", "/api/worker/soft-restart", {}, { success: "a worker újraindul", refresh: ["/api/services"] })}
      />
    </>
  );
}
