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
 */
import webpush from "web-push";
import type { PgBoss } from "pg-boss";
import { arrivalsForStop, budapestOffsetSec, nowUnix, withHungarianSuffix, type ArrivalItem } from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import { config } from "./config.ts";
import type { Engine } from "./engine.ts";
import { errMsg, log } from "./log.ts";
import type { VehiclePredictor } from "./predict.ts";

export const pushConfigured = Boolean(config.vapid.publicKey && config.vapid.privateKey && config.vapid.subject);
if (pushConfigured) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

const QUEUE = "push-send";
const RECURRING_WINDOW_MIN = 4;
const SCAN_LIMIT = 40;
const STALE_AFTER_S = 180;

type WatchRow = {
  id: number;
  subscription_id: number;
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

export class PushEngine {
  private watches: WatchRow[] = [];
  private sent = new Set<string>();
  private engine: Engine;
  private predictor: VehiclePredictor;
  private boss: PgBoss;
  private evaluating = false;
  stats = { queued: 0, sent: 0, failed: 0, gone: 0, skipped: 0 };

  constructor(engine: Engine, predictor: VehiclePredictor, boss: PgBoss) {
    this.engine = engine;
    this.predictor = predictor;
    this.boss = boss;
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
    this.watches = await sql<WatchRow>(
      `SELECT w.id, w.subscription_id, w.stop_id, w.stop_name, w.threshold_min, w.route_shorts, w.trip_id, w.sched_min, w.is_departure,
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
    const cancelled = this.engine.cancelled.ids;
    const days = this.engine.feeds.arrivalDays(now);
    if (!days.length) return;

    const byStop = new Map<string, WatchRow[]>();
    for (const w of this.watches) {
      const list = byStop.get(w.stop_id);
      if (list) list.push(w);
      else byStop.set(w.stop_id, [w]);
    }

    for (const [stopId, list] of byStop) {
      const res = arrivalsForStop(stopId, SCAN_LIMIT, this.engine.snapshot, days, now, {
        measuredDelay: (t) => this.engine.matcher.liveDelay(t, now),
        predictedVehicle: (t) => this.predictor.predict(t),
        cancelled,
      });
      for (const w of list) {
        if (inDnd(w.dnd_start_min, w.dnd_end_min, nowMin)) continue;
        const routeFilter = w.route_shorts?.length ? w.route_shorts : null;
        const relevant = (a: ArrivalItem) => {
          if (w.sched_min != null) {
            if (routeFilter && !routeFilter.includes(a.route)) return false;
            const delayMin = Math.round((a.delaySec ?? 0) / 60);
            const schedMin = (((nowMin + a.etaMin - delayMin) % 1440) + 1440) % 1440;
            return minuteDistance(schedMin, w.sched_min) <= RECURRING_WINDOW_MIN;
          }
          if (w.trip_id) return a.tripId === w.trip_id;
          return !routeFilter || routeFilter.includes(a.route);
        };

        // Törölt menet: a konkrét menetre feliratkozottak azonnal értesítést kapnak.
        if (w.trip_id && cancelled.has(w.trip_id)) {
          await this.enqueue(w, date, w.trip_id, "cancelled", {
            title: "Menet kimaradt",
            body: `A ${w.stop_name} ${w.is_departure ? "megállóból induló" : "megállóba érkező"} járatot az MVK törölte — nem fog közlekedni.`,
          });
          continue;
        }

        const due = res.arrivals.filter((a) => relevant(a) && !a.cancelled && a.etaMin >= 0 && a.etaMin <= w.threshold_min);
        for (const a of due) {
          const veh = a.vehicle?.id ?? (a.predictedVehicle ? `~${a.predictedVehicle.id}` : null);
          const label = `${withHungarianSuffix(a.route)} busz${veh ? ` (${veh})` : ""}`;
          const delay = delaySuffix(a.measuredDelaySec ?? a.delaySec);
          const verb = w.is_departure ? "indul" : "ér ide";
          const body = a.etaMin <= 0 ? `most ${verb}${delay} — ${w.stop_name}` : `kb. ${a.etaMin} perc múlva ${verb}${delay} — ${w.stop_name}`;
          await this.enqueue(w, date, a.tripId, "arrival", { title: `${label} → ${a.headsign}`, body });
        }
      }
    }
  }

  private async enqueue(w: WatchRow, date: string, tripId: string, kind: "arrival" | "cancelled", msg: { title: string; body: string }) {
    const key = `${w.id}|${date}|${tripId}|${kind}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    const payload = { ...msg, tag: `mvk-${w.stop_id}-${tripId}`.slice(0, 60), url: `/?stop=${encodeURIComponent(w.stop_id)}#multistop` };
    const r = await sql<{ id: number }>(
      `INSERT INTO push_delivery (watch_id, service_date, trip_id, kind, status, payload) VALUES ($1, $2, $3, $4, 'queued', $5)
       ON CONFLICT (watch_id, service_date, trip_id, kind) DO NOTHING RETURNING id`,
      [w.id, date, tripId, kind, JSON.stringify(payload)],
    );
    if (!r[0]) return;
    this.stats.queued++;
    await this.boss.send(QUEUE, { deliveryId: r[0].id });
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
