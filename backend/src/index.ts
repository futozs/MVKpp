/**
 * MVK MobilON+ backend (Hono + TypeScript).
 *  - Frontend a `/`-on; /live/positions, /live/arrivals?stop=SP1, /live/trip-path?trip=T
 *  - /api/* -> https://mccaze.mvkzrt.hu:8443 (Bearer beinjektálva)
 *  - Token: state/jwt.txt; GTFS indításkor frissül.
 */
import { serve } from '@hono/node-server'
import { networkInterfaces } from 'node:os'
import { Hono, type Context } from 'hono'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stops, routes, trips, schedByTripStop, stopSched, shapes,
  routeStops, routeShapeIds, tripStops,
  activeServices, serviceRange, haversineKm, projectOntoShapeKm,
  getFeedVersion, loadGtfs as loadGtfsFrom, resolveRouteId, type Trip,
} from './lib/gtfs.ts'
import { initJournal, recordSighting, journalFor, flushJournal, journalStats, takeSightings, restoreSightings } from './lib/journal.ts'
import { buildRouteIndex, buildTable, buildDaySchedule, secToHm, feedDays, type DaySchedule } from './lib/timetable.ts'
import { saveDaySchedule, loadDaySchedule, archiveRange, saveSightings, dayRuns, storedFeedVersions } from './lib/archive.ts'
import { stats } from './api/stats.ts'
import { ops, adminToken } from './api/ops.ts'

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
// Halozaton is elerheto: a hub es a dashboard mas gepekrol/telefonrol is nyithato.
// Szukitheto a HOST env-vel (pl. HOST=127.0.0.1) ha csak helyi eleres kell.
const HOST = process.env.HOST ?? '0.0.0.0'
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
// A betöltő, az indexek és a geometria a megosztott modulban él, hogy a
// statisztikai worker pontosan ugyanazt használja: src/lib/gtfs.ts
function loadGtfs() {
  const r = loadGtfsFrom(GTFS_DIR)
  console.log(`[GTFS] stops=${r.stops} routes=${r.routes} trips=${r.trips} stopTimes=${r.stopTimes} shapes=${r.shapes} feed=${r.feedVersion}`)
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
    const tripId = v.trip?.tripId || ''; const routeId = resolveRouteId(v.trip?.routeId || '', tripId); const r = routes.get(routeId)
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
      const tripId = v.trip?.tripId || ''; const routeId = resolveRouteId(v.trip?.routeId || '', tripId)
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
  // Az X-Admin-Token nelkul a hub uzemeltetesi hivasai (naplok, ujratelepites)
  // mar a preflightnal elbuknanak, amikor a hub nem a gateway origin-jerol jon.
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Token')
  c.header('Access-Control-Max-Age', '86400')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

function isAdminRequest(c: Context): boolean {
  return (c.req.header('x-admin-token') ?? '') === adminToken()
}

// Statisztikai adatraktár (külön adatbázis; ha nem elérhető, 503-at ad és
// a valós idejű funkciók érintetlenek maradnak).
app.route('/stats', stats)

// Uzemeltetes: ujratelepites es naplok. A rombolo muveletek admin tokent kernek.
app.route('/system', ops)

// A Hub kiszolgalasa a gateway-rol, /hub alatt.
//
// Igy tavoli elereshez (VPN) EGYETLEN port eleg: a dashboard a gyokeren, a hub
// a /hub-on, az API pedig ugyanitt — nem kell harom portot atengedni a tunelen,
// es nem kell a Vite dev szervert kitenni a halozatra.
const HUB_DIST = join(ROOT, '..', 'hub', 'dist')

function serveStatic(baseDir: string, rel: string) {
  const filePath = join(baseDir, rel)
  // Kilepes a konyvtarbol nem megengedett (pl. ../../etc/passwd).
  if (!filePath.startsWith(baseDir) || !existsSync(filePath)) return null
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const mime: Record<string, string> = {
    js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', json: 'application/json',
    woff2: 'font/woff2', woff: 'font/woff', ico: 'image/x-icon',
  }
  return new Response(readFileSync(filePath), {
    headers: { 'Content-Type': mime[ext] || 'application/octet-stream' },
  })
}

app.get('/hub', (c) => c.redirect('/hub/'))
app.get('/hub/*', (c) => {
  const rel = c.req.path.replace(/^\/hub\/?/, '')
  if (rel) {
    const asset = serveStatic(HUB_DIST, rel)
    if (asset) return asset
  }
  const index = join(HUB_DIST, 'index.html')
  if (existsSync(index)) return c.html(readFileSync(index, 'utf8'))
  return c.text('A hub meg nincs buildelve. Futtasd: cd hub && npm run build', 404)
})

// Static frontend serving (dist fallback or dashboard.html)
// CSAK dev módban: prod módban a frontend szerver az 5173-as porton serve-eli ezt.
if (process.env.NODE_ENV !== 'production') {
  app.get('/', (c) => {
    try {
      if (existsSync(FRONTEND_INDEX)) return c.html(readFileSync(FRONTEND_INDEX, 'utf8'))
      if (existsSync(FRONTEND)) return c.html(readFileSync(FRONTEND, 'utf8'))
      return c.html('<h1>MVK MobilON+ API Gateway</h1><p>Frontend elérhető: <a href="http://localhost:5173">http://localhost:5173</a></p>')
    } catch {
      return c.text('Frontend fájl nem található', 500)
    }
  })
} else {
  // Prod módban: csak info
  app.get('/', (c) => {
    return c.json({
      message: 'MVK MobilON+ API Gateway',
      status: 'running',
      endpoints: ['/api/*', '/live/*', '/gtfs/*', '/stats/*', '/system/*', '/_health', '/_jwt', '/_export']
    })
  })
}

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
app.get('/gtfs/meta.json', async (c) => c.json({
  feedVersion: getFeedVersion(),
  stops: stops.size, routes: routes.size, trips: trips.size,
  serviceRange: serviceRange(),
  /** Meddig ér vissza az elrakott menetrend — a naptár alsó határa ebből jön. */
  archiveRange: await archiveRange(),
}))

type TripStopRow = { id: string; name: string; lat: number | null; lon: number | null; dep: number }

/** Egy menet megállósora névvel, koordinátával és menetrendi indulással. */
function tripStopRows(tripId: string): TripStopRow[] | null {
  const seq = tripStops.get(tripId)
  if (!seq?.length) return null
  return seq.map((x) => {
    const s = stops.get(x.stopId)
    return {
      id: x.stopId,
      name: s?.name || x.stopId,
      lat: s?.lat ?? null,
      lon: s?.lon ?? null,
      /** Menetrendi indulás másodpercben éjfél óta. */
      dep: x.dep,
    }
  })
}

/**
 * Menetrendi eltérés a busz PILLANATNYI helyén: + késik, − siet.
 *
 * A két szomszédos megálló menetrendi ideje között ott interpolálunk, ahol a
 * busz a szakaszon tart — így nem kell megvárni a következő megállót ahhoz,
 * hogy látszódjon a csúszás.
 */
function deviationSec(stopList: TripStopRow[], segmentIndex: number, fraction: number): number | null {
  const from = stopList[segmentIndex]
  if (!from) return null
  const to = stopList[segmentIndex + 1] ?? from
  const sched = from.dep + (to.dep - from.dep) * fraction

  // Az éjfél utáni menetek menetrendi ideje 86400 fölött van, a mostani
  // másodperc viszont a nap elejéről számol: fél napnál nagyobb különbség
  // mindig napváltás, nem késés.
  let dev = budapestNow().secOfDay - sched
  if (dev > 43200) dev -= 86400
  if (dev < -43200) dev += 86400

  // Háromnegyed órán túl már nem menetrendi csúszásról van szó, hanem rossz
  // jármű-hozzárendelésről — ilyet inkább nem állítunk.
  return Math.abs(dev) > 2700 ? null : Math.round(dev)
}

/**
 * Hol tart a busz a menet megállósorán.
 *
 * A busz pozícióját a járat vonalgeometriájára vetítjük, és ugyanígy a
 * megállókat is — így megmondható, MELYIK két megálló között jár éppen, és
 * a szakaszon belül hol tart. A pillanatnyi GPS-irány megbízhatatlan, ezért
 * kizárólag a vonal menti távolságra hagyatkozunk.
 *
 * Ha nincs használható geometria, a legközelebbi megállóra esünk vissza.
 */
function progressOnTrip(tripId: string, vehicle: LiveVeh) {
  const trip = trips.get(tripId)
  const stopList = tripStopRows(tripId)
  if (!trip || !stopList?.length) return null

  const shape = trip.shapeId ? shapes.get(trip.shapeId) : undefined
  let segmentIndex: number | null = null
  let segmentFraction = 0

  if (shape && shape.length >= 2) {
    const busProjection = projectOntoShapeKm(shape, vehicle.lat, vehicle.lon)
    const stopAlong = stopList.map((s) =>
      s.lat != null && s.lon != null ? projectOntoShapeKm(shape, s.lat, s.lon)?.alongKm ?? null : null
    )

    // A busz túl messze van a vonaltól: a vetített érték félrevezető lenne.
    if (busProjection && busProjection.distKm <= 1.5) {
      const along = busProjection.alongKm
      for (let i = 0; i < stopAlong.length - 1; i++) {
        const a = stopAlong[i]
        const b = stopAlong[i + 1]
        if (a == null || b == null || b <= a) continue
        if (along >= a && along < b) {
          segmentIndex = i
          segmentFraction = (along - a) / (b - a)
          break
        }
      }
      if (segmentIndex == null) {
        const first = stopAlong.find((x) => x != null)
        const last = [...stopAlong].reverse().find((x) => x != null)
        if (first != null && along < first) {
          segmentIndex = 0
          segmentFraction = 0
        } else if (last != null && along >= last) {
          segmentIndex = stopList.length - 1
          segmentFraction = 0
        }
      }
    }
  }

  // Geometria nélkül: a legközelebbi megálló.
  if (segmentIndex == null) {
    let best = 0
    let bestDist = Infinity
    stopList.forEach((s, i) => {
      if (s.lat == null || s.lon == null) return
      const d = haversineKm(vehicle.lat, vehicle.lon, s.lat, s.lon)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    segmentIndex = best
    segmentFraction = 0
  }

  const denominator = Math.max(1, stopList.length - 1)
  const progress = Math.min(1, Math.max(0, (segmentIndex + segmentFraction) / denominator))

  return {
    stops: stopList,
    /** Hányadik megálló UTÁN jár (0 = az első és második között). */
    segmentIndex,
    /** 0..1 a szakaszon belül. */
    segmentFraction,
    /** 0..1 a teljes menetre. */
    progress,
    nextStop: stopList[Math.min(stopList.length - 1, segmentIndex + 1)] ?? null,
    /** + = késik, − = siet. */
    scheduleDeviationSec: deviationSec(stopList, segmentIndex, segmentFraction),
  }
}

app.get('/live/trip-progress', async (c) => {
  const tripId = (c.req.query('trip') || '').trim()
  const vehicleQuery = (c.req.query('vehicle') || '').trim().toLowerCase()
  if (!tripId) return c.json({ error: 'hiányzó ?trip=' }, 400)

  const stopList = tripStopRows(tripId)
  if (!trips.get(tripId) || !stopList?.length) return c.json({ error: 'Ismeretlen menet' }, 404)

  const vehicles = await activeVehicles()
  const vehicle =
    vehicles.find((v) => v.tripId === tripId) ??
    (vehicleQuery ? vehicles.find((v) => v.id.toLowerCase() === vehicleQuery) : undefined) ??
    null

  if (!vehicle) {
    return c.json({
      tripId,
      live: false,
      stops: stopList,
      segmentIndex: null,
      progress: null,
      scheduleDeviationSec: null,
    })
  }

  const prog = progressOnTrip(tripId, vehicle)
  if (!prog) return c.json({ error: 'Ismeretlen menet' }, 404)

  return c.json({
    tripId,
    live: true,
    vehicle: {
      id: vehicle.id,
      lat: vehicle.lat,
      lon: vehicle.lon,
      speed: vehicle.speed,
    },
    ...prog,
  })
})

// ── Menetrendkönyv ───────────────────────────────────────────────────────────
/**
 * A menetrend forrása kettős: a statikus GTFS feed által lefedett napokat
 * helyben számoljuk, az azon KÍVÜLI (jellemzően múltbeli) napokat az
 * adatbázis-archívumból olvassuk. A kliens felé a kettő ugyanúgy néz ki.
 */
async function daySource(ymd: string): Promise<{ day: DaySchedule; live: boolean } | null> {
  const range = serviceRange()
  if (range && ymd >= range.from && ymd <= range.to) {
    return { day: { date: ymd, feedVersion: getFeedVersion(), routes: buildRouteIndex(ymd), tables: {} }, live: true }
  }
  const archived = await loadDaySchedule(ymd)
  return archived ? { day: archived, live: false } : null
}

app.get('/gtfs/timetable/routes', async (c) => {
  const ymd = (c.req.query('date') || budapestNow().ymd).trim()
  if (!/^\d{8}$/.test(ymd)) return c.json({ error: 'érvénytelen ?date= (YYYYMMDD kell)' }, 400)

  const src = await daySource(ymd)
  if (!src) return c.json({ date: ymd, routes: [], note: 'Erre a napra nincs elrakva menetrend.' })
  return c.json({ date: ymd, archived: !src.live, routes: src.day.routes })
})

app.get('/gtfs/timetable', async (c) => {
  const routeId = (c.req.query('route') || '').trim()
  const dir = (c.req.query('dir') || '').trim()
  const ymd = (c.req.query('date') || budapestNow().ymd).trim()
  if (!/^\d{8}$/.test(ymd)) return c.json({ error: 'érvénytelen ?date= (YYYYMMDD kell)' }, 400)

  const range = serviceRange()
  if (range && ymd >= range.from && ymd <= range.to) {
    const table = buildTable(routeId, dir, ymd)
    if (!table) return c.json({ error: 'Ismeretlen járat' }, 404)
    return c.json({ ...table, archived: false })
  }

  // Archív nap: a tárolt táblák közül a kért járat + irány.
  const day = await loadDaySchedule(ymd)
  if (!day) return c.json({ error: 'Erre a napra nincs elrakva menetrend.' }, 404)
  const table = day.tables[`${routeId}|${dir}`]
  if (table) return c.json({ ...table, date: ymd, archived: true })

  const route = day.routes.find((r) => r.id === routeId)
  if (!route) return c.json({ error: 'Ismeretlen járat' }, 404)
  return c.json({
    route: { id: route.id, short: route.short, long: route.long, type: route.type, color: route.color, text: route.text },
    dir, date: ymd, headsign: '', stops: [], trips: [], archived: true, note: 'Ezen a napon nem közlekedett.',
  })
})

// ── Törölt (kihúzott) menetek ────────────────────────────────────────────────
/**
 * Az MVK `list-cancelled-trips` végpontja a mai napra KIHÚZOTT meneteket adja
 * vissza — nyers alakban csupán `[{ "tripId": "..." }]`, minden más nélkül.
 * A tripId a statikus GTFS trip_id-vel egyezik, így itt egészítjük ki azzal,
 * amit a menetrendkönyv meg tud jeleníteni: járat, irány, indulás, végállomás.
 *
 * A lista percekben mérhető ütemben változik, ezért NEM a valós idejű feedek
 * kétmásodperces gyorsítótárát használjuk, hanem saját, hosszabb TTL-t.
 */
const CANCELLED_TTL_MS = 30_000
let cancelledCache: { at: number; ids: string[] } | null = null

/** Az upstream nyers válaszából tiszta, duplikátummentes trip_id lista. */
function parseCancelledIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { trips?: unknown } | null)?.trips)
      ? ((raw as { trips: unknown[] }).trips)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const id = typeof item === 'string'
      ? item
      : String((item as Record<string, unknown> | null)?.tripId
        ?? (item as Record<string, unknown> | null)?.trip_id
        ?? (item as Record<string, unknown> | null)?.id
        ?? '')
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

async function cancelledTripIds(): Promise<string[]> {
  if (cancelledCache && Date.now() - cancelledCache.at < CANCELLED_TTL_MS) return cancelledCache.ids
  const { status, buf } = await mvkFetch('/api/v1/gtfs/list-cancelled-trips')
  if (status !== 200) throw new Error(`list-cancelled-trips HTTP ${status}`)
  const ids = parseCancelledIds(JSON.parse(buf.toString('utf8').trim() || '[]'))
  cancelledCache = { at: Date.now(), ids }
  return ids
}

/**
 * A mai kihúzott menetek menetrendi adatokkal. A menetrendkönyv ebből tudja,
 * melyik indulás van törölve — szemben a „még nem indult el” állapottal, ami
 * pusztán annyit jelent, hogy a járműhöz még nincs élő pozíció.
 */
app.get('/live/cancelled', async (c) => {
  let ids: string[]
  let stale = false
  try {
    ids = await cancelledTripIds()
  } catch (e) {
    // Elavult lista is jobb, mint a semmi: a menetrendkönyv így sem veszti el
    // a jelöléseket egyetlen sikertelen upstream hívás miatt.
    if (!cancelledCache) return c.json({ error: (e as Error).message }, 502)
    ids = cancelledCache.ids
    stale = true
  }

  const rows = ids.map((tripId) => {
    const t = trips.get(tripId)
    const r = t ? routes.get(t.routeId) : undefined
    const stopsOfTrip = tripStops.get(tripId)
    const first = stopsOfTrip?.[0] ?? null
    const last = stopsOfTrip?.[stopsOfTrip.length - 1] ?? null
    return {
      tripId,
      /** Hamis, ha a statikus GTFS nem ismeri ezt a menetet (elavult feed). */
      known: Boolean(t),
      routeId: t?.routeId ?? '',
      routeShort: r?.short ?? '',
      routeColor: r?.color ?? '888888',
      routeText: r?.text ?? 'FFFFFF',
      dir: t?.dir ?? '',
      headsign: t?.headsign ?? '',
      departure: first ? secToHm(first.dep) : null,
      departureSec: first?.dep ?? null,
      arrival: last ? secToHm(last.dep) : null,
      originName: first ? (stops.get(first.stopId)?.name ?? first.stopId) : null,
      destinationName: last ? (stops.get(last.stopId)?.name ?? last.stopId) : null,
    }
  })
  rows.sort((a, b) => (a.departureSec ?? Infinity) - (b.departureSec ?? Infinity) || a.tripId.localeCompare(b.tripId))

  return c.json({
    date: budapestNow().ymd,
    count: rows.length,
    stale,
    fetchedAt: new Date(cancelledCache?.at ?? Date.now()).toISOString(),
    tripIds: ids,
    trips: rows,
  })
})

// ── Menetnapló ───────────────────────────────────────────────────────────────
/**
 * Melyik jármű teljesítette az adott menetet, és milyen eltéréssel.
 *
 * Két forrás egészíti ki egymást: a JÁRMŰ a gateway saját naplójából jön (az
 * mindig gyűlik, amíg a gateway fut), az ELTÉRÉS pedig a statisztikai worker
 * `trip_run` táblájából (tényleges indulás/érkezés a menetrendhez képest).
 * Adatbázis nélkül a mai nap a helyi JSON-naplóból még kiszolgálható.
 */
app.get('/gtfs/trip-journal', async (c) => {
  const ymd = (c.req.query('date') || budapestNow().ymd).trim()
  if (!/^\d{8}$/.test(ymd)) return c.json({ error: 'érvénytelen ?date= (YYYYMMDD kell)' }, 400)

  const runs = await dayRuns(ymd)
  let source = 'db'

  // Az adatbázisba a napló percenként ürül; a mai nap utolsó perce a memóriából
  // egészíti ki, hogy a frissen elindult menetek se hiányozzanak.
  if (ymd === budapestNow().ymd) {
    for (const [tripId, e] of journalFor(ymd)) {
      const prev = runs.get(tripId)
      if (prev?.vehicleId) continue
      runs.set(tripId, {
        vehicleId: e.vehicleId, samples: e.samples, firstSeen: e.firstSeen, lastSeen: e.lastSeen,
        startDelaySec: prev?.startDelaySec ?? null, endDelaySec: prev?.endDelaySec ?? null,
        actualStart: prev?.actualStart ?? null, actualEnd: prev?.actualEnd ?? null,
        status: prev?.status ?? null, stopsSeen: prev?.stopsSeen ?? null, stopsTotal: prev?.stopsTotal ?? null,
      })
    }
    if (!runs.size) source = 'local'
  }

  const out: Record<string, unknown> = {}
  for (const [tripId, r] of runs) out[tripId] = r
  return c.json({ date: ymd, count: runs.size, source, trips: out })
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
  // A menetkövetés alsó sávja ugyanazt a menetrendi eltérést mutatja, mint a
  // menetrendkönyv haladás-síne — ezért itt is a közös számítás adja.
  const prog = veh ? progressOnTrip(effectiveTripId, veh) : null
  return c.json({ trip: effectiveTripId, route: r?.short || tr?.routeId || '', color: r?.color || '2f6df6', text: r?.text || 'FFFFFF', headsign: tr?.headsign || '', shape, vehicle: veh, nextStop: prog?.nextStop ?? null, scheduleDeviationSec: prog?.scheduleDeviationSec ?? null })
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
      feedVersion: getFeedVersion(),
      stops: stops.size,
      routes: routes.size,
      trips: trips.size,
      shapes: shapes.size,
    },
    jwt: jwtStatus(readJwt()),
    installationId: readInstallationId() || null,
    journal: JOURNAL_ON ? journalStats(budapestNow().ymd) : { enabled: false },
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
          if (sid === stopId) matching.push({ tripId: tu.trip?.tripId, routeId: resolveRouteId(tu.trip?.routeId || '', tu.trip?.tripId || ''), stopSequence: stu.stopSequence,
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

app.get('/_health', (c) => c.json({ jwt: jwtStatus(readJwt()), autoRenew: AUTO_RENEW, lastRenew, tokenRejected: Math.floor(Date.now() / 1000) - tokenRejectedAt < 180, gtfs: { feedVersion: getFeedVersion(), stops: stops.size }, installationIdKnown: readInstallationId().length > 0 }))
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
/**
 * A gateway újraindítása.
 *
 * A folyamat kilép, a manager.mjs pedig újraindítja. Ha a backend kézzel,
 * manager nélkül fut, a kilépés után magától nem jön vissza — ezt a válasz
 * `managed` mezője jelzi előre, hogy a hub ne ígérjen olyat, ami nem történik meg.
 */
app.post('/system/restart', (c) => {
  // A gateway halozaton is elerheto, ezert az ujrainditas admin tokent ker.
  if ((c.req.header('x-admin-token') ?? '') !== adminToken()) {
    return c.json({ error: 'Ervenytelen vagy hianyzo admin token.' }, 401)
  }
  const managed = process.env.MVK_MANAGED === '1'
  console.log('[system] ⟳ újraindítási kérés a hubról')
  // A válasz még kimegy, csak utána lépünk ki.
  setTimeout(() => process.exit(0), 150)
  return c.json({
    ok: true,
    managed,
    message: managed
      ? 'A gateway újraindul, néhány másodperc múlva elérhető.'
      : 'A gateway leáll. Manager nélkül indítva magától nem indul újra.',
  })
})

/** GTFS menetrend újratöltése a forrásból, a szerver leállítása nélkül. */
app.post('/system/reload-gtfs', async (c) => {
  if (!isAdminRequest(c)) return c.json({ error: 'Érvénytelen vagy hiányzó admin token.' }, 401)
  try {
    await refreshGtfs()
    return c.json({
      ok: true,
      feedVersion: getFeedVersion(),
      stops: stops.size,
      routes: routes.size,
      trips: trips.size,
    })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502)
  }
})

/** A valós idejű feed-gyorsítótár állapota — ebből látszik, él-e a háttérhurok. */
app.get('/system/cache', (c) => {
  const now = Date.now()
  const feeds = [...feedCache.entries()].map(([path, e]) => ({
    path,
    ageMs: e.at ? now - e.at : null,
    status: e.status,
    bytes: e.buf.length,
    inflight: e.inflight !== null,
  }))
  return c.json({
    ttlMs: FEED_TTL_MS,
    feeds,
    vehicles: vehiclesCache
      ? { ageMs: now - vehiclesCache.at, count: vehiclesCache.list.length }
      : null,
    weather: weatherCache ? { ageMs: now - weatherCache.at } : null,
  })
})

app.post('/system/refresh-app-token', async (c) => {
  if (!isAdminRequest(c)) return c.json({ error: 'Érvénytelen vagy hiányzó admin token.' }, 401)
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

/**
 * Menetnapló-mintavétel. A gateway 0–24-ben fut, ezért folyamatosan
 * feljegyezhetjük, melyik jármű melyik meneten látszik — így a menetrendkönyv
 * a már LEFUTOTT menetekhez is meg tudja mutatni a járművet, amit az élő feed
 * addigra elfelejtett. A pozíciófeed gyorsítótárazott, tehát ez a hurok
 * mintavételenként legfeljebb egy upstream hívást jelent.
 */
const JOURNAL_ON = (process.env.JOURNAL ?? '1') !== '0'
const JOURNAL_INTERVAL_SEC = Number(process.env.JOURNAL_INTERVAL_SEC ?? 15)
const JOURNAL_FLUSH_SEC = Number(process.env.JOURNAL_FLUSH_SEC ?? 60)

async function sampleJournal() {
  const st = jwtStatus(readJwt())
  if (!st.present || st.expired) return
  try {
    const now = budapestNow()
    for (const v of await activeVehicles()) {
      // Csak ismert menetre könyvelünk: az ismeretlen trip_id a feed zaja.
      if (!v.tripId || !trips.has(v.tripId)) continue
      recordSighting(now.ymd, v.tripId, v.id, now.unix)
    }
  } catch { /* egy kihagyott mintavétel nem gond, a következő pótolja */ }
}

/**
 * A napló kiírása: a helyi JSON gyorstárba MINDIG, az adatbázisba pedig a
 * legutóbbi kör óta felgyűlt növekmény. Az adatbázis a végleges tár — onnan
 * olvassa vissza a menetrend a múltbeli napok járműveit.
 */
async function persistJournal() {
  flushJournal()
  const ymd = budapestNow().ymd
  const rows = takeSightings(ymd)
  if (!rows.length) return
  try {
    if (!(await saveSightings(ymd, rows))) restoreSightings(ymd, rows)
  } catch (e) {
    // Adatbázis-kimaradás: a köteg visszakerül, a következő kör újra próbálja.
    restoreSightings(ymd, rows)
    console.log('[journal] adatbázis-írás sikertelen:', (e as Error).message)
  }
}

/**
 * A statikus feed által lefedett NAPOK menetrendjének elrakása. A feed mindig
 * csak a következő pár hetet ismeri, ezért ami kifutna belőle, azt itt mentjük
 * el — így a menetrendkönyv tetszőlegesen messzire vissza tud nézni.
 */
async function archiveSchedules(reason: string) {
  const today = budapestNow().ymd
  const feedVersion = getFeedVersion()
  const counts = { saved: 0, unchanged: 0, past: 0, skipped: 0 }
  let stored: Map<string, string>
  try {
    stored = await storedFeedVersions()
  } catch {
    return // nincs adatbázis — a gateway enélkül is teljes értékű
  }

  for (const ymd of feedDays()) {
    // Ugyanaz a feed ugyanarra a napra ugyanazt a menetrendet adja: felesleges
    // újraépíteni. Múltbeli napot pedig soha nem írunk felül.
    if (stored.get(ymd) === feedVersion) { counts.unchanged++; continue }
    if (stored.has(ymd) && ymd < today) { counts.past++; continue }
    try {
      counts[await saveDaySchedule(buildDaySchedule(ymd), today)]++
    } catch (e) {
      console.log(`[archív] ${ymd} mentése sikertelen:`, (e as Error).message)
      break
    }
  }
  if (counts.saved) {
    console.log(`[archív] ${reason}: ${counts.saved} nap elrakva, ${counts.unchanged} változatlan, ${counts.past} múltbeli érintetlen`)
  }
}

if (JOURNAL_ON) {
  initJournal(STATE_DIR, budapestNow().ymd)
  sampleJournal()
  setInterval(sampleJournal, JOURNAL_INTERVAL_SEC * 1000)
  setInterval(() => { persistJournal().catch(() => {}) }, JOURNAL_FLUSH_SEC * 1000)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { flushJournal(); process.exit(0) })
  }
}

// Induláskor, majd óránként: a feed napjainak archiválása. A GTFS maga hat
// óránként frissül, de a naptárfordulót ennél sűrűbben kell lefedni.
archiveSchedules('indulás').catch(() => {})
setInterval(() => { archiveSchedules('napi').catch(() => {}) }, 3600 * 1000)
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`== MVK backend ==  http://${HOST}:${info.port}   (dashboard a /-on)`)
  console.log(`   élő hozzárendelés: ≤${LIVE_MAX_KM} km, ≤${LIVE_MAX_ETA} perc   auto-renew: ${AUTO_RENEW ? 'BE' : 'KI'}`)
  console.log(`   JWT:`, jwtStatus(readJwt()))
  // Minden cim, amin a gateway elerheto. VPN ujracsatlakozas utan a tunnel
  // cime valtozhat, ezert hasznos, ha a naplobol mindig kiolvashato.
  if (HOST === '0.0.0.0') {
    const addrs = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
      (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => `${name}=${a.address}`)
    )
    console.log(`   elerheto cimek: ${addrs.join('  ') || '(csak localhost)'}`)
    console.log(`   dashboard: http://<cim>:${info.port}/    hub: http://<cim>:${info.port}/hub/`)
  }
  // Az admin token elso hivasra generalodik; kiirjuk, hogy a hubba be lehessen masolni.
  console.log(`   admin token (hub → Ujratelepites): ${adminToken()}`)
  if (HOST === '0.0.0.0') {
    console.log('   FIGYELEM: a gateway minden halozati interfeszen hallgat. Ha az internet fele is nyitva van, tedd tuzfal moge.')
  }
})
if (AUTO_RENEW) setInterval(() => { const st = jwtStatus(readJwt()); if (st.present && (st.expiresInSec ?? Infinity) <= RENEW_MARGIN_SEC) renew('ütemezett').catch(() => {}) }, CHECK_INTERVAL_SEC * 1000)
