/**
 * SQL-migrációk futtatója.
 *
 * A Timescale-objektumokat (hypertable, continuous aggregate, tömörítés) a
 * Prisma migrate nem tudja kifejezni, ezért a séma sima SQL-fájlokban él
 * (packages/db/sql/NNN_*.sql), a Prisma pedig `db pull`-lal követi.
 * Minden utasítás külön fut, mert a continuous aggregate-et nem lehet
 * tranzakción belül létrehozni.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { fileURLToPath } from "node:url";

const SQL_DIR = join(import.meta.dirname, "..", "sql");

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  let inDollar = false;
  const lines = sql.split(/\r?\n/);
  for (const raw of lines) {
    const line = !inStr && !inDollar && raw.trimStart().startsWith("--") ? "" : raw;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (!inStr && line.startsWith("$$", i)) {
        inDollar = !inDollar;
        cur += "$$";
        i++;
        continue;
      }
      if (!inDollar && ch === "'") inStr = !inStr;
      if (!inStr && !inDollar && ch === "-" && line[i + 1] === "-") break; // sorvégi megjegyzés
      if (!inStr && !inDollar && ch === ";") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cur += "\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function migrate(url = process.env.DATABASE_URL): Promise<string[]> {
  if (!url) throw new Error("DATABASE_URL nincs megadva");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM _migration`)).rows.map((r) => r.name));
    const files = readdirSync(SQL_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const stmts = splitSql(readFileSync(join(SQL_DIR, f), "utf8"));
      for (const s of stmts) {
        try {
          await client.query(s);
        } catch (e) {
          throw new Error(`${f}: ${(e as Error).message}\n--- utasítás ---\n${s.slice(0, 400)}`);
        }
      }
      await client.query(`INSERT INTO _migration (name) VALUES ($1)`, [f]);
      applied.push(f);
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then((a) => console.log(a.length ? `[migrate] lefutott: ${a.join(", ")}` : "[migrate] naprakész"))
    .catch((e) => {
      console.error("[migrate] HIBA:", e.message);
      process.exit(1);
    });
}
