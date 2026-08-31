/** A tízesek saját illeszkedése — pl. "húszas", nem "húszes". */
const TENS_SUFFIX: Record<number, string> = {
  1: "es",
  2: "as",
  3: "as",
  4: "es",
  5: "es",
  6: "as",
  7: "es",
  8: "as",
  9: "es",
};

/** Az egyesek illeszkedése — pl. "ötös", "hatos", "hármas". */
const ONES_SUFFIX: Record<number, string> = {
  1: "es",
  2: "es",
  3: "as",
  4: "es",
  5: "ös",
  6: "os",
  7: "es",
  8: "as",
  9: "es",
};

/**
 * Magyar illeszkedő végződés hozzáfűzése a járatszámhoz (pl. "14" → "14-es"),
 * hogy a push-értesítés úgy olvasson, ahogy valaki tényleg mondaná. Ugyanaz
 * a szabály, mint a frontend `lib/notifications.ts`-ében — mivel a push
 * kiküldés a szerveren történik, itt is szükség van rá.
 */
export function withHungarianSuffix(routeShort: string): string {
  const trimmed = routeShort.trim();
  const n = Number(trimmed);
  if (!Number.isInteger(n) || String(n) !== trimmed) return routeShort;
  if (n === 100) return `${routeShort}-as`;
  const ones = n % 10;
  if (ones === 0) {
    const tens = Math.floor(n / 10) % 10;
    return `${routeShort}-${TENS_SUFFIX[tens] ?? "es"}`;
  }
  return `${routeShort}-${ONES_SUFFIX[ones] ?? "es"}`;
}
