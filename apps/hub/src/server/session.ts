/**
 * A hub munkamenete: aláírt, httpOnly süti (`hub_session`).
 *
 *   v1.<lejárat ms>.<véletlen>.<HMAC-SHA256>
 *
 * A kulcs a HUB_PASSWORD-ből és az APP_SECRET-ből származik — a jelszó
 * cseréje így minden élő munkamenetet érvénytelenít. Tiszta függvények: a
 * proxy.ts és a route handlerek is ezt használják.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hub_session";

function sessionKey(password: string, appSecret: string): Buffer {
  return createHash("sha256").update(`mvk-hub-session:${password}:${appSecret}`).digest();
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function issueSession(password: string, appSecret: string, ttlMs: number, now = Date.now()): { value: string; expires: Date } {
  const exp = now + ttlMs;
  const payload = `v1.${exp}.${randomBytes(12).toString("base64url")}`;
  return { value: `${payload}.${sign(sessionKey(password, appSecret), payload)}`, expires: new Date(exp) };
}

export function verifySession(value: string | undefined, password: string, appSecret: string, now = Date.now()): boolean {
  if (!value || !password || !appSecret) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = Buffer.from(sign(sessionKey(password, appSecret), parts.slice(0, 3).join(".")));
  const got = Buffer.from(parts[3]);
  return expected.length === got.length && timingSafeEqual(expected, got);
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
