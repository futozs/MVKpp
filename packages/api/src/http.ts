/** Web-szabványos (Request → Response) segédek; Next.js route handlerből és tesztből is hívható. */
import { cached as sharedCached } from "@mvk/cache";

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

export type Route = { method: string; re: RegExp; keys: string[]; fn: (req: Request, p: Record<string, string>, url: URL) => Promise<Response> | Response };

export function route(method: string, path: string, fn: Route["fn"]): Route {
  const keys: string[] = [];
  const src = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/:(\w+)/g, (_, k) => {
    keys.push(k);
    return "/([^/]+)";
  });
  return { method, re: new RegExp(`^${src}$`), keys, fn };
}

/** A route-ok közül az első egyezőt futtatja; hibát egységes JSON-ná alakít. */
export async function dispatch(routes: Route[], req: Request): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const p: Record<string, string> = {};
    r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
    try {
      return await r.fn(req, p, url);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      console.error(`[api] ${req.method} ${url.pathname}:`, e);
      return json({ error: "Belső hiba" }, 500);
    }
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

export const isoDate = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
