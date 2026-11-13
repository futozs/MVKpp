/**
 * Jelszó nélküli fiók + felhős biztonsági mentés  WebAuthn passkey.
 *
 * Nincs jelszó, nincs saját titkos kulcs: a "belépés" a böngésző/eszköz
 * platform-hitelesítőjén (Touch ID, Windows Hello, telefon lezárása,
 * biztonsági kulcs) keresztül történik. Ez a modul csak a HTTP-hívásokat és
 * a helyi munkamenet-tárolást intézi  a kriptográfiai ceremóniát a
 * @simplewebauthn/browser könyvtár végzi.
 *
 * A mentés iránya szigorúan egyirányú: ez a modul rendszeresen FELküldi a
 * localStorage app-adatait, de sosem tölt le és ír felül automatikusan 
 * letöltés csak explicit felhasználói kérésre (pullBackup) történik.
 */
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { API_BASE } from "@/lib/apiBase";

const SESSION_STORAGE = "mvk_account";
/**
 * Minden localStorage-kulcs utazik a mentésben, KIVÉVE ezt a listát  a
 * munkamenet-token eszközhöz kötött, azt sosem visznénk a felhőbe. Korábban
 * ez egy "mvk_" előtag-egyezéshez volt kötve: bármelyik jövőbeli (vagy akár
 * meglévő, de elgépelt/eltérő névterű) kulcs csendben kimaradt volna a
 * mentésből  pl. így maradtak le a statisztika fülön mentett kedvencek is.
 */
const EXCLUDE_FROM_BACKUP = new Set([SESSION_STORAGE]);

export type Session = { email: string; sessionToken: string };

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.email || !parsed.sessionToken) return null;
    return { email: parsed.email, sessionToken: parsed.sessionToken };
  } catch {
    return null;
  }
}

function writeSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_STORAGE, JSON.stringify(s));
    else localStorage.removeItem(SESSION_STORAGE);
  } catch {
    /* localStorage megtelt vagy tiltott */
  }
  // A felhős szinkron (lib/sync.ts) erre indul el / áll le.
  window.dispatchEvent(new Event("mvk-session-change"));
}

export const getSession = readSession;

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

export type AccountResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/**
 * Néhány mobil böngésző (leginkább az iOS-en, kezdőképernyőre telepített,
 * "standalone" módban futó PWA) az app hidegindítása utáni első hálózati
 * kérésnél időnként üres vagy sérült választ ad vissza 2xx státusszal is 
 * ez korábban egy nyers "null is not an object" JS-hibaként bukott fel a
 * felületen, mert a hívó kód feltétel nélkül `data.options`-ként próbálta
 * használni az (ilyenkor null-ra eső) választ. Emiatt itt explicit módon
 * hibaként kezeljük az érvénytelen JSON-t, és egyszer, csendben újrapróbáljuk
 *  ez a fajta hiba jellemzően tranziens.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  session?: Session,
  allowRetry = true,
): Promise<AccountResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(session ? { "X-Account-Session": session.sessionToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return { ok: false, reason: (data?.error as string) ?? `HTTP ${res.status}` };
    }
    if (data == null) {
      if (allowRetry) return postJson(path, body, session, false);
      return { ok: false, reason: "A szerver érvénytelen választ adott  próbáld újra." };
    }
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Passkey-hibák (pl. a felhasználó megszakítja a rendszer-promptot) barátságos szövege. */
function friendlyPasskeyError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError") return "Megszakítva vagy időtúllépés.";
  if (name === "InvalidStateError") return "Ez a passkey már regisztrálva van ezen az eszközön.";
  return (e as Error)?.message ?? "Ismeretlen hiba.";
}

/** Új fiók + új passkey létrehozása. Ha az e-mailhez már van fiók, hibát ad. */
export async function registerAccount(email: string): Promise<AccountResult<Session>> {
  const opt = await postJson<{ options: unknown }>("/account/passkey/register-options", { email });
  if (!opt.ok) return opt;
  let response;
  try {
    response = await startRegistration({
      optionsJSON: opt.data.options as Parameters<typeof startRegistration>[0]["optionsJSON"],
    });
  } catch (e) {
    return { ok: false, reason: friendlyPasskeyError(e) };
  }
  const verify = await postJson<{ email: string; sessionToken: string }>(
    "/account/passkey/register-verify",
    { email, response },
  );
  if (!verify.ok) return verify;
  const session: Session = { email: verify.data.email, sessionToken: verify.data.sessionToken };
  writeSession(session);
  return { ok: true, data: session };
}

/** Bejelentkezés egy meglévő fiókhoz regisztrált passkey-vel. */
export async function loginWithPasskey(email: string): Promise<AccountResult<Session>> {
  const opt = await postJson<{ options: unknown }>("/account/passkey/login-options", { email });
  if (!opt.ok) return opt;
  let response;
  try {
    response = await startAuthentication({
      optionsJSON: opt.data.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });
  } catch (e) {
    return { ok: false, reason: friendlyPasskeyError(e) };
  }
  const verify = await postJson<{ email: string; sessionToken: string }>(
    "/account/passkey/login-verify",
    { email, response },
  );
  if (!verify.ok) return verify;
  const session: Session = { email: verify.data.email, sessionToken: verify.data.sessionToken };
  writeSession(session);
  return { ok: true, data: session };
}

/** Új passkey (pl. másik eszköz) hozzáadása a JELENLEG bejelentkezett fiókhoz. */
export async function addPasskeyToCurrentAccount(): Promise<AccountResult<true>> {
  const session = readSession();
  if (!session) return { ok: false, reason: "Nincs érvényes munkamenet ezen az eszközön." };
  const opt = await postJson<{ options: unknown }>(
    "/account/passkey/add-options",
    {},
    session,
  );
  if (!opt.ok) return opt;
  let response;
  try {
    response = await startRegistration({
      optionsJSON: opt.data.options as Parameters<typeof startRegistration>[0]["optionsJSON"],
    });
  } catch (e) {
    return { ok: false, reason: friendlyPasskeyError(e) };
  }
  return postJson<true>("/account/passkey/add-verify", { response }, session);
}

/** Kijelentkezés  a szerveren is érvényteleníti a munkamenetet. */
export async function logout(): Promise<void> {
  const session = readSession();
  writeSession(null);
  if (!session) return;
  try {
    await fetch(`${API_BASE}/account/logout`, {
      method: "POST",
      headers: { "X-Account-Session": session.sessionToken },
    });
  } catch {
    /* a helyi kijelentkezés enélkül is megtörtént */
  }
}

export type BackupStatus = {
  email: string;
  lastBackupAt: number | null;
  bytes: number;
  credentialCount: number;
};

export async function getBackupStatus(): Promise<AccountResult<BackupStatus>> {
  const session = readSession();
  if (!session) return { ok: false, reason: "Nincs beállított fiók ezen az eszközön." };
  try {
    const res = await fetch(`${API_BASE}/account/status`, {
      headers: { "X-Account-Session": session.sessionToken },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: data?.error ?? `HTTP ${res.status}` };
    return {
      ok: true,
      data: {
        email: data.email,
        lastBackupAt: data.lastBackupAt,
        bytes: data.bytes,
        credentialCount: data.credentialCount,
      },
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** A teljes localStorage pillanatképe (a kizártak nélkül)  ez utazik a felhőbe. */
function snapshotLocalData(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || EXCLUDE_FROM_BACKUP.has(key)) continue;
    const value = localStorage.getItem(key);
    if (value != null) out[key] = value;
  }
  return out;
}

/** Rendszeres/automatikus felküldés  soha nem tölt le, csak ment. */
export async function pushBackup(): Promise<AccountResult<{ bytes: number }>> {
  const session = readSession();
  if (!session) return { ok: false, reason: "Nincs beállított fiók ezen az eszközön." };
  try {
    const res = await fetch(`${API_BASE}/account/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Account-Session": session.sessionToken },
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
 * Visszaállítás a felhőből  SZÁNDÉKOSAN csak akkor hívódik, ha a felhasználó
 * kifejezetten kéri (gomb + megerősítés), soha nem automatikusan induláskor.
 * Felülírja a jelenlegi eszköz app-adatait a felhőben tárolt utolsó mentéssel.
 */
export async function pullBackup(): Promise<
  AccountResult<{ updatedAt: number; keysRestored: number }>
> {
  const session = readSession();
  if (!session) return { ok: false, reason: "Nincs beállított fiók ezen az eszközön." };
  try {
    const res = await fetch(`${API_BASE}/account/backup`, {
      headers: { "X-Account-Session": session.sessionToken },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: data?.error ?? `HTTP ${res.status}` };

    const restored = data.data as Record<string, string>;
    let n = 0;
    for (const [key, value] of Object.entries(restored)) {
      if (EXCLUDE_FROM_BACKUP.has(key)) continue;
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
