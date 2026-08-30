/**
 * Partíciógondozás.
 *
 * A dátum szerinti particionálás két dolgot ad: a lekérdezések a partíciók
 * túlnyomó részét meg sem érintik (partition pruning), és a megőrzési idő
 * lejártakor a törlés egy fájlművelet (`DROP PARTITION`) ahelyett, hogy
 * félmillió sort kellene a tranzakciós naplóba írni.
 *
 * A `pmax` gyűjtőpartíció mindig a végén marad: az új partíciókat abból
 * hasítjuk ki. Ha a készlet elfogy, minden új sor a `pmax`-ba folyik és ott
 * ragad — ezért gyártunk mindig előre.
 */
import type { Pool } from 'mysql2/promise'

export type Granularity = 'day' | 'month'

const pad = (n: number) => String(n).padStart(2, '0')
const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** Partíciónév: `p20260901` (napi) vagy `p202609` (havi). */
function partName(d: Date, g: Granularity): string {
  const y = d.getUTCFullYear()
  const m = pad(d.getUTCMonth() + 1)
  return g === 'day' ? `p${y}${m}${pad(d.getUTCDate())}` : `p${y}${m}`
}

/** A partíció felső határa (exkluzív): a következő nap, illetve hónap eleje. */
function partBoundary(d: Date, g: Granularity): string {
  const n = new Date(d)
  if (g === 'day') n.setUTCDate(n.getUTCDate() + 1)
  else {
    n.setUTCDate(1)
    n.setUTCMonth(n.getUTCMonth() + 1)
  }
  return isoOf(n)
}

function normalize(d: Date, g: Granularity): Date {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  if (g === 'month') n.setUTCDate(1)
  return n
}

async function listPartitions(pool: Pool, table: string): Promise<Set<string>> {
  const [rows] = await pool.query(
    `SELECT PARTITION_NAME AS p FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL`,
    [table]
  )
  return new Set((rows as { p: string }[]).map((r) => r.p))
}

/**
 * Előre gyárt `ahead` darab partíciót a mai naptól. Idempotens: a meglévőket
 * kihagyja, és ha nincs mit tenni, egyetlen ALTER sem fut.
 */
export async function ensurePartitions(
  pool: Pool,
  table: string,
  g: Granularity,
  ahead: number,
  from: Date = new Date()
): Promise<string[]> {
  const existing = await listPartitions(pool, table)
  const created: string[] = []
  const specs: string[] = []

  // Visszamenőleg is kell egy kevés, hogy a már beérkezett adat a helyére kerüljön.
  const back = g === 'day' ? 2 : 1
  const cursor = normalize(from, g)
  if (g === 'day') cursor.setUTCDate(cursor.getUTCDate() - back)
  else cursor.setUTCMonth(cursor.getUTCMonth() - back)

  for (let i = 0; i < ahead + back; i++) {
    const name = partName(cursor, g)
    if (!existing.has(name)) {
      specs.push(`PARTITION ${name} VALUES LESS THAN ('${partBoundary(cursor, g)}')`)
      created.push(name)
    }
    if (g === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1)
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  if (!specs.length) return []

  // A pmax-ot hasítjuk fel: az újak elé kerülnek, a gyűjtő a végén marad.
  specs.push(`PARTITION pmax VALUES LESS THAN (MAXVALUE)`)
  await pool.query(`ALTER TABLE \`${table}\` REORGANIZE PARTITION pmax INTO (${specs.join(', ')})`)
  return created
}

/**
 * Ejti a `before` dátumnál régebbi partíciókat. A `pmax` sosem eshet ki.
 * Egyetlen ALTER-ben megy, mert partíciónként külön ALTER fölöslegesen
 * újraépítené a tábla metaadatait.
 */
export async function dropPartitionsBefore(
  pool: Pool,
  table: string,
  g: Granularity,
  before: Date
): Promise<string[]> {
  const existing = await listPartitions(pool, table)
  const cutoff = partName(normalize(before, g), g)
  const doomed = [...existing]
    .filter((p) => p !== 'pmax' && /^p\d+$/.test(p) && p < cutoff)
    .sort()
  if (!doomed.length) return []
  await pool.query(`ALTER TABLE \`${table}\` DROP PARTITION ${doomed.join(', ')}`)
  return doomed
}

/** A particionált táblák és a hozzájuk tartozó szemcsézettség. */
export const PARTITIONED: { table: string; g: Granularity; ahead: number }[] = [
  // Napi, mert a ping-megőrzés is napi.
  { table: 'veh_ping', g: 'day', ahead: 14 },
  // A ténytáblák havi partíciói kevesebb metaadatot jelentenek.
  { table: 'trip_run', g: 'month', ahead: 3 },
  { table: 'stop_event', g: 'month', ahead: 3 },
  { table: 'segment_run', g: 'month', ahead: 3 },
]
