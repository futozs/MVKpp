import { query } from "../db/pool.ts";
import { pushConfigured, sendPush } from "./push.ts";
import { withHungarianSuffix } from "./huSuffix.ts";

const CHECK_INTERVAL_MS = Number(process.env.PUSH_CHECK_INTERVAL_MS ?? 3_000);
/** Ennél nagyobb eltérésnél már érdemes külön megemlíteni a késést/sietést. */
const DELAY_MENTION_THRESHOLD_S = 60;
/** Ismétlődő figyelésnél ennyi perc eltérést engedünk a célzott óra:perctől. */
const RECURRING_WINDOW_MIN = 4;

type MinimalArrival = {
  route: string;
  etaMin: number;
  tripId: string;
  vehicle: { id: string } | null;
  delaySec: number | null;
};
type ArrivalsForStop = (
  stopId: string,
  limit: number,
) => Promise<{ arrivals: MinimalArrival[] }>;
type CancelledTripIds = () => Promise<string[]>;
type NowSecOfDay = () => number;

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
  trip_id: string | null;
  is_departure: number;
  sched_min: number | null;
  last_notified: string | null;
};

function delaySuffix(delaySec: number | null): string {
  if (delaySec == null || Math.abs(delaySec) < DELAY_MENTION_THRESHOLD_S) return "";
  const min = Math.round(Math.abs(delaySec) / 60);
  return delaySec > 0 ? ` (${min} perc késés)` : ` (${min} perccel korábban)`;
}

/** Kör alakú (0-1439) percek közti legkisebb távolság — az éjfél átlépését is helyesen kezeli. */
function minuteDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
}

/**
 * A menetrend fülről beállított figyeléseknél (van trip_id) ellenőrizzük,
 * nem húzta-e ki az MVK az adott menetet — ha igen, ezt magát is érdemes
 * jelezni, különben a felhasználó feleslegesen várna egy sosem érkező buszra.
 * Ismétlődő (sched_min) figyeléseknél ez nem alkalmazható (nincs egyetlen
 * fix tripId) — azoknál a lenti fő szűrés dobja csendben a kihúzott menetet.
 */
async function checkCancelledWatches(
  stopWatches: WatchRow[],
  cancelled: Set<string>,
): Promise<Set<number>> {
  const handled = new Set<number>();
  for (const w of stopWatches) {
    if (!w.trip_id || !cancelled.has(w.trip_id)) continue;
    const already = new Set((w.last_notified ?? "").split(",").filter(Boolean));
    if (already.has(`CANCELLED:${w.trip_id}`)) {
      handled.add(w.watch_id);
      continue;
    }
    const title = "Menet kimaradt";
    const body = `A ${w.stop_name} (${w.stop_id}) ${w.is_departure ? "-ról induló" : "-hoz érkező"} járatot az MVK törölte — nem fog megérkezni.`;
    const result = await sendPush(
      { endpoint: w.endpoint, keys: { p256dh: w.p256dh, auth: w.auth } },
      { title, body, tag: `mvk-stop-${w.stop_id}` },
    );
    if (result === "gone") {
      await query(`DELETE FROM push_subscription WHERE sub_id = ?`, [w.sub_id]);
    } else {
      await query(`UPDATE push_watch SET last_notified = ? WHERE watch_id = ?`, [
        `CANCELLED:${w.trip_id}`,
        w.watch_id,
      ]);
    }
    handled.add(w.watch_id);
  }
  return handled;
}

/**
 * Egyetlen ellenőrző kör: minden bejegyzett push-figyelést összevet a friss
 * érkezésekkel, és ha van új (még nem riasztott) találat, push-t küld. Zárt
 * telefonon/bezárt lapnál is működik, mert a böngésző push-szolgáltatása
 * ébreszti fel a service workert — ez a lényegi különbség a helyi (nyitott
 * lapos) Notification API-hoz képest.
 */
async function checkOnce(
  arrivalsForStop: ArrivalsForStop,
  cancelledTripIds: CancelledTripIds,
  nowSecOfDay: NowSecOfDay,
): Promise<void> {
  const watches = await query<WatchRow>(
    `SELECT w.watch_id, w.sub_id, s.endpoint, s.p256dh, s.auth,
            w.stop_id, w.stop_name, w.threshold_min, w.route_shorts, w.trip_id,
            w.is_departure, w.sched_min, w.last_notified
       FROM push_watch w
       JOIN push_subscription s ON s.sub_id = w.sub_id`,
  );
  if (!watches.length) return;

  const byStop = new Map<string, WatchRow[]>();
  for (const w of watches) {
    const list = byStop.get(w.stop_id) ?? [];
    list.push(w);
    byStop.set(w.stop_id, list);
  }

  let cancelled: Set<string>;
  try {
    cancelled = new Set(await cancelledTripIds());
  } catch {
    cancelled = new Set();
  }
  const nowMin = Math.floor(nowSecOfDay() / 60);

  for (const [stopId, stopWatches] of byStop) {
    const cancelledHandled = await checkCancelledWatches(stopWatches, cancelled);

    let arrivals: MinimalArrival[];
    try {
      arrivals = (await arrivalsForStop(stopId, 8)).arrivals;
    } catch {
      continue;
    }
    // A törölt meneteket a fő szűrésből is kizárjuk — ismétlődő figyelésnél
    // (nincs egyetlen fix tripId) ez az egyetlen módja, hogy ne riasszunk
    // egy adott napon kihúzott menetre.
    arrivals = arrivals.filter((a) => !cancelled.has(a.tripId));

    for (const w of stopWatches) {
      if (cancelledHandled.has(w.watch_id)) continue;

      // Három szűrési mód, egymást kizárva:
      //  1) sched_min megadva: "ismétlődő" — route + menetrendi óra:perc
      //     közelség alapján, mert a GTFS naponta más tripId-t ad ugyanarra
      //     a mintára.
      //  2) trip_id megadva: pontosan EZ az egy menet (menetrend fülről,
      //     egyszeri kiválasztás).
      //  3) egyik sem: a megállófigyelős, route_shorts alapú szűrés.
      const routeFilter = w.route_shorts ? w.route_shorts.split(",") : null;
      const matches = arrivals.filter((a) => {
        if (w.sched_min != null) {
          if (routeFilter && !routeFilter.includes(a.route)) return false;
          const delayMin = Math.round((a.delaySec ?? 0) / 60);
          const schedMin = ((nowMin + a.etaMin - delayMin) % 1440 + 1440) % 1440;
          if (minuteDistance(schedMin, w.sched_min) > RECURRING_WINDOW_MIN) return false;
        } else if (w.trip_id) {
          if (a.tripId !== w.trip_id) return false;
        } else if (routeFilter && !routeFilter.includes(a.route)) {
          return false;
        }
        return a.etaMin >= 0 && a.etaMin <= w.threshold_min;
      });
      if (!matches.length) continue;

      const already = new Set((w.last_notified ?? "").split(",").filter(Boolean));
      const fresh = matches.filter((a) => !already.has(a.tripId));

      if (fresh.length) {
        const minEta = Math.max(0, Math.round(Math.min(...fresh.map((a) => a.etaMin))));
        const label = (a: MinimalArrival) =>
          a.vehicle?.id
            ? `${withHungarianSuffix(a.route)} busz (${a.vehicle.id})`
            : `${withHungarianSuffix(a.route)} busz`;
        const title = fresh.length > 1 ? fresh.map(label).join(", ") : label(fresh[0]);
        const delayNote = fresh.length === 1 ? delaySuffix(fresh[0].delaySec) : "";
        // Menetrend-alapú (pontos vagy ismétlődő) figyelésnél a kiindulási
        // megállónál "indul", egy útközbeni megállónál "ér ide" a helyes ige.
        const isSchedulePinned = w.trip_id != null || w.sched_min != null;
        const body = isSchedulePinned
          ? `kb. ${minEta} percen belül ${w.is_departure ? "indul" : "ér ide"}${delayNote} — ${w.stop_name} (${w.stop_id})`
          : `${w.stop_name} (${w.stop_id}) — kb. ${minEta} percen belül${delayNote}`;

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
        "[push] MÉG SENKI NEM IRATKOZOTT FEL — ha az appban már beállítottál értesítést, az a regisztráció nem jutott el ide (nézd a böngésző konzolját a telefonon).",
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

export function startPushLoop(
  arrivalsForStop: ArrivalsForStop,
  cancelledTripIds: CancelledTripIds,
  nowSecOfDay: NowSecOfDay,
): void {
  selfTest().catch((e) => console.log("[push] önteszt hiba:", (e as Error).message));
  if (!pushConfigured) return; // a self-test már logolta, miért nem indul
  console.log(`[push] hurok elindult (${CHECK_INTERVAL_MS / 1000} mp-enként)`);
  setInterval(() => {
    checkOnce(arrivalsForStop, cancelledTripIds, nowSecOfDay).catch((e) =>
      console.log("[push] hiba az ellenőrzési körben:", (e as Error).message),
    );
  }, CHECK_INTERVAL_MS);
}
