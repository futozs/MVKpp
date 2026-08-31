/**
 * Menetnapló — melyik JÁRMŰ teljesítette az adott menetet.
 *
 * A gateway 0–24-ben fut, ezért folyamatosan mintavételezheti a pozíció-feedet
 * és feljegyezheti, melyik jármű jelentkezett be melyik trip_id-n. Így a
 * menetrendkönyv a NAP MÁSODIK FELÉBEN is meg tudja mondani, hogy a délelőtti
 * menetet melyik busz vitte — az élő feed ilyenkor már rég nem tud róla.
 *
 * A napló naponta egy JSON fájl a `state/journal/` alatt, hogy a gateway
 * újraindítása se törölje a ma összegyűjtött hozzárendeléseket. A VÉGLEGES tár
 * az adatbázis (`trip_vehicle_log`): ide a `takeSightings` által visszaadott
 * deltákat írja ki a gateway, a helyi fájl csak gyorstár és tartalék.
 *
 * FONTOS: az MVK feed trip_id-je nem mindig pontos, ezért mintaszámot is
 * tárolunk — egyetlen villanásnyi észlelés nem elég egy menet „elkönyveléséhez".
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** [elsőEszlelés, utolsóEszlelés, mintaszám] — tömör alak a lemezre. */
type Sighting = [number, number, number]
/** tripId -> vehicleId -> észlelés */
type DayLog = Record<string, Record<string, Sighting>>

export type JournalEntry = {
  vehicleId: string
  firstSeen: number
  lastSeen: number
  samples: number
}

/** Ennyi külön mintavétel alatt egy hozzárendelést feed-zajnak tekintünk. */
const MIN_SAMPLES = 2
/** Ennyi napnál régebbi naplót indításkor eldobunk. */
const RETENTION_DAYS = Number(process.env.JOURNAL_RETENTION_DAYS ?? 30)

let baseDir = ''
const days = new Map<string, DayLog>()
const dirty = new Set<string>()
/** A legutóbbi adatbázis-kiírás óta felgyűlt növekmény (ymd -> trip -> jármű). */
const pending = new Map<string, DayLog>()

const fileOf = (ymd: string) => join(baseDir, `${ymd}.json`)

/** A naplókönyvtár megnyitása; a mai fájlt azonnal visszatöltjük a memóriába. */
export function initJournal(stateDir: string, todayYmd: string): void {
  baseDir = join(stateDir, 'journal')
  mkdirSync(baseDir, { recursive: true })
  loadDay(todayYmd)
  pruneOld()
}

function loadDay(ymd: string): DayLog {
  const cached = days.get(ymd)
  if (cached) return cached
  let log: DayLog = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileOf(ymd), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) log = parsed as DayLog
  } catch { /* nincs még napló erre a napra */ }
  days.set(ymd, log)
  return log
}

/** Egy mintavétel eredménye: ez a jármű ezen a meneten látszott. */
export function recordSighting(ymd: string, tripId: string, vehicleId: string, unix: number): void {
  if (!baseDir || !tripId || !vehicleId) return
  const log = loadDay(ymd)
  const byVehicle = (log[tripId] ??= {})
  const prev = byVehicle[vehicleId]
  if (prev) {
    prev[1] = unix
    prev[2]++
  } else {
    byVehicle[vehicleId] = [unix, unix, 1]
  }

  let delta = pending.get(ymd)
  if (!delta) pending.set(ymd, (delta = {}))
  const dv = (delta[tripId] ??= {})
  const dprev = dv[vehicleId]
  if (dprev) { dprev[1] = unix; dprev[2]++ } else { dv[vehicleId] = [unix, unix, 1] }

  dirty.add(ymd)
}

export type SightingDelta = { tripId: string; vehicleId: string; firstSeen: number; lastSeen: number; samples: number }

/**
 * A legutóbbi hívás óta felgyűlt észlelések, és a számláló nullázása.
 * A hívó feladata kiírni őket; ha az adatbázis nem elérhető, a `restore`-ral
 * visszaadhatja a köteget, hogy a következő körben újra próbálkozhassunk.
 */
export function takeSightings(ymd: string): SightingDelta[] {
  const delta = pending.get(ymd)
  if (!delta) return []
  pending.delete(ymd)
  const out: SightingDelta[] = []
  for (const [tripId, byVehicle] of Object.entries(delta)) {
    for (const [vehicleId, [firstSeen, lastSeen, samples]] of Object.entries(byVehicle)) {
      out.push({ tripId, vehicleId, firstSeen, lastSeen, samples })
    }
  }
  return out
}

/** Sikertelen kiírás után a köteg visszatétele a következő próbálkozáshoz. */
export function restoreSightings(ymd: string, rows: SightingDelta[]): void {
  if (!rows.length) return
  let delta = pending.get(ymd)
  if (!delta) pending.set(ymd, (delta = {}))
  for (const r of rows) {
    const dv = (delta[r.tripId] ??= {})
    const prev = dv[r.vehicleId]
    if (prev) {
      prev[0] = Math.min(prev[0], r.firstSeen)
      prev[1] = Math.max(prev[1], r.lastSeen)
      prev[2] += r.samples
    } else {
      dv[r.vehicleId] = [r.firstSeen, r.lastSeen, r.samples]
    }
  }
}

/**
 * Egy nap naplója menetenként EGY járműre szűkítve: ahol több jármű is
 * bejelentkezett ugyanarra a trip_id-ra (feed-zaj), a legtöbbször észlelt nyer.
 */
export function journalFor(ymd: string): Map<string, JournalEntry> {
  const log = loadDay(ymd)
  const out = new Map<string, JournalEntry>()
  for (const [tripId, byVehicle] of Object.entries(log)) {
    let best: JournalEntry | null = null
    for (const [vehicleId, [firstSeen, lastSeen, samples]] of Object.entries(byVehicle)) {
      if (samples < MIN_SAMPLES) continue
      if (!best || samples > best.samples) best = { vehicleId, firstSeen, lastSeen, samples }
    }
    if (best) out.set(tripId, best)
  }
  return out
}

/** A módosult napok kiírása lemezre (periodikusan és leálláskor hívjuk). */
export function flushJournal(): void {
  if (!baseDir) return
  for (const ymd of dirty) {
    const log = days.get(ymd)
    if (!log) continue
    try { writeFileSync(fileOf(ymd), JSON.stringify(log)) } catch { /* lemezhiba nem áll(hat)ítja meg a gateway-t */ }
  }
  dirty.clear()
}

/** A megőrzési időn túli naplófájlok eldobása. */
function pruneOld(): void {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000)
  const limit = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}${String(cutoff.getDate()).padStart(2, '0')}`
  try {
    for (const name of readdirSync(baseDir)) {
      const ymd = name.replace(/\.json$/, '')
      if (!/^\d{8}$/.test(ymd) || ymd >= limit) continue
      unlinkSync(join(baseDir, name))
      days.delete(ymd)
    }
  } catch { /* üres vagy nem olvasható könyvtár */ }
}

/** Diagnosztika a rendszer-hubnak. */
export function journalStats(todayYmd: string) {
  const log = loadDay(todayYmd)
  return { day: todayYmd, tripsSeen: Object.keys(log).length, pendingWrites: dirty.size }
}
