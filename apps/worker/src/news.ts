/**
 * MVK-hírek: kérésre töltjük le, 10 percig frissnek tekintjük. Ha az MVK nem
 * válaszol (pl. lejárt a token), a legutóbbi jó lista megy ki `stale`
 * jelzéssel, és egy percig nem próbálkozunk újra  a kliens ilyenkor is
 * azonnal kap választ.
 */
import { normalizeNews, nowUnix, type NewsFeed } from "@mvk/core";
import type { FeedManager } from "./feeds.ts";
import { errMsg, log } from "./log.ts";
import { mvkFetch } from "./mvk.ts";

const FRESH_S = 600;
const RETRY_S = 60;
const PATH = "/api/v1/news/available?language=hu";

export class NewsSource {
  private last: NewsFeed | null = null;
  private retryAt = 0;
  private inflight: Promise<NewsFeed> | null = null;
  private readonly feeds: FeedManager;

  constructor(feeds: FeedManager) {
    this.feeds = feeds;
  }

  /** null: még egyszer sem sikerült letölteni */
  async get(): Promise<NewsFeed | null> {
    const now = nowUnix();
    if (this.last && now - this.last.fetchedAt < FRESH_S) return this.last;
    if (now < this.retryAt) return this.staleCopy();
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    try {
      return await this.inflight;
    } catch (e) {
      this.retryAt = nowUnix() + RETRY_S;
      log.warn("news", "az MVK hírei nem tölthetők le", errMsg(e));
      return this.staleCopy();
    }
  }

  private staleCopy(): NewsFeed | null {
    return this.last ? { ...this.last, stale: true } : null;
  }

  private async load(): Promise<NewsFeed> {
    const r = await mvkFetch(PATH, { timeoutMs: 15_000 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const raw: unknown = JSON.parse(r.buf.toString("utf8"));
    if (!Array.isArray(raw)) throw new Error("váratlan válasz (nem lista)");
    const now = nowUnix();
    const { items, routes } = normalizeNews(raw, this.feeds.latest()?.routes.values() ?? [], now);
    this.last = { fetchedAt: now, stale: false, items, routes };
    return this.last;
  }
}
