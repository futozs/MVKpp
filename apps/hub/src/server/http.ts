/**
 * A hub API-ja egyetlen catch-all route handler mögött (app/api/[...path]):
 * útvonal-tábla, egységes hibakezelés, CSRF-védelem a módosító kérésekre.
 */

export class HubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Ctx = { req: Request; url: URL; params: Record<string, string>; ip: string };
type Handler = (ctx: Ctx) => Promise<Response> | Response;
type Route = { method: string; re: RegExp; keys: string[]; fn: Handler };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export function route(method: string, path: string, fn: Handler): Route {
  const keys: string[] = [];
  const src = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/:(\w+)/g, (_, k) => {
    keys.push(k);
    return "/([^/]+)";
  });
  return { method, re: new RegExp(`^${src}$`), keys, fn };
}

export async function readJson<T extends Record<string, unknown>>(req: Request): Promise<Partial<T>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Partial<T>) : {};
  } catch {
    throw new HubError(400, "érvénytelen JSON");
  }
}

export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

/**
 * Módosító kérés csak a hub saját oldaláról jöhet: az Origin (vagy a
 * Sec-Fetch-Site) a saját hosztunk legyen. A süti SameSite=Strict, ez a
 * második védvonal.
 */
function assertSameOrigin(req: Request, url: URL): void {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HubError(403, "idegen oldalról érkező kérés");
  const origin = req.headers.get("origin");
  if (!origin) {
    if (!site) throw new HubError(403, "hiányzó Origin fejléc");
    return;
  }
  const host = req.headers.get("host") ?? url.host;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    throw new HubError(403, "érvénytelen Origin");
  }
  if (o.host !== host) throw new HubError(403, "idegen oldalról érkező kérés");
}

export async function dispatch(routes: Route[], req: Request): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req, url);
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return await r.fn({ req, url, params, ip: clientIp(req) });
    } catch (e) {
      if (e instanceof HubError) return json({ error: e.message }, e.status);
      console.error(`[hub] ${req.method} ${url.pathname}:`, e);
      return json({ error: e instanceof Error ? e.message : "Belső hiba" }, 500);
    }
  }
  return json({ error: "nincs ilyen végpont" }, 404);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Egy lassú vagy hibás forrás ne döntse el az egész választ: hiba esetén { error }. */
export async function settle<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (e) {
    return { error: errMsg(e) };
  }
}
