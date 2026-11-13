/**
 * „Melyik menetrend érvényes ezen a napon?”  fallbackkel.
 *
 * Ha az MVK késik a GTFS-sel (vagy üreset ad ki, mint 2026-10-27-én), a
 * rendszer nem állhat le: a legfrissebb ÉRVÉNYES feedből a céllal
 * legjobban egyező naptípusú sablon-nap menetrendjét használjuk.
 */
import type { Feed, Trip } from "./feed.ts";
import { dayInfo, daySimilarity } from "../calendar.ts";
import { isoToYmd, ymdToIso, SERVICE_DAY_CUTOFF_SEC } from "../time.ts";

export type ServiceDay = {
  iso: string;
  ymd: string;
  feed: Feed;
  services: Set<string>;
  /** null = a feed pontosan erre a napra szól */
  fallback: null | {
    templateIso: string;
    reason: "no-feed-for-date" | "feed-empty-for-date";
  };
};

/**
 * @param feeds az érvényes (validált) feedek, bármilyen sorrendben
 * @param iso   a kért szolgáltatási nap ("YYYY-MM-DD")
 */
export function resolveServiceDay(feeds: Feed[], iso: string): ServiceDay | null {
  if (!feeds.length) return null;
  const ymd = isoToYmd(iso);
  // Az újabb feed nyer: ugyanarra a napra a frissebb kiadás a pontosabb.
  const ordered = [...feeds].sort((a, b) => feedOrderKey(b).localeCompare(feedOrderKey(a)));

  for (const feed of ordered) {
    if (feed.tripCountOn(ymd) > 0) {
      return { iso, ymd, feed, services: feed.activeServices(ymd), fallback: null };
    }
  }

  const feed = ordered[0];
  const target = dayInfo(iso);
  let best: { ymd: string; score: number; dist: number } | null = null;
  for (const d of feed.serviceDays()) {
    const info = dayInfo(ymdToIso(d));
    const score = daySimilarity(target, info);
    const dist = Math.abs(Date.parse(ymdToIso(d)) - Date.parse(iso)) / 86400_000;
    if (!best || score < best.score || (score === best.score && dist < best.dist)) best = { ymd: d, score, dist };
  }
  if (!best) return null;
  const covered = feed.serviceRange();
  const reason = covered && ymd >= covered.from && ymd <= covered.to ? "feed-empty-for-date" : "no-feed-for-date";
  return {
    iso,
    ymd,
    feed,
    services: feed.activeServices(best.ymd),
    fallback: { templateIso: ymdToIso(best.ymd), reason },
  };
}

function feedOrderKey(f: Feed): string {
  // A feed_version "YYYYMMDD-N" alakú; ha nem az, a kezdődátum dönt.
  return /^\d{8}-\d+$/.test(f.info.version) ? f.info.version : `${f.info.startDate ?? "0"}-0`;
}

/** Az adott napon ténylegesen közlekedő menetek. */
export function tripsOn(day: ServiceDay): Trip[] {
  const out: Trip[] = [];
  for (const t of day.feed.trips.values()) if (day.services.has(t.serviceId)) out.push(t);
  return out;
}

/**
 * Valós idejű trip_id → a feedünk menete.
 *
 * Az MVK GTFS-RT a SAJÁT aktuális feedjének azonosítóit küldi
 * ("<service>_<shape>_<HHMMSS>_<kód>"). Ha nálunk fallback vagy egy napos
 * eltérésű feed él, a pontos azonosító nem létezik  ekkor nyomvonal +
 * indulási idő alapján keressük meg ugyanazt a menetet.
 */
export function resolveTrip(day: ServiceDay, rtTripId: string): Trip | null {
  if (!rtTripId) return null;
  const exact = day.feed.trips.get(rtTripId);
  if (exact && day.services.has(exact.serviceId)) return exact;

  const parsed = parseMvkTripId(rtTripId);
  if (parsed) {
    const cands = day.feed.tripsByShapeStart.get(`${parsed.shapeId}|${parsed.startSec}`) ?? [];
    for (const id of cands) {
      const t = day.feed.trips.get(id);
      if (t && day.services.has(t.serviceId)) return t;
    }
    // Ha a fallback-nap szolgáltatásai között nincs, de a feedben létezik ilyen menet, az is jobb a semminél.
    if (cands.length) return day.feed.trips.get(cands[0]) ?? null;
  }
  return exact ?? null;
}

export function parseMvkTripId(id: string): { serviceId: string; shapeId: string; startSec: number } | null {
  const p = id.split("_");
  if (p.length < 3 || !/^\d{6}$/.test(p[2])) return null;
  const hh = Number(p[2].slice(0, 2));
  const mm = Number(p[2].slice(2, 4));
  const ss = Number(p[2].slice(4, 6));
  const sec = hh * 3600 + mm * 60 + ss;
  // mint a feed betöltésénél: a 03:00 előtti indulás az előző szolgáltatási nap végén van
  return { serviceId: p[0], shapeId: p[1], startSec: sec < SERVICE_DAY_CUTOFF_SEC ? sec + 86_400 : sec };
}

/**
 * Ugyanaz a menetazonosító több szolgáltatási napon is él (pl. a tegnapi és a mai
 * éjszakai menet): azt a napot választjuk, amelyiknek a menetrendje időben a
 * legközelebb van a pinghez. `atUnix` nélkül az első feloldható nap (ma, aztán tegnap).
 */
export function resolveTripNear<D extends { day: ServiceDay; midnightUnix: number }>(
  days: readonly D[],
  rtTripId: string,
  atUnix: number | null,
): { trip: Trip; dc: D } | null {
  let best: { trip: Trip; dc: D } | null = null;
  let bestGap = Infinity;
  for (const dc of days) {
    const trip = resolveTrip(dc.day, rtTripId);
    if (!trip) continue;
    if (atUnix == null) return { trip, dc };
    const st = dc.day.feed.tripStops.get(trip.id);
    if (!st?.length) continue;
    const first = dc.midnightUnix + st[0].dep;
    const last = dc.midnightUnix + st[st.length - 1].arr;
    const gap = atUnix < first ? first - atUnix : atUnix > last ? atUnix - last : 0;
    if (gap < bestGap) {
      best = { trip, dc };
      bestGap = gap;
    }
  }
  return best;
}
