/**
 * MÁV+ OTP2 (GraphQL) → egy szolgáltatási nap szabványos GTFS-e.
 *
 * A regionális (Volán + vasút) menetrendet nem saját formátumban tartjuk:
 * GTFS-szöveget írunk, és ugyanaz a `Feed` olvassa be, mint az MVK zipjét.
 * Így az illesztő, a megállófigyelő, a menetrend és a statisztika mind
 * ugyanazon az úton kapja meg.
 *
 * Szabályok:
 *  - Azonosítók: pontosan az OTP2 `gtfsId`-ja (`hkir:…`, `1:…`), kivéve az MVK
 *    megállóit (`mvkzrt:SP388` → `SP388`): a Volán a Tiszai pu. MVK-megállóján is
 *    megáll, és ott egy táblán kell látszania a kettőnek.
 *  - Éjszakai menetek: a mi szolgáltatási napunk 03:00-kor kezdődik (mint az
 *    MVK-nál). Az OTP-dátum 03:00 előtti meneteit az előző napunkhoz soroljuk,
 *    +24 órával (így a Feed éjszakai átfordítása nem nyúl hozzájuk).
 *  - Vasút: a vonal rövid neve a kategória (Sz, IC, IR, S…), a hosszú neve a
 *    végállomások; a vonatszám a menet neve (`trip_short_name`).
 */
import { SERVICE_DAY_CUTOFF_SEC, isoToYmd, shiftIso } from "../time.ts";

export type OtpStop = {
  gtfsId: string;
  name: string;
  code?: string | null;
  lat: number;
  lon: number;
  platformCode?: string | null;
  parentStation?: { gtfsId: string; name: string; lat: number; lon: number } | null;
};
export type OtpRoute = {
  gtfsId: string;
  shortName?: string | null;
  longName?: string | null;
  mode: string;
  type?: number | null;
  color?: string | null;
  textColor?: string | null;
  agency?: { gtfsId: string; name: string } | null;
};
export type OtpPattern = {
  code: string;
  headsign?: string | null;
  directionId?: number | string | null;
  route: OtpRoute;
  stops: OtpStop[];
  /** Google-féle kódolt polyline */
  points?: string | null;
};
export type OtpStoptime = { scheduledArrival: number; scheduledDeparture: number; pickupType?: string | null; dropoffType?: string | null };
export type OtpTrip = {
  gtfsId: string;
  tripShortName?: string | null;
  tripHeadsign?: string | null;
  directionId?: number | string | null;
  stoptimes: OtpStoptime[];
};
/** Egy OTP-szolgáltatási nap menetei mintánként. */
export type OtpDayTrips = { ymd: string; byPattern: Record<string, OtpTrip[]> };

export type RegionalGtfs = {
  files: Record<string, string>;
  counts: { patterns: number; routes: number; trips: number; stops: number; stopTimes: number; skipped: number };
};

const MVK_STOP_PREFIX = "mvkzrt:";
export const normStopId = (id: string) => (id.startsWith(MVK_STOP_PREFIX) ? id.slice(MVK_STOP_PREFIX.length) : id);

const PICKUP: Record<string, string> = { SCHEDULED: "0", NONE: "1", CALL_AGENCY: "2", COORDINATE_WITH_DRIVER: "3" };

/** HTML-jelölés és entitások nélkül (a vasúti `shortName` a MÁV piktogram-betűtípusának jele). */
export function plainText(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#\d+;|&[a-z]+;/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const RAIL_WORDS: [RegExp, string][] = [
  [/eurocity/i, "EC"],
  [/euronight/i, "EN"],
  [/railjet/i, "RJ"],
  [/intercity/i, "IC"],
  [/interr[ée]gi[óo]/i, "IR"],
  [/gyorsvonat/i, "G"],
  [/sebesvonat/i, "S"],
  [/expressz/i, "Ex"],
  [/pótló/i, "Pót"],
  [/személy/i, "Sz"],
];

/** Vasúti kategória: a vonal nevéből („IC TOKAJ”, „Sz 5112/…”), vagy a vonat nevéből („5139 személyvonat”). */
export function railCategory(routeLong: string | null | undefined, tripShortName?: string | null): string {
  const first = plainText(routeLong).split(" ")[0] ?? "";
  if (/^[A-ZÁÉ][A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]{0,3}$/.test(first)) return first;
  const t = plainText(tripShortName);
  for (const [re, cat] of RAIL_WORDS) if (re.test(t)) return cat;
  return "Vonat";
}

/** Vasúti menet-e (csak annak van vonatszáma; a Volán „3969/553” járatszáma nem az). */
export const isRailTrip = (t: { routeId: string; shortName?: string }): boolean => t.routeId.startsWith("1:") && Boolean(t.shortName);

/** „582 TOKAJ InterCity” → { no: "582", name: "TOKAJ" } */
export function trainParts(tripShortName: string | null | undefined): { no: string | null; name: string | null } {
  const t = plainText(tripShortName);
  const m = /^(\d{1,6})\s*(.*)$/.exec(t);
  if (!m) return { no: null, name: null };
  let rest = m[2];
  for (const [re] of RAIL_WORDS) rest = rest.replace(re, "");
  rest = rest.replace(/\s+/g, " ").trim();
  return { no: m[1], name: rest && /[A-ZÁÉÍÓÖŐÚÜŰ]{2,}/.test(rest) ? rest : null };
}

/** Google-féle kódolt polyline → [lat, lon] pontok (5 tizedes). */
export function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    let shift = 0;
    let res = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      res |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length);
    lat += res & 1 ? ~(res >> 1) : res >> 1;
    shift = 0;
    res = 0;
    do {
      b = str.charCodeAt(i++) - 63;
      res |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length);
    lon += res & 1 ? ~(res >> 1) : res >> 1;
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

function csvField(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(head: string[], rows: (string | number | null | undefined)[][]): string {
  return [head.join(","), ...rows.map((r) => r.map(csvField).join(","))].join("\n") + "\n";
}
function hms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}
const hex6 = (c: string | null | undefined, d: string) => (c && /^[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : d);

const MODE_TYPE: Record<string, string> = { RAIL: "2", RAIL_REPLACEMENT_BUS: "714", COACH: "200", BUS: "3", TRAM: "0", TROLLEYBUS: "11", SUBURBAN_RAILWAY: "109", TRAMTRAIN: "2" };

/**
 * Egy szolgáltatási nap regionális GTFS-e.
 * @param serviceIso a mi szolgáltatási napunk (03:00-tól 03:00-ig)
 * @param sameDay    az OTP ugyanerre a dátumra szóló menetei
 * @param nextDay    az OTP következő dátumának menetei (ezek 03:00 előttiek kellenek)
 */
export function regionalGtfsForDay(
  serviceIso: string,
  patterns: ReadonlyMap<string, OtpPattern>,
  sameDay: OtpDayTrips,
  nextDay: OtpDayTrips | null,
  version = `R${isoToYmd(serviceIso)}`,
): RegionalGtfs {
  const ymd = isoToYmd(serviceIso);
  const serviceId = `R${ymd}`;
  const stops = new Map<string, (string | number | null)[]>();
  const routes = new Map<string, OtpRoute>();
  const routeEnds = new Map<string, { n: number; from: string; to: string }>();
  const routeCat = new Map<string, string>();
  const tripRows: (string | number | null)[][] = [];
  const stRows: (string | number | null)[][] = [];
  const shapeRows: (string | number | null)[][] = [];
  const usedPatterns = new Set<string>();
  let skipped = 0;

  const addStop = (s: OtpStop) => {
    const id = normStopId(s.gtfsId);
    if (stops.has(id)) return id;
    const parent = s.parentStation ? normStopId(s.parentStation.gtfsId) : "";
    if (s.parentStation && !stops.has(parent)) {
      stops.set(parent, [parent, "", plainText(s.parentStation.name), s.parentStation.lat, s.parentStation.lon, "1", "", ""]);
    }
    stops.set(id, [id, s.platformCode ?? s.code ?? "", plainText(s.name), s.lat, s.lon, "0", parent, s.platformCode ?? ""]);
    return id;
  };

  const take = (day: OtpDayTrips | null, shift: number, keep: (firstDep: number) => boolean) => {
    if (!day) return;
    for (const [code, trips] of Object.entries(day.byPattern)) {
      const p = patterns.get(code);
      if (!p || !trips?.length) continue;
      for (const t of trips) {
        const st = t.stoptimes ?? [];
        if (st.length < 2 || st.length !== p.stops.length) {
          skipped++;
          continue;
        }
        if (!keep(st[0].scheduledDeparture)) continue;
        usedPatterns.add(code);
        const rid = p.route.gtfsId;
        routes.set(rid, p.route);
        const first = plainText(p.stops[0].name);
        const last = plainText(p.stops[p.stops.length - 1].name);
        const ends = routeEnds.get(rid);
        if (!ends || p.stops.length > ends.n) routeEnds.set(rid, { n: p.stops.length, from: first, to: last });
        if (rid.startsWith("1:") && !routeCat.has(rid)) routeCat.set(rid, railCategory(p.route.longName, t.tripShortName));
        const dir = t.directionId ?? p.directionId;
        tripRows.push([rid, serviceId, t.gtfsId, plainText(t.tripHeadsign) || plainText(p.headsign) || last, plainText(t.tripShortName), dir == null || dir === "" ? "0" : String(Number(dir) ? 1 : 0), code]);
        for (let i = 0; i < st.length; i++) {
          const sid = addStop(p.stops[i]);
          const x = st[i];
          stRows.push([t.gtfsId, hms(x.scheduledArrival + shift), hms(x.scheduledDeparture + shift), sid, i + 1, PICKUP[x.pickupType ?? ""] ?? "0", PICKUP[x.dropoffType ?? ""] ?? "0"]);
        }
      }
    }
  };
  // Mai OTP-dátum: a 03:00-tól induló menetek; holnapi OTP-dátum: a 03:00 előttiek, a nap végére tolva.
  take(sameDay, 0, (dep) => dep >= SERVICE_DAY_CUTOFF_SEC);
  if (nextDay) take(nextDay, 86_400, (dep) => dep < SERVICE_DAY_CUTOFF_SEC);

  for (const code of usedPatterns) {
    const p = patterns.get(code)!;
    const pts = p.points ? decodePolyline(p.points) : [];
    const line = pts.length >= 2 ? pts : p.stops.map((s) => [s.lat, s.lon] as [number, number]);
    line.forEach(([lat, lon], i) => shapeRows.push([code, lat.toFixed(6), lon.toFixed(6), i + 1]));
  }

  const routeRows = [...routes.values()].map((r) => {
    const rail = r.gtfsId.startsWith("1:");
    const ends = routeEnds.get(r.gtfsId);
    const span = ends ? `${ends.from} – ${ends.to}` : "";
    if (rail) {
      const cat = routeCat.get(r.gtfsId) ?? railCategory(r.longName);
      const named = plainText(r.longName).replace(/^\S+\s*/, "");
      const name = named && !/^\d/.test(named) ? `${named}: ` : "";
      const brand = hex6(r.textColor, "1E5AA8");
      return [r.gtfsId, r.agency?.gtfsId ?? "", cat, `${name}${span}`, r.type != null ? String(r.type) : (MODE_TYPE[r.mode] ?? "2"), brand === "FFFFFF" ? "1E5AA8" : brand, "FFFFFF", plainText(r.agency?.name), r.mode];
    }
    return [
      r.gtfsId,
      r.agency?.gtfsId ?? "",
      plainText(r.shortName) || plainText(r.longName).split(" ")[0] || "?",
      plainText(r.longName) || span,
      r.type != null ? String(r.type) : (MODE_TYPE[r.mode] ?? "3"),
      hex6(r.color, "0072BC"),
      hex6(r.textColor, "FFFFFF"),
      plainText(r.agency?.name),
      r.mode,
    ];
  });

  const files: Record<string, string> = {
    "feed_info.txt": csv(["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"], [
      ["MÁV+ OTP2 — Borsod-Abaúj-Zemplén (Volán + vasút)", "https://mavplusz.hu/", "hu", ymd, isoToYmd(shiftIso(serviceIso, 1)), version],
    ]),
    "routes.txt": csv(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color", "agency_name", "route_mode"], routeRows),
    "stops.txt": csv(["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station", "platform_code"], [...stops.values()]),
    "trips.txt": csv(["route_id", "service_id", "trip_id", "trip_headsign", "trip_short_name", "direction_id", "shape_id"], tripRows),
    "stop_times.txt": csv(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type"], stRows),
    "shapes.txt": csv(["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], shapeRows),
    "calendar_dates.txt": csv(["service_id", "date", "exception_type"], tripRows.length ? [[serviceId, ymd, "1"]] : []),
  };
  return {
    files,
    counts: { patterns: usedPatterns.size, routes: routes.size, trips: tripRows.length, stops: stops.size, stopTimes: stRows.length, skipped },
  };
}
