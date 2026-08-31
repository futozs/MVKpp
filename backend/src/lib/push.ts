import webpush from "web-push";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const SUBJECT = process.env.VAPID_SUBJECT ?? "";

/**
 * Push csak akkor él, ha mindhárom VAPID env változó be van állítva a
 * szerveren. Enélkül a /push végpontok szépen "nincs konfigurálva"
 * választ adnak, és a kliens visszaesik a helyi (nyitott lapos)
 * értesítésre — nincs kőbe vésett titok a forráskódban.
 */
export const pushConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY && SUBJECT);

if (pushConfigured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

export const vapidPublicKey = PUBLIC_KEY;

export type PushSubscriptionKeys = { p256dh: string; auth: string };
export type PushSubscriptionJSON = {
  endpoint: string;
  keys: PushSubscriptionKeys;
};

export type PushSendResult = "ok" | "gone" | "error";

/**
 * Egy push üzenet kiküldése. A "gone" visszatérési érték azt jelzi, hogy a
 * böngésző push-szolgáltatása szerint ez a feliratkozás már nem létezik
 * (pl. a felhasználó törölte az appot) — ilyenkor a hívó törölheti a sort.
 */
export async function sendPush(
  subscription: PushSubscriptionJSON,
  payload: { title: string; body: string; tag: string },
): Promise<PushSendResult> {
  if (!pushConfigured) return "error";
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return "ok";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "gone";
    return "error";
  }
}
