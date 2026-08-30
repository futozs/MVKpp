/**
 * Naptár-dimenzió: naptípus, ünnepnap, tanévi állapot.
 *
 * Ez adja a modellnek azt a jellemzőt, amitől a „szeptember 1-jén mennyi idő
 * bejutni a városba" kérdés egyáltalán megválaszolható. A tanszünetek dátumai
 * KÖZELÍTÉSEK — a `dim_calendar` sorai kézzel felülírhatók, és az
 * `event_note` mezőbe útlezárás vagy rendezvény is bejegyezhető.
 */

/** Húsvétvasárnap (anonim gregorián algoritmus). */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

const shift = (d: Date, days: number) => new Date(d.getTime() + days * 86400_000)
const key = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/** Magyar munkaszüneti napok az adott évben. */
export function hungarianHolidays(year: number): Map<string, string> {
  const e = easterSunday(year)
  const out = new Map<string, string>([
    [`${year}-01-01`, 'Újév'],
    [`${year}-03-15`, 'Nemzeti ünnep'],
    [`${year}-05-01`, 'A munka ünnepe'],
    [`${year}-08-20`, 'Államalapítás'],
    [`${year}-10-23`, 'Nemzeti ünnep'],
    [`${year}-11-01`, 'Mindenszentek'],
    [`${year}-12-25`, 'Karácsony'],
    [`${year}-12-26`, 'Karácsony másnapja'],
    [key(shift(e, -2)), 'Nagypéntek'],
    [key(e), 'Húsvétvasárnap'],
    [key(shift(e, 1)), 'Húsvéthétfő'],
    [key(shift(e, 50)), 'Pünkösdhétfő'],
  ])
  return out
}

/**
 * Tanévi állapot. Közelítés: szeptember 1. és június 15. között tanév, kivéve
 * az őszi, téli és tavaszi szünetet. A tavaszi szünet húsvéthoz kötött.
 */
export function isSchoolDay(d: Date): boolean {
  const y = d.getUTCFullYear()
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  // Nyári szünet: jún. 16. – aug. 31.
  if (md > 615 && md < 901) return false
  // Téli szünet: dec. 22. – jan. 2.
  if (md >= 1222 || md <= 102) return false
  // Őszi szünet: okt. 26. – nov. 3.
  if (md >= 1026 && md <= 1103) return false
  // Tavaszi szünet: húsvét körüli hét (nagycsütörtöktől keddig).
  const e = easterSunday(y)
  const spring = d.getTime() >= shift(e, -4).getTime() && d.getTime() <= shift(e, 2).getTime()
  if (spring) return false
  return true
}

export type CalendarRow = {
  service_date: string
  dow: number
  daytype: number
  school: number
  holiday_name: string | null
}

/** Naptípus: 0 = munkanap, 1 = szombat, 2 = vasárnap vagy ünnepnap. */
export function buildCalendar(fromIso: string, days: number): CalendarRow[] {
  const out: CalendarRow[] = []
  const start = new Date(fromIso + 'T00:00:00Z')
  const holidayCache = new Map<number, Map<string, string>>()

  for (let i = 0; i < days; i++) {
    const d = shift(start, i)
    const y = d.getUTCFullYear()
    if (!holidayCache.has(y)) holidayCache.set(y, hungarianHolidays(y))
    const iso = key(d)
    const holiday = holidayCache.get(y)!.get(iso) ?? null
    const jsDow = d.getUTCDay() // 0 = vasárnap
    const dow = jsDow === 0 ? 7 : jsDow // 1 = hétfő … 7 = vasárnap

    let daytype = 0
    if (holiday || dow === 7) daytype = 2
    else if (dow === 6) daytype = 1

    out.push({
      service_date: iso,
      dow,
      daytype,
      school: daytype === 0 && isSchoolDay(d) ? 1 : 0,
      holiday_name: holiday,
    })
  }
  return out
}
