/**
 * Riasztási szabályok  tiszta függvény: a begyűjtött állapotból a
 * figyelmeztetések listája (súlyosság szerint), az Áttekintés tetejére.
 */
export type Severity = "crit" | "warn" | "info";
export type Alert = { id: string; severity: Severity; title: string; detail?: string; href: string };

export type AlertInput = {
  now: number;
  token?: { present: boolean; expiresInSec?: number | null; rejected?: boolean } | null;
  agents?: { agentId: string; lastSeenAt: string }[] | null;
  poll?: { lastOkAt: number; lastError: string | null } | null;
  upstreamErrorPct?: number | null;
  containers?: { service: string; state: string; health: string | null }[] | null;
  dockerAvailable: boolean;
  diskUsedPct?: number | null;
  lastBackupAt?: string | null;
  backupsEnabled: boolean;
  eventLoopP99Ms?: number | null;
  probes?: { id: string; label: string; ok: boolean; error?: string }[] | null;
  gtfsFallback?: boolean | null;
  /** MVK ↔ MÁV+: ki viszi most az élő adatot, és él-e a regionális (Volán, vasút) */
  source?: SourceBrief | null;
  behind?: number | null;
  workerReachable: boolean;
};

export type SourceBrief = {
  state: "mvk" | "otp2";
  since: string;
  reason: string | null;
  fallbackSecToday: number;
  regional: { enabled: boolean; vehicles: number; lastOkAt: number | null; lastError: string | null; limited: number };
};

/** a MÁV+ ennyi csend után számít elakadtnak (a lekérés 10–15 mp-enként fut) */
const REGIONAL_STALE_MS = 5 * 60_000;

const MIN = 60_000;

export function buildAlerts(i: AlertInput): Alert[] {
  const out: Alert[] = [];
  const add = (a: Alert) => out.push(a);

  if (!i.workerReachable) add({ id: "worker-down", severity: "crit", title: "A worker nem érhető el", detail: "Nincs élő adat, nincs push.", href: "/rendszer" });

  const t = i.token;
  // ha a MÁV+ tartalék viszi az MVK-t, a token hiánya nem jelent adatkiesést (a statisztika és a jóslás ettől még gyengébb)
  const covered = i.source?.state === "otp2";
  if (t && !t.present) add({ id: "token-missing", severity: "crit", title: "Nincs MVK-token", detail: covered ? "Az élő adatot most a MÁV+ tartalék adja." : "A worker nem tud adatot lekérni.", href: "/token" });
  else if (t?.rejected) add({ id: "token-rejected", severity: "crit", title: "Az MVK elutasította a tokent", detail: "Kérj új tokent az agenttől.", href: "/token" });
  else if (t && (t.expiresInSec ?? 0) <= 0) add({ id: "token-expired", severity: "crit", title: "Lejárt az MVK-token", href: "/token" });
  else if (t && (t.expiresInSec ?? Infinity) < 3600) add({ id: "token-soon", severity: "warn", title: "Egy órán belül lejár az MVK-token", detail: `${Math.round((t.expiresInSec ?? 0) / 60)} perc van hátra.`, href: "/token" });

  for (const a of i.agents ?? []) {
    const ago = i.now - Date.parse(a.lastSeenAt);
    if (ago > 20 * MIN) add({ id: `agent-${a.agentId}`, severity: ago > 6 * 60 * MIN ? "crit" : "warn", title: `A(z) „${a.agentId}” token-agent hallgat`, detail: `${Math.round(ago / MIN)} perce jelentkezett utoljára.`, href: "/token" });
  }

  if (i.poll && i.poll.lastOkAt && i.now - i.poll.lastOkAt > 60_000) {
    add({ id: "poll-stale", severity: "crit", title: "Az MVK-adat elakadt", detail: `${Math.round((i.now - i.poll.lastOkAt) / 1000)} mp óta nincs sikeres lekérés${i.poll.lastError ? `: ${i.poll.lastError}` : ""}.`, href: "/mvk" });
  }
  if ((i.upstreamErrorPct ?? 0) >= 10) add({ id: "upstream-errors", severity: "warn", title: "Sok hibás MVK API-válasz", detail: `${i.upstreamErrorPct}% az utolsó 15 percben.`, href: "/mvk" });

  if (i.dockerAvailable) {
    for (const c of i.containers ?? []) {
      if (c.state !== "running") add({ id: `ctr-${c.service}`, severity: "crit", title: `Leállt: ${c.service}`, detail: `állapot: ${c.state}`, href: "/rendszer" });
      else if (c.health === "unhealthy") add({ id: `ctr-${c.service}`, severity: "crit", title: `Beteg: ${c.service}`, detail: "a healthcheck hibát jelez", href: "/rendszer" });
    }
  }

  if (i.diskUsedPct != null && i.diskUsedPct >= 90) add({ id: "disk", severity: "crit", title: "Majdnem tele a lemez", detail: `${i.diskUsedPct}% foglalt.`, href: "/mentesek" });
  else if (i.diskUsedPct != null && i.diskUsedPct >= 80) add({ id: "disk", severity: "warn", title: "Fogy a lemezhely", detail: `${i.diskUsedPct}% foglalt.`, href: "/mentesek" });

  if (i.backupsEnabled) {
    if (!i.lastBackupAt) add({ id: "backup-none", severity: "warn", title: "Még nincs adatbázis-mentés", href: "/mentesek" });
    else if (i.now - Date.parse(i.lastBackupAt) > 36 * 60 * MIN) add({ id: "backup-old", severity: "warn", title: "Régi a legutóbbi mentés", detail: `${Math.round((i.now - Date.parse(i.lastBackupAt)) / (60 * MIN))} órája készült.`, href: "/mentesek" });
  }

  if ((i.eventLoopP99Ms ?? 0) > 250) add({ id: "event-loop", severity: "warn", title: "Akadozik a worker", detail: `event loop p99: ${i.eventLoopP99Ms} ms`, href: "/valaszidok" });

  for (const p of i.probes ?? []) if (!p.ok) add({ id: `probe-${p.id}`, severity: p.id.startsWith("public") ? "crit" : "warn", title: `Nem válaszol: ${p.label}`, detail: p.error, href: "/valaszidok" });

  const src = i.source;
  if (src?.state === "otp2") {
    const mins = Math.max(1, Math.round((i.now - Date.parse(src.since)) / MIN));
    add({ id: "source-fallback", severity: "warn", title: "Tartalék adatforrás: MÁV+", detail: `${mins} perce az MVK helyett a MÁV+ adatai mennek${src.reason ? ` (${src.reason})` : ""}.`, href: "/forrasok" });
  }
  if (src?.regional.enabled) {
    const last = src.regional.lastOkAt;
    if (!last || i.now - last > REGIONAL_STALE_MS) {
      add({ id: "regional-stale", severity: src.state === "otp2" ? "crit" : "warn", title: "A MÁV+ adat elakadt", detail: `${last ? `${Math.round((i.now - last) / MIN)} perce` : "Ebben a futásban még"} nincs sikeres lekérés${src.regional.lastError ? `: ${src.regional.lastError}` : ""}. A Volán és a vasút nem frissül.`, href: "/forrasok" });
    }
  }

  if (i.gtfsFallback) add({ id: "gtfs-fallback", severity: "warn", title: "Mai menetrend: tartalék GTFS", detail: "Az MVK nem adott érvényes menetrendet mára.", href: "/mvk" });
  if ((i.behind ?? 0) > 0) add({ id: "update", severity: "info", title: `${i.behind} új commit vár telepítésre`, href: "/telepites" });

  const rank: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
