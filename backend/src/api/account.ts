/**
 * Jelszó nélküli fiók + felhős biztonsági mentés.
 *
 * Nincs jelszó, nincs e-mail-hitelesítés (nincs levélküldő infrastruktúra) —
 * a belépés maga a titkos kulcs, amit a kliens generál (Web Crypto CSPRNG) és
 * localStorage-ban tart. A szerver csak a kulcs SHA-256 hash-ét ismeri, a
 * kulcsot magát soha nem tárolja olvashatóan. Az e-mail csupán megjelenítési
 * címke — nincs rajta UNIQUE megszorítás, és önmagában NEM elég egy fiók
 * eléréséhez, mert nincs "csak e-maillel belépés" út (ez védi ki, hogy valaki
 * más e-mail-címét beírva átvegye az irányítást egy idegen fiók felett).
 *
 * A mentés iránya szigorúan egyirányú: a kliens rendszeresen felküldi a saját
 * localStorage-ját (POST /backup), a szerver viszont SOHA nem kezdeményez
 * letöltést — a GET /backup csak a felhasználó kifejezett kérésére hívódik a
 * kliensből, így a helyi adat automatikusan sosem íródik felül, csak mentés
 * történik, adatvesztés nem.
 */
import { Hono } from "hono";
import { randomBytes, createHash } from "node:crypto";
import { query, isReady } from "../db/pool.ts";

export const account = new Hono();

const MAX_PAYLOAD_BYTES = 1_000_000; // 1 MB bőven elég egy localStorage-mentéshez

account.use("*", async (c, next) => {
  if (!(await isReady())) {
    return c.json({ error: "Az adatraktár nem érhető el" }, 503);
  }
  await next();
});

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

type Account = { account_id: number; email: string };

/** A kérés `X-Account-Key` fejlécéből azonosítja a fiókot. */
async function resolveAccount(c: {
  req: { header: (k: string) => string | undefined };
}): Promise<Account | null> {
  const key = c.req.header("x-account-key");
  if (!key) return null;
  const [row] = await query<Account>(
    `SELECT account_id, email FROM account WHERE key_hash = ?`,
    [hashKey(key)],
  );
  return row ?? null;
}

account.post("/register", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = (body?.email ?? "").trim();
  if (!email || !email.includes("@") || email.length > 255) {
    return c.json({ error: "Érvénytelen e-mail cím" }, 400);
  }

  const key = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);

  await query(
    `INSERT INTO account (email, key_hash, created_at) VALUES (?,?,?)`,
    [email, hashKey(key), now],
  );

  console.log(`[account] új fiók létrehozva: ${email}`);

  // A kulcs EGYETLEN alkalommal, ebben a válaszban látszik — a kliens
  // felelőssége eltárolni (localStorage) és felkínálni a felhasználónak.
  return c.json({ ok: true, email, key });
});

account.get("/status", async (c) => {
  const acc = await resolveAccount(c);
  if (!acc) return c.json({ error: "Érvénytelen vagy hiányzó kulcs" }, 401);

  const [backup] = await query<{ updated_at: number; bytes: number }>(
    `SELECT updated_at, bytes FROM account_backup WHERE account_id = ?`,
    [acc.account_id],
  );

  return c.json({
    ok: true,
    email: acc.email,
    lastBackupAt: backup ? backup.updated_at : null,
    bytes: backup?.bytes ?? 0,
  });
});

account.post("/backup", async (c) => {
  const acc = await resolveAccount(c);
  if (!acc) return c.json({ error: "Érvénytelen vagy hiányzó kulcs" }, 401);

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
  const acc = await resolveAccount(c);
  if (!acc) return c.json({ error: "Érvénytelen vagy hiányzó kulcs" }, 401);

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
