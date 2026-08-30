import mysql from "mysql2/promise";

export const DB_CONFIG = {
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "root",
  password: process.env.DB_PASS ?? "",
  database: process.env.DB_NAME ?? "mvk_stats",
};

export const PING_RETENTION_DAYS = Number(
  process.env.PING_RETENTION_DAYS ?? 14,
);

let pool: mysql.Pool | null = null;
let lastError: string | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL ?? 8),
      queueLimit: 0,
      namedPlaceholders: false,
      dateStrings: true,
      timezone: "Z",
      charset: "utf8mb4_general_ci",
    });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

export async function isReady(): Promise<boolean> {
  try {
    await query("SELECT 1");
    lastError = null;
    return true;
  } catch (e) {
    lastError = (e as Error).message;
    return false;
  }
}

export const getLastError = () => lastError;

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
