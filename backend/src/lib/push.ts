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
  console.log(`[push] VAPID beállítva (subject=${SUBJECT}) — push aktív`);
} else {
  const missing = [
    !PUBLIC_KEY && "VAPID_PUBLIC_KEY",
    !PRIVATE_KEY && "VAPID_PRIVATE_KEY",
    !SUBJECT && "VAPID_SUBJECT",
  ].filter(Boolean);
  console.log(
    `[push] VAPID nincs beállítva (hiányzik: ${missing.join(", ")}) — a push kikapcsolva, csak a helyi (nyitott lapos) értesítés működik`,
  );
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
  const shortEndpoint = subscription.endpoint.slice(-16);
  if (!pushConfigured) {
    console.log(`[push] küldés kihagyva (nincs VAPID) — ...${shortEndpoint}`);
    return "error";
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    console.log(`[push] elküldve: "${payload.title}" → ...${shortEndpoint}`);
    return "ok";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    const message = (err as Error).message;
    if (status === 404 || status === 410) {
      console.log(
        `[push] feliratkozás lejárt (${status}) → ...${shortEndpoint}, törlöm`,
      );
      return "gone";
    }
    console.log(
      `[push] hiba küldéskor (${status ?? "?"}): ${message} → ...${shortEndpoint}`,
    );
    return "error";
  }
}
