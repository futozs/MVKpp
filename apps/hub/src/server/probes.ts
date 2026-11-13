/**
 * Kívülről mért válaszidők: a hub 30 mp-enként megszólítja a szolgáltatásokat
 * (worker, web, és ha van domain, a nyilvános címet a Caddyn és a TLS-en át),
 * az eredmény a hub_probe táblába kerül (14 napig), az utolsó a memóriába.
 */
import { sql } from "@mvk/db";
import { env } from "./env.ts";

export type ProbeTarget = { id: string; label: string; url: string };
export type ProbeResult = { id: string; label: string; at: number; ms: number | null; status: number; ok: boolean; error?: string };

const TIMEOUT_MS = 10_000;
const KEEP_DAYS = 14;

export function probeTargets(): ProbeTarget[] {
  const t: ProbeTarget[] = [
    { id: "worker:health", label: "worker /_health", url: `${env.workerUrl}/_health` },
    { id: "worker:positions", label: "worker /live/positions", url: `${env.workerUrl}/live/positions` },
    { id: "worker:meta", label: "worker /gtfs/meta.json", url: `${env.workerUrl}/gtfs/meta.json` },
    { id: "web:home", label: "web / (oldal)", url: `${env.webUrl}/` },
    { id: "web:manifest", label: "web /manifest", url: `${env.webUrl}/manifest.webmanifest` },
  ];
  if (env.publicUrl) {
    t.push({ id: "public:health", label: `${env.publicUrl.replace(/^https?:\/\//, "")} /_health`, url: `${env.publicUrl}/_health` });
    t.push({ id: "public:home", label: `${env.publicUrl.replace(/^https?:\/\//, "")} /`, url: `${env.publicUrl}/` });
  }
  return t;
}

const g = globalThis as { __hubProbes?: Map<string, ProbeResult> };
const latest = (g.__hubProbes ??= new Map());

async function probeOne(t: ProbeTarget): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(t.url, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    const ms = Math.round(performance.now() - t0);
    return { id: t.id, label: t.label, at: Date.now(), ms, status: res.status, ok: res.status < 400 };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "időtúllépés" : (e.cause as Error | undefined)?.message ?? e.message) : String(e);
    return { id: t.id, label: t.label, at: Date.now(), ms: null, status: 0, ok: false, error: msg };
  }
}

export async function runProbes(): Promise<ProbeResult[]> {
  const results = await Promise.all(probeTargets().map(probeOne));
  for (const r of results) latest.set(r.id, r);
  await sql(
    `INSERT INTO hub_probe (at, target, ms, status, ok) SELECT to_timestamp(a / 1000.0), t, m, s, o FROM unnest($1::bigint[], $2::text[], $3::int[], $4::int[], $5::bool[]) AS x(a, t, m, s, o)`,
    [results.map((r) => r.at), results.map((r) => r.id), results.map((r) => r.ms), results.map((r) => r.status), results.map((r) => r.ok)],
  ).catch(() => {
    /* a tábla még nincs meg (a worker migrál)  a memóriában akkor is megvan */
  });
  return results;
}

export const latestProbes = (): ProbeResult[] => [...latest.values()];

export async function cleanupProbes(): Promise<void> {
  await sql(`DELETE FROM hub_probe WHERE at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
}

/** Idősor célpontonként: `bucketMin` perces átlag, max és hibaszám. */
export async function probeSeries(hours: number, bucketMin: number) {
  return sql<{ target: string; t: string; avg: number | null; max: number | null; fails: number; n: number }>(
    `SELECT target, time_bucket(make_interval(mins => $2), at) AS t,
            round(avg(ms))::int AS avg, max(ms) AS max, count(*) FILTER (WHERE NOT ok)::int AS fails, count(*)::int AS n
       FROM hub_probe WHERE at > now() - make_interval(hours => $1)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [hours, bucketMin],
  );
}

export async function probeUptime(hours: number) {
  return sql<{ target: string; okPct: number; p50: number | null; p95: number | null; n: number }>(
    `SELECT target, round(100.0 * count(*) FILTER (WHERE ok) / count(*), 2)::float AS "okPct",
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::int AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::int AS p95, count(*)::int AS n
       FROM hub_probe WHERE at > now() - make_interval(hours => $1) GROUP BY 1`,
    [hours],
  );
}
