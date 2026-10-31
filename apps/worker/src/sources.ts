/**
 * Az MVK-adat forrása: az MVK API a fő forrás, a MÁV+ OTP2 csak a tartaléka.
 *
 * Átállás a tartalékra (a felhasználó döntése szerint):
 *  - azonnal, ha az MVK elutasítja a tokent (401/403), vagy nincs érvényes token
 *    (ilyenkor az MVK úgysem válaszolna);
 *  - ha az MVK szervere `outageMs` (60 mp) óta egyfolytában nem válaszol, 5xx-et
 *    vagy értelmezhetetlen választ ad.
 * Vissza az MVK-ra: `recoverPolls` (5) egymás utáni sikeres MVK-poll után.
 * Tartalék üzemben az MVK-t ritkábban (10 mp-enként) próbáljuk, hogy észrevegyük,
 * ha visszajött.
 */
import { config } from "./config.ts";
import { log } from "./log.ts";

export type MvkSource = "mvk" | "otp2";
export type MvkPollResult = { ok: true } | { ok: false; status: number | null; reason: string };

/** tartalék üzemben ennyi időnként próbáljuk újra az MVK-t (ms) */
const PROBE_MS = 10_000;

export class SourceManager {
  state: MvkSource = "mvk";
  since = Date.now();
  reason: string | null = null;
  private okStreak = 0;
  private failingSince = 0;
  private lastProbe = 0;
  /** a mai napon tartalékban töltött idő (mp) — a source_health-be */
  fallbackMsToday = 0;
  private fallbackFrom = 0;
  switches: { at: string; to: MvkSource; reason: string }[] = [];
  /** van-e hova átállni (OTP2_ENABLED=0 esetén nincs: marad az MVK, a régi adat 60 mp-ig él) */
  canFallback = true;

  /** Kérdezzük-e most az MVK-t (tartalékban csak ritkán, és csak érvényes tokennel). */
  shouldPollMvk(tokenUsable: boolean, now = Date.now()): boolean {
    if (!tokenUsable) return false;
    if (this.state === "mvk") return true;
    if (now - this.lastProbe < PROBE_MS) return false;
    this.lastProbe = now;
    return true;
  }

  /** Nincs érvényes token: nincs mit kérdezni, azonnal tartalék. */
  tokenUnusable(reason: string) {
    this.okStreak = 0;
    this.toFallback(reason);
  }

  onMvk(r: MvkPollResult, now = Date.now()) {
    if (r.ok) {
      this.failingSince = 0;
      this.okStreak++;
      if (this.state === "otp2" && this.okStreak >= config.fallback.recoverPolls) this.toMvk();
      return;
    }
    this.okStreak = 0;
    if (r.status === 401 || r.status === 403) {
      this.toFallback(`az MVK elutasította a tokent (HTTP ${r.status})`);
      return;
    }
    if (!this.failingSince) this.failingSince = now;
    if (now - this.failingSince >= config.fallback.outageMs) this.toFallback(`az MVK ${Math.round((now - this.failingSince) / 1000)} mp óta nem ad adatot (${r.reason})`);
  }

  private toFallback(reason: string) {
    if (!this.canFallback) {
      this.reason = reason;
      return;
    }
    if (this.state === "otp2") {
      this.reason = reason;
      return;
    }
    this.state = "otp2";
    this.since = Date.now();
    this.fallbackFrom = Date.now();
    this.reason = reason;
    this.switches = [{ at: new Date().toISOString(), to: "otp2" as const, reason }, ...this.switches].slice(0, 30);
    log.warn("source", `ÁTÁLLÁS a MÁV+ tartalékra: ${reason}`);
  }

  private toMvk() {
    if (this.fallbackFrom) this.fallbackMsToday += Date.now() - this.fallbackFrom;
    this.fallbackFrom = 0;
    this.state = "mvk";
    this.since = Date.now();
    const reason = `${config.fallback.recoverPolls} sikeres MVK-poll`;
    this.reason = null;
    this.switches = [{ at: new Date().toISOString(), to: "mvk" as const, reason }, ...this.switches].slice(0, 30);
    log.info("source", `vissza az MVK-ra (${reason})`);
  }

  /** a mai napon eddig tartalékban töltött idő (mp) */
  fallbackSecToday(): number {
    return Math.round((this.fallbackMsToday + (this.fallbackFrom ? Date.now() - this.fallbackFrom : 0)) / 1000);
  }

  /** Napközbeni újraindítás: a mai, már elmentett tartalék-idő folytatódik. */
  restoreToday(sec: number) {
    if (sec > 0) this.fallbackMsToday += sec * 1000;
  }

  rollDay() {
    this.fallbackMsToday = 0;
    if (this.fallbackFrom) this.fallbackFrom = Date.now();
  }

  status() {
    return { state: this.state, since: new Date(this.since).toISOString(), reason: this.reason, fallbackSecToday: this.fallbackSecToday(), switches: this.switches.slice(0, 10) };
  }
}
