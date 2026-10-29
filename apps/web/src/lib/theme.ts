const cache = new Map<string, string>();

export function token(name: string, fallback = "hsl(0 0% 0%)"): string {
  const cached = cache.get(name);
  if (cached) return cached;

  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;

  const value =
    raw.startsWith("#") || raw.startsWith("hsl") ? raw : `hsl(${raw})`;
  cache.set(name, value);
  return value;
}

export function clearTokenCache() {
  cache.clear();
}
