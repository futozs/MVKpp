/**
 * Adatbázis-hozzáférés: közös pg pool a nyers SQL-hez (Timescale-lekérdezések,
 * tömeges beírás unnest-tel). A típusos Prisma kliens külön belépési ponton
 * érhető el (`@mvk/db/prisma`), ugyanazzal a pool-lal — így aki nem használja,
 * annak a buildjébe nem kerül bele.
 */
import pg from "pg";

// A bigint (int8) oszlopokat számként kérjük — a mi értékeink bőven elférnek.
pg.types.setTypeParser(20, (v) => Number(v));
// A date oszlop maradjon "YYYY-MM-DD" szöveg (ne csússzon el időzónával).
pg.types.setTypeParser(1082, (v) => v);
// numeric → number
pg.types.setTypeParser(1700, (v) => Number(v));

let pool: pg.Pool | null = null;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL nincs megadva");
  return url;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.DB_POOL ?? 10),
      idleTimeoutMillis: 30_000,
      application_name: process.env.APP_NAME ?? "mvk",
    });
    pool.on("error", (e) => console.error("[db] pool hiba:", e.message));
  }
  return pool;
}

/** Paraméteres nyers lekérdezés. */
export async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function sqlOne<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => {});
  pool = null;
}

export async function dbReady(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

