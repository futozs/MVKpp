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
