/**
 * A hub munkamenete: aláírt, httpOnly süti (`hub_session`) + szerveroldali lista.
 *
 *   v1.<lejárat ms>.<véletlen azonosító>.<HMAC-SHA256>
 *
 * Az aláírókulcs folyamatonként véletlen (nem a jelszóból származik — egy
 * elcsípett sütiből így nem lehet jelszót törni), és az élő munkamenetek a
 * memóriában vannak: a kilépés azonnal érvényteleníti a sütit, a hub
 * újraindulása pedig mindenkit kiléptet. Tiszta függvények + egy globalThis-en
 * élő tár, hogy a proxy.ts és a route handlerek ugyanazt lássák.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hub_session";
const MAX_SESSIONS = 200;

type Store = { key: Buffer; live: Map<string, number> };
const g = globalThis as { __hubSessions?: Store };
const store: Store = (g.__hubSessions ??= { key: randomBytes(32), live: new Map() });

function sign(payload: string): string {
  return createHmac("sha256", store.key).update(payload).digest("base64url");
}

export function issueSession(ttlMs: number, now = Date.now()): { value: string; expires: Date } {
  const exp = now + ttlMs;
  const id = randomBytes(16).toString("base64url");
  for (const [k, e] of store.live) if (e <= now) store.live.delete(k);
  if (store.live.size >= MAX_SESSIONS) store.live.delete(store.live.keys().next().value as string);
  store.live.set(id, exp);
  const payload = `v1.${exp}.${id}`;
  return { value: `${payload}.${sign(payload)}`, expires: new Date(exp) };
}

function parse(value: string | undefined, now: number): { id: string; exp: number } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= now) return null;
  const expected = Buffer.from(sign(parts.slice(0, 3).join(".")));
  const got = Buffer.from(parts[3]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { id: parts[2], exp };
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  const s = parse(value, now);
  if (!s) return false;
  const exp = store.live.get(s.id);
  return exp != null && exp > now;
}

export function revokeSession(value: string | undefined): void {
  const s = parse(value, Date.now());
  if (s) store.live.delete(s.id);
}

/** Minden munkamenet érvénytelenítése (pl. jelszócsere után kézzel). */
export function revokeAllSessions(): void {
  store.live.clear();
}

/** Jelszó-összevetés állandó időben (a hosszkülönbség sem szivárog: mindkettő hash-e). */
export function passwordMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ── belépési próbálkozások korlátozása (címenként) ─────────────────────

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;
const fails = new Map<string, { n: number; until: number }>();

export function loginBlocked(ip: string, now = Date.now()): number {
  const f = fails.get(ip);
  if (!f || now > f.until) return 0;
  return f.n >= MAX_FAILS ? f.until - now : 0;
}

export function noteLoginFailure(ip: string, now = Date.now()): void {
  const f = fails.get(ip);
  if (!f || now > f.until) fails.set(ip, { n: 1, until: now + WINDOW_MS });
  else fails.set(ip, { n: f.n + 1, until: f.until });
  if (fails.size > 10_000) fails.clear();
}

export function clearLoginFailures(ip: string): void {
  fails.delete(ip);
}
