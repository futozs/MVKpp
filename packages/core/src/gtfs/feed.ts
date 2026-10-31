/**
 * Egy GTFS-feed memóriabeli, indexelt alakja.
 *
 * Egy példány = egy feed-verzió. A rendszer több verziót is tart (a múltbeli
 * napokhoz és a fallbackhez), ezért itt nincs globális állapot — a régi
 * `gtfs.ts` modulszintű Map-jei miatt egyszerre csak egy feed létezhetett.
 */
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { parseCsv } from "./csv.ts";
import { hmsToSec, isoToYmd, ymdToIso, isoDow, shiftIso, SERVICE_DAY_CUTOFF_SEC } from "../time.ts";
import { ProjectedShape, type LatLon } from "../geo.ts";

export type Stop = {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** szülő-állomás (vasútállomás, autóbusz-állomás), ha a megálló egy vágány / kocsiállás */
  parent?: string;
  /** vágány vagy kocsiállás jele */
  platform?: string;
  /** true: maga az állomás (GTFS location_type = 1), menet nem áll meg rajta közvetlenül */
  station?: boolean;
};
export type Route = {
  id: string;
  short: string;
  long: string;
  type: string;
  color: string;
  text: string;
  /**
   * A vonal kulcsa az adatbázisban és a statisztikában (`route_short` oszlop).
   * MVK-nál a rövid név (ahogy eddig), más forrásnál a vonal-azonosító: a
   * Volán helyi vonalainak száma városonként ismétlődik („3” Ózdon és Tiszaújvárosban).
   */
  key: string;
  /** üzemeltető (GTFS agency_id) és a neve — a regionális feedben */
  agency?: string;
  agencyName?: string;
};
export type Trip = {
  id: string;
  routeId: string;
  serviceId: string;
  headsign: string;
  dir: string;
  shapeId: string;
  /** a menet kiírt neve (vasútnál „5139 személyvonat”) */
  shortName?: string;
};
export type StopTime = { stopId: string; arr: number; dep: number; seq: number };

/**
 * Az MVK GTFS az éjfél utáni meneteket 00:xx–02:xx időkkel írja az előző esti
 * menetek közé (a menetazonosító szerint 24:xx–26:xx, és a valódi futások is a
 * GTFS-nap utáni éjjelen vannak). A szolgáltatási nap 03:00-kor kezdődik, így ezek
 * a nap végén futnak: +24 óra. A menet közbeni éjféli átfordulást (23:50 → 00:10)
 * is kisimítjuk, hogy a menet ideje mindig nőjön.
 */
function unwrapNightTimes(list: StopTime[]): void {
  if (!list.length) return;
  let shift = list[0].dep < SERVICE_DAY_CUTOFF_SEC ? 86_400 : 0;
  let prev = -Infinity;
  for (const x of list) {
    if (x.arr + shift < prev - 12 * 3600) shift += 86_400;
    x.arr += shift;
    x.dep += shift;
    prev = x.dep;
  }
}
export type StopAlong = StopTime & { alongM: number };

export type FeedInfo = {
  version: string;
  startDate: string | null;
  endDate: string | null;
  publisher: string;
};

export type FeedValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { stops: number; routes: number; trips: number; stopTimes: number; shapes: number; serviceDays: number };
};

const TRAM_TYPES = new Set(["0", "900"]);

export class Feed {
  readonly info: FeedInfo;
  readonly hash: string;
  readonly stops = new Map<string, Stop>();
  readonly routes = new Map<string, Route>();
  readonly trips = new Map<string, Trip>();
  /** menet → megállói sorrendben */
  readonly tripStops = new Map<string, StopTime[]>();
  /** megálló → (menet, indulás) indulási sorrendben; egy menet többször is szerepelhet (hurok) */
  readonly stopSched = new Map<string, { trip: string; dep: number; seq: number }[]>();
  readonly shapes = new Map<string, ProjectedShape>();
  /** "YYYYMMDD" → aznap aktív service_id-k */
  readonly servicesByDate = new Map<string, Set<string>>();
  readonly routeStops = new Map<string, Set<string>>();
  readonly routeShapeIds = new Map<string, Set<string>>();
  /** `${shapeId}|${elsőIndulásMp}` → menetek — a feed-verziók közti menet-azonosításhoz */
  readonly tripsByShapeStart = new Map<string, string[]>();
  /** állomás → a vágányai / kocsiállásai */
  readonly stationChildren = new Map<string, string[]>();

  private patternCache = new Map<string, string>();
  private alongCache = new Map<string, StopAlong[] | null>();
  private tripCountCache = new Map<string, number>();

  constructor(files: Record<string, string>, hash: string, info?: FeedInfo) {
    this.hash = hash;
    const fi = parseCsv(files["feed_info.txt"] ?? "")[0];
    this.info = info ?? {
      version: fi?.feed_version || hash.slice(0, 12),
      startDate: fi?.feed_start_date || null,
      endDate: fi?.feed_end_date || null,
      publisher: fi?.feed_publisher_name || "",
    };

    for (const s of parseCsv(files["stops.txt"] ?? "")) {
      const lat = Number.parseFloat(s.stop_lat);
      const lon = Number.parseFloat(s.stop_lon);
      if (!s.stop_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const stop: Stop = { id: s.stop_id, code: s.stop_code || "", name: s.stop_name || s.stop_id, lat, lon };
      if (s.parent_station) stop.parent = s.parent_station;
      if (s.platform_code) stop.platform = s.platform_code;
      if (s.location_type === "1") stop.station = true;
      this.stops.set(s.stop_id, stop);
    }
    for (const r of parseCsv(files["routes.txt"] ?? "")) {
      if (!r.route_id) continue;
      const short = r.route_short_name || r.route_id;
      const route: Route = {
        id: r.route_id,
        short,
        long: r.route_long_name || "",
        type: r.route_type || "3",
        color: (r.route_color || "888888").toUpperCase(),
        text: (r.route_text_color || "FFFFFF").toUpperCase(),
        key: r.route_id.includes(":") ? r.route_id : short,
      };
      if (r.agency_id) route.agency = r.agency_id;
      if (r.agency_name) route.agencyName = r.agency_name;
      this.routes.set(r.route_id, route);
    }
    for (const t of parseCsv(files["trips.txt"] ?? "")) {
      if (!t.trip_id) continue;
      const trip: Trip = {
        id: t.trip_id,
        routeId: t.route_id,
        serviceId: t.service_id,
        headsign: (t.trip_headsign || "").trim(),
        dir: t.direction_id || "0",
        shapeId: t.shape_id || "",
      };
      // Az MVK a trip_short_name-be a vonalváltozat kódját írja (pl. „8RT”): csak a regionális menetnél kell.
      if (t.trip_short_name && t.trip_id.includes(":")) trip.shortName = t.trip_short_name;
      this.trips.set(t.trip_id, trip);
    }
    for (const st of parseCsv(files["stop_times.txt"] ?? "")) {
      const dep = hmsToSec(st.departure_time || st.arrival_time);
      const arr = hmsToSec(st.arrival_time || st.departure_time);
      if (dep == null || arr == null || !this.trips.has(st.trip_id)) continue;
      let list = this.tripStops.get(st.trip_id);
      if (!list) this.tripStops.set(st.trip_id, (list = []));
      list.push({ stopId: st.stop_id, arr, dep, seq: Number.parseInt(st.stop_sequence, 10) || list.length + 1 });
    }
    for (const [tripId, list] of this.tripStops) {
      list.sort((a, b) => a.seq - b.seq);
      unwrapNightTimes(list);
      for (const x of list) {
        let arr = this.stopSched.get(x.stopId);
        if (!arr) this.stopSched.set(x.stopId, (arr = []));
        arr.push({ trip: tripId, dep: x.dep, seq: x.seq });
      }
    }
    for (const arr of this.stopSched.values()) arr.sort((a, b) => a.dep - b.dep);

    this.loadCalendar(files["calendar.txt"] ?? "", files["calendar_dates.txt"] ?? "");
    this.loadShapes(files["shapes.txt"] ?? "");
    this.buildIndexes();
  }

  private loadCalendar(calendarTxt: string, datesTxt: string) {
    const DAY_COLS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    for (const c of parseCsv(calendarTxt)) {
      if (!c.service_id || !c.start_date || !c.end_date) continue;
      const days = DAY_COLS.map((d) => c[d] === "1");
      if (!days.some(Boolean)) continue;
      // A calendar.txt tartománya legfeljebb ~2 év — védekezés hibás dátum ellen.
      let iso = ymdToIso(c.start_date);
      const end = ymdToIso(c.end_date);
      for (let guard = 0; iso <= end && guard < 800; guard++, iso = shiftIso(iso, 1)) {
        if (!days[isoDow(iso) - 1]) continue;
        this.addService(isoToYmd(iso), c.service_id);
      }
    }
    for (const c of parseCsv(datesTxt)) {
      if (!c.service_id || !/^\d{8}$/.test(c.date)) continue;
      if (c.exception_type === "1") this.addService(c.date, c.service_id);
      else if (c.exception_type === "2") this.servicesByDate.get(c.date)?.delete(c.service_id);
    }
  }

  private addService(ymd: string, serviceId: string) {
    let set = this.servicesByDate.get(ymd);
    if (!set) this.servicesByDate.set(ymd, (set = new Set()));
    set.add(serviceId);
  }

  private loadShapes(text: string) {
    const raw = new Map<string, { seq: number; lat: number; lon: number }[]>();
    for (const r of parseCsv(text)) {
      const lat = Number.parseFloat(r.shape_pt_lat);
      const lon = Number.parseFloat(r.shape_pt_lon);
      if (!r.shape_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      let a = raw.get(r.shape_id);
      if (!a) raw.set(r.shape_id, (a = []));
      a.push({ seq: Number.parseInt(r.shape_pt_sequence, 10) || a.length, lat, lon });
    }
    for (const [id, a] of raw) {
      a.sort((x, y) => x.seq - y.seq);
      this.shapes.set(id, new ProjectedShape(a.map((p) => [p.lat, p.lon] as LatLon)));
    }
  }

  private buildIndexes() {
    for (const st of this.stops.values()) {
      if (!st.parent) continue;
      const list = this.stationChildren.get(st.parent);
      if (list) list.push(st.id);
      else this.stationChildren.set(st.parent, [st.id]);
    }
    const bestByDir = new Map<string, { shapeId: string; len: number }>();
    for (const t of this.trips.values()) {
      const stopsOfTrip = this.tripStops.get(t.id);
      if (stopsOfTrip?.length) {
        for (const x of stopsOfTrip) {
          let set = this.routeStops.get(t.routeId);
          if (!set) this.routeStops.set(t.routeId, (set = new Set()));
          set.add(x.stopId);
        }
        if (t.shapeId) {
          const key = `${t.shapeId}|${stopsOfTrip[0].dep}`;
          const list = this.tripsByShapeStart.get(key);
          if (list) list.push(t.id);
          else this.tripsByShapeStart.set(key, [t.id]);
        }
      }
      if (!t.shapeId) continue;
      const len = this.shapes.get(t.shapeId)?.points.length ?? 0;
      if (!len) continue;
      const key = `${t.routeId}|${t.dir}`;
      const cur = bestByDir.get(key);
      if (!cur || len > cur.len) bestByDir.set(key, { shapeId: t.shapeId, len });
    }
    for (const [key, v] of bestByDir) {
      const rid = key.slice(0, key.lastIndexOf("|"));
      let set = this.routeShapeIds.get(rid);
      if (!set) this.routeShapeIds.set(rid, (set = new Set()));
      set.add(v.shapeId);
    }
  }

  get version() {
    return this.info.version;
  }

  /** Az adott napon aktív service_id-k ("YYYYMMDD"). */
  activeServices(ymd: string): Set<string> {
    return this.servicesByDate.get(ymd) ?? new Set();
  }

  /** Hány menet közlekedik a feed szerint az adott napon. */
  tripCountOn(ymd: string): number {
    const hit = this.tripCountCache.get(ymd);
    if (hit != null) return hit;
    const svc = this.activeServices(ymd);
    let n = 0;
    if (svc.size) for (const t of this.trips.values()) if (svc.has(t.serviceId) && this.tripStops.has(t.id)) n++;
    this.tripCountCache.set(ymd, n);
    return n;
  }

  /** A feed által lefedett, ténylegesen közlekedő napok ("YYYYMMDD", rendezve). */
  serviceDays(): string[] {
    return [...this.servicesByDate.keys()].filter((d) => this.tripCountOn(d) > 0).sort();
  }

  serviceRange(): { from: string; to: string } | null {
    const days = this.serviceDays();
    return days.length ? { from: days[0], to: days[days.length - 1] } : null;
  }

  routeOf(tripId: string): Route | undefined {
    const t = this.trips.get(tripId);
    return t ? this.routes.get(t.routeId) : undefined;
  }

  /** Feed-verziótól független menetminta: vonal + irány + megállósorrend. */
  patternHash(tripId: string): string | null {
    const hit = this.patternCache.get(tripId);
    if (hit) return hit;
    const t = this.trips.get(tripId);
    const seq = this.tripStops.get(tripId);
    if (!t || !seq?.length) return null;
    // Ugyanaz a képlet, mint a v2-ben (route_id|irány|megállók) — így a régi
    // menetek mintakulcsa egyezik az újakéval, és a tanulás folytonos.
    const raw = `${t.routeId}|${t.dir}|${seq.map((x) => x.stopId).join(",")}`;
    const h = createHash("sha1").update(raw).digest("hex").slice(0, 16);
    this.patternCache.set(tripId, h);
    return h;
  }

  /**
   * A menet megállói a nyomvonal menti távolsággal. Lépésről lépésre vetít
   * (mindig az előző megálló után keres), így a hurokjáratokon sem ugrik
   * vissza; ha mégsem monoton, null — ilyenkor a menetet nem illesztjük.
   */
  tripStopsAlong(tripId: string): StopAlong[] | null {
    if (this.alongCache.has(tripId)) return this.alongCache.get(tripId) ?? null;
    const t = this.trips.get(tripId);
    const seq = this.tripStops.get(tripId);
    const shape = t?.shapeId ? this.shapes.get(t.shapeId) : undefined;
    if (!t || !seq?.length || !shape) {
      this.alongCache.set(tripId, null);
      return null;
    }
    const out: StopAlong[] = [];
    let prev = 0;
    for (const x of seq) {
      const s = this.stops.get(x.stopId);
      if (!s) continue;
      const p = shape.projectForward(s.lat, s.lon, prev);
      if (!p) continue;
      const alongM = Math.round(Math.max(p.alongM, out.length ? out[out.length - 1].alongM + 1 : 0));
      out.push({ ...x, alongM });
      prev = alongM;
    }
    const ok = out.length >= 2 && out.length >= seq.length - 1;
    this.alongCache.set(tripId, ok ? out : null);
    return ok ? out : null;
  }

  isTram(routeId: string): boolean {
    return TRAM_TYPES.has(this.routes.get(routeId)?.type ?? "");
  }

  /** Egy megálló, vagy ha állomás, a vágányai (a megállótábla ezekből gyűjt). */
  stopsOf(id: string): string[] {
    const kids = this.stationChildren.get(id);
    if (!kids?.length) return [id];
    return this.stops.has(id) && !this.stops.get(id)!.station ? [id, ...kids] : kids;
  }

  /**
   * Több feed egy közös nézetben (az MVK + a regionális Volán/vasút egy
   * szolgáltatási napra). Az azonosítók nem ütköznek (a regionálisak előtagosak);
   * a közös MVK-megállóknál (a Volán is megáll a Tiszai pu.-nál) az ELSŐ feed
   * megállója marad, a menetrendjük összefésülődik. A részek objektumait nem
   * másolja és nem módosítja: a kompozit csak új indexeket épít rájuk.
   */
  static compose(parts: Feed[]): Feed {
    if (parts.length === 1) return parts[0];
    const h = createHash("sha256");
    for (const p of parts) h.update(p.hash);
    const first = parts[0];
    const out = new Feed({}, h.digest("hex"), {
      version: parts.map((p) => p.version).join("+"),
      startDate: first.info.startDate,
      endDate: first.info.endDate,
      publisher: parts.map((p) => p.info.publisher).filter(Boolean).join(" + "),
    });
    const mergeInto = <K, V>(dst: Map<K, V>, src: Map<K, V>) => {
      for (const [k, v] of src) if (!dst.has(k)) dst.set(k, v);
    };
    for (const p of parts) {
      mergeInto(out.stops, p.stops);
      mergeInto(out.routes, p.routes);
      mergeInto(out.trips, p.trips);
      mergeInto(out.tripStops, p.tripStops);
      mergeInto(out.shapes, p.shapes);
      mergeInto(out.routeStops, p.routeStops);
      mergeInto(out.routeShapeIds, p.routeShapeIds);
      mergeInto(out.tripsByShapeStart, p.tripsByShapeStart);
      for (const [stop, list] of p.stopSched) {
        const cur = out.stopSched.get(stop);
        out.stopSched.set(stop, cur ? [...cur, ...list].sort((a, b) => a.dep - b.dep) : list);
      }
      for (const [ymd, set] of p.servicesByDate) {
        const cur = out.servicesByDate.get(ymd);
        out.servicesByDate.set(ymd, cur ? new Set([...cur, ...set]) : set);
      }
      for (const [st, kids] of p.stationChildren) {
        const cur = out.stationChildren.get(st);
        out.stationChildren.set(st, cur ? [...new Set([...cur, ...kids])] : kids);
      }
    }
    return out;
  }

  validate(previous?: Feed | null): FeedValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    let stopTimes = 0;
    for (const l of this.tripStops.values()) stopTimes += l.length;
    const serviceDays = this.serviceDays().length;
    const counts = {
      stops: this.stops.size,
      routes: this.routes.size,
      trips: this.trips.size,
      stopTimes,
      shapes: this.shapes.size,
      serviceDays,
    };
    if (!counts.stops) errors.push("nincs megálló");
    if (!counts.routes) errors.push("nincs vonal");
    if (!counts.trips) errors.push("nincs menet");
    if (!counts.stopTimes) errors.push("nincs menetrendi idő");
    if (!serviceDays) errors.push("egyetlen napon sem közlekedik menet");
    const tripsWithTimes = [...this.trips.keys()].filter((id) => (this.tripStops.get(id)?.length ?? 0) >= 2).length;
    if (counts.trips && tripsWithTimes / counts.trips < 0.9) errors.push(`a menetek ${Math.round((100 * tripsWithTimes) / counts.trips)}%-ának van legalább 2 megállója`);
    const withShape = [...this.trips.values()].filter((t) => t.shapeId && this.shapes.has(t.shapeId)).length;
    if (counts.trips && withShape / counts.trips < 0.8) warnings.push(`csak a menetek ${Math.round((100 * withShape) / counts.trips)}%-ához van nyomvonal`);
    if (previous) {
      if (counts.stops < previous.stops.size * 0.7) errors.push(`gyanúsan kevés megálló (${counts.stops} vs ${previous.stops.size})`);
      if (counts.routes < previous.routes.size * 0.7) errors.push(`gyanúsan kevés vonal (${counts.routes} vs ${previous.routes.size})`);
    }
    return { ok: errors.length === 0, errors, warnings, counts };
  }
}

/** GTFS zip → Feed. */
export function feedFromZip(zip: Uint8Array): Feed {
  const files = unzipSync(zip);
  const text: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    const base = name.split("/").pop() ?? name;
    if (base.endsWith(".txt")) text[base] = strFromU8(data);
  }
  return new Feed(text, sha256(zip));
}

/** Kicsomagolt mappa tartalma → Feed (fejlesztéshez, tesztekhez). */
export function feedFromFiles(files: Record<string, string>): Feed {
  const h = createHash("sha256");
  for (const k of Object.keys(files).sort()) h.update(k).update(files[k]);
  return new Feed(files, h.digest("hex"));
}

export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
