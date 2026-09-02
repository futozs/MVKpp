/**
 * Jelszó nélküli fiók + felhős biztonsági mentés.
 *
 * Nincs jelszó: a "belépés" maga egy 256 bites, a böngészőben generált titkos
 * kulcs, ami csak ezen az eszközön (localStorage) él. Másik eszközön a kulcs
 * (vagy egy QR-kód / másolás) bevitelével lehet ugyanahhoz a fiókhoz
 * kapcsolódni — nincs "csak e-maillel belépés" út, mert az e-mail önmagában
 * nem hitelesít.
 *
 * A mentés iránya szigorúan egyirányú: ez a modul rendszeresen FELküldi a
 * localStorage app-adatait, de sosem tölt le és ír felül automatikusan —
 * letöltés csak explicit felhasználói kérésre (pullBackup) történik.
 */

let API_BASE = import.meta.env.VITE_API_URL ?? "";
if (!API_BASE && typeof window !== "undefined" && import.meta.env.PROD) {
  const { protocol, hostname } = window.location;
  API_BASE =
    protocol === "https:" ? `https://${hostname}` : `http://${hostname}:8088`;
}

const ACCOUNT_KEY_STORAGE = "mvk_account";
/** Csak ez alatt a névtér alatt élő kulcsokat mentjük/állítjuk vissza — ez maga sosem szerepel a mentésben. */
const BACKUP_PREFIX = "mvk_";
const EXCLUDE_FROM_BACKUP = new Set([ACCOUNT_KEY_STORAGE]);

export type Account = { email: string; key: string };

function readAccount(): Account | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Account>;
    if (!parsed.email || !parsed.key) return null;
    return { email: parsed.email, key: parsed.key };
  } catch {
    return null;
  }
}

function writeAccount(acc: Account | null): void {
  try {
    if (acc) localStorage.setItem(ACCOUNT_KEY_STORAGE, JSON.stringify(acc));
    else localStorage.removeItem(ACCOUNT_KEY_STORAGE);
  } catch {
    /* localStorage megtelt vagy tiltott */
  }
}

export const getAccount = readAccount;

/** Kijelentkezés — csak ezt az eszközt választja le, a felhős mentés megmarad. */
export function forgetAccountOnThisDevice(): void {
  writeAccount(null);
}

export type AccountResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

async function post<T>(path: string, body: unknown): Promise<AccountResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, reason: data?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Új fiók létrehozása — a kulcsot a szerver generálja, és csak ITT, egyszer adja vissza. */
export async function registerAccount(
  email: string,
): Promise<AccountResult<Account>> {
  const res = await post<{ email: string; key: string }>("/account/register", {
    email,
  });
  if (!res.ok) return res;
  const acc: Account = { email: res.data.email, key: res.data.key };
  writeAccount(acc);
  return { ok: true, data: acc };
}

/**
 * Egy meglévő fiók kulcsának bevitele ezen az eszközön (pl. egy másik
 * eszközön korábban létrehozott fiók csatlakoztatása). A kulcsot a szerver
 * ELLENŐRZI (státusz-lekérdezéssel), mielőtt elmentenénk — így egy elgépelt
 * kulcs nem "kapcsolódik csendben".
 */
export async function connectWithKey(
  key: string,
): Promise<AccountResult<Account>> {
  try {
    const res = await fetch(`${API_BASE}/account/status`, {
      headers: { "X-Account-Key": key },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        reason: res.status === 401 ? "Ismeretlen kulcs." : (data?.error ?? `HTTP ${res.status}`),
      };
    }
    const acc: Account = { email: data.email, key };
    writeAccount(acc);
    return { ok: true, data: acc };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export type BackupStatus = { email: string; lastBackupAt: number | null; bytes: number };

export async function getBackupStatus(): Promise<AccountResult<BackupStatus>> {
  const acc = readAccount();
  if (!acc) return { ok: false, reason: "Nincs beállított fiók ezen az eszközön." };
  try {
    const res = await fetch(`${API_BASE}/account/status`, {
      headers: { "X-Account-Key": acc.key },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: data?.error ?? `HTTP ${res.status}` };
    return {
      ok: true,
      data: { email: data.email, lastBackupAt: data.lastBackupAt, bytes: data.bytes },
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Az app saját localStorage-kulcsainak pillanatképe — ez utazik a felhőbe. */
function snapshotLocalData(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(BACKUP_PREFIX) || EXCLUDE_FROM_BACKUP.has(key)) continue;
    const value = localStorage.getItem(key);
    if (value != null) out[key] = value;
  }
  return out;
}

/** Rendszeres/automatikus felküldés — soha nem tölt le, csak ment. */
export async function pushBackup(): Promise<AccountResult<{ bytes: number }>> {
  const acc = readAccount();
  if (!acc) return { ok: false, reason: "Nincs beállított fiók ezen az eszközön." };
  try {
    const res = await fetch(`${API_BASE}/account/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Account-Key": acc.key },
      body: JSON.stringify(snapshotLocalData()),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: data?.error ?? `HTTP ${res.status}` };
    return { ok: true, data: { bytes: data.bytes } };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Visszaállítás a felhőből — SZÁNDÉKOSAN csak akkor hívódik, ha a felhasználó
 * kifejezetten kéri (gomb + megerősítés), soha nem automatikusan induláskor.
 * Felülírja a jelenlegi eszköz app-adatait a felhőben tárolt utolsó mentéssel.
 */
export async function pullBackup(): Promise<
  AccountResult<{ updatedAt: number; keysRestored: number }>
> {
  const acc = readAccount();
  if (!acc) return { ok: false, reason: "Nincs beállított fiók ezen az eszközön." };
  try {
    const res = await fetch(`${API_BASE}/account/backup`, {
      headers: { "X-Account-Key": acc.key },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: data?.error ?? `HTTP ${res.status}` };

    const restored = data.data as Record<string, string>;
    let n = 0;
    for (const [key, value] of Object.entries(restored)) {
      if (!key.startsWith(BACKUP_PREFIX) || EXCLUDE_FROM_BACKUP.has(key)) continue;
      try {
        localStorage.setItem(key, value);
        n++;
      } catch {
        /* egy kulcs sikertelen írása ne állítsa meg a többit */
      }
    }
    return { ok: true, data: { updatedAt: data.updatedAt, keysRestored: n } };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
