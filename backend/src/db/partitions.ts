import type { Pool } from "mysql2/promise";

export type Granularity = "day" | "month";

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function partName(d: Date, g: Granularity): string {
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  return g === "day" ? `p${y}${m}${pad(d.getUTCDate())}` : `p${y}${m}`;
}

function partBoundary(d: Date, g: Granularity): string {
  const n = new Date(d);
  if (g === "day") n.setUTCDate(n.getUTCDate() + 1);
  else {
    n.setUTCDate(1);
    n.setUTCMonth(n.getUTCMonth() + 1);
  }
  return isoOf(n);
}

function normalize(d: Date, g: Granularity): Date {
  const n = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  if (g === "month") n.setUTCDate(1);
  return n;
}

async function listPartitions(pool: Pool, table: string): Promise<Set<string>> {
  const [rows] = await pool.query(
    `SELECT PARTITION_NAME AS p FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL`,
    [table],
  );
  return new Set((rows as { p: string }[]).map((r) => r.p));
}

export async function ensurePartitions(
  pool: Pool,
  table: string,
  g: Granularity,
  ahead: number,
  from: Date = new Date(),
): Promise<string[]> {
  const existing = await listPartitions(pool, table);
  const created: string[] = [];
  const specs: string[] = [];

  const back = g === "day" ? 2 : 1;
  const cursor = normalize(from, g);
  if (g === "day") cursor.setUTCDate(cursor.getUTCDate() - back);
  else cursor.setUTCMonth(cursor.getUTCMonth() - back);

  for (let i = 0; i < ahead + back; i++) {
    const name = partName(cursor, g);
    if (!existing.has(name)) {
      specs.push(
        `PARTITION ${name} VALUES LESS THAN ('${partBoundary(cursor, g)}')`,
      );
      created.push(name);
    }
    if (g === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  if (!specs.length) return [];

  specs.push(`PARTITION pmax VALUES LESS THAN (MAXVALUE)`);
  await pool.query(
    `ALTER TABLE \`${table}\` REORGANIZE PARTITION pmax INTO (${specs.join(", ")})`,
  );
  return created;
}

export async function dropPartitionsBefore(
  pool: Pool,
  table: string,
  g: Granularity,
  before: Date,
): Promise<string[]> {
  const existing = await listPartitions(pool, table);
  const cutoff = partName(normalize(before, g), g);
  const doomed = [...existing]
    .filter((p) => p !== "pmax" && /^p\d+$/.test(p) && p < cutoff)
    .sort();
  if (!doomed.length) return [];
  await pool.query(
    `ALTER TABLE \`${table}\` DROP PARTITION ${doomed.join(", ")}`,
  );
  return doomed;
}

export const PARTITIONED: { table: string; g: Granularity; ahead: number }[] = [
  { table: "veh_ping", g: "day", ahead: 14 },
  { table: "trip_run", g: "month", ahead: 3 },
  { table: "stop_event", g: "month", ahead: 3 },
  { table: "segment_run", g: "month", ahead: 3 },
];
