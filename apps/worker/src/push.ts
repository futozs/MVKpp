/**
 * Push-értesítések v3.
 *
 * Mi volt rossz a régiben, és mit csinálunk helyette:
 *  - csak a 8 legközelebbi érkezést nézte → forgalmas megállónál a figyelt
 *    járat ki sem került a listába. Most 40-et nézünk.
 *  - egy eszköz egy megállóra egy figyelést tárolhatott → most tetszőlegeset.
 *  - nem volt TTL → a webpush alap 4 hetes élettartama miatt órákkal később
 *    is megérkezhetett. Most 5 perc + sürgős prioritás.
 *  - hibánál nem próbálta újra, mégis „elküldöttnek” jelölte → most
 *    kézbesítési napló (push_delivery) és pg-boss újrapróbálás.
 *  - ugyanarra a menetre többször is szólhatott, ha az ETA ki-be ugrált a
 *    küszöbön → most menetenként pontosan egyszer (egyedi kulcs a naplóban).
 *
 * Fajták (push_watch.kind): „érkezik a busz” (és ha a busza még az előző menetén
 * késik, előre szól), „indulj most” a sétaidővel, dugó a megálló felé tartó busz
 * előtt, és veszélybe került átszállás a következő lehetőséggel.
 */
import webpush from "web-push";
import type { PgBoss } from "pg-boss";
import { budapestOffsetSec, catchVerdict, dayKindOf, isoDow, nowUnix, withHungarianSuffix, type ArrivalItem } from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import { config } from "./config.ts";
import type { Engine } from "./engine.ts";
import type { TripInsights } from "./insights.ts";
import { errMsg, log } from "./log.ts";

export const pushConfigured = Boolean(config.vapid.publicKey && config.vapid.privateKey && config.vapid.subject);
if (pushConfigured) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

const QUEUE = "push-send";
const RECURRING_WINDOW_MIN = 4;
const SCAN_LIMIT = 40;
const STALE_AFTER_S = 180;
/** „dugó a busz előtt”: ennyi többletidőtől szólunk (mp)… */
const TRAFFIC_ALERT_S = 150;
/** …és csak az ennyi percen belül érkező buszokért */
const TRAFFIC_HORIZON_MIN = 30;
/** késve induló menet: ennyi várható késéstől szólunk a menetre feliratkozottnak (mp) */
const RISK_ALERT_S = 180;
/** átszállás: ennél kisebb esélynél szólunk */
const TRANSFER_ALERT_CHANCE = 0.4;
/** egyszeri („erre a menetre”) indulás-figyelés ennyi idő után lejár */
/** egyszeri figyelés legfeljebb ennyi óráig él: este a reggeli első buszra is jó, de másnap ugyanarra a menetazonosítóra már ne szóljon */
const ONE_SHOT_TTL_H = 20;

export type WatchKind = "arrival" | "leave" | "traffic" | "transfer";
type DeliveryKind = "arrival" | "cancelled" | "leave" | "missed" | "risk" | "traffic" | "transfer";

type WatchParams = {
  /** arrival (egyszeri menet-figyelés): a szolgáltatási nap, amelyre szól */
  date?: string;
  /** leave: séta a megállóig (mp) */
  walkS?: number;
  /** leave (ismétlődő): melyik napokon — munkanap, hétvége, mind, vagy a hét napjai (ISO 1–7) */
  days?: "workday" | "weekend" | "all" | number[];
  /** transfer: az első menet, az átszálló megálló és a séta */
  fromTrip?: string;
  alightStopId?: string;
  fromRoute?: string;
  toRoute?: string;
  boardStopName?: string;
};

type WatchRow = {
  id: number;
  subscription_id: number;
  kind: WatchKind;
  params: WatchParams | null;
  stop_id: string;
  stop_name: string;
  threshold_min: number;
  route_shorts: string[] | null;
  trip_id: string | null;
  sched_min: number | null;
  is_departure: boolean;
  dnd_start_min: number | null;
  dnd_end_min: number | null;
};

function inDnd(start: number | null, end: number | null, nowMin: number) {
  if (start == null || end == null || start === end) return false;
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

const minuteDistance = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
};

function delaySuffix(delaySec: number | null): string {
  if (delaySec == null || Math.abs(delaySec) < 60) return "";
  const m = Math.round(Math.abs(delaySec) / 60);
  return delaySec > 0 ? ` (${m} perc késés)` : ` (${m} perccel korábban)`;
}

/** Ismétlődő figyelés: ma esedékes-e (pl. csak szerdán és csütörtökön; ünnepnapon a munkanapi szokás nem). */
function isWatchDay(days: WatchParams["days"], date: string): boolean {
  if (!days || days === "all") return true;
  if (!Array.isArray(days)) return dayKindOf(date) === days;
  const workdayHabit = days.every((d) => d <= 5);
  return days.includes(isoDow(date)) && !(workdayHabit && dayKindOf(date) !== "workday");
}

const minText = (s: number) => `${Math.max(1, Math.round(s / 60))} perc`;
const busLabel = (a: ArrivalItem) => {
  const p = a.predictedVehicle;
  const veh = a.vehicle?.id ?? (p ? (p.method === "loop" ? p.id : `~${p.id}`) : null);
  return `${withHungarianSuffix(a.route)} busz${veh ? ` (${veh})` : ""}`;
};
/** A busz várható érkezése a megállóba (unix) és a 85%-os felső becslés. */
function expectedAt(a: ArrivalItem, now: number): { at: number; upper: number | null } {
  if (a.schedUnix != null && a.forecastDelaySec != null) return { at: a.schedUnix + a.forecastDelaySec, upper: a.forecastUpperSec != null ? a.schedUnix + a.forecastUpperSec : null };
  // a kiinduló megállónál a késve indulás jóslata
  if (a.schedUnix != null && a.startRisk) return { at: a.schedUnix + a.startRisk.expectedDelayS, upper: null };
  return { at: now + a.etaMin * 60, upper: null };
}

export class PushEngine {
  private watches: WatchRow[] = [];
  private sent = new Set<string>();
  private engine: Engine;
  private insights: TripInsights;
  private boss: PgBoss;
  private evaluating = false;
  stats = { queued: 0, sent: 0, failed: 0, gone: 0, skipped: 0 };

  constructor(engine: Engine, boss: PgBoss, insights: TripInsights) {
    this.engine = engine;
    this.boss = boss;
    this.insights = insights;
  }

  async start(): Promise<void> {
    if (!pushConfigured) {
      log.warn("push", "VAPID kulcsok nincsenek beállítva — a push kikapcsolva");
      return;
    }
    await this.boss.createQueue(QUEUE, { retryLimit: 3, retryDelay: 4, retryBackoff: true, expireInSeconds: 60 });
    await this.boss.work<{ deliveryId: number }>(QUEUE, { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) await this.deliver(job.data.deliveryId, job.retryCount >= 2);
    });
    await this.reload();
    const today = await sql<{ k: string }>(
      `SELECT watch_id || '|' || service_date::text || '|' || trip_id || '|' || kind AS k FROM push_delivery WHERE service_date >= CURRENT_DATE - 1`,
    );
    for (const r of today) this.sent.add(r.k);
    setInterval(() => this.reload().catch(() => {}), 60_000).unref();
    this.engine.on("tick", () => {
      if (this.evaluating) return;
      this.evaluating = true;
      this.evaluate()
        .catch((e) => log.warn("push", "kiértékelés hiba", errMsg(e)))
        .finally(() => (this.evaluating = false));
    });
    log.info("push", `aktív — ${this.watches.length} figyelés`);
  }

  async reload(): Promise<void> {
    // A lejárt egyszeri figyelések takarítása: „indulj most”, átszállás, és az egy napra szóló menet-figyelés
    // (dátummal: a nap után; régi, dátum nélküli sor: az élettartam után).
    await getPool().query(
      `DELETE FROM push_watch WHERE sched_min IS NULL AND (
         (kind IN ('leave', 'transfer') AND updated_at < now() - make_interval(hours => $1))
         OR (kind = 'arrival' AND trip_id IS NOT NULL AND (params->>'date' < $2 OR (params->>'date' IS NULL AND updated_at < now() - make_interval(hours => $1))))
       )`,
      [ONE_SHOT_TTL_H, this.engine.today],
    );
    this.watches = await sql<WatchRow>(
      `SELECT w.id, w.subscription_id, w.kind, w.params, w.stop_id, w.stop_name, w.threshold_min, w.route_shorts, w.trip_id, w.sched_min, w.is_departure,
              s.dnd_start_min, s.dnd_end_min
         FROM push_watch w JOIN push_subscription s ON s.id = w.subscription_id
        WHERE s.enabled`,
    );
  }

  private async evaluate(): Promise<void> {
    if (!this.watches.length) return;
    const now = nowUnix();
    const nowMin = Math.floor((((now + budapestOffsetSec(now)) % 86400) + 86400) % 86400 / 60);
    const date = this.engine.today;
    if (!this.engine.feeds.arrivalDays(now).length) return;

    const byStop = new Map<string, WatchRow[]>();
    for (const w of this.watches) {
      const list = byStop.get(w.stop_id);
      if (list) list.push(w);
      else byStop.set(w.stop_id, [w]);
    }

    for (const [stopId, list] of byStop) {
      const arrivals = this.insights.arrivals(stopId, SCAN_LIMIT, now).arrivals;
      for (const w of list) {
        if (inDnd(w.dnd_start_min, w.dnd_end_min, nowMin)) continue;
        if (w.kind === "leave") await this.evalLeave(w, arrivals, now, nowMin, date);
        else if (w.kind === "traffic") await this.evalTraffic(w, arrivals, date);
        else if (w.kind === "transfer") await this.evalTransfer(w, now, date);
        else await this.evalArrival(w, arrivals, nowMin, date);
      }
    }
  }

  /** Ehhez a figyeléshez tartozó indulások (menet, ismétlődő óra:perc, vonalszűrő). */
  private relevant(w: WatchRow, arrivals: ArrivalItem[], nowMin: number): ArrivalItem[] {
    const routeFilter = w.route_shorts?.length ? w.route_shorts : null;
    return arrivals.filter((a) => {
      if (w.sched_min != null) {
        if (routeFilter && !routeFilter.includes(a.route)) return false;
        const delayMin = Math.round((a.delaySec ?? 0) / 60);
        const schedMin = (((nowMin + a.etaMin - delayMin) % 1440) + 1440) % 1440;
        return minuteDistance(schedMin, w.sched_min) <= RECURRING_WINDOW_MIN;
      }
      if (w.trip_id) return a.tripId === w.trip_id;
      return !routeFilter || routeFilter.includes(a.route);
    });
  }

  private async evalArrival(w: WatchRow, arrivals: ArrivalItem[], nowMin: number, date: string) {
    // Egy napra szóló menet-figyelés: más napon ugyanez a menetazonosító nem ez a menet.
    if (w.trip_id && w.sched_min == null && w.params?.date && w.params.date !== date) return;
    // Törölt menet: a konkrét menetre feliratkozottak azonnal értesítést kapnak.
    if (w.trip_id && this.engine.cancelled.ids.has(w.trip_id)) {
      await this.enqueue(w, date, w.trip_id, "cancelled", {
        title: "Menet kimaradt",
        body: `A ${w.stop_name} ${w.is_departure ? "megállóból induló" : "megállóba érkező"} járatot az MVK törölte — nem fog közlekedni.`,
      });
      return;
    }
    const mine = this.relevant(w, arrivals, nowMin);
    // A figyelt menet busza még az előző menetén késik: előre szólunk, mielőtt az MVK kihúzná.
    for (const a of mine) {
      const r = a.startRisk;
      if (!w.trip_id || !r || r.expectedDelayS < RISK_ALERT_S || a.cancelled) continue;
      await this.enqueue(w, date, a.tripId, "risk", {
        title: r.level === "likely-missed" ? `${busLabel(a)}: valószínűleg kimarad` : `${busLabel(a)}: később indul`,
        body: `A ${a.time}-s menet busza (${r.vehicleId}) még ${r.prevRoute ? `a ${withHungarianSuffix(r.prevRoute)} vonalon` : "az előző menetén"} jár — várhatóan kb. ${minText(r.expectedDelayS)} késéssel ${w.is_departure ? "indul" : "ér ide"} (${w.stop_name}).`,
      });
    }
    const due = mine.filter((a) => !a.cancelled && a.etaMin >= 0 && a.etaMin <= w.threshold_min);
    for (const a of due) {
      const delay = delaySuffix(a.measuredDelaySec ?? a.delaySec);
      const verb = w.is_departure ? "indul" : "ér ide";
      const body = a.etaMin <= 0 ? `most ${verb}${delay} — ${w.stop_name}` : `kb. ${a.etaMin} perc múlva ${verb}${delay} — ${w.stop_name}`;
      await this.enqueue(w, date, a.tripId, "arrival", { title: `${busLabel(a)} → ${a.headsign}`, body });
    }
  }

  /** „Indulj most”: amikor el kell indulni, hogy biztosan elérd (a sétával együtt). */
  private async evalLeave(w: WatchRow, arrivals: ArrivalItem[], now: number, nowMin: number, date: string) {
    const walkS = Math.max(0, Math.min(3600, Number(w.params?.walkS) || 0));
    if (w.sched_min != null && !isWatchDay(w.params?.days, date)) return;
    for (const a of this.relevant(w, arrivals, nowMin)) {
      const { at, upper } = expectedAt(a, now);
      // csak a közeli indulásokra (egy óránál messzebbre nincs mit mondani)
      if (at - now > 3600) continue;
      if (a.cancelled) {
        // a szokásos / kért buszt kihúzták: ezt is megírjuk, a helyette jövővel
        const next = this.insights.nextDeparture(w.stop_id, a.route, now + walkS, now);
        await this.enqueue(w, date, a.tripId, "cancelled", {
          title: `${busLabel(a)} kimarad`,
          body: `Az MVK kihúzta a ${a.time}-s menetet (${w.stop_name}).${next ? ` A következő ${withHungarianSuffix(a.route)}: ${next.time}.` : ""}`,
        });
        continue;
      }
      const v = catchVerdict({ nowUnix: now, expectedUnix: at, upperUnix: upper, walkS });
      if (v.state === "relax") continue;
      const eta = minText(at - now);
      if (v.state === "missed") {
        // Az „Indulj most” után a felhasználó már úton van: a „nem éred el” akkor téves lenne
        // (a verdikt mindig a mostani indulást feltételezi).
        if (this.sent.has(`${w.id}|${date}|${a.tripId}|leave`)) continue;
        const next = this.insights.nextDeparture(w.stop_id, a.route, now + walkS, now);
        await this.enqueue(w, date, a.tripId, "missed", {
          title: `${busLabel(a)}: ezt már nem éred el`,
          body: `${eta} múlva ér a ${w.stop_name} megállóba, a séta ${minText(walkS)}.${next ? ` A következő ${withHungarianSuffix(a.route)}: ${next.time}.` : ""}`,
        });
        continue;
      }
      await this.enqueue(w, date, a.tripId, "leave", {
        title: v.state === "run" ? `Siess! ${busLabel(a)} ${eta} múlva` : `Indulj most: ${busLabel(a)} ${eta} múlva`,
        body: `${w.stop_name} — ${minText(walkS)} séta${v.state === "run" ? ", csak futva éred el" : ""}${delaySuffix(a.measuredDelaySec ?? a.delaySec)}.`,
      });
    }
  }

  /** Dugó a figyelt megálló felé tartó busz előtt. */
  private async evalTraffic(w: WatchRow, arrivals: ArrivalItem[], date: string) {
    const routeFilter = w.route_shorts?.length ? w.route_shorts : null;
    for (const a of arrivals) {
      const t = a.trafficAhead;
      if (!t || t.excessS < TRAFFIC_ALERT_S || a.cancelled || a.etaMin > TRAFFIC_HORIZON_MIN) continue;
      if (routeFilter && !routeFilter.includes(a.route)) continue;
      await this.enqueue(w, date, a.tripId, "traffic", {
        title: `Dugó: ${busLabel(a)} kb. +${minText(t.excessS)}`,
        body: `${t.fromName} → ${t.toName} között beállt a forgalom — kb. ${a.etaMin} perc múlva ér a ${w.stop_name} megállóba.`,
      });
    }
  }

  /** Átszállás: ha az esély elszáll, szólunk — a következő lehetőséggel. */
  private async evalTransfer(w: WatchRow, now: number, date: string) {
    const p = w.params ?? {};
    if (!w.trip_id || !p.fromTrip || !p.alightStopId) return;
    const walkS = Math.max(0, Math.min(1800, Number(p.walkS) || 0));
    const o = this.insights.transferOutlook({ fromTrip: p.fromTrip, alightStopId: p.alightStopId, toTrip: w.trip_id, boardStopId: w.stop_id, walkS }, now);
    // a második busz már elment, vagy még messze vagyunk tőle
    if (!o || o.departUnix < now - 60 || o.departUnix - now > 3600) return;
    if (this.engine.cancelled.ids.has(w.trip_id)) {
      await this.enqueue(w, date, w.trip_id, "cancelled", {
        title: "Az átszállás járata kimaradt",
        body: `A ${p.toRoute ? withHungarianSuffix(p.toRoute) + " " : ""}járatot a ${w.stop_name} megállóban az MVK törölte.`,
      });
      return;
    }
    if (o.chance >= TRANSFER_ALERT_CHANCE) return;
    const next = p.toRoute ? this.insights.nextDeparture(w.stop_id, p.toRoute, o.arriveUnix + walkS, now) : null;
    const pct = Math.round(o.chance * 100);
    await this.enqueue(w, date, w.trip_id, "transfer", {
      title: `Veszélyben az átszállás (${pct}% esély)`,
      body: `A ${p.fromRoute ? withHungarianSuffix(p.fromRoute) + " " : ""}busz várhatóan ${o.marginS < 0 ? `${minText(-o.marginS)} késéssel` : "épp csak"} ér ide a ${p.toRoute ? withHungarianSuffix(p.toRoute) : "csatlakozás"} indulásához — ${w.stop_name}.${next ? ` Ha lekésed: ${next.time}.` : ""}`,
    });
  }

  private async enqueue(w: WatchRow, date: string, tripId: string, kind: DeliveryKind, msg: { title: string; body: string }) {
    const key = `${w.id}|${date}|${tripId}|${kind}`;
    if (this.sent.has(key)) return;
    // Előre jelöljük (a következő kör ne küldje kétszer), de hiba esetén visszavesszük,
    // hogy egy átmeneti adatbázis- vagy sorhiba ne némítsa el végleg ezt az értesítést.
    this.sent.add(key);
    try {
      const payload = { ...msg, tag: `mvk-${w.stop_id}-${tripId}-${kind}`.slice(0, 60), url: `/?stop=${encodeURIComponent(w.stop_id)}#multistop` };
      const r = await sql<{ id: number }>(
        `INSERT INTO push_delivery (watch_id, service_date, trip_id, kind, status, payload) VALUES ($1, $2, $3, $4, 'queued', $5)
         ON CONFLICT (watch_id, service_date, trip_id, kind) DO NOTHING RETURNING id`,
        [w.id, date, tripId, kind, JSON.stringify(payload)],
      );
      if (!r[0]) return;
      this.stats.queued++;
      try {
        await this.boss.send(QUEUE, { deliveryId: r[0].id });
      } catch (e) {
        // a sorba nem került: a sort is töröljük, különben a következő kör ütközne rajta, és sosem menne ki
        await getPool().query(`DELETE FROM push_delivery WHERE id = $1`, [r[0].id]).catch(() => {});
        throw e;
      }
    } catch (e) {
      this.sent.delete(key);
      throw e;
    }
  }

  private async deliver(deliveryId: number, lastAttempt: boolean): Promise<void> {
    const rows = await sql<{
      status: string;
      payload: { title: string; body: string; tag: string; url: string };
      created_at: Date;
      sub_id: number;
      endpoint: string;
      p256dh: string;
      auth: string;
    }>(
      `SELECT d.status, d.payload, d.created_at, s.id AS sub_id, s.endpoint, s.p256dh, s.auth
         FROM push_delivery d JOIN push_watch w ON w.id = d.watch_id JOIN push_subscription s ON s.id = w.subscription_id
        WHERE d.id = $1`,
      [deliveryId],
    );
    const d = rows[0];
    if (!d || d.status === "sent") return;
    if (Date.now() - d.created_at.getTime() > STALE_AFTER_S * 1000) {
      await getPool().query(`UPDATE push_delivery SET status = 'skipped', last_error = 'elavult (túl késő lett volna)' WHERE id = $1`, [deliveryId]);
      this.stats.skipped++;
      return;
    }
    try {
      await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(d.payload), {
        TTL: 300,
        urgency: "high",
        topic: d.payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
      });
      await getPool().query(`UPDATE push_delivery SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [deliveryId]);
      await getPool().query(`UPDATE push_subscription SET last_success_at = now(), fail_count = 0 WHERE id = $1`, [d.sub_id]);
      this.stats.sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await getPool().query(`UPDATE push_delivery SET status = 'gone', attempts = attempts + 1, last_error = $2 WHERE id = $1`, [deliveryId, `HTTP ${status}`]);
        await getPool().query(`DELETE FROM push_subscription WHERE id = $1`, [d.sub_id]);
        this.stats.gone++;
        await this.reload();
        return;
      }
      await getPool().query(
        `UPDATE push_delivery SET status = $3, attempts = attempts + 1, last_error = $2 WHERE id = $1`,
        [deliveryId, `${status ?? ""} ${errMsg(e)}`.trim().slice(0, 300), lastAttempt ? "failed" : "queued"],
      );
      await getPool().query(`UPDATE push_subscription SET fail_count = fail_count + 1 WHERE id = $1`, [d.sub_id]);
      if (lastAttempt) {
        this.stats.failed++;
        return;
      }
      throw e; // pg-boss újrapróbálja
    }
  }
}
