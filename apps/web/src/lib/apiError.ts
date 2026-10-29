/**
 * API-hibák emberi nyelven: a nyers hibaszöveg (HTML-oldal, stack) helyett a
 * hibakódból egy rövid ok, amit a felület egy sorban ki tud írni.
 */
export interface FriendlyError {
  /** HTTP-kód, ha volt (hálózati hibánál null) */
  code: number | null;
  /** rövid ok, pl. „A szerver most nem érhető el” */
  reason: string;
}

const STATUS_RE = /\[(\d{3})\]/;

export function describeApiError(err: unknown): FriendlyError {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const code = Number(STATUS_RE.exec(msg)?.[1] ?? NaN);
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { code: null, reason: "Nincs internetkapcsolat" };
  if (!Number.isFinite(code)) {
    // fetch() hálózati hibája: „Failed to fetch” / „Load failed” / „NetworkError…”
    return { code: null, reason: "A szerver nem válaszol" };
  }
  if (code === 401 || code === 403) return { code, reason: "Nincs hozzáférés" };
  if (code === 404) return { code, reason: "Ismeretlen megálló vagy adat" };
  if (code === 408 || code === 504) return { code, reason: "Túl lassú válasz" };
  if (code === 429) return { code, reason: "Túl sok kérés, kicsit lassítunk" };
  if (code === 502 || code === 503) return { code, reason: "A szerver most nem érhető el" };
  if (code >= 500) return { code, reason: "Szerverhiba" };
  return { code, reason: "Váratlan hiba" };
}
