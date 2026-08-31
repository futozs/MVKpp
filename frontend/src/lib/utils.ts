import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const DIACRITICS_RE = /[̀-ͯ]/g

/**
 * Ekezet- es kis/nagybetu-fuggetlen normalizalas kereseshez, hogy pl.
 * "petofi ter" is talaljon a "Petofi ter"-re. NFD-vel szetbontjuk az
 * ekezetes karaktereket alapbetu + kombinalo ekezetjelre, majd a
 * kombinalo ekezetjeleket (U+0300-U+036F) eltavolitjuk.
 */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase()
}

/** A tizesek sajat illeszkedese - pl. "huszas", nem "huszes". */
const TENS_SUFFIX: Record<number, string> = {
  1: 'es',
  2: 'as',
  3: 'as',
  4: 'es',
  5: 'es',
  6: 'as',
  7: 'es',
  8: 'as',
  9: 'es',
}

/** Az egyesek illeszkedese - pl. "otos", "hatos", "harmas". */
const ONES_SUFFIX: Record<number, string> = {
  1: 'es',
  2: 'es',
  3: 'as',
  4: 'es',
  5: 'ös',
  6: 'os',
  7: 'es',
  8: 'as',
  9: 'es',
}

/**
 * Magyar illeszkedo vegzodes hozzafuzese a jaratszamhoz (pl. "14" -> "14-es",
 * "34" -> "34-es"), hogy ugy olvasson, ahogy valaki tenyleg mondana ("a
 * 14-es busz"), ne "14 busz". Kerek tizeseknel (10, 20, ..., 90) a tizes szo
 * sajat illeszkedese szamit, nem az utolso (0) szamjegy; nem tisztan
 * numerikus jaratjelnel (pl. betujel) valtozatlanul hagyjuk.
 */
export function withHungarianSuffix(routeShort: string): string {
  const trimmed = routeShort.trim()
  const n = Number(trimmed)
  if (!Number.isInteger(n) || String(n) !== trimmed) return routeShort
  if (n === 100) return `${routeShort}-as`
  const ones = n % 10
  if (ones === 0) {
    const tens = Math.floor(n / 10) % 10
    return `${routeShort}-${TENS_SUFFIX[tens] ?? 'es'}`
  }
  return `${routeShort}-${ONES_SUFFIX[ones] ?? 'es'}`
}
