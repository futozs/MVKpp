let API_BASE = import.meta.env.VITE_API_URL ?? "";
if (!API_BASE && typeof window !== "undefined" && import.meta.env.PROD) {
  const { protocol, hostname } = window.location;
  API_BASE =
    protocol === "https:" ? `https://${hostname}` : `http://${hostname}:8088`;
}

const log = (...args: unknown[]) => console.log("[push]", ...args);

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (e) {
    log("service worker nem áll készen:", (e as Error).message);
    return null;
  }
}

export type PushDiagnostic = { ok: boolean; reason?: string };

async function ensureSubscription(): Promise<
  { sub: PushSubscription } | { sub: null; reason: string }
> {
  if (!pushSupported()) {
    log("ez a böngésző NEM támogatja a Push API-t (nincs serviceWorker vagy PushManager)");
    return { sub: null, reason: "A böngésző nem támogatja a push-értesítést." };
  }

  const existing = await getSubscription();
  if (existing) {
    log("már van érvényes feliratkozás:", existing.endpoint.slice(-16));
    return { sub: existing };
  }

  try {
    const res = await fetch(`${API_BASE}/push/vapid-public-key`);
    if (!res.ok) {
      log(`VAPID kulcs lekérése sikertelen: HTTP ${res.status} (${API_BASE}/push/vapid-public-key)`);
      return { sub: null, reason: `Nem sikerült elérni a szervert (${API_BASE}).` };
    }
    const data = (await res.json()) as { publicKey: string | null };
    const publicKey = data.publicKey?.trim();
    if (!publicKey) {
      log("a szerveren nincs beállítva VAPID kulcs (push kikapcsolva a backenden)");
      return { sub: null, reason: "A szerveren nincs beállítva a push (VAPID hiányzik)." };
    }

    const keyBytes = urlBase64ToUint8Array(publicKey);
    log(`VAPID kulcs: ${publicKey.length} karakter → ${keyBytes.length} byte dekódolva`);
    if (keyBytes.length !== 65) {
      log("a VAPID kulcs mérete hibás (65 byte kellene) — sérült/hiányos kulcs a szerveren");
      return {
        sub: null,
        reason: `A szerver VAPID kulcsa hibás méretű (${keyBytes.length} byte a várt 65 helyett) — ellenőrizd a VAPID_PUBLIC_KEY-t a szerver .env-jében, nincs-e benne extra szóköz vagy csonka másolás.`,
      };
    }

    log("feliratkozás indul…");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes as BufferSource,
    });
    log("feliratkozás sikeres:", sub.endpoint.slice(-16));
    return { sub };
  } catch (e) {
    const message = (e as Error).message;
    log("feliratkozás sikertelen:", message);
    return { sub: null, reason: `A feliratkozás elutasítva: ${message}` };
  }
}

export type PushWatchConfig = {
  stopId: string;
  stopName: string;
  thresholdMin: number;
  routeShorts?: string[];
  tripId?: string;
  isDeparture?: boolean;
  schedMin?: number;
};

export async function registerPushWatch(
  config: PushWatchConfig,
): Promise<PushDiagnostic> {
  const result = await ensureSubscription();
  if (!result.sub) return { ok: false, reason: result.reason };

  try {
    const res = await fetch(`${API_BASE}/push/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: result.sub.toJSON(), ...config }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(`figyelés mentése sikertelen: HTTP ${res.status} — ${text}`);
      return { ok: false, reason: `A szerver elutasította a mentést (${res.status}).` };
    }
    log("figyelés mentve a szerveren:", config.stopId);
    return { ok: true };
  } catch (e) {
    const message = (e as Error).message;
    log("figyelés mentése sikertelen:", message);
    return { ok: false, reason: `Nem sikerült elérni a szervert: ${message}` };
  }
}

export async function setDnd(
  dnd: { enabled: boolean; startMin: number; endMin: number },
): Promise<PushDiagnostic> {
  const sub = await getSubscription();
  if (!sub) return { ok: false, reason: "Nincs aktív push-feliratkozás." };
  try {
    const res = await fetch(`${API_BASE}/push/dnd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        dndEnabled: dnd.enabled,
        dndStartMin: dnd.startMin,
        dndEndMin: dnd.endMin,
      }),
    });
    if (!res.ok) return { ok: false, reason: `A szerver elutasította (${res.status}).` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function unregisterPushWatch(stopId: string): Promise<void> {
  const sub = await getSubscription();
  if (!sub) return;
  try {
    await fetch(`${API_BASE}/push/watch`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, stopId }),
    });
  } catch {
  }
}
