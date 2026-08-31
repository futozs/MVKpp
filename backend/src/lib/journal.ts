/**
 * Menetnapló — melyik JÁRMŰ teljesítette az adott menetet.
 *
 * A gateway 0–24-ben fut, ezért folyamatosan mintavételezheti a pozíció-feedet
 * és feljegyezheti, melyik jármű jelentkezett be melyik trip_id-n. Így a
 * menetrendkönyv a NAP MÁSODIK FELÉBEN is meg tudja mondani, hogy a délelőtti
 * menetet melyik busz vitte — az élő feed ilyenkor már rég nem tud róla.
 *
 * A napló naponta egy JSON fájl a `state/journal/` alatt, hogy a gateway
 * újraindítása se törölje a ma összegyűjtött hozzárendeléseket.
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
  dirty.add(ymd)
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
