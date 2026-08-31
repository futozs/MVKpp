let API_BASE = import.meta.env.VITE_API_URL ?? "";
if (!API_BASE && typeof window !== "undefined" && import.meta.env.PROD) {
  const { protocol, hostname } = window.location;
  API_BASE =
    protocol === "https:" ? `https://${hostname}` : `http://${hostname}:8088`;
}

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
  } catch {
    return null;
  }
}

async function ensureSubscription(): Promise<PushSubscription | null> {
  const existing = await getSubscription();
  if (existing) return existing;
  if (!pushSupported()) return null;

  try {
    const res = await fetch(`${API_BASE}/push/vapid-public-key`);
    if (!res.ok) return null;
    const { publicKey } = (await res.json()) as { publicKey: string | null };
    if (!publicKey) return null; // a szerveren nincs beállítva push

    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  } catch {
    return null;
  }
}

export type PushWatchConfig = {
  stopId: string;
  stopName: string;
  thresholdMin: number;
  routeShorts?: string[];
};

/**
 * Feliratkozik (ha még nincs), és regisztrálja a figyelést a szerveren, hogy
 * a phone lezárt/az app bezárt állapotában is jöhessen push-értesítés. Ha
 * bármi hiányzik (nincs HTTPS, iOS-en nincs kezdőképernyőre telepítve, a
 * szerveren nincs VAPID beállítva), csendben nem csinál semmit — a lapon
 * belüli (nyitott lapos) Notification API akkor is működik tovább.
 */
export async function registerPushWatch(config: PushWatchConfig): Promise<boolean> {
  const sub = await ensureSubscription();
  if (!sub) return false;
  try {
    const res = await fetch(`${API_BASE}/push/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), ...config }),
    });
    return res.ok;
  } catch {
    return false;
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
    // A helyi figyelés törlése enélkül is megtörténik — ez csak a szerver oldali rész.
  }
}
