/**
 * Az adatbázis állapota: méret (táblánként, a hypertable-ök darabjaival és
 * tömörítésével), kapcsolatok, futó lekérdezések, gyorsítótár-találati arány,
 * napi növekedés.
 */
import { sql, sqlOne } from "@mvk/db";

export type TableSize = { name: string; kind: "hypertable" | "table" | "view"; totalBytes: number; tableBytes: number; indexBytes: number; rows: number; chunks: number | null; compressedBefore: number | null; compressedAfter: number | null };

async function hypertables(): Promise<TableSize[]> {
  const rows = await sql<{ name: string; total: number; tbl: number; idx: number; chunks: number; rows: number }>(
    `SELECT h.hypertable_name AS name,
            d.total_bytes AS total, d.table_bytes + COALESCE(d.toast_bytes, 0) AS tbl, d.index_bytes AS idx,
            h.num_chunks AS chunks,
            COALESCE(approximate_row_count(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass), 0) AS rows
       FROM timescaledb_information.hypertables h
       CROSS JOIN LATERAL hypertable_detailed_size(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass) d
      WHERE h.hypertable_schema = 'public'`,
  );
  const comp = await sql<{ name: string; before: number; after: number }>(
    `SELECT h.hypertable_name AS name, s.before_compression_total_bytes AS before, s.after_compression_total_bytes AS after
       FROM timescaledb_information.hypertables h
       CROSS JOIN LATERAL hypertable_compression_stats(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass) s
      WHERE h.hypertable_schema = 'public'`,
  ).catch(() => []);
  const byName = new Map(comp.map((c) => [c.name, c]));
  return rows.map((r) => ({
    name: r.name,
    kind: "hypertable",
    totalBytes: r.total ?? 0,
    tableBytes: r.tbl ?? 0,
    indexBytes: r.idx ?? 0,
    rows: Number(r.rows) || 0,
    chunks: r.chunks,
    compressedBefore: byName.get(r.name)?.before ?? null,
    compressedAfter: byName.get(r.name)?.after ?? null,
  }));
}

async function plainTables(exclude: Set<string>): Promise<TableSize[]> {
  const rows = await sql<{ name: string; kind: string; total: number; tbl: number; idx: number; rows: number }>(
    `SELECT c.relname AS name, c.relkind AS kind,
            pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS tbl, pg_indexes_size(c.oid) AS idx,
            GREATEST(c.reltuples, 0)::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 60`,
  );
  return rows
    .filter((r) => !exclude.has(r.name))
    .map((r) => ({ name: r.name, kind: r.kind === "m" ? "view" : "table", totalBytes: r.total, tableBytes: r.tbl, indexBytes: r.idx, rows: r.rows, chunks: null, compressedBefore: null, compressedAfter: null }));
}

export async function dbOverview() {
  const [size, version, stat, conns, extensions] = await Promise.all([
    sqlOne<{ bytes: number; name: string }>(`SELECT pg_database_size(current_database()) AS bytes, current_database() AS name`),
    sqlOne<{ server_version: string }>(`SHOW server_version`).then((r) => r?.server_version ?? null),
    sqlOne<{ hit: number; read: number; commits: number; rollbacks: number; deadlocks: number; temp_bytes: number; started: string }>(
      `SELECT blks_hit AS hit, blks_read AS read, xact_commit AS commits, xact_rollback AS rollbacks, deadlocks, temp_bytes, stats_reset AS started
         FROM pg_stat_database WHERE datname = current_database()`,
    ),
    sql<{ app: string; state: string; n: number }>(
      `SELECT COALESCE(NULLIF(application_name, ''), '(névtelen)') AS app, COALESCE(state, '?') AS state, count(*)::int AS n
         FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1, 2 ORDER BY 3 DESC`,
    ),
    sql<{ name: string; version: string }>(`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY 1`),
  ]);
  const hyper = await hypertables().catch(() => [] as TableSize[]);
  const plain = await plainTables(new Set(hyper.map((h) => h.name)));
  const tables = [...hyper, ...plain].sort((a, b) => b.totalBytes - a.totalBytes);
  const maxConn = await sqlOne<{ max_connections: string }>(`SHOW max_connections`);
  return {
    name: size?.name ?? "?",
    bytes: size?.bytes ?? 0,
    version,
    cacheHitPct: stat && stat.hit + stat.read > 0 ? Math.round((stat.hit / (stat.hit + stat.read)) * 10000) / 100 : null,
    stats: stat,
    connections: { total: conns.reduce((a, c) => a + c.n, 0), max: Number(maxConn?.max_connections ?? 0), byApp: conns },
    extensions,
    tables,
  };
}

export async function activeQueries() {
  return sql<{ pid: number; app: string; state: string; wait: string | null; seconds: number; query: string; client: string | null }>(
    `SELECT pid, COALESCE(application_name, '') AS app, state, wait_event_type || ':' || wait_event AS wait,
            EXTRACT(epoch FROM now() - query_start)::int AS seconds, left(query, 600) AS query, client_addr::text AS client
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle' AND query_start IS NOT NULL
      ORDER BY query_start ASC LIMIT 40`,
  );
}

export async function cancelQuery(pid: number, terminate: boolean): Promise<boolean> {
  const r = await sqlOne<{ ok: boolean }>(`SELECT ${terminate ? "pg_terminate_backend" : "pg_cancel_backend"}($1) AS ok`, [pid]);
  return Boolean(r?.ok);
}

/** Naponta mennyit nőtt a nyers GPS-tábla (darabonként)  a növekedés trendje. */
export async function dailyGrowth(days = 45) {
  return sql<{ day: string; bytes: number }>(
    `SELECT (c.range_start AT TIME ZONE 'Europe/Budapest')::date::text AS day, sum(s.total_bytes)::bigint AS bytes
       FROM timescaledb_information.chunks c
       JOIN chunks_detailed_size('veh_ping') s ON s.chunk_name = c.chunk_name AND s.chunk_schema = c.chunk_schema
      WHERE c.hypertable_name = 'veh_ping' AND c.range_start > now() - make_interval(days => $1)
      GROUP BY 1 ORDER BY 1`,
    [days],
  ).catch(() => []);
}
