/**
 * MVK MobilON+ backend (Hono + TypeScript).
 *  - Frontend a `/`-on; /live/positions, /live/arrivals?stop=SP1, /live/trip-path?trip=T
 *  - /api/* -> https://mccaze.mvkzrt.hu:8443 (Bearer beinjektálva)
 *  - Token: state/jwt.txt; GTFS indításkor frissül.
 */
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const STATE_DIR = join(ROOT, 'state')
const GTFS_DIR = join(ROOT, 'gtfs')
const FRONTEND = join(ROOT, '..', 'frontend', 'dashboard.html')
const JWT_FILE = join(STATE_DIR, 'jwt.txt')
const INST_FILE = join(STATE_DIR, 'installation_id.txt')
mkdirSync(STATE_DIR, { recursive: true })

const API_ORIGIN = 'https://mccaze.mvkzrt.hu:8443'
const GTFS_ORIGIN = 'http://84.206.68.21:8080'
const PORT = Number(process.env.PORT ?? 8088)
const HOST = process.env.HOST ?? '127.0.0.1'
const AUTO_RENEW = (process.env.AUTO_RENEW ?? '1') !== '0'
const RENEW_PATH = process.env.RENEW_PATH ?? '/api/v1/installation/generate-jwt'
const RENEW_MARGIN_SEC = Number(process.env.RENEW_MARGIN_SEC ?? 900)
const CHECK_INTERVAL_SEC = Number(process.env.CHECK_INTERVAL_SEC ?? 120)
// élő hozzárendelés hangolása:
const LIVE_MAX_KM = Number(process.env.LIVE_MAX_KM ?? 12)   // ennél távolabbi busz nem élő
const LIVE_MAX_ETA = Number(process.env.LIVE_MAX_ETA ?? 60) // ennél későbbi érkezés nem élő

const { transit_realtime } = GtfsRealtimeBindings

// ── token / jwt ──
const readFileSafe = (p: string) => { try { return readFileSync(p, 'utf8').trim() } catch { return '' } }
const readJwt = () => readFileSafe(JWT_FILE)
const readInstallationId = () => readFileSafe(INST_FILE)
const writeJwt = (t: string) => writeFileSync(JWT_FILE, t)
function decodeClaims(tok: string): Record<string, unknown> {
  try { const part = tok.split('.')[1] ?? ''; return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) } catch { return {} }
}
type JwtStatus = { present: boolean; exp?: number; expiresInSec?: number | null; expired?: boolean; installationId?: string }
function jwtStatus(tok: string): JwtStatus {
  if (!tok || tok.split('.').length !== 3) return { present: false }
  const c = decodeClaims(tok); const exp = typeof c.exp === 'number' ? c.exp : undefined; const now = Math.floor(Date.now() / 1000)
  return { present: true, exp, expiresInSec: exp ? exp - now : null, expired: exp !== undefined && exp <= now, installationId: typeof c['installation-id'] === 'string' ? (c['installation-id'] as string) : undefined }
}

// ── GTFS statikus ──
type Stop = { id: string; code: string; name: string; lat: number; lon: number }
type Route = { id: string; short: string; long: string; type: string; color: string; text: string }
type Trip = { routeId: string; headsign: string; dir: string; serviceId: string; shapeId: string }
const stops = new Map<string, Stop>()
const routes = new Map<string, Route>()
const trips = new Map<string, Trip>()
const schedByTripStop = new Map<string, number>()
const stopSched = new Map<string, { trip: string; dep: number }[]>()
const serviceByDate = new Map<string, { add: Set<string>; rem: Set<string> }>()
const shapes = new Map<string, [number, number][]>()
// Járatszűrőhöz épített indexek (loadGtfs tölti):
const routeStops = new Map<string, Set<string>>()     // routeId -> érintett megállók
const routeShapeIds = new Map<string, Set<string>>()  // routeId -> irányonként a leghosszabb shape
// Menetrend nézethez: trip -> a menet megállói indulási idő szerint rendezve.
const tripStops = new Map<string, { stopId: string; dep: number }[]>()
let feedVersion = ''

function parseCsv(name: string): Record<string, string>[] {
  const path = join(GTFS_DIR, name); if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  const lines = text.split(/\r?\n/).filter((l) => l.length); if (!lines.length) return []
  const head = lines[0].split(','); const out: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) { const cols = lines[i].split(','); const row: Record<string, string> = {}; head.forEach((h, j) => (row[h] = cols[j] ?? '')); out.push(row) }
  return out
}
function hhmmssToSec(t: string): number | null {
  const p = (t || '').trim().split(':'); if (p.length < 2) return null
  const n = +p[0] * 3600 + +p[1] * 60 + (p[2] ? +p[2] : 0); return Number.isFinite(n) ? n : null
}
/**
 * Járatonkénti index: melyik megállókat érinti, és irányonként melyik a leghosszabb
 * (legteljesebb) vonalgeometria. A dashboard járatszűrője ebből rajzolja a vonalat
 * és ebből tudja, mely megállók tartoznak a kiválasztott járatokhoz.
 */
function buildRouteIndex() {
  const bestByDir = new Map<string, { shapeId: string; len: number }>()
  for (const t of trips.values()) {
    if (!t.shapeId) continue
    const len = shapes.get(t.shapeId)?.length ?? 0; if (!len) continue
    const key = t.routeId + '|' + t.dir; const cur = bestByDir.get(key)
    if (!cur || len > cur.len) bestByDir.set(key, { shapeId: t.shapeId, len })
  }
  for (const [key, v] of bestByDir) {
    const rid = key.slice(0, key.lastIndexOf('|'))
    let set = routeShapeIds.get(rid); if (!set) routeShapeIds.set(rid, (set = new Set()))
    set.add(v.shapeId)
  }
  for (const [stopId, arr] of stopSched) {
    for (const x of arr) {
      const rid = trips.get(x.trip)?.routeId; if (!rid) continue
      let set = routeStops.get(rid); if (!set) routeStops.set(rid, (set = new Set()))
      set.add(stopId)
    }
  }
}

function loadGtfs() {
  stops.clear(); routes.clear(); trips.clear(); schedByTripStop.clear(); stopSched.clear(); serviceByDate.clear(); shapes.clear(); routeStops.clear(); routeShapeIds.clear(); tripStops.clear()
  for (const s of parseCsv('stops.txt')) { const lat = parseFloat(s.stop_lat), lon = parseFloat(s.stop_lon); if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, { id: s.stop_id, code: s.stop_code || '', name: s.stop_name || '', lat, lon }) }
  for (const r of parseCsv('routes.txt')) routes.set(r.route_id, { id: r.route_id, short: r.route_short_name || '', long: r.route_long_name || '', type: r.route_type || '', color: r.route_color || '888888', text: r.route_text_color || 'FFFFFF' })
  for (const t of parseCsv('trips.txt')) trips.set(t.trip_id, { routeId: t.route_id, headsign: (t.trip_headsign || '').trim(), dir: t.direction_id || '', serviceId: t.service_id, shapeId: t.shape_id || '' })
  for (const st of parseCsv('stop_times.txt')) {
    const dep = hhmmssToSec(st.departure_time || st.arrival_time); if (dep == null) continue
    schedByTripStop.set(st.trip_id + ' ' + st.stop_id, dep)
    let arr = stopSched.get(st.stop_id); if (!arr) stopSched.set(st.stop_id, (arr = []))
    if (!arr.some((x) => x.trip === st.trip_id && x.dep === dep)) arr.push({ trip: st.trip_id, dep })
    let ts = tripStops.get(st.trip_id); if (!ts) tripStops.set(st.trip_id, (ts = []))
    ts.push({ stopId: st.stop_id, dep })
  }
  for (const arr of stopSched.values()) arr.sort((a, b) => a.dep - b.dep)
  for (const arr of tripStops.values()) arr.sort((a, b) => a.dep - b.dep)
  for (const c of parseCsv('calendar_dates.txt')) { let e = serviceByDate.get(c.date); if (!e) serviceByDate.set(c.date, (e = { add: new Set(), rem: new Set() })); (c.exception_type === '1' ? e.add : e.rem).add(c.service_id) }
  const shp = new Map<string, { seq: number; lat: number; lon: number }[]>()
  for (const r of parseCsv('shapes.txt')) { const lat = parseFloat(r.shape_pt_lat), lon = parseFloat(r.shape_pt_lon), seq = parseInt(r.shape_pt_sequence); if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue; let a = shp.get(r.shape_id); if (!a) shp.set(r.shape_id, (a = [])); a.push({ seq, lat, lon }) }
  for (const [id, a] of shp) { a.sort((x, y) => x.seq - y.seq); shapes.set(id, a.map((p) => [p.lat, p.lon] as [number, number])) }
  buildRouteIndex()
  feedVersion = parseCsv('feed_info.txt')[0]?.feed_version || ''
  console.log(`[GTFS] stops=${stops.size} routes=${routes.size} trips=${trips.size} stopTimes=${schedByTripStop.size} shapes=${shapes.size} feed=${feedVersion}`)
}
// A gép SAJÁT helyi offsetjét használjuk (nem a hibás Intl Europe/Budapest-et).
// TZ_OFFSET_SEC env-vel felülírható (nyáron 7200 = +2h).
function tzOffsetSec(): number { return Number(process.env.TZ_OFFSET_SEC ?? -new Date().getTimezoneOffset() * 60) }
// Bármely unix-ból tiszta aritmetikával Budapest HH:MM (nincs tz-adatbázis).
function hmFromUnix(unix: number): string {
  const d = new Date((unix + tzOffsetSec()) * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
function budapestNow() {
  const unix = Math.floor(Date.now() / 1000); const offset = tzOffsetSec()
  const secOfDay = (((unix + offset) % 86400) + 86400) % 86400
  const d = new Date((unix + offset) * 1000)
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  return { ymd, secOfDay, unix, midnightUnix: unix - secOfDay, offset }
}
function activeServices(ymd: string): Set<string> {
  const e = serviceByDate.get(ymd); const s = new Set<string>()
  if (e) { e.add.forEach((x) => s.add(x)); e.rem.forEach((x) => s.delete(x)) }
  return s
}
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, dLat = ((bLat - aLat) * Math.PI) / 180, dLon = ((bLon - aLon) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
/**
 * Egy pont (lat/lon) vetítése egy shape (útvonal-polyline) mentén: visszaadja, hány km-re
 * van a vetített pont a shape KEZDETÉTŐL ("alongKm" — mennyire "haladt előre" valami az
 * útvonalon, irányfüggetlenül, csak a geometriára hagyatkozva, mert a pillanatnyi GPS
 * bearing megbízhatatlan), ÉS hogy a pont ténylegesen milyen messze esik magától az
 * útvonaltól ("distKm" — ha ez nagy, a pont valójában NINCS ezen az útvonalon, az "along"
 * érték ilyenkor félrevezető és nem szabad rá támaszkodni).
 */
function projectOntoShapeKm(shape: [number, number][], lat: number, lon: number): { alongKm: number; distKm: number } | null {
  if (shape.length < 2) return null
  const refLat = shape[0][0]
  const kx = 111.32 * Math.cos((refLat * Math.PI) / 180), ky = 111.32
  const toXY = (la: number, lo: number): [number, number] => [lo * kx, la * ky]
  const [px, py] = toXY(lat, lon)
  let cumKm = 0, bestDistKm = Infinity, bestAlongKm = 0
  for (let i = 0; i < shape.length - 1; i++) {
    const [ax, ay] = toXY(shape[i][0], shape[i][1])
    const [bx, by] = toXY(shape[i + 1][0], shape[i + 1][1])
    const dx = bx - ax, dy = by - ay
    const segLen2 = dx * dx + dy * dy
    let t = segLen2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLen2 : 0
    t = Math.max(0, Math.min(1, t))
    const projX = ax + t * dx, projY = ay + t * dy
    const distKm = Math.hypot(px - projX, py - projY)
    const segLenKm = Math.hypot(dx, dy)
    if (distKm < bestDistKm) { bestDistKm = distKm; bestAlongKm = cumKm + t * segLenKm }
    cumKm += segLenKm
  }
  return { alongKm: bestAlongKm, distKm: bestDistKm }
}

// ── MVK fetch + GTFS-RT ──
let tokenRejectedAt = 0 // mikor utasított el a szerver egy ÉRVÉNYES (nem lejárt) tokent
async function mvkFetch(path: string): Promise<{ status: number; buf: Buffer }> {
  const tok = readJwt(); const headers: Record<string, string> = { accept: 'application/json' }
  if (tok) headers.authorization = `Bearer ${tok}`
  const res = await fetch(API_ORIGIN + path, { headers })
  if (res.status === 401 || res.status === 403) { const st = jwtStatus(tok); if (st.present && !st.expired) { tokenRejectedAt = Math.floor(Date.now() / 1000); console.log(`[api] ⚠️ ${res.status} érvényes tokenre → app-refresh jelzés`) } }
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) }
}
/**
 * Valós idejű feed-gyorsítótár.
 *
 * Az MVK API-hívás ~150 ms. Korábban minden kliens-kérés külön felment
 * upstream-re: hat megállókártya négymásodpercenként tizenkét hívást
 * indított ugyanazért a két feedért. Itt egy háttérhurok tartja frissen a
 * két feedet, a végpontok pedig a memóriából szolgálnak ki (~1 ms).
 */
const FEED_TTL_MS = 2000
type FeedEntry = { at: number; status: number; buf: Buffer; inflight: Promise<{ status: number; buf: Buffer }> | null }
const feedCache = new Map<string, FeedEntry>()

async function cachedFeed(path: string): Promise<{ status: number; buf: Buffer }> {
  const entry = feedCache.get(path)
  if (entry && Date.now() - entry.at < FEED_TTL_MS) return { status: entry.status, buf: entry.buf }
  // Egyszerre érkező kérések ugyanarra a feedre egyetlen upstream hívást kapnak.
  if (entry?.inflight) return entry.inflight

  const inflight = mvkFetch(path)
    .then((res) => {
      feedCache.set(path, { at: Date.now(), status: res.status, buf: res.buf, inflight: null })
      return res
    })
    .catch((err) => {
      // Hiba esetén az előző (elavult) válasz jobb, mint a semmi.
      const prev = feedCache.get(path)
      if (prev) feedCache.set(path, { ...prev, inflight: null })
      else feedCache.delete(path)
      throw err
    })

  feedCache.set(path, {
    at: entry?.at ?? 0,
    status: entry?.status ?? 0,
    buf: entry?.buf ?? Buffer.alloc(0),
    inflight,
  })
  return inflight
}

/** A dekódolt járműlista is gyorsítótárazva: kártyánként újradekódolni pazarlás. */
let vehiclesCache: { at: number; list: LiveVeh[] } | null = null

function decodeVehicles(buf: Buffer) {
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buf)); const out: unknown[] = []
  for (const e of feed.entity) {
    const v = e.vehicle; if (!v) continue
    const tripId = v.trip?.tripId || ''; const routeId = v.trip?.routeId || trips.get(tripId)?.routeId || ''; const r = routes.get(routeId)
    out.push({ id: v.vehicle?.id || e.id, label: v.vehicle?.label || '', routeId, routeShort: r?.short || routeId, routeColor: r?.color || '888888', routeText: r?.text || 'FFFFFF', headsign: trips.get(tripId)?.headsign || '', lat: v.position?.latitude ?? null, lon: v.position?.longitude ?? null, bearing: v.position?.bearing ?? null, speed: v.position?.speed ?? null, tripId, timestamp: v.timestamp ? Number(v.timestamp) : null })
  }
  return { header: { version: feed.header.gtfsRealtimeVersion, timestamp: Number(feed.header.timestamp || 0) }, vehicles: out }
}

type LiveVeh = { id: string; lat: number; lon: number; bearing: number | null; speed: number | null; routeId: string; tripId: string }
async function activeVehicles(): Promise<LiveVeh[]> {
  if (vehiclesCache && Date.now() - vehiclesCache.at < FEED_TTL_MS) return vehiclesCache.list
  const out: LiveVeh[] = []
  try {
    const { status, buf } = await cachedFeed('/api/v1/gtfs/get-positions'); if (status !== 200) return out
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buf))
    for (const e of feed.entity) {
      const v = e.vehicle; if (v?.position?.latitude == null) continue
      const tripId = v.trip?.tripId || ''; const routeId = v.trip?.routeId || trips.get(tripId)?.routeId || ''
      out.push({ id: v.vehicle?.id || e.id, lat: v.position.latitude, lon: v.position.longitude, bearing: v.position.bearing ?? null, speed: v.position.speed ?? null, routeId, tripId })
    }
    vehiclesCache = { at: Date.now(), list: out }
  } catch { /* üres */ }
  return out
}

/**
 * VALÓS érkezések. Az élő buszokat POZÍCIÓ szerint rendeljük hozzá: vonalanként a
 * stophoz legközelebbi élő járművek a LEGKORÁBBI érkezésekhez, SORJÁBAN. Az MVK
 * trip_id-je megbízhatatlan, ezért nem arra hagyatkozunk. Csak közeli busz
 * (≤LIVE_MAX_KM) és ≤LIVE_MAX_ETA perces érkezés kaphat élőt.
 */
async function arrivalsForStop(stopId: string, limit: number) {
  const now = budapestNow()
  const active = activeServices(now.ymd)
  const vehicles = await activeVehicles()

  const pred = new Map<string, { unix: number; delay: number | null }>()
  let rtErr: string | null = null
  try {
    const { status, buf } = await cachedFeed('/api/v1/gtfs/get-updates')
    if (status === 200) {
      const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buf))
      for (const e of feed.entity) {
        const tu = e.tripUpdate; if (!tu) continue
        const tripId = tu.trip?.tripId || ''
        for (const stu of tu.stopTimeUpdate || []) {
          if ((stu.stopId || '') !== stopId) continue
          let unix: number | null = null, delay: number | null = null
          if (stu.arrival?.time) unix = Number(stu.arrival.time) - now.offset; else if (stu.departure?.time) unix = Number(stu.departure.time) - now.offset
          if (stu.arrival?.delay != null || stu.departure?.delay != null) delay = Number(stu.arrival?.delay ?? stu.departure?.delay)
          if (unix == null && delay != null) { const s = schedByTripStop.get(tripId + ' ' + stopId); if (s != null) unix = now.midnightUnix + s + delay }
          if (unix != null && !pred.has(tripId)) pred.set(tripId, { unix, delay })
        }
      }
    } else rtErr = `get-updates HTTP ${status}`
  } catch (err) { rtErr = (err as Error).message }

  // dedup trip_id szerint; RT-idő ha van (VALÓS érkezés), különben menetrend
  const cand = new Map<string, { unix: number; delay: number | null; hasRT: boolean }>()
  for (const { trip, dep } of stopSched.get(stopId) || []) {
    const tr = trips.get(trip); if (!tr || !active.has(tr.serviceId)) continue
    if (cand.has(trip)) continue
    const p = pred.get(trip)
    cand.set(trip, { unix: p?.unix ?? now.midnightUnix + dep, delay: p?.delay ?? null, hasRT: !!p })
  }
  for (const [trip, p] of pred) if (!cand.has(trip)) cand.set(trip, { unix: p.unix, delay: p.delay, hasRT: true })

  // Helper to find nearest stop {id, name}
  const findNearestStop = (lat: number, lon: number): { id: string; name: string } | null => {
    let bestDist = Infinity
    let best: { id: string; name: string } | null = null
    for (const s of stops.values()) {
      const d = haversineKm(lat, lon, s.lat, s.lon)
      if (d < bestDist) { bestDist = d; best = { id: s.id, name: s.name } }
    }
    return best
  }

  // jármű trip_id szerint vagy vonalanként legközelebbi aktív jármű
  const vehByTrip = new Map<string, LiveVeh>()
  for (const v of vehicles) if (v.tripId) vehByTrip.set(v.tripId, v)

  const seen = new Set<string>()
  const rows = [...cand.entries()]
    .map(([tripId, x]) => ({ tripId, unix: x.unix, delay: x.delay, hasRT: x.hasRT, routeId: trips.get(tripId)?.routeId || '', headsign: trips.get(tripId)?.headsign || '' }))
    .filter((x) => x.unix >= now.unix - 60)
    .sort((a, b) => a.unix - b.unix || (b.hasRT ? 1 : 0) - (a.hasRT ? 1 : 0))
    .filter((x) => { const k = x.routeId + '|' + hmFromUnix(x.unix) + '|' + x.headsign; if (seen.has(k)) return false; seen.add(k); return true })
  const s = stops.get(stopId)

  // Egy fizikai jármű csak EGY (a legkorábbi, hozzá illő) érkezéshez rendelhető —
  // különben ugyanaz a busz több jövőbeli járatnál is "élőnek" tűnik.
  const usedVehicleIds = new Set<string>()
  const arrivals = rows
    .map((x) => {
      const tr = trips.get(x.tripId); const r = routes.get(tr?.routeId || '')
      let veh = vehByTrip.get(x.tripId) || null
      if (veh) usedVehicleIds.add(veh.id)
      // Ha nincs közvetlen tripId egyezés, de fut (még szabad) jármű ugyanezen a vonalon:
      if (!veh) {
        const routeVehs = vehicles.filter((v) => {
          if (v.routeId !== tr?.routeId || usedVehicleIds.has(v.id)) return false
          // A routeId egyezés ODA-VISSZA irányban egyaránt teljesül (ugyanaz a routeId mindkét
          // irányban) — ha ismerjük a jármű saját (bár pontatlan, de irány szempontjából jó
          // közelítő) trip_id-jét, és az MÁSIK irányban közlekedik (pl. már megfordult és a
          // visszaútját kezdte meg), ne fogadjuk el találgatásnak, mert nem ez fogja
          // teljesíteni a keresett érkezést.
          const vDir = v.tripId ? trips.get(v.tripId)?.dir : undefined
          if (vDir != null && tr?.dir != null && vDir !== tr.dir) return false
          return true
        })
        if (routeVehs.length === 1) { veh = routeVehs[0]; usedVehicleIds.add(veh.id) }
      }

      let currentStopName: string | null = null
      let currentStopId: string | null = null
      let distanceToStopKm: number | null = null
      let progressDesc: string | null = null

      if (veh && s) {
        distanceToStopKm = +haversineKm(veh.lat, veh.lon, s.lat, s.lon).toFixed(1)
        const nearest = findNearestStop(veh.lat, veh.lon)
        currentStopName = nearest?.name ?? null
        currentStopId = nearest?.id ?? null
        const atStop = distanceToStopKm < 0.25
        if (currentStopName) {
          progressDesc = atStop ? `A megállóban van (${s.name})` : `${currentStopName} közelében (~${distanceToStopKm} km)`
        }

        // A hozzárendelt jármű élő infóját CSAK akkor tartjuk meg, ha ténylegesen hihető,
        // hogy ez a jármű még ezt a járatot fogja teljesíteni ennél a megállónál. Két
        // eset zárja ki (mindkettő az MVK feed megbízhatatlan tripId/routeId mezői miatt
        // fordulhat elő, ezért geometriára, nem pedig ezekre a mezőkre hagyatkozunk):
        let invalid = false
        if (!atStop && distanceToStopKm >= 0.15) {
          const shape = tr?.shapeId ? shapes.get(tr.shapeId) : null
          if (shape) {
            const vehProj = projectOntoShapeKm(shape, veh.lat, veh.lon)
            if (vehProj) {
              if (vehProj.distKm > 0.5) {
                // 1) ÚTVONALON KÍVÜL: a jármű valójában NINCS ezen az útvonalon (pl. az RT
                //    feed még a régi routeId-t adja rá, miközben már másik viszonylatra/
                //    irányba állt át) — ilyenkor a "vonalon egyetlen szabad jármű" találgatás
                //    tévedés, nem szabad hozzárendelni.
                invalid = true
              } else {
                const stopProj = projectOntoShapeKm(shape, s.lat, s.lon)
                // 2) MÁR ELHALADT: a jármű a menetrendnél korábban jár ("siet"), ezért az RT
                //    előrejelzés "MOST"-ot mutat, miközben GPS szerint már RÉGEN elhagyta a
                //    célmegállót. A pillanatnyi GPS-irány (bearing) erre megbízhatatlan —
                //    ehelyett az útvonal mentén megtett távolságot hasonlítjuk össze.
                if (stopProj && vehProj.alongKm > stopProj.alongKm + 0.1) invalid = true
              }
            }
          }
          // Kiegészítő jel (ha a shape hiányzik vagy a vetítés bizonytalan volt): ha a GPS
          // szerint legközelebbi megálló ugyanezen a trip-en a célmegálló UTÁN következik
          // a menetrend szerint, az is elhaladást jelez.
          if (!invalid && currentStopId && currentStopId !== stopId) {
            const targetDep = schedByTripStop.get(x.tripId + ' ' + stopId)
            const vehDep = schedByTripStop.get(x.tripId + ' ' + currentStopId)
            if (targetDep != null && vehDep != null && vehDep > targetDep + 30) invalid = true
          }
        }

        if (invalid) { veh = null; currentStopName = null; currentStopId = null; distanceToStopKm = null; progressDesc = null }
      }

      return {
        route: r?.short || tr?.routeId || '?', color: r?.color || '888888', text: r?.text || 'FFFFFF', headsign: tr?.headsign || '',
        time: hmFromUnix(x.unix),
        etaMin: Math.max(0, Math.round((x.unix - now.unix) / 60)),
        delaySec: x.delay, live: x.hasRT || veh != null, tripId: x.tripId, vehicle: veh,
        currentStopName,
        distanceToStopKm,
        progressDesc,
      }
    })
    .slice(0, limit)

  return {
    stop: s ? { id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon } : { id: stopId },
    now: now.unix, rtError: rtErr,
    arrivals,
  }
}

const FRONTEND_DIST = join(ROOT, '..', 'frontend', 'dist')
const FRONTEND_INDEX = join(FRONTEND_DIST, 'index.html')

// ── app ──
const app = new Hono()
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// Static frontend serving (dist fallback or dashboard.html)
app.get('/', (c) => {
  try {
    if (existsSync(FRONTEND_INDEX)) return c.html(readFileSync(FRONTEND_INDEX, 'utf8'))
    if (existsSync(FRONTEND)) return c.html(readFileSync(FRONTEND, 'utf8'))
    return c.html('<h1>MVK MobilON+ API Gateway</h1><p>Frontend elérhető: <a href="http://localhost:5173">http://localhost:5173</a></p>')
  } catch {
    return c.text('Frontend fájl nem található', 500)
  }
})

// Serve static assets from frontend/dist/assets if available
app.get('/assets/*', (c) => {
  const rel = c.req.path.replace(/^\/assets\//, '')
  const filePath = join(FRONTEND_DIST, 'assets', rel)
  if (existsSync(filePath)) {
    const buf = readFileSync(filePath)
    const ext = rel.split('.').pop()?.toLowerCase()
    const mimeMap: Record<string, string> = {
      js: 'application/javascript',
      css: 'text/css',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      json: 'application/json',
      woff2: 'font/woff2',
      woff: 'font/woff'
    }
    const ct = mimeMap[ext || ''] || 'application/octet-stream'
    return new Response(buf, { headers: { 'Content-Type': ct } })
  }
  return c.text('Not found', 404)
})

app.get('/gtfs/stops.json', (c) => c.json([...stops.values()].map((s) => [s.id, s.code, s.name, s.lat, s.lon])))
app.get('/gtfs/routes.json', (c) => c.json([...routes.values()].map((r) => [r.id, r.short, r.long, r.type, r.color, r.text])))
// Járatszűrő: egy vagy több járat vonalgeometriája + megállói (?route=20,1V vagy route_id).
app.get('/gtfs/route-geo', (c) => {
  const want = (c.req.query('route') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 16)
  if (!want.length) return c.json({ error: 'hiányzó ?route=' }, 400)
  const out = want.map((name) => {
    const r = routes.get(name) || [...routes.values()].find((x) => x.short.toLowerCase() === name.toLowerCase())
    if (!r) return null
    const geo = [...(routeShapeIds.get(r.id) || [])].map((id) => shapes.get(id) || []).filter((a) => a.length)
    return { id: r.id, short: r.short, long: r.long, type: r.type, color: r.color, text: r.text, shapes: geo, stops: [...(routeStops.get(r.id) || [])] }
  }).filter(Boolean)
  return c.json({ routes: out })
})
app.get('/gtfs/meta.json', (c) => c.json({ feedVersion, stops: stops.size, routes: routes.size, trips: trips.size }))

// ── Menetrendkönyv ───────────────────────────────────────────────────────────
/** Másodperc a nap kezdetétől -> HH:MM (a 24h fölötti éjszakai menetek is jók). */
function secToHm(sec: number): string {
  const h = Math.floor(sec / 3600) % 24
  const m = Math.floor((sec % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Egy adott napon közlekedő menetek egy járat + irány kombinációra. */
function tripsOfRouteDir(routeId: string, dir: string, ymd: string) {
  const active = activeServices(ymd)
  const out: { tripId: string; trip: Trip; stopsOfTrip: { stopId: string; dep: number }[] }[] = []
  for (const [tripId, t] of trips) {
    if (t.routeId !== routeId || t.dir !== dir) continue
    if (!active.has(t.serviceId)) continue
    const stopsOfTrip = tripStops.get(tripId)
    if (!stopsOfTrip || !stopsOfTrip.length) continue
    out.push({ tripId, trip: t, stopsOfTrip })
  }
  out.sort((a, b) => a.stopsOfTrip[0].dep - b.stopsOfTrip[0].dep)
  return out
}

/**
 * A menetrendkönyv tartalomjegyzéke: minden járat, irányonként bontva.
 * A leggyakoribb célállomás-felirat adja az irány nevét, mert a GTFS
 * direction_id (0/1) önmagában semmit nem mond az utasnak.
 */
app.get('/gtfs/timetable/routes', (c) => {
  const ymd = (c.req.query('date') || budapestNow().ymd).trim()
  const active = activeServices(ymd)

  type DirAgg = { headsigns: Map<string, number>; today: number; total: number; firstDep: number | null }
  const byRoute = new Map<string, Map<string, DirAgg>>()

  for (const [tripId, t] of trips) {
    if (!routes.has(t.routeId)) continue
    let dirs = byRoute.get(t.routeId)
    if (!dirs) byRoute.set(t.routeId, (dirs = new Map()))
    let agg = dirs.get(t.dir)
    if (!agg) dirs.set(t.dir, (agg = { headsigns: new Map(), today: 0, total: 0, firstDep: null }))

    agg.total++
    if (t.headsign) agg.headsigns.set(t.headsign, (agg.headsigns.get(t.headsign) || 0) + 1)
    if (active.has(t.serviceId)) {
      agg.today++
      const dep = tripStops.get(tripId)?.[0]?.dep
      if (dep != null && (agg.firstDep == null || dep < agg.firstDep)) agg.firstDep = dep
    }
  }

  const out = [...byRoute.entries()].map(([routeId, dirs]) => {
    const r = routes.get(routeId)!
    const directions = [...dirs.entries()]
      .map(([dir, agg]) => {
        let headsign = ''
        let best = -1
        for (const [h, n] of agg.headsigns) if (n > best) { best = n; headsign = h }
        return { dir, headsign, tripsToday: agg.today, tripsTotal: agg.total, firstDeparture: agg.firstDep == null ? null : secToHm(agg.firstDep) }
      })
      .sort((a, b) => a.dir.localeCompare(b.dir))
    return { id: r.id, short: r.short, long: r.long, type: r.type, color: r.color, text: r.text, directions }
  })

  out.sort((a, b) => {
    const na = parseInt(a.short, 10), nb = parseInt(b.short, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb || a.short.localeCompare(b.short, 'hu')
    if (!isNaN(na)) return -1
    if (!isNaN(nb)) return 1
    return a.short.localeCompare(b.short, 'hu')
  })

  return c.json({ date: ymd, routes: out })
})

/**
 * Egy járat egy irányának teljes napi menetrendje.
 *
 * A megállósor a legtöbb megállót érintő menetből származik (a betérők és a
 * rövidített menetek így is ugyanabba az oszloprendbe illeszkednek); minden
 * menetnél a hiányzó megállóhoz null kerül.
 */
app.get('/gtfs/timetable', (c) => {
  const routeId = (c.req.query('route') || '').trim()
  const dir = (c.req.query('dir') || '').trim()
  const ymd = (c.req.query('date') || budapestNow().ymd).trim()

  const route = routes.get(routeId)
  if (!route) return c.json({ error: 'Ismeretlen járat' }, 404)

  const list = tripsOfRouteDir(routeId, dir, ymd)
  if (!list.length) {
    return c.json({ route, dir, date: ymd, headsign: '', stops: [], trips: [], note: 'Ezen a napon nem közlekedik.' })
  }

  // Oszloprend: a legtöbb megállót érintő menet megállósora.
  const longest = list.reduce((a, b) => (b.stopsOfTrip.length > a.stopsOfTrip.length ? b : a), list[0])
  const stopOrder = longest.stopsOfTrip.map((x) => x.stopId)
  const indexOfStop = new Map(stopOrder.map((id, i) => [id, i]))

  const stopList = stopOrder.map((id) => {
    const s = stops.get(id)
    return { id, code: s?.code || '', name: s?.name || id, lat: s?.lat ?? null, lon: s?.lon ?? null }
  })

  let headsign = ''
  let best = -1
  const counts = new Map<string, number>()
  for (const x of list) if (x.trip.headsign) counts.set(x.trip.headsign, (counts.get(x.trip.headsign) || 0) + 1)
  for (const [h, n] of counts) if (n > best) { best = n; headsign = h }

  const tripRows = list.map((x) => {
    const times: (string | null)[] = new Array(stopOrder.length).fill(null)
    let extraCount = 0
    for (const st of x.stopsOfTrip) {
      const i = indexOfStop.get(st.stopId)
      if (i == null) { extraCount++; continue }
      times[i] = secToHm(st.dep)
    }
    const first = x.stopsOfTrip[0]
    const last = x.stopsOfTrip[x.stopsOfTrip.length - 1]
    return {
      tripId: x.tripId,
      headsign: x.trip.headsign || headsign,
      departure: secToHm(first.dep),
      departureSec: first.dep,
      arrival: secToHm(last.dep),
      originName: stops.get(first.stopId)?.name || first.stopId,
      destinationName: stops.get(last.stopId)?.name || last.stopId,
      stopCount: x.stopsOfTrip.length,
      /** A menet a fő megállósoron kívüli megállókat is érint (betérő). */
      deviates: extraCount > 0,
      times,
    }
  })

  return c.json({ route, dir, date: ymd, headsign, stops: stopList, trips: tripRows })
})

// ── Időjárás ─────────────────────────────────────────────────────────────────
/** WMO időjárás-kódok rövid magyar leírása (a fejléc egysoros kiírásához). */
const WMO_TEXT: Record<number, string> = {
  0: 'Derült', 1: 'Túlnyomóan derült', 2: 'Részben felhős', 3: 'Borult',
  45: 'Köd', 48: 'Zúzmarás köd',
  51: 'Gyenge szitálás', 53: 'Szitálás', 55: 'Erős szitálás',
  56: 'Ónos szitálás', 57: 'Erős ónos szitálás',
  61: 'Gyenge eső', 63: 'Eső', 65: 'Erős eső',
  66: 'Ónos eső', 67: 'Erős ónos eső',
  71: 'Gyenge havazás', 73: 'Havazás', 75: 'Erős havazás', 77: 'Hószemcsék',
  80: 'Záporok', 81: 'Erős záporok', 82: 'Felhőszakadás',
  85: 'Hózáporok', 86: 'Erős hózáporok',
  95: 'Zivatar', 96: 'Zivatar jégesővel', 99: 'Heves zivatar jégesővel',
}

/** Miskolc belvárosa — a pult egyetlen városra szól. */
const WEATHER_LAT = 48.104
const WEATHER_LON = 20.79
const WEATHER_TTL_MS = 10 * 60 * 1000

let weatherCache: { at: number; data: Record<string, unknown> } | null = null

/**
 * Aktuális hőmérséklet a fejlécbe. Open-Meteo: ingyenes, API-kulcs nélkül.
 * Tíz percig gyorsítótárazva — a hőmérséklet nem változik gyakrabban, és
 * így a fejléc nem terheli feleslegesen a külső szolgáltatót.
 */
app.get('/weather', async (c) => {
  if (weatherCache && Date.now() - weatherCache.at < WEATHER_TTL_MS) {
    return c.json(weatherCache.data)
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const raw = (await res.json()) as {
      current?: {
        temperature_2m?: number
        apparent_temperature?: number
        weather_code?: number
        wind_speed_10m?: number
      }
    }

    const code = raw.current?.weather_code ?? -1
    const data = {
      tempC: raw.current?.temperature_2m ?? null,
      feelsLikeC: raw.current?.apparent_temperature ?? null,
      windKmh: raw.current?.wind_speed_10m ?? null,
      code,
      text: WMO_TEXT[code] ?? 'Ismeretlen',
      at: new Date().toISOString(),
    }
    weatherCache = { at: Date.now(), data }
    return c.json(data)
  } catch (e) {
    // Elavult adat is jobb, mint üres fejléc.
    if (weatherCache) return c.json(weatherCache.data)
    return c.json({ error: (e as Error).message }, 502)
  }
})

app.get('/live/positions', async (c) => {
  const { status, buf } = await cachedFeed('/api/v1/gtfs/get-positions')
  if (status !== 200) return c.json({ error: `get-positions HTTP ${status}` }, 502)
  try { return c.json(decodeVehicles(buf)) } catch (e) { return c.json({ error: 'dekód hiba', detail: (e as Error).message }, 500) }
})
app.get('/live/updates', async (c) => {
  const { status, buf } = await cachedFeed('/api/v1/gtfs/get-updates')
  if (status !== 200) return c.json({ error: `get-updates HTTP ${status}` }, 502)
  try { const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buf)); return c.json({ header: { timestamp: Number(feed.header.timestamp || 0) }, count: feed.entity.length }) } catch (e) { return c.json({ error: 'dekód hiba', detail: (e as Error).message }, 500) }
})
// Egy konkrét jármű (busz/villamos) élő állapota: bevetésen van-e és hol.
app.get('/live/vehicle', async (c) => {
  const q = (c.req.query('id') || '').trim().toLowerCase(); if (!q) return c.json({ error: 'hiányzó ?id=' }, 400)
  const { status, buf } = await cachedFeed('/api/v1/gtfs/get-positions')
  if (status !== 200) return c.json({ error: `get-positions HTTP ${status}` }, 502)
  const all = (decodeVehicles(buf).vehicles as Record<string, unknown>[]).filter((v) => v.lat != null)
  const idOf = (v: Record<string, unknown>) => String(v.id ?? '').toLowerCase()
  const exact = all.filter((v) => idOf(v) === q)
  const hits = exact.length ? exact : all.filter((v) => idOf(v).includes(q))
  return c.json({ query: q, inService: hits.length > 0, count: hits.length, vehicles: hits })
})
app.get('/live/arrivals', async (c) => {
  const stop = c.req.query('stop'); if (!stop) return c.json({ error: 'hiányzó ?stop=SP...' }, 400)
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 10)))
  try { return c.json(await arrivalsForStop(stop, limit)) } catch (e) { return c.json({ error: (e as Error).message }, 500) }
})
// Multi-stop érkezések egy hívással (max 6 megálló a multi-megálló figyelőhöz)
app.get('/live/multi-arrivals', async (c) => {
  const stopsParam = c.req.query('stops'); if (!stopsParam) return c.json({ error: 'hiányzó ?stops=SP1,SP2' }, 400)
  const stopList = stopsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8)
  const limit = Math.min(10, Math.max(1, Number(c.req.query('limit') ?? 5)))
  try {
    const results = await Promise.all(stopList.map((id) => arrivalsForStop(id, limit)))
    return c.json({ results })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})
app.get('/live/trip-path', async (c) => {
  const trip = c.req.query('trip') || ''
  const vehId = (c.req.query('vehicle') || '').trim()
  if (!trip && !vehId) return c.json({ error: 'hiányzó ?trip= vagy ?vehicle=' }, 400)
  const active = await activeVehicles()
  // Az MVK trip_id-je megbízhatatlan (lásd fenti komment), ezért ha ismert a konkrét
  // jármű azonosítója, AZT keressük meg elsőként — ez mindig megbízhatóbb egyezés.
  let veh = vehId ? active.find((v) => v.id === vehId) || null : null
  if (!veh && trip) veh = active.find((v) => v.tripId === trip) || null
  // Az útvonal geometriáját/fejjelzést a jármű SAJÁT (valós) trip_id-jéből vesszük ha van,
  // különben a kért trip paraméter menetrendi adatai a fallback.
  const effectiveTripId = veh?.tripId || trip
  const tr = trips.get(effectiveTripId); const r = routes.get(tr?.routeId || '')
  const shape = tr?.shapeId ? shapes.get(tr.shapeId) || [] : []
  return c.json({ trip: effectiveTripId, route: r?.short || tr?.routeId || '', color: r?.color || '2f6df6', text: r?.text || 'FFFFFF', headsign: tr?.headsign || '', shape, vehicle: veh })
})
app.get('/system/info', (c) => {
  const mem = process.memoryUsage()
  return c.json({
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    gtfs: {
      feedVersion,
      stops: stops.size,
      routes: routes.size,
      trips: trips.size,
      shapes: shapes.size,
    },
    jwt: jwtStatus(readJwt()),
    installationId: readInstallationId() || null,
  })
})

// DIAGNOSZTIKA: mit tartalmaz a get-updates feed erre a megállóra?
app.get('/live/debug', async (c) => {
  const stopId = c.req.query('stop') || ''
  const s = stops.get(stopId)
  const result: Record<string, unknown> = { stopId, stopName: s?.name, stopCode: s?.code }

  // 1) get-updates nyers szerkezet
  const up = await mvkFetch('/api/v1/gtfs/get-updates')
  result.updatesStatus = up.status
  if (up.status === 200) {
    try {
      const feed = transit_realtime.FeedMessage.decode(new Uint8Array(up.buf))
      const stopIdCount = new Map<string, number>()
      let totalStu = 0
      const matching: unknown[] = []
      const sampleRaw: unknown[] = []
      for (const e of feed.entity) {
        const tu = e.tripUpdate; if (!tu) continue
        for (const stu of tu.stopTimeUpdate || []) {
          totalStu++
          const sid = stu.stopId || ''
          stopIdCount.set(sid, (stopIdCount.get(sid) || 0) + 1)
          if (sampleRaw.length < 3) sampleRaw.push({ tripId: tu.trip?.tripId, stopId: stu.stopId, stopSequence: stu.stopSequence, arrival: stu.arrival, departure: stu.departure })
          if (sid === stopId) matching.push({ tripId: tu.trip?.tripId, routeId: tu.trip?.routeId, stopSequence: stu.stopSequence,
            arrivalHM: stu.arrival?.time ? new Date(Number(stu.arrival.time) * 1000).toLocaleTimeString('hu-HU', { timeZone: 'Europe/Budapest' }) : null,
            arrivalTime: stu.arrival?.time ? Number(stu.arrival.time) : null, arrivalDelay: stu.arrival?.delay ?? null,
            departureTime: stu.departure?.time ? Number(stu.departure.time) : null, departureDelay: stu.departure?.delay ?? null })
        }
      }
      const sampleStopIds = [...stopIdCount.keys()].slice(0, 25)
      result.updates = { tripUpdateEntities: feed.entity.length, totalStopTimeUpdates: totalStu, distinctStopIds: stopIdCount.size,
        sampleStopIdsInFeed: sampleStopIds, thisStopMatches: matching.length, matches: matching.slice(0, 10), sampleRawStu: sampleRaw }
    } catch (e) { result.updatesError = (e as Error).message }
  }

  // 2) get-positions: milyen tripId/routeId-k futnak + hány közeli
  const veh = await activeVehicles()
  const near = s ? veh.map((v) => ({ id: v.id, routeId: v.routeId, tripId: v.tripId, km: +haversineKm(s.lat, s.lon, v.lat, v.lon).toFixed(2) })).sort((a, b) => a.km - b.km).slice(0, 8) : []
  result.vehicles = { total: veh.length, nearestToStop: near, sampleTripIds: veh.slice(0, 5).map((v) => v.tripId) }

  // 3) statikus: milyen tripId-k állnak meg itt ma
  const now = budapestNow(); const active = activeServices(now.ymd)
  const staticTrips = (stopSched.get(stopId) || []).filter((x) => { const tr = trips.get(x.trip); return tr && active.has(tr.serviceId) && now.midnightUnix + x.dep >= now.unix - 300 })
    .slice(0, 5).map((x) => ({ tripId: x.trip, schedDep: new Date((now.midnightUnix + x.dep) * 1000).toLocaleTimeString('hu-HU', { timeZone: 'Europe/Budapest' }), routeId: trips.get(x.trip)?.routeId }))
  result.staticNextTrips = staticTrips
  result.hint = 'Nézd: a "sampleStopIdsInFeed" formátuma egyezik-e a "stopId"-val; a "matches" üres-e; a get-positions tripId-i egyeznek-e a static tripId-kkal.'
  return c.json(result)
})

app.get('/_health', (c) => c.json({ jwt: jwtStatus(readJwt()), autoRenew: AUTO_RENEW, lastRenew, tokenRejected: Math.floor(Date.now() / 1000) - tokenRejectedAt < 180, gtfs: { feedVersion, stops: stops.size }, installationIdKnown: readInstallationId().length > 0 }))
app.get('/_jwt', (c) => c.text(readJwt() || '(nincs)'))
app.get('/_export', (c) => c.json({ jwt: readJwt(), installationId: readInstallationId() || undefined, status: jwtStatus(readJwt()), exportedAt: new Date().toISOString() }))
app.post('/_ingest', async (c) => {
  const raw = (await c.req.text()).trim(); let tok = raw, inst = ''
  if (raw.startsWith('{')) { try { const j = JSON.parse(raw); tok = String(j.jwt ?? j.token ?? '').trim(); inst = String(j.installationId ?? j['installation-id'] ?? '').trim() } catch { tok = '' } }
  if (!inst) { const c2 = decodeClaims(tok)['installation-id']; if (typeof c2 === 'string') inst = c2 }
  if (inst) writeFileSync(INST_FILE, inst)
  if (tok.split('.').length === 3) {
    const prev = jwtStatus(readJwt()); const st = jwtStatus(tok); writeJwt(tok)
    const min = st.expiresInSec != null ? Math.round(st.expiresInSec / 60) : '?'
    console.log(`[ingest] token ${prev.exp !== st.exp ? 'FRISSÍTVE ✅' : 'változatlan'} — lejár: ${st.exp ? new Date(st.exp * 1000).toISOString() : '?'} (${min} perc)`)
    return c.json({ ok: true, jwt: st, installationIdSaved: !!inst })
  }
  console.log('[ingest] ❌ érvénytelen JWT elutasítva')
  return c.json({ ok: false, error: 'nem érvényes JWT' }, 400)
})
app.post('/_renew', async (c) => { const r = await renew('kézi'); return c.json({ triggered: true, result: r, jwt: jwtStatus(readJwt()) }, r?.ok ? 200 : 502) })

// Token kényszerített frissítése a Mac-natív MVK app újraindításával és kiolvasásával
app.post('/system/refresh-app-token', async (c) => {
  const BUNDLE = 'com.hclinear.metaccazeMiskolc'
  const APPNAME = 'MVK MobilON+'
  const home = process.env.HOME || '/Users/' + (process.env.USER || '')
  const plistPath = join(home, 'Library/Containers', BUNDLE, 'Data/Library/Preferences', `${BUNDLE}.plist`)

  try {
    console.log('[system] 🔄 MVK App újraindítása és token kinyerése...')
    try {
      execFileSync('osascript', ['-e', `quit app id "${BUNDLE}"`], { stdio: 'ignore' })
    } catch {
      try { execFileSync('killall', [APPNAME], { stdio: 'ignore' }) } catch {}
    }
    await new Promise((r) => setTimeout(r, 2000))

    try {
      execFileSync('open', ['-b', BUNDLE], { stdio: 'ignore' })
    } catch {
      try { execFileSync('open', ['-a', APPNAME], { stdio: 'ignore' }) } catch {}
    }
    await new Promise((r) => setTimeout(r, 3500))

    if (!existsSync(plistPath)) {
      return c.json({ ok: false, error: `A plist fájl nem található (${plistPath}). Indítsd el az MVK MobilON+ appot kézzel.` }, 400)
    }

    const pyCode = `import plistlib, sys
try:
    pl = plistlib.load(open(sys.argv[1], "rb"))
    for k, v in pl.items():
        if isinstance(v, str) and v.startswith("eyJ") and v.count(".") == 2:
            print(v)
            break
except Exception as e:
    sys.stderr.write(str(e))
`
    const output = execFileSync('python3', ['-c', pyCode, plistPath], { encoding: 'utf8' }).trim()
    if (output && output.split('.').length === 3) {
      writeJwt(output)
      const st = jwtStatus(output)
      const min = st.expiresInSec != null ? Math.round(st.expiresInSec / 60) : '?'
      console.log(`[system] ✅ Token frissítve a Mac appból — lejár: ${min} perc múlva`)
      return c.json({ ok: true, message: `Token sikeresen frissítve az appból (${min} perc érvényes)!`, jwt: st })
    }
    return c.json({ ok: false, error: 'A plist-ben még nincs friss token. Nyisd meg az MVK appot kézzel egyszer.' }, 400)
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500)
  }
})

app.all('/MVK_mobilapp/*', (c) => forward(c, GTFS_ORIGIN, false))
app.all('/api/*', (c) => forward(c, API_ORIGIN, true))
async function forward(c: Context, origin: string, inject: boolean): Promise<Response> {
  const target = origin + c.req.path + new URL(c.req.url).search
  const headers = new Headers({ accept: c.req.header('accept') ?? 'application/json' })
  const ct = c.req.header('content-type'); if (ct) headers.set('content-type', ct)
  if (inject) { const t = readJwt(); if (t) headers.set('authorization', `Bearer ${t}`) }
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  const res = await fetch(target, { method: c.req.method, headers, body: hasBody ? Buffer.from(await c.req.arrayBuffer()) : undefined })
  const out = new Headers(); for (const k of ['content-type', 'content-range', 'accept-ranges']) { const v = res.headers.get(k); if (v) out.set(k, v) }
  return new Response(Buffer.from(await res.arrayBuffer()), { status: res.status, headers: out })
}

// ── auto-renew ──
let lastRenew: { at: string; ok: boolean; status?: number; note?: string } | null = null
let renewing = false
async function renew(reason: string) {
  if (renewing) return lastRenew
  renewing = true; const at = new Date().toISOString()
  try {
    const cur = readJwt(); if (!cur) return (lastRenew = { at, ok: false, note: 'nincs token' })
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${cur}` })
    let inst = readInstallationId(); if (!inst) { const j = decodeClaims(cur)['installation-id']; if (typeof j === 'string') inst = j }
    if (inst) headers.set('installation-id', inst)
    const res = await fetch(API_ORIGIN + RENEW_PATH, { method: 'POST', headers, body: '{}' }); const text = await res.text()
    if (!res.ok) { console.log(`[RENEW] ${reason} -> ${res.status} FAIL`); return (lastRenew = { at, ok: false, status: res.status, note: `elutasítva: ${text.slice(0, 160) || '(üres)'}` }) }
    const m = text.match(/eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/)
    if (m && m[0] !== cur) { writeJwt(m[0]); console.log(`[RENEW] ${reason} -> OK`); return (lastRenew = { at, ok: true, status: res.status, note: 'új token' }) }
    return (lastRenew = { at, ok: false, status: res.status, note: `nincs új JWT: ${text.slice(0, 160)}` })
  } catch (e) { return (lastRenew = { at, ok: false, note: (e as Error).message }) } finally { renewing = false }
}

// ── GTFS friss ──
async function refreshGtfs() {
  try {
    const res = await fetch(GTFS_ORIGIN + '/MVK_mobilapp/GTFS/MVK_GTFS.zip'); if (!res.ok) throw new Error('HTTP ' + res.status)
    const buf = Buffer.from(await res.arrayBuffer()); const zip = join(GTFS_DIR, '_latest.zip')
    writeFileSync(zip, buf); execFileSync('unzip', ['-o', '-q', zip, '-d', GTFS_DIR]); unlinkSync(zip); loadGtfs()
    console.log(`[GTFS] friss letöltve (${buf.length} bájt)`)
  } catch (e) { console.log('[GTFS] friss letöltés kihagyva:', (e as Error).message) }
}

// ── start ──
loadGtfs()
refreshGtfs()
setInterval(() => refreshGtfs(), 6 * 3600 * 1000)

/**
 * A valós idejű feedeket háttérben tartjuk melegen, hogy a kliens-kérések
 * a memóriából szolgálódjanak ki (~1 ms) az upstream ~150 ms helyett.
 * Csak érvényes token mellett indul, különben feleslegesen hívnánk 401-et.
 */
function warmFeeds() {
  const st = jwtStatus(readJwt())
  if (!st.present || st.expired) return
  cachedFeed('/api/v1/gtfs/get-positions').catch(() => {})
  cachedFeed('/api/v1/gtfs/get-updates').catch(() => {})
}
warmFeeds()
setInterval(warmFeeds, FEED_TTL_MS)
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`== MVK backend ==  http://${HOST}:${info.port}   (dashboard a /-on)`)
  console.log(`   élő hozzárendelés: ≤${LIVE_MAX_KM} km, ≤${LIVE_MAX_ETA} perc   auto-renew: ${AUTO_RENEW ? 'BE' : 'KI'}`)
  console.log(`   JWT:`, jwtStatus(readJwt()))
})
if (AUTO_RENEW) setInterval(() => { const st = jwtStatus(readJwt()); if (st.present && (st.expiresInSec ?? Infinity) <= RENEW_MARGIN_SEC) renew('ütemezett').catch(() => {}) }, CHECK_INTERVAL_SEC * 1000)
