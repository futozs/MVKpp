"use client";
import { AlertOctagon, AlertTriangle, ArrowRight, Info, RefreshCw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { isErr } from "@/lib/api";
import { ago, bytes, duration, ms, num } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { Alert, Overview } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageHeader } from "../shell/Shell";
import { Button, ErrorNote, KeyValue, Loading, Meter, Panel, Pill, Stat, StatusDot, type Tone } from "../ui/primitives";

const SEV: Record<Alert["severity"], { icon: typeof Info; tone: Tone; label: string }> = {
  crit: { icon: AlertOctagon, tone: "crit", label: "hiba" },
  warn: { icon: AlertTriangle, tone: "warn", label: "figyelmeztetés" },
  info: { icon: Info, tone: "info", label: "info" },
};

function Hero({ o, now }: { o: Overview; now: number }) {
  const crit = o.alerts.filter((a) => a.severity === "crit").length;
  const warn = o.alerts.filter((a) => a.severity === "warn").length;
  const w = isErr(o.worker) ? null : o.worker;
  const live = isErr(o.live) ? null : o.live;
  const tone: Tone = crit ? "crit" : warn ? "warn" : "ok";
  const headline = crit ? `${crit} dolog azonnali beavatkozást kér` : warn ? `${warn} dolog figyelmet kér` : "Minden rendszer él";
  const tokenLeft = w?.token.exp ? w.token.exp * 1000 - now : null;
  return (
    <section className="rounded-2xl border border-border bg-card px-5 py-6 sm:px-7 sm:py-7">
      <div className="flex flex-wrap items-center gap-3">
        <StatusDot tone={tone} pulse className="scale-150" />
        <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">{headline}</h2>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Járművek most" value={w ? num(w.poll.vehicles) : "–"} sub={w ? `ma max ${num(w.poll.vehiclesMax)}` : "a worker nem elérhető"} tone={w ? "ok" : "crit"} />
        <Stat label="Fent most" value={live ? num(live.clients) : "–"} sub={live ? `${live.signedIn} bejelentkezve` : "–"} />
        <Stat label="Ma használta" value={o.usage && !isErr(o.usage) ? num(o.usage.today) : "–"} sub="eszköz (webapp)" />
        <Stat
          label="Token hátra"
          value={tokenLeft == null ? "–" : tokenLeft > 0 ? duration(tokenLeft / 1000) : "lejárt"}
          tone={!w ? undefined : !w.token.present || (tokenLeft ?? 0) <= 0 || w.token.rejected ? "crit" : (tokenLeft ?? 0) < 3_600_000 ? "warn" : undefined}
          sub={w?.token.source ? `forrás: ${w.token.source}` : undefined}
        />
        <Stat label="MVK utolsó adat" value={w?.poll.lastOkAt ? `${Math.max(0, Math.round((now - w.poll.lastOkAt) / 1000))} mp` : "–"} sub={w ? `${ms(w.poll.lastMs)} lekérés` : undefined} tone={w && w.poll.lastOkAt && now - w.poll.lastOkAt > 60_000 ? "crit" : undefined} />
        <Stat label="Adatbázis" value={o.db && !isErr(o.db) ? bytes(o.db.bytes) : "–"} sub={o.disk ? `lemez ${o.disk.usedPct}% foglalt` : undefined} />
      </div>
    </section>
  );
}

function Alerts({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <ul className="space-y-2">
      {alerts.map((a) => {
        const s = SEV[a.severity];
        const Icon = s.icon;
        return (
          <li key={a.id}>
            <Link
              href={a.href}
              className={cn(
                "group flex items-start gap-3 rounded-2xl border bg-card px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                a.severity === "crit" ? "border-late/40" : a.severity === "warn" ? "border-nosignal/30" : "border-border",
              )}
            >
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.tone === "crit" ? "text-late" : s.tone === "warn" ? "text-nosignal" : "text-early")} aria-label={s.label} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{a.title}</div>
                {a.detail ? <div className="mt-0.5 text-xs text-muted-foreground">{a.detail}</div> : null}
              </div>
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
      {children} <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

function Services({ o, now }: { o: Overview; now: number }) {
  const w = isErr(o.worker) ? null : o.worker;
  if (isErr(o.containers)) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Docker nélkül fut a hub — csak a worker és a web folyamat látszik.</p>
        <KeyValue rows={[["worker", w ? `fut · ${duration(w.process.uptimeSec)}` : "nem elérhető"], ["web", isErr(o.web) ? "nem elérhető" : `fut · ${duration(o.web.process.uptimeSec)}`]]} />
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {o.containers.map((c) => {
        const tone: Tone = c.state !== "running" ? "crit" : c.health === "unhealthy" ? "crit" : c.health === "starting" ? "warn" : "ok";
        return (
          <li key={c.id} className="flex items-center gap-3 py-2">
            <StatusDot tone={tone} />
            <span className="w-16 shrink-0 text-[13px] font-semibold">{c.service || c.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.status}</span>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{ago(c.createdAt, now)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Probes({ o }: { o: Overview }) {
  if (!o.probes.length) return <p className="text-xs text-muted-foreground">Az első mérés fél percen belül kész.</p>;
  return (
    <ul className="space-y-1.5">
      {o.probes.map((p) => (
        <li key={p.id} className="flex items-center gap-2.5 text-[12.5px]">
          <StatusDot tone={p.ok ? ((p.ms ?? 0) > 1500 ? "warn" : "ok") : "crit"} />
          <span className="min-w-0 flex-1 truncate">{p.label}</span>
          <span className={cn("font-mono tabular-nums", p.ok ? "text-muted-foreground" : "text-late")}>{p.ok ? ms(p.ms) : p.error ?? `HTTP ${p.status}`}</span>
        </li>
      ))}
    </ul>
  );
}

export function OverviewPage() {
  const { data, error, isLoading, refetch, isFetching } = useOverview();
  const now = useNow(1000);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const o = data;
  const w = isErr(o.worker) ? null : o.worker;
  const git = isErr(o.git) ? null : o.git;
  const agents = o.agents;

  return (
    <>
      <PageHeader
        title="Áttekintés"
        lead="Az egész MVK++ egy pillantásra: élő adat, token, használat, szolgáltatások, adatbázis és kiadás. 10 másodpercenként frissül."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />} onClick={() => void refetch()}>
            Frissítés
          </Button>
        }
      />
      <div className="space-y-5">
        <Hero o={o} now={now} />
        <Alerts alerts={o.alerts} />

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-12">
          <Panel title="Szolgáltatások" action={<MoreLink href="/rendszer">kezelés</MoreLink>} className="xl:col-span-5">
            <Services o={o} now={now} />
          </Panel>
          <Panel title="Válaszidők" hint="kívülről mérve, 30 mp-enként" action={<MoreLink href="/valaszidok">részletek</MoreLink>} className="xl:col-span-4">
            <Probes o={o} />
          </Panel>
          <Panel title="Worker" action={<MoreLink href="/valaszidok">mérések</MoreLink>} className="xl:col-span-3">
            {w ? (
              <KeyValue
                rows={[
                  ["fut", duration(w.process.uptimeSec)],
                  ["CPU", `${w.process.cpuPct}%`],
                  ["memória", `${w.process.memory.rssMb} MB`],
                  ["event loop p99", `${w.process.eventLoop.p99Ms} ms`],
                  ["gyorsítótár", w.cache.backend === "redis" ? `Redis · ${w.cache.redis ?? "?"}` : "memória"],
                  ["írási sor", num(w.persist.pending)],
                ]}
              />
            ) : (
              <ErrorNote error={o.worker} />
            )}
          </Panel>

          <Panel title="Token-agentek" action={<MoreLink href="/token">token</MoreLink>} className="xl:col-span-4">
            {agents.length ? (
              <ul className="space-y-2">
                {agents.map((a) => {
                  const age = now - Date.parse(a.lastSeenAt);
                  return (
                    <li key={a.agentId} className="flex items-center gap-2.5 text-[12.5px]">
                      <StatusDot tone={age > 20 * 60_000 ? "crit" : age > 2 * 60_000 ? "warn" : "ok"} />
                      <span className="min-w-0 flex-1 truncate font-semibold">{a.agentId}</span>
                      <span className="text-xs text-muted-foreground">{a.info.appRunning === false ? "az MVK app nem fut · " : ""}{ago(a.lastSeenAt, now)}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Még egy agent sem jelentkezett.</p>
            )}
          </Panel>
          <Panel title="Használat" action={<MoreLink href="/hasznalat">kedvencek, eszközök</MoreLink>} className="xl:col-span-4">
            <div className="grid grid-cols-3 gap-4">
              <Stat label="ma" value={o.usage && !isErr(o.usage) ? num(o.usage.today) : "–"} />
              <Stat label="7 nap" value={o.usage && !isErr(o.usage) ? num(o.usage.week) : "–"} />
              <Stat label="30 nap" value={o.usage && !isErr(o.usage) ? num(o.usage.month) : "–"} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {o.accounts && !isErr(o.accounts) ? `${num(o.accounts.n)} fiók, ebből ${o.accounts.week} az elmúlt héten nyílt.` : null}
            </p>
          </Panel>
          <Panel title="Adat és mentés" action={<MoreLink href="/mentesek">mentések</MoreLink>} className="xl:col-span-4">
            {o.disk ? (
              <div className="mb-3">
                <div className="mb-1 flex justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate" title={o.disk.path}>
                    lemez · {o.disk.usedPct}% foglalt
                  </span>
                  <span className="shrink-0 font-mono">{o.disk.freeGb} GB szabad</span>
                </div>
                <Meter value={o.disk.usedPct} tone={o.disk.usedPct >= 90 ? "crit" : o.disk.usedPct >= 80 ? "warn" : "ok"} label="lemezhasználat" />
              </div>
            ) : null}
            <KeyValue
              rows={[
                ["legutóbbi mentés", o.backups.last ? ago(o.backups.last.createdAt, now) : "nincs"],
                ["mentések", `${o.backups.count} db · ${bytes(o.backups.totalBytes)}`],
              ]}
            />
          </Panel>

          <Panel title="Kiadás" action={<MoreLink href="/telepites">telepítés</MoreLink>} className="md:col-span-2 xl:col-span-12">
            {git?.available && git.head ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
                <span className="font-mono text-primary">{git.head.short}</span>
                <span className="min-w-0 flex-1 truncate">{git.head.subject}</span>
                <span className="text-xs text-muted-foreground">{git.branch} · {ago(git.head.date, now)}</span>
                {git.behind ? <Pill tone="info">{git.behind} új commit vár</Pill> : <Pill tone="ok">naprakész</Pill>}
                {git.dirty?.length ? <Pill tone="warn">{git.dirty.length} helyi módosítás</Pill> : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{git?.reason ?? (isErr(o.git) ? o.git.error : "A repó nem érhető el.")}</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
