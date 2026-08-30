/**
 * Megosztott GTFS-tár és geometria.
 *
 * Az API gateway (`src/index.ts`) és a statisztikai worker (`src/worker/`) is
 * ezt használja — egyik sem tart saját másolatot a betöltőből. A Map-eket
 * `loadGtfs()` HELYBEN üríti és tölti újra (soha nem cseréli ki a
 * referenciákat), ezért a hívó oldalon a destrukturált hivatkozások a feed
 * újratöltése után is érvényesek maradnak.
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type Stop = { id: string; code: string; name: string; lat: number; lon: number }
export type Route = { id: string; short: string; long: string; type: string; color: string; text: string }
export type Trip = { routeId: string; headsign: string; dir: string; serviceId: string; shapeId: string }

export const stops = new Map<string, Stop>()
export const routes = new Map<string, Route>()
export const trips = new Map<string, Trip>()
/** `${tripId} ${stopId}` -> menetrendi indulás mp-ben éjfél óta (lehet > 86400). */
export const schedByTripStop = new Map<string, number>()
export const stopSched = new Map<string, { trip: string; dep: number }[]>()
export const serviceByDate = new Map<string, { add: Set<string>; rem: Set<string> }>()
export const shapes = new Map<string, [number, number][]>()
export const routeStops = new Map<string, Set<string>>()
export const routeShapeIds = new Map<string, Set<string>>()
/** trip -> megállói indulási idő szerint rendezve, `seq` a GTFS stop_sequence. */
export const tripStops = new Map<string, { stopId: string; dep: number; seq: number }[]>()

let feedVersion = ''
export const getFeedVersion = () => feedVersion

// ── CSV ──────────────────────────────────────────────────────────────────
export function parseCsv(dir: string, name: string): Record<string, string>[] {
  const path = join(dir, name)
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  const lines = text.split(/\r?\n/).filter((l) => l.length)
  if (!lines.length) return []
  const head = lines[0].split(',')
  const out: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    const row: Record<string, string> = {}
    head.forEach((h, j) => (row[h] = cols[j] ?? ''))
    out.push(row)
  }
  return out
}

export function hhmmssToSec(t: string): number | null {
  const p = (t || '').trim().split(':')
  if (p.length < 2) return null
  const n = +p[0] * 3600 + +p[1] * 60 + (p[2] ? +p[2] : 0)
  return Number.isFinite(n) ? n : null
}

// ── idő ──────────────────────────────────────────────────────────────────
/**
 * Az Europe/Budapest UTC-eltolás az adott pillanatban, GÉPFÜGGETLENÜL.
 *
 * Az MVK feed a helyi időt teszi a unix-mezőkbe (mérve: +7200 mp nyáron),
 * ezért beérkezéskor ezzel kell visszakorrigálni valódi UTC-re. A gép saját
 * offsetjére hagyatkozni azért hibás, mert a szerver átkerülhet más
 * időzónába — a feed viszont akkor is budapesti marad.
 */
export function budapestOffsetSec(at: Date = new Date()): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Budapest',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(
    f.formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])
  ) as Record<string, number>
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 1000)
}

/**
 * Üzemi nap: hajnali 3 óráig még az ELŐZŐ naphoz tartozunk, mert a GTFS a
 * 24:00 utáni indulásokat is az előző naphoz sorolja (`24:30:00`).
 */
export const SERVICE_DAY_CUTOFF_SEC = 3 * 3600

export type NowInfo = {
  /** Valódi UTC unix. */
  unix: number
  /** Budapesti eltolás mp-ben. */
  offset: number
  /** Üzemi nap `YYYYMMDD` alakban (GTFS-kompatibilis). */
  ymd: string
  /** Üzemi nap `YYYY-MM-DD` alakban (MySQL DATE). */
  isoDate: string
  /** Mp az üzemi nap éjfele óta — hajnali 2-kor ez 26·3600 körül van. */
  secOfDay: number
  /** Az üzemi nap éjfelének valódi UTC unix-a. */
  midnightUnix: number
}

export function serviceNow(atUnix: number = Math.floor(Date.now() / 1000)): NowInfo {
  const offset = budapestOffsetSec(new Date(atUnix * 1000))
  const local = atUnix + offset
  let secOfDay = ((local % 86400) + 86400) % 86400
  let midnightLocal = local - secOfDay
  // Hajnali 3 előtt az előző üzemi naphoz tartozunk.
  if (secOfDay < SERVICE_DAY_CUTOFF_SEC) {
    midnightLocal -= 86400
    secOfDay += 86400
  }
  const d = new Date(midnightLocal * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return {
    unix: atUnix,
    offset,
    ymd: `${y}${m}${day}`,
    isoDate: `${y}-${m}-${day}`,
    secOfDay,
    midnightUnix: midnightLocal - offset,
  }
}

export const ymdToIso = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
export const isoToYmd = (iso: string) => iso.replace(/-/g, '')

export function activeServices(ymd: string): Set<string> {
  const e = serviceByDate.get(ymd)
  const s = new Set<string>()
  if (e) {
    e.add.forEach((x) => s.add(x))
    e.rem.forEach((x) => s.delete(x))
  }
  return s
}

// ── geometria ────────────────────────────────────────────────────────────
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/**
 * Pont vetítése vonalgeometriára. `alongKm` a vetített pont távolsága a shape
 * KEZDETÉTŐL (mennyit haladt előre az útvonalon — irányfüggetlenül, csak a
 * geometriából, mert a GPS bearing megbízhatatlan), `distKm` pedig az, hogy a
 * pont valójában milyen messze esik magától az útvonaltól. Nagy `distKm`
 * esetén a pont NINCS ezen az útvonalon, és az `alongKm` félrevezető.
 */
export function projectOntoShapeKm(
  shape: [number, number][],
  lat: number,
  lon: number
): { alongKm: number; distKm: number } | null {
  if (shape.length < 2) return null
  const refLat = shape[0][0]
  const kx = 111.32 * Math.cos((refLat * Math.PI) / 180)
  const ky = 111.32
  const toXY = (la: number, lo: number): [number, number] => [lo * kx, la * ky]
  const [px, py] = toXY(lat, lon)
  let cumKm = 0
  let bestDistKm = Infinity
  let bestAlongKm = 0
  for (let i = 0; i < shape.length - 1; i++) {
    const [ax, ay] = toXY(shape[i][0], shape[i][1])
    const [bx, by] = toXY(shape[i + 1][0], shape[i + 1][1])
    const dx = bx - ax
    const dy = by - ay
    const segLen2 = dx * dx + dy * dy
    let t = segLen2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLen2 : 0
    t = Math.max(0, Math.min(1, t))
    const projX = ax + t * dx
    const projY = ay + t * dy
    const dist = Math.hypot(px - projX, py - projY)
    if (dist < bestDistKm) {
      bestDistKm = dist
      bestAlongKm = cumKm + Math.hypot(projX - ax, projY - ay)
    }
    cumKm += Math.hypot(dx, dy)
  }
  return { alongKm: bestAlongKm, distKm: bestDistKm }
}

// ── betöltés ─────────────────────────────────────────────────────────────
function buildRouteIndex() {
  const bestByDir = new Map<string, { shapeId: string; len: number }>()
  for (const t of trips.values()) {
    if (!t.shapeId) continue
    const len = shapes.get(t.shapeId)?.length ?? 0
    if (!len) continue
    const key = t.routeId + '|' + t.dir
    const cur = bestByDir.get(key)
    if (!cur || len > cur.len) bestByDir.set(key, { shapeId: t.shapeId, len })
  }
  for (const [key, v] of bestByDir) {
    const rid = key.slice(0, key.lastIndexOf('|'))
    let set = routeShapeIds.get(rid)
    if (!set) routeShapeIds.set(rid, (set = new Set()))
    set.add(v.shapeId)
  }
  for (const [stopId, arr] of stopSched) {
    for (const x of arr) {
      const rid = trips.get(x.trip)?.routeId
      if (!rid) continue
      let set = routeStops.get(rid)
      if (!set) routeStops.set(rid, (set = new Set()))
      set.add(stopId)
    }
  }
}

export function loadGtfs(dir: string) {
  stops.clear(); routes.clear(); trips.clear(); schedByTripStop.clear()
  stopSched.clear(); serviceByDate.clear(); shapes.clear()
  routeStops.clear(); routeShapeIds.clear(); tripStops.clear()
  patternCache.clear(); alongCache.clear()

  for (const s of parseCsv(dir, 'stops.txt')) {
    const lat = parseFloat(s.stop_lat)
    const lon = parseFloat(s.stop_lon)
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      stops.set(s.stop_id, { id: s.stop_id, code: s.stop_code || '', name: s.stop_name || '', lat, lon })
    }
  }
  for (const r of parseCsv(dir, 'routes.txt')) {
    routes.set(r.route_id, {
      id: r.route_id, short: r.route_short_name || '', long: r.route_long_name || '',
      type: r.route_type || '', color: r.route_color || '888888', text: r.route_text_color || 'FFFFFF',
    })
  }
  for (const t of parseCsv(dir, 'trips.txt')) {
    trips.set(t.trip_id, {
      routeId: t.route_id, headsign: (t.trip_headsign || '').trim(), dir: t.direction_id || '',
      serviceId: t.service_id, shapeId: t.shape_id || '',
    })
  }
  for (const st of parseCsv(dir, 'stop_times.txt')) {
    const dep = hhmmssToSec(st.departure_time || st.arrival_time)
    if (dep == null) continue
    schedByTripStop.set(st.trip_id + ' ' + st.stop_id, dep)
    let arr = stopSched.get(st.stop_id)
    if (!arr) stopSched.set(st.stop_id, (arr = []))
    if (!arr.some((x) => x.trip === st.trip_id && x.dep === dep)) arr.push({ trip: st.trip_id, dep })
    let ts = tripStops.get(st.trip_id)
    if (!ts) tripStops.set(st.trip_id, (ts = []))
    ts.push({ stopId: st.stop_id, dep, seq: parseInt(st.stop_sequence) || ts.length + 1 })
  }
  for (const arr of stopSched.values()) arr.sort((a, b) => a.dep - b.dep)
  for (const arr of tripStops.values()) arr.sort((a, b) => a.seq - b.seq)
  for (const c of parseCsv(dir, 'calendar_dates.txt')) {
    let e = serviceByDate.get(c.date)
    if (!e) serviceByDate.set(c.date, (e = { add: new Set(), rem: new Set() }))
    ;(c.exception_type === '1' ? e.add : e.rem).add(c.service_id)
  }
  const shp = new Map<string, { seq: number; lat: number; lon: number }[]>()
  for (const r of parseCsv(dir, 'shapes.txt')) {
    const lat = parseFloat(r.shape_pt_lat)
    const lon = parseFloat(r.shape_pt_lon)
    const seq = parseInt(r.shape_pt_sequence)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    let a = shp.get(r.shape_id)
    if (!a) shp.set(r.shape_id, (a = []))
    a.push({ seq, lat, lon })
  }
  for (const [id, a] of shp) {
    a.sort((x, y) => x.seq - y.seq)
    shapes.set(id, a.map((p) => [p.lat, p.lon] as [number, number]))
  }
  buildRouteIndex()
  feedVersion = parseCsv(dir, 'feed_info.txt')[0]?.feed_version || ''
  return {
    stops: stops.size, routes: routes.size, trips: trips.size,
    stopTimes: schedByTripStop.size, shapes: shapes.size, feedVersion,
  }
}

// ── worker-specifikus segédek ────────────────────────────────────────────
const patternCache = new Map<string, string>()

/**
 * Menetminta-ujjlenyomat: két menet akkor ugyanaz a "minta", ha ugyanazokat a
 * megállókat érinti ugyanabban a sorrendben, ugyanabban az irányban. Ez az a
 * fogalom, ami túléli a GTFS-feed rotációját — a `trip_id` nem.
 */
export function patternHash(tripId: string): string | null {
  const cached = patternCache.get(tripId)
  if (cached) return cached
  const t = trips.get(tripId)
  const seq = tripStops.get(tripId)
  if (!t || !seq?.length) return null
  const raw = `${t.routeId}|${t.dir}|${seq.map((x) => x.stopId).join(',')}`
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 16)
  patternCache.set(tripId, h)
  return h
}

export type StopAlong = { stopId: string; dep: number; seq: number; alongM: number }
const alongCache = new Map<string, StopAlong[] | null>()

/**
 * A menet megállói a vonalgeometria mentén mért haladási távolsággal.
 *
 * Ez a megálló-detektálás alapja: nem sugaras geokerítéssel dolgozunk (az az
 * út két oldalán lévő ellenkező irányú megállópárt együtt kapná el), hanem
 * azt figyeljük, mikor lépi át a jármű haladási pozíciója a megállóét.
 */
export function tripStopsAlong(tripId: string): StopAlong[] | null {
  if (alongCache.has(tripId)) return alongCache.get(tripId) ?? null
  const t = trips.get(tripId)
  const seq = tripStops.get(tripId)
  const shape = t?.shapeId ? shapes.get(t.shapeId) : null
  if (!t || !seq?.length || !shape) {
    alongCache.set(tripId, null)
    return null
  }
  const out: StopAlong[] = []
  for (const x of seq) {
    const s = stops.get(x.stopId)
    if (!s) continue
    const p = projectOntoShapeKm(shape, s.lat, s.lon)
    if (!p) continue
    out.push({ stopId: x.stopId, dep: x.dep, seq: x.seq, alongM: Math.round(p.alongKm * 1000) })
  }
  // A vetített haladásnak monotonnak kell lennie; ha nem az (hurkolt vonal),
  // a menet nem alkalmas szakaszmérésre.
  for (let i = 1; i < out.length; i++) {
    if (out[i].alongM <= out[i - 1].alongM) {
      alongCache.set(tripId, null)
      return null
    }
  }
  alongCache.set(tripId, out)
  return out
}

/** Az adott üzemi nap helyi éjfelének valódi UTC unix-a. */
export function localMidnightUnix(isoDate: string): number {
  const base = Math.floor(Date.parse(isoDate + 'T00:00:00Z') / 1000)
  return base - budapestOffsetSec(new Date(base * 1000))
}
