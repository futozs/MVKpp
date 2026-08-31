import { query } from "../db/pool.ts";
import { pushConfigured, sendPush } from "./push.ts";
import { withHungarianSuffix } from "./huSuffix.ts";

const CHECK_INTERVAL_MS = Number(process.env.PUSH_CHECK_INTERVAL_MS ?? 20_000);

type MinimalArrival = { route: string; etaMin: number; tripId: string };
type ArrivalsForStop = (
  stopId: string,
  limit: number,
) => Promise<{ arrivals: MinimalArrival[] }>;

type WatchRow = {
  watch_id: number;
  sub_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  stop_id: string;
  stop_name: string;
  threshold_min: number;
  route_shorts: string | null;
  last_notified: string | null;
};

/**
 * Egyetlen ellenőrző kör: minden bejegyzett push-figyelést összevet a friss
 * érkezésekkel, és ha van új (még nem riasztott) találat, push-t küld. Zárt
 * telefonon/bezárt lapnál is működik, mert a böngésző push-szolgáltatása
 * ébreszti fel a service workert — ez a lényegi különbség a helyi (nyitott
 * lapos) Notification API-hoz képest.
 */
async function checkOnce(arrivalsForStop: ArrivalsForStop): Promise<void> {
  const watches = await query<WatchRow>(
    `SELECT w.watch_id, w.sub_id, s.endpoint, s.p256dh, s.auth,
            w.stop_id, w.stop_name, w.threshold_min, w.route_shorts, w.last_notified
       FROM push_watch w
       JOIN push_subscription s ON s.sub_id = w.sub_id`,
  );
  if (!watches.length) return;
  console.log(
    `[push] ellenőrzés: ${watches.length} figyelés, ${new Set(watches.map((w) => w.stop_id)).size} megálló`,
  );

  const byStop = new Map<string, WatchRow[]>();
  for (const w of watches) {
    const list = byStop.get(w.stop_id) ?? [];
    list.push(w);
    byStop.set(w.stop_id, list);
  }

  for (const [stopId, stopWatches] of byStop) {
    let arrivals: MinimalArrival[];
    try {
      arrivals = (await arrivalsForStop(stopId, 8)).arrivals;
    } catch {
      continue;
    }

    for (const w of stopWatches) {
      const routeFilter = w.route_shorts ? w.route_shorts.split(",") : null;
      const matches = arrivals.filter(
        (a) =>
          (!routeFilter || routeFilter.includes(a.route)) &&
          a.etaMin >= 0 &&
          a.etaMin <= w.threshold_min,
      );
      if (!matches.length) continue;

      const already = new Set((w.last_notified ?? "").split(",").filter(Boolean));
      const fresh = matches.filter((a) => !already.has(a.tripId));

      if (fresh.length) {
        const routes = [...new Set(fresh.map((a) => a.route))];
        const minEta = Math.max(0, Math.round(Math.min(...fresh.map((a) => a.etaMin))));
        const title =
          routes.length > 1
            ? `${routes.map(withHungarianSuffix).join(", ")} buszok`
            : `${withHungarianSuffix(routes[0])} busz`;
        const body = `${w.stop_name} (${w.stop_id}) — kb. ${minEta} percen belül`;

        const result = await sendPush(
          { endpoint: w.endpoint, keys: { p256dh: w.p256dh, auth: w.auth } },
          { title, body, tag: `mvk-stop-${w.stop_id}` },
        );
        if (result === "gone") {
          await query(`DELETE FROM push_subscription WHERE sub_id = ?`, [w.sub_id]);
          continue;
        }
      }

      await query(`UPDATE push_watch SET last_notified = ? WHERE watch_id = ?`, [
        matches.map((a) => a.tripId).join(","),
        w.watch_id,
      ]);
    }
  }
}

/**
 * Induláskor egyszer lefutó önteszt — pontosan azért, hogy a log alapján
 * egyértelmű legyen, hol akad el a lánc, anélkül hogy valós buszra kellene
 * várni. Ha ez a blokk nem "MINDEN RENDBEN"-nel zár, onnantól tudjuk, melyik
 * lépésnél van a hiba (VAPID, DB-tábla, vagy egyszerűen nincs feliratkozás).
 */
async function selfTest(): Promise<void> {
  console.log("[push] ── önteszt ──");
  console.log(`[push] VAPID: ${pushConfigured ? "beállítva" : "HIÁNYZIK"}`);
  if (!pushConfigured) {
    console.log("[push] ── önteszt vége: PUSH NEM AKTÍV ──");
    return;
  }
  try {
    const subs = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM push_subscription`,
    );
    const watches = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM push_watch`,
    );
    console.log(
      `[push] adatbázis-táblák OK — ${subs[0]?.n ?? 0} feliratkozás, ${watches[0]?.n ?? 0} figyelés van jelenleg mentve`,
    );
    if (!subs[0]?.n) {
      console.log(
        "[push] MÉG SENKI NEM IRATKOZOTT FEL — ha az appban már beállítottál értesítést, az a regisztráció nem jutott el ide (nézd a böngésző konzolját a telefonon, vagy próbáld a 'Teszt küldése' gombot).",
      );
    }
    console.log("[push] ── önteszt vége: MINDEN RENDBEN ──");
  } catch (e) {
    console.log(
      `[push] ADATBÁZIS-HIBA az önteszt közben (hiányzik a push_subscription/push_watch tábla? futott a db:migrate?): ${(e as Error).message}`,
    );
    console.log("[push] ── önteszt vége: HIBA ──");
  }
}

export function startPushLoop(arrivalsForStop: ArrivalsForStop): void {
  selfTest().catch((e) => console.log("[push] önteszt hiba:", (e as Error).message));
  if (!pushConfigured) return; // a self-test már logolta, miért nem indul
  console.log(`[push] hurok elindult (${CHECK_INTERVAL_MS / 1000} mp-enként)`);
  setInterval(() => {
    checkOnce(arrivalsForStop).catch((e) =>
      console.log("[push] hiba az ellenőrzési körben:", (e as Error).message),
    );
  }, CHECK_INTERVAL_MS);
}
