/**
 * Design tokenek kiolvasása futásidőben.
 *
 * A Leaflet nem Tailwind osztályokat kap, hanem konkrét színsztringeket.
 * Hogy a térkép se essen ki a témából, a színeket ugyanabból a
 * theme/tokens.css-ből olvassuk, amiből a többi felület — ott HSL
 * komponensekként vannak tárolva, ezért itt csomagoljuk hsl()-be.
 */
const cache = new Map<string, string>()

export function token(name: string, fallback = 'hsl(0 0% 0%)'): string {
  const cached = cache.get(name)
  if (cached) return cached

  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) return fallback

  const value = raw.startsWith('#') || raw.startsWith('hsl') ? raw : `hsl(${raw})`
  cache.set(name, value)
  return value
}

/** Témaváltás után hívandó, hogy a térkép is új színeket vegyen fel. */
export function clearTokenCache() {
  cache.clear()
}
