/**
 * MySQL kapcsolatkészlet.
 *
 * A statisztikai adatbázis SZÁNDÉKOSAN külön adatbázisban él, és a rendszer
 * enélkül is működik: ha nincs elérhető MySQL, az API gateway ugyanúgy fut, a
 * `/stats/*` végpontok pedig 503-at adnak. A valós idejű funkciók sosem
 * függhetnek attól, hogy az adatraktár elérhető-e.
 */
import mysql from 'mysql2/promise'

export const DB_CONFIG = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'mvk_stats',
}

/** A nyers GPS-pontok megőrzése napokban. A ténytáblák örökre megmaradnak. */
export const PING_RETENTION_DAYS = Number(process.env.PING_RETENTION_DAYS ?? 14)

let pool: mysql.Pool | null = null
let lastError: string | null = null

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL ?? 8),
      queueLimit: 0,
      // A kötegelt beszúrás (`INSERT ... VALUES ?`) miatt kell.
      namedPlaceholders: false,
      // A DATE/DATETIME oszlopokat sztringként kérjük, hogy ne csússzon el
      // időzónánként; minden időpont amúgy is UTC unix egészként utazik.
      dateStrings: true,
      timezone: 'Z',
      charset: 'utf8mb4_general_ci',
    })
  }
  return pool
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await getPool().query(sql, params)
  return rows as T[]
}

/** Igaz, ha az adatbázis elérhető. A hívó ez alapján dönt a 503-ról. */
export async function isReady(): Promise<boolean> {
  try {
    await query('SELECT 1')
    lastError = null
    return true
  } catch (e) {
    lastError = (e as Error).message
    return false
  }
}

export const getLastError = () => lastError

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
