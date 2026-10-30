/** Web-szabványos (Request → Response) segédek; Next.js route handlerből és tesztből is hívható. */
import { cached as sharedCached } from "@mvk/cache";
import { isPlausibleIso, serviceClock } from "@mvk/core";
import { RouteMetrics } from "@mvk/core/ops/metrics";

/**
 * A web API válaszidői útvonal-mintánként (a rendszer-hub /v3/admin/metrics-en
 * olvassa). A globalThis-en él, hogy a Next minden route-bundle-je ugyanazt lássa.
 */
const g = globalThis as { __mvkApiMetrics?: RouteMetrics };
export const apiMetrics: RouteMetrics = (g.__mvkApiMetrics ??= new RouteMetrics());

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export type Route = { method: string; path: string; re: RegExp; keys: string[]; fn: (req: Request, p: Record<string, string>, url: URL) => Promise<Response> | Response };

export function route(method: string, path: string, fn: Route["fn"]): Route {
  const keys: string[] = [];
  const src = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/:(\w+)/g, (_, k) => {
    keys.push(k);
    return "/([^/]+)";
  });
  return { method, path, re: new RegExp(`^${src}$`), keys, fn };
}

/** A route-ok közül az első egyezőt futtatja; hibát egységes JSON-ná alakít. */
export async function dispatch(routes: Route[], req: Request): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const p: Record<string, string> = {};
    try {
      r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
    } catch {
      return json({ error: "érvénytelen útvonal-kódolás" }, 400);
    }
    const t0 = performance.now();
    let res: Response;
    try {
      res = await r.fn(req, p, url);
    } catch (e) {
      if (e instanceof ApiError) res = json({ error: e.message }, e.status);
      else {
        console.error(`[api] ${req.method} ${url.pathname}:`, e);
        res = json({ error: "Belső hiba" }, 500);
      }
    }
    apiMetrics.record(`${req.method} ${r.path}`, performance.now() - t0, res.status);
    return res;
  }
  return json({ error: "nincs ilyen végpont" }, 404);
}

export async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Gyorsítótár a drága statisztikai lekérdezésekhez: memória + (ha van
 * REDIS_URL) Redis, így több web-példány és újraindítás között is közös.
 * Az érték JSON-ként tárolódik — csak sima adatot adjon vissza `fn`.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  return sharedCached(`api:${key}`, ttlMs / 1000, fn);
}

/** Valódi, a mai naptól ±400 napon belüli dátum — különben null (a hívó az alapértéket használja). */
export const isoDate = (s: string | null | undefined): string | null => (s && isPlausibleIso(s, serviceClock().iso) ? s : null);

/** Egész szám lekérdezési paraméter, korlátok közé szorítva; hiányzó / hibás → alapérték (nem 500-as hiba). */
export function intParam(v: string | null, fallback: number, min: number, max: number): number {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
