/**
 * MVK JWT kezelése a VPS-en.
 *
 * Forrásai: a macOS agent (aláírt kéréssel, ~6 óránként), a szerver saját
 * megújítása (generate-jwt), vagy kézi betöltés. A token titkosítva kerül az
 * adatbázisba; memóriában a legfrissebb érvényes él.
 */
import { getPool, sql } from "@mvk/db";
import { decryptSecret, encryptSecret, jwtClaims } from "@mvk/db/crypto";
import { config } from "./config.ts";
import { errMsg, log } from "./log.ts";

export type TokenStatus = {
  present: boolean;
  exp?: number;
  expiresInSec?: number | null;
  expired?: boolean;
  installationId?: string;
  source?: string;
  receivedAt?: string;
  rejected?: boolean;
};

type Current = { jwt: string; exp: number; installationId: string | null; source: string; receivedAt: Date };

let current: Current | null = null;
let rejectedAt = 0;
let lastRenew: { at: string; ok: boolean; status?: number; note?: string } | null = null;
let renewing = false;

const nowSec = () => Math.floor(Date.now() / 1000);

export function isJwt(s: string): boolean {
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s.trim());
}

export async function loadToken(): Promise<void> {
  const rows = await sql<{ jwt_enc: string; exp: Date; installation_id: string | null; source: string; received_at: Date }>(
    `SELECT jwt_enc, exp, installation_id, source, received_at FROM mvk_token
      WHERE rejected_at IS NULL ORDER BY exp DESC, received_at DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return;
  try {
    current = { jwt: decryptSecret(r.jwt_enc), exp: Math.floor(r.exp.getTime() / 1000), installationId: r.installation_id, source: r.source, receivedAt: r.received_at };
  } catch (e) {
    log.error("token", "a tárolt token nem fejthető vissza (megváltozott az APP_SECRET?)", e);
  }
}

export function currentJwt(): string | null {
  return current?.jwt ?? null;
}

export function tokenStatus(): TokenStatus {
  if (!current) return { present: false };
  const left = current.exp - nowSec();
  return {
    present: true,
    exp: current.exp,
    expiresInSec: left,
    expired: left <= 0,
    installationId: current.installationId ?? undefined,
    source: current.source,
    receivedAt: current.receivedAt.toISOString(),
    rejected: nowSec() - rejectedAt < 180,
  };
}

export const lastRenewInfo = () => lastRenew;
export const tokenRejectedRecently = () => nowSec() - rejectedAt < 180;

/** Új token befogadása. Csak akkor cseréli le a mostanit, ha később jár le. */
export async function ingestToken(jwt: string, source: string, agentId?: string | null, installationId?: string | null) {
  const tok = jwt.trim();
  if (!isJwt(tok)) return { ok: false as const, error: "nem érvényes JWT" };
  const c = jwtClaims(tok);
  const exp = typeof c.exp === "number" ? c.exp : null;
  if (!exp) return { ok: false as const, error: "a JWT-ben nincs lejárat" };
  if (exp <= nowSec()) return { ok: false as const, error: "a token már lejárt" };
  const inst = installationId || (typeof c["installation-id"] === "string" ? (c["installation-id"] as string) : null);
  const iat = typeof c.iat === "number" ? c.iat : null;
  const changed = current?.jwt !== tok;
  if (changed) {
    await getPool().query(
      `INSERT INTO mvk_token (jwt_enc, installation_id, iat, exp, source, agent_id) VALUES ($1, $2, to_timestamp($3), to_timestamp($4), $5, $6)`,
      [encryptSecret(tok), inst, iat, exp, source, agentId ?? null],
    );
  }
  if (!current || exp >= current.exp || tokenRejectedRecently()) {
    current = { jwt: tok, exp, installationId: inst, source, receivedAt: new Date() };
    rejectedAt = 0;
  }
  log.info("token", `${changed ? "új token" : "változatlan token"} (${source}${agentId ? `/${agentId}` : ""}), ${Math.round((exp - nowSec()) / 60)} percig érvényes`);
  return { ok: true as const, status: tokenStatus() };
}

/** Az MVK 401/403-at adott egy még érvényesnek hitt tokenre. */
export async function markRejected(): Promise<void> {
  if (!current || current.exp <= nowSec()) return;
  if (tokenRejectedRecently()) return;
  rejectedAt = nowSec();
  log.warn("token", "az MVK elutasította az érvényesnek tűnő tokent  az agentnek újra kell olvasnia az appból");
}

/** Szerveroldali megújítás (az MVK app is ezt hívja). Sikertelen App Attest nélkül is megpróbáljuk. */
export async function renewToken(reason: string) {
  if (renewing || !current) return lastRenew;
  renewing = true;
  const at = new Date().toISOString();
  try {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${current.jwt}` };
    if (current.installationId) headers["installation-id"] = current.installationId;
    const res = await fetch(`${config.mvkApi}/api/v1/installation/generate-jwt`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) return (lastRenew = { at, ok: false, status: res.status, note: `elutasítva: ${text.slice(0, 160) || "(üres)"}` });
    const m = text.match(/eyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]{6,}/);
    if (m && m[0] !== current.jwt) {
      await ingestToken(m[0], "renew");
      log.info("token", `megújítva (${reason})`);
      return (lastRenew = { at, ok: true, status: res.status, note: "új token" });
    }
    return (lastRenew = { at, ok: false, status: res.status, note: "a válaszban nincs új JWT" });
  } catch (e) {
    return (lastRenew = { at, ok: false, note: errMsg(e) });
  } finally {
    renewing = false;
  }
}

export function startRenewLoop(): void {
  setInterval(() => {
    const st = tokenStatus();
    if (st.present && (st.expiresInSec ?? Infinity) <= config.renewMarginSec) renewToken("ütemezett").catch(() => {});
  }, 120_000).unref();
}
