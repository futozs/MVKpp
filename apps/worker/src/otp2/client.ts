/**
 * MÁV+ OTP2 GraphQL-kliens (token nélküli, lásd docs/MAVPLUSZ_OTP2.md).
 *
 * - A szervernek dokumentálatlan, hosztonkénti korlátja van: a szorosan egymás
 *   után jövő kéréseket `403 host limit achived` (sima szöveg) válasszal dobja,
 *   és a tiltás másodpercekig tart. 300 ms-os közzel mérve minden kérés átment.
 *   Ezért minden kérés EGY soron megy, legalább `MIN_GAP_MS` közzel; az élő
 *   pozíció (high) mindig a menetrend-építés (low) elé kerül. Korlát-találatnál
 *   az egész sor szünetel, és a kérés újra próbálkozik.
 * - A szerver hibás lekérdezésre is HTTP 200-at ad, a hiba az `errors` tömbben
 *   jön — ezt mindig nézzük.
 * - Magyar szöveget kérünk (`Accept-Language: hu`; nélküle angol a tervező és a zavarok).
 */
import { config } from "../config.ts";
import { upstreamMetrics } from "../metrics.ts";

export class Otp2Error extends Error {
  readonly status: number;
  readonly limited: boolean;
  constructor(message: string, status = 0, limited = false) {
    super(message);
    this.status = status;
    this.limited = limited;
  }
}

type GqlResponse<T> = { data?: T; errors?: { message: string }[] };
type Priority = "high" | "low";
type Job = { run: () => Promise<void>; priority: Priority };

/** két kérés között legalább ennyi (ms) */
const MIN_GAP_MS = 500;
/** korlát-találat után az egész sor ennyit vár (ms) */
const LIMIT_PAUSE_MS = 15_000;
const LIMIT_RETRIES = 3;
/** hálózati hiba után fokozatos ritkítás (ms) */
const BACKOFF_MS = [0, 10_000, 20_000, 40_000, 60_000];

export class Otp2Client {
  private queue: Job[] = [];
  private running = false;
  private lastAt = 0;
  private pausedUntil = 0;
  private fails = 0;
  stats = { ok: 0, fail: 0, limited: 0, lastOkAt: 0, lastError: null as string | null, lastMs: 0, queued: 0 };

  /** Most éppen visszafogjuk-e a kéréseket (korlát vagy hibasorozat után). */
  backingOff(): boolean {
    return Date.now() < this.pausedUntil;
  }

  /** Ennyi kérés vár (a hub mutatja; az élő poll ilyenkor nem tesz be újat). */
  pending(priority?: Priority): number {
    return priority ? this.queue.filter((j) => j.priority === priority).length : this.queue.length;
  }

  query<T>(op: string, query: string, variables: Record<string, unknown> = {}, opts: { timeoutMs?: number; priority?: Priority } = {}): Promise<T> {
    if (!config.otp2.enabled) return Promise.reject(new Otp2Error("az OTP2 ki van kapcsolva (OTP2_ENABLED=0)"));
    const priority = opts.priority ?? "high";
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        priority,
        run: async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              resolve(await this.send<T>(op, query, variables, opts.timeoutMs ?? 10_000));
              return;
            } catch (e) {
              if (e instanceof Otp2Error && e.limited && attempt < LIMIT_RETRIES) {
                await sleep(Math.max(0, this.pausedUntil - Date.now()));
                continue;
              }
              reject(e);
              return;
            }
          }
        },
      };
      // A magas prioritású az utolsó magas után, minden alacsony elé kerül.
      if (priority === "high") {
        const i = this.queue.findIndex((j) => j.priority === "low");
        if (i < 0) this.queue.push(job);
        else this.queue.splice(i, 0, job);
      } else this.queue.push(job);
      this.stats.queued = this.queue.length;
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const wait = Math.max(this.lastAt + MIN_GAP_MS, this.pausedUntil) - Date.now();
        if (wait > 0) await sleep(wait);
        const job = this.queue.shift()!;
        this.stats.queued = this.queue.length;
        await job.run();
      }
    } finally {
      this.running = false;
    }
  }

  private async send<T>(op: string, query: string, variables: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const t0 = performance.now();
    const key = `OTP2 ${op}`;
    let status = 0;
    this.lastAt = Date.now();
    try {
      const res = await fetch(config.otp2.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "accept-language": "hu",
          "user-agent": config.otp2.userAgent,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      const text = await res.text();
      if (/host limit/i.test(text.slice(0, 64))) {
        this.stats.limited++;
        this.pausedUntil = Date.now() + LIMIT_PAUSE_MS;
        throw new Otp2Error("a MÁV+ korlátozza a kéréseket (host limit)", res.status, true);
      }
      if (!res.ok) throw new Otp2Error(`HTTP ${res.status}`, res.status);
      let body: GqlResponse<T>;
      try {
        body = JSON.parse(text) as GqlResponse<T>;
      } catch {
        // 200 + HTML (karbantartási oldal): a szerver baja, nem a lekérdezésé — ritkítunk
        throw new Otp2Error("nem JSON válasz (karbantartás?)", 502);
      }
      if (body.errors?.length) throw new Otp2Error(body.errors.map((e) => e.message).join("; ").slice(0, 300), 200);
      if (!body.data) throw new Otp2Error("üres válasz", 200);
      upstreamMetrics.record(key, performance.now() - t0, 200);
      this.fails = 0;
      this.stats.ok++;
      this.stats.lastOkAt = Date.now();
      this.stats.lastError = null;
      this.stats.lastMs = Math.round(performance.now() - t0);
      return body.data;
    } catch (e) {
      upstreamMetrics.record(key, performance.now() - t0, status || 0);
      const err = e instanceof Otp2Error ? e : new Otp2Error(e instanceof Error ? e.message : String(e), status);
      // A lekérdezés hibája (pl. eltűnt mező) nem a szerver baja: nem ritkítunk miatta.
      if (!err.limited && err.status !== 200) {
        this.fails++;
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + BACKOFF_MS[Math.min(this.fails, BACKOFF_MS.length - 1)]);
      }
      this.stats.fail++;
      this.stats.lastError = err.message;
      throw err;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const otp2 = new Otp2Client();
