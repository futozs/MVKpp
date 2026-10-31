/**
 * Viszonylat-tábla és vonatkeresés (a megállófigyelő vasúti kártyáihoz).
 *
 *  - „Miskolc-Tiszai → Füzesabony”: csak azok a menetek, amelyek A-ban és UTÁNA
 *    B-ben is megállnak (felszállni A-ban, leszállni B-ben lehet), mindkét
 *    végponton a valós idejű idővel.
 *  - „5139”: a mai (és ha már elment, a holnapi) 5139-es vonat.
 *
 * Bármelyik feedre működik (MVK, Volán, vasút): a megálló lehet állomás is,
 * akkor a vágányai számítanak.
 */
import type { Feed } from "../gtfs/feed.ts";
import type { ServiceDay } from "../gtfs/service.ts";
import { hmOfUnix } from "../time.ts";
import { modeOfRoute, operatorLabel, type TransitMode } from "../transit/modes.ts";
import { isRailTrip, trainParts } from "../transit/regionalGtfs.ts";
import type { ArrivalExtras } from "./arrivals.ts";
import type { LiveVeh, RealtimeSnapshot } from "./types.ts";

type DayCtx = { day: ServiceDay; midnightUnix: number };

export type RelationRow = {
  tripId: string;
  route: string;
  routeKey: string;
  color: string;
  text: string;
  mode: TransitMode;
  operator: string | null;
  trainNo: string | null;
  trainName: string | null;
  headsign: string;
  depStopId: string;
  arrStopId: string;
  depTime: string;
  depUnix: number;
  schedDepUnix: number;
  depDelaySec: number | null;
  arrTime: string;
  arrUnix: number;
  schedArrUnix: number;
  arrDelaySec: number | null;
  durationMin: number;
  /** a megállók száma A és B között (a kettőt is beleértve) */
  stops: number;
  platform: string | null;
  live: boolean;
  cancelled: boolean;
  vehicle: LiveVeh | null;
  notices: string[] | null;
  /** `primary`: a mai szolgáltatási nap példánya (az élő adat csak erre vonatkozik) */
  today: boolean;
};

export type RelationBoard = {
  from: { id: string; name: string | null };
  to: { id: string; name: string | null };
  now: number;
  rows: RelationRow[];
};

/** Az élő késés egy megállóban: a snapshot előrejelzése (a megálló bármelyik vágányán). */
function predAt(snap: RealtimeSnapshot, stopId: string, tripId: string) {
  return snap.predByStop.get(stopId)?.get(tripId) ?? null;
}

export function relationBoard(
  fromId: string,
  toId: string,
  limit: number,
  snap: RealtimeSnapshot,
  days: DayCtx[],
  nowUnix: number,
  extras: Pick<ArrivalExtras, "cancelled" | "platform" | "notices" | "modes"> = {},
): RelationBoard {
  const feed = days[0]?.day.feed;
  const fromSet = new Set(feed ? feed.stopsOf(fromId) : [fromId]);
  const toSet = new Set(feed ? feed.stopsOf(toId) : [toId]);
  const vehByTrip = new Map<string, LiveVeh>();
  for (const v of snap.vehicles) if (v.tripId) vehByTrip.set(v.tripId, v);

  const rows: RelationRow[] = [];
  const seen = new Set<string>();
  days.forEach((dc, di) => {
    const f = dc.day.feed;
    const isToday = di === 0;
    for (const sid of fromSet) {
      for (const { trip } of f.stopSched.get(sid) ?? []) {
        const key = `${di}|${trip}`;
        if (seen.has(key)) continue;
        const t = f.trips.get(trip);
        if (!t || !dc.day.services.has(t.serviceId)) continue;
        const r = f.routes.get(t.routeId);
        const mode = modeOfRoute(t.routeId, r?.type ?? "");
        if (extras.modes && !extras.modes.has(mode)) continue;
        const st = f.tripStops.get(trip) ?? [];
        const a = st.findIndex((x) => fromSet.has(x.stopId));
        if (a < 0) continue;
        let b = -1;
        for (let i = a + 1; i < st.length; i++)
          if (toSet.has(st[i].stopId)) {
            b = i;
            break;
          }
        if (b < 0) continue;
        seen.add(key);
        const A = st[a];
        const B = st[b];
        const pa = isToday ? predAt(snap, A.stopId, trip) : null;
        const pb = isToday ? predAt(snap, B.stopId, trip) : null;
        const schedDep = dc.midnightUnix + A.dep;
        const schedArr = dc.midnightUnix + B.arr;
        const depUnix = pa?.unix ?? schedDep;
        // Ha B-re nincs előrejelzés, A késése vetül rá (a vonat nem hozza be a késést magától).
        const arrDelay = pb?.delay ?? pa?.delay ?? null;
        const arrUnix = pb?.unix ?? schedArr + (arrDelay ?? 0);
        if (depUnix < nowUnix - 60) continue;
        const tp = isRailTrip(t) ? trainParts(t.shortName) : null;
        const cancelled = isToday && Boolean(extras.cancelled?.has(trip));
        rows.push({
          tripId: trip,
          route: r?.short ?? t.routeId,
          routeKey: r?.key ?? t.routeId,
          color: r?.color ?? "888888",
          text: r?.text ?? "FFFFFF",
          mode,
          operator: operatorLabel(r?.agencyName),
          trainNo: tp?.no ?? null,
          trainName: tp?.name ?? null,
          headsign: t.headsign,
          depStopId: A.stopId,
          arrStopId: B.stopId,
          depTime: hmOfUnix(depUnix),
          depUnix,
          schedDepUnix: schedDep,
          depDelaySec: pa?.delay ?? null,
          arrTime: hmOfUnix(arrUnix),
          arrUnix,
          schedArrUnix: schedArr,
          arrDelaySec: arrDelay,
          durationMin: Math.max(0, Math.round((arrUnix - depUnix) / 60)),
          stops: b - a + 1,
          platform: (isToday ? extras.platform?.(trip, A.stopId) : null) ?? f.stops.get(A.stopId)?.platform ?? null,
          live: Boolean(pa || pb || (isToday && vehByTrip.has(trip))),
          cancelled,
          vehicle: isToday ? (vehByTrip.get(trip) ?? null) : null,
          notices: isToday ? (extras.notices?.(trip) ?? null) : null,
          today: isToday,
        });
      }
    }
  });
  // Ugyanaz a vonat két menetként is szerepelhet (520 HERNÁD-ZEMPLÉN / 520 ZEMPLÉN): egy sor.
  const dedup = new Set<string>();
  const out = rows
    .sort((x, y) => x.depUnix - y.depUnix)
    .filter((x) => {
      const k = x.trainNo ? `${x.trainNo}|${x.schedDepUnix}` : `${x.routeKey}|${x.schedDepUnix}|${x.headsign}`;
      if (dedup.has(k)) return false;
      dedup.add(k);
      return true;
    })
    .slice(0, limit);
  return {
    from: { id: fromId, name: feed?.stops.get(fromId)?.name ?? null },
    to: { id: toId, name: feed?.stops.get(toId)?.name ?? null },
    now: nowUnix,
    rows: out,
  };
}

export type TrainMatch = { tripId: string; dayIndex: number; firstDepUnix: number; lastArrUnix: number };

/**
 * Egy vonatszám menetei a megadott napokon (ma, holnap), az indulás szerint.
 * A vonatszám a menet nevének eleje („5139 személyvonat” → 5139).
 */
export function findTrains(days: DayCtx[], trainNo: string): TrainMatch[] {
  const no = trainNo.trim().replace(/^0+/, "");
  if (!/^\d{1,6}$/.test(no)) return [];
  const out: TrainMatch[] = [];
  days.forEach((dc, di) => {
    const f: Feed = dc.day.feed;
    for (const t of f.trips.values()) {
      if (!isRailTrip(t) || !dc.day.services.has(t.serviceId)) continue;
      if (trainParts(t.shortName).no !== no) continue;
      const st = f.tripStops.get(t.id);
      if (!st?.length) continue;
      out.push({ tripId: t.id, dayIndex: di, firstDepUnix: dc.midnightUnix + st[0].dep, lastArrUnix: dc.midnightUnix + st[st.length - 1].arr });
    }
  });
  return out.sort((a, b) => a.firstDepUnix - b.firstDepUnix);
}

/**
 * Egy vasúti menet azonosító szerint (a térképen követett vonat): a napok, amelyeken
 * közlekedik, az indulás szerint. Ugyanaz az azonosító ma és holnap is lehet.
 */
export function findTrip(days: DayCtx[], tripId: string): TrainMatch[] {
  const out: TrainMatch[] = [];
  days.forEach((dc, di) => {
    const t = dc.day.feed.trips.get(tripId);
    if (!t || !isRailTrip(t) || !dc.day.services.has(t.serviceId)) return;
    const st = dc.day.feed.tripStops.get(tripId);
    if (!st?.length) return;
    out.push({ tripId, dayIndex: di, firstDepUnix: dc.midnightUnix + st[0].dep, lastArrUnix: dc.midnightUnix + st[st.length - 1].arr });
  });
  return out.sort((a, b) => a.firstDepUnix - b.firstDepUnix);
}

/** Kereséshez: kisbetű, ékezet nélkül, a „Miskolc, ” előtag nélkül is egyezik. */
export function searchKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
