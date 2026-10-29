import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const DIACRITICS_RE = /[̀-ͯ]/g

export function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase()
}

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
