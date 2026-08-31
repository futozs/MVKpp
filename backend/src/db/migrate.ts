// Legelső import: a lenti ./pool.ts modulbetöltéskor olvassa a process.env-et.
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DB_CONFIG } from "./pool.ts";
import { PARTITIONED, ensurePartitions } from "./partitions.ts";
import { buildCalendar } from "./calendar.ts";
import { syncDimensions } from "./dims.ts";
import { loadGtfs } from "../lib/gtfs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GTFS_DIR = join(HERE, "..", "..", "gtfs");

function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Oszlopok, amelyek egy korábbi sémaverzióban szűkebbek voltak. A séma maga
 * már a végleges típust írja le; ez a lista a meglévő telepítéseket hozza
 * szintre.
 */
const COLUMN_UPGRADES: [table: string, column: string, type: string][] = [
  ["vehicle_incident", "resolution", "VARCHAR(48) NULL"],
];

/**
 * Új oszlopok, amik egy korábbi telepítésen még hiányoznak. A CREATE TABLE
 * IF NOT EXISTS egy már létező táblán nem ad hozzá oszlopot, ezért ez a
 * lista pótolja utólag — a duplikált-oszlop hibát (MySQL 1060) szándékosan
 * elnyeljük, hogy többször futtatva is biztonságos maradjon.
 */
const NEW_COLUMNS: [table: string, column: string, type: string][] = [
  ["push_watch", "trip_id", "VARCHAR(64) NULL AFTER route_shorts"],
];

async function main() {
  const log = (s: string) => console.log(`[migrate] ${s}`);

  const root = await mysql.createConnection({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
  });
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  await root.end();
  log(`adatbázis kész: ${DB_CONFIG.database}`);

  const pool = mysql.createPool({
    ...DB_CONFIG,
    connectionLimit: 4,
    dateStrings: true,
  });

  try {
    const sql = readFileSync(join(HERE, "schema.sql"), "utf8");
    const stmts = splitStatements(sql);
    for (const s of stmts) await pool.query(s);
    log(`séma: ${stmts.length} utasítás lefutott`);

    // A CREATE TABLE IF NOT EXISTS meglévő táblán nem csinál semmit, ezért a
    // már kiadott oszlopok szélesítése külön lépés. A MODIFY idempotens.
    for (const [table, column, type] of COLUMN_UPGRADES) {
      await pool.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${type}`,
      );
    }
    log(`oszlopigazítás: ${COLUMN_UPGRADES.length} rendben`);

    for (const [table, column, type] of NEW_COLUMNS) {
      try {
        await pool.query(
          `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`,
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e; // 1060 = oszlop már létezik
      }
    }
    log(`új oszlopok: ${NEW_COLUMNS.length} rendben`);

    for (const p of PARTITIONED) {
      const made = await ensurePartitions(pool, p.table, p.g, p.ahead);
      log(
        `partíció ${p.table}: ${made.length ? made.length + " új (" + made[0] + "…" + made[made.length - 1] + ")" : "már naprakész"}`,
      );
    }

    const from = new Date(Date.now() - 365 * 86400_000)
      .toISOString()
      .slice(0, 10);
    const cal = buildCalendar(from, 365 + 730);
    const rows = cal.map((c) => [
      c.service_date,
      c.dow,
      c.daytype,
      c.school,
      c.holiday_name,
    ]);
    for (let i = 0; i < rows.length; i += 500) {
      await pool.query(
        `INSERT INTO dim_calendar (service_date, dow, daytype, school, holiday_name) VALUES ?
           ON DUPLICATE KEY UPDATE dow = VALUES(dow), daytype = VALUES(daytype),
             school = VALUES(school), holiday_name = VALUES(holiday_name)`,
        [rows.slice(i, i + 500)],
      );
    }
    log(
      `naptár: ${rows.length} nap (${cal[0].service_date} … ${cal[cal.length - 1].service_date})`,
    );

    const g = loadGtfs(GTFS_DIR);
    log(
      `GTFS betöltve: ${g.stops} megálló, ${g.routes} vonal, ${g.trips} menet, feed=${g.feedVersion}`,
    );
    const d = await syncDimensions(pool);
    log(
      `dimenziók: ${d.routes} vonal, ${d.stops} megálló, ${d.patterns} minta, ${d.segments} megállóköz`,
    );

    log("kész.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[migrate] HIBA:", e.message);
  process.exit(1);
});
