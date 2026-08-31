/**
 * Menetrendkönyv — a napi menetrend felépítése a statikus GTFS-ből.
 *
 * Külön modul, mert két fogyasztója van: a `/gtfs/timetable*` végpontok, és a
 * napi archiváló, ami PONTOSAN ugyanezt a szerkezetet rakja el az adatbázisba.
 * Egy múltbeli nap így ugyanúgy néz ki, mint egy mai — a kliensnek mindegy,
 * hogy az élő feedből vagy az archívumból kapta.
 */
import {
  stops, routes, trips, tripStops, activeServices, serviceRange,
  getFeedVersion, type Route, type Trip,
} from './gtfs.ts'

/** Másodperc a nap kezdetétől -> HH:MM (a 24h fölötti éjszakai menetek is jók). */
export function secToHm(sec: number): string {
  const h = Math.floor(sec / 3600) % 24
  const m = Math.floor((sec % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export type TimetableTripRow = {
  tripId: string
  headsign: string
  departure: string
  departureSec: number
  arrival: string
  arrivalSec: number
  originName: string
  destinationName: string
  stopCount: number
  deviates: boolean
  times: (string | null)[]
}

export type TimetableTable = {
  route: Route
  dir: string
  date: string
  headsign: string
  stops: { id: string; code: string; name: string; lat: number | null; lon: number | null }[]
  trips: TimetableTripRow[]
  note?: string
}

export type TimetableRouteRow = {
  id: string; short: string; long: string; type: string; color: string; text: string
  directions: { dir: string; headsign: string; tripsToday: number; tripsTotal: number; firstDeparture: string | null }[]
}

/** Egy nap teljes menetrendje egyetlen szerkezetben — ez kerül az archívumba. */
export type DaySchedule = {
  date: string
  feedVersion: string
  routes: TimetableRouteRow[]
  /** Kulcs: `${routeId}|${dir}`. */
  tables: Record<string, TimetableTable>
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
export function buildRouteIndex(ymd: string): TimetableRouteRow[] {
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

  return out
}

/**
 * Egy járat egy irányának teljes napi menetrendje.
 *
 * A megállósor a legtöbb megállót érintő menetből származik (a betérők és a
 * rövidített menetek így is ugyanabba az oszloprendbe illeszkednek); minden
 * menetnél a hiányzó megállóhoz null kerül.
 */
export function buildTable(routeId: string, dir: string, ymd: string): TimetableTable | null {
  const route = routes.get(routeId)
  if (!route) return null

  const list = tripsOfRouteDir(routeId, dir, ymd)
  if (!list.length) {
    return { route, dir, date: ymd, headsign: '', stops: [], trips: [], note: 'Ezen a napon nem közlekedik.' }
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

  const tripRows: TimetableTripRow[] = list.map((x) => {
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
      /** A menet vége másodpercben — ebből tudja a kliens, hogy már lefutott-e. */
      arrivalSec: last.dep,
      originName: stops.get(first.stopId)?.name || first.stopId,
      destinationName: stops.get(last.stopId)?.name || last.stopId,
      stopCount: x.stopsOfTrip.length,
      /** A menet a fő megállósoron kívüli megállókat is érint (betérő). */
      deviates: extraCount > 0,
      times,
    }
  })

  return { route, dir, date: ymd, headsign, stops: stopList, trips: tripRows }
}

/** Egy nap MINDEN járatának és irányának menetrendje — az archívum tartalma. */
export function buildDaySchedule(ymd: string): DaySchedule {
  const routeRows = buildRouteIndex(ymd)
  const tables: Record<string, TimetableTable> = {}
  for (const r of routeRows) {
    for (const d of r.directions) {
      // Az aznap nem közlekedő irányt nem tároljuk: az üres tábla helyben is
      // előállítható, viszont az archívum méretét feleslegesen duplázná.
      if (d.tripsToday === 0) continue
      const table = buildTable(r.id, d.dir, ymd)
      if (table && table.trips.length) tables[`${r.id}|${d.dir}`] = table
    }
  }
  return { date: ymd, feedVersion: getFeedVersion(), routes: routeRows, tables }
}

/** A statikus feed által lefedett napok YYYYMMDD listája. */
export function feedDays(): string[] {
  const range = serviceRange()
  if (!range) return []
  const out: string[] = []
  const toDate = (ymd: string) => new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  for (let d = toDate(range.from); fmt(d) <= range.to; d.setDate(d.getDate() + 1)) out.push(fmt(d))
  return out
}
