/**
 * Kétszintű gyorsítótár: a folyamat memóriája (L1) + Redis (L2, pl. Upstash).
 *
 * `REDIS_URL` (redis:// vagy rediss://) megadásával a web és a worker közös,
 * újraindítást túlélő gyorsítótárat kap; nélküle minden a memóriában marad.
 * A Redis kiesése sosem hiba: ilyenkor egyszerűen újraszámolunk.
 *
 * Egyidejű kérések ugyanarra a kulcsra egyetlen számítást várnak meg
 * (single-flight), a nagy értékek gzip-pel tömörítve kerülnek a Redisbe.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { Redis } from "ioredis";

const PREFIX = "mvk:v3:";
/** Redis mellett a memória csak rövid ideig tart — a közös forrás a Redis. */
const L1_MAX_TTL_S = 15;
const L1_MAX_ENTRIES = 2000;
const COMPRESS_FROM_BYTES = 2048;
/** ennél nagyobb (tömörített) értéket nem küldünk a Redisbe (Upstash-kérésméret) */
const MAX_REDIS_BYTES = 4 * 1024 * 1024;
const ERROR_LOG_INTERVAL_MS = 60_000;

const RAW = 0;
const GZIP = 1;

export function encodeValue(value: unknown): Buffer | null {
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  const raw = Buffer.from(json);
  if (raw.length < COMPRESS_FROM_BYTES) return Buffer.concat([Buffer.from([RAW]), raw]);
  return Buffer.concat([Buffer.from([GZIP]), gzipSync(raw, { level: 4 })]);
}

export function decodeValue(buf: Buffer): unknown {
  const body = buf.subarray(1);
  return JSON.parse((buf[0] === GZIP ? gunzipSync(body) : body).toString("utf8"));
}

type Entry = { exp: number; value: Promise<unknown> };

export type CacheStatus = {
  backend: "redis" | "memory";
  redis: string;
  memoryEntries: number;
  hits: number;
  redisHits: number;
  misses: number;
  errors: number;
  skippedLarge: number;
};

export class TieredCache {
  private readonly l1 = new Map<string, Entry>();
  private readonly redis: Redis | null;
  private readonly stats = { hits: 0, redisHits: 0, misses: 0, errors: 0, skippedLarge: 0 };
  private lastErrorLog = 0;

  constructor(url: string | null) {
    this.redis = url ? this.connect(url) : null;
  }

  private connect(url: string): Redis {
    const r = new Redis(url, {
      // Nem kapcsolódva a parancsok azonnal hibát adnak (nem várakoznak) → újraszámolás.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 1000,
      retryStrategy: (n) => Math.min(n * 500, 10_000),
    });
    r.on("error", (e) => this.fail(e));
    return r;
  }

  private fail(e: unknown) {
    this.stats.errors++;
    const now = Date.now();
    if (now - this.lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLog = now;
    // A kapcsolati szöveget (benne a jelszóval) sosem írjuk ki.
    console.warn(`[cache] Redis nem elérhető, memóriából dolgozunk: ${e instanceof Error ? e.message : String(e)}`);
  }

  private ready(): Redis | null {
    return this.redis?.status === "ready" ? this.redis : null;
  }

  /** Érték a kulcson; ha nincs (vagy lejárt), `fn` kiszámolja és `ttlS` másodpercig eltesszük. */
  cached<T>(key: string, ttlS: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.l1.get(key);
    if (hit && hit.exp > now) {
      this.stats.hits++;
      return hit.value as Promise<T>;
    }
    const l1Ttl = this.redis ? Math.min(ttlS, L1_MAX_TTL_S) : ttlS;
    const value = this.load(key, ttlS, fn);
    this.l1.set(key, { exp: now + l1Ttl * 1000, value });
    value.catch(() => {
      if (this.l1.get(key)?.value === value) this.l1.delete(key);
    });
    if (this.l1.size > L1_MAX_ENTRIES) this.prune(now);
    return value;
  }

  private async load<T>(key: string, ttlS: number, fn: () => Promise<T>): Promise<T> {
    const fromRedis = await this.get(key);
    if (fromRedis !== undefined) {
      this.stats.redisHits++;
      return fromRedis as T;
    }
    this.stats.misses++;
    const v = await fn();
    void this.set(key, v, ttlS);
    return v;
  }

  private async get(key: string): Promise<unknown> {
    const r = this.ready();
    if (!r) return undefined;
    try {
      const buf = await r.getBuffer(PREFIX + key);
      return buf ? decodeValue(buf) : undefined;
    } catch (e) {
      this.fail(e);
      return undefined;
    }
  }

  private async set(key: string, value: unknown, ttlS: number): Promise<void> {
    const r = this.ready();
    if (!r) return;
    try {
      const buf = encodeValue(value);
      if (!buf) return;
      if (buf.length > MAX_REDIS_BYTES) {
        this.stats.skippedLarge++;
        return;
      }
      await r.set(PREFIX + key, buf, "EX", Math.max(1, Math.round(ttlS)));
    } catch (e) {
      this.fail(e);
    }
  }

  private prune(now: number) {
    for (const [k, x] of this.l1) if (x.exp <= now) this.l1.delete(k);
    // Ha még mindig sok: a legrégebben betett elemek mennek.
    for (const k of this.l1.keys()) {
      if (this.l1.size <= L1_MAX_ENTRIES * 0.8) break;
      this.l1.delete(k);
    }
  }

  status(): CacheStatus {
    return {
      backend: this.redis ? "redis" : "memory",
      redis: this.redis?.status ?? "off",
      memoryEntries: this.l1.size,
      ...this.stats,
    };
  }

  async close(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => this.redis?.disconnect());
  }
}

// Egy folyamatban egy példány — a Next fejlesztői újratöltései se nyissanak új kapcsolatot.
const holder = globalThis as { __mvkCache?: TieredCache };

export function sharedCache(): TieredCache {
  return (holder.__mvkCache ??= new TieredCache(process.env.REDIS_URL?.trim() || null));
}

export const cached = <T>(key: string, ttlS: number, fn: () => Promise<T>): Promise<T> => sharedCache().cached(key, ttlS, fn);
export const cacheStatus = (): CacheStatus => sharedCache().status();
export const closeCache = (): Promise<void> => holder.__mvkCache?.close() ?? Promise.resolve();
