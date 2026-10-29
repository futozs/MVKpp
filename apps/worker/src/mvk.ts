/** MVK API-kliens: a token beinjektálása, időkorlát, 401/403 jelzése. */
import { config } from "./config.ts";
import { currentJwt, markRejected } from "./token.ts";

export type MvkResponse = { status: number; buf: Buffer; contentType: string | null };

export async function mvkFetch(path: string, init: { method?: string; body?: Buffer; contentType?: string; accept?: string; timeoutMs?: number } = {}): Promise<MvkResponse> {
  const headers: Record<string, string> = { accept: init.accept ?? "application/json" };
  const tok = currentJwt();
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (init.contentType) headers["content-type"] = init.contentType;
  const res = await fetch(config.mvkApi + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body ? new Uint8Array(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  if (res.status === 401 || res.status === 403) await markRejected();
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
}

export function parseCancelledIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { trips?: unknown } | null)?.trips) ? (raw as { trips: unknown[] }).trips : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const r = item as Record<string, unknown> | null;
    const id = typeof item === "string" ? item : String(r?.tripId ?? r?.trip_id ?? r?.id ?? "");
    const t = id.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
