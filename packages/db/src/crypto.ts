/**
 * Titkok kezelése.
 *  - Az MVK tokent titkosítva tároljuk (AES-256-GCM, kulcs az APP_SECRET-ből):
 *    egy adatbázis-mentésből így nem olvasható ki.
 *  - A macOS token-agent kéréseit HMAC-SHA256 aláírás + időbélyeg védi
 *    (visszajátszás ellen 5 perces ablak).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16) throw new Error("APP_SECRET hiányzik vagy túl rövid (min. 16 karakter)");
  return createHash("sha256").update(`mvk-token:${secret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(blob: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("ismeretlen titok-formátum");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Az agent aláírása: hex(HMAC(secret, `${ts}.${body}`)) */
export function signAgentRequest(secret: string, ts: number, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

export function verifyAgentRequest(secret: string, tsHeader: string | undefined, sigHeader: string | undefined, body: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(tsHeader);
  if (!secret || !Number.isFinite(ts) || !sigHeader) return false;
  if (Math.abs(nowSec - ts) > 300) return false;
  return safeEqual(signAgentRequest(secret, ts, body), sigHeader);
}

/** JWT payload olvasása (aláírás-ellenőrzés nélkül — csak a lejárathoz). */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}
