/**
 * Menetrend-archívum visszatöltése egy KORÁBBI GTFS-készletből.
 *
 * A gateway a saját feedjének napjait automatikusan elrakja, de a már kifutott
 * feedekhez ez a szkript kell: rámutatsz egy régi GTFS-könyvtárra, és a benne
 * szereplő napok bekerülnek az archívumba.
 *
 *   node tools/archive-backfill.ts <gtfs-könyvtár> [--from YYYYMMDD] [--to YYYYMMDD]
 *
 * MÁR ELRAKOTT napot nem ír felül: a múlt menetrendje az, ami akkor érvényes
 * volt. Külön processzben fut, mert a GTFS betöltés globális indexeket cserél.
 */
import { loadGtfs, getFeedVersion } from '../src/lib/gtfs.ts'
import { buildDaySchedule, feedDays } from '../src/lib/timetable.ts'
import { saveDaySchedule } from '../src/lib/archive.ts'
import { closePool } from '../src/db/pool.ts'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv[i + 1] ?? null) : null
}

const dir = process.argv[2]
if (!dir || dir.startsWith('--')) {
  console.error('Használat: node tools/archive-backfill.ts <gtfs-könyvtár> [--from YYYYMMDD] [--to YYYYMMDD]')
  process.exit(1)
}

const from = arg('from')
const to = arg('to')

const r = loadGtfs(dir)
console.log(`[backfill] GTFS: ${r.stops} megálló, ${r.routes} vonal, ${r.trips} menet, feed=${r.feedVersion}`)

const days = feedDays().filter((d) => (!from || d >= from) && (!to || d <= to))
if (!days.length) {
  console.error('[backfill] a megadott tartományban nincs nap ebben a feedben.')
  process.exit(1)
}
console.log(`[backfill] ${days.length} nap: ${days[0]} … ${days[days.length - 1]}`)

// A „ma" itt a jövő: minden feldolgozott napot múltbelinek tekintünk, hogy a
// már elrakott napokat biztosan ne írjuk felül.
const guard = '99999999'
const counts: Record<string, number> = { saved: 0, unchanged: 0, past: 0, skipped: 0 }

for (const ymd of days) {
  const res = await saveDaySchedule(buildDaySchedule(ymd), guard)
  counts[res]++
  if (res === 'saved') console.log(`  ${ymd} elrakva (feed ${getFeedVersion()})`)
  if (res === 'skipped') { console.error('[backfill] nincs adatbázis-kapcsolat.'); break }
}

console.log(`[backfill] kész: ${counts.saved} új nap, ${counts.past} már megvolt, ${counts.skipped} kihagyva`)
await closePool()
