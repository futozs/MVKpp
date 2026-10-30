/**
 * A worker és a web elérése a belső hálón, admin-kulccsal. A kulcs csak itt,
 * a hub szerveroldalán él — a böngésző sosem kapja meg.
 */
import { env } from "./env.ts";
import { HubError } from "./http.ts";

type Target = "worker" | "web";
const DEFAULT_TIMEOUT_MS = 8_000;

function base(target: Target): string {
  return target === "worker" ? env.workerUrl : env.webUrl;
}

export async function callService(target: Target, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // A worker a mesterkulcsot kapja, a (nyilvános) web csak a csak-olvasó metrika-kulcsot.
  if (target === "worker" && env.adminKey) headers.set("x-admin-key", env.adminKey);
  if (target === "web" && env.metricsKey) headers.set("x-metrics-key", env.metricsKey);
  try {
    return await fetch(base(target) + path, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? "időtúllépés" : e instanceof Error ? e.message : String(e);
    throw new HubError(502, `a ${target === "worker" ? "worker" : "web"} nem érhető el (${why})`);
  }
}

export async function serviceJson<T>(target: Target, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await callService(target, path, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    const hint = res.status === 401 ? (target === "worker" ? " (ADMIN_KEY eltér?)" : " (METRICS_KEY eltér vagy hiányzik?)") : "";
    throw new HubError(res.status === 401 ? 502 : res.status, `${target}: ${msg}${hint}`);
  }
  return data as T;
}

export const workerJson = <T>(path: string, init?: RequestInit & { timeoutMs?: number }) => serviceJson<T>("worker", path, init);
export const webJson = <T>(path: string, init?: RequestInit & { timeoutMs?: number }) => serviceJson<T>("web", path, init);

export function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** A worker gyakran kért, ritkán változó listái (megálló- és vonalnevek) — 30 percig a memóriában. */
const nameCache = new Map<string, { at: number; data: unknown }>();
const NAME_TTL_MS = 30 * 60_000;

export async function cachedWorkerJson<T>(path: string): Promise<T> {
  const hit = nameCache.get(path);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.data as T;
  const data = await workerJson<T>(path, { timeoutMs: 15_000 });
  nameCache.set(path, { at: Date.now(), data });
  return data;
}

/** /gtfs/stops.json: [id, kód, név, lat, lon][] — /gtfs/routes.json: [id, rövid, hosszú, típus, szín, szövegszín][] */
type StopTuple = [string, string, string, number, number];
type RouteTuple = [string, string, string, number, string, string];

export type RouteName = { short: string; long: string; color: string; text: string };
export type Names = { stops: Map<string, string>; routes: Map<string, RouteName> };

/** Megálló- és vonalnevek a worker GTFS-éből (a kedvenc-statisztika olvasható legyen). */
export async function gtfsNames(): Promise<Names> {
  const [stops, routes] = await Promise.all([
    cachedWorkerJson<StopTuple[]>("/gtfs/stops.json").catch(() => [] as StopTuple[]),
    cachedWorkerJson<RouteTuple[]>("/gtfs/routes.json").catch(() => [] as RouteTuple[]),
  ]);
  return {
    stops: new Map(stops.map((x) => [String(x[0]), String(x[2])])),
    routes: new Map(routes.map((x) => [String(x[0]), { short: String(x[1] || x[0]), long: String(x[2] ?? ""), color: x[4] || "888888", text: x[5] || "FFFFFF" }])),
  };
}
