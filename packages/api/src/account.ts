/**
 * /account/* — jelszó nélküli fiók (passkey / WebAuthn) és munkamenet.
 *
 * A v2 végpontjai változatlan kérés/válasz formával (az iOS app és a régi
 * kliens is ezt hívja): sessionToken a válaszban, X-Account-Session a
 * kérésekben. A kriptográfiát a @simplewebauthn/server végzi.
 *
 * A passkey a regisztráció pillanatában az oldal hosztnevéhez (RP ID) kötődik:
 * a meglévő passkey-k csak akkor működnek tovább, ha az új szerver ugyanazon
 * a domainen fut, mint a régi.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { getPool, sql, sqlOne } from "@mvk/db";
import { ApiError, body, dispatch, json, route, type Route } from "./http.ts";
import { applyState } from "./sync.ts";

const RP_NAME = "MVK++";
const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_DAYS = 180;
const MAX_BACKUP_BYTES = 1_000_000;

const g = globalThis as unknown as { __mvkChallenges?: Map<string, { challenge: string; expiresAt: number }> };
const challenges = (g.__mvkChallenges ??= new Map());

const MAX_CHALLENGES = 5000;
function setChallenge(k: string, c: string) {
  // A lejártak kitakarítása (a hitelesítés nélküli kérések különben a végtelenségig növelnék).
  if (challenges.size >= MAX_CHALLENGES) {
    const now = Date.now();
    for (const [key, e] of challenges) if (e.expiresAt <= now) challenges.delete(key);
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  }
  challenges.set(k.toLowerCase(), { challenge: c, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}
function takeChallenge(k: string): string | null {
  const e = challenges.get(k.toLowerCase());
  challenges.delete(k.toLowerCase());
  return e && e.expiresAt > Date.now() ? e.challenge : null;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const userHandle = (email: string) => new Uint8Array(createHash("sha256").update(email.toLowerCase()).digest());
const validEmail = (e: unknown): e is string => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255;

/** RP ID és origin a kérésből (iOS-en a standalone PWA néha nem küld Origint, ilyenkor a Referer). */
function rp(req: Request): { rpID: string; origin: string } {
  const origin = req.headers.get("origin") ?? (() => {
    try {
      return new URL(req.headers.get("referer") ?? "").origin;
    } catch {
      return null;
    }
  })();
  if (!origin || origin === "null") throw new ApiError(400, "Hiányzó Origin fejléc");
  const u = new URL(origin);
  const allowed = (process.env.RP_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(u.origin)) throw new ApiError(400, "Ismeretlen eredet (origin)");
  return { rpID: u.hostname, origin: u.origin };
}

type User = { id: string; email: string };

export async function sessionUser(req: Request): Promise<User | null> {
  const tok = req.headers.get("x-account-session") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!tok) return null;
  const r = await sqlOne<User>(
    `UPDATE user_session s SET last_seen_at = now() FROM app_user u
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id
      RETURNING u.id, u.email::text AS email`,
    [hashToken(tok)],
  );
  return r;
}

async function requireUser(req: Request): Promise<User> {
  const u = await sessionUser(req);
  if (!u) throw new ApiError(401, "Nincs érvényes munkamenet.");
  return u;
}

async function createSession(userId: string, req: Request): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO user_session (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [hashToken(token), userId, SESSION_TTL_DAYS, (req.headers.get("user-agent") ?? "").slice(0, 200)],
  );
  return token;
}

const findUser = (email: string) => sqlOne<User>(`SELECT id, email::text AS email FROM app_user WHERE email = $1`, [email]);
const credentialsOf = (userId: string) =>
  sql<{ credential_id: string; public_key: Buffer; counter: number; transports: string | null }>(
    `SELECT credential_id, public_key, counter, transports FROM passkey WHERE user_id = $1`,
    [userId],
  );

async function storeCredential(userId: string, info: { credential: WebAuthnCredential; credentialDeviceType: string; credentialBackedUp: boolean }, deviceName: string | null) {
  await getPool().query(
    `INSERT INTO passkey (credential_id, user_id, public_key, counter, transports, device_type, backed_up, device_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [info.credential.id, userId, Buffer.from(info.credential.publicKey), info.credential.counter, info.credential.transports?.join(",") ?? null, info.credentialDeviceType, info.credentialBackedUp, deviceName],
  );
}

const routes: Route[] = [
  route("POST", "/account/passkey/register-options", async (req) => {
    const r = rp(req);
    const b = await body<{ email?: string }>(req);
    const email = (b?.email ?? "").trim().toLowerCase();
    if (!validEmail(email)) throw new ApiError(400, "Érvénytelen e-mail cím");
    if (await findUser(email)) throw new ApiError(409, "Ehhez az e-mailhez már van fiók — jelentkezz be a meglévő passkey-vel.");
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: r.rpID,
      userName: email,
      userID: userHandle(email),
      userDisplayName: email,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    setChallenge(email, options.challenge);
    return json({ ok: true, options });
  }),

  route("POST", "/account/passkey/register-verify", async (req) => {
    const r = rp(req);
    const b = await body<{ email?: string; response?: RegistrationResponseJSON; deviceName?: string }>(req);
    const email = (b?.email ?? "").trim().toLowerCase();
    if (!validEmail(email) || !b?.response) throw new ApiError(400, "Hiányzó mező");
    const expectedChallenge = takeChallenge(email);
    if (!expectedChallenge) throw new ApiError(400, "A regisztráció lejárt, próbáld újra.");
    if (await findUser(email)) throw new ApiError(409, "Ehhez az e-mailhez már van fiók — jelentkezz be a meglévő passkey-vel.");
    const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge, expectedOrigin: r.origin, expectedRPID: r.rpID }).catch((e: Error) => {
      throw new ApiError(400, `A passkey ellenőrzése sikertelen: ${e.message}`);
    });
    if (!v.verified || !v.registrationInfo) throw new ApiError(400, "A passkey ellenőrzése sikertelen.");
    const user = await sqlOne<User>(`INSERT INTO app_user (email) VALUES ($1) RETURNING id, email::text AS email`, [email]);
    if (!user) throw new ApiError(500, "A fiók létrehozása sikertelen");
    try {
      await storeCredential(user.id, v.registrationInfo, b.deviceName?.slice(0, 64) ?? null);
    } catch (e) {
      // Passkey nélkül a fiók használhatatlan lenne (az e-mail foglalt, belépni nem lehet): visszavonjuk.
      await getPool().query(`DELETE FROM app_user WHERE id = $1`, [user.id]).catch(() => {});
      throw e;
    }
    return json({ ok: true, email, sessionToken: await createSession(user.id, req) });
  }),

  route("POST", "/account/passkey/login-options", async (req) => {
    const r = rp(req);
    const b = await body<{ email?: string }>(req);
    const email = (b?.email ?? "").trim().toLowerCase();
    // E-mail nélkül: felfedezhető passkey („Bejelentkezés passkey-vel” gomb, választás az eszközön).
    if (!email) {
      const options = await generateAuthenticationOptions({ rpID: r.rpID, userVerification: "preferred" });
      setChallenge(`discover:${options.challenge}`, options.challenge);
      return json({ ok: true, options });
    }
    if (!validEmail(email)) throw new ApiError(400, "Érvénytelen e-mail cím");
    const user = await findUser(email);
    if (!user) throw new ApiError(404, "Nincs ilyen fiók.");
    const creds = await credentialsOf(user.id);
    if (!creds.length) throw new ApiError(404, "Ehhez a fiókhoz nincs regisztrált passkey.");
    const options = await generateAuthenticationOptions({
      rpID: r.rpID,
      userVerification: "preferred",
      allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: (c.transports?.split(",") as never) ?? undefined })),
    });
    setChallenge(email, options.challenge);
    return json({ ok: true, options });
  }),

  route("POST", "/account/passkey/login-verify", async (req) => {
    const r = rp(req);
    const b = await body<{ email?: string; response?: AuthenticationResponseJSON }>(req);
    if (!b?.response) throw new ApiError(400, "Hiányzó mező");
    const email = (b.email ?? "").trim().toLowerCase();
    let expectedChallenge: string | null;
    let row;
    if (email) {
      if (!validEmail(email)) throw new ApiError(400, "Hiányzó mező");
      expectedChallenge = takeChallenge(email);
      const user = await findUser(email);
      if (!user) throw new ApiError(404, "Nincs ilyen fiók.");
      row = await sqlOne<{ credential_id: string; user_id: string; public_key: Buffer; counter: number; transports: string | null; email: string }>(
        `SELECT p.credential_id, p.user_id, p.public_key, p.counter, p.transports, u.email::text AS email FROM passkey p JOIN app_user u ON u.id = p.user_id
          WHERE p.credential_id = $1 AND p.user_id = $2`,
        [b.response.id, user.id],
      );
    } else {
      const clientData = JSON.parse(Buffer.from(b.response.response.clientDataJSON, "base64url").toString("utf8")) as { challenge?: string };
      expectedChallenge = clientData.challenge ? takeChallenge(`discover:${clientData.challenge}`) : null;
      row = await sqlOne<{ credential_id: string; user_id: string; public_key: Buffer; counter: number; transports: string | null; email: string }>(
        `SELECT p.credential_id, p.user_id, p.public_key, p.counter, p.transports, u.email::text AS email FROM passkey p JOIN app_user u ON u.id = p.user_id
          WHERE p.credential_id = $1`,
        [b.response.id],
      );
    }
    if (!expectedChallenge) throw new ApiError(400, "A bejelentkezés lejárt, próbáld újra.");
    if (!row) throw new ApiError(400, "Ismeretlen passkey ehhez a fiókhoz.");
    const v = await verifyAuthenticationResponse({
      response: b.response,
      expectedChallenge,
      expectedOrigin: r.origin,
      expectedRPID: r.rpID,
      credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports ? (row.transports.split(",") as never) : undefined },
    }).catch((e: Error) => {
      throw new ApiError(400, `A passkey ellenőrzése sikertelen: ${e.message}`);
    });
    if (!v.verified) throw new ApiError(400, "A passkey ellenőrzése sikertelen.");
    await getPool().query(`UPDATE passkey SET counter = $1, last_used_at = now() WHERE credential_id = $2`, [v.authenticationInfo.newCounter, row.credential_id]);
    return json({ ok: true, email: row.email, sessionToken: await createSession(row.user_id, req) });
  }),

  route("POST", "/account/passkey/add-options", async (req) => {
    const r = rp(req);
    const u = await requireUser(req);
    const existing = await credentialsOf(u.id);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: r.rpID,
      userName: u.email,
      userID: userHandle(u.email),
      userDisplayName: u.email,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
    });
    setChallenge(`add:${u.email}`, options.challenge);
    return json({ ok: true, options });
  }),

  route("POST", "/account/passkey/add-verify", async (req) => {
    const r = rp(req);
    const u = await requireUser(req);
    const b = await body<{ response?: RegistrationResponseJSON; deviceName?: string }>(req);
    if (!b?.response) throw new ApiError(400, "Hiányzó mező");
    const expectedChallenge = takeChallenge(`add:${u.email}`);
    if (!expectedChallenge) throw new ApiError(400, "A folyamat lejárt, próbáld újra.");
    const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge, expectedOrigin: r.origin, expectedRPID: r.rpID }).catch((e: Error) => {
      throw new ApiError(400, `A passkey ellenőrzése sikertelen: ${e.message}`);
    });
    if (!v.verified || !v.registrationInfo) throw new ApiError(400, "A passkey ellenőrzése sikertelen.");
    await storeCredential(u.id, v.registrationInfo, b.deviceName?.slice(0, 64) ?? null);
    return json({ ok: true });
  }),

  route("POST", "/account/logout", async (req) => {
    const tok = req.headers.get("x-account-session");
    if (tok) await getPool().query(`DELETE FROM user_session WHERE token_hash = $1`, [hashToken(tok)]);
    return json({ ok: true });
  }),

  route("GET", "/account/status", async (req) => {
    const u = await requireUser(req);
    const b = await sqlOne<{ updated_at: Date; bytes: number }>(`SELECT updated_at, bytes FROM legacy_backup WHERE user_id = $1`, [u.id]);
    const st = await sqlOne<{ n: number; last: Date | null }>(`SELECT count(*)::int AS n, max(updated_at) AS last FROM user_state WHERE user_id = $1 AND NOT deleted`, [u.id]);
    const creds = await sql<{ device_name: string | null; created_at: Date; last_used_at: Date | null }>(`SELECT device_name, created_at, last_used_at FROM passkey WHERE user_id = $1 ORDER BY created_at`, [u.id]);
    const last = [b?.updated_at, st?.last].filter((x): x is Date => Boolean(x)).sort((a, c) => c.getTime() - a.getTime())[0] ?? null;
    return json({
      ok: true,
      email: u.email,
      lastBackupAt: last ? Math.floor(last.getTime() / 1000) : null,
      bytes: b?.bytes ?? 0,
      credentialCount: creds.length,
      syncedKeys: st?.n ?? 0,
      passkeys: creds.map((c) => ({ name: c.device_name, createdAt: c.created_at, lastUsedAt: c.last_used_at })),
    });
  }),

  // v2-kompatibilis teljes mentés: a v3 ezt kulcsonként a szinkron-táblába is beírja.
  route("POST", "/account/backup", async (req) => {
    const u = await requireUser(req);
    const raw = await req.text();
    if (!raw || raw.length > MAX_BACKUP_BYTES) throw new ApiError(400, "Hiányzó vagy túl nagy mentés");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "A mentés nem érvényes JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "A mentésnek kulcs–érték objektumnak kell lennie");
    const obj = parsed as Record<string, unknown>;
    const prevRow = await sqlOne<{ payload: Buffer }>(`SELECT payload FROM legacy_backup WHERE user_id = $1`, [u.id]);
    let prev: Record<string, unknown> = {};
    try {
      const p = prevRow ? JSON.parse(prevRow.payload.toString("utf8")) : {};
      if (p && typeof p === "object" && !Array.isArray(p)) prev = p as Record<string, unknown>;
    } catch {
      /* sérült régi mentés — mintha nem lenne */
    }
    await getPool().query(
      `INSERT INTO legacy_backup (user_id, payload, bytes, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, bytes = EXCLUDED.bytes, updated_at = now()`,
      [u.id, Buffer.from(raw), raw.length],
    );
    // A v2-kliens teljes pillanatképet küld "most" időbélyeggel. Csak azt vesszük
    // át, ami az előző mentése óta TÉNYLEG változott (vagy még nincs a szinkronban):
    // így a régi app módosításai átérnek, de a többi eszközön közben mentett
    // frissebb értékeket nem írja felül a változatlan pillanatkép.
    const known = new Set((await sql<{ key: string }>(`SELECT key FROM user_state WHERE user_id = $1`, [u.id])).map((r) => r.key));
    const now = new Date().toISOString();
    const items = Object.entries(obj)
      .filter(([k, v]) => typeof v === "string" && (!known.has(k) || prev[k] !== v))
      .map(([key, value]) => ({ key, value, deleted: false, updatedAt: now }));
    // Amit az előző mentés még tartalmazott, de ez már nem: törölte az appban.
    for (const k of Object.keys(prev)) if (!(k in obj) && known.has(k)) items.push({ key: k, value: null, deleted: true, updatedAt: now });
    await applyState(u.id, items, req.headers.get("x-device-id"));
    return json({ ok: true, bytes: raw.length, updatedAt: Math.floor(Date.now() / 1000) });
  }),

  route("GET", "/account/backup", async (req) => {
    const u = await requireUser(req);
    const rows = await sql<{ key: string; value: unknown }>(`SELECT key, value FROM user_state WHERE user_id = $1 AND NOT deleted`, [u.id]);
    if (rows.length) {
      const data: Record<string, unknown> = {};
      for (const r of rows) data[r.key] = r.value;
      const last = await sqlOne<{ t: number }>(`SELECT extract(epoch FROM max(updated_at))::int AS t FROM user_state WHERE user_id = $1`, [u.id]);
      return json({ ok: true, updatedAt: last?.t ?? null, data });
    }
    const b = await sqlOne<{ payload: Buffer; updated_at: Date }>(`SELECT payload, updated_at FROM legacy_backup WHERE user_id = $1`, [u.id]);
    if (!b) throw new ApiError(404, "Még nincs mentés ehhez a fiókhoz");
    return json({ ok: true, updatedAt: Math.floor(b.updated_at.getTime() / 1000), data: JSON.parse(b.payload.toString("utf8")) });
  }),
];

export const handleAccount = (req: Request) => dispatch(routes, req);
export { requireUser };
