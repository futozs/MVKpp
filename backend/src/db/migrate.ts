/**
 * Séma-migráció. Futtatás: `npm run db:migrate` a backend könyvtárból.
 *
 * Idempotens — bármikor újrafuttatható. Létrehozza az adatbázist, felviszi a
 * sémát, kihasítja a partíciókat, feltölti a naptárat, és szinkronizálja a
 * dimenziókat a jelenlegi GTFS-ből.
 */
import mysql from 'mysql2/promise'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DB_CONFIG } from './pool.ts'
import { PARTITIONED, ensurePartitions } from './partitions.ts'
import { buildCalendar } from './calendar.ts'
import { syncDimensions } from './dims.ts'
import { loadGtfs } from '../lib/gtfs.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GTFS_DIR = join(HERE, '..', '..', 'gtfs')

/** A `--` sorkommentek eltávolítása után pontosvessző mentén darabol. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main() {
  const log = (s: string) => console.log(`[migrate] ${s}`)

  // 1. adatbázis
  const root = await mysql.createConnection({
    host: DB_CONFIG.host, port: DB_CONFIG.port,
    user: DB_CONFIG.user, password: DB_CONFIG.password,
  })
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
  )
  await root.end()
  log(`adatbázis kész: ${DB_CONFIG.database}`)

  const pool = mysql.createPool({ ...DB_CONFIG, connectionLimit: 4, dateStrings: true })

  try {
    // 2. séma
    const sql = readFileSync(join(HERE, 'schema.sql'), 'utf8')
    const stmts = splitStatements(sql)
    for (const s of stmts) await pool.query(s)
    log(`séma: ${stmts.length} utasítás lefutott`)

    // 3. partíciók
    for (const p of PARTITIONED) {
      const made = await ensurePartitions(pool, p.table, p.g, p.ahead)
      log(`partíció ${p.table}: ${made.length ? made.length + ' új (' + made[0] + '…' + made[made.length - 1] + ')' : 'már naprakész'}`)
    }

    // 4. naptár — egy évvel vissza, két évvel előre
    const from = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10)
    const cal = buildCalendar(from, 365 + 730)
    const rows = cal.map((c) => [c.service_date, c.dow, c.daytype, c.school, c.holiday_name])
    for (let i = 0; i < rows.length; i += 500) {
      await pool.query(
        `INSERT INTO dim_calendar (service_date, dow, daytype, school, holiday_name) VALUES ?
           ON DUPLICATE KEY UPDATE dow = VALUES(dow), daytype = VALUES(daytype),
             school = VALUES(school), holiday_name = VALUES(holiday_name)`,
        [rows.slice(i, i + 500)]
      )
    }
    log(`naptár: ${rows.length} nap (${cal[0].service_date} … ${cal[cal.length - 1].service_date})`)

    // 5. dimenziók a GTFS-ből
    const g = loadGtfs(GTFS_DIR)
    log(`GTFS betöltve: ${g.stops} megálló, ${g.routes} vonal, ${g.trips} menet, feed=${g.feedVersion}`)
    const d = await syncDimensions(pool)
    log(`dimenziók: ${d.routes} vonal, ${d.stops} megálló, ${d.patterns} minta, ${d.segments} megállóköz`)

    log('kész.')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[migrate] HIBA:', e.message)
  process.exit(1)
})
