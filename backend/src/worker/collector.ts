/**
 * Collector — a nyers GPS-telemetria begyűjtése.
 *
 * Ez az egyetlen rész, ami sürgős: minden perc, amíg nem fut, VÉGLEG elveszett
 * adat. A többi feldolgozási lépés bármikor utólag lefuttatható a nyers
 * pingekre, ez viszont nem pótolható.
 *
 * Mintavételi ütem: mérés szerint a járművek ~18 másodpercenként adnak új
 * GPS-fixet, a GTFS-RT feed pedig járművenként csak a LEGUTÓBBI pozíciót
 * hordozza. Ezért 18 mp-nél sűrűbben kell lekérdezni, különben fixek vesznek
 * el — de nem érdemes sokkal sűrűbben, mert a többlet mind ismétlés. Az 5 mp
 * kényelmes ráhagyás; az ismétlődő sorokat az elsődleges kulcs ütközése
 * ejti ki, ezért az `INSERT IGNORE` ingyen deduplikál.
 */
import type { Pool } from 'mysql2/promise'
import { budapestOffsetSec, routes, serviceNow } from '../lib/gtfs.ts'
import { keys, vehicleKey } from '../db/dims.ts'

const GATEWAY = process.env.STATS_GATEWAY ?? 'http://127.0.0.1:8088'
export const COLLECT_INTERVAL_MS = Number(process.env.COLLECT_INTERVAL_MS ?? 5000)

type FeedVehicle = {
  id: string
  label?: string
  routeId?: string
  lat: number | null
  lon: number | null
  bearing: number | null
  speed: number | null
  tripId?: string
  timestamp: number | null
}

export type CollectResult = { kept: number; dup: number; vehicles: number; ok: boolean; error?: string }

const e7 = (v: number) => Math.round(v * 1e7)
/** MySQL UNSIGNED oszlopba negatív érték nem mehet; a hiányzót NULL-ozzuk. */
const u = (v: number | null, scale = 1, max = 65535): number | null => {
  if (v == null || !Number.isFinite(v)) return null
  const n = Math.round(v * scale)
  return n < 0 ? null : Math.min(n, max)
}

/**
 * Egy lekérdezési kör. A helyi gateway-t hívja, nem közvetlenül az MVK API-t:
 * így a JWT-kezelés, az automatikus token-megújítás és a 2 mp-es feed-cache
 * mind újrahasznosul, és nem terheljük duplán az upstreamet.
 */
export async function collectOnce(pool: Pool): Promise<CollectResult> {
  let feed: { vehicles: FeedVehicle[] }
  try {
    const res = await fetch(`${GATEWAY}/live/positions`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { kept: 0, dup: 0, vehicles: 0, ok: false, error: `HTTP ${res.status}` }
    feed = (await res.json()) as { vehicles: FeedVehicle[] }
  } catch (e) {
    return { kept: 0, dup: 0, vehicles: 0, ok: false, error: (e as Error).message }
  }

  const list = (feed.vehicles || []).filter((v) => v.lat != null && v.lon != null && v.timestamp)
  if (!list.length) return { kept: 0, dup: 0, vehicles: 0, ok: true }

  // A feed a HELYI időt teszi a unix-mezőbe (mérve: +7200 mp nyáron), ezért
  // beérkezéskor egyszer, itt korrigáljuk valódi UTC-re. Innentől az egész
  // adatbázisban minden időpont UTC; helyi idő csak megjelenítéskor van.
  const offset = budapestOffsetSec()

  const rows: unknown[][] = []
  for (const v of list) {
    const utcTs = Number(v.timestamp) - offset
    if (!Number.isFinite(utcTs) || utcTs <= 0) continue

    const vk = keys.vehicle.get(v.id) ?? (await vehicleKey(pool, v.id, v.label || 'UNKNOWN'))
    if (!vk) continue

    const short = v.routeId ? routes.get(v.routeId)?.short || v.routeId : ''
    const rk = short ? keys.route.get(short) ?? null : null

    rows.push([
      serviceNow(utcTs).isoDate,
      vk,
      utcTs,
      e7(v.lat as number),
      e7(v.lon as number),
      u(v.speed, 10),          // m/s -> dm/s
      u(v.bearing, 1, 359),
      rk,
      v.tripId || null,        // csak nyom, NEM kulcs — a feed trip_id-je megbízhatatlan
    ])
  }
  if (!rows.length) return { kept: 0, dup: 0, vehicles: list.length, ok: true }

  const [res] = await pool.query(
    `INSERT IGNORE INTO veh_ping
       (service_date, vehicle_key, feed_ts, lat_e7, lon_e7, speed_dms, bearing_deg, route_key, trip_hint)
     VALUES ?`,
    [rows]
  )
  const kept = (res as { affectedRows: number }).affectedRows
  return { kept, dup: rows.length - kept, vehicles: list.length, ok: true }
}

/** Napi feed-egészség: ebből derül ki utólag, mikor volt hiányos az adatgyűjtés. */
export async function recordHealth(pool: Pool, r: CollectResult): Promise<void> {
  const date = serviceNow().isoDate
  await pool.query(
    `INSERT INTO feed_health (service_date, polls_ok, polls_fail, pings_kept, pings_dup, vehicles_max)
       VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       polls_ok = polls_ok + VALUES(polls_ok),
       polls_fail = polls_fail + VALUES(polls_fail),
       pings_kept = pings_kept + VALUES(pings_kept),
       pings_dup = pings_dup + VALUES(pings_dup),
       vehicles_max = GREATEST(vehicles_max, VALUES(vehicles_max))`,
    [date, r.ok ? 1 : 0, r.ok ? 0 : 1, r.kept, r.dup, r.vehicles]
  )
}
