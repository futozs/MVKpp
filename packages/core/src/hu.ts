/** Magyar toldalék járatszámhoz: „14-es”, „5-ös”, „20-as”. */
const TENS: Record<number, string> = { 1: "es", 2: "as", 3: "as", 4: "es", 5: "es", 6: "as", 7: "es", 8: "as", 9: "es" };
const ONES: Record<number, string> = { 1: "es", 2: "es", 3: "as", 4: "es", 5: "ös", 6: "os", 7: "es", 8: "as", 9: "es" };

export function withHungarianSuffix(routeShort: string): string {
  const trimmed = routeShort.trim();
  const m = trimmed.match(/^(\d+)([A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]*)$/);
  if (!m) return routeShort;
  const n = Number(m[1]);
  // Betűs jelzésnél (1V, 34A) a toldalék a kiejtéstől függ  inkább hagyjuk.
  if (m[2]) return routeShort;
  if (n === 100) return `${trimmed}-as`;
  if (n === 1000) return `${trimmed}-es`;
  const ones = n % 10;
  if (ones === 0) return `${trimmed}-${TENS[Math.floor(n / 10) % 10] ?? "as"}`;
  return `${trimmed}-${ONES[ones] ?? "es"}`;
}
