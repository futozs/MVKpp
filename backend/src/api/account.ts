/**
 * Jelszó nélküli fiók + felhős biztonsági mentés — WebAuthn passkey.
 *
 * Nincs jelszó és nincs saját titkos kulcs sem: a hitelesítés a böngésző
 * platform-hitelesítőjén (Touch ID, Windows Hello, Android/iOS lezárás,
 * biztonsági kulcs) keresztül történik. A szerver soha nem lát és nem tárol
 * semmilyen titkot — csak a hitelesítő NYILVÁNOS kulcsát és egy számlálót
 * (account_credential). A kriptográfiai ellenőrzést a @simplewebauthn/server
 * (auditált, széles körben használt) könyvtár végzi, nem saját kód.
 *
 * Két elsődleges folyamat:
 *  - Regisztráció: ÚJ e-mailhez ÚJ fiókot és passkey-t hoz létre. Ha az
 *    e-mailhez már van fiók, ELUTASÍTJUK — különben bárki, aki ismeri
 *    valakinek az e-mail-címét, felvehetne SAJÁT passkey-t egy IDEGEN
 *    fiókhoz (ez lenne a fiók-átvétel).
 *  - Bejelentkezés: meglévő fiókhoz tartozó, már regisztrált passkey-vel.
 *  - Új eszköz hozzáadása egy MEGLÉVŐ fiókhoz csak érvényes munkamenettel
 *    (X-Account-Session) engedélyezett — így ehhez is előbb be kell
 *    jelentkezni egy már meglévő passkey-vel.
 *
 * Sikeres regisztráció/belépés után a szerver egy saját munkamenet-tokent ad
 * ki (account_session) — ezt küldi a kliens az X-Account-Session fejlécben a
 * mentési végpontokhoz, mert a WebAuthn ceremónia maga nem ad hordozható
 * tokent a további kérésekhez.
 *
 * A mentés iránya szigorúan egyirányú: a kliens rendszeresen felküldi a saját
 * localStorage-ját (POST /backup), a szerver viszont SOHA nem kezdeményez
 * letöltést — a GET /backup csak a felhasználó kifejezett kérésére hívódik a
 * kliensből, így a helyi adat automatikusan sosem íródik felül.
 */
import { Hono } from "hono";
import { randomBytes, createHash } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifyRegistrationResponseOpts,
  type VerifyAuthenticationResponseOpts,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  WebAuthnCredential,
  Uint8Array_,
} from "@simplewebauthn/server";
import { query, isReady } from "../db/pool.ts";

export const account = new Hono();

const RP_NAME = "MVK MobilON+";
const MAX_PAYLOAD_BYTES = 1_000_000; // 1 MB bőven elég egy localStorage-mentéshez
const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_S = 90 * 24 * 3600; // 90 nap

account.use("*", async (c, next) => {
  if (!(await isReady())) {
    return c.json({ error: "Az adatraktár nem érhető el" }, 503);
  }
  await next();
});

// ── RP ID / origin — az önhosztolt jelleg miatt a kérés Originjéből ────────
// A WebAuthn a regisztráció pillanatában rögzített RP ID-hoz köti a
// passkey-t — ha az app máskor más hosztnévről/IP-ről nyílik meg, a
// böngésző NEM fogja felajánlani ugyanazt a passkey-t. Ez a WebAuthn
// szabvány velejárója, nem ennek a kódnak a hibája: érdemes egyetlen,
// állandó hosztnévről (pl. mindig ugyanaz a helyi DNS-név vagy domain)
// használni a fiókot.
function rpFromRequest(c: {
  req: { header: (k: string) => string | undefined };
}): { rpID: string; origin: string } | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return { rpID: url.hostname, origin };
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** E-mailből származtatott, stabil "user handle" — nem PII-t hordoz, csak egy 32 byte-os azonosítót. */
function userHandle(email: string): Uint8Array_ {
  // A Node Buffer mindig valódi ArrayBuffer-re épül (soha nem
  // SharedArrayBuffer-re) — a cast csak a típusszintű ArrayBufferLike vs.
  // ArrayBuffer különbséget hidalja át, futásidejű kockázat nélkül.
  return createHash("sha256").update(email.toLowerCase()).digest() as unknown as Uint8Array_;
}

// ── Ideiglenes kihívás-tár (regisztráció/belépés köztes állapota) ─────────
// Percekig él csak, nincs szükség adatbázisra — egy folyamatban lévő
// ceremónia e-mailenként legfeljebb egy lehet.
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

function setChallenge(email: string, challenge: string) {
  challenges.set(email.toLowerCase(), { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}
function takeChallenge(email: string): string | null {
  const key = email.toLowerCase();
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

type AccountRow = { account_id: number; email: string };
type CredentialRow = {
  credential_id: string;
  account_id: number;
  public_key: Buffer;
  counter: number;
  transports: string | null;
};

async function findAccountByEmail(email: string): Promise<AccountRow | null> {
  const [row] = await query<AccountRow>(
    `SELECT account_id, email FROM account WHERE email = ?`,
    [email],
  );
  return row ?? null;
}

async function credentialsFor(accountId: number): Promise<CredentialRow[]> {
  return query<CredentialRow>(
    `SELECT credential_id, account_id, public_key, counter, transports
       FROM account_credential WHERE account_id = ?`,
    [accountId],
  );
}

async function createSession(accountId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  await query(
    `INSERT INTO account_session (session_hash, account_id, created_at, expires_at)
     VALUES (?,?,?,?)`,
    [hashToken(token), accountId, now, now + SESSION_TTL_S],
  );
  return token;
}

async function resolveSession(c: {
  req: { header: (k: string) => string | undefined };
}): Promise<AccountRow | null> {
  const token = c.req.header("x-account-session");
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const [row] = await query<AccountRow>(
    `SELECT a.account_id, a.email
       FROM account_session s
       JOIN account a ON a.account_id = s.account_id
      WHERE s.session_hash = ? AND s.expires_at > ?`,
    [hashToken(token), now],
  );
  return row ?? null;
}

function validEmail(email: unknown): email is string {
  return typeof email === "string" && email.includes("@") && email.length <= 255;
}

// ── Regisztráció (ÚJ fiók) ──────────────────────────────────────────────

account.post("/passkey/register-options", async (c) => {
  const rp = rpFromRequest(c);
  if (!rp) return c.json({ error: "Hiányzó Origin fejléc" }, 400);

  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = (body?.email ?? "").trim();
  if (!validEmail(email)) return c.json({ error: "Érvénytelen e-mail cím" }, 400);

  const existing = await findAccountByEmail(email);
  if (existing) {
    return c.json(
      { error: "Ehhez az e-mailhez már van fiók — jelentkezz be a meglévő passkey-vel." },
      409,
    );
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: email,
    userID: userHandle(email),
    userDisplayName: email,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  setChallenge(email, options.challenge);
  return c.json({ ok: true, options });
});

account.post("/passkey/register-verify", async (c) => {
  const rp = rpFromRequest(c);
  if (!rp) return c.json({ error: "Hiányzó Origin fejléc" }, 400);

  const body = await c.req
    .json<{ email?: string; response?: RegistrationResponseJSON }>()
    .catch(() => null);
  const email = (body?.email ?? "").trim();
  if (!validEmail(email) || !body?.response) {
    return c.json({ error: "Hiányzó mező" }, 400);
  }

  const expectedChallenge = takeChallenge(email);
  if (!expectedChallenge) {
    return c.json({ error: "A regisztráció lejárt, próbáld újra." }, 400);
  }

  // Az e-mail a challenge kiadása óta is elfoglalhatóvá válhatott — újra
  // ellenőrizzük közvetlenül a beírás előtt.
  if (await findAccountByEmail(email)) {
    return c.json(
      { error: "Ehhez az e-mailhez már van fiók — jelentkezz be a meglévő passkey-vel." },
      409,
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
    } satisfies VerifyRegistrationResponseOpts);
  } catch (e) {
    return c.json({ error: `A passkey ellenőrzése sikertelen: ${(e as Error).message}` }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "A passkey ellenőrzése sikertelen." }, 400);
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const now = Math.floor(Date.now() / 1000);

  await query(
    `INSERT INTO account (email, created_at) VALUES (?,?)`,
    [email, now],
  );
  const acc = await findAccountByEmail(email);
  if (!acc) return c.json({ error: "A fiók létrehozása sikertelen" }, 500);

  await query(
    `INSERT INTO account_credential
       (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      credential.id,
      acc.account_id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports?.join(",") ?? null,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      now,
    ],
  );

  console.log(`[account] új fiók + passkey létrehozva: ${email}`);

  const sessionToken = await createSession(acc.account_id);
  return c.json({ ok: true, email, sessionToken });
});

// ── Bejelentkezés (meglévő fiók) ────────────────────────────────────────

account.post("/passkey/login-options", async (c) => {
  const rp = rpFromRequest(c);
  if (!rp) return c.json({ error: "Hiányzó Origin fejléc" }, 400);

  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = (body?.email ?? "").trim();
  if (!validEmail(email)) return c.json({ error: "Érvénytelen e-mail cím" }, 400);

  const acc = await findAccountByEmail(email);
  if (!acc) return c.json({ error: "Nincs ilyen fiók." }, 404);
  const creds = await credentialsFor(acc.account_id);
  if (!creds.length) return c.json({ error: "Ehhez a fiókhoz nincs regisztrált passkey." }, 404);

  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "preferred",
    allowCredentials: creds.map((cr) => ({
      id: cr.credential_id,
      transports: (cr.transports?.split(",") as never) ?? undefined,
    })),
  });
  setChallenge(email, options.challenge);
  return c.json({ ok: true, options });
});

account.post("/passkey/login-verify", async (c) => {
  const rp = rpFromRequest(c);
  if (!rp) return c.json({ error: "Hiányzó Origin fejléc" }, 400);

  const body = await c.req
    .json<{ email?: string; response?: AuthenticationResponseJSON }>()
    .catch(() => null);
  const email = (body?.email ?? "").trim();
  if (!validEmail(email) || !body?.response) {
    return c.json({ error: "Hiányzó mező" }, 400);
  }

  const expectedChallenge = takeChallenge(email);
  if (!expectedChallenge) {
    return c.json({ error: "A bejelentkezés lejárt, próbáld újra." }, 400);
  }

  const acc = await findAccountByEmail(email);
  if (!acc) return c.json({ error: "Nincs ilyen fiók." }, 404);

  const [row] = await query<CredentialRow>(
    `SELECT credential_id, account_id, public_key, counter, transports
       FROM account_credential WHERE credential_id = ? AND account_id = ?`,
    [body.response.id, acc.account_id],
  );
  if (!row) return c.json({ error: "Ismeretlen passkey ehhez a fiókhoz." }, 400);

  const credential: WebAuthnCredential = {
    id: row.credential_id,
    publicKey: row.public_key as unknown as Uint8Array_,
    counter: row.counter,
    transports: row.transports ? (row.transports.split(",") as never) : undefined,
  };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential,
    } satisfies VerifyAuthenticationResponseOpts);
  } catch (e) {
    return c.json({ error: `A passkey ellenőrzése sikertelen: ${(e as Error).message}` }, 400);
  }
  if (!verification.verified) {
    return c.json({ error: "A passkey ellenőrzése sikertelen." }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await query(
    `UPDATE account_credential SET counter = ?, last_used_at = ? WHERE credential_id = ?`,
    [verification.authenticationInfo.newCounter, now, row.credential_id],
  );

  const sessionToken = await createSession(acc.account_id);
  return c.json({ ok: true, email: acc.email, sessionToken });
});

// ── Új eszköz/passkey hozzáadása MEGLÉVŐ, bejelentkezett fiókhoz ──────────

account.post("/passkey/add-options", async (c) => {
  const rp = rpFromRequest(c);
  if (!rp) return c.json({ error: "Hiányzó Origin fejléc" }, 400);
  const acc = await resolveSession(c);
  if (!acc) return c.json({ error: "Nincs érvényes munkamenet." }, 401);

  const existing = await credentialsFor(acc.account_id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: acc.email,
    userID: userHandle(acc.email),
    userDisplayName: acc.email,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: existing.map((cr) => ({ id: cr.credential_id })),
  });
  setChallenge(`add:${acc.email}`, options.challenge);
  return c.json({ ok: true, options });
});

account.post("/passkey/add-verify", async (c) => {
  const rp = rpFromRequest(c);
  if (!rp) return c.json({ error: "Hiányzó Origin fejléc" }, 400);
  const acc = await resolveSession(c);
  if (!acc) return c.json({ error: "Nincs érvényes munkamenet." }, 401);

  const body = await c.req.json<{ response?: RegistrationResponseJSON }>().catch(() => null);
  if (!body?.response) return c.json({ error: "Hiányzó mező" }, 400);

  const expectedChallenge = takeChallenge(`add:${acc.email}`);
  if (!expectedChallenge) return c.json({ error: "A folyamat lejárt, próbáld újra." }, 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
    } satisfies VerifyRegistrationResponseOpts);
  } catch (e) {
    return c.json({ error: `A passkey ellenőrzése sikertelen: ${(e as Error).message}` }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "A passkey ellenőrzése sikertelen." }, 400);
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const now = Math.floor(Date.now() / 1000);
  await query(
    `INSERT INTO account_credential
       (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      credential.id,
      acc.account_id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports?.join(",") ?? null,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      now,
    ],
  );

  return c.json({ ok: true });
});

account.post("/logout", async (c) => {
  const token = c.req.header("x-account-session");
  if (token) {
    await query(`DELETE FROM account_session WHERE session_hash = ?`, [hashToken(token)]);
  }
  return c.json({ ok: true });
});

// ── Biztonsági mentés ────────────────────────────────────────────────────

account.get("/status", async (c) => {
  const acc = await resolveSession(c);
  if (!acc) return c.json({ error: "Nincs érvényes munkamenet." }, 401);

  const [backup] = await query<{ updated_at: number; bytes: number }>(
    `SELECT updated_at, bytes FROM account_backup WHERE account_id = ?`,
    [acc.account_id],
  );
  const creds = await credentialsFor(acc.account_id);

  return c.json({
    ok: true,
    email: acc.email,
    lastBackupAt: backup ? backup.updated_at : null,
    bytes: backup?.bytes ?? 0,
    credentialCount: creds.length,
  });
});

account.post("/backup", async (c) => {
  const acc = await resolveSession(c);
  if (!acc) return c.json({ error: "Nincs érvényes munkamenet." }, 401);

  const raw = await c.req.text();
  if (!raw || raw.length > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "Hiányzó vagy túl nagy mentés" }, 400);
  }
  try {
    JSON.parse(raw);
  } catch {
    return c.json({ error: "A mentés nem érvényes JSON" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await query(
    `INSERT INTO account_backup (account_id, payload, bytes, updated_at)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), bytes = VALUES(bytes),
       updated_at = VALUES(updated_at)`,
    [acc.account_id, raw, raw.length, now],
  );

  return c.json({ ok: true, bytes: raw.length, updatedAt: now });
});

/**
 * Csak a felhasználó kifejezett kérésére hívódik a kliensből — SOSEM
 * automatikusan. Ez a végpont maga nem "szinkronizál", csak visszaadja a
 * legutóbbi mentést; a felülírás (ha lesz) a kliens döntése.
 */
account.get("/backup", async (c) => {
  const acc = await resolveSession(c);
  if (!acc) return c.json({ error: "Nincs érvényes munkamenet." }, 401);

  const [row] = await query<{ payload: Buffer; updated_at: number }>(
    `SELECT payload, updated_at FROM account_backup WHERE account_id = ?`,
    [acc.account_id],
  );
  if (!row) return c.json({ error: "Még nincs mentés ehhez a fiókhoz" }, 404);

  return c.json({
    ok: true,
    updatedAt: row.updated_at,
    data: JSON.parse(row.payload.toString("utf8")),
  });
});
